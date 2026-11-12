// 2026-11-12 — owner Staff Access & Launch Readiness checks (pure, client-safe).
//
// GREEN  = ready.
// AMBER  = waiting on an external owner input / manual Shopify action / credential
//          (NOT a code failure).
// RED    = unsafe or missing authority right now.
// Inputs are gathered by the owner-only route; nothing here reads env or DB.

export type ReadinessTone = "green" | "amber" | "red";
export type ReadinessKind = "security" | "costing" | "storefront" | "integration" | "migration";
export type ReadinessCheck = { key: string; kind: ReadinessKind; tone: ReadinessTone; label: string; detail: string; ownerAction: string | null };

export type ReadinessInputs = {
  ownerIdsConfigured: number;
  temporaryAllStaff: boolean;
  staffRoleAssignments: number;
  authorizedManagers: number;
  activeConfiguratorProducts: number;
  configuratorProductsMissingShopifyIds: number;
  mimakiWhiteCalibrationApproved: boolean;
  jar50mlConfirmed: boolean;
  bandSecondsMissingSizes: string[];
  bannerFinishingUnverified: string[];
  splitBagPackoutModeled: boolean;
  operationalMigrationActivated: boolean;
  /** Owner-approved minimum job count for calibration-variance review (null = not set). */
  calibrationMinSamples: number | null;
};

export function buildReadinessChecks(i: ReadinessInputs): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);

  add(i.temporaryAllStaff
    ? { key: "owner-enforcement", kind: "security", tone: "red", label: "Owner enforcement", detail: "GSO_OWNER_ENFORCEMENT=temporary_all_staff — EVERY Shopify staff login is treated as owner (all financials, all overrides).", ownerAction: "Remove GSO_OWNER_ENFORCEMENT on Render before any employee logs in." }
    : i.ownerIdsConfigured > 0
      ? { key: "owner-enforcement", kind: "security", tone: "green", label: "Owner enforcement", detail: `${i.ownerIdsConfigured} owner Shopify staff ID(s) configured; enforcement is on.`, ownerAction: null }
      : { key: "owner-enforcement", kind: "security", tone: "red", label: "Owner enforcement", detail: "No owner IDs configured — owner-only pages and financials are denied to everyone.", ownerAction: "Set GSO_OWNER_SHOPIFY_USER_IDS on Render (owner ID 77055393857)." });

  add(i.staffRoleAssignments > 0
    ? { key: "staff-roles", kind: "security", tone: "green", label: "Employee roles", detail: `${i.staffRoleAssignments} employee role assignment(s); ${i.authorizedManagers} manager(s) authorized for financials.`, ownerAction: null }
    : { key: "staff-roles", kind: "security", tone: "amber", label: "Employee roles", detail: "No employees are assigned yet (unassigned staff are denied by default — safe).", ownerAction: "Give each employee their own Shopify staff account, collect their user IDs from this page, then set GSO_STAFF_ROLES on Render." });

  add(i.configuratorProductsMissingShopifyIds > 0
    ? { key: "configurator-ids", kind: "storefront", tone: "red", label: "Configurator product IDs", detail: `${i.configuratorProductsMissingShopifyIds} of ${i.activeConfiguratorProducts} active configurator product(s) have no Shopify product ID — a raw native-variant order for them cannot be recognised and held.`, ownerAction: "Map the Shopify product/variant IDs in Configurator Mapping." }
    : { key: "configurator-ids", kind: "storefront", tone: "green", label: "Configurator product IDs", detail: `All ${i.activeConfiguratorProducts} active configurator product(s) carry Shopify IDs, so raw-variant orders are held for owner review.`, ownerAction: null });

  add({ key: "wholesale-discount", kind: "storefront", tone: "amber", label: "Old Wholesale Pricing discount", detail: "Manual Shopify action — the app cannot deactivate it (and never re-creates it without the owner).", ownerAction: "Shopify Admin → Discounts → Wholesale Pricing → Deactivate." });
  add({ key: "stock-bag-storefront", kind: "storefront", tone: "amber", label: "Stock Bag storefront cleanup", detail: "Backend holds raw-variant orders; the theme still needs the native buy paths removed.", ownerAction: "Remove native Add to Cart / Quick Add on configurator-only templates, hide raw $1 variants, test the configurator checkout, never activate the cart transform." });

  add(i.mimakiWhiteCalibrationApproved
    ? { key: "mimaki-white", kind: "costing", tone: "green", label: "Mimaki White calibration", detail: "Approved calibration present.", ownerAction: null }
    : { key: "mimaki-white", kind: "costing", tone: "amber", label: "Mimaki White calibration", detail: "No approved normalized calibration — Mimaki White quotes block MIMAKI_WHITE_CALIBRATION_REQUIRED (Roland White or raw history is never substituted).", ownerAction: "Approve one controlled calibration print (procedure in docs/GSO_ERP_PROJECT_STATE.md)." });
  add(i.jar50mlConfirmed
    ? { key: "jar-50ml", kind: "costing", tone: "green", label: "50ml label geometry", detail: "Owner-confirmed.", ownerAction: null }
    : { key: "jar-50ml", kind: "costing", tone: "amber", label: "50ml label geometry", detail: "Pending owner samples; 50ml quotes carry the confirmation warning.", ownerAction: "Measure the 50ml side / lid / band label (art size)." });
  if (i.bandSecondsMissingSizes.length) add({ key: "jar-band-labor", kind: "costing", tone: "amber", label: "Jar band application labor", detail: `No owner application time for the band on ${i.bandSecondsMissingSizes.join(", ")} — the band is selectable and its print / media / ink / cut are costed, but a job with it stays needs-review (quote-only); Side / Lid quote normally.`, ownerAction: `Time the application of ONE band on ${i.bandSecondsMissingSizes.join(" and ")} (seconds).` });
  if (i.bannerFinishingUnverified.length) add({ key: "banner-finishing", kind: "costing", tone: "amber", label: "Banner finishing", detail: `Quote-only until standards exist: ${i.bannerFinishingUnverified.join(", ")}.`, ownerAction: "Provide hem sec/ft + tape $/ft, sec + $ per grommet (and spacing), pole pocket sec/ft + material $/ft, double-sided construction, tube cost + banners/tube." });
  if (!i.splitBagPackoutModeled) add({ key: "split-bag-packout", kind: "costing", tone: "amber", label: "Split Bag packout / freight", detail: "Carton packout and inbound freight are not modelled (never invented).", ownerAction: "Provide the first real Split Bag shipment (cartons, units per carton, freight invoice)." });
  add(i.calibrationMinSamples != null
    ? { key: "calibration-review", kind: "costing", tone: "green", label: "Calibration variance review", detail: `Owner review when the mean variance over the last ${i.calibrationMinSamples} jobs reaches 10% (never auto-changed).`, ownerAction: null }
    : { key: "calibration-review", kind: "costing", tone: "amber", label: "Calibration variance review", detail: "The 10% sustained-variance rule needs an owner-approved minimum job count; until then no automatic review alert is raised (calibrations are never auto-changed).", ownerAction: "Choose the minimum number of jobs and set GSO_CALIBRATION_REVIEW_MIN_SAMPLES on Render." });
  add({ key: "rush", kind: "costing", tone: "amber", label: "Rush pricing", detail: "No rush surcharge or rules are approved; nothing adds a rush fee.", ownerAction: "Approve rush surcharge, turnaround and qualification rules." });

  add(i.operationalMigrationActivated
    ? { key: "operational-migration", kind: "migration", tone: "green", label: "Operational records migration", detail: "Activated.", ownerAction: null }
    : { key: "operational-migration", kind: "migration", tone: "amber", label: "Operational records migration", detail: "Staged (20261112090000_add_operational_records): reservations, structured QC / reprint / shipment / waste, purchasing approver, rush, promised date, variance, notification preferences.", ownerAction: "Activate per prisma/migrations-pending/README.md after a DB backup." });

  add({ key: "quickbooks", kind: "integration", tone: "amber", label: "QuickBooks", detail: "Not connected (CSV exports only).", ownerAction: "Provide QuickBooks app credentials when ready." });
  add({ key: "messaging", kind: "integration", tone: "amber", label: "Customer email / SMS", detail: "No provider connected; nothing is ever sent to customers.", ownerAction: "Choose an email and an SMS provider and supply credentials." });
  return checks;
}

export function readinessSummary(checks: ReadinessCheck[]): { red: number; amber: number; green: number } {
  return { red: checks.filter((c) => c.tone === "red").length, amber: checks.filter((c) => c.tone === "amber").length, green: checks.filter((c) => c.tone === "green").length };
}
