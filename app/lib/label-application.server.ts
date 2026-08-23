// Patch 2D (17D.5) — canonical LABEL APPLICATION to a physical item.
//
// Three modes, and deliberately NO catalog:
//
//   NONE                    labels/stickers only. No item, no application.
//   CUSTOMER_PROVIDED_ITEM  the customer supplies the item (cans, tubes,
//                           bottles, …). Item cost to GSO is $0; application
//                           labor is still charged.
//   CUSTOM_ITEM             GSO buys/supplies the item. Item cost AND labor.
//
// There is no admin item list, no saved Glass Tube / Soda Can / Bottle record
// and no database model here. Everything is a per-job input, because a
// universal application time for an arbitrary item does not exist and must
// never be invented.
//
// QUANTITY SAFETY is the whole point of this file. Four quantities are kept
// strictly apart so a 2-application job on 1,000 cans can never be priced as
// 2,000 cans:
//
//   physicalItems      the things being labelled          (1,000 cans)
//   applicationsPerItem labels applied to each one        (2)
//   applicationEvents  physicalItems x applicationsPerItem (2,000)
//   printedLabels      labels actually produced by the job (>= events)
//
// ITEM COST is charged on physicalItems. LABOR is charged on applicationEvents.
//
// Pure: no db, no network, no clock.

import type { CostCategory } from "./true-cost-engine.server";

export const LABEL_APPLICATION_VERSION = "17D.5-label-application";

/** Canonical owner labor standard. Same $20/hr as every other hand stage. */
export const APPLICATION_LABOR_RATE_PER_HOUR = 20;

export const APPLICATION_REASONS = {
  /** Application enabled but no measured seconds-per-event. -> DRAFT_ONLY */
  applicationRateRequired: "APPLICATION_RATE_REQUIRED",
  /** CUSTOM_ITEM chosen but no unit cost entered. -> DRAFT_ONLY */
  customItemCostRequired: "CUSTOM_ITEM_COST_REQUIRED",
  /** Fewer labels produced than applications required. -> DRAFT_ONLY */
  labelQuantityShortfall: "APPLICATION_LABEL_QUANTITY_SHORTFALL",
  /** applicationsPerItem must be a whole number >= 1. -> DRAFT_ONLY */
  applicationsPerItemInvalid: "APPLICATIONS_PER_ITEM_INVALID",
  /** Item quantity missing or <= 0. -> DRAFT_ONLY */
  itemQuantityRequired: "APPLICATION_ITEM_QUANTITY_REQUIRED",
} as const;

export type ApplicationMode = "none" | "customer_provided_item" | "custom_item";

export type LabelApplicationInput = {
  mode: ApplicationMode;
  itemDescription?: string;
  /** PHYSICAL items being labelled — never the number of labels. */
  itemQuantity?: number;
  /** Labels applied to each physical item. Whole number, minimum 1. */
  applicationsPerItem?: number;
  /** Owner-measured seconds for ONE application event. Never assumed. */
  applicationSecondsPerEvent?: number;
  /** CUSTOM_ITEM only. Manually entered per job — there is no catalog. */
  customItemUnitCost?: number | null;
  /** Labels this job actually prints, summed across every applicable line. */
  printedLabels: number;
};

export type LabelApplicationStage = {
  key: string;
  label: string;
  amount: number;
  category?: CostCategory;
  formula?: string;
  note?: string;
  provisional?: string;
  blocker?: string;
};

export type LabelApplicationResult = {
  version: string;
  mode: ApplicationMode;
  /** Diagnostics the calculator must display so the four counts stay visible. */
  physicalItems: number;
  applicationsPerItem: number;
  applicationEvents: number;
  printedLabels: number;
  itemCost: number;
  applicationLaborCost: number;
  stages: LabelApplicationStage[];
  blockers: string[];
  reasons: string[];
};

function isWholeAtLeastOne(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1;
}

export function computeLabelApplication(input: LabelApplicationInput): LabelApplicationResult {
  const printedLabels = Math.max(0, Number(input.printedLabels) || 0);

  if (input.mode === "none") {
    return {
      version: LABEL_APPLICATION_VERSION,
      mode: "none",
      physicalItems: 0,
      applicationsPerItem: 0,
      applicationEvents: 0,
      printedLabels,
      itemCost: 0,
      applicationLaborCost: 0,
      stages: [
        { key: "application_item", category: "materials", label: "Applied item — none", amount: 0, note: "Labels/stickers only: no physical item and no application labor." },
      ],
      blockers: [],
      reasons: [],
    };
  }

  const isCustom = input.mode === "custom_item";
  const blockers: string[] = [];
  const reasons: string[] = [];

  const physicalItems = Number(input.itemQuantity) || 0;
  if (!(physicalItems > 0)) {
    reasons.push(APPLICATION_REASONS.itemQuantityRequired);
    blockers.push(`${APPLICATION_REASONS.itemQuantityRequired}: the number of PHYSICAL items being labelled is required.`);
  }

  const applicationsPerItem = input.applicationsPerItem as number;
  if (!isWholeAtLeastOne(applicationsPerItem)) {
    reasons.push(APPLICATION_REASONS.applicationsPerItemInvalid);
    blockers.push(`${APPLICATION_REASONS.applicationsPerItemInvalid}: applications per item must be a whole number of at least 1 (received ${String(input.applicationsPerItem)}).`);
  }

  const seconds = Number(input.applicationSecondsPerEvent);
  const secondsOk = Number.isFinite(seconds) && seconds > 0;
  if (!secondsOk) {
    reasons.push(APPLICATION_REASONS.applicationRateRequired);
    blockers.push(`${APPLICATION_REASONS.applicationRateRequired}: seconds per application must be measured for this item. A universal application time for an arbitrary item does not exist and is never assumed.`);
  }

  const safeApplications = isWholeAtLeastOne(applicationsPerItem) ? applicationsPerItem : 0;
  const applicationEvents = physicalItems > 0 ? physicalItems * safeApplications : 0;

  // Extras/overage are fine — only a SHORTFALL is a problem.
  if (applicationEvents > 0 && printedLabels < applicationEvents) {
    reasons.push(APPLICATION_REASONS.labelQuantityShortfall);
    blockers.push(`${APPLICATION_REASONS.labelQuantityShortfall}: the job prints ${printedLabels} label(s) but ${applicationEvents} application(s) are required (${physicalItems} item(s) x ${safeApplications}).`);
  }

  let unitCost = 0;
  if (isCustom) {
    const supplied = input.customItemUnitCost;
    if (supplied == null || !Number.isFinite(Number(supplied)) || Number(supplied) < 0) {
      reasons.push(APPLICATION_REASONS.customItemCostRequired);
      blockers.push(`${APPLICATION_REASONS.customItemCostRequired}: a per-unit cost must be entered for a GSO-supplied item. There is no item catalog and no default.`);
    } else {
      unitCost = Number(supplied);
    }
  }

  const itemCost = isCustom ? physicalItems * unitCost : 0;
  const applicationLaborCost = secondsOk && applicationEvents > 0
    ? (applicationEvents * seconds / 3600) * APPLICATION_LABOR_RATE_PER_HOUR
    : 0;

  const blocker = blockers.length ? blockers.join(" | ") : undefined;
  const description = String(input.itemDescription || "").trim() || "item";

  const stages: LabelApplicationStage[] = [
    {
      key: "application_item",
      category: "materials",
      label: isCustom
        ? `Applied item — ${physicalItems} x ${description} @ $${unitCost.toFixed(4)}`
        : `Applied item — ${physicalItems} x ${description} (customer-provided)`,
      amount: blocker ? 0 : itemCost,
      formula: isCustom ? `${physicalItems} item(s) x $${unitCost.toFixed(4)}` : `${physicalItems} customer-provided item(s) x $0.00`,
      note: isCustom
        ? "GSO supplies the item; the unit cost is a manually entered job input, never a catalog lookup."
        : "The customer supplies the item, so it costs GSO nothing. Application labor is still charged.",
      blocker,
    },
    {
      key: "application_labor",
      category: "finishing_application",
      label: `Application labor — ${applicationEvents} application(s) on ${physicalItems} item(s)`,
      amount: blocker ? 0 : applicationLaborCost,
      formula: `${physicalItems} item(s) x ${safeApplications} application(s) = ${applicationEvents} event(s) x ${secondsOk ? seconds : "?"}s / 3600 x $${APPLICATION_LABOR_RATE_PER_HOUR}/hr`,
      note: `Labor is charged on APPLICATION EVENTS (${applicationEvents}), never on physical items (${physicalItems}). Printed labels for the job: ${printedLabels}.`,
      blocker,
    },
  ];

  return {
    version: LABEL_APPLICATION_VERSION,
    mode: input.mode,
    physicalItems,
    applicationsPerItem: safeApplications,
    applicationEvents,
    printedLabels,
    itemCost: blocker ? 0 : itemCost,
    applicationLaborCost: blocker ? 0 : applicationLaborCost,
    stages,
    blockers,
    reasons: Array.from(new Set(reasons)),
  };
}
