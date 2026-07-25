// Governed actual-cost finalization (Patch 15E.1). Pure — no Prisma, no
// network. The production route computes THROUGH this module for the gate,
// the final formulas, the variance, and the finalize snapshot; the action
// re-fetches and recomputes server-side (posted totals are never authoritative).
//
// Zero-versus-missing: inputs arrive as number|null — BLANK means "not
// entered" (null) and is NEVER coerced to an authoritative $0; an explicit $0
// needs its confirmation (labor checkbox / typed 0 on optional dollar fields
// is accepted as entered-zero). DB columns keep their numeric defaults; the
// snapshot records the entered/confirmed state.

export const REOPEN_PHRASE = "OWNER COST REOPEN"; // exact, case-sensitive

export type FinalizeStatus = "READY" | "WARNING" | "BLOCKED";

export type DtpActualEntry = {
  invoiceSubtotal: number | null;
  additionalCharges: number | null;
  credit: number | null;
  freight: number | null;
  invoiceIncludesFreight: boolean;
};

export type FinalizeInputs = {
  laborMinutes: number | null;
  laborRate: number | null;
  laborCostOverride: number | null;
  laborZeroConfirmed: boolean;
  packingCost: number | null;
  shippingCost: number | null; // non-DTP general shipping (DTP shipping comes from the freight entry)
  outsourceCost: number | null; // non-DTP general outsource
  reprintCost: number | null;
  otherCost: number | null;
  dtp: DtpActualEntry | null;
  warningReason: string;
};

export type ActualSourceSummary = {
  printLogRecordedCost: number; // guarded-writeback rows (source print_log)
  previewPrintCost: number; // live preview — estimate-grade, never silently final
  materialCost: number; // manual usage rows
  materialRowCount: number;
  deductedQty: number;
  usedQty: number;
  wasteQty: number;
  reprintQty: number;
  pulledQty: number;
};

// Estimate expectations parsed from the write-once item snapshots (read-only).
export function estimateExpectations(items: any[]): { estimatedTotalCost: number; hadMaterialLines: boolean; hadPrintLines: boolean } {
  let estimatedTotalCost = 0;
  let hadMaterialLines = false;
  let hadPrintLines = false;
  for (const item of items || []) {
    estimatedTotalCost += (Number(item.quantity) || 0) * (Number(item.unitCost) || 0);
    try {
      const snapshot = JSON.parse(String(item.costSnapshot || "null"));
      const lines = snapshot?.productBreakdown?.lines || [];
      for (const line of lines) {
        if (line.key === "material" && Number(line.amount) > 0) hadMaterialLines = true;
        if ((String(line.key || "").startsWith("ink_") || line.key === "machine") && Number(line.amount) > 0) hadPrintLines = true;
      }
    } catch {
      // legacy/manual snapshots — no structured expectations
    }
  }
  return { estimatedTotalCost, hadMaterialLines, hadPrintLines };
}

// DTP invoice/freight normalization (15E.1-E): counted ONCE, never twice.
//   actualOutsourceCost = subtotal (minus freight when the invoice includes
//   it) + additional charges − credit;  actualShippingCost = actual freight.
export function normalizeDtpOutsource(entry: DtpActualEntry): {
  outsourceCost: number;
  shippingCost: number;
  note: string;
  invalid: string | null;
  invoiceEntered: boolean;
  freightEntered: boolean;
} {
  const subtotal = entry.invoiceSubtotal ?? 0;
  const additional = entry.additionalCharges ?? 0;
  const credit = entry.credit ?? 0;
  const freight = entry.freight ?? 0;
  const invoiceEntered = entry.invoiceSubtotal != null;
  const freightEntered = entry.freight != null;
  let invalid: string | null = null;
  if (additional < 0 || freight < 0 || subtotal < 0) invalid = "Vendor amounts cannot be negative (use the credit field for reductions).";
  if (credit < 0) invalid = "Enter the credit as a positive amount — it is subtracted.";
  let vendorBase = subtotal;
  let note = "Invoice subtotal excludes freight; freight recorded separately.";
  if (entry.invoiceIncludesFreight) {
    if (freightEntered && freight > subtotal) invalid = invalid || "Invoice-includes-freight is set but the freight entered exceeds the invoice subtotal.";
    vendorBase = subtotal - (freightEntered ? freight : 0);
    note = "Invoice includes freight — freight backed OUT of vendor cost and counted once as shipping.";
  }
  const outsourceCost = vendorBase + additional - credit;
  if (outsourceCost < 0) invalid = invalid || "Credit exceeds the normalized vendor cost — vendor cost cannot be negative.";
  return { outsourceCost: Math.max(0, outsourceCost), shippingCost: freightEntered ? freight : 0, note, invalid, invoiceEntered, freightEntered };
}

export type FinalCostComponents = {
  printCost: number;
  printCostSource: "recorded" | "preview" | "none";
  materialCost: number;
  laborCost: number;
  laborBasis: "override" | "minutes_x_rate" | "confirmed_zero" | "not_entered";
  packingCost: number;
  shippingCost: number;
  outsourceCost: number;
  reprintCost: number;
  otherCost: number;
  dtpNormalization: ReturnType<typeof normalizeDtpOutsource> | null;
};

// Every component sums exactly once (15E.1-B): recorded print OR preview
// (never both), labor override REPLACES minutes×rate, DTP freight lives in
// shipping only.
export function computeFinalActualCost(input: {
  revenue: number;
  sources: ActualSourceSummary;
  inputs: FinalizeInputs;
}): { components: FinalCostComponents; totalCost: number; grossProfit: number; grossMarginPct: number } {
  const { sources, inputs } = input;
  const printCostSource: FinalCostComponents["printCostSource"] =
    sources.printLogRecordedCost > 0 ? "recorded" : sources.previewPrintCost > 0 ? "preview" : "none";
  const printCost = printCostSource === "recorded" ? sources.printLogRecordedCost : printCostSource === "preview" ? sources.previewPrintCost : 0;
  let laborCost = 0;
  let laborBasis: FinalCostComponents["laborBasis"] = "not_entered";
  if (inputs.laborCostOverride != null) {
    laborCost = inputs.laborCostOverride;
    laborBasis = "override";
  } else if ((inputs.laborMinutes ?? 0) > 0 && (inputs.laborRate ?? 0) > 0) {
    laborCost = ((inputs.laborMinutes as number) / 60) * (inputs.laborRate as number);
    laborBasis = "minutes_x_rate";
  } else if (inputs.laborZeroConfirmed) {
    laborBasis = "confirmed_zero";
  }
  const dtpNormalization = inputs.dtp ? normalizeDtpOutsource(inputs.dtp) : null;
  const outsourceCost = dtpNormalization ? dtpNormalization.outsourceCost : inputs.outsourceCost ?? 0;
  const shippingCost = dtpNormalization ? dtpNormalization.shippingCost : inputs.shippingCost ?? 0;
  const components: FinalCostComponents = {
    printCost,
    printCostSource,
    materialCost: sources.materialCost,
    laborCost,
    laborBasis,
    packingCost: inputs.packingCost ?? 0,
    shippingCost,
    outsourceCost,
    reprintCost: inputs.reprintCost ?? 0,
    otherCost: inputs.otherCost ?? 0,
    dtpNormalization,
  };
  const totalCost =
    components.printCost + components.materialCost + components.laborCost + components.packingCost +
    components.shippingCost + components.outsourceCost + components.reprintCost + components.otherCost;
  const grossProfit = input.revenue - totalCost;
  const grossMarginPct = input.revenue > 0 ? (grossProfit / input.revenue) * 100 : 0;
  return { components, totalCost, grossProfit, grossMarginPct };
}

// Variance vs the estimate. percent is NULL (unavailable) when the estimated
// total is not positive — never a fake 0%.
export function computeEstimateVariance(finalTotalCost: number, estimatedTotalCost: number): { varianceDollars: number; variancePct: number | null } {
  const varianceDollars = finalTotalCost - estimatedTotalCost;
  return { varianceDollars, variancePct: estimatedTotalCost > 0 ? (varianceDollars / estimatedTotalCost) * 100 : null };
}

const IN_HOUSE_PRINT_FAMILIES = new Set(["sticker-bags", "standard-jars", "premium-jars", "stickers-labels", "banners"]);

export type FinalizeAssessment = {
  status: FinalizeStatus;
  blockedReasons: string[];
  warningReasons: string[];
  requiresReason: boolean;
  components: FinalCostComponents;
  revenue: number;
  totalCost: number;
  grossProfit: number;
  grossMarginPct: number;
  estimatedTotalCost: number;
  varianceDollars: number;
  variancePct: number | null;
};

export function assessFinalization(input: {
  family: string; // familyFromQuoteItems result ("dtp-bags", "sticker-bags", …, "default")
  alreadyFinalized: boolean;
  revenue: number;
  estimate: { estimatedTotalCost: number; hadMaterialLines: boolean; hadPrintLines: boolean };
  sources: ActualSourceSummary;
  inputs: FinalizeInputs;
}): FinalizeAssessment {
  const blocked: string[] = [];
  const warnings: string[] = [];
  const { components, totalCost, grossProfit, grossMarginPct } = computeFinalActualCost({ revenue: input.revenue, sources: input.sources, inputs: input.inputs });
  const variance = computeEstimateVariance(totalCost, input.estimate.estimatedTotalCost);
  const isDtp = input.family === "dtp-bags";
  const isInHousePrint = IN_HOUSE_PRINT_FAMILIES.has(input.family);

  // BLOCKED
  if (input.alreadyFinalized) blocked.push("Job is already finalized — reopen it first (OWNER COST REOPEN).");
  if (input.revenue <= 0) blocked.push("Revenue is zero or negative — production items have no unit price.");
  for (const [label, value] of [
    ["labor", components.laborCost], ["packing", components.packingCost], ["shipping", components.shippingCost],
    ["outsource", components.outsourceCost], ["reprint", components.reprintCost], ["other", components.otherCost],
  ] as Array<[string, number]>) {
    if (value < 0) blocked.push(`Negative ${label} cost is not valid (credits belong in the DTP credit field).`);
  }
  if (totalCost < 0) blocked.push("Final total cost is negative.");
  if ((input.inputs.laborMinutes ?? 0) > 0 && input.inputs.laborCostOverride == null && (input.inputs.laborRate ?? 0) <= 0) {
    blocked.push("Labor minutes entered without a labor rate — enter the confirmed rate or a labor cost override.");
  }
  if (isDtp) {
    if (!input.inputs.dtp || !normalizeDtpOutsource(input.inputs.dtp).invoiceEntered) blocked.push("DTP job requires the Spektra vendor invoice subtotal before finalization.");
    const invalid = input.inputs.dtp ? normalizeDtpOutsource(input.inputs.dtp).invalid : null;
    if (invalid) blocked.push(`DTP invoice/freight entry invalid: ${invalid}`);
  }
  if (input.sources.deductedQty > 0 && input.sources.materialCost <= 0) {
    blocked.push("Inventory was deducted for this job but no costed material usage exists — reconcile the material rows first.");
  }

  // WARNING (finalize allowed only WITH a written reason)
  if (!isDtp) {
    if (components.printCostSource === "preview" && isInHousePrint) {
      warnings.push("Print cost is the LIVE PREVIEW — apply the guarded print-log writeback for recorded actuals, or finalize with a reason.");
    }
    if (components.printCostSource === "none" && isInHousePrint && input.estimate.hadPrintLines) {
      warnings.push("No print cost recorded for an in-house print job that estimated print/ink/machine lines.");
    }
    if (input.estimate.hadMaterialLines && input.sources.materialRowCount === 0) {
      warnings.push("The estimate included material cost but no material usage rows are logged.");
    }
  }
  if (components.laborBasis === "not_entered") {
    warnings.push("Labor is not entered — enter minutes + rate, an override, or confirm $0 labor.");
  }
  if (isDtp && input.inputs.dtp && !normalizeDtpOutsource(input.inputs.dtp).freightEntered) {
    warnings.push("Actual Spektra freight is not entered (the $85 estimate is not an actual).");
  }
  {
    const basis = input.sources.usedQty + input.sources.wasteQty + input.sources.reprintQty || input.sources.pulledQty;
    if (input.sources.deductedQty > 0 && basis > 0 && Math.abs(input.sources.deductedQty - basis) / basis > 0.25) {
      warnings.push(`Inventory deducted (${input.sources.deductedQty}) differs from the costed usage basis (${basis}) by more than 25% — confirm before finalizing.`);
    }
  }

  const status: FinalizeStatus = blocked.length ? "BLOCKED" : warnings.length ? "WARNING" : "READY";
  return {
    status,
    blockedReasons: blocked,
    warningReasons: warnings,
    requiresReason: status === "WARNING",
    components,
    revenue: input.revenue,
    totalCost,
    grossProfit,
    grossMarginPct,
    estimatedTotalCost: input.estimate.estimatedTotalCost,
    varianceDollars: variance.varianceDollars,
    variancePct: variance.variancePct,
  };
}

// Immutable finalize snapshot — embedded in the actual_cost_finalized event.
export function buildActualCostFinalizeSnapshot(input: {
  assessment: FinalizeAssessment;
  inputs: FinalizeInputs;
  actor: string;
  finalizedAt: string;
  family: string;
}): Record<string, unknown> {
  const { assessment } = input;
  return {
    version: "15E.1-actual-cost-finalize",
    family: input.family,
    gateStatus: assessment.status,
    warningReasons: assessment.warningReasons,
    finalizeReason: input.inputs.warningReason?.trim() || null,
    enteredInputs: {
      laborMinutes: input.inputs.laborMinutes,
      laborRate: input.inputs.laborRate,
      laborCostOverride: input.inputs.laborCostOverride,
      laborZeroConfirmed: input.inputs.laborZeroConfirmed,
      packingCost: input.inputs.packingCost,
      shippingCost: input.inputs.shippingCost,
      outsourceCost: input.inputs.outsourceCost,
      reprintCost: input.inputs.reprintCost,
      otherCost: input.inputs.otherCost,
      dtp: input.inputs.dtp,
    },
    components: assessment.components,
    revenue: assessment.revenue,
    finalTotalCost: assessment.totalCost,
    finalGrossProfit: assessment.grossProfit,
    finalGrossMarginPct: assessment.grossMarginPct,
    estimatedTotalCost: assessment.estimatedTotalCost,
    varianceDollars: assessment.varianceDollars,
    variancePct: assessment.variancePct, // null = unavailable (no estimated cost)
    actor: input.actor,
    finalizedAt: input.finalizedAt,
  };
}

// Real authenticated actor (15E.1-I): staff email, else name, else stable
// user/shop identifiers. Offline Shopify sessions carry no person — the
// documented fallback records the shop-scoped admin identity. Never a posted field.
export function resolveActorFromSession(session: any, shop: string): string {
  const email = String(session?.email || session?.onlineAccessInfo?.associated_user?.email || "").trim();
  if (email) return email;
  const first = String(session?.firstName || session?.onlineAccessInfo?.associated_user?.first_name || "").trim();
  const last = String(session?.lastName || session?.onlineAccessInfo?.associated_user?.last_name || "").trim();
  const name = `${first} ${last}`.trim();
  if (name) return name;
  const userId = session?.userId || session?.onlineAccessInfo?.associated_user?.id;
  if (userId) return `user:${userId}`;
  return `shop-admin:${shop} (offline session)`;
}

// Blank-preserving numeric parser (15E.1-M): "" -> null, never 0.
export function numberOrNull(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
