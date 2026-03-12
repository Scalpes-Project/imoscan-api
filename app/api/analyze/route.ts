// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { normalizeJsonStringsVouvoiement } from "@/lib/tone";
import { validateAnalyzeResult } from "@/lib/validator";

// --- Config ---
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS_COMPACT = 2000;
const MAX_TOKENS_DOSSIER = 4000;
const TEMPERATURE = 0.15;
const TIMEOUT_MS = 55_000;
const MIN_TEXT_LENGTH = 100;

const PROMPT_VERSION = "IMOSCAN_V3.4_PHOTOSCAN";
const META_VERSION = "analyze_v3_4";

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
  let cleaned = raw.trim();

  // Strip fenced code blocks if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  // Try to extract JSON object boundaries if extra text exists
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
  const d = data as Record<string, unknown>;
  const verdict = d.verdict as Record<string, unknown> | undefined;

  if (verdict) {
    const decisionMap: Record<string, string> = {
      ECARTEZ: "ÉCARTEZ",
      NEGOCIEZ: "NÉGOCIEZ",
      "ÉCARTEZ": "ÉCARTEZ", // rare composed accent
    };
    const signalMap: Record<string, string> = { PRECIS: "PRÉCIS" };

    if (typeof verdict.decision === "string" && decisionMap[verdict.decision]) {
      verdict.decision = decisionMap[verdict.decision];
    }
    if (typeof verdict.signals === "string" && signalMap[verdict.signals]) {
      verdict.signals = signalMap[verdict.signals];
    }
  }

  const proofs = d.proofs as Record<string, unknown> | undefined;
  if (proofs) {
    const pd = proofs.priceDefensibility as Record<string, unknown> | undefined;
    const statusMap: Record<string, string> = { DEFENDABLE: "DÉFENDABLE" };
    if (pd && typeof pd.status === "string" && statusMap[pd.status]) {
      pd.status = statusMap[pd.status];
    }
  }
}

function sanitizeOutput(data: unknown): void {
  const d = data as any;
  if (!d || typeof d !== "object") return;

  // Ensure meta fields exist & are coherent
  d.meta = d.meta && typeof d.meta === "object" ? d.meta : {};
  d.meta.tone = "VOUVOIEMENT";
  d.meta.version = META_VERSION;
  // Keep mode if model provided; route will not invent if missing
  if (d.meta.mode !== "COMPACT" && d.meta.mode !== "DOSSIER") {
    // fallback to COMPACT if absent
    d.meta.mode = "COMPACT";
  }

  const fixTypos = (s: string): string =>
    s.replace(/compl[eè]vos/gi, "complètes").replace(/compl[eè]ves/gi, "complètes");

  // Light “intent” softener (server-side guardrail)
  const softenIntent = (s: string): string =>
    s
      .replace(/\b[Ss]trat(?:e|é|è)gie\b/gi, "Opacité")
      .replace(/\bmanipulation\b/gi, "asymétrie d'information")
      .replace(/\b(suspect|suspecte|suspects|suspectes)\b/gi, "non vérifiable")
      .replace(/\bmasquer\b/gi, "couvrir")
      .replace(/\b(cach(e|er|ée|ées|és)|dissimule|rétention|retention)\b/gi, "non documenté")
      .replace(/\b(evitement|évitement)\b/gi, "opacité");

  // Fix ammo.asks[].title + soften why
  if (d.ammo?.asks && Array.isArray(d.ammo.asks)) {
    for (const ask of d.ammo.asks) {
      if (ask && typeof ask.title === "string") ask.title = fixTypos(ask.title);
      if (ask && typeof ask.why === "string") ask.why = softenIntent(ask.why);
    }
  }

  // Soften intent-ish phrasing in redFlags/reasons
  if (d.redFlags && Array.isArray(d.redFlags)) {
    for (const rf of d.redFlags) {
      if (rf && typeof rf.whyItMatters === "string") rf.whyItMatters = softenIntent(rf.whyItMatters);
    }
  }
  if (d.reasons && Array.isArray(d.reasons)) {
    for (const r of d.reasons) {
      if (r && typeof r.impact === "string") r.impact = softenIntent(r.impact);
    }
  }

  // Force CTA coherence (server-side truth)
  const decision: string | undefined = d.verdict?.decision;
  if (d.cta && decision) {
    if (decision === "ÉCARTEZ" || decision === "ECARTEZ") {
      d.cta.primary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
      delete d.cta.secondary;
    } else {
      d.cta.primary = { label: "Copier le message agent", action: "COPY_AGENT_MESSAGE" };
      d.cta.secondary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
    }
  }
}

function buildUserMessage(params: {
  requestId: string;
  mode: "COMPACT" | "DOSSIER";
  normalizedText: string;
  source?: unknown;
  extracted?: unknown;
  photoContext?: unknown;
  context?: unknown;
}): string {
  const { requestId, mode, normalizedText, source, extracted, photoContext, context } = params;

  const compactLimits =
    mode === "COMPACT"
      ? "COMPACT limits: reasons<=2, redFlags<=2, proofs.quickFacts<=4, proofs.documentsIndex<=2, narrativeReading.blindSpots=3 exactly, ammo.asks<=3, ammo.preVisitQuestions<=3, ammo.visitChecklist<=5."
      : "DOSSIER mode.";

  return [
    "JSON ONLY. No text outside JSON.",
    `requestId="${requestId}"`,
    `mode="${mode}"`,
    compactLimits,
    'Use enums with accents exactly: decision="VISITEZ|NÉGOCIEZ|ÉCARTEZ", signals="PRÉCIS|PARTIEL|FLOU", status="DÉFENDABLE|FRAGILE|INJUSTIFIABLE".',
    `meta.version must be "${META_VERSION}". meta.tone must be "VOUVOIEMENT".`,
    "Return keys exactly: ok, requestId, meta{tone,version,mode,captureMethod?}, source{url,provider,capturedAt}, verdict{decision,signals,signalWhy,oneLine}, narrativeReading{whatYouReallyBuy,blindSpots,priceBasis}, dimensionScores[{axis,score,comment}], proofs{quickFacts,priceDefensibility{status,rationale,ranges?},documentsIndex}, reasons, redFlags, ammo{asks,preVisitQuestions,visitChecklist}, offer{available,positioning,scenarios,agentMessageTemplate}, cta, disclaimer, photoScan?.",
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
    source?: unknown;
    extracted?: unknown;
    photoContext?: unknown;
    context?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_INPUT", "Corps de requête invalide.", 400);
  }

  const {
    normalizedText,
    mode = "COMPACT",
    source,
    extracted,
    photoContext,
    context,
  } = body;

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
            content:
              "Votre réponse précédente n'est pas un JSON valide. Renvoyez UNIQUEMENT le JSON corrigé, sans texte avant ou après. Pas de markdown.",
          },
        ],
      });

      const retryBlock = retryResponse.content.find((b) => b.type === "text");
      const retryText = retryBlock && retryBlock.type === "text" ? retryBlock.text : "";
      parsed = safeJsonParse(retryText);
    } catch (retryErr) {
      console.error("[IMOSCAN] Retry failed:", retryErr);
    }

    if (!parsed) {
      return errorResponse("BAD_JSON", "Impossible de produire un verdict valide. Réessayez.", 500);
    }
  }

  // Normalize & sanitize before validation
  normalizeEnums(parsed);
  sanitizeOutput(parsed);

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

  // TEMP DEBUG MARKER
  (result as any)._server = {
    maxTokensCompact: MAX_TOKENS_COMPACT,
    maxTokensDossier: MAX_TOKENS_DOSSIER,
    temperature: TEMPERATURE,
    metaVersion: META_VERSION,
    promptVersion: PROMPT_VERSION,
  };

  return NextResponse.json(result, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}