// lib/validator.ts
// Validates IMOSCAN JSON output — lightweight, no Zod dependency
// Updated for V3.4 (PhotoScan + captureMethod), backward compatible.

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

type Obj = Record<string, unknown>;

const DECISIONS = ["VISITEZ", "NÉGOCIEZ", "ÉCARTEZ"] as const;
const SIGNALS = ["PRÉCIS", "PARTIEL", "FLOU"] as const;
const PD_STATUS = ["DÉFENDABLE", "FRAGILE", "INJUSTIFIABLE"] as const;
const MODES = ["COMPACT", "DOSSIER"] as const;
const CAPTURE_METHODS = ["EXTENSION", "BOOKMARKLET", "WEBVIEW", "MANUAL"] as const;

const AXES = ["readability", "coproRisk", "priceDefensibility", "usageQuality", "liquidity"] as const;
const PHOTO_CONF = ["FORT", "MOYEN", "FAIBLE"] as const;

function isObj(x: unknown): x is Obj {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export function validateAnalyzeResult(data: unknown): ValidationResult {
  const errors: string[] = [];
  const d = data as Obj;

  // Top level
  if (d.ok !== true) errors.push("ok must be true");
  if (typeof d.requestId !== "string") errors.push("requestId must be string");

  // Meta
  const meta = d.meta;
  if (!isObj(meta)) errors.push("meta missing");
  else {
    if (meta.tone !== "VOUVOIEMENT") errors.push("meta.tone must be VOUVOIEMENT");
    if (!MODES.includes(meta.mode as any)) errors.push("meta.mode invalid");

    // Optional but recommended
    if (meta.version !== undefined) {
      const v = String(meta.version);
      if (!v.startsWith("analyze_v")) errors.push("meta.version invalid");
      // If you want to enforce V3.4 only, uncomment:
      // if (v !== "analyze_v3_4") errors.push("meta.version must be analyze_v3_4");
    }

    if (meta.captureMethod !== undefined) {
      if (!CAPTURE_METHODS.includes(meta.captureMethod as any)) errors.push("meta.captureMethod invalid");
    }
  }

  // Verdict
  const verdict = d.verdict;
  if (!isObj(verdict)) errors.push("verdict missing");
  else {
    if (!DECISIONS.includes(verdict.decision as any)) errors.push("verdict.decision invalid");
    if (!SIGNALS.includes(verdict.signals as any)) errors.push("verdict.signals invalid");

    if (!Array.isArray(verdict.signalWhy) || verdict.signalWhy.length < 2)
      errors.push("verdict.signalWhy must have 2+ items");

    if (typeof verdict.oneLine !== "string" || verdict.oneLine.length > 140)
      errors.push("verdict.oneLine must be string ≤140 chars");
  }

  // Narrative reading
  const nr = d.narrativeReading;
  if (!isObj(nr)) errors.push("narrativeReading missing");
  else {
    if (typeof nr.whatYouReallyBuy !== "string") errors.push("narrativeReading.whatYouReallyBuy missing");
    if (!Array.isArray(nr.blindSpots) || nr.blindSpots.length < 3)
      errors.push("narrativeReading.blindSpots must have 3+ items");
    if (typeof nr.priceBasis !== "string") errors.push("narrativeReading.priceBasis missing");
  }

  // Dimension scores
  const ds = d.dimensionScores;
  if (!Array.isArray(ds) || ds.length !== 5) {
    errors.push("dimensionScores must have exactly 5 items");
  } else {
    const axesSeen = new Set<string>();
    for (const item of ds) {
      if (!isObj(item)) {
        errors.push("dimensionScores item must be object");
        continue;
      }
      const axis = item.axis;
      const score = item.score;
      const comment = item.comment;

      if (typeof axis !== "string" || !AXES.includes(axis as any)) errors.push("dimensionScores.axis invalid");
      else axesSeen.add(axis);

      if (typeof score !== "number" || score < 1 || score > 10) errors.push("dimensionScores.score must be 1-10");
      if (typeof comment !== "string" || comment.length < 3) errors.push("dimensionScores.comment invalid");
    }
    if (axesSeen.size !== 5) errors.push("dimensionScores must include all 5 axes exactly once");
  }

  // Proofs
  const proofs = d.proofs;
  if (!isObj(proofs)) errors.push("proofs missing");
  else {
    const qf = proofs.quickFacts;
    if (!Array.isArray(qf) || qf.length < 3 || qf.length > 6)
      errors.push("proofs.quickFacts must have 3-6 items");

    const pd = proofs.priceDefensibility;
    if (!isObj(pd)) errors.push("proofs.priceDefensibility missing");
    else {
      if (!PD_STATUS.includes(pd.status as any)) errors.push("priceDefensibility.status invalid");
      if (pd.rationale !== undefined && !isStringArray(pd.rationale)) errors.push("priceDefensibility.rationale invalid");
    }

    // documentsIndex is optional but if present, it must be array
    if (proofs.documentsIndex !== undefined && !Array.isArray(proofs.documentsIndex))
      errors.push("proofs.documentsIndex invalid");
  }

  // Reasons
  const reasons = d.reasons;
  if (!Array.isArray(reasons) || reasons.length < 2 || reasons.length > 4)
    errors.push("reasons must have 2-4 items");

  // RedFlags optional in some UIs, but in your app you always expect it.
  // Keep it tolerant: if present, must be array.
  if (d.redFlags !== undefined && !Array.isArray(d.redFlags)) errors.push("redFlags invalid");

  // Ammo
  const ammo = d.ammo;
  if (!isObj(ammo)) errors.push("ammo missing");
  else {
    const asks = ammo.asks;
    if (!Array.isArray(asks) || asks.length < 3) errors.push("ammo.asks must have 3+ items");

    const pvq = ammo.preVisitQuestions;
    if (!Array.isArray(pvq) || pvq.length < 3) errors.push("ammo.preVisitQuestions must have 3+ items");

    const vc = ammo.visitChecklist;
    if (!Array.isArray(vc) || vc.length < 5) errors.push("ammo.visitChecklist must have 5+ items");
  }

  // Offer logic
  const offer = d.offer;
  if (!isObj(offer)) errors.push("offer missing");
  else {
    const decision = isObj(verdict) ? (verdict.decision as string) : undefined;

    if (decision === "ÉCARTEZ" && offer.available !== false)
      errors.push("offer.available must be false when ÉCARTEZ");
    if (decision && decision !== "ÉCARTEZ" && offer.available !== true)
      errors.push("offer.available must be true when not ÉCARTEZ");

    if (offer.available === true && !offer.agentMessageTemplate)
      errors.push("agentMessageTemplate required when offer.available");
  }

  // Disclaimer
  const disc = d.disclaimer;
  if (!Array.isArray(disc) || disc.length !== 2) errors.push("disclaimer must have exactly 2 items");

  // PhotoScan (optional)
  const ps = d.photoScan;
  if (ps !== undefined) {
    if (!isObj(ps)) errors.push("photoScan must be object when present");
    else {
      if (typeof ps.usedPhotosCount !== "number" || ps.usedPhotosCount < 0)
        errors.push("photoScan.usedPhotosCount invalid");
      if (!PHOTO_CONF.includes(ps.photoConfidence as any)) errors.push("photoScan.photoConfidence invalid");

      if (!isStringArray(ps.observations) || ps.observations.length < 1)
        errors.push("photoScan.observations must be string[] non-empty");
      if (!isStringArray(ps.blindSpots) || ps.blindSpots.length < 1)
        errors.push("photoScan.blindSpots must be string[] non-empty");
      if (!isStringArray(ps.stagingSignals) || ps.stagingSignals.length < 1)
        errors.push("photoScan.stagingSignals must be string[] non-empty");
      if (!isStringArray(ps.photoProofGaps) || ps.photoProofGaps.length < 1)
        errors.push("photoScan.photoProofGaps must be string[] non-empty");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}