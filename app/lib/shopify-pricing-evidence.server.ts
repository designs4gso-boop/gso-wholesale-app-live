// Shopify historical-order pricing evidence (15F.0K.4E). READ-ONLY: pulls
// paid storefront orders via Admin GraphQL (cursor pagination, defensive
// caps), normalizes line items into the SAME privacy-safe evidence records
// as Phase 15F.0K.4D, and caches the normalized summary in ErpAdminSetting.
// NOTHING here writes to Shopify, creates market targets, or reprices
// anything. Customer identities are hashed server-side and the raw values
// never leave this module.
//
// Scope: read_orders covers Shopify's recent (~60-day) window;
// read_all_orders (added 15F.0K.4E, owner-approved) unlocks older history
// after the owner runs `shopify app deploy` and reauthorizes. Until then
// this module still works — just with the shorter window — and the page
// says so instead of failing.

import {
  classifyEvidenceBasket,
  basketKey,
  customerKey,
  evidenceExclusion,
  type EvidenceRecord,
  type ShopifyEvidenceContext,
} from "./pricing-intelligence.server";

export const SHOPIFY_EVIDENCE_SETTING_KEY = "pricingIntelligence.shopifyEvidence";
export const SHOPIFY_EVIDENCE_CATEGORY = "PricingIntelligence";
export const SHOPIFY_ACCESS_BLOCKED_MESSAGE =
  "Historical Shopify order access is not yet authorized. Reauthorize the app with read_all_orders to include orders older than Shopify's standard recent-order window.";

// Defensive pagination caps: 20 pages x 50 orders = 1,000 orders max per
// refresh (far above current shop volume; revisit only with real growth).
export const SHOPIFY_EVIDENCE_MAX_PAGES = 20;
export const SHOPIFY_EVIDENCE_PAGE_SIZE = 50;
const MAX_CACHED_RECORDS = 2000;
const MAX_CACHED_NOTES = 200;

// Read-only order query (October25 API). Only fields Pricing Intelligence
// needs; no addresses, no phone — customer id + email exist SOLELY to build
// the server-side hash and are dropped during normalization.
export const SHOPIFY_ORDER_EVIDENCE_QUERY = `#graphql
  query PricingEvidenceOrders($first: Int!, $cursor: String) {
    orders(first: $first, after: $cursor, query: "status:any", sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        test
        cancelledAt
        createdAt
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount } }
        customer { id }
        email
        lineItems(first: 100) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            refundableQuantity
            isGiftCard
            customAttributes { key value }
            product { productType }
            originalUnitPriceSet { shopMoney { amount } }
            originalTotalSet { shopMoney { amount } }
            discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          }
        }
      }
    }
  }
`;

type NormalizedNote = { label: string; source: "shopify_order"; reasons: string[] };

export type ShopifyEvidenceNormalization = {
  records: EvidenceRecord[];
  excluded: NormalizedNote[];
  incomplete: NormalizedNote[]; // pricingIncomplete — never enters medians
  // 15F.0K.4G: excluded TEST orders (id digit-tail + order name, both
  // privacy-safe) so ERP job/quote evidence paid by them can be excluded
  // or flagged during gathering.
  testOrders: Array<{ id: string; name: string }>;
  orderCount: number;
  earliest: string | null;
  latest: string | null;
};

// digit tail of a Shopify gid/id ("gid://shopify/Order/123" -> "123")
const idTail = (value: any): string | null => {
  const raw = String(value || "");
  const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const digits = tail.replace(/\D/g, "");
  return digits || null;
};

const money = (set: any): number | null => {
  const raw = set?.shopMoney?.amount;
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

// Financial statuses whose price the customer genuinely accepted. PARTIALLY_PAID
// is EXCLUDED (no owner-approved policy exists); refund handling is per-line
// plus the fully-refunded order rule below.
const ACCEPTED_FINANCIAL = ["PAID", "PARTIALLY_REFUNDED"];

export function normalizeShopifyOrderEvidence(orders: any[]): ShopifyEvidenceNormalization {
  const records: EvidenceRecord[] = [];
  const excluded: NormalizedNote[] = [];
  const incomplete: NormalizedNote[] = [];
  const testOrders: Array<{ id: string; name: string }> = [];
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const order of orders || []) {
    const orderLabel = String(order?.name || order?.id || "order");
    const lines = order?.lineItems?.nodes || [];
    const excludeOrder = (reason: string) => {
      excluded.push({ label: `${orderLabel} (${lines.length} line(s))`, source: "shopify_order", reasons: [reason] });
    };

    if (order?.test === true) {
      const testId = idTail(order?.id);
      if (testId) testOrders.push({ id: testId, name: orderLabel });
      excludeOrder("Shopify test order");
      continue;
    }
    if (order?.cancelledAt) { excludeOrder("canceled order"); continue; }
    const financial = String(order?.displayFinancialStatus || "").toUpperCase();
    if (!ACCEPTED_FINANCIAL.includes(financial)) {
      excludeOrder(`financial status ${financial || "UNKNOWN"} is not accepted evidence`);
      continue;
    }
    const refunded = money(order?.totalRefundedSet) ?? 0;
    const subtotal = money(order?.currentSubtotalPriceSet);
    if (refunded > 0 && subtotal != null && refunded >= subtotal && subtotal >= 0) {
      excludeOrder("fully refunded order");
      continue;
    }

    // privacy: hash NOW; raw customer id/email never leave this function.
    const rawCustomerId = order?.customer?.id ? String(order.customer.id) : "";
    const hashedCustomer = rawCustomerId
      ? customerKey(null, rawCustomerId)
      : customerKey(order?.email || null, order?.email ? null : `guest:${String(order?.id || orderLabel)}`);

    const evidenceAtIso = String(order?.processedAt || order?.createdAt || "");
    const evidenceAt = evidenceAtIso ? new Date(evidenceAtIso) : new Date();
    const dateSlice = evidenceAt.toISOString().slice(0, 10);
    if (!earliest || dateSlice < earliest) earliest = dateSlice;
    if (!latest || dateSlice > latest) latest = dateSlice;

    for (const line of lines) {
      const label = `${orderLabel}: ${String(line?.title || "").slice(0, 40)}`;
      if (line?.isGiftCard) { excluded.push({ label, source: "shopify_order", reasons: ["gift card line"] }); continue; }
      const quantity = Math.floor(Number(line?.quantity) || 0);
      const refundable = line?.refundableQuantity == null ? quantity : Math.floor(Number(line.refundableQuantity));
      if (quantity - refundable > 0) {
        excluded.push({ label, source: "shopify_order", reasons: ["refunded line (conservative: partial refunds excluded entirely)"] });
        continue;
      }
      const attributeText = (line?.customAttributes || [])
        .map((attribute: any) => `${attribute?.key}: ${attribute?.value}`)
        .join(" | ");
      const shared = evidenceExclusion({
        sourceId: String(order?.id || ""),
        productName: line?.title,
        customerName: null,
        email: order?.email || null,
        notes: attributeText,
        quantity,
        unitPrice: undefined, // net price checked below with discount context
      });
      if (shared.excluded) { excluded.push({ label, source: "shopify_order", reasons: shared.reasons }); continue; }

      // net selling price = gross line total minus ALL allocated discounts
      // (line-level + order-level allocations); shipping/tax/tips are not
      // line items and never enter this calculation.
      const gross = money(line?.originalTotalSet);
      if (gross == null) {
        incomplete.push({ label, source: "shopify_order", reasons: ["pricingIncomplete: line total unavailable"] });
        continue;
      }
      const allocations = (line?.discountAllocations || []).map((allocation: any) => money(allocation?.allocatedAmountSet));
      if (allocations.some((value: number | null) => value == null)) {
        incomplete.push({ label, source: "shopify_order", reasons: ["pricingIncomplete: discount allocation unavailable"] });
        continue;
      }
      const allocatedDiscount = allocations.reduce((sum: number, value: number) => sum + value, 0);
      const net = gross - allocatedDiscount;
      if (!(net > 0) || !(quantity > 0)) {
        excluded.push({ label, source: "shopify_order", reasons: [!(quantity > 0) ? "non-positive quantity" : "free/zero-net-price line (sample or full discount)"] });
        continue;
      }
      const netUnit = net / quantity;

      const basket = classifyEvidenceBasket({
        productName: line?.title,
        variantTitle: line?.variantTitle,
        selectedFinish: null,
        costSnapshot: null,
        attributeText: `${attributeText} | ${String(line?.product?.productType || "")}`,
        quantity,
      });
      if (basket.family === "unknown" && basket.materialClass === "unknown" && basket.glossStage === "unknown") {
        excluded.push({ label, source: "shopify_order", reasons: ["unclassifiable line (kept out of every basket)"] });
        continue;
      }

      records.push({
        source: "shopify_order",
        basket,
        key: basketKey(basket),
        quantity,
        unitPrice: netUnit,
        state: "accepted",
        customerKey: hashedCustomer,
        evidenceAt,
        exactSnapshot: (line?.customAttributes || []).length > 0,
        pricing: { grossLineTotal: gross, allocatedDiscount, netLineTotal: net, netUnitPrice: netUnit },
        refs: { orderId: idTail(order?.id), lineItemId: idTail(line?.id) },
      });
    }
  }

  return { records, excluded, incomplete, testOrders, orderCount: (orders || []).length, earliest, latest };
}

// ---------- paginated fetch (read-only; defensive caps) ----------
export async function fetchShopifyOrderEvidence(admin: any): Promise<{ orders: any[]; pagesFetched: number; truncated: boolean }> {
  const orders: any[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;
  for (let page = 0; page < SHOPIFY_EVIDENCE_MAX_PAGES; page += 1) {
    const response: any = await admin.graphql(SHOPIFY_ORDER_EVIDENCE_QUERY, { variables: { first: SHOPIFY_EVIDENCE_PAGE_SIZE, cursor } });
    const body: any = await response.json();
    if (body?.errors?.length) {
      const message = body.errors.map((error: any) => error?.message).join("; ");
      throw new Error(`Shopify orders query failed: ${message}`);
    }
    const connection: any = body?.data?.orders;
    if (!connection) throw new Error("Shopify orders query returned no data (possible access restriction).");
    orders.push(...(connection.nodes || []));
    pagesFetched += 1;
    if (!connection.pageInfo?.hasNextPage) return { orders, pagesFetched, truncated: false };
    cursor = connection.pageInfo.endCursor;
  }
  return { orders, pagesFetched, truncated: true };
}

// ---------- cache (ErpAdminSetting JSON — smallest auditable option) ----------
// Chosen over a new Prisma model because current volume is tiny, the repo has
// an established JSON-in-ErpAdminSetting precedent (pricing-feedback,
// ownerConfig), no migration is needed, and the stored rows are ALREADY
// normalized + privacy-safe (hashed customer, no PII, no raw orders).
export type ShopifyEvidenceCache = {
  capturedAt: string;
  ok: boolean;
  error: string | null;
  accessBlocked: boolean;
  orderCount: number;
  pagesFetched: number;
  truncated: boolean;
  earliest: string | null;
  latest: string | null;
  records: Array<Omit<EvidenceRecord, "evidenceAt"> & { evidenceAt: string }>;
  excluded: NormalizedNote[];
  incomplete: NormalizedNote[];
  // 15F.0K.4G — optional so caches written before 4G still load cleanly
  testOrders?: Array<{ id: string; name: string }>;
};

// 15F.0K.4G: dedup/test-propagation context for gatherPricingEvidence,
// built entirely from the privacy-safe cache (object ids + basket keys).
export function buildShopifyEvidenceContext(cache: ShopifyEvidenceCache | null, records: EvidenceRecord[]): ShopifyEvidenceContext {
  const lineItemIds = new Set<string>();
  const orderIds = new Set<string>();
  const keysByLineItemId = new Map<string, string>();
  for (const record of records) {
    if (record.refs?.lineItemId) {
      lineItemIds.add(record.refs.lineItemId);
      keysByLineItemId.set(record.refs.lineItemId, record.key);
    }
    if (record.refs?.orderId) orderIds.add(record.refs.orderId);
  }
  return { lineItemIds, orderIds, keysByLineItemId, testOrders: cache?.testOrders ?? [] };
}

// Order-insensitive basket-key multiset comparison — used by the refresh
// action to show the reclassification notice when updated deterministic
// rules changed how cached history classifies.
export function evidenceKeysChanged(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) return true;
  const sortedPrevious = [...previous].sort();
  const sortedNext = [...next].sort();
  return sortedPrevious.some((key, index) => key !== sortedNext[index]);
}

export function isAccessDeniedError(message: string): boolean {
  return /access\s*denied|not\s*approved|read_all_orders|unauthorized|403/i.test(String(message || ""));
}

export async function saveShopifyEvidenceCache(dbClient: any, shop: string, cache: ShopifyEvidenceCache): Promise<void> {
  const value = JSON.stringify({
    ...cache,
    records: cache.records.slice(0, MAX_CACHED_RECORDS),
    excluded: cache.excluded.slice(0, MAX_CACHED_NOTES),
    incomplete: cache.incomplete.slice(0, MAX_CACHED_NOTES),
  });
  await dbClient.erpAdminSetting.upsert({
    where: { shop_key: { shop, key: SHOPIFY_EVIDENCE_SETTING_KEY } },
    update: { value, category: SHOPIFY_EVIDENCE_CATEGORY, valueType: "json" },
    create: {
      shop,
      category: SHOPIFY_EVIDENCE_CATEGORY,
      key: SHOPIFY_EVIDENCE_SETTING_KEY,
      label: "Pricing Intelligence — normalized Shopify order evidence (privacy-safe cache)",
      value,
      valueType: "json",
      description: "Staff-refreshed, read-only, normalized accepted-price evidence from Shopify orders. Hashed customer keys only — no PII, no raw orders.",
    },
  });
}

export async function loadShopifyEvidenceCache(dbClient: any, shop: string): Promise<{ cache: ShopifyEvidenceCache | null; records: EvidenceRecord[] }> {
  try {
    const row = await dbClient.erpAdminSetting.findUnique({ where: { shop_key: { shop, key: SHOPIFY_EVIDENCE_SETTING_KEY } }, select: { value: true } });
    if (!row?.value) return { cache: null, records: [] };
    const cache = JSON.parse(row.value) as ShopifyEvidenceCache;
    const records: EvidenceRecord[] = (cache.records || []).map((record) => ({ ...record, evidenceAt: new Date(record.evidenceAt) }));
    return { cache, records };
  } catch {
    return { cache: null, records: [] }; // corrupt cache never breaks the page
  }
}
