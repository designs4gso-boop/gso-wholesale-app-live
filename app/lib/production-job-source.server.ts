// Central production-job creation service (Patch 15D.1).
// ONE creation path for every source — replaces the three divergent creators
// (quotes page, production page, orders_paid webhook) found by the Phase 15D
// audit. Sources are TRUSTED SERVER-SIDE records only: the service re-fetches
// everything and never reads client-posted prices, costs, margins, or status.
//
// Idempotency (spec 15D.1-B): findFirst-then-create is NOT safe under
// concurrent requests (Render can run multiple instances), so the check+create
// runs inside ONE Prisma transaction that first takes a PostgreSQL
// TRANSACTION-LEVEL ADVISORY LOCK (pg_advisory_xact_lock) keyed by a
// deterministic pair of 32-bit hashes of `${shop}|${sourceType}|${sourceId}`.
// The lock serializes competing creations for the same source across all app
// instances and releases automatically at commit/rollback. Prisma cannot
// express the lock natively, so the smallest raw SQL call is used inside the
// transaction ($queryRawUnsafe with numeric parameters only — documented per
// spec). On non-PostgreSQL dev databases (SQLite) the call fails and is
// deliberately ignored: dev is single-instance, production is Postgres.
// Future hardening MAY add a unique index on (shop, quoteId); this service is
// concurrency-safe without it.

import { OVERRIDE_PHRASE } from "./calculator-emergency.server";
import { cleanCommercialName, safeNameToken } from "./commercial-name-resolver.server";
import { decideMachine } from "./print-intake-routing.server";
import {
  canonicalLineWarnings,
  canonicalMaterialSummary,
  canonicalSelectedAddOns,
  orderGidColumnAvailable,
  parseCanonicalOrderLine,
} from "./order-canonical.server";

export type ManualJobItemInput = {
  productTitle: string;
  quantity: number;
  family?: string; // canonical FAMILY_CHECKLISTS key (default "default")
  finish?: string; // e.g. "CMYK", "White", "Gloss — 3X", free finish text
  printer?: "auto" | "mimaki" | "roland";
  sku?: string;
  size?: string;
  notes?: string;
  unitPrice?: number;
  unitCost?: number;
};

export type ProductionJobSource =
  | { type: "erp_quote"; quoteId: string }
  | { type: "shopify_order"; order: any }
  | {
      type: "manual_admin";
      authorizedBy: string;
      // 15H.4B: STABLE client-generated id — the manual idempotency key
      // (shop + requestId). Same requestId retried/double-clicked -> same job.
      requestId: string;
      payload: {
        customerName: string;
        email?: string;
        phone?: string;
        notes?: string;
        reference?: string;
        dueDate?: string; // ISO date; invalid values are ignored, never guessed
        items: ManualJobItemInput[];
      };
    };

export type CreateJobResult = { job: any; created: boolean; reason: string };

// ---------- deterministic advisory-lock key ----------
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0; // signed 32-bit for pg int4
}

export function advisoryLockKeys(shop: string, sourceType: string, sourceId: string): [number, number] {
  const composite = `${shop}|${sourceType}|${sourceId}`;
  return [fnv1a32(composite, 0x811c9dc5), fnv1a32(composite, 0x01234567)];
}

async function acquireSourceLock(tx: any, shop: string, sourceType: string, sourceId: string) {
  const [keyA, keyB] = advisoryLockKeys(shop, sourceType, sourceId);
  try {
    // numeric parameters only — no string interpolation into SQL.
    // 15F.0J.5A: pg_advisory_xact_lock returns VOID, which Prisma cannot
    // deserialize ("Failed to deserialize column of type 'void'"). The ::text
    // cast runs AFTER the lock is acquired and yields a supported scalar, so
    // the lock is held AND the client call succeeds.
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${Math.trunc(keyA)}, ${Math.trunc(keyB)})::text AS gso_lock`);
  } catch (error: any) {
    const message = String((error as Error)?.message || error || "");
    // ONLY a non-Postgres dev database (SQLite) may skip locking — any other
    // failure is a real concurrency-safety error and must be loud (the old
    // blanket catch silently swallowed lock failures; 15F.0J.5A narrows it).
    if (/no such function|not supported on|sqlite/i.test(message)) return;
    const lockError = new Error(`advisory_lock_failed: ${message.slice(0, 160)}`);
    (lockError as any).gsoCode = "advisory_lock_failed";
    throw lockError;
  }
}

// ---------- shared naming (moved verbatim from the audited creators) ----------
function clean(value: any) {
  return String(value ?? "").trim();
}
function money(value: any) {
  return Math.round(Number(value || 0) * 100) / 100;
}
function dateStamp(value = new Date()) {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}
function slugPart(value: any, fallback = "JOB") {
  const cleanValue = String(value || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return cleanValue || fallback;
}
function normalizeFilePart(value: any, fallback = "ITEM") {
  return slugPart(value || fallback, fallback).slice(0, 40);
}
export function itemTicketFor(jobTicket: string, index: number) {
  return `${jobTicket}-${String(index + 1).padStart(2, "0")}`;
}
function parseJson(value: any) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
function snapshotValue(item: any, key: string) {
  return item?.[key] || parseJson(item.costSnapshot)?.[key] || parseJson(item.priceSnapshot)?.[key] || "";
}
function firstImageFromQuoteItem(item: any) {
  const costSnapshot = parseJson(item.costSnapshot);
  const priceSnapshot = parseJson(item.priceSnapshot);
  return (
    item.productImageUrl || costSnapshot?.productImageUrl || costSnapshot?.imageUrl ||
    priceSnapshot?.productImageUrl || priceSnapshot?.imageUrl || ""
  );
}

// 15H.1: THE authoritative job-ticket allocator (exported for the backfill
// action — no other generator may exist). Canonical format GSO-YYYYMMDD-NNNN.
// The old exhaustion fallback minted a NON-CANONICAL 6-digit epoch tail that
// no ticket parser matches — 15H.1 removes it: allocation now FAILS CLOSED
// (loud error) rather than ever returning an unsafe identity. The DB unique
// index (shop, jobTicket) is the final authority behind this probe loop —
// see runWithTicketRetry for the P2002 path.
export async function allocateJobTicket(tx: any, shop: string, now = new Date()) {
  const stamp = dateStamp(now);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const countToday = await tx.productionJob.count({ where: { shop, createdAt: { gte: start, lt: end } } });
  for (let sequence = countToday + 1; sequence < countToday + 5000; sequence += 1) {
    const ticket = `GSO-${stamp}-${String(sequence).padStart(4, "0")}`;
    const existing = await tx.productionJob.findFirst({ where: { shop, jobTicket: ticket } });
    if (!existing) return ticket;
  }
  const exhausted = new Error(`ticket_allocation_exhausted: no free GSO-${stamp} sequence within 5000 probes`);
  (exhausted as any).gsoCode = "ticket_allocation_exhausted";
  throw exhausted;
}

async function buildNextJobTicket(tx: any, shop: string, now = new Date()) {
  return allocateJobTicket(tx, shop, now);
}

// 15H.1: Postgres aborts the WHOLE transaction on a unique violation, so a
// ticket collision (two sources racing different advisory locks) cannot be
// retried statement-level — the entire transaction re-runs. Each rerun
// re-acquires the lock, re-checks source idempotency, and allocates a fresh
// candidate (the winner's committed row is now visible to the probe).
// Bounded; only ticket-constraint P2002s retry — everything else rethrows.
export function isTicketUniqueViolation(error: any): boolean {
  if (String(error?.code) !== "P2002") return false;
  const target = JSON.stringify(error?.meta?.target ?? "");
  return /jobTicket|itemTicket/i.test(target);
}

export async function runWithTicketRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTicketUniqueViolation(error) || attempt === attempts) throw error;
    }
  }
  throw lastError;
}

// quote-item file name. 15D.2: names pass through the shared resolver so
// placeholder fragments can never reach folders/RIP/print filenames (the
// Shopify-order file namer below is untouched for webhook parity).
export function suggestedFileNameForQuoteItem(jobTicket: string, item: any, index: number) {
  const ticket = itemTicketFor(jobTicket, index);
  const product = safeNameToken(item.productName || item.productTitle, "PRODUCT");
  const variant = safeNameToken(item.variant || item.variantTitle, "VARIANT");
  const qty = Number(item.quantity || 1);
  return `${ticket}_${product}_${variant}_QTY${qty}`;
}

// ---------- family checklist templates (15D.1-G) ----------
export const FAMILY_CHECKLISTS: Record<string, Array<{ section: string; label: string; sortOrder: number }>> = {
  "sticker-bags": [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Proof approved", sortOrder: 20 },
    { section: "production", label: "Labels printed", sortOrder: 30 },
    { section: "production", label: "Cut complete", sortOrder: 40 },
    { section: "production", label: "Weeded (if required)", sortOrder: 50 },
    { section: "production", label: "Labels applied to bags", sortOrder: 60 },
    { section: "qc", label: "QC passed", sortOrder: 70 },
    { section: "packing", label: "Packed and labeled", sortOrder: 80 },
  ],
  "standard-jars": [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Proof approved", sortOrder: 20 },
    { section: "production", label: "Jar inventory pulled", sortOrder: 30 },
    { section: "production", label: "Labels printed", sortOrder: 40 },
    { section: "production", label: "Labels applied", sortOrder: 50 },
    { section: "qc", label: "QC passed", sortOrder: 60 },
    { section: "packing", label: "Packed and labeled", sortOrder: 70 },
  ],
  "premium-jars": [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Proof approved", sortOrder: 20 },
    { section: "production", label: "Jar + top inventory verified (Miron top type from snapshot)", sortOrder: 30 },
    { section: "production", label: "Labels printed", sortOrder: 40 },
    { section: "production", label: "Labels applied", sortOrder: 50 },
    { section: "qc", label: "QC passed", sortOrder: 60 },
    { section: "packing", label: "Packed and labeled", sortOrder: 70 },
  ],
  "stickers-labels": [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Proof approved", sortOrder: 20 },
    { section: "production", label: "Printed", sortOrder: 30 },
    { section: "production", label: "Cut complete", sortOrder: 40 },
    { section: "production", label: "Finish complete", sortOrder: 50 },
    { section: "qc", label: "QC passed", sortOrder: 60 },
    { section: "packing", label: "Packed and labeled", sortOrder: 70 },
  ],
  banners: [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Proof approved", sortOrder: 20 },
    { section: "production", label: "Printed", sortOrder: 30 },
    { section: "production", label: "Trim / hem / grommet complete", sortOrder: 40 },
    { section: "qc", label: "QC passed", sortOrder: 50 },
    { section: "packing", label: "Packed and labeled", sortOrder: 60 },
  ],
  // DTP = OUTSOURCED Spektra purchase workflow ONLY (15D.1-D) — no in-house
  // print/machine/application/weeding steps.
  "dtp-bags": [
    { section: "prepress", label: "Artwork received", sortOrder: 10 },
    { section: "prepress", label: "Artwork reviewed", sortOrder: 20 },
    { section: "purchase", label: "Purchase order prepared", sortOrder: 30 },
    { section: "purchase", label: "Purchase order sent to Spektra", sortOrder: 40 },
    { section: "purchase", label: "Vendor proof received", sortOrder: 50 },
    { section: "purchase", label: "Customer proof approved", sortOrder: 60 },
    { section: "purchase", label: "Order confirmed", sortOrder: 70 },
    { section: "purchase", label: "Expected delivery recorded", sortOrder: 80 },
    { section: "receiving", label: "Goods received", sortOrder: 90 },
    { section: "qc", label: "Quality control", sortOrder: 100 },
    { section: "packing", label: "Customer delivery / pickup", sortOrder: 110 },
    { section: "packing", label: "Complete", sortOrder: 120 },
  ],
  // generic default = the shared checklist all three creators used pre-15D.1
  default: [
    { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
    { section: "prepress", label: "Dieline / size confirmed", sortOrder: 20 },
    { section: "prepress", label: "Proof sent if required", sortOrder: 30 },
    { section: "prepress", label: "Proof approved", sortOrder: 40 },
    { section: "production", label: "Material pulled", sortOrder: 50 },
    { section: "production", label: "Machine assigned", sortOrder: 60 },
    { section: "production", label: "Print complete", sortOrder: 70 },
    { section: "production", label: "Cut / laminate / finish complete", sortOrder: 80 },
    { section: "qc", label: "QC passed", sortOrder: 90 },
    { section: "packing", label: "Packed and labeled", sortOrder: 100 },
  ],
};

export function familyFromQuoteItems(items: any[]): string {
  for (const item of items) {
    const snapshot = parseJson(item.costSnapshot);
    const family = snapshot?.productBreakdown?.canonicalFamily || snapshot?.productBreakdown?.family || "";
    if (family) {
      if (family === "dtp-bags" || family === "dtp-pouches" || snapshot?.productBreakdown?.dtpPricing) return "dtp-bags";
      if (FAMILY_CHECKLISTS[family]) return family;
      if (family === "bags-4x5") return "sticker-bags";
      if (family === "chiron-jars" || family === "miron-jars") return "premium-jars";
    }
    if (snapshot?.productBreakdown?.dtpPricing || snapshot?.productBreakdown?.dtp) return "dtp-bags";
  }
  return "default";
}

export function checklistForFamily(family: string) {
  return FAMILY_CHECKLISTS[family] || FAMILY_CHECKLISTS.default;
}

// ---------- 15H.4B: manual job validation + machine resolution ----------
// Owner-facing manual/walk-in/internal jobs. Validation is FAIL-CLOSED and
// machine resolution delegates to the ONE canonical decider (decideMachine)
// — no duplicated routing logic: the requested printer is expressed as a
// machineSummary and the same contradiction rules apply (white/gloss on the
// CMYK-only Mimaki rejects; Auto follows white/gloss->Roland else Mimaki).
export const MANUAL_JOB_FAMILIES: Array<{ value: string; label: string }> = [
  { value: "sticker-bags", label: "Stock Bags" },
  { value: "standard-jars", label: "Jars" },
  { value: "premium-jars", label: "Premium Jars (Miron/Chiron)" },
  { value: "stickers-labels", label: "Stickers / Labels" },
  { value: "dtp-bags", label: "DTP Pouches (outsourced)" },
  { value: "banners", label: "Banners" },
  { value: "default", label: "Custom / Other / Internal / Test" },
];

export const MANUAL_JOB_FINISHES = [
  "CMYK",
  "White",
  "Gloss",
  "White + Gloss",
  "Specialty (describe in notes)",
] as const;

export type ManualJobValidation =
  | { ok: true; items: Array<ManualJobItemInput & { resolvedMachine: "mimaki" | "roland"; machineRule: string }> }
  | { ok: false; reason: string };

export function validateManualJobInput(input: {
  requestId: string;
  customerName: string;
  items: ManualJobItemInput[];
}): ManualJobValidation {
  if (!clean(input.requestId) || clean(input.requestId).length < 8) return { ok: false, reason: "Manual jobs require a stable requestId (retry-safe idempotency key)." };
  if (!clean(input.customerName)) return { ok: false, reason: "Job / customer name is required." };
  if (!input.items?.length) return { ok: false, reason: "At least one item is required." };
  const resolved: Array<ManualJobItemInput & { resolvedMachine: "mimaki" | "roland"; machineRule: string }> = [];
  for (const item of input.items) {
    if (!clean(item.productTitle)) return { ok: false, reason: "Item / product name is required." };
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || Math.floor(quantity) <= 0) return { ok: false, reason: "Quantity must be a whole number greater than zero." };
    const family = clean(item.family || "default");
    if (!MANUAL_JOB_FAMILIES.some((option) => option.value === family)) return { ok: false, reason: `Unknown production family "${family}".` };
    const finish = clean(item.finish || "CMYK");
    const printer = clean(item.printer || "auto").toLowerCase();
    if (!["auto", "mimaki", "roland"].includes(printer)) return { ok: false, reason: `Unknown printer selection "${printer}".` };
    // Canonical decision: requested printer -> machineSummary; finish text
    // carries the white/gloss requirement tokens the decider reads.
    const decision = decideMachine(
      {
        id: "manual",
        itemTicket: null,
        ripJobName: null,
        suggestedFileName: null,
        productTitle: item.productTitle,
        selectedFinish: finish,
        materialSummary: null,
        machineSummary: printer === "mimaki" ? "Mimaki UCJV300-130" : printer === "roland" ? "Roland LG-640" : null,
      },
      "",
    );
    if (!decision.machine) {
      return {
        ok: false,
        reason: `Machine selection conflicts with the finish: ${decision.reasons.join("; ")} (the Mimaki is CMYK-only — white/gloss/specialty work runs on the Roland).`,
      };
    }
    resolved.push({ ...item, quantity: Math.floor(quantity), family, finish, printer: printer as any, resolvedMachine: decision.machine, machineRule: String(decision.machineRule || "default_cmyk") });
  }
  return { ok: true, items: resolved };
}

// ---------- ERP quote conversion validation (15D.1-C) ----------
// Pure + exported for tests. Re-validates the STORED snapshot — a quote that
// saved as draft-with-warnings (missing costs) or a DTP quote that is BLOCKED
// or lost its override can never convert, even after payment.
export function validateQuoteSnapshotForConversion(items: any[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const item of items) {
    const snapshot = parseJson(item.costSnapshot);
    if (!snapshot) continue; // legacy/manual quote-builder items carry other shapes — no engine snapshot to re-validate
    const breakdown = snapshot.productBreakdown;
    if (breakdown?.missing?.length) {
      reasons.push(`Missing costs in the saved snapshot: ${breakdown.missing.slice(0, 3).join("; ")}${breakdown.missing.length > 3 ? "…" : ""}`);
    }
    const dtpPricing = breakdown?.dtpPricing;
    if (dtpPricing) {
      if (!breakdown?.dtp || !breakdown?.selections?.blank) {
        reasons.push("DTP snapshot is missing vendor/product data.");
      }
      if (String(dtpPricing.status || "").startsWith("BLOCKED")) {
        reasons.push(`DTP quote is BLOCKED: ${(dtpPricing.statusReasons || []).join("; ") || "blocked status"}`);
      }
      if (dtpPricing.overrideRequired) {
        const reason = String(dtpPricing.overrideReason || "").trim();
        if (reason.length < 5) {
          reasons.push(`DTP owner override was required but no written reason is recorded — re-save the quote with the "${OVERRIDE_PHRASE}" phrase and a reason.`);
        }
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function quoteConversionEligibility(quote: any | null, shop: string): { ok: boolean; reason: string } {
  if (!quote) return { ok: false, reason: "Quote not found." };
  if (quote.shop !== shop) return { ok: false, reason: "Quote not found." }; // never leak cross-shop existence
  if (!["paid", "production"].includes(quote.status)) {
    return {
      ok: false,
      reason: quote.status === "deposit_paid"
        ? "Balance must be paid before production can start."
        : "Production can start only after the quote is fully paid.",
    };
  }
  if (!quote.items?.length) return { ok: false, reason: "Quote has no quote items to send to production." };
  const snapshotCheck = validateQuoteSnapshotForConversion(quote.items);
  if (!snapshotCheck.ok) return { ok: false, reason: `Quote cannot convert: ${snapshotCheck.reasons.join(" | ")}` };
  return { ok: true, reason: "" };
}

// ---------- Shopify configurator-order mapping (15D.1-F) ----------
// Moved from webhooks.orders_paid.tsx and kept FIELD-FOR-FIELD equivalent —
// the webhook parity test pins every important generated value.
function gid(type: string, value: any) {
  const raw = clean(value);
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/${type}/${raw}`;
}
export function orderIdentity(order: any) {
  return clean(order.admin_graphql_api_id) || gid("Order", order.id) || clean(order.id);
}
function orderName(order: any) {
  return clean(order.name) || clean(order.order_number) || clean(order.id) || "Shopify Order";
}
function getLineProperty(line: any, name: string) {
  const wanted = name.toLowerCase();
  const properties = Array.isArray(line.properties) ? line.properties : [];
  for (const prop of properties) {
    const key = clean(prop.name || prop.key).toLowerCase();
    if (key === wanted) return clean(prop.value);
  }
  const customAttributes = Array.isArray(line.customAttributes) ? line.customAttributes : [];
  for (const attr of customAttributes) {
    const key = clean(attr.name || attr.key).toLowerCase();
    if (key === wanted) return clean(attr.value);
  }
  return "";
}
function isJarFamily(value: any) {
  const family = clean(value).toLowerCase();
  return family === "jars" || family === "jar";
}
export function isConfiguratorLine(line: any) {
  // 15H.4A: a server-created canonical snapshot is the strongest signal —
  // it alone qualifies the line even if visible properties were stripped.
  if (parseCanonicalOrderLine(getLineProperty(line, "_GSO Canonical"))) return true;
  const material = getLineProperty(line, "Material");
  const finish = getLineProperty(line, "Finish");
  const bagColor = getLineProperty(line, "Bag Color");
  const productFamily = getLineProperty(line, "Product Family");
  const labelSet = getLineProperty(line, "Label Set");
  return Boolean(
    (material && finish && bagColor) ||
      (isJarFamily(productFamily) && material && finish && labelSet),
  );
}
function customerNameFromOrder(order: any) {
  const first = clean(order.customer?.first_name || order.billing_address?.first_name);
  const last = clean(order.customer?.last_name || order.billing_address?.last_name);
  const joined = `${first} ${last}`.trim();
  return joined || clean(order.billing_address?.name) || clean(order.email) || "Shopify customer";
}
function companyNameFromOrder(order: any) {
  return clean(order.billing_address?.company) || clean(order.customer?.default_address?.company) || "";
}
function lineProductTitle(line: any) {
  const title = clean(line.title || line.name);
  if (!title) return "Configured Stock Bag";
  return title.replace(/\s+-\s+[^-]+\/[^-]+\/[^-]+$/i, "");
}
function suggestedFileNameForOrderItem(jobTicket: string, item: any, index: number) {
  const ticket = itemTicketFor(jobTicket, index);
  const product = normalizeFilePart(item.productTitle || item.title || "PRODUCT");
  const finish = normalizeFilePart(item.productionFinish || item.finish || "FINISH");
  const isJar = isJarFamily(item.productFamily) || String(item.productType || "").startsWith("jar_");
  const color = normalizeFilePart(isJar ? item.labelSet || "LABEL" : item.bagColor || "COLOR");
  const qty = Number(item.quantity || 1);
  if (isJar && item.jarColor) {
    const jarColor = normalizeFilePart(item.jarColor);
    return `${ticket}_${product}_${finish}_${jarColor}_${color}_QTY${qty}`;
  }
  return `${ticket}_${product}_${finish}_${color}_QTY${qty}`;
}

// Pure builder: everything the webhook used to assemble, given a jobTicket.
export function buildShopifyOrderJobPayload(order: any, jobTicket: string) {
  // 15H.1: no unstable fallback — a payload without a stable Shopify order
  // identity can never become a production job (the service fails closed
  // before calling this; the null here is belt-and-braces so the stored
  // quoteId always equals the idempotency source key).
  const orderId = orderIdentity(order);
  if (!orderId) return null;
  const quoteId = `shopify_order_${orderId}`;
  const quoteNumber = orderName(order);
  const allLines = Array.isArray(order.line_items) ? order.line_items : [];
  const configuredLines = allLines.filter(isConfiguratorLine);
  // 15H.4A-I: unsupported/unrecognized lines are NEVER given fabricated
  // production specs — they are omitted from automated production and
  // logged on the job so a human sees exactly what was skipped.
  const skippedLines = allLines
    .filter((line: any) => !isConfiguratorLine(line))
    .map((line: any) => `${clean(line.title || line.name) || "untitled line"} x${Number(line.quantity || 1)}`);
  if (!configuredLines.length) return null;

  const mappedItems = configuredLines.map((line: any, index: number) => {
    // 15H.4A-E: the server-created checkout snapshot is AUTHORITATIVE for
    // canonical stock-bag lines; visible properties are the legacy fallback
    // (byte-identical mapping to the pre-15H.4A webhook when absent).
    const canonical = parseCanonicalOrderLine(getLineProperty(line, "_GSO Canonical"));
    const productFamily = getLineProperty(line, "Product Family") || (canonical ? "Stock Bags" : "");
    const productType = getLineProperty(line, "Product Type") || (canonical ? canonical.profile : "");
    const material = canonical ? canonical.material : getLineProperty(line, "Material");
    const finish = canonical ? canonical.finishLabel : getLineProperty(line, "Finish");
    const productionFinish = canonical ? canonical.finishLabel : (getLineProperty(line, "Production Finish") || finish);
    const bagColor = canonical ? canonical.bagColor : getLineProperty(line, "Bag Color");
    const labelSet = getLineProperty(line, "Label Set");
    const jarColor = getLineProperty(line, "Jar Color");
    const sides = canonical ? (canonical.faces === 1 ? "Single Sided" : "Double Sided") : (getLineProperty(line, "Sides") || "Double Sided");
    const isJar = isJarFamily(productFamily) || productType.startsWith("jar_");
    const quantity = Number(line.quantity || 1);
    const linePaidUnitPrice = money(line.price || line.originalUnitPrice || line.original_unit_price || 0);
    // 15H.4A-K: the canonical engine-stamped unit price is the order-time
    // commercial truth; the paid line price rides alongside and mismatches
    // surface as human-visible warnings (never a recalculation).
    const canonicalWarnings = canonical ? canonicalLineWarnings(canonical, { quantity, unitPrice: linePaidUnitPrice }) : [];
    const unitPrice = canonical ? money(canonical.unitPrice) : linePaidUnitPrice;
    const productTitle = lineProductTitle(line);
    const variantTitle = isJar
      ? [jarColor, material, finish, labelSet].filter(Boolean).join(" / ")
      : `${material} / ${finish} / ${bagColor}`;
    const selectedAddOns = canonical
      ? canonicalSelectedAddOns(canonical)
      : isJar
        ? { productFamily, productType, material, finish, productionFinish, ...(jarColor ? { jarColor } : {}), labelSet }
        : { productFamily, productType, material, finish, productionFinish, bagColor, sides };
    const materialSummary = canonical
      ? canonicalMaterialSummary(canonical)
      : isJar
        ? [
            `Product Family: ${productFamily}`, `Product Type: ${productType}`, `Material: ${material}`,
            `Finish: ${finish}`, `Production Finish: ${productionFinish}`,
            ...(jarColor ? [`Jar Color: ${jarColor}`] : []), `Label Set: ${labelSet}`,
          ].join(" | ")
        : `Material: ${material} | Finish: ${finish} | Production Finish: ${productionFinish} | Bag Color: ${bagColor} | Sides: ${sides}`;
    const productionNotes = isJar
      ? [
          `Shopify order: ${quoteNumber}`, `Product Family: ${productFamily}`, `Product Type: ${productType}`,
          `Material: ${material}`, `Finish: ${finish}`, `Production Finish: ${productionFinish}`,
          ...(jarColor ? [`Jar Color: ${jarColor}`] : []), `Label Set: ${labelSet}`,
        ].join("\n")
      : [
          `Shopify order: ${quoteNumber}`, `Material: ${material}`, `Finish: ${finish}`,
          `Production Finish: ${productionFinish}`, `Bag Color: ${bagColor}`, `Sides: ${sides}`,
          ...(canonical
            ? [
                `Holographic: ${canonical.holo ? "yes" : "no"}`,
                `Required White: ${canonical.whiteRequired ? "yes" : "no"}`,
                `Gloss Layers: ${canonical.glossX}X`,
                `Canonical engine: ${canonical.engine} (${canonical.v})`,
              ]
            : []),
          ...canonicalWarnings.map((warning) => `WARNING: ${warning}`),
        ].join("\n");
    const priceSnapshot = {
      source: "shopify_order_paid_webhook",
      orderId, orderName: quoteNumber, lineItemId: line.id || null,
      productFamily, productType, material, finish, productionFinish, bagColor,
      ...(jarColor ? { jarColor } : {}), labelSet, sides, quantity, unitPrice,
      lineTotal: money(unitPrice * quantity),
      // 15H.4A: the verbatim server-created checkout snapshot is the
      // order-time commercial truth for canonical lines; the PAID line price
      // rides alongside for reconciliation. Never recalculated.
      ...(canonical ? { canonical, linePaidUnitPrice, canonicalWarnings } : {}),
    };
    const item = {
      productTitle,
      variantTitle,
      sku: clean(line.sku) || null,
      quantity,
      unitPrice,
      unitCost: 0,
      shopifyProductGid: gid("Product", line.product_id),
      shopifyVariantGid: gid("ProductVariant", line.variant_id),
      productImageUrl:
        getLineProperty(line, "_GSO Product Image") || getLineProperty(line, "Product Image") ||
        clean(line.image?.src || line.image?.url || line.variant?.image?.src || line.variant?.image?.url || "") || null,
      selectedFinish: productionFinish,
      selectedAddOns: JSON.stringify(selectedAddOns),
      materialSummary,
      priceSnapshot: JSON.stringify(priceSnapshot),
      costSnapshot: JSON.stringify({
        source: "pending_cost_book_mapping",
        note: "Customer price captured from Shopify order. Internal cost will be mapped from Material Center / Cost Book later.",
      }),
      productionNotes,
      sortOrder: index + 1,
    };
    return {
      ...item,
      itemTicket: itemTicketFor(jobTicket, index),
      ripJobName: itemTicketFor(jobTicket, index),
      suggestedFileName: suggestedFileNameForOrderItem(jobTicket, {
        productTitle: item.productTitle, productFamily, productType,
        productionFinish: line.productionFinish || productionFinish, finish: line.finish || finish,
        bagColor: line.bagColor || bagColor, jarColor: line.jarColor || jarColor,
        labelSet: line.labelSet || labelSet, quantity: item.quantity,
      }, index),
    };
  });

  const firstLine = configuredLines[0];
  const firstImage =
    getLineProperty(firstLine, "_GSO Product Image") || getLineProperty(firstLine, "Product Image") ||
    clean(firstLine.image?.src || firstLine.image?.url || firstLine.variant?.image?.src || firstLine.variant?.image?.url || "") ||
    mappedItems.find((item: any) => item.productImageUrl)?.productImageUrl || null;

  return {
    quoteId,
    quoteNumber,
    // 15H.4A: first-class order linkage (written to ProductionJob.orderGid
    // once the staged column is activated; capability-guarded at create).
    orderGid: orderId,
    customerName: customerNameFromOrder(order),
    company: companyNameFromOrder(order) || null,
    email: clean(order.email || order.customer?.email) || null,
    phone: clean(order.phone || order.billing_address?.phone || order.customer?.phone) || null,
    customerNotes: clean(order.note) || null,
    internalNotes: [
      `Created automatically from paid Shopify configurator order ${quoteNumber}.`,
      `Source: paid_shopify_order | Order GID: ${orderId}.`,
      ...(skippedLines.length
        ? [`NOTE: ${skippedLines.length} non-production line(s) omitted (no fabricated specs): ${skippedLines.slice(0, 5).join("; ")}${skippedLines.length > 5 ? "…" : ""}`]
        : []),
    ].join("\n"),
    productImageUrl: firstImage,
    items: mappedItems,
    skippedLines,
    eventType: "created_from_shopify_order",
    eventMessage: (ticket: string) =>
      `Production job ${ticket} created from paid Shopify configurator order ${quoteNumber} (order ${orderId}).${skippedLines.length ? ` ${skippedLines.length} non-production line(s) omitted.` : ""}`,
  };
}

// ---------- the central service ----------
export async function createProductionJobFromSource(
  dbClient: any,
  input: { shop: string; source: ProductionJobSource; actor?: string },
): Promise<CreateJobResult> {
  const { shop, source } = input;
  const actor = clean(input.actor) || "system";

  // resolve the idempotency source key BEFORE the transaction
  let sourceKey: string;
  if (source.type === "erp_quote") {
    sourceKey = clean(source.quoteId);
    if (!sourceKey) throw new Error("Quote ID is required.");
  } else if (source.type === "shopify_order") {
    // 15H.1: FAIL CLOSED on an id-less payload. The old `|| Date.now()`
    // fallback minted a never-matching source key, so a webhook retry for
    // such a payload would create duplicate jobs. No stable Shopify order
    // identity (admin_graphql_api_id or id) = no production job.
    const stableOrderId = orderIdentity(source.order);
    if (!stableOrderId) {
      throw new Error("Paid-order payload has no stable order identity (admin_graphql_api_id/id) — refusing to create a production job from an unidempotent source.");
    }
    sourceKey = `shopify_order_${stableOrderId}`;
  } else {
    if (!clean(source.authorizedBy)) throw new Error("Manual production jobs require an authorizing user.");
    // 15H.4B: STABLE idempotency — shop + client requestId (no Date.now).
    // Same requestId retried, double-clicked, or replayed after a timeout
    // resolves to the SAME ProductionJob.
    const requestId = clean((source as any).requestId);
    if (!requestId || requestId.length < 8) throw new Error("Manual production jobs require a stable requestId.");
    sourceKey = `manual_${requestId}`;
  }

  // 15H.1: ticket-constraint P2002 reruns the whole transaction (see helper).
  return await runWithTicketRetry(() => dbClient.$transaction(async (tx: any) => {
    // concurrency-safe idempotency: lock, THEN check, THEN create — all in one tx
    await acquireSourceLock(tx, shop, source.type, sourceKey);

    // 15H.4B: EVERY source is idempotent now — the manual branch's stable
    // requestId key made the old exemption obsolete.
    const existing = await tx.productionJob.findFirst({ where: { shop, quoteId: sourceKey } });
    if (existing) return { job: existing, created: false, reason: "Production job already exists." };

    if (source.type === "erp_quote") {
      const quote = await tx.quote.findFirst({ where: { shop, id: sourceKey }, include: { items: true } });
      const eligibility = quoteConversionEligibility(quote, shop);
      if (!eligibility.ok) throw new Error(eligibility.reason);
      const family = familyFromQuoteItems(quote.items);
      const jobTicket = await buildNextJobTicket(tx, shop);
      const job = await tx.productionJob.create({
        data: {
          shop,
          quoteId: quote.id,
          quoteNumber: quote.id,
          jobTicket,
          assetInboxKey: jobTicket,
          customerName: quote.customerName || null,
          company: quote.company || null,
          email: quote.email || null,
          phone: quote.phone || null,
          status: "new",
          priority: "normal",
          customerNotes: quote.notes || null,
          internalNotes: `Created from quote via central service (${family} checklist).`,
          productImageUrl: firstImageFromQuoteItem(quote.items[0]) || null,
          proofUrl: null,
          items: {
            create: quote.items.map((item: any, index: number) => ({
              shop,
              quoteItemId: item.id,
              itemTicket: itemTicketFor(jobTicket, index),
              ripJobName: itemTicketFor(jobTicket, index),
              suggestedFileName: suggestedFileNameForQuoteItem(jobTicket, item, index),
              productTitle: cleanCommercialName(item.productName) || "Custom item", // 15D.2: clean resolved name
              variantTitle: item.variant || null,
              sku: item.sku || null,
              quantity: Number(item.quantity) || 1,
              unitPrice: Number(item.unitPrice) || 0,
              unitCost: Number(item.unitCost) || 0,
              productImageUrl: firstImageFromQuoteItem(item) || null,
              shopifyProductGid: snapshotValue(item, "shopifyProductGid") || snapshotValue(item, "shopifyProductId") || null,
              shopifyVariantGid: snapshotValue(item, "shopifyVariantGid") || snapshotValue(item, "shopifyVariantId") || null,
              recipeId: item.recipeId || snapshotValue(item, "recipeId") || null,
              recipeName: item.recipeName || snapshotValue(item, "recipeName") || null,
              selectedFinish: item.selectedFinish || snapshotValue(item, "selectedFinish") || null,
              selectedAddOns: item.selectedAddOnIds || snapshotValue(item, "selectedAddOns") || null,
              costSnapshot: item.costSnapshot || null, // complete commercial snapshot preserved (incl. dtp/dtpPricing)
              priceSnapshot: item.priceSnapshot || null,
              productionNotes: item.notes || null,
              sortOrder: index + 1,
            })),
          },
          checklistItems: { create: checklistForFamily(family).map((check) => ({ shop, ...check })) },
          events: {
            create: [{
              shop,
              eventType: "created_from_quote",
              message: `Production job ${jobTicket} created from quote ${quote.id} (source erp_quote, family ${family}).`,
              createdBy: actor,
            }],
          },
        },
        include: { items: true },
      });
      // proof sheet + back-link (inside the same transaction)
      const proofUrl = `/app/erp/production/${job.id}/proof`;
      await tx.productionJob.update({ where: { id: job.id }, data: { proofUrl } });
      await tx.productionJobFile.create({
        data: {
          shop, jobId: job.id,
          fileName: "Standard GSO Proof Sheet", fileType: "proof", fileUrl: proofUrl,
          assetRole: "proof", assetSource: "generated", sourceRef: jobTicket,
          matchedBy: "auto_created_from_job", jobTicket,
          originalFileName: "Standard GSO Proof Sheet",
          notes: "Auto-created internal proof sheet. Open to edit images/artwork and print/export.",
        },
      });
      await tx.productionJobEvent.create({ data: { shop, jobId: job.id, eventType: "proof_created", message: "Standard GSO proof sheet auto-created.", createdBy: actor } });
      // authoritative lifecycle: paid -> production (forward-only; webhook
      // payment logic already preserves production as a later status)
      await tx.quote.updateMany({ where: { shop, id: quote.id, status: { in: ["paid", "production"] } }, data: { status: "production" } });
      await tx.quote.updateMany({
        where: { shop, id: quote.id },
        data: { notes: `${quote.notes ? `${quote.notes}\n` : ""}[GSO] Production job ${jobTicket} created (${job.id}).` },
      });
      return { job: { ...job, proofUrl }, created: true, reason: "Production job created." };
    }

    if (source.type === "shopify_order") {
      const jobTicket = await buildNextJobTicket(tx, shop);
      const payload = buildShopifyOrderJobPayload(source.order, jobTicket);
      if (!payload) return { job: null, created: false, reason: "No configurator line items found." };
      // 15H.4A: orderGid is a STAGED column — write it only when the probe
      // says the database actually has it (safe to deploy pre-activation).
      const canWriteOrderGid = await orderGidColumnAvailable(dbClient);
      const job = await tx.productionJob.create({
        data: {
          shop,
          quoteId: payload.quoteId,
          quoteNumber: payload.quoteNumber,
          ...(canWriteOrderGid && payload.orderGid ? { orderGid: payload.orderGid } : {}),
          jobTicket,
          assetInboxKey: jobTicket,
          customerName: payload.customerName,
          company: payload.company,
          email: payload.email,
          phone: payload.phone,
          status: "new",
          priority: "normal",
          customerNotes: payload.customerNotes,
          internalNotes: payload.internalNotes,
          productImageUrl: payload.productImageUrl,
          items: { create: payload.items.map((item: any) => ({ shop, ...item })) },
          checklistItems: { create: FAMILY_CHECKLISTS.default.map((check) => ({ shop, ...check })) },
          events: { create: [{ shop, eventType: payload.eventType, message: payload.eventMessage(jobTicket), createdBy: actor }] },
        },
        include: { items: true },
      });
      return { job, created: true, reason: "Production job created from configurator order." };
    }

    // manual_admin (15H.4B): walk-in / internal / owner-entered production
    // work — a real permanent ticket with NO Shopify order, quote, or
    // payment required. Nothing commercial is fabricated (prices default 0
    // = not entered). Validation + canonical machine resolution ran here.
    const verdict = validateManualJobInput({
      requestId: clean((source as any).requestId),
      customerName: source.payload.customerName,
      items: source.payload.items,
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const manualItems = verdict.items;
    const family = manualItems[0]?.family || "default";
    const dueDate = (() => {
      const raw = clean(source.payload.dueDate);
      if (!raw) return null;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })();
    const jobTicket = await buildNextJobTicket(tx, shop);
    const job = await tx.productionJob.create({
      data: {
        shop,
        quoteId: sourceKey,
        quoteNumber: clean(source.payload.reference) || `MANUAL-${clean((source as any).requestId).slice(0, 8).toUpperCase()}`,
        jobTicket,
        assetInboxKey: jobTicket,
        customerName: source.payload.customerName || null,
        email: clean(source.payload.email) || null,
        phone: clean(source.payload.phone) || null,
        status: "new",
        priority: "normal",
        dueDate,
        customerNotes: source.payload.notes || null,
        internalNotes: [
          `Manual production job authorized by ${source.authorizedBy}.`,
          `Source: manual_admin | Request: ${clean((source as any).requestId)}.`,
          "No Shopify order / quote / payment — commercial linkage optional.",
        ].join("\n"),
        items: {
          create: manualItems.map((item, index) => ({
            shop,
            itemTicket: itemTicketFor(jobTicket, index),
            ripJobName: itemTicketFor(jobTicket, index),
            suggestedFileName: suggestedFileNameForQuoteItem(jobTicket, { productTitle: item.productTitle, quantity: item.quantity }, index),
            productTitle: item.productTitle,
            sku: clean(item.sku) || null,
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice) || 0,
            unitCost: Number(item.unitCost) || 0,
            selectedFinish: item.finish || "CMYK",
            machineSummary: item.resolvedMachine === "roland" ? "Roland LG-640" : "Mimaki UCJV300-130",
            materialSummary: [
              `Family: ${MANUAL_JOB_FAMILIES.find((option) => option.value === item.family)?.label || item.family}`,
              `Finish: ${item.finish || "CMYK"}`,
              `Machine: ${item.resolvedMachine} (${item.machineRule})`,
              ...(item.size ? [`Size: ${item.size}`] : []),
            ].join(" | "),
            selectedAddOns: JSON.stringify({
              source: "manual_admin",
              family: item.family,
              finish: item.finish,
              requestedPrinter: item.printer || "auto",
              resolvedMachine: item.resolvedMachine,
              machineRule: item.machineRule,
              ...(item.size ? { size: item.size } : {}),
            }),
            productionNotes: [
              ...(item.notes ? [item.notes] : []),
              `Machine: ${item.resolvedMachine} (requested ${item.printer || "auto"}, rule ${item.machineRule}).`,
            ].join("\n"),
            sortOrder: index + 1,
          })),
        },
        checklistItems: { create: checklistForFamily(family).map((check) => ({ shop, ...check })) },
        events: {
          create: [{
            shop,
            eventType: "created_manual_admin",
            message: `Manual production job ${jobTicket} created by ${source.authorizedBy} (request ${clean((source as any).requestId)}). ${manualItems.map((item) => `${item.productTitle} x${item.quantity} -> ${item.resolvedMachine} (requested ${item.printer || "auto"})`).join("; ")}.`,
            createdBy: actor,
          }],
        },
      },
      include: { items: true },
    });
    return { job, created: true, reason: "Manual production job created." };
  }));
}

// ---------- 15F.0J.5: automatic PRINT-INTAKE job creation ----------
// For a genuinely new dropped file with a DETERMINISTIC printer/mode and no
// exact production match: create ONE PrintIntake record + ONE controlled
// ProductionJob through the SAME advisory-locked ticket generator (never a
// second sequence). Idempotent on (shop, full SHA-256): the advisory lock is
// keyed on the hash, the unique constraint backstops races, and a repeat
// call returns the existing identity. NOTHING commercial is fabricated —
// no revenue, price, payment, approval, or customer beyond parsed hints;
// the job is explicitly UNLINKED until quote/order/customer are attached.
export type PrintIntakeCreateInput = {
  shop: string;
  fileName: string;
  subfolder?: string | null;
  fileHash: string; // full SHA-256 (lowercase hex)
  fileSize?: number;
  machine: "mimaki" | "roland";
  machineRule: string;
  mode: string; // CMYK | GLOSS-NX | WHITE-NX | combined
  hints?: unknown;
  reviewWarnings?: string[];
};

export async function createOrReusePrintIntakeJob(dbClient: any, input: PrintIntakeCreateInput): Promise<{
  created: boolean;
  printIntakeId: string;
  productionJobId: string;
  jobTicket: string;
  ripName: string;
}> {
  const shop = input.shop;
  const fileHash = String(input.fileHash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fileHash)) throw new Error("createOrReusePrintIntakeJob requires a full SHA-256 hash.");
  // 15H.3-K: reuse honors BOTH pointer types. A row created by the MATCHED
  // branch stores matchedProductionJobId (no generated pointer) — if that
  // job later deactivates and the file re-plans, the original linkage wins;
  // a second job is NEVER created for a hash that already has an identity.
  const reuseIdentity = (row: any) => {
    const jobId = row?.generatedProductionJobId || row?.matchedProductionJobId;
    if (!row || !jobId || !row.authoritativeTicket) return null;
    return { created: false, printIntakeId: row.id, productionJobId: jobId, jobTicket: row.authoritativeTicket, ripName: row.routedFilename || row.authoritativeTicket };
  };
  // Fast path outside the transaction (same result the lock would produce).
  const existing = await dbClient.printIntake.findUnique({ where: { shop_fileHashSha256: { shop, fileHashSha256: fileHash } } });
  const existingIdentity = reuseIdentity(existing);
  if (existingIdentity) return existingIdentity;
  const cleanedName = String(input.fileName || "").slice(0, 200);
  const warnings = input.reviewWarnings && input.reviewWarnings.length
    ? input.reviewWarnings
    : ["Commercial linkage pending: no quote/order/customer attached (link later from the Production Board)."];
  try {
    // 15H.1: ticket-constraint P2002 reruns the whole transaction (fresh
    // lock + recheck + fresh ticket); the catch below keeps handling ONLY
    // the PrintIntake (shop, hash) unique-race backstop.
    return await runWithTicketRetry(() => dbClient.$transaction(async (tx: any) => {
      // Concurrency: one lock per file content — two simultaneous plans for
      // the same hash serialize here (15D.1 advisory-lock strategy).
      await acquireSourceLock(tx, shop, "print_intake", fileHash);
      const inside = await tx.printIntake.findUnique({ where: { shop_fileHashSha256: { shop, fileHashSha256: fileHash } } });
      const insideIdentity = reuseIdentity(inside);
      if (insideIdentity) return insideIdentity;
      const jobTicket = await buildNextJobTicket(tx, shop);
      const ripName = buildIntakeRipNameLocal(jobTicket, input.machine, input.mode, cleanedName);
      // 15F.0J.5A: ProductionJob has NO `source` column — PrintIntake is the
      // authoritative source record (generatedProductionJobId + the
      // created_from_print_intake event + notes/customer markers carry the
      // provenance; the board infers "Print Intake" from those).
      const job = await tx.productionJob.create({
        data: {
          shop,
          jobTicket,
          assetInboxKey: jobTicket,
          customerName: "Unlinked (print intake)",
          status: "new",
          priority: "normal",
          internalNotes: [
            "PRINT INTAKE — UNLINKED. Auto-created from a dropped file; no quote/order/payment exists.",
            `Original file: ${cleanedName}`,
            `Printer: ${input.machine} (${input.machineRule}) — mode ${input.mode}.`,
            ...warnings,
          ].join("\n"),
          items: {
            create: [{
              shop,
              itemTicket: itemTicketFor(jobTicket, 0),
              ripJobName: ripName,
              suggestedFileName: ripName,
              productTitle: `PRINT INTAKE — ${cleanedName.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 80)}`,
              quantity: 0, // unknown — never fabricated; set at commercial linkage
              unitPrice: 0,
              unitCost: 0,
              selectedFinish: input.mode,
              machineSummary: input.machine === "roland" ? "Roland LG-640" : "Mimaki UCJV300-130",
              productionNotes: `Auto-created by print intake. Routed as ${ripName}. Quantity/pricing unknown until linked.`,
              costSnapshot: JSON.stringify({ source: "print_intake_auto_created", note: "No cost/revenue data — commercial linkage pending.", hints: input.hints ?? null }),
              sortOrder: 1,
            }],
          },
        },
      });
      const intake = inside
        ? await tx.printIntake.update({
            where: { id: inside.id },
            data: { generatedProductionJobId: job.id, authoritativeTicket: jobTicket, printer: input.machine, printMode: input.mode, routingRule: input.machineRule, routedFilename: ripName, status: "routed", reviewReason: warnings.join(" | ") },
          })
        : await tx.printIntake.create({
            data: {
              shop,
              originalFilename: cleanedName,
              originalSubfolder: input.subfolder || null,
              fileHashSha256: fileHash,
              fileSize: Math.max(0, Math.floor(input.fileSize || 0)),
              status: "routed",
              generatedProductionJobId: job.id,
              authoritativeTicket: jobTicket,
              printer: input.machine,
              printMode: input.mode,
              routingRule: input.machineRule,
              routedFilename: ripName,
              reviewReason: warnings.join(" | "),
              rawParsedHints: JSON.stringify({ hints: input.hints ?? null, warnings }),
            },
          });
      await tx.productionJobEvent.create({
        data: {
          shop,
          jobId: job.id,
          eventType: "created_from_print_intake",
          message: `Print-intake job auto-created from "${cleanedName}" (hash ${fileHash.slice(0, 8)}). Routed to ${input.machine} as ${ripName}. Commercial linkage pending.`,
        },
      });
      return { created: true, printIntakeId: intake.id, productionJobId: job.id, jobTicket, ripName };
    }));
  } catch (error: any) {
    // Unique-constraint race backstop (PrintIntake shop+hash): the other
    // request won — return its identity. Ticket-constraint P2002s never
    // reach here un-retried (runWithTicketRetry) and would not match the
    // hash lookup anyway.
    if (String(error?.code) === "P2002" && !isTicketUniqueViolation(error)) {
      const winner = await dbClient.printIntake.findUnique({ where: { shop_fileHashSha256: { shop, fileHashSha256: fileHash } } });
      const winnerIdentity = reuseIdentity(winner);
      if (winnerIdentity) return winnerIdentity;
    }
    throw error;
  }
}

// Local copy of the routed-name contract (print-intake-routing owns the
// canonical builder; duplicated shape kept in sync by tests).
function buildIntakeRipNameLocal(ticket: string, machine: string, mode: string, originalFileName: string, attempt = 1): string {
  const base = String(originalFileName || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const safe = base.toUpperCase().replace(/[^A-Z0-9.]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "FILE";
  return `${ticket}__${machine.toUpperCase()}__${mode}__${safe}__A${Math.max(1, Math.floor(attempt))}`.slice(0, 120);
}
