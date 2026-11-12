// 2026-11-11 — server-side redaction of production job money for non-owner
// viewers (owner decision: production staff do not receive revenue, true cost,
// profit, margin or cost notes). Used by every production surface that returns
// job rows: the board, the printable work order, the calendar and the proof
// page. Operational data (quantities, ink mL, minutes, statuses) is kept.
// Pure: no db, no auth — callers decide visibility with
// productionFinancialVisibility (owner-authorization.server.ts).

/** Strip every money figure from a board job for a non-owner viewer (server side). */
export function redactJobFinancials(job: any) {
  const MONEY_TEXT = /\$\s?\d|cost|profit|margin|revenue/i;
  return {
    ...job,
    actualLaborRate: null, actualLaborMinutes: null, actualLaborCost: null, actualPackingCost: null, actualShippingCost: null,
    actualOutsourceCost: null, actualOtherCost: null, actualReprintCost: null, actualTotalCost: null, actualFinalProfit: null,
    actualFinalMargin: null, actualCostNotes: null,
    // 2026-11-12 (migration 20261112090000): quoted-vs-actual columns.
    quotedTrueCost: null, actualVarianceAmount: null, actualVariancePct: null,
    // Print-log actuals keep their operational figures only.
    actuals: job.actuals ? { entryCount: job.actuals.entryCount, actualSqft: job.actuals.actualSqft, actualInkMl: job.actuals.actualInkMl, actualPrintMinutes: job.actuals.actualPrintMinutes } : null,
    writebackPreview: null, printLogApplied: null,
    finalizeGate: job.finalizeGate ? { ...job.finalizeGate, varianceDollars: null, variancePct: null, estimatedTotalCost: null } : null,
    items: (job.items || []).map((item: any) => ({ ...item, unitPrice: null, unitCost: null, costSnapshot: null, priceSnapshot: null })),
    materialUsages: (job.materialUsages || []).map((usage: any) => ({ ...usage, costPerUnit: null, totalCost: null })),
    inventoryMovements: (job.inventoryMovements || []).map((movement: any) => ({ ...movement, costPerUnit: null, costImpact: null })),
    events: (job.events || []).map((event: any) => (MONEY_TEXT.test(`${event.message || ""} ${event.oldValue || ""} ${event.newValue || ""}`)
      ? { ...event, message: "(financial detail — owner only)", oldValue: null, newValue: null }
      : event)),
  };
}
