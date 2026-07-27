// Pricing Intelligence evidence capture (15F.0K.4D). Pure, testable core for
// quote outcomes, test-data exclusion, conservative basket classification,
// and threshold-gated evidence aggregation. NOTHING here creates market
// targets or reprices anything — advisory evidence counting only. The
// 2026-07-26 audit found ~5-7 genuine accepted line items total, so tiny-n
// statistics are deliberately withheld until the thresholds below pass.

import crypto from "node:crypto";

// ---------- quote outcomes (A) ----------
export const QUOTE_OUTCOME_STATUSES = ["won", "lost", "canceled", "expired"] as const;
export type QuoteOutcomeStatus = (typeof QUOTE_OUTCOME_STATUSES)[number];
// Statuses whose price the customer ACCEPTED (evidence-eligible). The legacy
// paid ladder remains accepted history; `won` is the new explicit outcome.
export const ACCEPTED_EVIDENCE_STATUSES = ["won", "deposit_paid", "paid", "production", "completed"];
export const LOST_EVIDENCE_STATUSES = ["lost", "canceled", "expired"];
export const OUTCOME_REASON_MIN_LENGTH = 3;

export type QuoteOutcomeChange =
  | { ok: true; status: string; outcomeAt: Date | null; outcomeReason: string | null; clearsOutcome: boolean }
  | { ok: false; message: string };

// One pure resolver for the quotes route: outcome statuses stamp
// outcomeAt/outcomeReason (lost/canceled REQUIRE a reason; expired optional;
// won optional); returning to draft/sent CLEARS the outcome fields; every
// other existing status transition leaves outcome fields untouched.
export function resolveQuoteOutcomeChange(input: { nextStatus: string; reason?: string | null; now?: Date }): QuoteOutcomeChange {
  const nextStatus = String(input.nextStatus || "").trim();
  const reason = String(input.reason || "").trim();
  const now = input.now ?? new Date();
  if (nextStatus === "lost" || nextStatus === "canceled") {
    if (reason.length < OUTCOME_REASON_MIN_LENGTH) {
      return { ok: false, message: `Marking a quote ${nextStatus} requires a short reason (at least ${OUTCOME_REASON_MIN_LENGTH} characters).` };
    }
    return { ok: true, status: nextStatus, outcomeAt: now, outcomeReason: reason.slice(0, 300), clearsOutcome: false };
  }
  if (nextStatus === "won" || nextStatus === "expired") {
    return { ok: true, status: nextStatus, outcomeAt: now, outcomeReason: reason ? reason.slice(0, 300) : null, clearsOutcome: false };
  }
  if (nextStatus === "draft" || nextStatus === "sent") {
    return { ok: true, status: nextStatus, outcomeAt: null, outcomeReason: null, clearsOutcome: true };
  }
  // existing ladder statuses (approved/deposit_paid/paid/production/completed):
  // untouched outcome fields — signalled by clearsOutcome false + null stamps.
  return { ok: true, status: nextStatus, outcomeAt: null, outcomeReason: null, clearsOutcome: false };
}

// ---------- test-data exclusion (C) ----------
// CONSERVATIVE: exact known artifacts + unambiguous markers only. A common
// word like "Test" inside a legitimate product name (title-case) is NOT
// enough on its own — only the ALL-CAPS standalone TEST token (calibration
// precedent), test_ source ids, known audit artifacts, test emails, explicit
// [TEST DATA] markers, and non-positive quantity/price exclude a record.
const KNOWN_TEST_ARTIFACTS = [
  "cmyk routing test", // synthetic routing test (audit 2026-07-26)
  "noproduction test", // corrupted-name sticker test artifact (15D.2 audit)
  "pipeline test", // GSO PIPELINE TEST print-intake fixtures
  "production test sticker", // 15D.2 repaired test artifact display name
];

export type EvidenceExclusion = { excluded: boolean; reasons: string[] };

export function evidenceExclusion(record: {
  sourceId?: string | null; // quoteId / job quoteId / external source id
  productName?: string | null;
  customerName?: string | null;
  email?: string | null;
  notes?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
}): EvidenceExclusion {
  const reasons: string[] = [];
  const sourceId = String(record.sourceId || "");
  if (/^test_/i.test(sourceId)) reasons.push(`test source id (${sourceId.slice(0, 24)})`);
  const textFields = [record.productName, record.customerName, record.notes].map((value) => String(value || ""));
  const joined = textFields.join(" \n ");
  if (/\bTEST\b/.test(joined)) reasons.push("explicit all-caps TEST marker");
  const lowered = joined.toLowerCase();
  for (const artifact of KNOWN_TEST_ARTIFACTS) {
    if (lowered.includes(artifact)) { reasons.push(`known test artifact ("${artifact}")`); break; }
  }
  const email = String(record.email || "").toLowerCase();
  if (email && (/(^|[.+_-])test@/.test(email) || email.endsWith("@example.com"))) reasons.push("test email address");
  if (String(record.notes || "").includes("[TEST DATA]")) reasons.push("explicit [TEST DATA] marker");
  if (record.quantity != null && !(Number(record.quantity) > 0)) reasons.push("non-positive quantity");
  if (record.unitPrice != null && !(Number(record.unitPrice) > 0)) reasons.push("non-positive unit price");
  return { excluded: reasons.length > 0, reasons };
}

// ---------- conservative basket classification (E) ----------
// unknown NEVER merges into a precise basket: the unknown value is its own
// basket segment, so a record without verified sides/gloss/material can
// never contaminate a narrowly defined basket. 4X is never treated as 3X.
export type EvidenceBasket = {
  family: string; // sticker-bags | stickers-labels | premium-jars | standard-jars | banners | dtp-bags | custom-item | unknown
  sizeToken: string; // e.g. 4x5 | 100ml | unknown
  productForm: "finished_applied" | "labels_only" | "jar_labels" | "finished_jar_set" | "unknown";
  sides: "1" | "2" | "unknown";
  materialClass: "matte" | "gloss" | "holographic" | "clear" | "unknown";
  whiteLayers: string; // "0" | "1".. | "unknown"
  glossStage: string; // "0" | "1" | "3" | "4" | "5" | "7" | "unknown"
  qtyBand: string;
};

export const QTY_BANDS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 1, max: 63, label: "1-63" },
  { min: 64, max: 127, label: "64-127" },
  { min: 128, max: 255, label: "128-255" },
  { min: 256, max: 499, label: "256-499" },
  { min: 500, max: 999, label: "500-999" },
  { min: 1000, max: 2499, label: "1000-2499" },
  { min: 2500, max: 4999, label: "2500-4999" },
  { min: 5000, max: null, label: "5000+" },
];

export function qtyBandFor(quantity: number): string {
  const qty = Math.floor(Number(quantity) || 0);
  for (const band of QTY_BANDS) if (qty >= band.min && (band.max == null || qty <= band.max)) return band.label;
  return "unknown";
}

const SIZE_RE = /(\d{1,2}\s*[xX]\s*\d{1,2})|((?:50|100|150|250)\s*ml)|([345]\s*oz)/;

export function classifyEvidenceBasket(input: {
  productName?: string | null;
  variantTitle?: string | null;
  selectedFinish?: string | null;
  costSnapshot?: string | null; // QuoteItem.costSnapshot JSON string
  // 15F.0K.4E: Shopify line-item custom attributes / product type — treated
  // as STRUCTURED text (properties beat title inference simply because they
  // carry the configurator vocabulary verbatim).
  attributeText?: string | null;
  quantity: number;
}): EvidenceBasket {
  const text = [input.attributeText, input.productName, input.variantTitle, input.selectedFinish].map((value) => String(value || "")).join(" | ");
  const lowered = text.toLowerCase();

  let family = "unknown";
  let sides: EvidenceBasket["sides"] = "unknown";
  let materialClass: EvidenceBasket["materialClass"] = "unknown";
  let whiteLayers = "unknown";
  let glossStage = "unknown";
  let productForm: EvidenceBasket["productForm"] = "unknown";

  // 1) snapshot is the most trustworthy source when present
  if (input.costSnapshot) {
    try {
      const snapshot = JSON.parse(input.costSnapshot);
      const canonical = snapshot?.productBreakdown?.canonicalFamily || snapshot?.canonicalFamily;
      if (typeof canonical === "string" && canonical) family = canonical;
      const selections = snapshot?.productBreakdown?.selections || snapshot?.selections;
      if (selections) {
        if (Number.isFinite(Number(selections.whiteLayers))) whiteLayers = String(Math.floor(Number(selections.whiteLayers)));
        if (Number.isFinite(Number(selections.glossLayers))) glossStage = String(Math.floor(Number(selections.glossLayers)));
        const faces = Math.floor(Number(selections.faces));
        if (faces === 1) sides = "1";
        if (faces >= 2) sides = "2";
      }
    } catch {
      // unparseable snapshot -> stay unknown (never guess)
    }
  }

  // 2) conservative text parsing (configurator variant vocabulary)
  if (family === "unknown") {
    if (/\bbag\b/i.test(text)) family = "sticker-bags";
    else if (/\bjar\b|\bmiron\b|\bchiron\b/i.test(text)) family = /miron|chiron/i.test(text) ? "premium-jars" : "standard-jars";
    else if (/sticker|label/i.test(text)) family = "stickers-labels";
    else if (/banner/i.test(text)) family = "banners";
    else if (/pouch|dtp/i.test(text)) family = "dtp-bags";
  }
  if (materialClass === "unknown") {
    if (/holographic|\bholo\b/i.test(text)) materialClass = "holographic";
    else if (/\bclear\b/i.test(text) && !/clear jar|3oz clear|4oz clear|5oz clear/i.test(text)) materialClass = "clear";
    else if (/\bmatte\b/i.test(text)) materialClass = "matte";
    else if (/\bgloss(?!\s*-?\s*\d)/i.test(text) && !/spot gloss/i.test(text)) materialClass = "gloss";
  }
  if (glossStage === "unknown") {
    const spot = text.match(/(\d)\s*[xX]\s*Spot\s*Gloss/i) || text.match(/GLOSS-(\d)X/i);
    if (spot) glossStage = spot[1];
    else if (/no\s*spot\s*gloss/i.test(text)) glossStage = "0";
  }
  if (whiteLayers === "unknown" && /white/i.test(text) && materialClass !== "unknown") {
    // "Holo + White + 4X Spot Gloss" style — presence known, count not
    whiteLayers = /white/i.test(text) ? "1+" : "unknown";
  }
  if (sides === "unknown") {
    if (/double|front\s*(and|\+|&)\s*back|both sides/i.test(text)) sides = "2";
    else if (/single|front only|one side/i.test(text)) sides = "1";
  }
  if (productForm === "unknown") {
    if (/side\s*\+\s*lid|jar/i.test(text) && family.includes("jar")) productForm = /label only|labels only/i.test(text) ? "jar_labels" : "finished_jar_set";
    else if (family === "sticker-bags") productForm = /label only|labels only|unapplied/i.test(text) ? "labels_only" : "finished_applied";
    else if (family === "stickers-labels") productForm = "labels_only";
  }

  const sizeMatch = text.match(SIZE_RE);
  const sizeToken = sizeMatch ? sizeMatch[0].toLowerCase().replace(/\s+/g, "") : "unknown";

  return { family, sizeToken, productForm, sides, materialClass, whiteLayers, glossStage, qtyBand: qtyBandFor(input.quantity) };
}

export function basketKey(basket: EvidenceBasket): string {
  return [basket.family, basket.sizeToken, basket.productForm, `sides:${basket.sides}`, basket.materialClass, `white:${basket.whiteLayers}`, `gloss:${basket.glossStage}`, basket.qtyBand].join(" | ");
}

// ---------- privacy-safe customer key ----------
export function customerKey(email?: string | null, name?: string | null): string {
  const seed = String(email || "").trim().toLowerCase() || String(name || "").trim().toLowerCase() || "unknown-customer";
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

// ---------- threshold-gated confidence (D4) ----------
export const EVIDENCE_MIN_ACCEPTED = 5;
export const EVIDENCE_MIN_CUSTOMERS = 3;
export const EVIDENCE_MIN_MONTHS = 2;
export const MSG_NOT_ENOUGH_HISTORY = "Not enough verified sales history yet";
export const MSG_INSUFFICIENT_CUSTOMERS = "Insufficient customer diversity";
export const MSG_INSUFFICIENT_MONTHS = "Insufficient time coverage";

export type EvidenceConfidence = { eligible: boolean; message: string };

export function evidenceConfidence(input: { accepted: number; distinctCustomers: number; distinctMonths: number }): EvidenceConfidence {
  if (input.accepted < EVIDENCE_MIN_ACCEPTED) return { eligible: false, message: `${MSG_NOT_ENOUGH_HISTORY} (${input.accepted}/${EVIDENCE_MIN_ACCEPTED} accepted)` };
  if (input.distinctCustomers < EVIDENCE_MIN_CUSTOMERS) return { eligible: false, message: `${MSG_INSUFFICIENT_CUSTOMERS} (${input.distinctCustomers}/${EVIDENCE_MIN_CUSTOMERS} customers)` };
  if (input.distinctMonths < EVIDENCE_MIN_MONTHS) return { eligible: false, message: `${MSG_INSUFFICIENT_MONTHS} (${input.distinctMonths}/${EVIDENCE_MIN_MONTHS} months)` };
  return { eligible: true, message: "Display-eligible (advisory only — never an automatic market target)" };
}

// ---------- evidence records + aggregation (D) ----------
export type EvidenceRecord = {
  source: "erp_quote" | "production_job" | "shopify_order"; // shopify_order live since 15F.0K.4E
  basket: EvidenceBasket;
  key: string;
  quantity: number;
  unitPrice: number; // for shopify_order: REALIZED net unit price after all allocated discounts
  state: "accepted" | "lost" | "open";
  customerKey: string; // hashed — raw identity never leaves the loader
  evidenceAt: Date;
  exactSnapshot: boolean; // true when classified from a structured snapshot (exact match capable)
  // 15F.0K.4E: Shopify discount detail (gross/allocated/net) — audit only
  pricing?: { grossLineTotal: number; allocatedDiscount: number; netLineTotal: number; netUnitPrice: number };
};

export type BasketAggregate = {
  key: string;
  basket: EvidenceBasket;
  accepted: number;
  exactMatches: number;
  nearMatches: number;
  lost: number;
  open: number;
  distinctCustomers: number;
  distinctMonths: number;
  earliest: string | null;
  latest: string | null;
  // 15F.0K.4E: accepted evidence per source (local ERP vs Shopify stay
  // distinguishable while combining for the thresholds)
  sourceCounts: { erp_quote: number; production_job: number; shopify_order: number };
  confidence: EvidenceConfidence;
  // present ONLY when confidence.eligible (threshold-gated; advisory only)
  acceptedLow: number | null;
  acceptedMedian: number | null;
  acceptedHigh: number | null;
  recentAcceptedMedian: number | null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregateEvidence(records: EvidenceRecord[]): BasketAggregate[] {
  const groups = new Map<string, EvidenceRecord[]>();
  for (const record of records) {
    const list = groups.get(record.key) || [];
    list.push(record);
    groups.set(record.key, list);
  }
  const aggregates: BasketAggregate[] = [];
  for (const [key, list] of groups) {
    const accepted = list.filter((record) => record.state === "accepted");
    const lost = list.filter((record) => record.state === "lost");
    const open = list.filter((record) => record.state === "open");
    const customers = new Set(accepted.map((record) => record.customerKey));
    const months = new Set(accepted.map((record) => `${record.evidenceAt.getUTCFullYear()}-${record.evidenceAt.getUTCMonth() + 1}`));
    const confidence = evidenceConfidence({ accepted: accepted.length, distinctCustomers: customers.size, distinctMonths: months.size });
    const prices = accepted.map((record) => record.unitPrice);
    const recent = accepted.filter((record) => Date.now() - record.evidenceAt.getTime() <= 1000 * 60 * 60 * 24 * 120).map((record) => record.unitPrice);
    const dates = list.map((record) => record.evidenceAt.getTime());
    aggregates.push({
      key,
      basket: list[0].basket,
      accepted: accepted.length,
      exactMatches: accepted.filter((record) => record.exactSnapshot).length,
      nearMatches: accepted.filter((record) => !record.exactSnapshot).length,
      lost: lost.length,
      open: open.length,
      distinctCustomers: customers.size,
      distinctMonths: months.size,
      earliest: dates.length ? new Date(Math.min(...dates)).toISOString().slice(0, 10) : null,
      latest: dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null,
      sourceCounts: {
        erp_quote: accepted.filter((record) => record.source === "erp_quote").length,
        production_job: accepted.filter((record) => record.source === "production_job").length,
        shopify_order: accepted.filter((record) => record.source === "shopify_order").length,
      },
      confidence,
      acceptedLow: confidence.eligible ? Math.min(...prices) : null,
      acceptedMedian: confidence.eligible ? median(prices) : null,
      acceptedHigh: confidence.eligible ? Math.max(...prices) : null,
      recentAcceptedMedian: confidence.eligible ? median(recent) : null,
    });
  }
  return aggregates.sort((a, b) => b.accepted - a.accepted || a.key.localeCompare(b.key));
}

// ---------- gather (thin DB wrapper; identities hashed before return) ----------
export async function gatherPricingEvidence(dbClient: any, shop: string): Promise<{
  records: EvidenceRecord[];
  excluded: Array<{ label: string; source: string; reasons: string[] }>;
  totals: { reviewed: number; eligible: number; excluded: number; won: number; lost: number; open: number; distinctCustomers: number };
}> {
  const [quotes, jobItems] = await Promise.all([
    dbClient.quote.findMany({
      where: { shop },
      select: {
        id: true, status: true, email: true, customerName: true, createdAt: true, updatedAt: true, outcomeAt: true, notes: true,
        items: { select: { productName: true, variant: true, sku: true, quantity: true, unitPrice: true, selectedFinish: true, costSnapshot: true } },
      },
      take: 2000,
    }),
    dbClient.productionJobItem.findMany({
      select: {
        productTitle: true, variantTitle: true, quantity: true, unitPrice: true, selectedFinish: true, costSnapshot: true, createdAt: true,
        job: { select: { shop: true, quoteId: true, status: true, customerName: true, email: true } },
      },
      take: 2000,
    }),
  ]);

  const records: EvidenceRecord[] = [];
  const excluded: Array<{ label: string; source: string; reasons: string[] }> = [];
  const allCustomers = new Set<string>();
  let won = 0; let lost = 0; let open = 0;

  for (const quote of quotes) {
    for (const item of quote.items) {
      const exclusion = evidenceExclusion({ sourceId: quote.id, productName: item.productName, customerName: quote.customerName, email: quote.email, notes: null, quantity: item.quantity, unitPrice: item.unitPrice });
      if (exclusion.excluded) { excluded.push({ label: String(item.productName || "").slice(0, 48), source: "erp_quote", reasons: exclusion.reasons }); continue; }
      const state: EvidenceRecord["state"] = ACCEPTED_EVIDENCE_STATUSES.includes(quote.status) ? "accepted" : LOST_EVIDENCE_STATUSES.includes(quote.status) ? "lost" : "open";
      const basket = classifyEvidenceBasket({ productName: item.productName, variantTitle: item.variant, selectedFinish: item.selectedFinish, costSnapshot: item.costSnapshot, quantity: item.quantity });
      const key = customerKey(quote.email, quote.customerName);
      allCustomers.add(key);
      if (state === "accepted") won += 1; else if (state === "lost") lost += 1; else open += 1;
      records.push({ source: "erp_quote", basket, key: basketKey(basket), quantity: item.quantity, unitPrice: item.unitPrice, state, customerKey: key, evidenceAt: quote.outcomeAt ?? quote.updatedAt ?? quote.createdAt, exactSnapshot: Boolean(item.costSnapshot) });
    }
  }

  for (const item of jobItems) {
    if (item.job?.shop && item.job.shop !== shop) continue;
    const quoteRef = String(item.job?.quoteId || "");
    if (quoteRef && !quoteRef.startsWith("shopify_order_") && !quoteRef.startsWith("manual_") && !quoteRef.startsWith("test_")) continue; // quote-linked items already counted via the quote
    const exclusion = evidenceExclusion({ sourceId: quoteRef || "no-source", productName: item.productTitle, customerName: item.job?.customerName, email: item.job?.email, notes: null, quantity: item.quantity, unitPrice: item.unitPrice });
    if (exclusion.excluded) { excluded.push({ label: String(item.productTitle || "").slice(0, 48), source: "production_job", reasons: exclusion.reasons }); continue; }
    const state: EvidenceRecord["state"] = quoteRef.startsWith("shopify_order_") ? "accepted" : "open";
    const basket = classifyEvidenceBasket({ productName: item.productTitle, variantTitle: item.variantTitle, selectedFinish: item.selectedFinish, costSnapshot: item.costSnapshot, quantity: item.quantity });
    const key = customerKey(item.job?.email, item.job?.customerName);
    allCustomers.add(key);
    if (state === "accepted") won += 1; else open += 1;
    records.push({ source: "production_job", basket, key: basketKey(basket), quantity: item.quantity, unitPrice: item.unitPrice, state, customerKey: key, evidenceAt: item.createdAt, exactSnapshot: Boolean(item.costSnapshot) });
  }

  return {
    records,
    excluded,
    totals: { reviewed: records.length + excluded.length, eligible: records.length, excluded: excluded.length, won, lost, open, distinctCustomers: allCustomers.size },
  };
}
