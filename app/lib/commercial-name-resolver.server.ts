// Shared commercial-name resolver (Patch 15D.2). ONE precedence for every
// customer/product display name across calculator saves, Quote/CRM display,
// Shopify order line titles, and production items/filenames.
//
// Root causes fixed here (live-tested 15D.1):
//   "Unnamed Quote"  — calculator quotes save without customer/company and the
//                      CRM fell back to a literal.
//   "NoProduction Test Sticker selected / unknown" — the calculator's product
//                      name input was PREFILLED with the placeholder
//                      "Not selected / unknown" (the manual panel's
//                      family-fallback label); typing into it without clearing
//                      fused the pieces, and nothing sanitized server-side.
//
// Precedence (15D.2-B): explicit owner-entered name -> selected
// VendorProduct/recipe name -> product/profile label -> quote-item title ->
// family owner label -> "Custom Quote". Placeholder fragments are NEVER
// concatenated into names.

const PLACEHOLDER_EXACT = new Set([
  "",
  "not selected / unknown",
  "not selected",
  "unknown",
  "n/a",
  "na",
  "none",
  "no product selected",
  "selected product",
  "custom quote",
  "emergency calculator item",
  "custom item",
  "— select —",
  "select",
]);

// fragments stripped out of corrupted composites (longest first)
const PLACEHOLDER_FRAGMENTS = [
  "not selected / unknown",
  "selected / unknown",
  "no product selected",
  "not selected",
  "unknown",
  "n/a",
];

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function isPlaceholderName(value: unknown): boolean {
  const normalized = normalize(value).toLowerCase();
  return PLACEHOLDER_EXACT.has(normalized);
}

// Trims, strips placeholder fragments, and repairs the known prefill
// corruption ("Not selected / unknown" typed-into): if a fragment was present
// AND the remainder starts with "No" fused onto a capitalized word, the "No"
// is the orphaned head of "Not …" and is dropped. Returns null when nothing
// meaningful remains.
export function cleanCommercialName(value: unknown): string | null {
  let text = normalize(value);
  if (!text) return null;
  let hadFragment = false;
  for (const fragment of PLACEHOLDER_FRAGMENTS) {
    const pattern = new RegExp(fragment.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "gi");
    if (pattern.test(text)) {
      hadFragment = true;
      text = text.replace(pattern, " ");
    }
  }
  text = normalize(text.replace(/\s*[/|–—-]\s*$/g, "").replace(/^\s*[/|–—-]\s*/g, ""));
  if (hadFragment) {
    // orphaned "No" head from "Not selected …" prefill corruption only —
    // legitimate names starting with "No…" (no fragment present) are untouched
    text = normalize(text.replace(/^No(?=[A-Z])/, ""));
  }
  if (!text || isPlaceholderName(text)) return null;
  return text.slice(0, 120);
}

// First clean candidate wins; safe fallback "Custom Quote".
export function resolveProductDisplayName(candidates: Array<unknown>): string {
  for (const candidate of candidates) {
    const cleaned = cleanCommercialName(candidate);
    if (cleaned) return cleaned;
  }
  return "Custom Quote";
}

// Quote display name (15D.2-C): "<Customer> — <Product>" | product | customer
// | "Custom Quote". Company preferred over contact name for the customer part.
export function resolveQuoteDisplayName(input: { company?: unknown; customerName?: unknown; productName?: unknown }): string {
  const customer = cleanCommercialName(input.company) || cleanCommercialName(input.customerName);
  const product = cleanCommercialName(input.productName);
  if (customer && product) return `${customer} — ${product}`;
  if (product) return product;
  if (customer) return customer;
  return "Custom Quote";
}

// Safe token for folders / RIP names / print filenames (15D.2-G): uppercase,
// placeholder-stripped, unsafe characters replaced, collapsed hyphens, capped
// length, never blank. "Production Test Sticker" -> "PRODUCTION-TEST-STICKER".
export function safeNameToken(value: unknown, fallback = "ITEM", maxLength = 40): string {
  const cleaned = cleanCommercialName(value) ?? "";
  const token = cleaned
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, "-") // keep digits + dots (dimensions like 4X5 / 2.5)
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return token || fallback;
}
