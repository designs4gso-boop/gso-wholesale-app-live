import type React from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { materialKind } from "../lib/material-classify";
import { resolveMaterialUnitCost, resolvePrintMaterialCostPerSqft } from "../lib/cost-calculator.server";
import { buildCsv } from "../lib/shopify-cost-audit-shared";
import { applyApprovedCostUpdates, previewApprovedCostUpdates } from "../lib/approved-cost-updates.server";
import {
  APPLY_CONFIRM_PHRASE,
  APPROVED_UPDATE_STATUS_LABELS,
  CALCULATOR_ASSUMPTION_ROWS,
  CONFIDENCE_LABELS,
  NO_FLAT_COST_ISSUE,
  OWNER_CHECKLIST_HEADER,
  PLACEHOLDER_ISSUE,
  SEEDED_FINGERPRINTS,
  UNEXPECTED_TIERS_ISSUE,
  buildReplayTests,
  checklistRowToCells,
  classifyConfidence,
  hasVerifiedMarker,
  looksLikePlaceholder,
  nearlyEqual,
  tierPolicy,
  tiersNonMonotonic,
  worstConfidence,
  type ApprovedUpdateStatus,
  type CategoryRow,
  type ChecklistRow,
  type Confidence,
  type ReplayTest,
  type WorkbookIssue,
} from "../lib/cost-verification-shared";

// Cost Verification Workbook (Patch 13.2). Read-only by design: no action
// export, no writes, no Shopify calls. Every fix routes to the page that owns
// the data; verification is recorded via costReviewNeeded and the interim
// [VERIFIED ...] notes-marker convention until the schema patch adds real
// verifiedAt/By columns.

const money = (value: number, digits = 2) => `$${Number(value || 0).toFixed(digits)}`;

function pushIssue(issues: WorkbookIssue[], issue: WorkbookIssue) {
  issues.push(issue);
}

// 13.2.2: the ONLY write on this page. Owner-gated: requires the exact
// confirmation phrase, re-evaluates matching server-side, and updates only
// unambiguously matched VendorProduct/VendorProductTier rows. No Shopify, no
// quotes, no production, no recipes, no schema.
export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (String(formData.get("intent")) !== "applyApprovedCosts") {
    return { ok: false as const, error: "Unknown intent." };
  }
  if (String(formData.get("confirmPhrase") ?? "").trim() !== APPLY_CONFIRM_PHRASE) {
    return { ok: false as const, error: `Confirmation phrase does not match. Type exactly: ${APPLY_CONFIRM_PHRASE}` };
  }

  const result = await applyApprovedCostUpdates(db, session.shop);
  return { ok: true as const, applied: result.applied, skippedCount: result.skipped.length };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [materials, vendorProducts, machines, recipes, recipeTierCount, configuratorRows, pricingRuleCount, productCostCount, sourcedCostTierCount, ripCount, latestRip] = await Promise.all([
    db.material.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, materialType: true, unit: true, baseUnit: true,
        costPerUnit: true, purchaseCost: true, purchaseUnit: true, calculatedUnitCost: true,
        rollWidthIn: true, rollLengthFt: true, volumeMl: true, notes: true, sku: true, vendor: true,
        costReviewNeeded: true, useInRecipes: true, updatedAt: true,
        _count: { select: { costHistory: true } },
      },
      orderBy: { name: "asc" },
      take: 300,
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, productType: true, vendorSku: true, vendor: true, moq: true,
        defaultUnitCost: true, notes: true,
        tiers: { select: { minQty: true, maxQty: true, unitCost: true }, orderBy: { minQty: "asc" } },
      },
      orderBy: { name: "asc" },
      take: 300,
    }),
    db.machine.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, machineType: true, costPerHour: true, sqftPerHour: true,
        inkChannels: {
          select: { slotNumber: true, inkName: true, inkType: true, costPerMl: true, cartridgeCost: true, cartridgeMl: true, mlPerSqft1Pct: true, enabled: true },
          orderBy: { slotNumber: "asc" },
        },
      },
      take: 50,
    }),
    db.productRecipe.findMany({
      where: { shop, active: true },
      select: {
        id: true, name: true, useInQuotes: true, costReviewNeeded: true, productionMode: true,
        applicationLaborSecondsPerUnit: true, packingLaborSecondsPerUnit: true, prepressMinutes: true,
        baseCmykCoveragePct: true, inkAllowancePct: true, maintenanceCostPerSqft: true, machineRecoveryCostPerSqft: true,
      },
      take: 300,
    }),
    db.recipeTier.count({ where: { shop } }),
    db.configuratorPricingRule.findMany({ where: { shop, active: true }, select: { costEach: true }, take: 500 }),
    db.pricingRule.count({ where: { shop } }),
    db.productCost.count({ where: { shop } }),
    db.sourcedCostTier.count({ where: { shop } }),
    db.printLogEntry.count({ where: { shop, jobTicket: { startsWith: "GSOQ-" }, inkMl: { gt: 0 } } }),
    db.printLogEntry.findFirst({ where: { shop, jobTicket: { startsWith: "GSOQ-" }, inkMl: { gt: 0 } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  const issues: WorkbookIssue[] = [];

  // ---- Blank / vendor items (jars, bags, boxes, cans) ----
  const blankItemRows = vendorProducts.map((product) => {
    const tierCosts = product.tiers.map((tier) => Number(tier.unitCost)).filter((cost) => cost > 0);
    const bestValue = tierCosts.length ? Math.max(...tierCosts) : Number(product.defaultUnitCost) || null;
    const confidence = classifyConfidence({ notes: product.notes, value: bestValue });
    const band = tierCosts.length ? `${money(Math.min(...tierCosts))}-${money(Math.max(...tierCosts))} (${product.tiers.length} tiers)` : bestValue ? `${money(bestValue)} flat` : "no cost";

    if (!bestValue) {
      pushIssue(issues, { area: "Blank items", item: product.name, severity: "critical", problem: "No usable cost: no default unit cost and no tiers.", verify: "Vendor invoice / price sheet", fixPath: "/app/erp/vendor-cost-book", fixLabel: "Vendor Cost Book" });
    }
    if (product.tiers.length && tiersNonMonotonic(product.tiers)) {
      pushIssue(issues, { area: "Blank items", item: product.name, severity: "warning", problem: "Suspicious tiers: cost per unit rises as quantity rises — check for typos.", verify: "Vendor price sheet tier table", fixPath: "/app/erp/vendor-cost-book", fixLabel: "Vendor Cost Book" });
    }
    if (confidence === "seeded") {
      pushIssue(issues, { area: "Blank items", item: product.name, severity: "warning", problem: "Cost was seeded from old calculator presets — DB-backed is not invoice-verified.", verify: `Vendor invoice (${product.vendor || "vendor"})`, fixPath: "/app/erp/vendor-cost-book", fixLabel: "Vendor Cost Book" });
    }
    return { name: product.name, productType: product.productType, vendor: product.vendor || "", band, moq: product.moq, confidence };
  });

  // Flat Material copies of blank costs drifting from vendor tiers.
  const vendorBySku = new Map(vendorProducts.filter((p) => p.vendorSku).map((p) => [String(p.vendorSku), p]));
  for (const material of materials) {
    if (materialKind(material) !== "blank" || !material.sku) continue;
    const vendorProduct = vendorBySku.get(material.sku);
    if (!vendorProduct?.tiers?.length) continue;
    const tierCosts = vendorProduct.tiers.map((tier) => Number(tier.unitCost)).filter((cost) => cost > 0);
    const flat = Number(material.costPerUnit) || 0;
    if (flat > 0 && tierCosts.length && (flat > Math.max(...tierCosts) + 0.0001 || flat < Math.min(...tierCosts) - 0.0001)) {
      pushIssue(issues, { area: "Blank items", item: material.name, severity: "warning", problem: `Flat material copy (${money(flat)}) is outside the vendor tier band — the two copies have drifted.`, verify: "Vendor invoice; then align the Material flat cost", fixPath: "/app/erp/materials", fixLabel: "Materials" });
    }
  }

  // ---- Print media / sticker / holographic / laminate ----
  const printMaterialRows = materials.filter((m) => materialKind(m) === "print").map((material) => {
    const resolved = resolvePrintMaterialCostPerSqft(material);
    const trap = Number(material.purchaseCost) > 0 && resolved.unitCost <= 0;
    const rollMissingDims = String(material.purchaseUnit || "").toLowerCase() === "roll" && (!(Number(material.rollWidthIn) > 0) || !(Number(material.rollLengthFt) > 0));
    const confidence: Confidence = hasVerifiedMarker(material.notes)
      ? "verified"
      : resolved.unitCost <= 0
        ? "missing"
        : material._count.costHistory > 0
          ? "manual"
          : classifyConfidence({ notes: material.notes, value: resolved.unitCost });

    if (trap) {
      pushIssue(issues, { area: "Materials", item: material.name, severity: "critical", problem: `purchaseCost fallback trap: only the purchase price (${money(Number(material.purchaseCost))}) exists — the live engine would use it as a per-unit cost.`, verify: "Invoice + roll/volume details so a real unit cost derives", fixPath: "/app/erp/materials", fixLabel: "Materials" });
    } else if (resolved.unitCost <= 0) {
      pushIssue(issues, { area: "Materials", item: material.name, severity: "critical", problem: "No usable cost per sqft.", verify: "Supplier invoice", fixPath: "/app/erp/materials", fixLabel: "Materials" });
    }
    if (rollMissingDims) {
      pushIssue(issues, { area: "Materials", item: material.name, severity: resolved.unitCost > 0 ? "warning" : "critical", problem: "Purchased by the roll but roll width/length missing — $/sqft cannot derive from the invoice price.", verify: "Roll dimensions from the label/invoice", fixPath: "/app/erp/materials", fixLabel: "Materials" });
    }
    if (material.costReviewNeeded) {
      pushIssue(issues, { area: "Materials", item: material.name, severity: "warning", problem: "Flagged cost review needed.", verify: "Invoice, then clear the flag", fixPath: "/app/erp/materials", fixLabel: "Materials" });
    }
    return { name: material.name, materialType: material.materialType, costPerSqft: resolved.unitCost, unitPair: `${material.purchaseUnit || "?"} -> ${material.baseUnit || material.unit}`, confidence };
  });

  // ---- Ink: channels + ink/coating materials ----
  const inkChannelRows: Array<{ machine: string; slot: string; costPerMl: number; usage: number; confidence: Confidence; flags: string[] }> = [];
  for (const machine of machines) {
    const isPrinter = String(machine.machineType || "").toLowerCase().includes("print") || /roland|mimaki/i.test(machine.name || "");
    if (!isPrinter) continue;

    if (!(Number(machine.costPerHour) > 0)) {
      pushIssue(issues, { area: "Machine / labor", item: machine.name, severity: "critical", problem: "No machine hourly cost.", verify: "Real recovery rate (power + maintenance + depreciation)", fixPath: "/app/erp/machines", fixLabel: "Machines" });
    } else if (nearlyEqual(Number(machine.costPerHour), SEEDED_FINGERPRINTS.machineRatePerHour)) {
      pushIssue(issues, { area: "Machine / labor", item: machine.name, severity: "warning", problem: "Machine rate is the seeded $5/hr default — and the Cost Calculator's input defaults to $8/hr, so the app disagrees with itself.", verify: "Pick ONE verified hourly rate; use it in Machines and the calculator", fixPath: "/app/erp/machines", fixLabel: "Machines" });
    }

    for (const channel of machine.inkChannels.filter((c) => c.enabled)) {
      const derived = Number(channel.costPerMl) > 0
        ? Number(channel.costPerMl)
        : Number(channel.cartridgeCost) > 0 && Number(channel.cartridgeMl) > 0
          ? Number(channel.cartridgeCost) / Number(channel.cartridgeMl)
          : 0;
      const flags: string[] = [];
      let seeded = false;
      if (nearlyEqual(Number(channel.cartridgeCost), SEEDED_FINGERPRINTS.mimakiBottleCost) && nearlyEqual(Number(channel.cartridgeMl), SEEDED_FINGERPRINTS.mimakiBottleMl)) {
        seeded = true;
        flags.push("seeded Mimaki $190/1000ml estimate");
      }
      if (nearlyEqual(Number(channel.cartridgeCost), SEEDED_FINGERPRINTS.rolandPouchCost) && nearlyEqual(Number(channel.cartridgeMl), SEEDED_FINGERPRINTS.rolandPouchMl)) {
        seeded = true;
        flags.push("seeded Roland $156.99/750ml preset");
      }
      if (nearlyEqual(Number(channel.mlPerSqft1Pct), SEEDED_FINGERPRINTS.inkUsagePerSqftPct)) {
        flags.push("seeded 0.0075 usage rate (uncalibrated)");
      }
      // Machine/ink-channel records have no notes field, so a VERIFIED marker
      // cannot be stored on them until the schema patch; fingerprints decide.
      const confidence: Confidence = derived <= 0 ? "missing" : seeded ? "seeded" : "manual";
      const slotName = `${machine.name} slot ${channel.slotNumber}: ${channel.inkName || channel.inkType}`;

      if (derived <= 0) {
        pushIssue(issues, { area: "Ink", item: slotName, severity: "critical", problem: "Enabled ink channel has no cost per ml.", verify: "Ink invoice (cartridge/pouch cost and ml)", fixPath: "/app/erp/machines", fixLabel: "Machines" });
      }
      for (const flag of flags) {
        pushIssue(issues, { area: "Ink", item: slotName, severity: "warning", problem: `Value matches a ${flag}.`, verify: flag.includes("usage") ? "Calibrate from RasterLink/VersaWorks logs (13A)" : "Ink invoice", fixPath: flag.includes("usage") ? "/app/erp/rip-imports" : "/app/erp/machines", fixLabel: flag.includes("usage") ? "RIP Imports" : "Machines" });
      }
      inkChannelRows.push({ machine: machine.name, slot: `${channel.slotNumber} ${channel.inkName || channel.inkType}`, costPerMl: derived, usage: Number(channel.mlPerSqft1Pct), confidence, flags });
    }
  }

  // ---- Recipe assumptions (engine-side labor / coverage defaults) ----
  const storedUnpricedLabor = recipes.filter((recipe) =>
    Number(recipe.applicationLaborSecondsPerUnit) > 0 || Number(recipe.packingLaborSecondsPerUnit) > 0 || Number(recipe.prepressMinutes) > 0,
  );
  if (storedUnpricedLabor.length) {
    pushIssue(issues, {
      area: "Machine / labor",
      item: `${storedUnpricedLabor.length} recipe(s) incl. ${storedUnpricedLabor.slice(0, 3).map((r) => r.name).join(", ")}`,
      severity: "warning",
      problem: "Recipes store application/packing/prepress labor that the live quote engine does not price — quotes exclude it (deferred engine-completeness patch).",
      verify: "Stopwatch-check the stored seconds; approve the engine patch after cost verification",
      fixPath: "/app/erp/product-setup",
      fixLabel: "Product Setup",
    });
  }
  const defaultAssumptionRecipes = recipes.filter((recipe) =>
    nearlyEqual(Number(recipe.baseCmykCoveragePct), SEEDED_FINGERPRINTS.cmykCoveragePct) &&
    nearlyEqual(Number(recipe.inkAllowancePct), SEEDED_FINGERPRINTS.inkAllowancePct),
  );
  if (defaultAssumptionRecipes.length) {
    pushIssue(issues, { area: "Machine / labor", item: `${defaultAssumptionRecipes.length} recipe(s) at default estimating assumptions`, severity: "warning", problem: "Coverage 40% / ink allowance 15% (and per-sqft overheads $0.08/$0.05) are schema defaults, never derived from real jobs.", verify: "Confirm or recalibrate after RIP actuals (13A)", fixPath: "/app/erp/product-setup", fixLabel: "Product Setup" });
  }
  const reviewFlaggedRecipes = recipes.filter((recipe) => recipe.costReviewNeeded);
  if (reviewFlaggedRecipes.length) {
    pushIssue(issues, { area: "Machine / labor", item: `${reviewFlaggedRecipes.length} recipe(s) flagged costReviewNeeded`, severity: "warning", problem: "Flagged recipes are excluded from quoting until reviewed.", verify: "Review and clear per recipe", fixPath: "/app/erp/product-setup", fixLabel: "Product Setup" });
  }

  // ---- Legacy tables (context only) ----
  if (pricingRuleCount + productCostCount + sourcedCostTierCount > 0) {
    pushIssue(issues, { area: "Legacy", item: `PricingRule (${pricingRuleCount}) / ProductCost (${productCostCount}) / SourcedCostTier (${sourcedCostTierCount})`, severity: "warning", problem: "Legacy rows exist; the recipe engine does not read them. Do not verify these — they retire with the schema batch.", verify: "Nothing — context only", fixPath: "/app/erp/cost-health", fixLabel: "Cost Health" });
  }
  if (ripCount === 0) {
    pushIssue(issues, { area: "RIP actuals", item: "GSOQ RIP results", severity: "warning", problem: "No actual ink data synced yet — ink estimates cannot be calibrated.", verify: "Run the NAS sync after a GSOQ RasterLink capture", fixPath: "/app/erp/rip-imports", fixLabel: "RIP Imports" });
  }

  // ---- Confidence rollups + summary cards ----
  const blankConfidence = worstConfidence(blankItemRows.map((row) => row.confidence));
  const materialConfidence = worstConfidence(printMaterialRows.map((row) => row.confidence));
  const inkConfidence = worstConfidence(inkChannelRows.map((row) => row.confidence));
  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const areaHasCritical = (area: string) => issues.some((issue) => issue.area === area && issue.severity === "critical");

  const configuratorCosts = configuratorRows.map((row) => Number(row.costEach)).filter((cost) => cost > 0);
  const configuratorBand = configuratorCosts.length ? `${money(Math.min(...configuratorCosts))}-${money(Math.max(...configuratorCosts))} (${configuratorCosts.length} rules)` : "none";

  // ---- Master category table ----
  const categories: CategoryRow[] = [
    { category: "Blank items (jars / bags / boxes / cans)", source: "VendorProduct + VendorProductTier", valueSummary: `${vendorProducts.length} items`, confidence: blankConfidence, problem: areaHasCritical("Blank items") ? "Items with no usable cost" : "Mostly seeded from old presets", verify: "Miron invoice, SAFE CARE price list", fixPath: "/app/erp/vendor-cost-book", fixLabel: "Vendor Cost Book" },
    { category: "Roll media / sticker / holographic / laminate", source: "Material.calculatedUnitCost + roll dims", valueSummary: `${printMaterialRows.length} print materials`, confidence: materialConfidence, problem: areaHasCritical("Materials") ? "Missing $/sqft or purchaseCost traps" : "Check values against invoices", verify: "Supplier invoices + roll dimensions", fixPath: "/app/erp/materials", fixLabel: "Materials" },
    { category: "Ink cost per ml", source: "MachineInkChannel cartridge cost ÷ ml", valueSummary: `${inkChannelRows.length} enabled channels`, confidence: inkConfidence, problem: "Mimaki cost is a code-flagged estimate; Roland is the preset", verify: "Ink invoices", fixPath: "/app/erp/machines", fixLabel: "Machines" },
    { category: "Ink usage / RIP actuals", source: "mlPerSqft1Pct + PrintLogEntry", valueSummary: ripCount ? `${ripCount} GSOQ results (latest ${latestRip ? new Date(latestRip.createdAt).toLocaleDateString() : ""})` : "no actuals yet", confidence: ripCount ? "manual" : "seeded", problem: "0.0075 usage rate is seeded; RIP data exists to calibrate (13A)", verify: "RasterLink/VersaWorks logs; NAS script ink $/ml", fixPath: "/app/erp/rip-imports", fixLabel: "RIP Imports" },
    { category: "Machine hourly rate + speed", source: "Machine.costPerHour / sqftPerHour", valueSummary: machines.map((m) => `${m.name}: ${money(Number(m.costPerHour))}/hr`).join("; ") || "none", confidence: machines.some((m) => nearlyEqual(Number(m.costPerHour), 5)) ? "seeded" : machines.length ? "manual" : "missing", problem: "$5 seeded vs $8 calculator default conflict", verify: "One real recovery rate, used everywhere", fixPath: "/app/erp/machines", fixLabel: "Machines" },
    { category: "Labor rate / setup / application seconds", source: "Calculator inputs ($25/hr, heuristics) + recipe fields", valueSummary: "hardcoded heuristics", confidence: "seeded", problem: "Application seconds are code heuristics; recipes store labor the engine does not price", verify: "Stopwatch one real run; payroll rate", fixPath: "/app/erp/cost-calculator", fixLabel: "Cost Calculator" },
    { category: "Waste %", source: "Line inputs (10%) + recipe wastePct (2% jars)", valueSummary: "assumed", confidence: "seeded", problem: "Never measured", verify: "Accept consciously or measure a run", fixPath: "/app/erp/product-setup", fixLabel: "Product Setup" },
    { category: "Cutting / prepress / packout", source: "Calculator preset rules (code)", valueSummary: "hardcoded rules", confidence: "seeded", problem: "Setup minutes and per-unit seconds are code constants", verify: "Confirm each rule's minutes against reality", fixPath: "/app/erp/cost-calculator", fixLabel: "Cost Calculator" },
    { category: "Vendor quantity tiers", source: "VendorProductTier", valueSummary: `${vendorProducts.reduce((sum, p) => sum + p.tiers.length, 0)} tier rows`, confidence: blankConfidence, problem: "Seeded from presets; live engine still flat-costs in-house blanks (deferred fix)", verify: "Invoice tier tables", fixPath: "/app/erp/vendor-cost-book", fixLabel: "Vendor Cost Book" },
    { category: "Shopify product/variant costs", source: "InventoryItem.unitCost (merchant-entered)", valueSummary: "see Shopify Cost Audit", confidence: "manual", problem: "Helper data only — can be as wrong as anything else", verify: "Use mismatches to prioritize invoices; invoices decide", fixPath: "/app/erp/shopify-cost-audit", fixLabel: "Shopify Cost Audit" },
    { category: "Configurator costEach", source: "ConfiguratorPricingRule + hardcoded fallbacks", valueSummary: configuratorBand, confidence: "seeded", problem: "Seeded matrix + code fallbacks feed the live storefront", verify: "Bag vendor invoice", fixPath: "/app/erp/configurator-audit", fixLabel: "Configurator Audit" },
    { category: "RecipeTier sell prices", source: "RecipeTier fixedPrice (jar sheet era)", valueSummary: `${recipeTierCount} tier rows`, confidence: "seeded", problem: "Seeded from the old-calculator-era sell sheet — the owner's stated concern", verify: "Re-derive: verified cost + 40% vs sheet (replay tests)", fixPath: "/app/erp/product-setup", fixLabel: "Product Setup" },
    { category: "Legacy PricingRule / ProductCost / SourcedCostTier", source: "Legacy tables", valueSummary: `${pricingRuleCount} / ${productCostCount} / ${sourcedCostTierCount} rows`, confidence: "manual", problem: "Not read by the engine; retire with the schema batch", verify: "Nothing", fixPath: "/app/erp/cost-health", fixLabel: "Cost Health" },
  ];

  // ---- Replay tests (resolve real ids for prefills) ----
  const findVendorItem = (needle: RegExp) => {
    const hit = vendorProducts.find((p) => needle.test(`${p.vendorSku || ""} ${p.name || ""}`));
    return hit ? `vendor:${hit.id}` : null;
  };
  const holographic = materials.find((m) => materialKind(m) === "print" && /holo/i.test(m.name || ""));
  const tieredVendor = vendorProducts.find((p) => p.tiers.length > 0);
  const replayTests = buildReplayTests({
    threeOzItemId: findVendorItem(/3oz.*clear|preset:3oz-jar-clear/i),
    fourOzItemId: findVendorItem(/4oz.*clear|preset:4oz-jar-clear/i),
    holographicMaterialId: holographic?.id || null,
    bagItemId: findVendorItem(/4x5.*bag|preset:blank-4x5-bag/i) || "preset:blank-4x5-bag",
    blankOnlyItemId: tieredVendor ? `vendor:${tieredVendor.id}` : null,
    hasRipRows: ripCount > 0,
    hasOutsourcedRecipe: recipes.some((recipe) => recipe.productionMode === "outsourced"),
  });

  issues.sort((a, b) => (a.severity === b.severity ? a.area.localeCompare(b.area) : a.severity === "critical" ? -1 : 1));

  // ---- Owner Cost Checklist (13.2.1): one row per cost fact, blank OWNER
  // STATUS / OWNER NOTES columns for manual review against invoices. ----
  const ownerChecklist: ChecklistRow[] = [];

  for (const product of vendorProducts) {
    const policy = tierPolicy(product.vendor, product.name);
    const baseIssues: string[] = [];
    if (looksLikePlaceholder(product.name, product.vendorSku, product.notes)) baseIssues.push(PLACEHOLDER_ISSUE);
    const verify = `Vendor invoice / price sheet (${product.vendor || "vendor"})`;

    if (product.tiers.length) {
      if (policy === "expected_flat") baseIssues.push(UNEXPECTED_TIERS_ISSUE);
      if (tiersNonMonotonic(product.tiers)) baseIssues.push("Tier cost rises with quantity — check for typos.");
      for (const tier of product.tiers) {
        ownerChecklist.push({
          category: "Blank / vendor item (tiered)",
          itemName: product.name,
          vendor: product.vendor || "",
          cost: Number(tier.unitCost) || null,
          unit: "each",
          tierMinQty: tier.minQty,
          tierMaxQty: tier.maxQty,
          moq: product.moq,
          source: "VendorProductTier",
          confidence: classifyConfidence({ notes: product.notes, value: Number(tier.unitCost) || null }),
          issue: baseIssues.join("; "),
          verify,
          fixPage: "Vendor Cost Book",
        });
      }
    } else {
      const flat = Number(product.defaultUnitCost) || 0;
      if (flat <= 0) {
        baseIssues.push(policy === "expected_flat" ? NO_FLAT_COST_ISSUE : "Miron item with no tiers and no flat cost — enter the tier table.");
      }
      ownerChecklist.push({
        category: "Blank / vendor item (flat)",
        itemName: product.name,
        vendor: product.vendor || "",
        cost: flat > 0 ? flat : null,
        unit: "each",
        tierMinQty: null,
        tierMaxQty: null,
        moq: product.moq,
        source: "VendorProduct.defaultUnitCost",
        confidence: classifyConfidence({ notes: product.notes, value: flat > 0 ? flat : null }),
        issue: baseIssues.join("; "),
        verify,
        fixPage: "Vendor Cost Book",
      });
    }
  }

  for (const material of materials) {
    const kind = materialKind(material);
    const isInk = /ink|coating/i.test(String(material.materialType || ""));
    if (kind !== "print" && kind !== "blank" && !isInk) continue;

    const materialIssues: string[] = [];
    if (looksLikePlaceholder(material.name, material.sku, material.notes)) materialIssues.push(PLACEHOLDER_ISSUE);
    if (material.costReviewNeeded) materialIssues.push("Flagged cost review needed.");
    if (!material.useInRecipes) materialIssues.push("Hidden from recipes (useInRecipes off).");

    if (isInk) {
      const resolved = resolveMaterialUnitCost(material);
      const perMl = resolved.unitCost > 0
        ? resolved.unitCost
        : Number(material.purchaseCost) > 0 && Number(material.volumeMl) > 0
          ? Number(material.purchaseCost) / Number(material.volumeMl)
          : 0;
      ownerChecklist.push({
        category: "Ink / coating material",
        itemName: material.name,
        vendor: material.vendor || "",
        cost: perMl > 0 ? perMl : null,
        unit: "ml",
        tierMinQty: null,
        tierMaxQty: null,
        moq: null,
        source: "Material (ink/coating)",
        confidence: classifyConfidence({ notes: material.notes, value: perMl > 0 ? perMl : null }),
        issue: materialIssues.join("; "),
        verify: "Ink invoice (bottle/pouch cost and ml)",
        fixPage: "Materials",
      });
    } else if (kind === "print") {
      const resolved = resolvePrintMaterialCostPerSqft(material);
      if (Number(material.purchaseCost) > 0 && resolved.unitCost <= 0) materialIssues.push("purchaseCost fallback trap — no derivable unit cost.");
      if (String(material.purchaseUnit || "").toLowerCase() === "roll" && (!(Number(material.rollWidthIn) > 0) || !(Number(material.rollLengthFt) > 0))) {
        materialIssues.push("Roll dimensions missing.");
      }
      ownerChecklist.push({
        category: "Print media / roll material",
        itemName: material.name,
        vendor: material.vendor || "",
        cost: resolved.unitCost > 0 ? resolved.unitCost : null,
        unit: "sqft",
        tierMinQty: null,
        tierMaxQty: null,
        moq: null,
        source: "Material.calculatedUnitCost",
        confidence: hasVerifiedMarker(material.notes) ? "verified" : resolved.unitCost <= 0 ? "missing" : material._count.costHistory > 0 ? "manual" : classifyConfidence({ notes: material.notes, value: resolved.unitCost }),
        issue: materialIssues.join("; "),
        verify: "Supplier invoice + roll width/length",
        fixPage: "Materials",
      });
    } else {
      const resolved = resolveMaterialUnitCost(material);
      const duplicated = material.sku && vendorBySku.get(material.sku)?.tiers?.length
        ? "Duplicate of vendor product tiers — vendor tiers are source of truth."
        : "";
      if (duplicated) materialIssues.push(duplicated);
      ownerChecklist.push({
        category: "Blank material (flat copy)",
        itemName: material.name,
        vendor: material.vendor || "",
        cost: resolved.unitCost > 0 ? resolved.unitCost : null,
        unit: "each",
        tierMinQty: null,
        tierMaxQty: null,
        moq: null,
        source: "Material.costPerUnit",
        confidence: classifyConfidence({ notes: material.notes, value: resolved.unitCost > 0 ? resolved.unitCost : null }),
        issue: materialIssues.join("; "),
        verify: "Vendor invoice (or rely on the vendor tier rows above)",
        fixPage: "Materials",
      });
    }
  }

  for (const machine of machines) {
    const rate = Number(machine.costPerHour) || 0;
    ownerChecklist.push({
      category: "Machine hourly rate",
      itemName: machine.name,
      vendor: "",
      cost: rate > 0 ? rate : null,
      unit: "hour",
      tierMinQty: null,
      tierMaxQty: null,
      moq: null,
      source: "Machine.costPerHour",
      confidence: rate <= 0 ? "missing" : nearlyEqual(rate, SEEDED_FINGERPRINTS.machineRatePerHour) ? "seeded" : "manual",
      issue: rate <= 0 ? "No hourly cost." : nearlyEqual(rate, SEEDED_FINGERPRINTS.machineRatePerHour) ? "Seeded $5/hr — conflicts with the calculator's $8/hr default input." : "",
      verify: "Real recovery rate (power + maintenance + depreciation)",
      fixPage: "Machines",
    });
  }

  for (const row of inkChannelRows) {
    ownerChecklist.push({
      category: "Machine ink channel",
      itemName: `${row.machine} — slot ${row.slot}`,
      vendor: row.machine,
      cost: row.costPerMl > 0 ? row.costPerMl : null,
      unit: "ml",
      tierMinQty: null,
      tierMaxQty: null,
      moq: null,
      source: "MachineInkChannel",
      confidence: row.confidence,
      issue: row.flags.join("; "),
      verify: "Ink invoice (cartridge/pouch cost and ml)",
      fixPage: "Machines",
    });
  }

  for (const assumption of CALCULATOR_ASSUMPTION_ROWS) {
    ownerChecklist.push({
      category: "Calculator assumption (hardcoded)",
      itemName: assumption.itemName,
      vendor: "",
      cost: assumption.cost,
      unit: assumption.unit,
      tierMinQty: null,
      tierMaxQty: null,
      moq: null,
      source: "hardcoded — app/routes/app.erp.cost-calculator.tsx",
      confidence: "seeded",
      issue: assumption.note,
      verify: "Owner confirmation / stopwatch a real run",
      fixPage: "Cost Calculator",
    });
  }

  ownerChecklist.push({
    category: "Recipes (context)",
    itemName: `${recipes.length} active recipe(s) attach blanks via RecipeMaterial`,
    vendor: "",
    cost: null,
    unit: "",
    tierMinQty: null,
    tierMaxQty: null,
    moq: null,
    source: "ProductRecipe / RecipeMaterial",
    confidence: "n/a",
    issue: "Context only — the live engine prices attached blanks flat until the engine-completeness patch.",
    verify: "Nothing — context",
    fixPage: "Product Setup",
  });
  ownerChecklist.push({
    category: "Legacy tables (context)",
    itemName: `PricingRule (${pricingRuleCount}) / ProductCost (${productCostCount}) / SourcedCostTier (${sourcedCostTierCount})`,
    vendor: "",
    cost: null,
    unit: "",
    tierMinQty: null,
    tierMaxQty: null,
    moq: null,
    source: "Legacy tables",
    confidence: "n/a",
    issue: "Context only — not source of truth; retires with the schema batch.",
    verify: "Nothing — context",
    fixPage: "Cost Health",
  });

  return {
    summary: {
      blankReady: vendorProducts.length > 0 && !areaHasCritical("Blank items"),
      materialsReady: printMaterialRows.length > 0 && !areaHasCritical("Materials"),
      inkReady: inkChannelRows.length > 0 && !areaHasCritical("Ink"),
      machineLaborReady: machines.length > 0 && !areaHasCritical("Machine / labor"),
      vendorTiersReady: vendorProducts.some((p) => p.tiers.length > 0),
      ripReady: ripCount > 0,
      blankCount: vendorProducts.length,
      printMaterialCount: printMaterialRows.length,
      inkChannelCount: inkChannelRows.length,
      machineCount: machines.length,
      tierRowCount: vendorProducts.reduce((sum, p) => sum + p.tiers.length, 0),
      ripCount,
      criticalCount,
      warningCount,
    },
    categories,
    issues: issues.slice(0, 200),
    blankItemRows,
    printMaterialRows,
    inkChannelRows,
    replayTests,
    ownerChecklist,
    approvedUpdates: await previewApprovedCostUpdates(db, shop),
  };
}

const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "white" };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };
const thStyle: React.CSSProperties = { background: "#f3f4f6", textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12 };
const tdStyle: React.CSSProperties = { padding: 8, borderBottom: "1px solid #e5e7eb", fontSize: 12, verticalAlign: "top" };

const confidenceStyle: Record<Confidence, React.CSSProperties> = {
  verified: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  manual: { background: "#e0e7ff", color: "#3730a3", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  seeded: { background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  missing: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
};

function ConfidenceBadge({ value }: { value: Confidence }) {
  return <span style={confidenceStyle[value]}>{CONFIDENCE_LABELS[value]}</span>;
}

const approvedStatusStyle: Record<ApprovedUpdateStatus, React.CSSProperties> = {
  already_correct: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  will_update: { background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  will_create: { background: "#e0e7ff", color: "#3730a3", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  missing_record: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  ambiguous: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  manual_review: { background: "#fee2e2", color: "#991b1b", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  do_not_update: { background: "#e5e7eb", color: "#374151", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
};

export default function CostVerificationRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const applying = navigation.state === "submitting";
  const willUpdateCount = data.approvedUpdates.filter((row) => row.status === "will_update" || row.status === "will_create").length;

  const downloadCsv = () => {
    const csv = buildCsv(
      ["section", "item", "detail", "confidence/severity", "verify", "fixPage"],
      [
        ...data.categories.map((row) => ["category", row.category, `${row.source} — ${row.valueSummary} — ${row.problem}`, CONFIDENCE_LABELS[row.confidence], row.verify, row.fixLabel]),
        ...data.issues.map((issue) => ["issue", `${issue.area}: ${issue.item}`, issue.problem, issue.severity, issue.verify, issue.fixLabel]),
        ...data.replayTests.map((test) => ["replay", `${test.id}: ${test.name}`, test.drivers, test.pending ? "pending" : "ready", test.verify, test.hrefLabel]),
      ],
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "cost-verification-workbook.csv";
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  // 13.2.1: one row per cost fact with blank OWNER STATUS / OWNER NOTES
  // columns — the sheet the owner checks off against invoices.
  const downloadOwnerChecklist = () => {
    const csv = buildCsv([...OWNER_CHECKLIST_HEADER], data.ownerChecklist.map(checklistRowToCells));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "owner-cost-checklist.csv";
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <main style={{ maxWidth: 1280, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <style>{`@media print { .no-print { display: none; } main { background: white; } }`}</style>
      <p className="no-print">
        <Link to="/app/erp/cost-health">← Cost Health</Link> · <Link to="/app/erp/shopify-cost-audit">Shopify Cost Audit</Link> · <Link to="/app/erp/cost-calculator">Cost Calculator</Link> · <Link to="/app/erp/materials">Materials</Link> · <Link to="/app/erp/machines">Machines</Link> · <Link to="/app/erp/vendors">Vendors</Link> · <Link to="/app/erp/vendor-cost-book">Vendor Cost Book</Link> · <Link to="/app/erp/product-setup">Product Setup</Link> · <Link to="/app/erp/print-logs">Print Logs</Link> · <Link to="/app/erp/rip-imports">RIP Imports</Link>
      </p>

      <section style={{ background: "linear-gradient(135deg,#111827,#365314)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>Cost Verification Workbook</h1>
        <p style={{ marginBottom: 0 }}>
          This page verifies the cost data feeding quotes, calculator, and production. It does not update prices, products, Shopify, or recipes.
        </p>
      </section>

      <section style={{ marginTop: 16, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e3a8a", borderRadius: 12, padding: "12px 16px", fontSize: 13 }}>
        <b>How to use this page:</b> ERP costs must be verified against real invoices/vendor sheets before pricing is trusted. Shopify costs are
        merchant-entered <b>helper data only</b> — they prioritize which invoice to pull, they prove nothing. Seeded/default values are not proof
        either: much of the database was seeded from old calculator constants. Work top-down: fix criticals, then verify seeded values, then run
        the replay tests. To mark something verified without a schema change, append a marker like <code>[VERIFIED 2026-07-17 inv#123]</code> to
        the record's notes on its edit page — this workbook detects it and shows the row as Verified. (Machines/ink channels have no notes field;
        their proper verified stamps arrive with the planned schema patch.)
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginTop: 16 }}>
        {[
          { label: "Blank item costs", value: `${data.summary.blankCount} items`, ok: data.summary.blankReady },
          { label: "Material costs", value: `${data.summary.printMaterialCount} print materials`, ok: data.summary.materialsReady },
          { label: "Ink costs", value: `${data.summary.inkChannelCount} channels`, ok: data.summary.inkReady },
          { label: "Machine + labor", value: `${data.summary.machineCount} machines`, ok: data.summary.machineLaborReady },
          { label: "Vendor tiers", value: `${data.summary.tierRowCount} tier rows`, ok: data.summary.vendorTiersReady },
          { label: "RIP actual costs", value: data.summary.ripCount ? `${data.summary.ripCount} GSOQ results` : "none yet", ok: data.summary.ripReady },
          { label: "Known-job tests", value: "0 of 7 recorded", ok: false },
          { label: "Critical issues", value: String(data.summary.criticalCount), ok: data.summary.criticalCount === 0 },
          { label: "Warnings", value: String(data.summary.warningCount), ok: data.summary.warningCount === 0 },
        ].map((card) => (
          <div key={card.label} style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{card.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{card.value}</div>
            <span style={card.ok ? confidenceStyle.verified : confidenceStyle.seeded}>{card.ok ? "Ready" : "Needs work"}</span>
          </div>
        ))}
      </section>

      <section style={{ ...cardStyle, marginTop: 16, border: "2px solid #f59e0b" }}>
        <h2 style={{ marginTop: 0 }}>Approved Cost Updates (owner-only)</h2>
        <p style={{ fontSize: 13, color: "#92400e", background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: 10, padding: "10px 14px" }}>
          <b>Owner / advanced tool.</b> This applies the owner-approved cost truth list (2026-07-17) to ERP vendor cost records. Nothing updates on
          deploy or page load — this table is a read-only preview until you type the confirmation phrase and press Apply. Only unambiguously matched
          rows update, and "Will create" rows (13.2.3: the approved blank bags and DTP 4x5x2 pouch) are created fresh with vendor "Vendor TBD" when
          no clean record exists. Ambiguous/template rows are never touched. No Shopify, quote, production, recipe, or pricing-engine data is affected.
        </p>

        {actionData ? (
          actionData.ok ? (
            <div style={{ border: "1px solid #16a34a", background: "#f0fdf4", color: "#166534", borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 10 }}>
              <b>Applied {actionData.applied.length} update(s)</b> ({actionData.skippedCount} row(s) skipped as not updatable):
              <ul style={{ margin: "6px 0 0 18px" }}>
                {actionData.applied.map((entry) => <li key={entry.key}><b>{entry.label}</b>: {entry.changes.join("; ")}</li>)}
                {!actionData.applied.length ? <li>Nothing needed updating — everything already matched the approved list.</li> : null}
              </ul>
            </div>
          ) : (
            <div style={{ border: "1px solid #ef4444", background: "#fef2f2", color: "#991b1b", borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 10 }}>
              {actionData.error}
            </div>
          )
        ) : null}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Item</th><th style={thStyle}>Status</th><th style={thStyle}>Current app value</th><th style={thStyle}>Approved value</th><th style={thStyle}>Changes on apply</th><th style={thStyle}>Matched record / note</th></tr></thead>
            <tbody>
              {data.approvedUpdates.map((row) => (
                <tr key={row.key}>
                  <td style={tdStyle}><b>{row.label}</b></td>
                  <td style={tdStyle}><span style={approvedStatusStyle[row.status]}>{APPROVED_UPDATE_STATUS_LABELS[row.status]}</span></td>
                  <td style={tdStyle}>{row.currentSummary}</td>
                  <td style={tdStyle}>{row.approvedSummary}</td>
                  <td style={tdStyle}>{row.changes.length ? row.changes.join("; ") : "—"}</td>
                  <td style={tdStyle}>{row.matchedName || "—"}{row.note ? <div style={smallHelp}>{row.note}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {willUpdateCount > 0 ? (
          <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 12 }}>
            <input type="hidden" name="intent" value="applyApprovedCosts" />
            <label style={{ fontSize: 13 }}>
              Type <code>{APPLY_CONFIRM_PHRASE}</code> to apply {willUpdateCount} update(s)/creation(s)<br />
              <input name="confirmPhrase" autoComplete="off" placeholder={APPLY_CONFIRM_PHRASE} style={{ padding: 10, border: "1px solid #d1d5db", borderRadius: 8, width: 280 }} />
            </label>
            <button type="submit" disabled={applying} style={{ background: applying ? "#9ca3af" : "#b45309", color: "white", border: 0, borderRadius: 10, padding: "12px 18px", fontWeight: 800 }}>
              {applying ? "Applying..." : "Apply approved cost updates"}
            </button>
          </Form>
        ) : (
          <div style={{ ...smallHelp, marginTop: 10 }}>No rows need updating — every matched record already matches the approved list.</div>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Master cost-source table</h2>
          <button type="button" className="no-print" onClick={downloadOwnerChecklist} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #16a34a", background: "#f0fdf4", color: "#166534", fontWeight: 700, fontSize: 12 }}>Download Owner Cost Checklist CSV</button>
          <button type="button" className="no-print" onClick={downloadCsv} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 12 }}>Download audit CSV</button>
          <button type="button" className="no-print" onClick={() => window.print()} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 12 }}>Print checklist</button>
        </div>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Category</th><th style={thStyle}>Current source</th><th style={thStyle}>Value / count / range</th><th style={thStyle}>Confidence</th><th style={thStyle}>Problem</th><th style={thStyle}>Owner: verify against</th><th style={thStyle}>Fix page</th></tr></thead>
            <tbody>
              {data.categories.map((row) => (
                <tr key={row.category}>
                  <td style={tdStyle}><b>{row.category}</b></td>
                  <td style={tdStyle}>{row.source}</td>
                  <td style={tdStyle}>{row.valueSummary}</td>
                  <td style={tdStyle}><ConfidenceBadge value={row.confidence} /></td>
                  <td style={tdStyle}>{row.problem}</td>
                  <td style={tdStyle}>{row.verify}</td>
                  <td style={tdStyle}><Link to={row.fixPath}>{row.fixLabel}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Issues to fix ({data.summary.criticalCount} critical, {data.summary.warningCount} warnings)</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Severity</th><th style={thStyle}>Area</th><th style={thStyle}>Item</th><th style={thStyle}>Problem</th><th style={thStyle}>Verify against</th><th style={thStyle}>Fix page</th></tr></thead>
            <tbody>
              {data.issues.map((issue, idx) => (
                <tr key={`${issue.area}-${issue.item}-${idx}`}>
                  <td style={tdStyle}><span style={issue.severity === "critical" ? confidenceStyle.missing : confidenceStyle.seeded}>{issue.severity}</span></td>
                  <td style={tdStyle}>{issue.area}</td>
                  <td style={tdStyle}><b>{issue.item}</b></td>
                  <td style={tdStyle}>{issue.problem}</td>
                  <td style={tdStyle}>{issue.verify}</td>
                  <td style={tdStyle}><Link to={issue.fixPath}>{issue.fixLabel}</Link></td>
                </tr>
              ))}
              {!data.issues.length ? <tr><td colSpan={6} style={{ ...tdStyle, color: "#166534" }}>No issues found — verify remaining seeded values, then run the replay tests.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Blank items (jars / bags / boxes / cans)</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Item</th><th style={thStyle}>Type</th><th style={thStyle}>Vendor</th><th style={thStyle}>Cost / tier band</th><th style={thStyle}>MOQ</th><th style={thStyle}>Confidence</th></tr></thead>
            <tbody>
              {data.blankItemRows.map((row) => (
                <tr key={row.name}>
                  <td style={tdStyle}><b>{row.name}</b></td><td style={tdStyle}>{row.productType}</td><td style={tdStyle}>{row.vendor}</td><td style={tdStyle}>{row.band}</td><td style={tdStyle}>{row.moq}</td><td style={tdStyle}><ConfidenceBadge value={row.confidence} /></td>
                </tr>
              ))}
              {!data.blankItemRows.length ? <tr><td colSpan={6} style={tdStyle}>No vendor products yet — enter blanks via the Vendor Cost Book.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div style={smallHelp}>Fix via <Link to="/app/erp/vendor-cost-book">Vendor Cost Book</Link>; recipes attach blanks in <Link to="/app/erp/product-setup">Product Setup</Link>. Remaining Cost Calculator code presets (bags, soda can) auto-hide once entered here with the matching vendor SKU.</div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Print media / sticker / holographic / laminate</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Material</th><th style={thStyle}>Type</th><th style={thStyle}>$/sqft</th><th style={thStyle}>Purchase → base unit</th><th style={thStyle}>Confidence</th></tr></thead>
            <tbody>
              {data.printMaterialRows.map((row) => (
                <tr key={row.name}>
                  <td style={tdStyle}><b>{row.name}</b></td><td style={tdStyle}>{row.materialType}</td><td style={tdStyle}>{row.costPerSqft > 0 ? money(row.costPerSqft, 4) : "—"}</td><td style={tdStyle}>{row.unitPair}</td><td style={tdStyle}><ConfidenceBadge value={row.confidence} /></td>
                </tr>
              ))}
              {!data.printMaterialRows.length ? <tr><td colSpan={5} style={tdStyle}>No print materials found — add roll media in Materials.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div style={smallHelp}>Fix via <Link to="/app/erp/materials">Materials</Link> (enter invoice price + roll width/length so $/sqft derives).</div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Ink</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>Machine</th><th style={thStyle}>Slot</th><th style={thStyle}>Cost/ml</th><th style={thStyle}>Usage ml/sqft/1%</th><th style={thStyle}>Confidence</th><th style={thStyle}>Flags</th></tr></thead>
            <tbody>
              {data.inkChannelRows.map((row, idx) => (
                <tr key={`${row.machine}-${row.slot}-${idx}`}>
                  <td style={tdStyle}>{row.machine}</td><td style={tdStyle}>{row.slot}</td><td style={tdStyle}>{row.costPerMl > 0 ? money(row.costPerMl, 4) : "—"}</td><td style={tdStyle}>{row.usage}</td><td style={tdStyle}><ConfidenceBadge value={row.confidence} /></td><td style={tdStyle}>{row.flags.join("; ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={smallHelp}>Fix costs via <Link to="/app/erp/machines">Machines</Link>; calibrate usage from <Link to="/app/erp/rip-imports">RIP Imports</Link> / <Link to="/app/erp/print-logs">Print Logs</Link> (Patch 13A formalizes this).</div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Finishing / prepress / packout + Shopify comparison</h2>
        <p style={{ fontSize: 13, color: "#4b5563" }}>
          Cutting, prepress, packout, application seconds, and the $25/hr labor rate are <b>code heuristics in the Cost Calculator</b>, not database
          values — confirm their minutes/seconds against one stopwatched real run. Recipes additionally store application/packing/prepress labor the
          live engine does <b>not</b> price yet (deferred engine-completeness patch). For Shopify: use the <Link to="/app/erp/shopify-cost-audit">Shopify Cost Audit</Link> to
          find ERP-vs-Shopify mismatches fast — but Shopify cost is merchant-entered helper data; it does not verify invoices and does not replace this workbook.
        </p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Known-job replay checklist</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thStyle}>#</th><th style={thStyle}>Job</th><th style={thStyle}>Cost drivers tested</th><th style={thStyle}>What to verify</th><th style={thStyle}>Run</th></tr></thead>
            <tbody>
              {data.replayTests.map((test: ReplayTest) => (
                <tr key={test.id} style={test.pending ? { opacity: 0.6 } : undefined}>
                  <td style={tdStyle}><b>{test.id}</b></td>
                  <td style={tdStyle}>{test.name}</td>
                  <td style={tdStyle}>{test.drivers}</td>
                  <td style={tdStyle}>{test.verify}</td>
                  <td style={tdStyle}>{test.href ? <Link to={test.href}>{test.hrefLabel}</Link> : <span style={{ color: "#6b7280" }}>{test.hrefLabel}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={smallHelp}>Results are not saved yet — record pass/fail and the numbers in docs/GSO_ERP_PROJECT_STATE.md (or the printed checklist) after each run.</div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: "#86efac", background: "#f0fdf4" }}>
        <h2 style={{ marginTop: 0 }}>Next actions, in order</h2>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
          <li>Gather invoices/vendor sheets (Miron, SAFE CARE, media supplier, ink) and verify every seeded/critical row above; mark records with the <code>[VERIFIED ...]</code> notes marker as you go.</li>
          <li>Fix data via <Link to="/app/erp/materials">Materials</Link>, <Link to="/app/erp/vendor-cost-book">Vendor Cost Book</Link>, and <Link to="/app/erp/machines">Machines</Link>.</li>
          <li>Replay the known jobs (T1–T7) and record the results in the state doc.</li>
          <li>Only then: the engine-completeness patch (purchaseCost fallback, vendor-tier blank costing, stored-labor pricing — prices will move; owner approval).</li>
          <li>Only then: multi-design/file groups (12B.1b).</li>
          <li>Only then: the Shopify product publisher.</li>
        </ol>
      </section>
    </main>
  );
}
