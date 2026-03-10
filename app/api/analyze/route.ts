// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { normalizeJsonStringsVouvoiement } from "@/lib/tone";
import { validateAnalyzeResult } from "@/lib/validator";

// --- Config ---
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 4000;
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
      "ECARTEZ": "\u00C9CARTEZ",
      "NEGOCIEZ": "N\u00C9GOCIEZ",
      "\u00C9CARTEZ": "\u00C9CARTEZ",
    };
    const signalMap: Record<string, string> = {
      "PRECIS": "PR\u00C9CIS",
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
    const statusMap: Record<string, string> = { "DEFENDABLE": "D\u00C9FENDABLE" };
    if (pd && typeof pd.status === "string" && statusMap[pd.status]) {
      pd.status = statusMap[pd.status];
    }
  }
}

function sanitizeOutput(data: unknown): void {
  const d = data as any;
  if (!d || typeof d !== "object") return;

  const fixTypos = (s: string): string =>
    s.replace(/compl[e\u00E8]vos/gi, "compl\u00E8tes").replace(/compl[e\u00E8]ves/gi, "compl\u00E8tes");

  const softenIntent = (s: string): string =>
    s
      .replace(/\b[Ss]trat(?:e|\u00E9|\u00E8)gie\b/g, "Opacit\u00E9")
      .replace(/\bmanipulation\b/gi, "asym\u00E9trie d'information")
      .replace(/\b(suspect|suspecte|suspects|suspectes)\b/gi, "non v\u00E9rifiable")
      .replace(/\bmasquer\b/gi, "couvrir")
      .replace(/\b[e\u00E9]vitement\b/gi, "opacit\u00E9");

  if (d.ammo?.asks && Array.isArray(d.ammo.asks)) {
    for (const ask of d.ammo.asks) {
      if (ask && typeof ask.title === "string") ask.title = fixTypos(ask.title);
    }
  }
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

  const decision: string | undefined = d.verdict?.decision;
  if (d.cta && decision) {
    if (decision === "\u00C9CARTEZ" || decision === "ECARTEZ") {
      d.cta.primary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
      delete d.cta.secondary;
    } else {
      d.cta.primary = { label: "Copier le message agent", action: "COPY_AGENT_MESSAGE" };
      d.cta.secondary = { label: "Scanner une autre annonce", action: "NEW_SCAN" };
    }
  }
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  let body: { normalizedText?: string; mode?: string; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_INPUT", "Corps de requete invalide.", 400);
  }

  const { normalizedText, mode = "COMPACT", context } = body;

  if (!normalizedText || typeof normalizedText !== "string") {
    return errorResponse("BAD_INPUT", "normalizedText requis.", 400);
  }
  if (normalizedText.length < MIN_TEXT_LENGTH) {
    return errorResponse("TOO_SHORT", "Texte trop court. Collez l annonce complete.", 400);
  }
  if (!["COMPACT", "DOSSIER"].includes(mode)) {
    return errorResponse("BAD_INPUT", "mode doit etre COMPACT ou DOSSIER.", 400);
  }

  const requestId = uuidv4();

  const userMessage = `Repondez UNIQUEMENT en JSON valide. Pas de texte avant ou apres le JSON.
requestId: "${requestId}", mode: "${mode}".

JSON attendu: { ok, requestId, meta, source, verdict:{decision,signals,signalWhy,oneLine}, narrativeReading:{whatYouReallyBuy,blindSpots,priceBasis}, dimensionScores, proofs:{quickFacts,priceDefensibility,documentsIndex}, reasons, redFlags, ammo:{asks,preVisitQuestions,visitChecklist}, offer:{available,positioning,scenarios,agentMessageTemplate}, cta, disclaimer }

Regles: offerEUR=null, pas de ranges, pas de pourcentages inventes, constats uniquement.
COMPACT: reasons 2, redFlags 2, asks 3, preVisitQuestions 3, visitChecklist 5, quickFacts 4, documentsIndex 2, blindSpots 3.
ECARTEZ: cta.primary NEW_SCAN, pas de secondary. Sinon: cta.primary COPY_AGENT_MESSAGE.

Annonce:
${normalizedText}`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse("SERVER_ERROR", "Cle API manquante.", 500);
  }

  const client = new Anthropic({ apiKey });

  let rawText: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return errorResponse("SERVER_ERROR", "Reponse vide du modele.", 500);
    }
    rawText = textBlock.text;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur API";
    console.error("[IMOSCAN] Claude API error:", message);
    if (message.includes("abort")) {
      return errorResponse("TIMEOUT", "Delai depasse. Reessayez.", 504);
    }
    return errorResponse("SERVER_ERROR", "Erreur d analyse. Reessayez.", 500);
  }

  let parsed = safeJsonParse(rawText);

  if (!parsed) {
    console.warn("[IMOSCAN] BAD_JSON on first attempt, retrying...");
    try {
      const retryResponse = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userMessage },
          { role: "assistant", content: rawText },
          {
            role: "user",
            content: "Votre reponse precedente n est pas un JSON valide. Renvoyez UNIQUEMENT le JSON corrige, sans texte avant ou apres.",
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
      return errorResponse("BAD_JSON", "Impossible de produire un verdict valide. Reessayez.", 500);
    }
  }

  normalizeEnums(parsed);
  sanitizeOutput(parsed);

  const validation = validateAnalyzeResult(parsed);
  if (!validation.valid) {
    console.warn("[IMOSCAN] Validation errors:", validation.errors);
    (parsed as Record<string, unknown>)._warnings = validation.errors;
  }

  const normalized = normalizeJsonStringsVouvoiement(parsed);

  const result = normalized as Record<string, unknown>;
  result._latencyMs = Date.now() - startTime;
  result._engine = "claude-solo";
  result._model = MODEL;

  return NextResponse.json(result, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}