// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { normalizeJsonStringsVouvoiement } from "@/lib/tone";
import { validateAnalyzeResult } from "@/lib/validator";

// --- Config ---
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS_COMPACT = 3000;
const MAX_TOKENS_DOSSIER = 4000;
const TEMPERATURE = 0.15;
const TIMEOUT_MS = 55_000;
const MIN_TEXT_LENGTH = 100;

const PROMPT_VERSION = "IMOSCAN_V3.4.1_HARDCORE";
const META_VERSION = "analyze_v3_4_1";

// --- CORS preflight ---
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// --- Helpers ---
function safeJsonParse(raw: string): unknown | null {
  let cleaned = (raw ?? "").trim();

  // Strip fenced code blocks if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  // Extract JSON object boundaries if extra text exists
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1).trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, error: code, message },
    { status, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

function normalizeEnums(data: unknown): void {
  const d = data as Record<string, any>;
  const verdict = d?.verdict;

  if (verdict) {
    const decisionMap: Record<string, string> = {
      ECARTEZ: "ÉCARTEZ",
      NEGOCIEZ: "NÉGOCIEZ",
      "ÉCARTEZ": "ÉCARTEZ", // rare composed accent
    };
    const signalMap: Record<string, string> = { PRECIS: "PRÉCIS" };
    if (typeof verdict.decision === "string" && decisionMap[verdict.decision]) verdict.decision = decisionMap[verdict.decision];
    if (typeof verdict.signals === "string" && signalMap[verdict.signals]) verdict.signals = signalMap[verdict.signals];
  }

  const proofs = d?.proofs;
  if (proofs?.priceDefensibility) {
    const pd = proofs.priceDefensibility;
    const statusMap: Record<string, string> = { DEFENDABLE: "DÉFENDABLE" };
    if (typeof pd.status === "string" && statusMap[pd.status]) pd.status = statusMap[pd.status];
  }
}

function coerceScalpesFullToString(parsed: any): void {
  const sf = parsed?.scalpesFull;
  if (!sf) return;

  // already a string
  if (typeof sf === "string") {
    parsed.scalpesFull = sf;
    return;
  }

  // object -> stringify to human-readable block (no markdown)
  if (sf && typeof sf === "object") {
    const hook = typeof sf.hook === "string" ? sf.hook.trim() : "";
    const mech = typeof sf.mechanism === "string" ? sf.mechanism.trim() : "";
    const whatBreaks = Array.isArray(sf.whatBreaks) ? sf.whatBreaks.filter((x: any) => typeof x === "string").slice(0, 3) : [];
    const whatYouMustProve = Array.isArray(sf.whatYouMustProve)
      ? sf.whatYouMustProve.filter((x: any) => typeof x === "string").slice(0, 3)
      : [];
    const blade = typeof sf.verdictBlade === "string" ? sf.verdictBlade.trim() : "";

    const lines: string[] = [];
    if (hook) lines.push(hook);
    if (mech) lines.push(mech);
    if (whatBreaks.length) {
      lines.push("Ce qui casse :");
      for (const w of whatBreaks) lines.push(`- ${w}`);
    }
    if (whatYouMustProve.length) {
      lines.push("Ce que vous devez prouver :");
      for (const w of whatYouMustProve) lines.push(`- ${w}`);
    }
    if (blade) lines.push(blade);

    parsed.scalpesFull = lines.join("\n");
    return;
  }

  // unknown type -> drop
  delete parsed.scalpesFull;
}

function normalizeCrucialPoints(parsed: any): void {
  const cps = parsed?.crucialPoints;
  if (!Array.isArray(cps)) return;

  const clean = cps
    .map((x: any) => {
      if (!x || typeof x !== "object") return null;
      const title = typeof x.title === "string" ? x.title.trim() : "";
      const why = typeof x.why === "string" ? x.why.trim() : "";
      const demand = typeof x.demand === "string" ? x.demand.trim() : "";
      const severity = typeof x.severity === "string" ? x.severity.trim().toUpperCase() : "MEDIUM";
      const sev = severity === "HIGH" || severity === "LOW" ? severity : "MEDIUM";
      if (!title || !why || !demand) return null;
      return { title, why, demand, severity: sev };
    })
    .filter(Boolean)
    .slice(0, 5);

  parsed.crucialPoints = clean;
}

function sanitizeOutput(parsed: any, mode: "COMPACT" | "DOSSIER", captureMethod?: string): void {
  if (!parsed || typeof parsed !== "object") return;

  // Force meta coherence server-side
  parsed.meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  parsed.meta.tone = "VOUVOIEMENT";
  parsed.meta.version = META_VERSION;
  parsed.meta.mode = mode;
  if (captureMethod) parsed.meta.captureMethod = captureMethod;

  // Force disclaimer standard
  parsed.disclaimer = [
    "IMOSCAN est une aide à la décision. Pas une garantie.",
    "IMOSCAN tranche sur ce qui est visible et fourni.",
  ];

  const fixTypos = (s: string): string =>
    s
      .replace(/compl[eè]vos/gi, "complètes")
      .replace(/compl[eè]ves/gi, "complètes")
      .replace(/compl[\u00E8e]v?os/gi, "complètes")
      .replace(/compl[\u00E8e]t?os/gi, "complètes");

  const softenIntent = (s: string): string =>
    s
      .replace(/\b[Ss]trat(?:e|é|è)gie\b/gi, "Opacité")
      .replace(/\bmanipulation\b/gi, "asymétrie d'information")
      .replace(/\b(suspect|suspecte|suspects|suspectes)\b/gi, "non vérifiable")
      .replace(/\bmasquer\b/gi, "couvrir")
      .replace(/\b(cach(e|er|ée|ées|és)|dissimule|rétention|retention)\b/gi, "non documenté")
      .replace(/\b(evitement|évitement)\b/gi, "opacité");

  // Fix ammo asks typos + soften whys
  if (parsed.ammo?.asks && Array.isArray(parsed.ammo.asks)) {
    for (const ask of parsed.ammo.asks) {
      if (ask && typeof ask.title === "string") ask.title = fixTypos(ask.title);
      if (ask && typeof ask.item === "string") ask.item = fixTypos(ask.item);
      if (ask && typeof ask.why === "string") ask.why = softenIntent(fixTypos(ask.why));
      if (ask && Array.isArray(ask.whatToRequest)) {
        ask.whatToRequest = ask.whatToRequest.map((w: any) => (typeof w === "string" ? fixTypos(w) : w));
      }
    }
  }

  // Soften intent-ish phrasing in redFlags/reasons
  if (parsed.redFlags && Array.isArray(parsed.redFlags)) {
    for (const rf of parsed.redFlags) {
      if (rf && typeof rf.whyItMatters === "string") rf.whyItMatters = softenIntent(fixTypos(rf.whyItMatters));
      if (rf && typeof rf.label === "string") rf.label = fixTypos(rf.label);
      if (rf && typeof rf.ask === "string") rf.ask = fixTypos(rf.ask);
    }
  }
  if (parsed.reasons && Array.isArray(parsed.reasons)) {
    for (const r of parsed.reasons) {
      if (r && typeof r.impact === "string") r.impact = softenIntent(fixTypos(r.impact));
      if (r && typeof r.title === "string") r.title = fixTypos(r.title);
      if (r && Array.isArray(r.evidence)) {
        r.evidence = r.evidence.map((e: any) => (typeof e === "string" ? fixTypos(e) : e));
      }
    }
  }

  // Fix typos in offer agent message
  if (parsed.offer && typeof parsed.offer.agentMessageTemplate === "string") {
    parsed.offer.agentMessageTemplate = fixTypos(parsed.offer.agentMessageTemplate);
  }

  // Force CTA coherence (server-side truth)
  const decision: string | undefined = parsed?.verdict?.decision;
  parsed.cta = parsed.cta && typeof parsed.cta === "object" ? parsed.cta : {};
  if (decision === "ÉCARTEZ") {
    parsed.cta.primary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
    delete parsed.cta.secondary;
  } else {
    parsed.cta.primary = { label: "Copier le message agent", action: "COPY_AGENT_MESSAGE" };
    parsed.cta.secondary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
  }
}

function buildUserMessage(params: {
  requestId: string;
  mode: "COMPACT" | "DOSSIER";
  normalizedText: string;
  source?: any;
  extracted?: any;
  photoContext?: any;
  context?: any;
}): string {
  const { requestId, mode, normalizedText, source, extracted, photoContext, context } = params;

  const compactLimits =
    mode === "COMPACT"
      ? "COMPACT limits: reasons<=2, redFlags<=2, proofs.quickFacts<=4, proofs.documentsIndex<=2, narrativeReading.blindSpots=3 exactly, ammo.asks<=3, ammo.preVisitQuestions<=3, ammo.visitChecklist<=5, crucialPoints=3..5."
      : "DOSSIER mode.";

  return [
    "JSON ONLY. No text outside JSON. No markdown.",
    `requestId="${requestId}"`,
    `mode="${mode}"`,
    `meta.version MUST be "${META_VERSION}". meta.tone MUST be "VOUVOIEMENT".`,
    compactLimits,
    'Use enums with accents exactly: decision="VISITEZ|NÉGOCIEZ|ÉCARTEZ", signals="PRÉCIS|PARTIEL|FLOU", status="DÉFENDABLE|FRAGILE|INJUSTIFIABLE".',
    "Return keys exactly: ok, requestId, meta{tone,version,mode,captureMethod?}, source{url,provider,capturedAt}, verdict{decision,signals,signalWhy,oneLine}, narrativeReading{whatYouReallyBuy,blindSpots,priceBasis}, dimensionScores[{axis,score,comment}], proofs{quickFacts,priceDefensibility{status,rationale,ranges?},documentsIndex}, reasons, redFlags, ammo{asks,preVisitQuestions,visitChecklist}, offer{available,positioning,scenarios,agentMessageTemplate}, cta, disclaimer, photoScan?, scalpesFull, crucialPoints.",
    source ? `source=${JSON.stringify(source)}` : "",
    extracted ? `extracted=${JSON.stringify(extracted)}` : "",
    photoContext ? `photoContext=${JSON.stringify(photoContext)}` : "",
    context ? `context=${JSON.stringify(context)}` : "",
    `normalizedText:\n${normalizedText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  let body: {
    normalizedText?: string;
    mode?: string;
    source?: any;
    extracted?: any;
    photoContext?: any;
    context?: any;
  };

  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_INPUT", "Corps de requête invalide.", 400);
  }

  const { normalizedText, mode = "COMPACT", source, extracted, photoContext, context } = body;

  if (!normalizedText || typeof normalizedText !== "string") {
    return errorResponse("BAD_INPUT", "normalizedText requis.", 400);
  }
  if (normalizedText.length < MIN_TEXT_LENGTH) {
    return errorResponse(
      "TOO_SHORT",
      "Texte trop court. Utilisez extension/webview/bookmarklet pour capturer l'annonce complète.",
      400
    );
  }
  if (!["COMPACT", "DOSSIER"].includes(mode)) {
    return errorResponse("BAD_INPUT", "mode doit être COMPACT ou DOSSIER.", 400);
  }

  const requestId = uuidv4();
  const maxTokens = mode === "DOSSIER" ? MAX_TOKENS_DOSSIER : MAX_TOKENS_COMPACT;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse("SERVER_ERROR", "Clé API manquante.", 500);
  }

  const userMessage = buildUserMessage({
    requestId,
    mode: mode as "COMPACT" | "DOSSIER",
    normalizedText,
    source,
    extracted,
    photoContext,
    context,
  });

  const client = new Anthropic({ apiKey });

  let rawText = "";
  let retryText = "";
  let parsed: unknown | null = null;

  // Attempt #1
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    const textBlock = response.content.find((b) => b.type === "text");
    rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";
    parsed = safeJsonParse(rawText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur API";
    console.error("[IMOSCAN] Claude API error:", message);
    if (String(message).includes("abort")) {
      return errorResponse("TIMEOUT", "Délai dépassé. Réessayez.", 504);
    }
    return errorResponse("SERVER_ERROR", "Erreur d'analyse. Réessayez.", 500);
  }

  // Retry once if BAD_JSON
  if (!parsed) {
    console.warn("[IMOSCAN] BAD_JSON on first attempt, retrying...");

    try {
      const retryResponse = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userMessage },
          { role: "assistant", content: rawText },
          {
            role: "user",
            content: "Votre réponse précédente n'est pas un JSON valide. Renvoyez UNIQUEMENT le JSON corrigé, sans texte avant ou après. Pas de markdown.",
          },
        ],
      });

      const retryBlock = retryResponse.content.find((b) => b.type === "text");
      retryText = retryBlock && retryBlock.type === "text" ? retryBlock.text : "";
      parsed = safeJsonParse(retryText);
    } catch (retryErr) {
      console.error("[IMOSCAN] Retry failed:", retryErr);
    }

    if (!parsed) {
      console.log("[IMOSCAN] BAD_JSON rawText len:", rawText.length);
      console.log("[IMOSCAN] BAD_JSON rawText first 800:\n", rawText.slice(0, 800));
      console.log("[IMOSCAN] BAD_JSON rawText last 800:\n", rawText.slice(-800));
      console.log("[IMOSCAN] BAD_JSON retryText len:", retryText.length);
      console.log("[IMOSCAN] BAD_JSON retryText first 800:\n", retryText.slice(0, 800));
      console.log("[IMOSCAN] BAD_JSON retryText last 800:\n", retryText.slice(-800));

      return errorResponse("BAD_JSON", "Impossible de produire un verdict valide. Réessayez.", 500);
    }
  }

  // Normalize & sanitize before validation
  const captureMethod = source?.captureMethod;
  normalizeEnums(parsed);
  sanitizeOutput(parsed as any, mode as "COMPACT" | "DOSSIER", typeof captureMethod === "string" ? captureMethod : undefined);

  // HARDCORE additions normalization
  coerceScalpesFullToString(parsed as any);
  normalizeCrucialPoints(parsed as any);

  // Validate (non-blocking warning for now)
  const validation = validateAnalyzeResult(parsed);
  if (!validation.valid) {
    console.warn("[IMOSCAN] Validation errors:", validation.errors);
    (parsed as Record<string, unknown>)._warnings = validation.errors;
  }

  // Normalize strings (vouvoiement)
  const normalized = normalizeJsonStringsVouvoiement(parsed);

  const result = normalized as Record<string, unknown>;
  result._latencyMs = Date.now() - startTime;
  result._engine = "claude-solo";
  result._model = MODEL;
  result._promptVersion = PROMPT_VERSION;

  return NextResponse.json(result, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}