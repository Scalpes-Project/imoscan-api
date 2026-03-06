// lib/tone.ts
// Safety net normalizer - prompt is source of truth, this catches edge cases

const REPLACEMENTS: [RegExp, string][] = [
  [/\btu\b/gi, "vous"],
  [/\bton\b/gi, "votre"],
  [/\bta\b/gi, "votre"],
  [/\btes\b/gi, "vos"],
  [/\btoi\b/gi, "vous"],
];

export function normalizeVouvoiement(input: string): string {
  let result = input;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function normalizeJsonStringsVouvoiement<T>(obj: T): T {
  if (typeof obj === "string") {
    return normalizeVouvoiement(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeJsonStringsVouvoiement) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = normalizeJsonStringsVouvoiement(value);
    }
    return result as T;
  }
  return obj;
}
