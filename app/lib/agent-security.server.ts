// Agent platform security policy and auth crypto. No database, no Shopify.
// External agents are intake-only: the sole recognized scope is intake:create.
import crypto from "node:crypto";

export const AGENT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
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

export function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function timingSafeEqualString(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Canonical token format: "Bearer tokenId.tokenSecret", split on the FIRST
// dot. A colon is tolerated as a legacy separator only when no valid dot
// split exists; the Agent Security page always displays the dot form.
export function parseAgentBearer(header: string | null | undefined) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const value = match[1].trim();

  let separatorIndex = value.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    separatorIndex = value.indexOf(":");
  }
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  return {
    tokenId: value.slice(0, separatorIndex),
    tokenSecret: value.slice(separatorIndex + 1),
  };
}

// Accepts unix milliseconds, unix seconds (normalized: second-scale values
// are unambiguous below 1e11), or any Date.parse()-able string. The tolerance
// window itself is unchanged.
export function parseAgentTimestamp(
  value: string,
  toleranceMs = AGENT_TIMESTAMP_TOLERANCE_MS,
  now = Date.now(),
) {
  const numeric = Number(value);
  let timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp > 0 && timestamp < 1e11) timestamp *= 1000;
  return Math.abs(now - timestamp) <= toleranceMs ? timestamp : null;
}

export function verifyAgentSignature(tokenSecret: string, timestamp: string, rawBody: string, signature: string) {
  const expected = crypto.createHmac("sha256", tokenSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  return timingSafeEqualString(expected.toLowerCase(), String(signature || "").trim().toLowerCase());
}
