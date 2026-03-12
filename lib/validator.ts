// lib/validator.ts
// Validates IMOSCAN V3.4.1 JSON output — lightweight, no Zod dependency

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export function validateAnalyzeResult(data: unknown): ValidationResult {
  const errors: string[] = [];
  const d = data as Record<string, unknown>;

  // Top level
  if (d.ok !== true) errors.push("ok must be true");
  if (typeof d.requestId !== "string") errors.push("requestId must be string");

  // Meta
  const meta = d.meta as Record<string, unknown> | undefined;
  if (!meta) errors.push("meta missing");
  else {
    if (meta.tone !== "VOUVOIEMENT") errors.push("meta.tone must be VOUVOIEMENT");
    if (!["COMPACT", "DOSSIER"].includes(meta.mode as string)) errors.push("meta.mode invalid");
    // version is server-forced, so no strict check here
  }

  // Verdict
  const verdict = d.verdict as Record<string, unknown> | undefined;
  if (!verdict) errors.push("verdict missing");
  else {
    if (!["VISITEZ", "NÉGOCIEZ", "ÉCARTEZ"].includes(verdict.decision as string))
      errors.push("verdict.decision invalid");
    if (!["PRÉCIS", "PARTIEL", "FLOU"].includes(verdict.signals as string))
      errors.push("verdict.signals invalid");
    if (!Array.isArray(verdict.signalWhy) || verdict.signalWhy.length < 2)
      errors.push("verdict.signalWhy must have 2+ items");
    if (typeof verdict.oneLine !== "string" || (verdict.oneLine as string).length > 140)
      errors.push("verdict.oneLine must be string ≤140 chars");
  }

  // Narrative reading
  const nr = d.narrativeReading as Record<string, unknown> | undefined;
  if (!nr) errors.push("narrativeReading missing");
  else {
    if (typeof nr.whatYouReallyBuy !== "string") errors.push("narrativeReading.whatYouReallyBuy missing");
    if (!Array.isArray(nr.blindSpots) || nr.blindSpots.length < 3)
      errors.push("narrativeReading.blindSpots must have 3+ items");
    if (typeof nr.priceBasis !== "string") errors.push("narrativeReading.priceBasis missing");
  }

  // Dimension scores (API shape)
  const ds = d.dimensionScores as unknown[];
  if (!Array.isArray(ds) || ds.length !== 5) {
    errors.push("dimensionScores must have exactly 5 items");
  } else {
    for (const item of ds) {
      if (!isObj(item)) {
        errors.push("dimensionScores item invalid");
        continue;
      }
      if (typeof item.axis !== "string") errors.push("dimensionScores.axis missing");
      if (typeof item.score !== "number") errors.push("dimensionScores.score missing");
      if (typeof item.comment !== "string") errors.push("dimensionScores.comment missing");
    }
  }

  // Proofs
  const proofs = d.proofs as Record<string, unknown> | undefined;
  if (!proofs) errors.push("proofs missing");
  else {
    const qf = proofs.quickFacts as unknown[];
    if (!Array.isArray(qf) || qf.length < 3 || qf.length > 6)
      errors.push("proofs.quickFacts must have 3-6 items");

    const pd = proofs.priceDefensibility as Record<string, unknown> | undefined;
    if (!pd) errors.push("proofs.priceDefensibility missing");
    else {
      if (!["DÉFENDABLE", "FRAGILE", "INJUSTIFIABLE"].includes(pd.status as string))
        errors.push("priceDefensibility.status invalid");
      const rat = pd.rationale as unknown;
      if (!Array.isArray(rat) && typeof rat !== "string") errors.push("priceDefensibility.rationale invalid");
    }
  }

  // Reasons
  const reasons = d.reasons as unknown[];
  if (!Array.isArray(reasons) || reasons.length < 2 || reasons.length > 4)
    errors.push("reasons must have 2-4 items");

  // Ammo
  const ammo = d.ammo as Record<string, unknown> | undefined;
  if (!ammo) errors.push("ammo missing");
  else {
    const asks = ammo.asks as unknown[];
    if (!Array.isArray(asks) || asks.length < 3) errors.push("ammo.asks must have 3+ items");
    const pvq = ammo.preVisitQuestions as unknown[];
    if (!Array.isArray(pvq) || pvq.length < 3) errors.push("ammo.preVisitQuestions must have 3+ items");
    const vc = ammo.visitChecklist as unknown[];
    if (!Array.isArray(vc) || vc.length < 5) errors.push("ammo.visitChecklist must have 5+ items");
  }

  // Offer logic
  const offer = d.offer as Record<string, unknown> | undefined;
  if (!offer) errors.push("offer missing");
  else {
    const decision = (verdict as Record<string, unknown>)?.decision;
    if (decision === "ÉCARTEZ" && offer.available !== false)
      errors.push("offer.available must be false when ÉCARTEZ");
    if (decision !== "ÉCARTEZ" && offer.available !== true)
      errors.push("offer.available must be true when not ÉCARTEZ");
    if (offer.available && !offer.agentMessageTemplate)
      errors.push("agentMessageTemplate required when offer.available");
  }

  // Disclaimer
  const disc = d.disclaimer as unknown[];
  if (!Array.isArray(disc) || disc.length !== 2) errors.push("disclaimer must have exactly 2 items");

  // HARDCORE: scalpesFull + crucialPoints
  const scalpesFull = (d as any).scalpesFull;
  if (!scalpesFull) {
    errors.push("scalpesFull missing");
  } else if (typeof scalpesFull !== "string" && !isObj(scalpesFull)) {
    errors.push("scalpesFull invalid type");
  }

  const cp = (d as any).crucialPoints;
  if (!Array.isArray(cp) || cp.length < 3) {
    errors.push("crucialPoints must have 3+ items");
  } else {
    for (const item of cp.slice(0, 5)) {
      if (!isObj(item)) {
        errors.push("crucialPoints item invalid");
        continue;
      }
      if (typeof item.title !== "string" || !item.title.trim()) errors.push("crucialPoints.title missing");
      if (typeof item.why !== "string" || !item.why.trim()) errors.push("crucialPoints.why missing");
      if (typeof item.demand !== "string" || !item.demand.trim()) errors.push("crucialPoints.demand missing");
      if (!["HIGH", "MEDIUM", "LOW"].includes(String(item.severity))) errors.push("crucialPoints.severity invalid");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}