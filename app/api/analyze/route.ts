// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { normalizeJsonStringsVouvoiement } from "@/lib/tone";
import { validateAnalyzeResult } from "@/lib/validator";

// --- Config ---
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS_COMPACT = 1100; // ↓ was 2000 (reduces latency a lot)
const MAX_TOKENS_DOSSIER = 4000;
const TEMPERATURE = 0.2;
const TIMEOUT_MS = 45_000;
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
      ECARTEZ: "\u00C9CARTEZ",
      NEGOCIEZ: "N\u00C9GOCIEZ",
      // Rare case: combined accent variant
      ÉCARTEZ: "\u00C9CARTEZ",
    };
    const signalMap: Record<string, string> = {
      PRECIS: "PR\u00C9CIS",
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
    const statusMap: Record<string, string> = { DEFENDABLE: "D\u00C9FENDABLE" };
    if (pd && typeof pd.status === "string" && statusMap[pd.status]) {
      pd.status = statusMap[pd.status];
    }
  }
}

/**
 * Post-processing sanitizer:
 * - Fixes recurring typos in titles
 * - Softens "intent attribution" language in Scalpes fields (non-destructive)
 * - Forces CTA coherence based on decision
 *
 * NOTE: Keep sanitizer minimal; avoid rewriting semantics beyond small safe substitutions.
 */
function sanitizeOutput(data: unknown): void {
  const d = data as any;
  if (!d || typeof d !== "object") return;

  const fixTypos = (s: string): string =>
    s
      .replace(/compl[eè]vos/gi, "complètes")
      .replace(/compl[eè]ves/gi, "complètes");

  // Replace intent/accusation-ish words with neutral constat terms (light touch)
  const softenIntent = (s: string): string =>
    s
      .replace(/\b[Ss]trat[ée]gie\b/g, "Opacité")
      .replace(/\bmanipulation\b/gi, "asymétrie d'information")
      .replace(/\b(suspect|suspecte|suspects|suspectes)\b/gi, "non vérifiable")
      .replace(/\bmasquer\b/gi, "couvrir");

  // Fix ammo.asks[].title
  if (d.ammo?.asks && Array.isArray(d.ammo.asks)) {
    for (const ask of d.ammo.asks) {
      if (ask && typeof ask.title === "string") {
        ask.title = fixTypos(ask.title);
      }
    }
  }

  // Soften intent in redFlags[].whyItMatters
  if (d.redFlags && Array.isArray(d.redFlags)) {
    for (const rf of d.redFlags) {
      if (rf && typeof rf.whyItMatters === "string") {
        rf.whyItMatters = softenIntent(rf.whyItMatters);
      }
    }
  }

  // Soften intent in reasons[].impact
  if (d.reasons && Array.isArray(d.reasons)) {
    for (const r of d.reasons) {
      if (r && typeof r.impact === "string") {
        r.impact = softenIntent(r.impact);
      }
    }
  }

  // Force CTA coherence
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

  const schemaReminder = `
RAPPEL SCHEMA JSON OBLIGATOIRE — respectez EXACTEMENT ces cles et types :

{
  "ok": true,
  "requestId": "${requestId}",
  "meta": { "tone": "VOUVOIEMENT", "version": "analyze_v3_2", "mode": "${mode}" },
  "source": { "url": null, "provider": "seloger"|"leboncoin"|"pap"|"unknown", "capturedAt": null },
  "verdict": { "decision": "VISITEZ"|"NEGOCIEZ"|"ECARTEZ", "signals": "PRECIS"|"PARTIEL"|"FLOU", "signalWhy": ["..."], "oneLine": "..." },
  "narrativeReading": { "whatYouReallyBuy": "...", "blindSpots": [{ "topic": "...", "whatsMissing": "...", "whyItCosts": "..." }], "priceBasis": "..." },
  "dimensionScores": [{ "axis": "readability", "score": 1-10, "comment": "..." }, { "axis": "coproRisk", ... }, { "axis": "priceDefensibility", ... }, { "axis": "usageQuality", ... }, { "axis": "liquidity", ... }],
  "proofs": { "quickFacts": [{ "label": "...", "value": "..." }], "priceDefensibility": { "status": "DEFENDABLE"|"FRAGILE"|"INJUSTIFIABLE", "rationale": ["..."] }, "documentsIndex": [{ "doc": "...", "status": "OK"|"MISSING"|"UNKNOWN", "why": "..." }] },
  "reasons": [{ "title": "...", "impact": "...", "evidence": ["..."] }],
  "redFlags": [{ "label": "...", "severity": "LOW"|"MEDIUM"|"HIGH", "whyItMatters": "...", "ask": "..." }],
  "ammo": { "asks": [{ "title": "...", "priority": "P0"|"P1"|"P2", "whatToRequest": ["..."], "why": "..." }], "preVisitQuestions": [{ "question": "...", "whyBeforeVisit": "..." }], "visitChecklist": [{ "q": "...", "tag": "..." }], "negotiationLevers": [{ "lever": "...", "use": "...", "script": "..." }] },
  "offer": { "available": true|false, "positioning": "...", "scenarios": [{ "name": "...", "offerEUR": null, "conditions": ["..."], "whyThisWorks": "..." }], "agentMessageTemplate": "..." },
  "cta": { "primary": { "label": "...", "action": "NEW_SCAN"|"COPY_AGENT_MESSAGE" }, "secondary": { "label": "...", "action": "NEW_SCAN"|"UPSELL_OFFER_DOSSIER"|"SUBSCRIBE" } },
  "disclaimer": ["IMOSCAN est une aide a la decision. Pas une garantie.", "IMOSCAN tranche sur ce qui est visible et fourni."]
}

IMPORTANT : offerEUR = null (pas de context.marketRefs fourni). Pas de ranges.
IMPORTANT : aucun pourcentage de decote, aucun "euros de trop", aucun "standard marche" invente. Qualifications uniquement (FRAGILE, probable decote, risque).
IMPORTANT : aucune faute d orthographe dans les labels et titres.

MODE COMPACT — LIMITES STRICTES :
- reasons: 2 max
- redFlags: 2 max
- ammo.asks: 3 max
- ammo.preVisitQuestions: 3 max
- ammo.visitChecklist: 5 max
- proofs.quickFacts: 4 max
- proofs.documentsIndex: 2 max
- narrativeReading.whatYouReallyBuy: 2 phrases max
- narrativeReading.blindSpots: 3 max
- Phrases courtes partout. Pas de verbosite.

REGISTRE SCALPES — INTERDICTIONS SUPPLEMENTAIRES :
- Interdit d attribuer une intention ("manipulation", "strategie", "suspect", "trompeur").
- Remplacer par des constats : "opacite", "non documente", "non verifiable", "asymetrie d information".

CTA — COHERENCE :
- Si decision = ECARTEZ : cta.primary = {"label":"Scanner une autre annonce","action":"NEW_SCAN"}. Pas de cta.secondary.
- Si decision != ECARTEZ : cta.primary = {"label":"Copier le message agent","action":"COPY_AGENT_MESSAGE"}, cta.secondary = {"label":"Scanner une autre annonce","action":"NEW_SCAN"}
`;

  const userMessage =
    schemaReminder +
    "\n\nAnalysez cette annonce :\n\n" +
    JSON.stringify({
      requestId,
      normalizedText,
      mode,
      ...(context ? { context } : {}),
    });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse("SERVER_ERROR", "Clé API manquante.", 500);
  }

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

  // Normalize enums (fix accent-less outputs from model)
  normalizeEnums(parsed);

  // Sanitize output (typos + soften intent + CTA coherence)
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