// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { normalizeJsonStringsVouvoiement } from "@/lib/tone";
import { validateAnalyzeResult } from "@/lib/validator";

// --- Config ---
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS_COMPACT = 1100;
const MAX_TOKENS_DOSSIER = 4000;
const TEMPERATURE = 0.2;
const TIMEOUT_MS = 55_000;
const MIN_TEXT_LENGTH = 100;

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
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
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
      "ÉCARTEZ": "ÉCARTEZ", // accent combiné rare
    };
    const signalMap: Record<string, string> = {
      PRECIS: "PRÉCIS",
    };

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

  const fixTypos = (s: string): string =>
    s.replace(/compl[eè]vos/gi, "complètes").replace(/compl[eè]ves/gi, "complètes");

  // Non-destructive softening of intent attribution / accusation-ish words
  const softenIntent = (s: string): string =>
    s
      .replace(/\b[Ss]trat(?:e|é|è)gie\b/g, "Opacité")
      .replace(/\bmanipulation\b/gi, "asymétrie d'information")
      .replace(/\b(suspect|suspecte|suspects|suspectes)\b/gi, "non vérifiable")
      .replace(/\bmasquer\b/gi, "couvrir")
      .replace(/\b(cach(e|er|ée|ées|és)|dissimule|rétention|retention)\b/gi, "non documenté")
      .replace(/\b(evitement|évitement)\b/gi, "opacité");

  // Fix ammo.asks[].title
  if (d.ammo?.asks && Array.isArray(d.ammo.asks)) {
    for (const ask of d.ammo.asks) {
      if (ask && typeof ask.title === "string") ask.title = fixTypos(ask.title);
      if (ask && typeof ask.why === "string") ask.why = softenIntent(ask.why);
    }
  }

  // Soften intent in redFlags / reasons
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
  context?: unknown;
}): string {
  const { requestId, mode, normalizedText, context } = params;

  // Keep this short. The real rules live in SYSTEM_PROMPT.
  // This message just anchors the schema + mode limits.
  const schema = {
    ok: true,
    requestId,
    meta: { tone: "VOUVOIEMENT", version: "analyze_v3_3_1", mode },
    source: { url: null, provider: "leboncoin", capturedAt: null },
    verdict: { decision: "VISITEZ|NÉGOCIEZ|ÉCARTEZ", signals: "PRÉCIS|PARTIEL|FLOU", signalWhy: ["..."], oneLine: "..." },
    narrativeReading: {
      whatYouReallyBuy: "...",
      blindSpots: [{ topic: "...", whatsMissing: "...", whyItCosts: "..." }],
      priceBasis: "...",
    },
    dimensionScores: [{ axis: "readability", score: 1, comment: "..." }],
    proofs: {
      quickFacts: [{ label: "...", value: "..." }],
      priceDefensibility: { status: "DÉFENDABLE|FRAGILE|INJUSTIFIABLE", rationale: ["..."] },
      documentsIndex: [{ doc: "...", status: "OK|MISSING|UNKNOWN", why: "..." }],
    },
    reasons: [{ title: "...", impact: "...", evidence: ["..."] }],
    redFlags: [{ label: "...", severity: "LOW|MEDIUM|HIGH", whyItMatters: "...", ask: "..." }],
    ammo: {
      asks: [{ title: "...", priority: "P0|P1|P2", whatToRequest: ["..."], why: "..." }],
      preVisitQuestions: [{ question: "...", whyBeforeVisit: "..." }],
      visitChecklist: [{ q: "...", tag: "..." }],
    },
    offer: { available: true, positioning: "...", scenarios: [{ name: "...", offerEUR: null, conditions: ["..."], whyThisWorks: "..." }], agentMessageTemplate: "..." },
    cta: { primary: { label: "...", action: "NEW_SCAN|COPY_AGENT_MESSAGE" }, secondary: { label: "...", action: "NEW_SCAN|UPSELL_OFFER_DOSSIER|SUBSCRIBE" } },
    disclaimer: ["..."],
  };

  const compactLimits =
    mode === "COMPACT"
      ? `
MODE COMPACT LIMITS (strict):
- reasons: 2 max
- redFlags: 2 max
- proofs.quickFacts: 4 max
- proofs.documentsIndex: 2 max
- narrativeReading.blindSpots: 3 max
- ammo.asks: 3 max
- ammo.preVisitQuestions: 3 max
- ammo.visitChecklist: 5 max
`
      : "";

  return (
    `Répondez UNIQUEMENT en JSON valide. Aucun texte avant/après.\n` +
    `requestId="${requestId}" mode="${mode}".\n` +
    compactLimits +
    `Schéma attendu (clés exactes, types exacts) :\n` +
    JSON.stringify(schema, null, 2) +
    `\n\nAnnonce (normalizedText) :\n` +
    normalizedText +
    (context ? `\n\ncontext:\n${JSON.stringify(context)}` : "")
  );
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  let body: { normalizedText?: string; mode?: string; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_INPUT", "Corps de requête invalide.", 400);
  }

  const { normalizedText, mode = "COMPACT", context } = body;

  if (!normalizedText || typeof normalizedText !== "string") {
    return errorResponse("BAD_INPUT", "normalizedText requis.", 400);
  }
  if (normalizedText.length < MIN_TEXT_LENGTH) {
    return errorResponse("TOO_SHORT", "Texte trop court. Collez l'annonce complète.", 400);
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
    context,
  });

  const client = new Anthropic({ apiKey });

  let rawText: string;
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
    if (!textBlock || textBlock.type !== "text") {
      return errorResponse("SERVER_ERROR", "Réponse vide du modèle.", 500);
    }
    rawText = textBlock.text;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur API";
    console.error("[IMOSCAN] Claude API error:", message);
    if (message.includes("abort")) {
      return errorResponse("TIMEOUT", "Délai dépassé. Réessayez.", 504);
    }
    return errorResponse("SERVER_ERROR", "Erreur d'analyse. Réessayez.", 500);
  }

  let parsed = safeJsonParse(rawText);

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
              "Votre réponse précédente n'est pas un JSON valide. Renvoyez UNIQUEMENT le JSON corrigé, sans texte avant ou après.",
          },
        ],
      });

      const retryBlock = retryResponse.content.find((b) => b.type === "text");
      if (retryBlock && retryBlock.type === "text") {
        parsed = safeJsonParse(retryBlock.text);
      }
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
  result._promptVersion = "IMOSCAN_V3.3.1";

  return NextResponse.json(result, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}