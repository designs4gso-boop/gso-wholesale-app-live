// Agent platform security policy. Pure helpers only — no database, no Shopify.
// External agents are intake-only: the sole recognized scope is intake:create.

export const AGENT_RATE_LIMIT_PER_HOUR = 60;
export const AGENT_RATE_LIMIT_BURST_PER_MINUTE = 10;
export const AGENT_AUTH_FAILURE_BRAKE_LIMIT = 100;
export const AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES = 5;
export const AGENT_REPLAY_WINDOW_MINUTES = 10;
export const AGENT_INTAKE_SCOPE = "intake:create";

function stringList(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// null scopes = legacy credential created before scope enforcement: allowed.
// Any non-null scopes value must explicitly include intake:create, so a
// malformed Json shape (object/string/number) denies safely.
export function credentialAllowsIntake(scopes: unknown): boolean {
  const list = stringList(scopes);
  if (list === null) return true;
  return list.includes(AGENT_INTAKE_SCOPE);
}

// null allowedProductFamilies = all families allowed (legacy / unrestricted).
// A non-null list must contain the normalized submitted family key.
export function familyAllowed(allowedProductFamilies: unknown, normalizedFamily: string): boolean {
  const list = stringList(allowedProductFamilies);
  if (list === null) return true;
  return list.includes(String(normalizedFamily || "").trim().toLowerCase());
}
