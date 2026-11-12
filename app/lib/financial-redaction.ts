// 2026-11-11 OWNER DECISION — internal-financial redaction for server payloads.
//
// Internal vendor / unit / purchase / material / ink / machine / labor cost,
// profit, margin and internal floors may reach the browser ONLY for owners and
// managers the owner authorized for financials. For everyone else a loader must
// strip them BEFORE serialization — hiding a number in JSX is not enough.
//
// Pure, client-safe. Deep-copies; never mutates the input.

/** Keys that carry internal financial values (matched case-insensitively). */
const SENSITIVE_KEY = /(cost|price|margin|profit|floor|landed|markup|valuation|costimpact)/i;

/** Keys that look sensitive but carry no money (kept). */
const SAFE_KEYS = new Set(["costReviewNeeded", "costUnderReview", "priority", "costSource", "canSeeCost"]);

export function isSensitiveFinancialKey(key: string): boolean {
  return !SAFE_KEYS.has(key) && SENSITIVE_KEY.test(key);
}

/** Deep copy with every internal-financial key removed (arrays / nested objects / Dates handled). */
export function stripInternalFinancials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => stripInternalFinancials(entry)) as unknown as T;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFinancialKey(key)) continue;
      out[key] = stripInternalFinancials(entry);
    }
    return out as T;
  }
  return value;
}

/** Every sensitive key path still present (for adversarial tests). */
export function findInternalFinancialKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => findInternalFinancialKeys(entry, `${path}[${index}]`));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      (isSensitiveFinancialKey(key) ? [`${path}.${key}`] : []).concat(findInternalFinancialKeys(entry, `${path}.${key}`)),
    );
  }
  return [];
}
