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

// Owner-approved cost truth (13.2.2 vendor blanks, 13.2.3 creation, 13.2.4
// roll materials + ink). Applying is a deliberate in-app action: nothing runs
// on deploy or page load; the preview is read-only and the apply re-computes
// matching server-side, writes ONLY unambiguously matched records in one
// transaction, and touches nothing else (no Shopify, no quotes, no
// production, no recipes, no engine, no schema). Raw material costs only —
// waste, labor, speed, and ink-usage profiles stay separate pricing factors.

const MIRON_MARKER = "[VERIFIED 2026-07-17 owner-approved Miron jar + normal SAN lid sheet]";
const SAFECARE_MARKER = "[VERIFIED 2026-07-17 owner-approved SAFECARE jar cost]";
const BAG_MARKER = "[VERIFIED 2026-07-17 owner-approved blank bag cost]";
// 2D-2: the 4x5 blank was superseded on 2026-08-22 ($0.09 -> $0.11). Its own
// marker keeps the two dates distinguishable in the audit trail, and the
// canonical bag adapter reads BAG_4X5_BLANK_UNIT_COST rather than this seed.
const BAG_MARKER_4X5 = "[VERIFIED 2026-08-22 owner-approved 4x5 blank bag cost $0.11 - supersedes the 2026-07-17 $0.09]";
const POUCH_MARKER = "[VERIFIED 2026-07-17 owner-approved DTP 4x5x2 blank pouch table]";
const ROLL_INK_MARKER = "[VERIFIED 2026-07-17 owner-approved roll/ink cost]";

// Full-precision approved costs (never pre-rounded, never waste-adjusted).
export const APPROVED_ROLL_COSTS = {
  poseidonMattePerSqft: 213 / ((54 / 12) * 150), // 0.3155555556
  poseidonGlossPerSqft: 213 / ((54 / 12) * 150), // 0.3155555556
  holographicPerSqft: 488 / ((50 / 12) * 164), // 0.7141463415
  bannerVinylPerSqft: 140 / ((54 / 12) * 105), // 0.2962962963
  mimakiPerMl: 176 / 1000, // 0.1760
  rolandPerMl: 149 / 750, // 0.1986666667
} as const;

type ApprovedItem = {
  key: string;
  label: string;
  target: "vendor_product" | "material" | "material_group" | "ink_channels";
  kind: "tiered" | "flat";
  policy: "update" | "manual_review" | "do_not_update";
  matchVendorSkus: string[];
  matchName: RegExp;
  allowTemplates?: boolean;
  tiers?: ApprovedTier[];
  flatCost?: number;
  marker?: string;
  note?: string;
  // 13.2.3: vendor-product creation spec (field shape proven by the Vendor
  // Cost Book push and the jar seed).
  creation?: { name: string; productType: string; vendor: string; vendorSku: string };
  // 13.2.4: material targets. approvedUnitCost is the raw per-base-unit cost;
  // purchase details keep the Materials-page derivation convention
  // (calculatedUnitCost = purchaseCost / roll sqft or / volumeMl).
  material?: {
    approvedUnitCost: number;
    unitLabel: "sqft" | "ml";
    purchase: { cost: number; rollWidthIn?: number; rollLengthFt?: number; volumeMl?: number };
    // Creation spec (Banner Vinyl only); field shape proven by the Materials
    // page create path.
    creation?: { name: string; materialType: string; baseUnit: string; unit: string; purchaseUnit: string; vendor: string };
  };
  // 13.2.4: machine ink channel group per brand (channels have no notes field,
  // so verified markers are not storable on them until the schema patch).
  inkChannels?: { machineName: RegExp; approvedCostPerMl: number; cartridgeCost: number; cartridgeMl: number };
};

const RANGES: Array<[number, number | null]> = [[1, 249], [250, 499], [500, 999], [1000, 2499], [2500, null]];
const tiersFrom = (costs: number[]): ApprovedTier[] =>
  RANGES.map(([minQty, maxQty], index) => ({ minQty, maxQty, unitCost: costs[index] }));

export const APPROVED_COST_TRUTH: ApprovedItem[] = [
  // 1. Miron jars — tiered, jar + normal black SAN/plastic lid included.
  { key: "miron-50ml", label: "50ml Miron jar + lid", target: "vendor_product", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-50ml"], matchName: /^50\s?ml.*miron/i, tiers: tiersFrom([2.46, 2.24, 2.03, 1.89, 1.74]), marker: MIRON_MARKER },
  { key: "miron-100ml-tall", label: "100ml tall Miron jar + lid", target: "vendor_product", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-100ml-tall"], matchName: /^100\s?ml.*tall.*miron/i, tiers: tiersFrom([2.78, 2.54, 2.31, 2.14, 1.99]), marker: MIRON_MARKER },
  { key: "miron-100ml-wide", label: "100ml wide Miron jar + lid", target: "vendor_product", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-100ml-wide"], matchName: /^100\s?ml.*wide.*miron/i, tiers: tiersFrom([2.9, 2.67, 2.44, 2.26, 2.1]), marker: MIRON_MARKER },
  { key: "miron-150ml", label: "150ml Miron jar + lid", target: "vendor_product", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-150ml"], matchName: /^150\s?ml.*miron/i, tiers: tiersFrom([3.26, 3.0, 2.76, 2.54, 2.37]), marker: MIRON_MARKER },
  { key: "miron-250ml", label: "250ml Miron jar + lid", target: "vendor_product", kind: "tiered", policy: "update", matchVendorSkus: ["preset:miron-250ml"], matchName: /^250\s?ml.*miron/i, tiers: tiersFrom([3.92, 3.6, 3.32, 3.11, 2.92]), marker: MIRON_MARKER },

  // 2. SAFECARE jars — flat cost each.
  { key: "safecare-3oz-clear", label: "3oz clear jar", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:3oz-jar-clear"], matchName: /^3\s?oz.*clear/i, flatCost: 0.5, marker: SAFECARE_MARKER },
  { key: "safecare-3oz-bw", label: "3oz black/white jar", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:3oz-jar-black-white"], matchName: /^3\s?oz.*black/i, flatCost: 0.62, marker: SAFECARE_MARKER },
  { key: "safecare-4oz-clear", label: "4oz clear jar", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:4oz-jar-clear"], matchName: /^4\s?oz.*clear/i, flatCost: 0.6, marker: SAFECARE_MARKER },
  { key: "safecare-4oz-bw", label: "4oz black/white jar", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:4oz-jar-black-white"], matchName: /^4\s?oz.*black/i, flatCost: 0.65, marker: SAFECARE_MARKER },
  { key: "safecare-5oz-clear", label: "5oz clear jar (cost-only placeholder)", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:5oz-jar-clear"], matchName: /^5\s?oz.*clear/i, flatCost: 0.6, marker: SAFECARE_MARKER, note: "Cost item only — stays out of storefront/quote flow per project rules; this updates its cost record, nothing else." },

  // 3. Blank bags — flat cost each, created flat (no fake tiers) when missing.
  { key: "bag-4x5", label: "4x5 blank bag", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:blank-4x5-bag"], matchName: /^(blank\s*)?4\s?x\s?5\b.*bag/i, flatCost: 0.11, marker: BAG_MARKER_4X5, creation: { name: "4x5 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x5-bag" } },
  { key: "bag-4x6", label: "4x6 blank bag", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:blank-4x6-bag"], matchName: /^(blank\s*)?4\s?x\s?6\b.*bag/i, flatCost: 0.1, marker: BAG_MARKER, creation: { name: "4x6 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x6-bag" } },
  { key: "bag-14x16", label: "14x16 / larger blank bag", target: "vendor_product", kind: "flat", policy: "update", matchVendorSkus: ["preset:pound-bag"], matchName: /(14\s?x\s?16|pound)\s*(blank\s*)?bag/i, flatCost: 1.0, marker: BAG_MARKER, creation: { name: "14x16 Blank Bag", productType: "bag", vendor: "Vendor TBD", vendorSku: "preset:pound-bag" } },

  // 4. DTP 4x5x2 blank pouch — tiered.
  {
    key: "dtp-4x5x2-pouch", label: "DTP 4x5x2 blank pouch", target: "vendor_product", kind: "tiered", policy: "update",
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

  // 5. Roll materials (13.2.4) — raw roll cost only; waste stays separate.
  { key: "roll-poseidon-matte", label: "Poseidon matte roll media", target: "material", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /poseidon.*matte|matte.*poseidon/i, marker: ROLL_INK_MARKER, material: { approvedUnitCost: APPROVED_ROLL_COSTS.poseidonMattePerSqft, unitLabel: "sqft", purchase: { cost: 213, rollWidthIn: 54, rollLengthFt: 150 } } },
  { key: "roll-poseidon-gloss", label: "Poseidon gloss roll media", target: "material", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /poseidon.*gloss|gloss.*poseidon/i, marker: ROLL_INK_MARKER, material: { approvedUnitCost: APPROVED_ROLL_COSTS.poseidonGlossPerSqft, unitLabel: "sqft", purchase: { cost: 213, rollWidthIn: 54, rollLengthFt: 150 } } },
  { key: "roll-holographic", label: "Holographic roll media", target: "material", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /holographic/i, marker: ROLL_INK_MARKER, material: { approvedUnitCost: APPROVED_ROLL_COSTS.holographicPerSqft, unitLabel: "sqft", purchase: { cost: 488, rollWidthIn: 50, rollLengthFt: 164 } } },
  {
    key: "roll-banner-vinyl", label: "Banner vinyl", target: "material", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /banner.*vinyl|vinyl.*banner|^banner\s*(roll|media)?$/i, marker: ROLL_INK_MARKER,
    material: {
      approvedUnitCost: APPROVED_ROLL_COSTS.bannerVinylPerSqft, unitLabel: "sqft", purchase: { cost: 140, rollWidthIn: 54, rollLengthFt: 105 },
      creation: { name: "Banner Vinyl", materialType: "banner", baseUnit: "sqft", unit: "sqft", purchaseUnit: "roll", vendor: "Vendor TBD" },
    },
  },

  // 6. Ink materials (13.2.4) — brand groups: updates EVERY non-template ink
  // material row matching the brand, whatever the row layout (per-type rows or
  // one combined row). No creation — machine channels are the engine's source.
  { key: "ink-material-mimaki", label: "Mimaki ink material row(s)", target: "material_group", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /mimaki/i, marker: ROLL_INK_MARKER, material: { approvedUnitCost: APPROVED_ROLL_COSTS.mimakiPerMl, unitLabel: "ml", purchase: { cost: 176, volumeMl: 1000 } } },
  { key: "ink-material-roland", label: "Roland ink material row(s)", target: "material_group", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /roland|lg[-\s]?540|eco[-\s]?uv/i, marker: ROLL_INK_MARKER, material: { approvedUnitCost: APPROVED_ROLL_COSTS.rolandPerMl, unitLabel: "ml", purchase: { cost: 149, volumeMl: 750 } } },

  // 7. Machine ink channels (13.2.4) — CMYK/White/Gloss(Clear) enabled
  // channels per machine brand. No notes field on channels: verified markers
  // wait for the schema patch (shown as a note, not a blocker).
  { key: "ink-channels-mimaki", label: "Mimaki machine ink channels", target: "ink_channels", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /mimaki/i, note: "Ink channels have no notes field; verified marker arrives with the schema patch.", inkChannels: { machineName: /mimaki/i, approvedCostPerMl: APPROVED_ROLL_COSTS.mimakiPerMl, cartridgeCost: 176, cartridgeMl: 1000 } },
  { key: "ink-channels-roland", label: "Roland machine ink channels", target: "ink_channels", kind: "flat", policy: "update", matchVendorSkus: [], matchName: /roland/i, note: "Ink channels have no notes field; verified marker arrives with the schema patch.", inkChannels: { machineName: /roland/i, approvedCostPerMl: APPROVED_ROLL_COSTS.rolandPerMl, cartridgeCost: 149, cartridgeMl: 750 } },

  // 8. Do not update yet / manual review.
  { key: "dtp-4x6x2-pouch", label: "DTP 4x6x2 blank pouch", target: "vendor_product", kind: "flat", policy: "do_not_update", matchVendorSkus: [], matchName: /4\s?x\s?6\s?x\s?2.*pouch/i, note: "No pricing yet — leave unverified." },
  { key: "miron-black-metal-lids", label: "Miron black metal lids", target: "vendor_product", kind: "flat", policy: "do_not_update", matchVendorSkus: [], matchName: /black\s*metal\s*lid/i, note: "Future optional add-on — never the default lid price." },
  { key: "template-4x5-stock-bag", label: "Template - 4x5 Outsourced Stock Bag", target: "vendor_product", kind: "flat", policy: "manual_review", matchVendorSkus: [], matchName: /template.*4\s?x\s?5.*stock\s?bag/i, allowTemplates: true, note: "Placeholder — do not convert to a live cost record unless the owner confirms it is a real item." },
  { key: "template-outsourced-box", label: "Template - Outsourced Box", target: "vendor_product", kind: "flat", policy: "manual_review", matchVendorSkus: [], matchName: /template.*outsourced\s*box/i, allowTemplates: true, note: "Placeholder — do not convert to a live cost record unless the owner confirms it is a real item." },
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

type MaterialRecord = {
  id: string;
  name: string | null;
  materialType: string | null;
  vendorSku?: string | null;
  sku: string | null;
  notes: string | null;
  costPerUnit: number;
  calculatedUnitCost: number;
  purchaseCost: number;
  purchaseUnit: string | null;
  rollWidthIn: number | null;
  rollLengthFt: number | null;
  volumeMl: number | null;
  baseUnit: string | null;
  unit: string | null;
};

type MachineRecord = {
  id: string;
  name: string | null;
  inkChannels: Array<{ id: string; slotNumber: number; inkName: string | null; inkType: string | null; enabled: boolean; costPerMl: number; cartridgeCost: number; cartridgeMl: number }>;
};

export type EvalContext = {
  vendorProducts: VendorProductRecord[];
  materials: MaterialRecord[];
  machines: MachineRecord[];
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

const CHANNEL_TYPES = /cmyk|white|gloss/i;
const isRelevantChannel = (channel: MachineRecord["inkChannels"][number]) =>
  channel.enabled && (CHANNEL_TYPES.test(String(channel.inkType || "")) || /clear/i.test(String(channel.inkName || "")));

function approvedSummaryOf(item: ApprovedItem) {
  if (item.target === "material" || item.target === "material_group") {
    return `${money(item.material!.approvedUnitCost)}/${item.material!.unitLabel}`;
  }
  if (item.target === "ink_channels") {
    return `${money(item.inkChannels!.approvedCostPerMl)}/ml (cartridge $${item.inkChannels!.cartridgeCost}/${item.inkChannels!.cartridgeMl}ml)`;
  }
  if (item.kind === "tiered" && item.tiers) {
    return item.tiers.map((tier) => `${tier.minQty}${tier.maxQty == null ? "+" : `-${tier.maxQty}`}: ${money(tier.unitCost)}`).join("; ");
  }
  return item.flatCost != null ? `${money(item.flatCost)} each (flat)` : "—";
}

function vendorCurrentSummaryOf(record: VendorProductRecord | null) {
  if (!record) return "no record";
  if (record.tiers.length) {
    return record.tiers.map((tier) => `${tier.minQty}${tier.maxQty == null ? "+" : `-${tier.maxQty}`}: ${money(Number(tier.unitCost))}`).join("; ");
  }
  return Number(record.defaultUnitCost) > 0 ? `${money(Number(record.defaultUnitCost))} each (flat)` : "no cost";
}

function materialCurrentCost(record: MaterialRecord) {
  return Number(record.calculatedUnitCost) > 0 ? Number(record.calculatedUnitCost) : Number(record.costPerUnit) || 0;
}

// Exported for tests: pure given (item, context records).
export function evaluateApprovedItem(item: ApprovedItem, context: EvalContext): {
  row: ApprovedPreviewRow;
  record: VendorProductRecord | null;
  materialRecord: MaterialRecord | null;
  materialGroup: MaterialRecord[];
  channelGroup: Array<{ machine: MachineRecord; channels: MachineRecord["inkChannels"] }>;
} {
  const base = {
    key: item.key,
    label: item.label,
    kind: item.kind,
    approvedSummary: item.policy === "update" ? approvedSummaryOf(item) : "—",
    note: item.note || "",
  };
  const none = { record: null, materialRecord: null, materialGroup: [] as MaterialRecord[], channelGroup: [] as Array<{ machine: MachineRecord; channels: MachineRecord["inkChannels"] }> };

  // ---- material (unique roll) ----
  if (item.target === "material") {
    const pool = context.materials.filter((m) => !looksLikeTemplateRecord(m.name));
    const hits = pool.filter((m) => item.matchName.test(String(m.name ?? "")));
    if (hits.length > 1) return { ...none, row: { ...base, status: "ambiguous", matchedName: hits.map((h) => h.name).join(" | "), currentSummary: "multiple candidates", changes: [] } };
    if (!hits.length) {
      if (item.material?.creation) {
        const spec = item.material.creation;
        const changes = [
          `create Material "${spec.name}" (${spec.materialType}, ${spec.purchaseUnit} $${item.material.purchase.cost}, ${item.material.purchase.rollWidthIn}in x ${item.material.purchase.rollLengthFt}ft, vendor: ${spec.vendor})`,
          `cost ${money(item.material.approvedUnitCost)}/${item.material.unitLabel}`,
          "add verified marker to notes",
        ];
        return { ...none, row: { ...base, status: "will_create", matchedName: null, currentSummary: "no record", changes } };
      }
      return { ...none, row: { ...base, status: "missing_record", matchedName: null, currentSummary: "no record", changes: [] } };
    }
    const record = hits[0];
    const current = materialCurrentCost(record);
    const changes: string[] = [];
    if (!nearlyEqual(current, item.material!.approvedUnitCost, 0.0001)) {
      changes.push(`cost/${item.material!.unitLabel}: ${current > 0 ? money(current) : "none"} -> ${money(item.material!.approvedUnitCost)}`);
    }
    const purchase = item.material!.purchase;
    if (!nearlyEqual(Number(record.purchaseCost) || 0, purchase.cost, 0.005)) changes.push(`purchase cost: $${Number(record.purchaseCost) || 0} -> $${purchase.cost}`);
    if (purchase.rollWidthIn && !nearlyEqual(Number(record.rollWidthIn) || 0, purchase.rollWidthIn, 0.01)) changes.push(`roll width: ${Number(record.rollWidthIn) || 0}in -> ${purchase.rollWidthIn}in`);
    if (purchase.rollLengthFt && !nearlyEqual(Number(record.rollLengthFt) || 0, purchase.rollLengthFt, 0.01)) changes.push(`roll length: ${Number(record.rollLengthFt) || 0}ft -> ${purchase.rollLengthFt}ft`);
    if (item.marker && !hasVerifiedMarker(record.notes)) changes.push("add verified marker to notes");
    return {
      ...none,
      materialRecord: changes.length ? record : null,
      row: { ...base, status: changes.length ? "will_update" : "already_correct", matchedName: record.name, currentSummary: current > 0 ? `${money(current)}/${item.material!.unitLabel}` : "no cost", changes },
    };
  }

  // ---- material_group (ink materials by brand, any row layout) ----
  if (item.target === "material_group") {
    const isInk = (m: MaterialRecord) => /ink|coating/i.test(String(m.materialType || "")) || /\bink\b/i.test(String(m.name || ""));
    const hits = context.materials.filter((m) => !looksLikeTemplateRecord(m.name) && isInk(m) && item.matchName.test(String(m.name ?? "")));
    if (!hits.length) return { ...none, row: { ...base, status: "missing_record", matchedName: null, currentSummary: "no ink material rows for this brand", changes: [] } };
    const needing = hits.filter((m) => !nearlyEqual(materialCurrentCost(m), item.material!.approvedUnitCost, 0.0001) || (item.marker && !hasVerifiedMarker(m.notes)));
    const currentValues = [...new Set(hits.map((m) => money(materialCurrentCost(m))))].join(", ");
    const changes = needing.length
      ? [`${needing.length} of ${hits.length} row(s): ${currentValues}/ml -> ${money(item.material!.approvedUnitCost)}/ml`, `purchase $${item.material!.purchase.cost}/${item.material!.purchase.volumeMl}ml`, "add verified marker to notes"]
      : [];
    return {
      ...none,
      materialGroup: needing,
      row: { ...base, status: needing.length ? "will_update" : "already_correct", matchedName: hits.slice(0, 3).map((h) => h.name).join(" | ") + (hits.length > 3 ? ` +${hits.length - 3}` : ""), currentSummary: `${hits.length} row(s) at ${currentValues}/ml`, changes },
    };
  }

  // ---- ink_channels (per machine brand) ----
  if (item.target === "ink_channels") {
    const spec = item.inkChannels!;
    const machines = context.machines.filter((m) => spec.machineName.test(String(m.name ?? "")));
    if (!machines.length) return { ...none, row: { ...base, status: "missing_record", matchedName: null, currentSummary: "no matching machine", changes: [] } };
    if (machines.length > 1) return { ...none, row: { ...base, status: "ambiguous", matchedName: machines.map((m) => m.name).join(" | "), currentSummary: "multiple machines match", changes: [] } };
    const machine = machines[0];
    const channels = machine.inkChannels.filter(isRelevantChannel);
    if (!channels.length) return { ...none, row: { ...base, status: "missing_record", matchedName: machine.name, currentSummary: "no enabled CMYK/White/Gloss channels", changes: [] } };
    const needing = channels.filter((channel) =>
      !nearlyEqual(Number(channel.costPerMl) || 0, spec.approvedCostPerMl, 0.0001) ||
      !nearlyEqual(Number(channel.cartridgeCost) || 0, spec.cartridgeCost, 0.005) ||
      !nearlyEqual(Number(channel.cartridgeMl) || 0, spec.cartridgeMl, 0.5),
    );
    const currentValues = [...new Set(channels.map((channel) => money(Number(channel.costPerMl) || 0)))].join(", ");
    const changes = needing.length
      ? [`${needing.length} of ${channels.length} channel(s): ${currentValues}/ml -> ${money(spec.approvedCostPerMl)}/ml`, `cartridge -> $${spec.cartridgeCost}/${spec.cartridgeMl}ml`]
      : [];
    return {
      ...none,
      channelGroup: needing.length ? [{ machine, channels: needing }] : [],
      row: { ...base, status: needing.length ? "will_update" : "already_correct", matchedName: machine.name, currentSummary: `${channels.length} channel(s) at ${currentValues}/ml`, changes },
    };
  }

  // ---- vendor_product (13.2.2/13.2.3 behavior, unchanged) ----
  const match = matchApprovedRecord(item, context.vendorProducts);

  if (item.policy === "do_not_update") {
    return { ...none, row: { ...base, status: "do_not_update", matchedName: match.record?.name || null, currentSummary: vendorCurrentSummaryOf(match.record), changes: [] } };
  }
  if (item.policy === "manual_review") {
    return { ...none, row: { ...base, status: "manual_review", matchedName: match.record?.name || (match.hits.length ? `${match.hits.length} candidate(s)` : null), currentSummary: vendorCurrentSummaryOf(match.record), changes: [] } };
  }
  if (match.status === "ambiguous") {
    return { ...none, row: { ...base, status: "ambiguous", matchedName: match.hits.map((hit) => hit.name).join(" | "), currentSummary: "multiple candidates", changes: [] } };
  }
  if (match.status === "missing" || !match.record) {
    if (item.creation) {
      const changes = [
        `create VendorProduct "${item.creation.name}" (${item.creation.productType}, vendor: ${item.creation.vendor}, sku: ${item.creation.vendorSku})`,
        ...(item.kind === "tiered" && item.tiers ? [`create ${item.tiers.length} tier row(s)`] : [`flat cost ${money(item.flatCost || 0)} (no tier rows)`]),
        ...(item.marker ? ["add verified marker to notes"] : []),
      ];
      return { ...none, row: { ...base, status: "will_create", matchedName: null, currentSummary: "no record", changes } };
    }
    return { ...none, row: { ...base, status: "missing_record", matchedName: null, currentSummary: "no record", changes: [] } };
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
      return { ...none, row: { ...base, status: "manual_review", matchedName: record.name, currentSummary: vendorCurrentSummaryOf(record), changes: [], note: `${base.note ? `${base.note} ` : ""}Approved as flat but the record has ${record.tiers.length} tiers — owner must confirm before flattening.` } };
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
    ...none,
    row: { ...base, status, matchedName: record.name, currentSummary: vendorCurrentSummaryOf(record), changes },
    record: status === "will_update" ? record : null,
  };
}

async function loadContext(dbClient: any, shop: string): Promise<EvalContext> {
  const [vendorProducts, materials, machines] = await Promise.all([
    dbClient.vendorProduct.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, vendor: true, vendorSku: true, defaultUnitCost: true, notes: true,
        tiers: { select: { id: true, minQty: true, maxQty: true, unitCost: true }, orderBy: { minQty: "asc" } },
      },
      take: 300,
    }),
    dbClient.material.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, materialType: true, sku: true, notes: true,
        costPerUnit: true, calculatedUnitCost: true, purchaseCost: true, purchaseUnit: true,
        rollWidthIn: true, rollLengthFt: true, volumeMl: true, baseUnit: true, unit: true,
      },
      take: 300,
    }),
    dbClient.machine.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true,
        inkChannels: { select: { id: true, slotNumber: true, inkName: true, inkType: true, enabled: true, costPerMl: true, cartridgeCost: true, cartridgeMl: true } },
      },
      take: 50,
    }),
  ]);
  return { vendorProducts, materials, machines };
}

export async function previewApprovedCostUpdates(dbClient: any, shop: string): Promise<ApprovedPreviewRow[]> {
  const context = await loadContext(dbClient, shop);
  return APPROVED_COST_TRUTH.map((item) => evaluateApprovedItem(item, context).row);
}

// Applies ONLY rows the server itself re-evaluates as will_update/will_create.
// One transaction; scoped strictly to the matched records.
export async function applyApprovedCostUpdates(dbClient: any, shop: string) {
  const context = await loadContext(dbClient, shop);
  const evaluated = APPROVED_COST_TRUTH.map((item) => ({ item, ...evaluateApprovedItem(item, context) }));
  const actionable = evaluated.filter((entry) => entry.row.status === "will_update" || entry.row.status === "will_create");

  await dbClient.$transaction(async (tx: any) => {
    for (const entry of actionable) {
      const { item, row, record, materialRecord, materialGroup, channelGroup } = entry;

      // Vendor product update (13.2.2)
      if (item.target === "vendor_product" && row.status === "will_update" && record) {
        const marker = item.marker && !hasVerifiedMarker(record.notes) ? item.marker : null;
        const notes = marker ? `${record.notes ? `${record.notes}\n` : ""}${marker}` : undefined;
        if (item.kind === "tiered" && item.tiers) {
          await tx.vendorProductTier.deleteMany({ where: { shop, vendorProductId: record.id } });
          await tx.vendorProductTier.createMany({
            data: item.tiers.map((tier) => ({ shop, vendorProductId: record.id, minQty: tier.minQty, maxQty: tier.maxQty, unitCost: tier.unitCost, notes: "Owner-approved 2026-07-17" })),
          });
          await tx.vendorProduct.update({ where: { id: record.id }, data: { defaultUnitCost: item.tiers[0].unitCost, ...(notes ? { notes } : {}) } });
        } else if (item.kind === "flat" && item.flatCost != null) {
          if (record.tiers.length === 1) {
            await tx.vendorProductTier.update({ where: { id: record.tiers[0].id }, data: { unitCost: item.flatCost, notes: "Owner-approved 2026-07-17" } });
          }
          await tx.vendorProduct.update({ where: { id: record.id }, data: { defaultUnitCost: item.flatCost, ...(notes ? { notes } : {}) } });
        }
      }

      // Vendor product creation (13.2.3)
      if (item.target === "vendor_product" && row.status === "will_create" && item.creation) {
        const flatDefault = item.kind === "tiered" && item.tiers ? item.tiers[0].unitCost : item.flatCost || 0;
        await tx.vendorProduct.create({
          data: {
            shop, name: item.creation.name, productType: item.creation.productType, vendor: item.creation.vendor,
            vendorSku: item.creation.vendorSku, moq: 1, defaultUnitCost: flatDefault, active: true,
            notes: `Created by Approved Cost Updates (13.2.3).${item.marker ? `\n${item.marker}` : ""}`,
            ...(item.kind === "tiered" && item.tiers
              ? { tiers: { create: item.tiers.map((tier) => ({ shop, minQty: tier.minQty, maxQty: tier.maxQty, unitCost: tier.unitCost, notes: "Owner-approved 2026-07-17" })) } }
              : {}),
          },
        });
      }

      // Material update (13.2.4): purchase details + derived unit cost (raw
      // cost only, no waste), Materials-page convention costPerUnit ===
      // calculatedUnitCost, marker appended, cost-history row for the trail.
      if (item.target === "material" && row.status === "will_update" && materialRecord && item.material) {
        const oldCost = materialCurrentCost(materialRecord);
        const marker = item.marker && !hasVerifiedMarker(materialRecord.notes) ? item.marker : null;
        await tx.material.update({
          where: { id: materialRecord.id },
          data: {
            purchaseCost: item.material.purchase.cost,
            purchaseUnit: "roll",
            ...(item.material.purchase.rollWidthIn ? { rollWidthIn: item.material.purchase.rollWidthIn } : {}),
            ...(item.material.purchase.rollLengthFt ? { rollLengthFt: item.material.purchase.rollLengthFt } : {}),
            calculatedUnitCost: item.material.approvedUnitCost,
            costPerUnit: item.material.approvedUnitCost,
            costReviewNeeded: false,
            ...(marker ? { notes: `${materialRecord.notes ? `${materialRecord.notes}\n` : ""}${marker}` } : {}),
          },
        });
        await tx.materialCostHistory.create({
          data: { shop, materialId: materialRecord.id, oldCost, newCost: item.material.approvedUnitCost, reason: "Owner-approved roll cost (13.2.4)", changedBy: "Approved Cost Updates" },
        });
      }

      // Material creation (13.2.4, Banner Vinyl only)
      if (item.target === "material" && row.status === "will_create" && item.material?.creation) {
        const spec = item.material.creation;
        await tx.material.create({
          data: {
            shop, name: spec.name, materialType: spec.materialType, unit: spec.unit, baseUnit: spec.baseUnit,
            purchaseUnit: spec.purchaseUnit, purchaseCost: item.material.purchase.cost,
            rollWidthIn: item.material.purchase.rollWidthIn || null, rollLengthFt: item.material.purchase.rollLengthFt || null,
            calculatedUnitCost: item.material.approvedUnitCost, costPerUnit: item.material.approvedUnitCost,
            vendor: spec.vendor, useInRecipes: true, costReviewNeeded: false, active: true,
            notes: `Created by Approved Cost Updates (13.2.4).${item.marker ? `\n${item.marker}` : ""}`,
          },
        });
      }

      // Ink material group (13.2.4)
      if (item.target === "material_group" && row.status === "will_update" && item.material) {
        for (const inkMaterial of materialGroup) {
          const oldCost = materialCurrentCost(inkMaterial);
          const marker = item.marker && !hasVerifiedMarker(inkMaterial.notes) ? item.marker : null;
          await tx.material.update({
            where: { id: inkMaterial.id },
            data: {
              purchaseCost: item.material.purchase.cost,
              volumeMl: item.material.purchase.volumeMl || null,
              calculatedUnitCost: item.material.approvedUnitCost,
              costPerUnit: item.material.approvedUnitCost,
              costReviewNeeded: false,
              ...(marker ? { notes: `${inkMaterial.notes ? `${inkMaterial.notes}\n` : ""}${marker}` } : {}),
            },
          });
          await tx.materialCostHistory.create({
            data: { shop, materialId: inkMaterial.id, oldCost, newCost: item.material.approvedUnitCost, reason: "Owner-approved ink cost (13.2.4)", changedBy: "Approved Cost Updates" },
          });
        }
      }

      // Machine ink channels (13.2.4)
      if (item.target === "ink_channels" && row.status === "will_update" && item.inkChannels) {
        for (const group of channelGroup) {
          for (const channel of group.channels) {
            await tx.machineInkChannel.update({
              where: { id: channel.id },
              data: { costPerMl: item.inkChannels.approvedCostPerMl, cartridgeCost: item.inkChannels.cartridgeCost, cartridgeMl: item.inkChannels.cartridgeMl },
            });
          }
        }
      }
    }
  });

  return {
    applied: actionable.map((entry) => ({ key: entry.row.key, label: entry.row.label, status: entry.row.status, changes: entry.row.changes })),
    skipped: evaluated.filter((entry) => entry.row.status !== "will_update" && entry.row.status !== "will_create").map((entry) => ({ key: entry.row.key, status: entry.row.status })),
  };
}
