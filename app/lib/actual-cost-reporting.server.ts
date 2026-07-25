// Actual-cost reporting + pricing feedback (Patch 15E.2). Pure server module
// — no Prisma, no JSX math. FINALIZED-ONLY policy: profitability totals come
// exclusively from finalized jobs (server columns + the immutable 15E.1
// finalize-event snapshot); unfinalized jobs may only appear in a clearly
// labeled "open jobs" section. Nothing here mutates data, and pricing is
// NEVER updated automatically — feedback is owner-review evidence only.

import { cleanCommercialName } from "./commercial-name-resolver.server";
import { familyFromQuoteItems } from "./production-job-source.server";
import { dtpHardFloorPct } from "./dtp-owner-pricing.server";

// ---------- leakage thresholds (centralized, owner-documented) ----------
export const LEAKAGE_THRESHOLDS = {
  marginTargetPct: 40, // global warning target
  marginVsEstimateDropPts: 5,
  costOverEstimatePct: 10,
  freightOverEstimatePct: 20,
  vendorInvoiceOverEstimatePct: 5,
  materialWastePct: 12, // owner threshold until configured elsewhere
  reprintPctOfRevenue: 2,
} as const;

// Family hard floors for leakage flags (documented approximation: premium
// jars use the Chiron 40 minimum — Miron's 45 needs per-class detail the job
// row does not carry; DTP floors are quantity-banded).
export const FAMILY_FLOOR_PCTS: Record<string, number> = {
  "sticker-bags": 45,
  "standard-jars": 40,
  "premium-jars": 40,
  "stickers-labels": 40,
  banners: 40,
  "dtp-bags": -1, // resolved per quantity via dtpHardFloorPct
  default: 40,
};

export function familyFloorPct(family: string, quantity: number): number {
  if (family === "dtp-bags") return dtpHardFloorPct(quantity);
  return FAMILY_FLOOR_PCTS[family] ?? FAMILY_FLOOR_PCTS.default;
}

export const QUANTITY_BANDS = [
  { key: "1-99", min: 1, max: 99 },
  { key: "100-249", min: 100, max: 249 },
  { key: "250-499", min: 250, max: 499 },
  { key: "500-999", min: 500, max: 999 },
  { key: "1000-2499", min: 1000, max: 2499 },
  { key: "2500-4999", min: 2500, max: 4999 },
  { key: "5000-7499", min: 5000, max: 7499 },
  { key: "7500+", min: 7500, max: null as number | null },
];

export function quantityBand(quantity: number): string {
  const band = QUANTITY_BANDS.find((row) => quantity >= row.min && (row.max == null || quantity <= row.max));
  return band ? band.key : "1-99";
}

function parseJson(value: any) {
  try {
    return JSON.parse(String(value ?? "null"));
  } catch {
    return null;
  }
}

function normalizeKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9@.]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------- normalization (A/P) ----------
export type FinalizedJobRow = {
  jobId: string;
  jobTicket: string;
  finalizedAt: string | null;
  finalizedBy: string;
  legacyFinal: boolean; // finalized before 15E.1 — no finalize-event snapshot
  gateStatus: string;
  warningReasons: string[];
  finalizeReason: string | null;
  reopenCount: number;
  family: string;
  productKey: string;
  productLabel: string;
  vendor: string | null;
  customerKey: string;
  customerLabel: string;
  quantity: number;
  sourceQuoteId: string | null;
  estimatedRevenue: number;
  estimatedCost: number;
  estimatedProfit: number;
  estimatedMarginPct: number | null;
  finalRevenue: number;
  finalCost: number;
  finalProfit: number;
  finalMarginPct: number;
  varianceDollars: number;
  variancePct: number | null;
  marginVariancePts: number | null;
  laborCost: number;
  laborMinutes: number;
  laborOverrideUsed: boolean;
  laborZeroConfirmed: boolean;
  estimatedLaborCost: number;
  reprintCost: number;
  packingCost: number;
  shippingCost: number;
  outsourceCost: number;
  otherCost: number;
  materialCost: number;
  materialUsedQty: number;
  materialWasteQty: number;
  materialReprintQty: number;
  materialDeductedQty: number;
  dtp: {
    sku: string | null;
    estimatedVendorSubtotal: number | null;
    estimatedFreight: number;
    actualInvoiceSubtotal: number | null;
    actualFreight: number | null;
    credit: number | null;
    ownerTierUsed: number | null;
    customPriceUsed: boolean;
    overrideUsed: boolean;
    targetMarginPct: number | null;
    extraDesignFees: number | null;
  } | null;
};

// Pull the 15E.1 snapshot from the finalize event message ("… SNAPSHOT {json}")
export function parseFinalizeSnapshotFromEvents(events: Array<{ eventType: string; message: string }>): any | null {
  const finalizeEvents = (events || []).filter((event) => event.eventType === "actual_cost_finalized");
  const latest = finalizeEvents[finalizeEvents.length - 1];
  if (!latest) return null;
  const marker = latest.message.indexOf("SNAPSHOT ");
  if (marker < 0) return null;
  return parseJson(latest.message.slice(marker + "SNAPSHOT ".length));
}

export function normalizeFinalizedJobActuals(job: any): FinalizedJobRow | null {
  if (!job?.actualCostFinalized) return null; // finalized-only policy
  const items = job.items || [];
  const events = job.events || [];
  const snapshot = parseFinalizeSnapshotFromEvents(events);
  const reopenCount = events.filter((event: any) => event.eventType === "actual_cost_reopened").length;
  const family = familyFromQuoteItems(items);
  const quantity = items.reduce((sum: number, item: any) => sum + (Number(item.quantity) || 0), 0);
  const estimatedRevenue = items.reduce((sum: number, item: any) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), 0);
  const estimatedCost = items.reduce((sum: number, item: any) => sum + (Number(item.quantity) || 0) * (Number(item.unitCost) || 0), 0);
  const finalRevenue = snapshot?.revenue ?? estimatedRevenue;
  const finalCost = Number(job.actualTotalCost || 0);
  const finalProfit = Number(job.actualFinalProfit ?? finalRevenue - finalCost);
  const finalMarginPct = Number(job.actualFinalMargin ?? (finalRevenue > 0 ? (finalProfit / finalRevenue) * 100 : 0));
  const estimatedMarginPct = estimatedRevenue > 0 ? ((estimatedRevenue - estimatedCost) / estimatedRevenue) * 100 : null;
  // product identity precedence (E): vendor sku (snapshot selections) ->
  // recipe -> profile -> clean name. DTP skus keep 4x5x2 / 5x4x2 distinct.
  const firstItem = items[0] || {};
  const costSnapshot = parseJson(firstItem.costSnapshot);
  const breakdown = costSnapshot?.productBreakdown || null;
  const dtpPricing = breakdown?.dtpPricing || null;
  const dtpBlock = breakdown?.dtp || null;
  const selectionBlank = String(breakdown?.selections?.blank || "");
  const productKey =
    (selectionBlank && selectionBlank !== "custom" && selectionBlank !== "none" ? selectionBlank : "")
    || (firstItem.recipeId ? `recipe:${firstItem.recipeId}` : "")
    || (firstItem.sku ? `sku:${normalizeKey(firstItem.sku)}` : "")
    || `name:${normalizeKey(cleanCommercialName(firstItem.productTitle || firstItem.productName) || "custom")}`;
  const productLabel = cleanCommercialName(firstItem.productTitle || firstItem.productName) || "Custom Quote";
  const customerEmail = normalizeKey(job.email || "");
  const customerCompany = normalizeKey(job.company || "");
  const customerName = normalizeKey(job.customerName || "");
  const customerKey = customerEmail ? `email:${customerEmail}` : customerCompany ? `company:${customerCompany}` : customerName ? `name:${customerName}` : "unknown";
  const customerLabel = job.company || job.customerName || job.email || "Unknown customer";
  const usages = (job.materialUsages || []).filter((usage: any) => String(usage.source || "") !== "print_log");
  const materialCost = usages.reduce((sum: number, usage: any) => sum + Number(usage.totalCost || 0), 0);
  const enteredDtp = snapshot?.enteredInputs?.dtp || null;
  const estimatedLabor = (() => {
    const lines = breakdown?.lines || [];
    return lines
      .filter((line: any) => ["art_setup", "print_setup", "application", "weeding", "packing"].includes(String(line.key)))
      .reduce((sum: number, line: any) => sum + Number(line.amount || 0), 0);
  })();
  return {
    jobId: job.id,
    jobTicket: job.jobTicket || job.id,
    finalizedAt: job.actualCostFinalizedAt ? new Date(job.actualCostFinalizedAt).toISOString() : null,
    finalizedBy: job.actualCostFinalizedBy || "unknown",
    legacyFinal: !snapshot,
    gateStatus: snapshot?.gateStatus || "LEGACY",
    warningReasons: snapshot?.warningReasons || [],
    finalizeReason: snapshot?.finalizeReason || null,
    reopenCount,
    family,
    productKey,
    productLabel,
    vendor: family === "dtp-bags" ? "Spektra" : null,
    customerKey,
    customerLabel,
    quantity,
    sourceQuoteId: job.quoteId && !String(job.quoteId).startsWith("manual_") ? job.quoteId : null,
    estimatedRevenue,
    estimatedCost,
    estimatedProfit: estimatedRevenue - estimatedCost,
    estimatedMarginPct,
    finalRevenue,
    finalCost,
    finalProfit,
    finalMarginPct,
    varianceDollars: finalCost - estimatedCost,
    variancePct: estimatedCost > 0 ? ((finalCost - estimatedCost) / estimatedCost) * 100 : null,
    marginVariancePts: estimatedMarginPct != null ? finalMarginPct - estimatedMarginPct : null,
    laborCost: Number(snapshot?.components?.laborCost ?? job.actualLaborCost ?? 0),
    laborMinutes: Number(snapshot?.enteredInputs?.laborMinutes ?? job.actualLaborMinutes ?? 0),
    laborOverrideUsed: snapshot?.components?.laborBasis === "override",
    laborZeroConfirmed: snapshot?.components?.laborBasis === "confirmed_zero",
    estimatedLaborCost: estimatedLabor,
    reprintCost: Number(job.actualReprintCost || 0),
    packingCost: Number(job.actualPackingCost || 0),
    shippingCost: Number(job.actualShippingCost || 0),
    outsourceCost: Number(job.actualOutsourceCost || 0),
    otherCost: Number(job.actualOtherCost || 0),
    materialCost,
    materialUsedQty: usages.reduce((sum: number, usage: any) => sum + Number(usage.usedQty || 0), 0),
    materialWasteQty: usages.reduce((sum: number, usage: any) => sum + Number(usage.wasteQty || 0), 0),
    materialReprintQty: usages.reduce((sum: number, usage: any) => sum + Number(usage.reprintQty || 0), 0),
    materialDeductedQty: usages.reduce((sum: number, usage: any) => sum + Number(usage.stockDeductedQty || 0), 0),
    dtp: family === "dtp-bags" ? {
      sku: selectionBlank || dtpBlock?.size || null,
      estimatedVendorSubtotal: dtpBlock?.vendorSubtotal ?? null,
      estimatedFreight: Number(dtpBlock?.freight ?? 85),
      actualInvoiceSubtotal: enteredDtp?.invoiceSubtotal ?? (job.actualOutsourceCost > 0 ? Number(job.actualOutsourceCost) : null),
      actualFreight: enteredDtp?.freight ?? (job.actualShippingCost > 0 ? Number(job.actualShippingCost) : null),
      credit: enteredDtp?.credit ?? null,
      ownerTierUsed: dtpPricing?.ownerPriceTierUsed ?? null,
      customPriceUsed: dtpPricing?.customUnitPrice != null,
      overrideUsed: Boolean(dtpPricing?.overrideRequired),
      targetMarginPct: dtpPricing?.marginWarningTargetPct ?? 40,
      extraDesignFees: dtpPricing?.extraDesignFees ?? null,
    } : null,
  };
}

// ---------- variance + leakage (C/K) ----------
export function computeJobVariance(row: FinalizedJobRow) {
  return { varianceDollars: row.varianceDollars, variancePct: row.variancePct, marginVariancePts: row.marginVariancePts };
}

export function detectMarginLeakage(row: FinalizedJobRow): string[] {
  const flags: string[] = [];
  const floor = familyFloorPct(row.family, row.quantity);
  if (row.finalMarginPct < LEAKAGE_THRESHOLDS.marginTargetPct) flags.push(`Below ${LEAKAGE_THRESHOLDS.marginTargetPct}% target (${row.finalMarginPct.toFixed(1)}%)`);
  if (row.finalMarginPct < floor) flags.push(`BELOW FAMILY FLOOR ${floor}% (${row.finalMarginPct.toFixed(1)}%)`);
  if (row.marginVariancePts != null && row.marginVariancePts <= -LEAKAGE_THRESHOLDS.marginVsEstimateDropPts) flags.push(`Margin ${Math.abs(row.marginVariancePts).toFixed(1)} pts below estimate`);
  if (row.variancePct != null && row.variancePct >= LEAKAGE_THRESHOLDS.costOverEstimatePct) flags.push(`Cost ${row.variancePct.toFixed(1)}% over estimate`);
  if (row.dtp) {
    const { estimatedFreight, actualFreight, estimatedVendorSubtotal, actualInvoiceSubtotal } = row.dtp;
    if (actualFreight != null && estimatedFreight > 0 && ((actualFreight - estimatedFreight) / estimatedFreight) * 100 >= LEAKAGE_THRESHOLDS.freightOverEstimatePct) {
      flags.push(`Freight ${(((actualFreight - estimatedFreight) / estimatedFreight) * 100).toFixed(0)}% over the $${estimatedFreight.toFixed(0)} estimate`);
    }
    if (actualInvoiceSubtotal != null && estimatedVendorSubtotal != null && estimatedVendorSubtotal > 0 && ((actualInvoiceSubtotal - estimatedVendorSubtotal) / estimatedVendorSubtotal) * 100 >= LEAKAGE_THRESHOLDS.vendorInvoiceOverEstimatePct) {
      flags.push(`Vendor invoice ${(((actualInvoiceSubtotal - estimatedVendorSubtotal) / estimatedVendorSubtotal) * 100).toFixed(1)}% over estimate`);
    }
  }
  if (row.materialUsedQty > 0 && (row.materialWasteQty / row.materialUsedQty) * 100 > LEAKAGE_THRESHOLDS.materialWastePct) {
    flags.push(`Material waste ${((row.materialWasteQty / row.materialUsedQty) * 100).toFixed(1)}% above ${LEAKAGE_THRESHOLDS.materialWastePct}% threshold`);
  }
  if (row.finalRevenue > 0 && (row.reprintCost / row.finalRevenue) * 100 > LEAKAGE_THRESHOLDS.reprintPctOfRevenue) {
    flags.push(`Reprint cost ${((row.reprintCost / row.finalRevenue) * 100).toFixed(1)}% of revenue`);
  }
  if (row.gateStatus === "WARNING") flags.push("Finalized with warning reason");
  if (row.reopenCount > 0) flags.push(`Reopened ${row.reopenCount}x after finalization`);
  return flags;
}

// ---------- aggregation (D/E/F/G) ----------
export type AggregateRow = {
  key: string;
  label: string;
  jobs: number;
  units: number;
  revenue: number;
  estimatedCost: number;
  actualCost: number;
  profit: number;
  weightedMarginPct: number; // Σprofit / Σrevenue — the KPI (never an average of percentages)
  averageMarginPct: number;
  varianceDollars: number;
  variancePct: number | null;
  belowTargetJobs: number;
  belowFloorJobs: number;
  warningJobs: number;
  reopenedJobs: number;
  reprintCost: number;
  materialWasteCost: number;
  laborVarianceDollars: number;
  freightVarianceDollars: number;
  vendorVarianceDollars: number;
  extra: Record<string, number>;
};

function aggregate(rows: FinalizedJobRow[], keyOf: (row: FinalizedJobRow) => string, labelOf: (row: FinalizedJobRow) => string): AggregateRow[] {
  const groups = new Map<string, FinalizedJobRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.entries()].map(([key, groupRows]) => {
    const revenue = groupRows.reduce((sum, row) => sum + row.finalRevenue, 0);
    const actualCost = groupRows.reduce((sum, row) => sum + row.finalCost, 0);
    const estimatedCost = groupRows.reduce((sum, row) => sum + row.estimatedCost, 0);
    const profit = groupRows.reduce((sum, row) => sum + row.finalProfit, 0);
    const wasteCost = groupRows.reduce((sum, row) => sum + (row.materialUsedQty > 0 ? row.materialCost * (row.materialWasteQty / Math.max(1e-9, row.materialUsedQty + row.materialWasteQty + row.materialReprintQty)) : 0), 0);
    return {
      key,
      label: labelOf(groupRows[0]),
      jobs: groupRows.length,
      units: groupRows.reduce((sum, row) => sum + row.quantity, 0),
      revenue,
      estimatedCost,
      actualCost,
      profit,
      weightedMarginPct: revenue > 0 ? (profit / revenue) * 100 : 0,
      averageMarginPct: groupRows.reduce((sum, row) => sum + row.finalMarginPct, 0) / groupRows.length,
      varianceDollars: actualCost - estimatedCost,
      variancePct: estimatedCost > 0 ? ((actualCost - estimatedCost) / estimatedCost) * 100 : null,
      belowTargetJobs: groupRows.filter((row) => row.finalMarginPct < LEAKAGE_THRESHOLDS.marginTargetPct).length,
      belowFloorJobs: groupRows.filter((row) => row.finalMarginPct < familyFloorPct(row.family, row.quantity)).length,
      warningJobs: groupRows.filter((row) => row.gateStatus === "WARNING").length,
      reopenedJobs: groupRows.filter((row) => row.reopenCount > 0).length,
      reprintCost: groupRows.reduce((sum, row) => sum + row.reprintCost, 0),
      materialWasteCost: wasteCost,
      laborVarianceDollars: groupRows.reduce((sum, row) => sum + (row.laborCost - row.estimatedLaborCost), 0),
      freightVarianceDollars: groupRows.reduce((sum, row) => sum + (row.dtp && row.dtp.actualFreight != null ? row.dtp.actualFreight - row.dtp.estimatedFreight : 0), 0),
      vendorVarianceDollars: groupRows.reduce((sum, row) => sum + (row.dtp && row.dtp.actualInvoiceSubtotal != null && row.dtp.estimatedVendorSubtotal != null ? row.dtp.actualInvoiceSubtotal - row.dtp.estimatedVendorSubtotal : 0), 0),
      extra: {},
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

export const aggregateByFamily = (rows: FinalizedJobRow[]) => aggregate(rows, (row) => row.family, (row) => row.family);
export const aggregateByProduct = (rows: FinalizedJobRow[]) => aggregate(rows, (row) => row.productKey, (row) => row.productLabel);
export const aggregateByCustomer = (rows: FinalizedJobRow[]) => aggregate(rows, (row) => row.customerKey, (row) => row.customerLabel);
export const aggregateByVendor = (rows: FinalizedJobRow[]) => aggregate(rows.filter((row) => row.vendor), (row) => `${row.vendor}:${row.productKey}`, (row) => `${row.vendor} — ${row.productLabel}`);
export const aggregateByQuantityBand = (rows: FinalizedJobRow[]) => aggregate(rows, (row) => quantityBand(row.quantity), (row) => quantityBand(row.quantity));

// ---------- pricing feedback (L) — evidence only, never a write ----------
export type PricingFeedbackSuggestion = {
  id: string;
  type: string;
  family: string;
  productKey: string;
  quantityBand: string;
  message: string;
  currentStandard: string;
  actualObserved: string;
  jobCount: number;
  dateRange: string;
  variancePct: number | null;
  projectedEffect: string;
  confidence: "low" | "medium" | "high";
  supportingJobs: string[]; // job tickets
};

const MIN_EVIDENCE_JOBS = 3;

export function buildPricingFeedbackSuggestions(rows: FinalizedJobRow[]): PricingFeedbackSuggestion[] {
  const suggestions: PricingFeedbackSuggestion[] = [];
  const groups = new Map<string, FinalizedJobRow[]>();
  for (const row of rows) {
    const key = `${row.family}|${row.productKey}|${quantityBand(row.quantity)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  for (const [key, groupRows] of groups) {
    if (groupRows.length < MIN_EVIDENCE_JOBS) continue; // insufficient evidence — no recommendation
    const [family, productKey, band] = key.split("|");
    const confidence: PricingFeedbackSuggestion["confidence"] = groupRows.length >= 5 ? "high" : "medium";
    const tickets = groupRows.map((row) => row.jobTicket);
    const dates = groupRows.map((row) => row.finalizedAt || "").filter(Boolean).sort();
    const dateRange = dates.length ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}` : "n/a";
    const push = (type: string, message: string, currentStandard: string, actualObserved: string, variancePct: number | null, projectedEffect: string) =>
      suggestions.push({ id: `${type}:${key}`.replace(/[^a-zA-Z0-9:|_.-]+/g, "-"), type, family, productKey, quantityBand: band, message, currentStandard, actualObserved, jobCount: groupRows.length, dateRange, variancePct, projectedEffect, confidence, supportingJobs: tickets });

    const withVariance = groupRows.filter((row) => row.variancePct != null);
    if (withVariance.length >= MIN_EVIDENCE_JOBS) {
      const avgVariance = withVariance.reduce((sum, row) => sum + (row.variancePct as number), 0) / withVariance.length;
      if (avgVariance >= LEAKAGE_THRESHOLDS.costOverEstimatePct) {
        push("cost-understated", `Estimated cost appears understated for ${family} / ${band}`, "current calculator estimate basis", `actual cost averages ${avgVariance.toFixed(1)}% over estimate`, avgVariance, "review waste/labor/vendor standards in Product Setup / owner standards");
      }
    }
    const dtpRows = groupRows.filter((row) => row.dtp);
    const invoiceRows = dtpRows.filter((row) => row.dtp!.actualInvoiceSubtotal != null && row.dtp!.estimatedVendorSubtotal != null && row.dtp!.estimatedVendorSubtotal! > 0);
    if (invoiceRows.length >= MIN_EVIDENCE_JOBS) {
      const avg = invoiceRows.reduce((sum, row) => sum + ((row.dtp!.actualInvoiceSubtotal! - row.dtp!.estimatedVendorSubtotal!) / row.dtp!.estimatedVendorSubtotal!) * 100, 0) / invoiceRows.length;
      if (Math.abs(avg) >= LEAKAGE_THRESHOLDS.vendorInvoiceOverEstimatePct) {
        push("vendor-cost", `Spektra invoice runs ${avg.toFixed(1)}% ${avg > 0 ? "over" : "under"} the vendor tier for ${productKey} / ${band}`, "Vendor Cost Book tier", `invoices average ${avg.toFixed(1)}% ${avg > 0 ? "above" : "below"} tier`, avg, "review the VendorProduct tier in the Vendor Cost Book");
      }
    }
    const freightRows = dtpRows.filter((row) => row.dtp!.actualFreight != null);
    if (freightRows.length >= MIN_EVIDENCE_JOBS) {
      const avgFreight = freightRows.reduce((sum, row) => sum + (row.dtp!.actualFreight as number), 0) / freightRows.length;
      if (avgFreight > 85 * (1 + LEAKAGE_THRESHOLDS.freightOverEstimatePct / 100)) {
        push("freight-allowance", `Actual Spektra freight averages $${avgFreight.toFixed(2)} vs the $85 assumption`, "$85 flat per PO", `$${avgFreight.toFixed(2)} average actual`, ((avgFreight - 85) / 85) * 100, "review SPEKTRA_FREIGHT_PER_PO / DTP price ladder");
      }
    }
    const revenue = groupRows.reduce((sum, row) => sum + row.finalRevenue, 0);
    const profit = groupRows.reduce((sum, row) => sum + row.finalProfit, 0);
    const weighted = revenue > 0 ? (profit / revenue) * 100 : 0;
    const target = family === "dtp-bags" ? 40 : LEAKAGE_THRESHOLDS.marginTargetPct;
    if (weighted < target - LEAKAGE_THRESHOLDS.marginVsEstimateDropPts) {
      push("price-below-target", `Weighted actual margin ${weighted.toFixed(1)}% is well below the ${target}% target for ${family} / ${band}`, `${target}% target margin`, `${weighted.toFixed(1)}% weighted actual`, weighted - target, family === "dtp-bags" ? "review the DTP owner price ladder" : "review family pricing/curve inputs");
    }
  }
  return suggestions;
}

// ---------- CSV (O) ----------
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (value: string | number | null) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n");
}
