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
  // Strip markdown fences if present
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
    {
      status,
      headers: { "Access-Control-Allow-Origin": "*" },
    }
  );
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  // 1. Parse input
  let body: { normalizedText?: string; mode?: string; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_INPUT", "Corps de requête invalide.", 400);
  }

  const { normalizedText, mode = "COMPACT", context } = body;

  // 2. Validate input
  if (!normalizedText || typeof normalizedText !== "string") {
    return errorResponse("BAD_INPUT", "normalizedText requis.", 400);
  }
  if (normalizedText.length < MIN_TEXT_LENGTH) {
    return errorResponse("TOO_SHORT", "Texte trop court. Collez l'annonce complète.", 400);
  }
  if (!["COMPACT", "DOSSIER"].includes(mode)) {
    return errorResponse("BAD_INPUT", "mode doit être COMPACT ou DOSSIER.", 400);
  }

  // 3. Build request
  const requestId = uuidv4();
  
  const schemaReminder = `
RAPPEL SCHÉMA JSON OBLIGATOIRE — respectez EXACTEMENT ces clés et types :

{
  "ok": true,
  "requestId": "${requestId}",
  "meta": { "tone": "VOUVOIEMENT", "version": "analyze_v3_2", "mode": "${mode}" },
  "source": { "url": null, "provider": "seloger"|"leboncoin"|"pap"|"unknown", "capturedAt": null },
  "verdict": { "decision": "VISITEZ"|"NÉGOCIEZ"|"ÉCARTEZ", "signals": "PRÉCIS"|"PARTIEL"|"FLOU", "signalWhy": ["..."], "oneLine": "..." },
  "narrativeReading": { "whatYouReallyBuy": "...", "blindSpots": [{ "topic": "...", "whatsMissing": "...", "whyItCosts": "..." }], "priceBasis": "..." },
  "dimensionScores": [{ "axis": "readability", "score": 1-10, "comment": "..." }, { "axis": "coproRisk", ... }, { "axis": "priceDefensibility", ... }, { "axis": "usageQuality", ... }, { "axis": "liquidity", ... }],
  "proofs": { "quickFacts": [{ "label": "...", "value": "..." }], "priceDefensibility": { "status": "DÉFENDABLE"|"FRAGILE"|"INJUSTIFIABLE", "rationale": ["..."] }, "documentsIndex": [{ "doc": "...", "status": "OK"|"MISSING"|"UNKNOWN", "why": "..." }] },
  "reasons": [{ "title": "...", "impact": "...", "evidence": ["..."] }],
  "redFlags": [{ "label": "...", "severity": "LOW"|"MEDIUM"|"HIGH", "whyItMatters": "...", "ask": "..." }],
  "ammo": { "asks": [{ "title": "...", "priority": "P0"|"P1"|"P2", "whatToRequest": ["..."], "why": "..." }], "preVisitQuestions": [{ "question": "...", "whyBeforeVisit": "..." }], "visitChecklist": [{ "q": "...", "tag": "..." }], "negotiationLevers": [{ "lever": "...", "use": "...", "script": "..." }] },
  "offer": { "available": true|false, "positioning": "...", "scenarios": [{ "name": "...", "offerEUR": null, "conditions": ["..."], "whyThisWorks": "..." }], "agentMessageTemplate": "..." },
  "cta": { "primary": { "label": "...", "action": "NEW_SCAN"|"COPY_AGENT_MESSAGE" }, "secondary": { "label": "...", "action": "NEW_SCAN"|"UPSELL_OFFER_DOSSIER"|"SUBSCRIBE" } },
  "disclaimer": ["IMOSCAN est une aide à la décision. Pas une garantie.", "IMOSCAN tranche sur ce qui est visible et fourni."]
}

IMPORTANT : offerEUR = null (pas de context.marketRefs fourni). Pas de ranges.
`;

  const userMessage = schemaReminder + "\n\nAnalysez cette annonce :\n\n" + JSON.stringify({
    requestId,
    normalizedText,
    mode,
    ...(context ? { context } : {}),
  });

  // 4. Call Claude
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

  // 5. Parse JSON
  let parsed = safeJsonParse(rawText);

  // 6. Retry once if BAD_JSON
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

  // 7. Validate structure
  const validation = validateAnalyzeResult(parsed);
  if (!validation.valid) {
    console.warn("[IMOSCAN] Validation errors:", validation.errors);
    // Still return the result but flag it
    (parsed as Record<string, unknown>)._warnings = validation.errors;
  }

  // 8. Normalize vouvoiement (safety net)
  const normalized = normalizeJsonStringsVouvoiement(parsed);

  // 9. Add server metadata
  const result = normalized as Record<string, unknown>;
  result._latencyMs = Date.now() - startTime;
  result._engine = "claude-solo";
  result._model = MODEL;

  // 10. Return
  return NextResponse.json(result, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
