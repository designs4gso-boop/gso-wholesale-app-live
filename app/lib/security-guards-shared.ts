// Phase 15G.1 — security / data-safety lockdown shared helpers.
// Client-safe and dependency-free: pure data + pure functions. No Prisma, no
// Shopify, no server imports — tests import ONLY this module (repo convention).

// ---------- public storefront payload hygiene ----------
// Field names that must never serialize on a public storefront response.
// Applied as a deep strip over the final proxy payloads (defense in depth on
// top of building the payloads without these fields in the first place).
export const INTERNAL_COST_FIELDS = [
  "costEach",
  "totalCost",
  "totalProfit",
  "profitEach",
  "margin",
  "marginPct",
  "unitCost",
  "costSnapshot",
  "materialCost",
  "laborCost",
  "machineCost",
  "inkCost",
  "setupCost",
  "accessToken",
  "stack",
] as const;

const INTERNAL_COST_FIELD_SET = new Set<string>(INTERNAL_COST_FIELDS);

export function stripInternalCostFields<T>(value: T, seen = new WeakSet<object>()): T {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value as object)) return Array.isArray(value) ? ([] as unknown as T) : ({} as T);
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((entry) => stripInternalCostFields(entry, seen)) as unknown as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_COST_FIELD_SET.has(key)) continue;
    output[key] = stripInternalCostFields(entry, seen);
  }
  return output as T;
}

// Shopify draftOrderCreate userErrors -> customer-safe {field, message} rows.
// Only plain strings survive; anything malformed becomes a generic message.
export function sanitizeDraftOrderUserErrors(errors: unknown): Array<{ field: string | null; message: string }> {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 10).map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const rawField = record.field;
    const field = Array.isArray(rawField)
      ? rawField.map((part) => String(part)).join(".").slice(0, 120) || null
      : rawField != null && rawField !== ""
        ? String(rawField).slice(0, 120)
        : null;
    const message = String(record.message || "Invalid input.").slice(0, 300);
    return { field, message };
  });
}

export const PUBLIC_CHECKOUT_ERROR_MESSAGE =
  "Checkout could not be completed. Please try again or contact the shop.";

// Fixed customer-safe failure body — never derived from the caught error.
// The caller logs the real error server-side before returning this.
export function publicCheckoutFailure(): { ok: false; error: string } {
  return { ok: false, error: PUBLIC_CHECKOUT_ERROR_MESSAGE };
}

// ---------- 15G.1A: production-agent credential masking ----------
// Staff/public UI must never render a full print-intake / RIP upload token
// (or any other production-agent bearer credential). Loaders send only this
// masked status to the browser; the raw value stays server-side. The suffix
// reveals at most the LAST 4 characters and only when the credential is long
// enough (>= 12 chars) that 4 characters cannot help reconstruct it.
export const CREDENTIAL_PLACEHOLDER = "<PRINT_INTAKE_TOKEN>";
export const CREDENTIAL_MIN_LENGTH_FOR_SUFFIX = 12;

export type MaskedCredential = { configured: boolean; maskedSuffix: string | null };

export function maskCredential(value: unknown): MaskedCredential {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) return { configured: false, maskedSuffix: null };
  if (token.length < CREDENTIAL_MIN_LENGTH_FOR_SUFFIX) return { configured: true, maskedSuffix: null };
  return { configured: true, maskedSuffix: `****${token.slice(-4)}` };
}

export function credentialStatusLabel(masked: MaskedCredential): string {
  if (!masked.configured) return "Not configured";
  return masked.maskedSuffix ? `Configured (${masked.maskedSuffix})` : "Configured";
}

// ---------- typed confirmation phrases (owner destructive-action gates) ----------
export const OWNER_SHOPIFY_PRICE_PUSH_PHRASE = "OWNER SHOPIFY PRICE PUSH";
export const MARGIN_REVIEW_PUSH_WARNING =
  "Margin Review pricing is under recalibration. Live price pushes require owner confirmation.";
export const OWNER_RESET_SETTINGS_PHRASE = "OWNER RESET SETTINGS";
export const RESET_PILOT_DATA_PHRASE = "RESET STOCK BAG PILOT";

export function phraseGateOk(input: unknown, phrase: string): boolean {
  if (!phrase) return false;
  return String(input ?? "").trim() === phrase;
}

// ---------- Admin Settings reset protection ----------
// Reset Defaults may only touch the page's own key/value defaults. Owner
// pricing envelopes (ownerConfig.*, category OwnerConfig) and the Pricing
// Intelligence records (pricingIntelligence.*, e.g. the live-sales cutoff)
// are NEVER deletable from that page.
export const PROTECTED_SETTING_KEY_PREFIXES = ["ownerConfig.", "pricingIntelligence."];
export const PROTECTED_SETTING_CATEGORIES = ["OwnerConfig"];

export function isProtectedSettingKey(key: string, category?: string | null): boolean {
  const normalizedKey = String(key || "");
  if (PROTECTED_SETTING_KEY_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))) return true;
  if (category && PROTECTED_SETTING_CATEGORIES.includes(String(category))) return true;
  return false;
}

export function resettableSettingKeys(definitionKeys: string[]): string[] {
  const unique = new Set<string>();
  for (const key of definitionKeys || []) {
    const normalized = String(key || "").trim();
    if (!normalized || isProtectedSettingKey(normalized)) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

// Returns a delete filter that can only ever match the explicit resettable
// keys for the shop — never a bare {shop} that would wipe the whole table.
// null = fail closed (caller must abort the reset).
export function buildAdminResetWhere(
  shop: string,
  definitionKeys: string[],
): { shop: string; key: { in: string[] } } | null {
  const normalizedShop = String(shop || "").trim();
  const keys = resettableSettingKeys(definitionKeys);
  if (!normalizedShop || keys.length === 0) return null;
  return { shop: normalizedShop, key: { in: keys } };
}

// ---------- shop-scoped mutations ----------
// Every shop-owned record mutation must verify the record belongs to the
// authenticated shop — never trust the record id alone. These helpers wrap
// Prisma's updateMany/deleteMany (which accept a compound where) and fail
// closed on a zero count. The model is injected so tests can prove the
// behavior with an in-memory fake instead of a real database.
export type CountResult = { count: number };
export type ScopedWriteResult =
  | { ok: true; count: number }
  | { ok: false; status: 400 | 404; error: string };

function missingScope(shop: string, id: unknown): boolean {
  if (!String(shop || "").trim()) return true;
  if (id == null) return true;
  if (typeof id === "string" && id.trim() === "") return true;
  if (typeof id === "number" && !Number.isFinite(id)) return true;
  return false;
}

export async function updateOwnedRecord(
  model: { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<CountResult> },
  shop: string,
  id: string | number,
  data: Record<string, unknown>,
): Promise<ScopedWriteResult> {
  if (missingScope(shop, id)) return { ok: false, status: 400, error: "Missing shop or record id." };
  const result = await model.updateMany({ where: { id, shop }, data });
  if (!result || result.count <= 0) return { ok: false, status: 404, error: "Record not found for this shop." };
  return { ok: true, count: result.count };
}

export async function deleteOwnedRecord(
  model: { deleteMany: (args: { where: Record<string, unknown> }) => Promise<CountResult> },
  shop: string,
  id: string | number,
): Promise<ScopedWriteResult> {
  if (missingScope(shop, id)) return { ok: false, status: 400, error: "Missing shop or record id." };
  const result = await model.deleteMany({ where: { id, shop } });
  if (!result || result.count <= 0) return { ok: false, status: 404, error: "Record not found for this shop." };
  return { ok: true, count: result.count };
}
