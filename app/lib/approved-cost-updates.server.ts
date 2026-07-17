import {
  hasVerifiedMarker,
  looksLikeTemplateRecord,
  matchApprovedRecord,
  nearlyEqual,
  tierChangeSummary,
  tiersMatchApproved,
  type ApprovedTier,
  type ApprovedUpdateStatus,
} from "./cost-verification-shared";

// Owner-approved cost truth (13.2.2). Applying is a deliberate in-app action:
// nothing here runs on deploy or page load; the preview is read-only and the
// apply re-computes matching server-side, updates ONLY unambiguously matched
// VendorProduct/VendorProductTier rows in one transaction, and touches nothing
// else (no Shopify, no quotes, no production, no recipes, no schema).

const MIRON_MARKER = "[VERIFIED 2026-07-17 owner-approved Miron jar + normal SAN lid sheet]";
const SAFECARE_MARKER = "[VERIFIED 2026-07-17 owner-approved SAFECARE jar cost]";
const BAG_MARKER = "[VERIFIED 2026-07-17 owner-approved blank bag cost]";
const POUCH_MARKER = "[VERIFIED 2026-07-17 owner-approved DTP 4x5x2 blank pouch table]";

type ApprovedItem = {
  key: string;
  label: string;
  kind: "tiered" | "flat";
  policy: "update" | "manual_review" | "do_not_update";
  matchVendorSkus: string[];
  matchName: RegExp;
  allowTemplates?: boolean;
  tiers?: ApprovedTier[];
  flatCost?: number;
  marker?: string;
  note?: string;
  // 13.2.3: when no clean record exists, items carrying a creation spec may be
  // CREATED on apply. Field shape proven safe by the Vendor Cost Book push and
  // the jar seed (shop/name/productType/vendor/vendorSku/moq/defaultUnitCost/
  // notes/active + tier rows). Items without a spec stay "missing record".
  creation?: {
    name: string;
    productType: string;
    vendor: string;
    vendorSku: string;
  };
};

const RANGES: Array<[number, number | null]> = [[1, 249], [250, 499], [500, 999], [1000, 2499], [2500, null]];
const tiersFrom = (costs: number[]): ApprovedTier[] =>
  RANGES.map(([minQty, maxQty], index) => ({ minQty, maxQty, unitCost: costs[index] }));

export const APPROVED_COST_TRUTH: ApprovedItem[] = [
  // 1. Miron jars — tiered, jar + normal black SAN/plastic lid included.
  { key: "miron-50ml", label: "50ml Miron jar + lid", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-50ml"], matchName: /^50\s?ml.*miron/i, tiers: tiersFrom([2.46, 2.24, 2.03, 1.89, 1.74]), marker: MIRON_MARKER },
  { key: "miron-100ml-tall", label: "100ml tall Miron jar + lid", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-100ml-tall"], matchName: /^100\s?ml.*tall.*miron/i, tiers: tiersFrom([2.78, 2.54, 2.31, 2.14, 1.99]), marker: MIRON_MARKER },
  { key: "miron-100ml-wide", label: "100ml wide Miron jar + lid", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-100ml-wide"], matchName: /^100\s?ml.*wide.*miron/i, tiers: tiersFrom([2.9, 2.67, 2.44, 2.26, 2.1]), marker: MIRON_MARKER },
  { key: "miron-150ml", label: "150ml Miron jar + lid", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-150ml"], matchName: /^150\s?ml.*miron/i, tiers: tiersFrom([3.26, 3.0, 2.76, 2.54, 2.37]), marker: MIRON_MARKER },
  { key: "miron-250ml", label: "250ml Miron jar + lid", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-250ml"], matchName: /^250\s?ml.*miron/i, tiers: tiersFrom([3.92, 3.6, 3.32, 3.11, 2.92]), marker: MIRON_MARKER },

  // 2. SAFECARE jars — flat cost each (a single all-range tier row counts as flat).
  { key: "safecare-3oz-clear", label: "3oz clear jar", kind: "flat", policy: "update", matchVendorSkus: ["preset:3oz-jar-clear"], matchName: /^3\s?oz.*clear/i, flatCost: 0.5, marker: SAFECARE_MARKER },
  { key: "safecare-3oz-bw", label: "3oz black/white jar", kind: "flat", policy: "update", matchVendorSkus: ["preset:3oz-jar-black-white"], matchName: /^3\s?oz.*black/i, flatCost: 0.62, marker: SAFECARE_MARKER },
  { key: "safecare-4oz-clear", label: "4oz clear jar", kind: "flat", policy: "update", matchVendorSkus: ["preset:4oz-jar-clear"], matchName: /^4\s?oz.*clear/i, flatCost: 0.6, marker: SAFECARE_MARKER },
  { key: "safecare-4oz-bw", label: "4oz black/white jar", kind: "flat", policy: "update", matchVendorSkus: ["preset:4oz-jar-black-white"], matchName: /^4\s?oz.*black/i, flatCost: 0.65, marker: SAFECARE_MARKER },
  { key: "safecare-5oz-clear", label: "5oz clear jar (cost-only placeholder)", kind: "flat", policy: "update", matchVendorSkus: ["preset:5oz-jar-clear"], matchName: /^5\s?oz.*clear/i, flatCost: 0.6, marker: SAFECARE_MARKER, note: "Cost item only — stays out of storefront/quote flow per project rules; this updates its cost record, nothing else." },

  // 3. Blank bags — flat cost each (created flat, NOT fake multi-tier items;
  // the Vendor Cost Book pattern does not require one-row tiers — the
  // calculator/audit/engine paths all read defaultUnitCost for tierless items).
  // vendorSkus reuse the calculator preset ids so the stale code presets
  // auto-hide once these records exist (12B.1a supersede rule).
  { key: "bag-4x5", label: "4x5 blank bag", kind: "flat", policy: "update", matchVendorSkus: ["preset:blank-4x5-bag"], matchName: /^(blank\s*)?4\s?x\s?5\b.*bag/i, flatCost: 0.09, marker: BAG_MARKER, creation: { name: "4x5 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x5-bag" } },
  { key: "bag-4x6", label: "4x6 blank bag", kind: "flat", policy: "update", matchVendorSkus: ["preset:blank-4x6-bag"], matchName: /^(blank\s*)?4\s?x\s?6\b.*bag/i, flatCost: 0.1, marker: BAG_MARKER, creation: { name: "4x6 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x6-bag" } },
  { key: "bag-14x16", label: "14x16 / larger blank bag", kind: "flat", policy: "update", matchVendorSkus: ["preset:pound-bag"], matchName: /(14\s?x\s?16|pound)\s*(blank\s*)?bag/i, flatCost: 1.0, marker: BAG_MARKER, creation: { name: "14x16 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:pound-bag" } },

  // 4. DTP 4x5x2 blank pouch — tiered (owner vendor table, total ÷ pieces).
  {
    key: "dtp-4x5x2-pouch", label: "DTP 4x5x2 blank pouch", kind: "tiered", policy: "update",
    matchVendorSkus: ["preset:dtp-4x5x2-pouch"], matchName: /4\s?x\s?5\s?x\s?2.*pouch|dtp.*4\s?x\s?5\s?x\s?2/i,
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 0.7138 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.4744 },
      { minQty: 5000, maxQty: 7499, unitCost: 0.4029 },
      { minQty: 7500, maxQty: 9999, unitCost: 0.3458 },
      { minQty: 10000, maxQty: null, unitCost: 0.3117 },
    ],
    marker: POUCH_MARKER,
    creation: { name: "DTP 4x5x2 Blank Pouch", productType: "dtp_bag", vendor: "Vendor TBD", vendorSku: "preset:dtp-4x5x2-pouch" },
  },

  // 5. Do not update yet / manual review.
  { key: "dtp-4x6x2-pouch", label: "DTP 4x6x2 blank pouch", kind: "flat", policy: "do_not_update", matchVendorSkus: [], matchName: /4\s?x\s?6\s?x\s?2.*pouch/i, note: "No pricing yet — leave unverified." },
  { key: "miron-black-metal-lids", label: "Miron black metal lids", kind: "flat", policy: "do_not_update", matchVendorSkus: [], matchName: /black\s*metal\s*lid/i, note: "Future optional add-on — never the default lid price." },
  { key: "template-4x5-stock-bag", label: "Template - 4x5 Outsourced Stock Bag", kind: "flat", policy: "manual_review", matchVendorSkus: [], matchName: /template.*4\s?x\s?5.*stock\s?bag/i, allowTemplates: true, note: "Placeholder — do not convert to a live cost record unless the owner confirms it is a real item." },
  { key: "template-outsourced-box", label: "Template - Outsourced Box", kind: "flat", policy: "manual_review", matchVendorSkus: [], matchName: /template.*outsourced\s*box/i, allowTemplates: true, note: "Placeholder — do not convert to a live cost record unless the owner confirms it is a real item." },
];

type VendorProductRecord = {
  id: string;
  name: string | null;
  vendor: string | null;
  vendorSku: string | null;
  defaultUnitCost: number;
  notes: string | null;
  tiers: Array<{ id: string; minQty: number; maxQty: number | null; unitCost: number }>;
};

export type ApprovedPreviewRow = {
  key: string;
  label: string;
  kind: "tiered" | "flat";
  status: ApprovedUpdateStatus;
  matchedName: string | null;
  currentSummary: string;
  approvedSummary: string;
  changes: string[];
  note: string;
};

function money(value: number) {
  return `$${Number(value).toFixed(4).replace(/0{0,2}$/, "")}`;
}

function approvedSummaryOf(item: ApprovedItem) {
  if (item.kind === "tiered" && item.tiers) {
    return item.tiers.map((tier) => `${tier.minQty}${tier.maxQty == null ? "+" : `-${tier.maxQty}`}: ${money(tier.unitCost)}`).join("; ");
  }
  return item.flatCost != null ? `${money(item.flatCost)} each (flat)` : "—";
}

function currentSummaryOf(record: VendorProductRecord | null) {
  if (!record) return "no record";
  if (record.tiers.length) {
    return record.tiers.map((tier) => `${tier.minQty}${tier.maxQty == null ? "+" : `-${tier.maxQty}`}: ${money(Number(tier.unitCost))}`).join("; ");
  }
  return Number(record.defaultUnitCost) > 0 ? `${money(Number(record.defaultUnitCost))} each (flat)` : "no cost";
}

// Exported for tests: pure given (item, candidate records).
export function evaluateApprovedItem(item: ApprovedItem, vendorProducts: VendorProductRecord[]): { row: ApprovedPreviewRow; record: VendorProductRecord | null } {
  const base = {
    key: item.key,
    label: item.label,
    kind: item.kind,
    approvedSummary: item.policy === "update" ? approvedSummaryOf(item) : "—",
    note: item.note || "",
  };

  const match = matchApprovedRecord(item, vendorProducts);

  if (item.policy === "do_not_update") {
    return { row: { ...base, status: "do_not_update", matchedName: match.record?.name || null, currentSummary: currentSummaryOf(match.record), changes: [] }, record: null };
  }
  if (item.policy === "manual_review") {
    return { row: { ...base, status: "manual_review", matchedName: match.record?.name || (match.hits.length ? `${match.hits.length} candidate(s)` : null), currentSummary: currentSummaryOf(match.record), changes: [] }, record: null };
  }
  if (match.status === "ambiguous") {
    return { row: { ...base, status: "ambiguous", matchedName: match.hits.map((hit) => hit.name).join(" | "), currentSummary: "multiple candidates", changes: [] }, record: null };
  }
  if (match.status === "missing" || !match.record) {
    if (item.creation) {
      const changes = [
        `create VendorProduct "${item.creation.name}" (${item.creation.productType}, vendor: ${item.creation.vendor}, sku: ${item.creation.vendorSku})`,
        ...(item.kind === "tiered" && item.tiers
          ? [`create ${item.tiers.length} tier row(s)`]
          : [`flat cost ${money(item.flatCost || 0)} (no tier rows)`]),
        ...(item.marker ? ["add verified marker to notes"] : []),
      ];
      return { row: { ...base, status: "will_create", matchedName: null, currentSummary: "no record", changes }, record: null };
    }
    return { row: { ...base, status: "missing_record", matchedName: null, currentSummary: "no record", changes: [] }, record: null };
  }

  const record = match.record;
  const changes: string[] = [];
  const markerPresent = item.marker ? hasVerifiedMarker(record.notes) : true;

  if (item.kind === "tiered" && item.tiers) {
    if (!tiersMatchApproved(record.tiers, item.tiers)) changes.push(...tierChangeSummary(record.tiers, item.tiers));
    if (Number(record.defaultUnitCost) > 0 && !nearlyEqual(Number(record.defaultUnitCost), item.tiers[0].unitCost, 0.0001)) {
      changes.push(`default cost: ${money(Number(record.defaultUnitCost))} -> ${money(item.tiers[0].unitCost)} (first tier)`);
    }
  } else if (item.kind === "flat" && item.flatCost != null) {
    if (record.tiers.length > 1) {
      return { row: { ...base, status: "manual_review", matchedName: record.name, currentSummary: currentSummaryOf(record), changes: [], note: `${base.note ? `${base.note} ` : ""}Approved as flat but the record has ${record.tiers.length} tiers — owner must confirm before flattening.` }, record: null };
    }
    if (!nearlyEqual(Number(record.defaultUnitCost), item.flatCost, 0.0001)) {
      changes.push(`flat cost: ${Number(record.defaultUnitCost) > 0 ? money(Number(record.defaultUnitCost)) : "none"} -> ${money(item.flatCost)}`);
    }
    if (record.tiers.length === 1 && !nearlyEqual(Number(record.tiers[0].unitCost), item.flatCost, 0.0001)) {
      changes.push(`single tier row: ${money(Number(record.tiers[0].unitCost))} -> ${money(item.flatCost)}`);
    }
  }
  if (!markerPresent) changes.push("add verified marker to notes");

  const status: ApprovedUpdateStatus = changes.length ? "will_update" : "already_correct";
  return {
    row: { ...base, status, matchedName: record.name, currentSummary: currentSummaryOf(record), changes },
    record: status === "will_update" ? record : null,
  };
}

async function loadVendorProducts(dbClient: any, shop: string): Promise<VendorProductRecord[]> {
  return dbClient.vendorProduct.findMany({
    where: { shop, active: true },
    select: {
      id: true, name: true, vendor: true, vendorSku: true, defaultUnitCost: true, notes: true,
      tiers: { select: { id: true, minQty: true, maxQty: true, unitCost: true }, orderBy: { minQty: "asc" } },
    },
    take: 300,
  });
}

export async function previewApprovedCostUpdates(dbClient: any, shop: string): Promise<ApprovedPreviewRow[]> {
  const vendorProducts = await loadVendorProducts(dbClient, shop);
  return APPROVED_COST_TRUTH.map((item) => evaluateApprovedItem(item, vendorProducts).row);
}

// Applies ONLY rows the server itself re-evaluates as will_update/will_create.
// Updates are scoped to the matched VendorProduct + its tiers; creations use
// the field shape proven by the Vendor Cost Book / jar seed. One transaction.
export async function applyApprovedCostUpdates(dbClient: any, shop: string) {
  const vendorProducts = await loadVendorProducts(dbClient, shop);
  const evaluated = APPROVED_COST_TRUTH.map((item) => ({ item, ...evaluateApprovedItem(item, vendorProducts) }));
  const toUpdate = evaluated.filter((entry) => entry.row.status === "will_update" && entry.record);
  const toCreate = evaluated.filter((entry) => entry.row.status === "will_create" && entry.item.creation);

  await dbClient.$transaction(async (tx: any) => {
    for (const { item, record } of toUpdate) {
      if (!record) continue;
      const marker = item.marker && !hasVerifiedMarker(record.notes) ? item.marker : null;
      const notes = marker ? `${record.notes ? `${record.notes}\n` : ""}${marker}` : undefined;

      if (item.kind === "tiered" && item.tiers) {
        await tx.vendorProductTier.deleteMany({ where: { shop, vendorProductId: record.id } });
        await tx.vendorProductTier.createMany({
          data: item.tiers.map((tier) => ({
            shop,
            vendorProductId: record.id,
            minQty: tier.minQty,
            maxQty: tier.maxQty,
            unitCost: tier.unitCost,
            notes: "Owner-approved 2026-07-17",
          })),
        });
        await tx.vendorProduct.update({
          where: { id: record.id },
          data: { defaultUnitCost: item.tiers[0].unitCost, ...(notes ? { notes } : {}) },
        });
      } else if (item.kind === "flat" && item.flatCost != null) {
        if (record.tiers.length === 1) {
          await tx.vendorProductTier.update({ where: { id: record.tiers[0].id }, data: { unitCost: item.flatCost, notes: "Owner-approved 2026-07-17" } });
        }
        await tx.vendorProduct.update({
          where: { id: record.id },
          data: { defaultUnitCost: item.flatCost, ...(notes ? { notes } : {}) },
        });
      }
    }

    for (const { item } of toCreate) {
      const creation = item.creation!;
      const flatDefault = item.kind === "tiered" && item.tiers ? item.tiers[0].unitCost : item.flatCost || 0;
      await tx.vendorProduct.create({
        data: {
          shop,
          name: creation.name,
          productType: creation.productType,
          vendor: creation.vendor,
          vendorSku: creation.vendorSku,
          moq: 1,
          defaultUnitCost: flatDefault,
          active: true,
          notes: `Created by Approved Cost Updates (13.2.3).${item.marker ? `\n${item.marker}` : ""}`,
          ...(item.kind === "tiered" && item.tiers
            ? {
                tiers: {
                  create: item.tiers.map((tier) => ({
                    shop,
                    minQty: tier.minQty,
                    maxQty: tier.maxQty,
                    unitCost: tier.unitCost,
                    notes: "Owner-approved 2026-07-17",
                  })),
                },
              }
            : {}),
        },
      });
    }
  });

  return {
    applied: [...toUpdate, ...toCreate].map((entry) => ({ key: entry.row.key, label: entry.row.label, status: entry.row.status, changes: entry.row.changes })),
    skipped: evaluated.filter((entry) => entry.row.status !== "will_update" && entry.row.status !== "will_create").map((entry) => ({ key: entry.row.key, status: entry.row.status })),
  };
}
