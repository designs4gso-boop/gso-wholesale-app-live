import type React from "react";
import { useState } from "react";
import { Form, useActionData, useLoaderData, useLocation, useNavigation, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  MARGIN_FLOOR_PCT,
  OVERRIDE_PHRASE,
  PROVISIONAL_MARGIN_CURVE,
  SUGGESTED_QUANTITIES,
  canFinalize,
  checkMarginGate,
  computeFreight,
  curveForTierCount,
  defaultTierMargins,
  generateTiers,
  marginMath,
  resolveMarginFamily,
  MARGIN_RULE_SOURCE,
  type CostLine,
  type FamilyMarginRule,
} from "../lib/calculator-emergency.server";
import { computeAutoCost, type AutoFamily } from "../lib/auto-costing.server";
import { CUT_TYPES, DOCUMENTED_PRINTER_SQFT_PER_HOUR, DTP_ENGINE_VERSION, DTP_TIER_QUANTITIES, dtpMarginPctForQuantity, MAX_LABELS_PER_UNIT, MULTILABEL_ENGINE_VERSION, PRODUCTION_READY_ENGINE_VERSION, REQUIRED_STICKER_BAG_SIZES, SPEKTRA_FREIGHT_PER_PO, TOP_ENGINE_VERSION, bagSizeToken, blankClassAllowedFor, buildLabelRows, canonicalUiFamily, classifyCalculatorProduct, computeProductDrivenCost, enforceFlatChironCost, formatComponentLabel, marginFamilyKeyFor, mironTopCompatible, normalizeCutType, uiFamilyToEngine, type CalculatorProductClass, type LabelRow, type ProductDrivenInput, type ProductFamilyKey, type ResolvedComponent } from "../lib/product-driven-costing.server";
import { COMMERCIAL_PRICING_VERSION, buildStickerLines, combineStickerLines, computeCommercialPrice, designSplit, marginPctForQuantity } from "../lib/commercial-pricing-policy.server";
import { calculatorFamilies, calculatorFamilyValues, familyByKeyOrAlias } from "../lib/product-family-registry";
import { resolveProductDisplayName } from "../lib/commercial-name-resolver.server";
import { OWNER_STANDARDS } from "../lib/owner-standards";
import { officialMoqForFamily } from "../lib/product-family-sales-rules";
import { DTP_LADDER_QUANTITIES, DTP_PRICING_ENGINE_VERSION, priceDtpQuote } from "../lib/dtp-owner-pricing.server";
import { materialKind } from "../lib/material-classify";
import {
  WIRED_LABOR,
  blankItemCostQty,
  blankItemUnitCostAtQty,
  computeLineCosts,
  designSetupCost,
  glossWhiteSetupApplies,
  resolveMaterialUnitCost,
  resolvePrintMaterialCostPerSqft,
  suggestedPriceFromMargin,
  wiredApplicationRate,
} from "../lib/cost-calculator.server";

type QuoteRipRow = {
  importedAt: string;
  quoteId: string;
  workflow: string;
  source: string;
  fileName: string;
  status: string;
  cyanCc: number;
  magentaCc: number;
  yellowCc: number;
  blackCc: number;
  whiteCc: number;
  clearCc: number;
  totalCc: number;
  ripSeconds: number;
  estimatedInkCost: number;
  confidence: string;
  sourceFile: string;
};

type MaterialOption = {
  id: string;
  name: string;
  materialType: string;
  displayCostPerSqft: number;
  costWarning: string | null;
};

type BlankItemTier = { minQty: number; maxQty: number | null; unitCost: number };

type BlankItemOption = {
  id: string;
  source: "preset" | "material" | "vendor";
  isPreset: boolean;
  name: string;
  productType: string;
  unitCost: number;
  costWarning: string | null;
  tiers?: BlankItemTier[];
  defaultApplicationMode: string;
  applicationKey: string;
  wastePct: number;
  vendor: string;
  sku?: string; // 14C.2: lets the product pickers dedupe material rows that mirror a vendor record
  addOns?: Array<{ name: string; pricingType: string; amount: number; enabled: boolean }>; // 15C: DTP feature spec from VendorProductAddOn
};

type QuoteLine = {
  index: number;
  name: string;
  quantity: number;
  widthIn: number;
  heightIn: number;
  materialId: string;
  customMaterialCostPerSqft: number;
  wastePct: number;
  quoteId: string;
  ripResultMode: string;
  inkEstimateProfile: string;
  customInkCostPerSqft: number;
  labelType: string;
  labelTypeName: string;
  baseSqft: number;
  wasteAdjustedSqft: number;
  effectiveUnits: number;
  materialName: string;
  materialCostPerSqft: number;
  materialCost: number;
  inkSource: string;
  inkCost: number;
  inkCc: number;
  unitCost: number;
  totalCost: number;
  isBlank: boolean;
  isComplete: boolean;
  warnings: string[];
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

// 15F.0G.2: PRINTER-SPECIFIC speeds \u2014 ONE authoritative resolver shared by
// the loader, the save action, and (through the engine) every snapshot and
// production estimate. Source-of-truth rule (documented):
// - Roland: the Machine record (150 sqft/hr, correct) with the 150 baseline
//   as fallback \u2014 the ADDITIVE mode model uses it as the CMYK base.
// - Mimaki UCJV300-130: the ENGINE-OWNED RasterLink combined-layer profile
//   (51.6/18.2/11.8/8.6 sqft/hr x 1.15 turnaround) is authoritative; the
//   Machine record's stale generic speed (still the generic 150; the
//   interim G.1 single-rate value was retired as incorrect) is NOT used for this
//   verified profile, so the resolver passes 0 and the engine's Mimaki
//   branch prices from MIMAKI_UCJV_RASTERLINK_PROFILE.
// No browser-posted throughput is ever trusted (records re-fetched at save).
function resolvePrinterSpeeds(machineRecords: Array<{ name: string; sqftPerHour: number }>): { mimaki: number; roland: number } {
  const recordFor = (pattern: RegExp) => machineRecords.find((machine) => pattern.test(machine.name) && machine.sqftPerHour > 0) || null;
  const rolandRecord = recordFor(/roland/i);
  return {
    mimaki: 0, // engine-owned RasterLink profile governs Mimaki (see note above)
    roland: rolandRecord ? rolandRecord.sqftPerHour : DOCUMENTED_PRINTER_SQFT_PER_HOUR,
  };
}

function parseNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function money(value: number) {
  return `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: number, digits = 3) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fieldNumber(url: URL, name: string, fallback: number) {
  const values = url.searchParams.getAll(name);
  const raw = values.length ? values[values.length - 1] : null;
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getAt<T>(values: T[], index: number, fallback: T) {
  const value = values[index];
  return value === undefined || value === null || value === ("" as T) ? fallback : value;
}

function getNumberAt(values: string[], index: number, fallback: number) {
  const raw = getAt(values, index, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRawRow(rawRow?: string | null) {
  if (!rawRow) return {} as Record<string, unknown>;
  try {
    return JSON.parse(rawRow) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function rowFromEntry(entry: {
  createdAt: Date;
  jobTicket: string | null;
  sourceJobName: string | null;
  printerSoftware: string | null;
  status: string | null;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  printMinutes: number;
  rawRow: string | null;
}): QuoteRipRow {
  const raw = parseRawRow(entry.rawRow);
  return {
    importedAt: cleanText(raw.importedAt) || entry.createdAt.toISOString(),
    quoteId: cleanText(raw.quoteId) || cleanText(entry.jobTicket),
    workflow: cleanText(raw.workflow) || cleanText(entry.status || "cost-calculation"),
    source: cleanText(raw.source) || cleanText(entry.printerSoftware || "quote-rip-sync"),
    fileName: cleanText(raw.fileName) || cleanText(entry.sourceJobName),
    status: cleanText(raw.status) || cleanText(entry.status),
    cyanCc: parseNumber(raw.cyanCc),
    magentaCc: parseNumber(raw.magentaCc),
    yellowCc: parseNumber(raw.yellowCc),
    blackCc: parseNumber(raw.blackCc),
    whiteCc: parseNumber(raw.whiteCc) || entry.whiteInkMl,
    clearCc: parseNumber(raw.clearCc) || entry.glossInkMl,
    totalCc: parseNumber(raw.totalCc) || entry.inkMl,
    ripSeconds: parseNumber(raw.ripSeconds) || Math.round((entry.printMinutes || 0) * 60),
    estimatedInkCost: parseNumber(raw.estimatedInkCost),
    confidence: cleanText(raw.confidence || "medium"),
    sourceFile: cleanText(raw.sourceFile),
  };
}

function uniqueLatestByQuote(rows: QuoteRipRow[]) {
  const seen = new Set<string>();
  const out: QuoteRipRow[] = [];
  for (const row of rows) {
    const key = row.quoteId || row.fileName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function inkEstimateCostPerSqft(profile: string, custom: number) {
  if (profile === "cmyk-heavy") return 0.50;
  if (profile === "cmyk-white-heavy") return 1.00;
  if (profile === "cmyk-gloss-heavy") return 1.00;
  if (profile === "cmyk-white-gloss-heavy") return 1.50;
  if (profile === "cmyk-2x-gloss-heavy") return 1.50;
  if (profile === "cmyk-3x-gloss-heavy") return 2.00;
  if (profile === "cmyk-4x-gloss-heavy") return 2.50;
  if (profile === "custom") return custom;
  return 0.50;
}

function labelTypeName(labelType: string) {
  if (labelType === "side") return "Side label";
  if (labelType === "lid") return "Lid label";
  if (labelType === "lid-side") return "Lid side label";
  if (labelType === "front") return "Front label";
  if (labelType === "back") return "Back label";
  if (labelType === "warning") return "Warning label";
  if (labelType === "box") return "Box label";
  if (labelType === "custom") return "Custom label";
  return "Side label";
}

const PRESET_LABEL = "[Preset — code price, may be stale]";

// Hardcoded blank-item presets. Kept in 12B.1a so daily quoting keeps working,
// but a preset is hidden whenever a DB Vendor Product exists with the same
// vendorSku (the jar ERP seed created exactly those rows), so verified DB data
// automatically supersedes code prices. Remaining presets should be entered as
// Vendor Products with tiers and verified against invoices, then deleted here.
function presetBlankItems(): BlankItemOption[] {
  const mironTiers: Record<string, BlankItemTier[]> = {
    jar50: [
      { minQty: 1, maxQty: 249, unitCost: 2.46 },
      { minQty: 250, maxQty: 499, unitCost: 2.24 },
      { minQty: 500, maxQty: 999, unitCost: 2.03 },
      { minQty: 1000, maxQty: 2499, unitCost: 1.89 },
      { minQty: 2500, maxQty: null, unitCost: 1.74 },
    ],
    jar100Tall: [
      { minQty: 1, maxQty: 249, unitCost: 2.86 },
      { minQty: 250, maxQty: 499, unitCost: 2.63 },
      { minQty: 500, maxQty: 999, unitCost: 2.41 },
      { minQty: 1000, maxQty: 2499, unitCost: 2.22 },
      { minQty: 2500, maxQty: null, unitCost: 2.07 },
    ],
    jar100Wide: [
      { minQty: 1, maxQty: 249, unitCost: 2.90 },
      { minQty: 250, maxQty: 499, unitCost: 2.67 },
      { minQty: 500, maxQty: 999, unitCost: 2.44 },
      { minQty: 1000, maxQty: 2499, unitCost: 2.26 },
      { minQty: 2500, maxQty: null, unitCost: 2.10 },
    ],
    jar150: [
      { minQty: 1, maxQty: 249, unitCost: 3.26 },
      { minQty: 250, maxQty: 499, unitCost: 3.00 },
      { minQty: 500, maxQty: 999, unitCost: 2.76 },
      { minQty: 1000, maxQty: 2499, unitCost: 2.54 },
      { minQty: 2500, maxQty: null, unitCost: 2.37 },
    ],
    jar250: [
      { minQty: 1, maxQty: 249, unitCost: 3.92 },
      { minQty: 250, maxQty: 499, unitCost: 3.60 },
      { minQty: 500, maxQty: 999, unitCost: 3.32 },
      { minQty: 1000, maxQty: 2499, unitCost: 3.11 },
      { minQty: 2500, maxQty: null, unitCost: 2.92 },
    ],
  };
  const fixed = (id: string, name: string, unitCost: number, productType: string, app: string, key: string, wastePct: number, vendor: string): BlankItemOption =>
    ({ id, source: "preset", isPreset: true, name, productType, unitCost, costWarning: null, defaultApplicationMode: app, applicationKey: key, wastePct, vendor });
  const tiered = (id: string, name: string, tiers: BlankItemTier[], key: string): BlankItemOption =>
    ({ id, source: "preset", isPreset: true, name, productType: "jar", unitCost: tiers[0]?.unitCost || 0, costWarning: null, tiers, defaultApplicationMode: "apply-jar", applicationKey: key, wastePct: 2, vendor: "MIRON" });
  return [
    fixed("preset:customer-supplied", "Customer supplied item - $0.00", 0, "customer-supplied", "none", "customer", 0, "Customer"),
    fixed("preset:blank-4x5-bag", "Blank 4x5 bag", 0.09, "bag", "apply-flat-bag", "blank-4x5-bag", 4, "SAFE CARE"),
    fixed("preset:oz-bag", "OZ bag", 0.40, "bag", "apply-flat-bag", "oz-bag", 2, "SAFE CARE"),
    fixed("preset:pound-bag", "Pound bag", 1.00, "bag", "apply-flat-bag", "pound-bag", 2, "SAFE CARE"),
    fixed("preset:3oz-jar-clear", "3oz jar - clear", 0.50, "jar", "apply-jar", "safe-care-jar", 2, "SAFE CARE"),
    fixed("preset:3oz-jar-black-white", "3oz jar - black/white", 0.62, "jar", "apply-jar", "safe-care-jar", 2, "SAFE CARE"),
    fixed("preset:4oz-jar-clear", "4oz jar - clear", 0.60, "jar", "apply-jar", "safe-care-jar", 2, "SAFE CARE"),
    fixed("preset:4oz-jar-black-white", "4oz jar - black/white", 0.65, "jar", "apply-jar", "safe-care-jar", 2, "SAFE CARE"),
    fixed("preset:5oz-jar-clear", "5oz jar - clear", 0.60, "jar", "apply-jar", "safe-care-jar", 2, "SAFE CARE"),
    fixed("preset:soda-can", "Soda can", 0.52, "jar", "apply-jar", "soda-can", 2, "P1"),
    tiered("preset:miron-50ml", "50ml Miron jar + lid", mironTiers.jar50, "miron-50ml"),
    tiered("preset:miron-100ml-tall", "100ml tall Miron jar + lid", mironTiers.jar100Tall, "miron-100ml"),
    tiered("preset:miron-100ml-wide", "100ml wide Miron jar + lid", mironTiers.jar100Wide, "miron-100ml"),
    tiered("preset:miron-150ml", "150ml Miron jar + lid", mironTiers.jar150, "miron-150ml"),
    tiered("preset:miron-250ml", "250ml Miron jar + lid", mironTiers.jar250, "miron-250ml"),
  ];
}

// Default application mode for DB-backed blank/vendor items, mirroring the
// preset behavior so picking a seeded jar suggests jar application.
function defaultApplicationModeFor(typeText: string) {
  const type = String(typeText || "").toLowerCase();
  if (type.includes("jar") || type.includes("can")) return "apply-jar";
  if (type.includes("bag") || type.includes("pouch")) return "apply-flat-bag";
  if (type.includes("box")) return "apply-box";
  if (type.includes("tube")) return "apply-tube";
  return "none";
}

function secondsForKnownApplication(item: BlankItemOption | null, line: Pick<QuoteLine, "labelType" | "widthIn" | "heightIn">, mode: string) {
  const labelType = line.labelType || "side";
  const area = Math.max((line.widthIn || 0) * (line.heightIn || 0), 1);
  const key = item?.applicationKey || "";
  if (mode === "apply-flat-bag") {
    if (key === "blank-4x5-bag") return 10;
    if (key === "oz-bag") return 12;
    if (key === "pound-bag") return 15;
    return 10;
  }
  if (mode === "apply-jar" || mode === "apply-tube") {
    if (key === "soda-can") return 10;
    if (key === "safe-care-jar") return labelType === "lid" || labelType === "lid-side" ? 8 : 10;
    if (key === "miron-50ml" || key === "miron-100ml") {
      if (labelType === "lid") return 10;
      if (labelType === "lid-side") return 12;
      return 12;
    }
    if (key === "miron-150ml") {
      if (labelType === "lid") return 10;
      if (labelType === "lid-side") return 12;
      return 13;
    }
    if (key === "miron-250ml") {
      if (labelType === "lid") return 10;
      if (labelType === "lid-side") return 12;
      return 15;
    }
    return labelType === "lid" ? 8 : 10;
  }
  if (mode === "apply-box") return Math.max(5, 4 + area * 0.12);
  return 0;
}

function estimateApplicationRule(mode: string, avgLabelSqIn: number, labelsPerItem: number) {
  const safeSqIn = Math.max(avgLabelSqIn || 0, 1);
  const safeLabels = Math.max(labelsPerItem || 1, 1);

  if (mode === "apply-flat-bag") {
    return { name: "Apply label to flat bag/pouch", secondsPerUnit: Math.max(4, 3 + safeSqIn * 0.12), setupMinutes: 5, extraCostPerUnit: 0 };
  }
  if (mode === "apply-jar") {
    return { name: "Apply label to jar", secondsPerUnit: Math.max(6, 5 + safeSqIn * 0.15), setupMinutes: 10, extraCostPerUnit: 0 };
  }
  if (mode === "apply-box") {
    return { name: "Apply label to box", secondsPerUnit: Math.max(5, 4 + safeSqIn * 0.12), setupMinutes: 7, extraCostPerUnit: 0 };
  }
  if (mode === "apply-tube") {
    return { name: "Apply label to round tube", secondsPerUnit: Math.max(7, 6 + safeSqIn * 0.18), setupMinutes: 10, extraCostPerUnit: 0 };
  }
  if (mode === "apply-label-set") {
    return { name: "Apply full label set to item", secondsPerUnit: Math.max(6, 4 + safeSqIn * 0.13) * safeLabels, setupMinutes: 10, extraCostPerUnit: 0 };
  }
  if (mode === "custom") {
    return { name: "Custom application", secondsPerUnit: 0, setupMinutes: 0, extraCostPerUnit: 0 };
  }
  return { name: "No application", secondsPerUnit: 0, setupMinutes: 0, extraCostPerUnit: 0 };
}

function cuttingRule(mode: string, qty: number, customMinutes: number, customFlatCost: number, laborRatePerHour: number) {
  const safeQty = Math.max(qty || 0, 0);
  const rules: Record<string, { name: string; setupMinutes: number; secondsPerUnit: number; flatCost: number }> = {
    none: { name: "No cutting / finishing", setupMinutes: 0, secondsPerUnit: 0, flatCost: 0 },
    square: { name: "Square/rectangle cut", setupMinutes: 5, secondsPerUnit: 1, flatCost: 0 },
    contour: { name: "Contour cut", setupMinutes: 10, secondsPerUnit: 4, flatCost: 0 },
    diecut: { name: "Die-cut sticker", setupMinutes: 15, secondsPerUnit: 6, flatCost: 0 },
    sheet: { name: "Sheet cut / trim down", setupMinutes: 5, secondsPerUnit: 2, flatCost: 0 },
    weed: { name: "Weeded decal", setupMinutes: 10, secondsPerUnit: 8, flatCost: 0 },
  };
  if (mode === "custom") {
    const minutes = Math.max(customMinutes || 0, 0);
    return { name: "Custom cutting / finishing", minutes, cost: Math.max(customFlatCost || 0, 0) + (minutes / 60) * laborRatePerHour };
  }
  const rule = rules[mode] || rules.none;
  const minutes = rule.setupMinutes + (safeQty * rule.secondsPerUnit) / 60;
  return { name: rule.name, minutes, cost: rule.flatCost + (minutes / 60) * laborRatePerHour };
}

// prepressRule was replaced in 13A.3 by designSetupCost (owner standard:
// art + print setup per design; cut setup included). See cost-calculator.server.ts.

function packoutRule(mode: string, qty: number, customUnitCost: number, customFlatCost: number) {
  const safeQty = Math.max(qty || 0, 0);
  const rules: Record<string, { name: string; unitCost: number; flatCost: number }> = {
    none: { name: "No packout", unitCost: 0, flatCost: 0 },
    standard: { name: "Standard packout", unitCost: 0.02, flatCost: 2 },
    bulk: { name: "Bulk packout", unitCost: 0.01, flatCost: 2 },
    individual: { name: "Individual packout", unitCost: 0.05, flatCost: 5 },
  };
  if (mode === "custom") {
    const unitCost = Math.max(customUnitCost || 0, 0);
    const flatCost = Math.max(customFlatCost || 0, 0);
    return { name: "Custom packout", unitCost, flatCost, cost: flatCost + safeQty * unitCost };
  }
  const rule = rules[mode] || rules.none;
  return { name: rule.name, unitCost: rule.unitCost, flatCost: rule.flatCost, cost: rule.flatCost + safeQty * rule.unitCost };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const appOrigin = new URL(request.url).origin;

  // Read-only since 12B.1a: the RIP sync settings row is created by the RIP
  // Imports / Print Intake / Print Log Settings pages, never by this route.
  const [setting, entries, materialRecords, vendorProducts, machineRecords] = await Promise.all([
    db.printLogAutoImportSetting.findUnique({ where: { shop } }),
    db.printLogEntry.findMany({
      where: { shop, jobTicket: { startsWith: "GSOQ-" }, inkMl: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.material.findMany({
      where: { shop, active: true, useInRecipes: true },
      orderBy: [{ materialType: "asc" }, { name: "asc" }],
      take: 200,
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true },
      include: { tiers: { orderBy: { minQty: "asc" } }, addOns: { orderBy: { name: "asc" } } },
      orderBy: [{ productType: "asc" }, { name: "asc" }],
      take: 200,
    }),
    // 15F.0-D: verified machine speeds for machine-recovery time (printers only)
    db.machine.findMany({ where: { shop, active: true, machineType: "printer" }, select: { name: true, sqftPerHour: true } }),
  ]);
  const printerSqftPerHour = resolvePrinterSpeeds(machineRecords);

  const rows = uniqueLatestByQuote(entries.map(rowFromEntry));
  const rowById = new Map(rows.map((row) => [row.quoteId, row]));

  // Print media dropdown: real DB materials only (12B.1a). The old hardcoded
  // roll presets and name-based price overrides are gone; costs come from
  // calculatedUnitCost/costPerUnit and never from raw purchaseCost.
  const materials: MaterialOption[] = materialRecords
    .filter((m) => materialKind(m) === "print")
    .map((m) => {
      const resolved = resolvePrintMaterialCostPerSqft(m);
      return {
        id: m.id,
        name: m.name,
        materialType: m.materialType,
        displayCostPerSqft: resolved.unitCost,
        costWarning: resolved.warning,
      };
    });
  const materialById = new Map(materials.map((m) => [m.id, m]));

  const dbBlankItems: BlankItemOption[] = materialRecords
    .filter((m) => materialKind(m) === "blank")
    .slice(0, 100)
    .map((m) => {
      const resolved = resolveMaterialUnitCost(m);
      return {
        id: `material:${m.id}`,
        source: "material" as const,
        isPreset: false,
        name: m.name,
        productType: m.materialType,
        unitCost: resolved.unitCost,
        costWarning: resolved.warning,
        defaultApplicationMode: defaultApplicationModeFor(`${m.materialType} ${m.name}`),
        applicationKey: "custom",
        wastePct: 0,
        vendor: m.vendor || "Saved material",
        sku: cleanText(m.sku),
      };
    });

  const dbVendorItems: BlankItemOption[] = vendorProducts.slice(0, 100).map((p) => ({
    id: `vendor:${p.id}`,
    source: "vendor" as const,
    isPreset: false,
    name: p.name,
    productType: p.productType,
    unitCost: p.defaultUnitCost || 0,
    costWarning:
      (p.defaultUnitCost || 0) > 0 || (p.tiers || []).length
        ? null
        : `${p.name} has no unit cost or cost tiers. Set them in the Vendor Cost Book.`,
    tiers: (p.tiers || []).map((t) => ({ minQty: t.minQty, maxQty: t.maxQty, unitCost: t.unitCost })),
    defaultApplicationMode: defaultApplicationModeFor(`${p.productType} ${p.name}`),
    applicationKey: "custom",
    wastePct: 2,
    vendor: p.vendor || "Vendor product",
    sku: cleanText(p.vendorSku),
    addOns: (p.addOns || []).map((addOn: any) => ({ name: addOn.name, pricingType: String(addOn.pricingType || ""), amount: Number(addOn.amount) || 0, enabled: Boolean(addOn.enabled) })),
  }));

  // Hide code presets that the jar ERP seed already copied into VendorProduct
  // rows (matched by vendorSku === preset id): DB data supersedes code prices.
  const seededVendorSkus = new Set(
    vendorProducts.map((p) => cleanText(p.vendorSku)).filter(Boolean),
  );
  const presetItems = presetBlankItems().filter((item) => !seededVendorSkus.has(item.id));

  const blankItems: BlankItemOption[] = [...dbBlankItems, ...dbVendorItems, ...presetItems];
  const blankItemById = new Map(blankItems.map((item) => [item.id, item]));

  const quoteMode = cleanText(url.searchParams.get("quoteMode") || "estimated");
  const targetMarginPct = fieldNumber(url, "targetMarginPct", 40);
  const laborRatePerHour = fieldNumber(url, "laborRatePerHour", 25);
  const machineCostPerHour = fieldNumber(url, "machineCostPerHour", 8);
  const setupMinutes = fieldNumber(url, "setupMinutes", 10);
  const finishingMinutes = fieldNumber(url, "finishingMinutes", 0);
  const lineCount = Math.min(Math.max(Math.round(fieldNumber(url, "lineCount", 1)), 1), 8);

  const lineNames = url.searchParams.getAll("lineName");
  const lineQtys = url.searchParams.getAll("lineQty");
  const lineWidths = url.searchParams.getAll("lineWidthIn");
  const lineHeights = url.searchParams.getAll("lineHeightIn");
  const lineMaterials = url.searchParams.getAll("lineMaterialId");
  const customMaterialCosts = url.searchParams.getAll("lineCustomMaterialCostPerSqft");
  const lineWastes = url.searchParams.getAll("lineWastePct");
  const lineQuoteIds = url.searchParams.getAll("lineQuoteId");
  const lineRipModes = url.searchParams.getAll("lineRipResultMode");
  const lineInkProfiles = url.searchParams.getAll("lineInkEstimateProfile");
  const lineCustomInkCosts = url.searchParams.getAll("lineCustomInkCostPerSqft");
  const lineLabelTypes = url.searchParams.getAll("lineLabelType");

  const lines: QuoteLine[] = Array.from({ length: lineCount }, (_, index) => {
    const name = cleanText(getAt(lineNames, index, ""));
    const quantity = getNumberAt(lineQtys, index, 0);
    const widthIn = getNumberAt(lineWidths, index, 0);
    const heightIn = getNumberAt(lineHeights, index, 0);
    const materialId = cleanText(getAt(lineMaterials, index, ""));
    const customMaterialCostPerSqft = getNumberAt(customMaterialCosts, index, 0);
    const wastePct = getNumberAt(lineWastes, index, 10);
    const quoteId = cleanText(getAt(lineQuoteIds, index, ""));
    const ripResultMode = cleanText(getAt(lineRipModes, index, "per-piece"));
    const inkEstimateProfile = cleanText(getAt(lineInkProfiles, index, "cmyk-heavy"));
    const customInkCostPerSqft = getNumberAt(lineCustomInkCosts, index, 0);
    const labelType = cleanText(getAt(lineLabelTypes, index, "side"));
    const material = materialById.get(materialId);
    const isBlank = !name && quantity <= 0 && widthIn <= 0 && heightIn <= 0 && !materialId && !quoteId;
    const warnings: string[] = [];
    if (!isBlank) {
      if (quantity <= 0) warnings.push("Qty required");
      if (widthIn <= 0) warnings.push("Width required");
      if (heightIn <= 0) warnings.push("Height required");
      if (!materialId) warnings.push("Material required");
      if (materialId === "custom" && customMaterialCostPerSqft <= 0) warnings.push("Custom material cost required");
      if (materialId && materialId !== "custom" && !material) warnings.push("Saved material not found - reselect the material");
      if (material?.costWarning) warnings.push(material.costWarning);
      if (quoteMode === "actual" && !quoteId) warnings.push("GSOQ RIP result required");
      if (quoteMode === "estimated" && inkEstimateProfile === "custom" && customInkCostPerSqft <= 0) warnings.push("Custom ink cost required");
    }
    const isComplete = !isBlank && warnings.length === 0;
    const materialCostPerSqft = isComplete
      ? materialId === "custom"
        ? customMaterialCostPerSqft
        : material?.displayCostPerSqft || 0
      : 0;
    const ripRow = rowById.get(quoteId) || null;
    const useActualRip = isComplete && quoteMode === "actual" && ripRow;
    const ripIsPerPiece = ripResultMode !== "full-job";
    const inkMode = useActualRip ? (ripIsPerPiece ? ("actual-per-piece" as const) : ("actual-full-job" as const)) : ("estimated" as const);
    const costs = computeLineCosts({
      quantity: isComplete ? quantity : 0,
      widthIn,
      heightIn,
      wastePct,
      materialCostPerSqft,
      inkMode,
      estimatedInkCostPerSqft: isComplete ? inkEstimateCostPerSqft(inkEstimateProfile, customInkCostPerSqft) : 0,
      ripInkCost: ripRow?.estimatedInkCost || 0,
      ripInkCc: ripRow?.totalCc || 0,
    });
    return {
      index,
      name,
      quantity,
      widthIn,
      heightIn,
      materialId,
      customMaterialCostPerSqft,
      wastePct,
      quoteId,
      ripResultMode,
      inkEstimateProfile,
      customInkCostPerSqft,
      labelType,
      labelTypeName: labelTypeName(labelType),
      baseSqft: costs.baseSqft,
      wasteAdjustedSqft: costs.wasteAdjustedSqft,
      effectiveUnits: costs.effectiveUnits,
      materialName: materialId === "custom" ? "Custom material" : material?.name || "Custom material",
      materialCostPerSqft,
      materialCost: costs.materialCost,
      inkSource: useActualRip ? `Actual RIP ${ripRow.quoteId}` : `Estimated ${inkEstimateProfile}`,
      inkCost: costs.inkCost,
      inkCc: costs.inkCc,
      unitCost: costs.unitCost,
      totalCost: costs.totalCost,
      isBlank,
      isComplete,
      warnings,
    };
  });

  const completeLines = lines.filter((line) => line.isComplete);
  const primaryQuantity = Math.max(completeLines[0]?.quantity || lines[0]?.quantity || 0, 1);
  const totalLabelApplications = completeLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalLabelAreaSqIn = completeLines.reduce((sum, line) => sum + line.quantity * line.widthIn * line.heightIn, 0);
  const averageLabelSqIn = totalLabelApplications > 0 ? totalLabelAreaSqIn / totalLabelApplications : 0;

  const itemMode = cleanText(url.searchParams.get("itemMode") || "none");
  const itemId = cleanText(url.searchParams.get("itemId") || "custom");
  const itemQty = itemMode === "none" ? 0 : primaryQuantity;
  const customItemName = cleanText(url.searchParams.get("customItemName") || "Custom item");
  const customItemUnitCost = fieldNumber(url, "customItemUnitCost", 0);
  const selectedItem = blankItemById.get(itemId) || null;
  const itemWastePct = itemMode === "inventory" ? selectedItem?.wastePct || 0 : 0;
  const itemCostQty = itemMode === "none" ? 0 : blankItemCostQty(itemQty, itemWastePct);
  const itemTierResult =
    itemMode === "inventory" && selectedItem
      ? blankItemUnitCostAtQty(selectedItem.tiers, selectedItem.unitCost, itemQty, selectedItem.name)
      : null;
  const itemUnitCost = itemMode === "none" ? 0 : itemId === "custom" ? customItemUnitCost : itemTierResult?.unitCost || 0;
  const itemTierLabel = itemTierResult?.tierLabel || "fixed";
  const itemName = itemMode === "none" ? "No blank item" : itemId === "custom" ? customItemName : selectedItem?.name || "Selected item";
  const itemCost = itemCostQty * itemUnitCost;

  const rawApplicationMode = url.searchParams.get("applicationMode");
  const applicationMode = cleanText(rawApplicationMode || (itemMode === "inventory" ? selectedItem?.defaultApplicationMode || "none" : "none"));
  const applicationRule = estimateApplicationRule(applicationMode, averageLabelSqIn, lines.length);
  const customApplicationSecondsPerUnit = fieldNumber(url, "applicationSecondsPerUnit", 8);
  const customApplicationUnitCost = fieldNumber(url, "applicationUnitCost", 0);
  // 13A.3: comparable application labor uses OWNER STANDARDS (per-application
  // dollar rates; sides = label lines; no extra setup minutes — the standard
  // is all-in). Unmapped combinations (oz bags, generic bags, boxes, tubes,
  // label sets, custom) keep the legacy seconds heuristic.
  const wiredAppRate = applicationMode === "custom" || applicationMode === "none"
    ? null
    : wiredApplicationRate(applicationMode, `${selectedItem?.applicationKey || ""} ${selectedItem?.name || ""}`);
  const applicationSetupMinutes = applicationMode === "none" || wiredAppRate != null ? 0 : applicationMode === "apply-flat-bag" ? 5 : applicationMode === "apply-box" ? 8 : 10;
  const applicationLineDetails = applicationMode === "none" ? [] : completeLines.map((line) => {
    const apps = line.quantity;
    if (wiredAppRate != null) {
      return { lineIndex: line.index, lineName: line.name, labelType: line.labelTypeName, apps, seconds: 0, minutes: 0, wired: true, ratePerApp: wiredAppRate, laborCost: apps * wiredAppRate };
    }
    const seconds = applicationMode === "custom" ? customApplicationSecondsPerUnit : secondsForKnownApplication(selectedItem, line, applicationMode) || applicationRule.secondsPerUnit;
    const minutes = (apps * seconds) / 60;
    return { lineIndex: line.index, lineName: line.name, labelType: line.labelTypeName, apps, seconds, minutes, wired: false, ratePerApp: null as number | null, laborCost: (minutes / 60) * laborRatePerHour };
  });
  const applicationQty = applicationMode === "none" ? 0 : applicationLineDetails.reduce((sum, line) => sum + line.apps, 0);
  const applicationSecondsPerUnit = applicationMode === "none" ? 0 : applicationLineDetails.length ? applicationLineDetails.reduce((sum, line) => sum + line.seconds, 0) / applicationLineDetails.length : 0;
  const applicationUnitCost = applicationMode === "custom" ? customApplicationUnitCost : applicationRule.extraCostPerUnit;
  const applicationMinutesBeforeSetup = applicationLineDetails.reduce((sum, line) => sum + line.minutes, 0);
  const applicationLaborMinutes = applicationMode === "none" ? 0 : applicationSetupMinutes + applicationMinutesBeforeSetup;
  const applicationLaborCost = wiredAppRate != null
    ? applicationLineDetails.reduce((sum, line) => sum + line.laborCost, 0)
    : (applicationLaborMinutes / 60) * laborRatePerHour + applicationQty * applicationUnitCost;

  const cuttingMode = cleanText(url.searchParams.get("cuttingMode") || "none");
  const cuttingCustomMinutes = fieldNumber(url, "cuttingCustomMinutes", 0);
  const cuttingCustomFlatCost = fieldNumber(url, "cuttingCustomFlatCost", 0);
  const cutting = cuttingRule(cuttingMode, primaryQuantity, cuttingCustomMinutes, cuttingCustomFlatCost, laborRatePerHour);

  // 13A.3: preset prepress modes are replaced by the owner design-setup
  // standard (art + print per design, 1 design; cut setup included). "custom"
  // stays a user override; "none" stays $0.
  const prepressMode = cleanText(url.searchParams.get("prepressMode") || "none");
  const prepressCustomMinutes = fieldNumber(url, "prepressCustomMinutes", 0);
  const prepressCustomFlatCost = fieldNumber(url, "prepressCustomFlatCost", 0);
  const prepress = designSetupCost(prepressMode, prepressCustomMinutes, prepressCustomFlatCost, laborRatePerHour);

  // 13A.3: gloss/white SETUP labor (owner standard, once per job) whenever any
  // line prints white/gloss — estimated profile or actual RIP ink. Labor only;
  // ink usage profiles unchanged.
  const glossWhiteApplies = glossWhiteSetupApplies({
    estimatedProfiles: quoteMode === "estimated" ? completeLines.map((line) => line.inkEstimateProfile) : [],
    ripWhiteOrGlossCc: quoteMode === "actual"
      ? completeLines.reduce((sum, line) => {
          const row = rowById.get(line.quoteId);
          return sum + (row ? (row.whiteCc || 0) + (row.clearCc || 0) : 0);
        }, 0)
      : 0,
  });
  const glossWhiteSetupCost = glossWhiteApplies ? WIRED_LABOR.glossWhiteSetupPerJob : 0;

  const packoutMode = cleanText(url.searchParams.get("packoutMode") || "none");
  const packoutCustomUnitCost = fieldNumber(url, "packoutCustomUnitCost", 0);
  const packoutCustomFlatCost = fieldNumber(url, "packoutCustomFlatCost", 0);
  const packout = packoutRule(packoutMode, primaryQuantity, packoutCustomUnitCost, packoutCustomFlatCost);

  const safetyWarnings: string[] = [];
  if (itemMode !== "none" && applicationMode === "none") safetyWarnings.push("Blank item selected but application is No application. If GSO is applying labels, choose an application type.");
  if (applicationMode !== "none" && itemMode === "none") safetyWarnings.push("Application selected but no blank item/product is selected. Confirm this is intentional.");
  if (itemMode === "inventory" && selectedItem?.costWarning) safetyWarnings.push(selectedItem.costWarning);
  if (itemTierResult?.warning) safetyWarnings.push(itemTierResult.warning);
  if (itemMode === "inventory" && selectedItem && itemUnitCost <= 0 && selectedItem.id !== "preset:customer-supplied") {
    safetyWarnings.push(`${selectedItem.name} resolved to $0.00 unit cost. The blank item cost below is not included until its cost is fixed.`);
  }
  if (completeLines.length > 1) {
    const quantities = [...new Set(completeLines.map((line) => line.quantity))];
    if (quantities.length > 1) safetyWarnings.push("Multiple label lines have different quantities. Confirm this is intentional before quoting.");
  }

  const lineMaterialCost = lines.reduce((sum, line) => sum + line.materialCost, 0);
  const lineInkCost = lines.reduce((sum, line) => sum + line.inkCost, 0);
  const lineBaseSqft = lines.reduce((sum, line) => sum + line.baseSqft, 0);
  const lineWasteAdjustedSqft = lines.reduce((sum, line) => sum + line.wasteAdjustedSqft, 0);
  const lineInkCc = lines.reduce((sum, line) => sum + line.inkCc, 0);
  const setupAndFinishingMinutes = setupMinutes + finishingMinutes;
  const processLaborCost = (setupAndFinishingMinutes / 60) * laborRatePerHour;
  const processMachineCost = (setupAndFinishingMinutes / 60) * machineCostPerHour;
  const cuttingCost = cutting.cost;
  const prepressCost = prepress.cost;
  const packoutCost = packout.cost;
  const totalCost = lineMaterialCost + lineInkCost + itemCost + applicationLaborCost + glossWhiteSetupCost + processLaborCost + processMachineCost + cuttingCost + prepressCost + packoutCost;
  const unitCost = totalCost / primaryQuantity;
  const suggestedTotal = suggestedPriceFromMargin(totalCost, targetMarginPct);
  const suggestedUnit = suggestedTotal / primaryQuantity;
  const grossProfit = suggestedTotal - totalCost;

  // ---- 14B.0 emergency panel (server-computed from GET params; ONE path) ----
  const eparams = new URL(request.url).searchParams;
  const eQuantities = String(eparams.get("eqty") || SUGGESTED_QUANTITIES.slice(0, 5).join(",")).split(",").map((value) => Number(value.trim())).filter((value) => value > 0);
  const eMarginsRaw = String(eparams.get("emargin") || "").split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
  const eFamilyRule = resolveMarginFamily(eparams.get("efamily"));
  const eDefaults = eFamilyRule ? curveForTierCount(eFamilyRule.curve, eQuantities.length, eFamilyRule.familyMinPct) : defaultTierMargins(eQuantities.length);
  const eMargins = eMarginsRaw.length === eQuantities.length ? eMarginsRaw : eDefaults;
  // 14B.1: AUTO mode — compute variable+setup from family inputs through the
  // pure engine (manual entries remain the labeled fallback).
  const eMode = eparams.get("emode") === "auto" && eFamilyRule ? "auto" : "manual";
  let eVar = Number(eparams.get("evar") || 0);
  let eSetup = Number(eparams.get("esetup") || 0);
  const eBlank = Number(eparams.get("eblank") || 0);
  const eWaste = Number(eparams.get("ewaste") || 0);
  let autoCost: ReturnType<typeof computeAutoCost> | null = null;
  if (eMode === "auto") {
    const familyMap: Record<string, AutoFamily> = { "bags-4x5": "bags-4x5", "chiron-jars": "chiron-jars", "miron-jars": "miron-jars", "stickers-labels": "stickers-labels", "banners": "banners" };
    const autoFamily = familyMap[eFamilyRule!.key];
    if (autoFamily) {
      autoCost = computeAutoCost(autoFamily, {
        quantity: eQuantities[eQuantities.length - 1] || 1,
        designs: Number(eparams.get("edesigns") || 0),
        sides: eparams.get("esides") === "2" ? 2 : 1,
        labelWidthIn: Number(eparams.get("ewidth") || 0),
        labelHeightIn: Number(eparams.get("eheight") || 0),
        materialCostPerSqft: Number(eparams.get("ematsqft") || 0) > 0 ? Number(eparams.get("ematsqft")) : null,
        materialLabel: String(eparams.get("ematlabel") || "Material"),
        printer: eparams.get("eprinter") === "roland" ? "roland" : "mimaki",
        whiteInk: eparams.get("ewhite") === "1",
        spotGloss: eparams.get("egloss") === "1",
        inkMlPerSqft: Number(eparams.get("einkml") || 0.6),
        machineMinutesPerSqft: Number(eparams.get("emachmin") || 0),
        machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value, // provisional owner standard (15B: single source)
        blankUnitCost: eBlank > 0 ? eBlank : null,
        blankLabel: String(eparams.get("eblanklabel") || "Blank item"),
        lidUnitCost: Number(eparams.get("elid") || 0) > 0 ? Number(eparams.get("elid")) : null,
        lidLabel: String(eparams.get("elidlabel") || "Miron lid"),
        boxes: Number(eparams.get("eboxes") || 0),
        wastePct: eparams.get("ewaste") ? eWaste : -1,
        freightPerUnit: 0 /* freight added once by the panel pipeline */,
        freightSource: "estimated",
        cutIsProvisional: true,
        weedingPages: Number(eparams.get("eweedpages") || 0),
        hemming: eparams.get("ehem") === "1",
        grommets: eparams.get("egrommet") === "1",
      });
      eVar = autoCost.perUnitVariable;
      eSetup = autoCost.setupTotal;
    }
  }

  // ---- 14C.1 product-driven mode: user posts IDs + business inputs only;
  // every cost/sqft/waste/box/weeding value is derived HERE from resolved
  // records. Overrides the 14B.1 path when pfamily is present.
  // 14C.1B1 helpers: canonical top types render even when no separate top
  // records exist yet (data limitation) — unverifiable picks stay Draft Only.
  const CANONICAL_TOPS = [
    { value: "type:standard-top", label: "Standard / Classic top" },
    { value: "type:black-metal-top", label: "Black metal top" },
  ];
  const resolveTopSelection = (rawId: string, picked: any): ResolvedComponent | null => {
    if (rawId.startsWith("type:")) {
      const canonical = CANONICAL_TOPS.find((top) => top.value === rawId);
      return canonical ? { name: canonical.label, unitCost: null, tiers: [], status: "estimated", note: "Canonical top type — no Vendor Cost Book record yet." } : null;
    }
    return picked ? { name: picked.name, unitCost: Number(picked.unitCost) > 0 ? Number(picked.unitCost) : null, tiers: picked.tiers || [], status: "verified" as const } : null;
  };
  const standardTopCost = (entries: Array<{ item: any; klass: CalculatorProductClass }>): number | null => {
    const standard = entries.find((entry) => entry.klass === "miron_top" && /standard|classic/i.test(entry.item.name) && Number(entry.item.unitCost) > 0);
    return standard ? Number(standard.item.unitCost) : null;
  };
  let productCost: ReturnType<typeof computeProductDrivenCost> | null = null;
  let classified: Array<{ item: any; klass: CalculatorProductClass; includesTop: boolean }> = [];
  let selectedClass: CalculatorProductClass | null = null;
  let selectedIncludesTop = false;
  let topRequired = false;
  let autoBag: any = null;
  let bagRecords: Array<{ item: any }> = [];
  let pickedBlankRef: any = null;
  let labelRowsP: LabelRow[] | null = null;
  let labelCountP = 1;
  let sameSizeP = true;
  let canonicalBagOptions: Array<{ value: string; label: string }> = [];
  let productTiers: any[] | null = null;
  let productMultiLine: any = null; // 15F.0-K multi-line sticker jobs
  let productMarginRule: FamilyMarginRule | null = null;
  let productMarginKey: string | null = null;
  let requestedQtyP = 0;
  const pFamily = String(eparams.get("pfamily") || "");
  // 15B: accepted values come from the shared registry (canonical + legacy
  // aliases of calculator-ENABLED families — reserved dtp-bags stays out).
  if (pFamily && calculatorFamilyValues().includes(pFamily)) {
    // 14C.1B: classify every option once; family pickers filter by class.
    classified = blankItems.map((item) => ({ item, ...classifyCalculatorProduct({ name: item.name, productType: item.productType, vendor: item.vendor, vendorSku: item.sku }) }));
    // 14C.2 dedupe: a Material row that mirrors a VendorProduct record (same
    // sku or same normalized name) is dropped from the pickers — the vendor
    // record carries the quantity tiers and is the costing source of truth.
    const normKey = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const vendorKeys = new Set(
      classified
        .filter((entry: any) => String(entry.item.id).startsWith("vendor:"))
        .flatMap((entry: any) => [normKey(entry.item.name), normKey(entry.item.sku || "")])
        .filter(Boolean),
    );
    classified = classified.filter((entry: any) => !(
      String(entry.item.id).startsWith("material:")
      && (vendorKeys.has(normKey(entry.item.name)) || (entry.item.sku && vendorKeys.has(normKey(entry.item.sku))))
    ));
    const isBagFamily = pFamily === "bags-4x5" || pFamily === "sticker-bags";
    // 14C.2A: unpriced bag records stay VISIBLE (labeled NO PRICE — not
    // verified; quotes stay Draft Only) and owner-required sizes without a
    // record render as canonical NO PRICE options. A cost is never guessed.
    bagRecords = classified.filter((entry: any) => entry.klass === "bag_sticker");
    const presentBagSizes = new Set(bagRecords.map((entry: any) => bagSizeToken(entry.item.name)).filter(Boolean));
    canonicalBagOptions = isBagFamily
      ? REQUIRED_STICKER_BAG_SIZES.filter((size) => !presentBagSizes.has(size)).map((size) => ({ value: `type:bag-${size}`, label: `${size} Sticker Bag — NO PRICE — not verified` }))
      : [];
    autoBag = isBagFamily && bagRecords.length === 1 ? (bagRecords[0] as any).item : null;
    const requestedBlankId = String(eparams.get("pblank") || "") || (autoBag ? autoBag.id : "");
    let pickedBlank = blankItemById.get(requestedBlankId) || null;
    let pickedEntry = pickedBlank ? classified.find((entry) => entry.item.id === pickedBlank!.id) : null;
    // family-switch safety: a selection that is not valid for THIS family
    // (stale Chiron/Miron/bag id from a previous family, or a deduped
    // material row) is treated as no selection — never silently re-priced.
    if (pickedBlank && (!pickedEntry || !blankClassAllowedFor(pFamily, pickedEntry.klass))) {
      pickedBlank = null;
      pickedEntry = null;
    }
    pickedBlankRef = pickedBlank || null;
    selectedClass = pickedEntry ? pickedEntry.klass : null;
    selectedIncludesTop = pickedEntry ? pickedEntry.includesTop : false;
    topRequired = (pFamily === "premium-jars" || pFamily === "miron-jars") && selectedClass === "jar_miron"; // ALWAYS required for Miron (14C.1B1)
    // 14C.2 jar multi-label rows (server-built; stale extra rows discarded)
    const jarFamilyP = ["standard-jars", "premium-jars", "chiron-jars", "miron-jars"].includes(pFamily);
    labelCountP = Math.min(Math.max(1, Math.floor(Number(eparams.get("plabelcount") || 1))), MAX_LABELS_PER_UNIT);
    sameSizeP = eparams.get("psame") !== "no";
    labelRowsP = jarFamilyP
      ? buildLabelRows({
          count: labelCountP,
          same: sameSizeP,
          sameWidthIn: Number(eparams.get("pwidth") || 0),
          sameHeightIn: Number(eparams.get("pheight") || 0),
          types: eparams.getAll("plabeltype").map(String),
          widths: eparams.getAll("plabelw").map(Number),
          heights: eparams.getAll("plabelh").map(Number),
        })
      : null;
    const pickedLid = blankItemById.get(String(eparams.get("plid") || ""));
    const pickedMaterial = materialById.get(String(eparams.get("pmat") || ""));
    const customName = String(eparams.get("pcustomname") || "").slice(0, 80);
    const customCost = Number(eparams.get("pcustomcost") || 0);
    const customNote = String(eparams.get("pcustomnote") || "").slice(0, 160);
    const toComponent = (item: any): ResolvedComponent | null =>
      item ? { name: item.name, unitCost: Number(item.unitCost) > 0 ? Number(item.unitCost) : null, tiers: item.tiers || [], status: "verified" as const } : null;
    // 14C.2A: canonical NO PRICE bag sizes resolve to a null-cost component
    // (Draft Only); Chiron blanks are forced to their flat cost (tiers ignored)
    const canonicalBagSize = String(eparams.get("pblank") || "").startsWith("type:bag-") ? String(eparams.get("pblank")).slice("type:bag-".length) : null;
    const canonicalBagComponent: ResolvedComponent | null = canonicalBagSize && REQUIRED_STICKER_BAG_SIZES.includes(canonicalBagSize)
      ? { name: `${canonicalBagSize} Sticker Bag`, unitCost: null, tiers: [], status: "estimated", note: "Owner cost not provided yet — Draft Only." }
      : null;
    if (canonicalBagComponent) selectedClass = "bag_sticker";
    const blankComponent = enforceFlatChironCost(
      eparams.get("pblank") === "custom"
        ? (customName && customCost > 0 && customNote
            ? { name: customName, unitCost: customCost, tiers: [], status: "estimated" as const, note: `Custom item — ${customNote}` }
            : null)
        : eparams.get("pblank") === "none" ? null : canonicalBagComponent || toComponent(pickedBlank),
      selectedClass,
    );
    if (eparams.get("pblank") === "custom" && !blankComponent) {
      // custom without name/cost/reason stays null -> MISSING line via engine when family expects a blank
    }
    const printer = eparams.get("pprinter") === "roland" ? "roland" as const : "mimaki" as const;
    requestedQtyP = Math.floor(Number(eparams.get("pqty") || 0));
    const engineFamilyP = uiFamilyToEngine(pFamily, selectedClass, selectedIncludesTop);
    const isDtpP = engineFamilyP === "dtp-bags";
    // 15C: DTP freight — user-entered actual/allowance wins; else the $85
    // Spektra flat per-PO default (one charge per PO, never per design/line).
    const dtpUserActual = Number(eparams.get("efactual") || 0) + Number(eparams.get("efhandling") || 0) + Number(eparams.get("effees") || 0);
    const dtpAllowance = Number(eparams.get("efallow") || 0);
    const dtpAddOns = (pickedBlank as any)?.addOns || [];
    const dtpInputP = isDtpP ? {
      sizeLabel: pickedBlank?.name || "",
      moq: officialMoqForFamily("dtp-pouches") || 1000,
      hangHole: eparams.get("phanghole") === "yes",
      includedFeatures: dtpAddOns.filter((addOn: any) => addOn.enabled && addOn.amount <= 0 && /includ/i.test(addOn.pricingType)).map((addOn: any) => addOn.name),
      optionalFeatures: dtpAddOns.filter((addOn: any) => addOn.enabled && /option/i.test(addOn.pricingType)).map((addOn: any) => ({ name: addOn.name, amount: addOn.amount })),
      ...(dtpUserActual > 0
        ? { freightPerOrder: dtpUserActual, freightSource: "verified" as const, freightNote: "Actual entered freight/handling/fees (replaces the $85 Spektra default)." }
        : dtpAllowance > 0
          ? { freightPerOrder: dtpAllowance, freightSource: "estimated" as const, freightNote: "ESTIMATED allowance (replaces the $85 Spektra default)." }
          : { freightPerOrder: SPEKTRA_FREIGHT_PER_PO, freightSource: "verified" as const, freightNote: "One $85 charge per Spektra purchase order — never per design, size, or line item; allocated across units in tier pricing." }),
    } : null;
    const productInput: ProductDrivenInput = {
      family: engineFamilyP,
      quantity: requestedQtyP || eQuantities[eQuantities.length - 1] || 1,
      designs: Number(eparams.get("pdesigns") || 0),
      facesPerUnit: Math.max(1, Number(eparams.get("pfaces") || 1)),
      widthIn: Number(eparams.get("pwidth") || 0),
      heightIn: Number(eparams.get("pheight") || 0),
      labelRows: labelRowsP,
      dtp: dtpInputP,
      blank: blankComponent,
      lid: pFamily === "miron-jars" || topRequired ? resolveTopSelection(String(eparams.get("plid") || ""), pickedLid) : null,
      mironTop: topRequired ? {
        setIncludesStandardTop: selectedIncludesTop,
        includedStandardTopCost: standardTopCost(classified),
        selectedTopIsStandard: /^type:standard/.test(String(eparams.get("plid") || "")) || /standard|classic/i.test(pickedLid?.name || ""),
      } : null,
      material: pickedMaterial && pickedMaterial.displayCostPerSqft > 0
        ? { name: pickedMaterial.name, costPerSqft: pickedMaterial.displayCostPerSqft }
        : pickedMaterial ? { name: pickedMaterial.name, costPerSqft: null } : null,
      printer,
      // Documented capability constants (match INK_RATES truth): Mimaki has a
      // white channel, gloss COST is missing; Roland has all channels at the
      // owner-approved provisional uniform rate.
      printerHasWhite: true,
      printerHasGloss: printer === "roland",
      whiteLayers: Number(eparams.get("pwhitelayers") || 0),
      glossLayers: Number(eparams.get("pglosslayers") || 0),
      inkMlPerSqft: 0.6,
      machineMinutesPerSqft: Number(eparams.get("pmachmin") || 0),
      machineSqftPerHour: printer === "roland" ? printerSqftPerHour.roland : printerSqftPerHour.mimaki, // 15F.0-D verified speed
      machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value, // provisional owner standard (15B: single source)
      cutType: normalizeCutType(eparams.get("pcut")), // 15F.0-E (legacy kiss/weeded -> square-rect)
      cutRequiresWeeding: eparams.get("pcut") === "weeded",
      hemming: eparams.get("phem") === "1",
      grommets: eparams.get("pgrommet") === "1",
      freightPerUnit: 0, // freight added ONCE by the freight panel pipeline below
      freightSource: "estimated",
      recipeWastePct: null,
      wasteOverride: eparams.get("pwasteoverride") && eparams.get("pwastereason")
        ? { pct: Number(eparams.get("pwasteoverride")), reason: String(eparams.get("pwastereason")) }
        : null,
      boxOverride: eparams.get("pboxoverride") && eparams.get("pboxreason")
        ? { unitsPerBox: Number(eparams.get("pboxoverride")), reason: String(eparams.get("pboxreason")) }
        : null,
    };
    productCost = computeProductDrivenCost(productInput);
    eVar = productCost.perUnitVariable;
    eSetup = productCost.setupTotal;
    // ---- 14C.2 AUTOMATIC family pricing tiers, fed directly from the
    // calculated job. Each tier quantity RERUNS the full engine (blank tiers,
    // boxes, setup spread all re-resolve per quantity) — the researched family
    // curve and 40% floor are untouched; the requested quantity is always one
    // of the rows. Only rendered once a quantity was actually entered.
    if (requestedQtyP > 0) {
      productMarginKey = marginFamilyKeyFor(pFamily, selectedClass, pickedBlank?.name || (autoBag ? autoBag.name : ""));
      productMarginRule = productMarginKey ? resolveMarginFamily(productMarginKey) : null;
      const baseTierQuantities = isDtpP && !eparams.get("eqty") ? DTP_LADDER_QUANTITIES : eQuantities; // 15C.2: DTP rows = owner ladder quantities (1000/2500/5000/7500/10000)
      const tierQuantities = [...new Set([...baseTierQuantities, requestedQtyP])].filter((value) => value > 0).sort((a, b) => a - b);
      // 15F.0-C: margin comes from each row's QUANTITY (researched band), never
      // from row count/position — adding the requested row cannot shift the
      // standard rows (forensic P0-1 fix). Families without a researched curve
      // stay on the provisional universal curve, quantity-banded and labeled.
      const provisionalRuleP: FamilyMarginRule = { key: "provisional-universal", label: "Provisional universal curve", curve: [...PROVISIONAL_MARGIN_CURVE], familyMinPct: MARGIN_FLOOR_PCT, aliases: [] };
      const marginRuleForPricingP = productMarginRule ?? provisionalRuleP;
      const premiumEligibleP = engineFamilyP === "stickers-labels" && (Number(eparams.get("pwhitelayers") || 0) > 0 || Number(eparams.get("pglosslayers") || 0) > 0);
      const curveDefaults = isDtpP
        ? tierQuantities.map((qty) => dtpMarginPctForQuantity(qty)) // 15C.1: quantity-threshold rule, never row-position
        : tierQuantities.map((qty) => marginPctForQuantity(marginRuleForPricingP, qty));
      const tierMargins = eMarginsRaw.length === tierQuantities.length ? eMarginsRaw : curveDefaults;
      const freightInputsP = {
        actualFreight: Number(eparams.get("efactual") || 0),
        handling: Number(eparams.get("efhandling") || 0),
        otherFees: Number(eparams.get("effees") || 0),
        estimatedAllowance: Number(eparams.get("efallow") || 0),
        allocation: ((eparams.get("efalloc") as any) || "per_unit") as "per_unit" | "by_value" | "manual",
        manualPerUnit: Number(eparams.get("efmanual") || 0),
      };
      const floorForFamily = Math.max(productMarginRule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT);
      productTiers = tierQuantities.map((qty, index) => {
        const run = qty === productInput.quantity ? productCost! : computeProductDrivenCost({ ...productInput, quantity: qty });
        // 15C: DTP freight is a flat per-PO line INSIDE the engine run — the
        // tier pipeline must not add it a second time.
        const tierFreight = isDtpP ? { total: 0, perUnit: 0, source: "verified" as const, note: "" } : computeFreight(freightInputsP, qty, 0);
        // 15C.2: DTP prices come from the OWNER ladder (hybrid model) — never
        // a margin formula. Custom price applies to the requested qty only.
        if (isDtpP) {
          const dtpRow = priceDtpQuote({
            ladderSku: String((pickedBlank as any)?.sku || ""),
            quantity: qty,
            landedCost: run.totalCost,
            missingCost: run.missing.length > 0,
            designs: Number(eparams.get("pdesigns") || 0),
            customUnitPrice: qty === requestedQtyP && Number(eparams.get("pdtpcustomprice") || 0) > 0 ? Number(eparams.get("pdtpcustomprice")) : null,
            repeatOrder: eparams.get("pdtprepeat") === "1",
            passThroughFreight: eparams.get("pdtpfreightpass") === "1",
            freightAmount: dtpInputP ? dtpInputP.freightPerOrder : SPEKTRA_FREIGHT_PER_PO,
            override: { phrase: String(eparams.get("eophrase") || ""), reason: String(eparams.get("eoreason") || "") },
          });
          return {
            quantity: qty, requested: qty === requestedQtyP,
            jobCost: run.totalCost, unitCost: run.unitCost,
            marginPct: Math.round(dtpRow.grossMarginPct * 10) / 10,
            unitPrice: dtpRow.unitPrice, totalPrice: dtpRow.customerTotal,
            profit: dtpRow.grossProfit, actualMarginPct: dtpRow.grossMarginPct,
            belowFloor: dtpRow.grossMarginPct < dtpRow.hardFloorPct,
            draftOnly: run.missing.length > 0,
            freightTotal: dtpInputP ? dtpInputP.freightPerOrder : SPEKTRA_FREIGHT_PER_PO,
            freightSource: dtpInputP ? dtpInputP.freightSource : "verified",
            setupTotal: run.setupTotal,
            status: dtpRow.status,
            dtp: {
              vendorTierLabel: run.lines.find((line) => line.key === "blank")?.label || null,
              ownerPriceTierUsed: dtpRow.ownerPriceTierUsed,
              defaultOwnerUnitPrice: dtpRow.defaultOwnerUnitPrice,
              customUnitPrice: dtpRow.customUnitPrice,
              baseSubtotal: dtpRow.customerBaseSubtotal,
              extraDesignCount: dtpRow.extraDesignCount,
              extraDesignFeeEach: dtpRow.extraDesignFeeEach,
              extraDesignFees: dtpRow.extraDesignFees,
              designFeeWaived: dtpRow.designFeeWaived,
              freightTreatment: dtpRow.freightTreatment,
              customerFreight: dtpRow.customerFreight,
              hardFloorPct: dtpRow.hardFloorPct,
              statusReasons: dtpRow.statusReasons,
              overrideRequired: dtpRow.overrideRequired,
              overrideSatisfied: dtpRow.overrideSatisfied,
            },
          };
        }
        // 15F.0-H: one commercial price per row — cost-based on the researched
        // quantity band, lifted by any owner floor/ladder candidate; the
        // controlling rule is recorded. Advanced per-tier margin edits still
        // override the band margin (validated by the existing floor gate).
        const overrideMargin = eMarginsRaw.length === tierQuantities.length ? eMarginsRaw[index] : null;
        const completeCost = run.totalCost + tierFreight.total;
        const commercial = computeCommercialPrice({
          familyKey: canonicalUiFamily(pFamily), quantity: qty, completeCost,
          marginRule: marginRuleForPricingP, premiumEligible: premiumEligibleP,
          marginPctOverride: overrideMargin,
          finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, // 15F.0-FINAL area floor inputs
        });
        const belowFloor = commercial.marginPctApplied < floorForFamily;
        return {
          quantity: qty,
          requested: qty === requestedQtyP,
          jobCost: completeCost,
          unitCost: qty > 0 ? completeCost / qty : completeCost,
          marginPct: commercial.marginPctApplied,
          unitPrice: commercial.finalUnitPrice,
          totalPrice: commercial.finalTotalPrice,
          profit: commercial.achievedProfit,
          actualMarginPct: commercial.achievedMarginPct,
          belowFloor,
          draftOnly: run.missing.length > 0,
          freightTotal: tierFreight.total,
          freightSource: tierFreight.source,
          setupTotal: run.setupTotal,
          blockers: run.missing,
          commercial: { version: commercial.version, candidates: commercial.candidates, controllingRule: commercial.controllingRule, marginSource: commercial.marginSource, premiumApplied: premiumEligibleP },
          status: run.missing.length ? "BLOCKED" : belowFloor ? "BELOW FLOOR — override required" : "READY TO QUOTE",
        };
      });
    }
    // 15F.0-K: multi-line sticker jobs — every line runs the SAME engine
    // independently (own material/printer/layers/cut/quantity band); job-level
    // packing is charged once and allocated by cost share; the combined price
    // is the sum of per-line commercial prices (premium lines stay premium).
    const lineCountK = Math.floor(Number(eparams.get("pslcount") || 0));
    if (engineFamilyP === "stickers-labels" && lineCountK >= 2) {
      const lineInputs = buildStickerLines({
        count: lineCountK,
        names: eparams.getAll("pslname").map(String),
        quantities: eparams.getAll("pslqty").map(Number),
        designs: eparams.getAll("psldesigns").map(Number),
        widths: eparams.getAll("pslw").map(Number),
        heights: eparams.getAll("pslh").map(Number),
        materialIds: eparams.getAll("pslmat").map(String),
        printers: eparams.getAll("pslprinter").map(String),
        whites: eparams.getAll("pslwhite").map(Number),
        glosses: eparams.getAll("pslgloss").map(Number),
        cuts: eparams.getAll("pslcut").map(String),
      });
      const lineResults = lineInputs.map((line) => {
        const lineMaterial = materialById.get(line.materialId);
        const run = computeProductDrivenCost({
          family: "stickers-labels", quantity: Math.max(1, line.quantity), designs: line.designs,
          facesPerUnit: 1, widthIn: line.widthIn, heightIn: line.heightIn, labelRows: null, dtp: null,
          blank: null, lid: null, mironTop: null,
          material: lineMaterial ? { name: lineMaterial.name, costPerSqft: lineMaterial.displayCostPerSqft > 0 ? lineMaterial.displayCostPerSqft : null } : null,
          printer: line.printer, printerHasWhite: true, printerHasGloss: line.printer === "roland",
          whiteLayers: line.whiteLayers, glossLayers: line.glossLayers, inkMlPerSqft: 0.6,
          machineMinutesPerSqft: 0, machineSqftPerHour: line.printer === "roland" ? printerSqftPerHour.roland : printerSqftPerHour.mimaki,
          machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
          cutType: normalizeCutType(line.cutType), cutRequiresWeeding: false,
          hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated",
          recipeWastePct: null, wasteOverride: null, boxOverride: null,
        });
        const packingAmount = run.lines.find((engineLine) => engineLine.key === "packing")?.amount || 0;
        return {
          name: line.name, quantity: line.quantity, designs: line.designs,
          glossOrWhite: line.whiteLayers > 0 || line.glossLayers > 0,
          lineCost: run.totalCost - packingAmount, // packing charged ONCE at job level below
          missing: run.missing,
          finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, // 15F.0-FINAL floor inputs
          splitText: designSplit(line.quantity, line.designs).text,
        };
      });
      const totalUnitsK = lineInputs.reduce((sum, line) => sum + Math.max(0, line.quantity), 0);
      const combined = combineStickerLines({
        lines: lineResults,
        // 15F.0-FINAL-H: one job-level packout on the combined units (sticker density rule)
        jobPackingCost: OWNER_STANDARDS.packoutPerBox.value * Math.max(1, Math.ceil(totalUnitsK / 5000)),
        marginRule: resolveMarginFamily("stickers-labels"),
      });
      productMultiLine = { perLine: lineResults, combined, packingNote: "Packing charged once at job level — single-box floor of the $2 owner standard." };
    }
  }
  const freight = computeFreight(
    {
      actualFreight: Number(eparams.get("efactual") || 0),
      handling: Number(eparams.get("efhandling") || 0),
      otherFees: Number(eparams.get("effees") || 0),
      estimatedAllowance: Number(eparams.get("efallow") || 0),
      allocation: (eparams.get("efalloc") as any) || "per_unit",
      manualPerUnit: Number(eparams.get("efmanual") || 0),
    },
    eQuantities[eQuantities.length - 1] || 1,
    0,
  );
  const eTiers = generateTiers({
    tiers: eQuantities.map((quantity, index) => ({ quantity, marginPct: eMargins[index] ?? MARGIN_FLOOR_PCT })),
    perUnitVariableCost: eVar + freight.perUnit,
    setupTotal: eSetup,
    blankVendorRows: [],
    blankFallbackUnitCost: eBlank > 0 ? eBlank : null,
    wastePct: eWaste,
  });
  const eGate = checkMarginGate(Math.min(...eMargins, 100), { phrase: String(eparams.get("eophrase") || ""), reason: String(eparams.get("eoreason") || "") }, eFamilyRule?.familyMinPct ?? MARGIN_FLOOR_PCT);
  const emergency = {
    quantities: eQuantities, margins: eMargins, defaults: eDefaults, tiers: eTiers, freight, gate: eGate, floor: MARGIN_FLOOR_PCT,
    mode: eMode, autoCost: autoCost ? { lines: autoCost.lines, perUnitVariable: autoCost.perUnitVariable, setupTotal: autoCost.setupTotal, missing: autoCost.missing, warnings: autoCost.warnings } : null,
    productMode: {
      family: pFamily || null,
      canonicalFamily: pFamily ? canonicalUiFamily(pFamily) : null,
      selectedClass,
      topRequired,
      autoBag: autoBag ? { value: autoBag.id, label: `${autoBag.name} — $${Number(autoBag.unitCost).toFixed(2)} — Verified (auto-selected)` } : null,
      bagCount: bagRecords.length,
      result: productCost ? { lines: productCost.lines, derived: productCost.derived, missing: productCost.missing, warnings: productCost.warnings, totalCost: productCost.totalCost, unitCost: productCost.unitCost } : null,
      // 14C.2 automatic tiers + label-builder echo (form state survives
      // reloads; the save form posts the same GET state via psearch).
      tiers: productTiers,
      requestedQty: requestedQtyP,
      marginFamily: productMarginRule
        ? { key: productMarginRule.key, label: productMarginRule.label, curve: productMarginRule.curve, minPct: productMarginRule.familyMinPct, configured: true, source: MARGIN_RULE_SOURCE }
        : { key: productMarginKey || "", label: "FAMILY MARGIN RULE NOT CONFIGURED", curve: [] as number[], minPct: MARGIN_FLOOR_PCT, configured: false, source: "provisional universal curve" },
      labelForm: labelRowsP ? { count: labelCountP, same: sameSizeP, rows: labelRowsP } : null,
      // 15F.0-J: multi-design split (quantity = TOTAL labels; designs share it)
      designSplitText: pFamily && canonicalUiFamily(pFamily) === "stickers-labels" && Number(eparams.get("pdesigns") || 0) > 1 && requestedQtyP > 0
        ? designSplit(requestedQtyP, Number(eparams.get("pdesigns"))).text
        : null,
      multiLine: productMultiLine, // 15F.0-K
      cutSelected: eparams.get("pcut") || "square-rect", // 15F.0-E form echo
      isDtp: pFamily ? canonicalUiFamily(pFamily) === "dtp-bags" : false,
      dtpSpec: (() => {
        if (!pFamily || canonicalUiFamily(pFamily) !== "dtp-bags") return null;
        const addOns = (pickedBlankRef as any)?.addOns || [];
        return {
          included: addOns.filter((addOn: any) => addOn.enabled && addOn.amount <= 0 && /includ/i.test(addOn.pricingType)).map((addOn: any) => addOn.name),
          optional: addOns.filter((addOn: any) => addOn.enabled && /option/i.test(addOn.pricingType)).map((addOn: any) => ({ name: addOn.name, amount: addOn.amount })),
          moq: officialMoqForFamily("dtp-pouches") || 1000,
          freightDefault: SPEKTRA_FREIGHT_PER_PO,
        };
      })(),
      printConfig: pFamily && canonicalUiFamily(pFamily) === "dtp-bags"
        ? `Vendor-finished pouches — ${Number(eparams.get("pdesigns") || 0) || 1} design(s)${eparams.get("phanghole") === "yes" ? " — hang hole" : ""}`
        : labelRowsP
        ? `${labelRowsP.length} label(s) per jar — ${labelRowsP.map((row) => row.typeLabel).join(", ")}`
        : pFamily === "bags-4x5" || pFamily === "sticker-bags"
          ? (Number(eparams.get("pfaces") || 1) >= 2 ? "Front and back" : "Front only")
          : pFamily === "banners"
            ? (Number(eparams.get("pfaces") || 1) >= 2 ? "Double-sided" : "Single-sided")
            : "Single print",
      // 14C.1B classification-driven pickers (labels via the shared formatter;
      // NO PRICE records are never shown as Verified; 5oz/other stay hidden).
      blankOptions: classified.filter((entry: any) => {
        const priced = Number(entry.item.unitCost) > 0 || (entry.item.tiers || []).length > 0;
        // 14C.2A: unpriced sticker bags stay visible (NO PRICE label, Draft Only)
        if (pFamily === "bags-4x5" || pFamily === "sticker-bags") return entry.klass === "bag_sticker";
        if (canonicalUiFamily(pFamily) === "dtp-bags") return entry.klass === "bag_dtp"; // 15C: unpriced sizes stay visible (NO PRICE, Draft Only)
        if (pFamily === "standard-jars") return entry.klass === "jar_standard" && priced;
        if (pFamily === "premium-jars") return (entry.klass === "jar_chiron" || entry.klass === "jar_miron") && priced;
        if (pFamily === "custom" || pFamily === "custom-item") return true;
        return false;
      }).slice(0, 40).map((entry: any) => ({
        value: entry.item.id,
        group: entry.klass === "jar_chiron" ? "CHIRON" : entry.klass === "jar_miron" ? "MIRON" : null,
        label: formatComponentLabel(entry.item.name, entry.klass, entry.includesTop,
          Number(entry.item.unitCost) > 0 ? `$${Number(entry.item.unitCost).toFixed(2)} — Verified` : (entry.item.tiers || []).length ? "tiered — Verified" : "NO PRICE — not verified"),
      })).concat(canonicalBagOptions.map((option) => ({ value: option.value, group: null, label: option.label }))),
      lidOptions: classified.filter((entry: any) =>
        entry.klass === "miron_top"
        && (Number(entry.item.unitCost) > 0 || (entry.item.tiers || []).length > 0)
        && (!pickedBlankRef || mironTopCompatible(pickedBlankRef.name, entry.item.name)),
      ).slice(0, 20).map((entry: any) => ({ value: entry.item.id, label: `${entry.item.name} — ${Number(entry.item.unitCost) > 0 ? `$${Number(entry.item.unitCost).toFixed(2)} — Verified` : "tiered — Verified"}` }))
        // 14C.1B1: canonical top types always available so the required
        // selector never silently disappears (unpriced picks stay Draft Only)
        .concat(CANONICAL_TOPS.map((top) => ({ value: top.value, label: `${top.label} — ${top.value === "type:standard-top" ? "included when the set contains it" : "upgrade cost pending Vendor Cost Book record"}` }))),
      materialOptions: materials
        .filter((material) => (pFamily === "banners" ? /banner/i.test(`${material.materialType || ""} ${material.name}`) : true))
        .slice(0, 40)
        .map((material) => ({ value: material.id, label: `${material.name} — ${material.displayCostPerSqft > 0 ? `$${material.displayCostPerSqft.toFixed(4)}/sqft — Verified` : "NO PRICE — Missing"}` })),
    },
    family: eFamilyRule
      ? { key: eFamilyRule.key, label: eFamilyRule.label, curve: eFamilyRule.curve, minPct: eFamilyRule.familyMinPct, configured: true, source: MARGIN_RULE_SOURCE }
      : { key: String(eparams.get("efamily") || ""), label: "Not selected / unknown", curve: [] as number[], minPct: MARGIN_FLOOR_PCT, configured: false, source: "provisional universal curve" },
  };

  return {
    emergency,
    appOrigin,
    syncEndpoint: `${appOrigin}/api/quote-rip-results/sync`,
    uploadToken: setting?.uploadToken || null,
    rows,
    lastAutoImportAt: setting?.lastAutoImportAt ? setting.lastAutoImportAt.toISOString() : null,
    materials,
    blankItems: blankItems.map((item) => ({
      id: item.id,
      isPreset: item.isPreset,
      name: item.name,
      unitCost: item.unitCost,
      hasTiers: Boolean(item.tiers?.length),
      vendor: item.vendor,
    })),
    form: {
      quoteMode,
      targetMarginPct,
      laborRatePerHour,
      machineCostPerHour,
      setupMinutes,
      finishingMinutes,
      lineCount,
      lines,
      itemMode,
      itemId,
      itemQty,
      itemCostQty,
      itemWastePct,
      customItemName,
      customItemUnitCost,
      itemTierLabel,
      applicationMode,
      applicationQty,
      applicationSecondsPerUnit,
      applicationUnitCost,
      applicationSetupMinutes,
      applicationName: applicationRule.name,
      applicationLineDetails,
      averageLabelSqIn,
      cuttingMode,
      cuttingCustomMinutes,
      cuttingCustomFlatCost,
      prepressMode,
      prepressCustomMinutes,
      prepressCustomFlatCost,
      packoutMode,
      packoutCustomUnitCost,
      packoutCustomFlatCost,
      safetyWarnings,
    },
    calc: {
      lineMaterialCost,
      lineInkCost,
      lineBaseSqft,
      lineWasteAdjustedSqft,
      lineInkCc,
      itemName,
      itemQty,
      itemCostQty,
      itemWastePct,
      itemUnitCost,
      itemTierLabel,
      itemCost,
      applicationLaborMinutes,
      applicationLaborCost,
      applicationQty,
      applicationSecondsPerUnit,
      applicationSetupMinutes,
      applicationName: applicationRule.name,
      applicationLineDetails,
      applicationWired: wiredAppRate != null,
      applicationRatePerApp: wiredAppRate,
      glossWhiteApplies,
      glossWhiteSetupCost,
      processLaborCost,
      processMachineCost,
      cuttingName: cutting.name,
      cuttingMinutes: cutting.minutes,
      cuttingCost,
      prepressName: prepress.name,
      prepressMinutes: prepress.minutes,
      prepressCost,
      packoutName: packout.name,
      packoutUnitCost: packout.unitCost,
      packoutFlatCost: packout.flatCost,
      packoutCost,
      totalCost,
      unitCost,
      suggestedTotal,
      suggestedUnit,
      grossProfit,
    },
  };
}

// 14B.0: the calculator's ONLY write action — save the emergency panel result
// as a DRAFT quote (snapshot preserved; historical quotes untouched). The
// server RE-COMPUTES from the posted fields; below-floor margins require the
// exact override phrase + reason; missing costs force draft-with-warnings.
export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  if (String(form.get("intent")) !== "saveEmergencyQuoteDraft") return Response.json({ ok: false, message: "Unknown action." });
  // 14C.2: the product-flow save form posts ONE hidden "psearch" field holding
  // the calculated GET state (React Router location.search — identical on
  // server and client). Reads fall back to it; multi-value label-row params
  // come from it authoritatively. Everything is still re-fetched/re-computed —
  // posted params carry IDs and business inputs only, never trusted totals.
  const psearchParams = new URLSearchParams(String(form.get("psearch") || "").replace(/^\?/, ""));
  const fRead = (key: string) => {
    const direct = form.get(key);
    if (direct != null && String(direct) !== "") return String(direct);
    return String(psearchParams.get(key) ?? "");
  };
  const fReadAll = (key: string) => {
    const fromSearch = psearchParams.getAll(key);
    return fromSearch.length ? fromSearch.map(String) : form.getAll(key).map(String);
  };
  const isAuto = fRead("emode") === "auto";
  let quantities = fRead("eqty").split(",").map((value) => Number(value.trim())).filter((value) => value > 0);
  if (!quantities.length) quantities = SUGGESTED_QUANTITIES.slice(0, 5); // same default as the loader
  const margins = fRead("emargin").split(",").map((value) => Number(value.trim()));
  let eVar = Number(fRead("evar") || 0);
  let eSetup = Number(fRead("esetup") || 0);
  const eBlank = Number(fRead("eblank") || 0);
  const eWaste = Number(fRead("ewaste") || 0);
  const rawProductNameEntry = String(form.get("eproduct") || ""); // resolved AFTER the product block (15D.2 precedence)
  const freight = computeFreight(
    { actualFreight: Number(fRead("efactual") || 0), handling: Number(fRead("efhandling") || 0), otherFees: Number(fRead("effees") || 0), estimatedAllowance: Number(fRead("efallow") || 0), allocation: (fRead("efalloc") as any) || "per_unit", manualPerUnit: Number(fRead("efmanual") || 0) },
    quantities[quantities.length - 1] || 1, 0,
  );
  const tiers = generateTiers({
    tiers: quantities.map((quantity, index) => ({ quantity, marginPct: Number.isFinite(margins[index]) && margins[index] > 0 ? margins[index] : MARGIN_FLOOR_PCT })),
    perUnitVariableCost: eVar + freight.perUnit, setupTotal: eSetup, blankVendorRows: [], blankFallbackUnitCost: eBlank > 0 ? eBlank : null, wastePct: eWaste,
  });
  if (!tiers.length) return Response.json({ ok: false, message: "No valid tier quantities." });
  const familyRule = resolveMarginFamily(fRead("efamily"));
  let autoSnapshot: ReturnType<typeof computeAutoCost> | null = null;
  if (isAuto) {
    const familyMapA: Record<string, AutoFamily> = { "bags-4x5": "bags-4x5", "chiron-jars": "chiron-jars", "miron-jars": "miron-jars", "stickers-labels": "stickers-labels", "banners": "banners" };
    const autoFamily = familyRule ? familyMapA[familyRule.key] : undefined;
    if (!autoFamily) return Response.json({ ok: false, message: "Automatic mode needs one of the five supported families." });
    autoSnapshot = computeAutoCost(autoFamily, {
      quantity: quantities[quantities.length - 1] || 1, designs: Number(form.get("edesigns") || 0),
      sides: form.get("esides") === "2" ? 2 : 1, labelWidthIn: Number(form.get("ewidth") || 0), labelHeightIn: Number(form.get("eheight") || 0),
      materialCostPerSqft: Number(form.get("ematsqft") || 0) > 0 ? Number(form.get("ematsqft")) : null, materialLabel: String(form.get("ematlabel") || "Material"),
      printer: form.get("eprinter") === "roland" ? "roland" : "mimaki", whiteInk: form.get("ewhite") === "1", spotGloss: form.get("egloss") === "1",
      inkMlPerSqft: Number(form.get("einkml") || 0.6), machineMinutesPerSqft: Number(form.get("emachmin") || 0), machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value, // provisional owner standard (15B: single source)
      blankUnitCost: eBlank > 0 ? eBlank : null, blankLabel: String(form.get("eblanklabel") || "Blank item"),
      lidUnitCost: Number(form.get("elid") || 0) > 0 ? Number(form.get("elid")) : null, lidLabel: String(form.get("elidlabel") || "Miron lid"),
      boxes: Number(form.get("eboxes") || 0), wastePct: form.get("ewaste") ? eWaste : -1,
      freightPerUnit: 0, freightSource: "estimated", cutIsProvisional: true, weedingPages: Number(form.get("eweedpages") || 0),
      hemming: form.get("ehem") === "1", grommets: form.get("egrommet") === "1",
    });
    eVar = autoSnapshot.perUnitVariable; eSetup = autoSnapshot.setupTotal; // client evar/esetup IGNORED in auto mode
  }

  // 14C.1: product-driven saves re-resolve the posted record IDs from the DB
  // and re-derive EVERYTHING (costs, sqft, waste, boxes, weeding, layers).
  let productSnapshot: ReturnType<typeof computeProductDrivenCost> | null = null;
  let savedClassification: { klass: CalculatorProductClass; includesTop: boolean } | null = null;
  let savedEngineFamily: ProductFamilyKey | null = null;
  let savedTiers: any[] | null = null;
  let savedSelectedTier: any | null = null;
  let savedMultiLine: ReturnType<typeof combineStickerLines> | null = null; // 15F.0-K
  let savedMarginRule: FamilyMarginRule | null = null;
  let savedMarginKey: string | null = null;
  let savedLabelRows: LabelRow[] | null = null;
  let savedSameSize = true;
  let savedRequestedQty = 0;
  let savedBlankNameForNaming: string | null = null;
  const pFamilySave = String(fRead("pfamily") || "");
  if (pFamilySave && calculatorFamilyValues().includes(pFamilySave)) {
    type FetchedComponent = { component: ResolvedComponent; meta: { name: string; productType?: string; vendor?: string; vendorSku?: string; addOns?: Array<{ name: string; pricingType: string; amount: number; enabled: boolean }> } | null };
    const fetchComponent = async (rawId: string): Promise<FetchedComponent | null> => {
      if (!rawId || rawId === "none") return null;
      if (rawId === "custom") {
        const name = String(fRead("pcustomname") || "").slice(0, 80);
        const cost = Number(fRead("pcustomcost") || 0);
        const note = String(fRead("pcustomnote") || "").slice(0, 160);
        return name && cost > 0 && note ? { component: { name, unitCost: cost, tiers: [], status: "estimated", note: `Custom item — ${note}` }, meta: null } : null;
      }
      if (rawId.startsWith("vendor:")) {
        const record = await db.vendorProduct.findFirst({ where: { shop, id: rawId.slice(7) }, include: { tiers: true, addOns: true } });
        return record ? {
          component: { name: record.name, unitCost: Number(record.defaultUnitCost) > 0 ? Number(record.defaultUnitCost) : null, tiers: (record.tiers || []).map((tier: any) => ({ minQty: tier.minQty, maxQty: tier.maxQty, unitCost: tier.unitCost })), status: "verified" },
          meta: { name: record.name, productType: record.productType || "", vendor: record.vendor || "", vendorSku: record.vendorSku || "", addOns: (record.addOns || []).map((addOn: any) => ({ name: addOn.name, pricingType: String(addOn.pricingType || ""), amount: Number(addOn.amount) || 0, enabled: Boolean(addOn.enabled) })) },
        } : null;
      }
      if (rawId.startsWith("material:")) {
        const record = await db.material.findFirst({ where: { shop, id: rawId.slice(9) } });
        if (!record) return null;
        const resolved = resolveMaterialUnitCost(record);
        return {
          component: { name: record.name, unitCost: resolved.unitCost > 0 ? resolved.unitCost : null, tiers: [], status: "verified" },
          meta: { name: record.name, productType: record.materialType || "", vendor: record.vendor || "", vendorSku: record.sku || "" },
        };
      }
      if (rawId.startsWith("type:bag-")) {
        // canonical owner-required bag size with no record yet — Draft Only
        const size = rawId.slice("type:bag-".length);
        return REQUIRED_STICKER_BAG_SIZES.includes(size)
          ? { component: { name: `${size} Sticker Bag`, unitCost: null, tiers: [], status: "estimated", note: "Owner cost not provided yet — Draft Only." }, meta: { name: `${size} Sticker Bag`, productType: "bag" } }
          : null;
      }
      if (rawId.startsWith("preset:")) {
        // presets are code-priced fallbacks still visible in the pickers
        // (customer-supplied, OZ bag, soda can) — resolve them at save the
        // same way the loader does so a preset-based draft never loses its blank
        const preset = presetBlankItems().find((item) => item.id === rawId);
        return preset ? {
          component: { name: preset.name, unitCost: preset.unitCost > 0 ? preset.unitCost : null, tiers: preset.tiers || [], status: "verified" },
          meta: { name: preset.name, productType: preset.productType, vendor: preset.vendor, vendorSku: preset.id },
        } : null;
      }
      return null;
    };
    const materialId = String(fRead("pmat") || "");
    const materialRecord = materialId ? await db.material.findFirst({ where: { shop, id: materialId } }) : null;
    const materialResolved = materialRecord ? resolvePrintMaterialCostPerSqft(materialRecord) : null;
    const printerSave = fRead("pprinter") === "roland" ? "roland" as const : "mimaki" as const;
    // 15F.0-D: verified machine speeds re-fetched at save (posted values never trusted)
    const printerSpeedsSave = resolvePrinterSpeeds(await db.machine.findMany({ where: { shop, active: true, machineType: "printer" }, select: { name: true, sqftPerHour: true } }));
    // 14C.1B: classification + engine mapping recomputed at save from the
    // FETCHED record (client cannot spoof the class or skip the Miron top).
    const savedBlankRaw = String(fRead("pblank") || "");
    const savedFetched = await fetchComponent(savedBlankRaw);
    let savedBlank = savedFetched ? savedFetched.component : null;
    savedClassification = savedFetched
      ? classifyCalculatorProduct(savedFetched.meta || { name: savedFetched.component.name })
      : null;
    // family-switch safety (mirrors the loader): a real record whose class is
    // not valid for the posted family is treated as no selection.
    if (savedBlank && savedClassification && /^(vendor:|material:|preset:)/.test(savedBlankRaw) && !blankClassAllowedFor(pFamilySave, savedClassification.klass)) {
      savedBlank = null;
      savedClassification = null;
    }
    // 14C.2A: Chiron blank cost is flat — quantity tiers ignored at save too
    savedBlank = enforceFlatChironCost(savedBlank, savedClassification ? savedClassification.klass : null);
    savedBlankNameForNaming = savedBlank?.name || null;
    const savedTopRaw = String(fRead("plid") || "");
    const savedTopFetched = savedTopRaw.startsWith("type:")
      ? (savedTopRaw === "type:standard-top" ? { name: "Standard / Classic top", unitCost: null, tiers: [], status: "estimated" as const } : savedTopRaw === "type:black-metal-top" ? { name: "Black metal top", unitCost: null, tiers: [], status: "estimated" as const } : null)
      : (await fetchComponent(savedTopRaw))?.component ?? null;
    const savedTop = savedTopFetched;
    savedEngineFamily = uiFamilyToEngine(pFamilySave, savedClassification ? savedClassification.klass : null, savedClassification ? savedClassification.includesTop : false);
    // 14C.2 jar label rows — rebuilt server-side from the posted count; stale
    // extra row entries are discarded by the shared builder.
    const jarFamilySave = ["standard-jars", "premium-jars", "chiron-jars", "miron-jars"].includes(pFamilySave);
    const labelCountSave = Math.min(Math.max(1, Math.floor(Number(fRead("plabelcount") || 1))), MAX_LABELS_PER_UNIT);
    savedSameSize = fRead("psame") !== "no";
    savedLabelRows = jarFamilySave
      ? buildLabelRows({
          count: labelCountSave,
          same: savedSameSize,
          sameWidthIn: Number(fRead("pwidth") || 0),
          sameHeightIn: Number(fRead("pheight") || 0),
          types: fReadAll("plabeltype"),
          widths: fReadAll("plabelw").map(Number),
          heights: fReadAll("plabelh").map(Number),
        })
      : null;
    savedRequestedQty = Math.floor(Number(fRead("pqty") || 0)) || quantities[quantities.length - 1] || 1;
    const savedIsDtp = savedEngineFamily === "dtp-bags";
    const savedDtpAddOns = savedFetched?.meta?.addOns || [];
    const savedDtpUserActual = Number(fRead("efactual") || 0) + Number(fRead("efhandling") || 0) + Number(fRead("effees") || 0);
    const savedDtpAllowance = Number(fRead("efallow") || 0);
    const savedDtpInput = savedIsDtp ? {
      sizeLabel: savedBlank?.name || "",
      moq: officialMoqForFamily("dtp-pouches") || 1000,
      hangHole: fRead("phanghole") === "yes",
      includedFeatures: savedDtpAddOns.filter((addOn) => addOn.enabled && addOn.amount <= 0 && /includ/i.test(addOn.pricingType)).map((addOn) => addOn.name),
      optionalFeatures: savedDtpAddOns.filter((addOn) => addOn.enabled && /option/i.test(addOn.pricingType)).map((addOn) => ({ name: addOn.name, amount: addOn.amount })),
      ...(savedDtpUserActual > 0
        ? { freightPerOrder: savedDtpUserActual, freightSource: "verified" as const, freightNote: "Actual entered freight/handling/fees (replaces the $85 Spektra default)." }
        : savedDtpAllowance > 0
          ? { freightPerOrder: savedDtpAllowance, freightSource: "estimated" as const, freightNote: "ESTIMATED allowance (replaces the $85 Spektra default)." }
          : { freightPerOrder: SPEKTRA_FREIGHT_PER_PO, freightSource: "verified" as const, freightNote: "One $85 charge per Spektra purchase order — never per design, size, or line item; allocated across units in tier pricing." }),
    } : null;
    const productInputSave: ProductDrivenInput = {
      family: savedEngineFamily,
      quantity: savedRequestedQty,
      designs: Number(fRead("pdesigns") || 0),
      facesPerUnit: Math.max(1, Number(fRead("pfaces") || 1)),
      widthIn: Number(fRead("pwidth") || 0),
      heightIn: Number(fRead("pheight") || 0),
      labelRows: savedLabelRows,
      dtp: savedDtpInput,
      blank: savedBlank,
      lid: savedEngineFamily === "miron-jars" ? savedTop : null,
      mironTop: savedEngineFamily === "miron-jars" ? {
        setIncludesStandardTop: Boolean(savedClassification?.includesTop),
        includedStandardTopCost: null, // no verified standard-top record yet — upgrades stay Draft Only
        selectedTopIsStandard: savedTopRaw === "type:standard-top" || /standard|classic/i.test(savedTop?.name || ""),
      } : null,
      material: materialRecord ? { name: materialRecord.name, costPerSqft: materialResolved && materialResolved.unitCost > 0 ? materialResolved.unitCost : null } : null,
      printer: printerSave,
      printerHasWhite: true,
      printerHasGloss: printerSave === "roland",
      whiteLayers: Number(fRead("pwhitelayers") || 0),
      glossLayers: Number(fRead("pglosslayers") || 0),
      inkMlPerSqft: 0.6,
      machineMinutesPerSqft: Number(fRead("pmachmin") || 0),
      machineSqftPerHour: printerSave === "roland" ? printerSpeedsSave.roland : printerSpeedsSave.mimaki, // 15F.0-D verified speed
      machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value, // provisional owner standard (15B: single source)
      cutType: normalizeCutType(fRead("pcut")), // 15F.0-E (legacy kiss/weeded -> square-rect)
      cutRequiresWeeding: fRead("pcut") === "weeded",
      hemming: fRead("phem") === "1",
      grommets: fRead("pgrommet") === "1",
      freightPerUnit: 0,
      freightSource: "estimated",
      recipeWastePct: null,
      wasteOverride: fRead("pwasteoverride") && fRead("pwastereason") ? { pct: Number(fRead("pwasteoverride")), reason: fRead("pwastereason") } : null,
      boxOverride: fRead("pboxoverride") && fRead("pboxreason") ? { unitsPerBox: Number(fRead("pboxoverride")), reason: fRead("pboxreason") } : null,
    };
    productSnapshot = computeProductDrivenCost(productInputSave);
    eVar = productSnapshot.perUnitVariable;
    eSetup = productSnapshot.setupTotal;
    // ---- 14C.2: recompute the automatic tiers server-side and resolve the
    // selected customer tier by QUANTITY — posted tier totals are ignored.
    savedMarginKey = marginFamilyKeyFor(pFamilySave, savedClassification ? savedClassification.klass : null, savedBlank?.name || "");
    savedMarginRule = savedMarginKey ? resolveMarginFamily(savedMarginKey) : null;
    const baseQuantitiesSave = savedIsDtp && !fRead("eqty") ? DTP_LADDER_QUANTITIES : quantities;
    const tierQuantitiesSave = [...new Set([...baseQuantitiesSave, savedRequestedQty])].filter((value) => value > 0).sort((a, b) => a - b);
    const validMargins = margins.filter((value) => Number.isFinite(value) && value > 0);
    // 15F.0-C: quantity-band margins at save — identical resolver to the loader.
    const provisionalRuleSave: FamilyMarginRule = { key: "provisional-universal", label: "Provisional universal curve", curve: [...PROVISIONAL_MARGIN_CURVE], familyMinPct: MARGIN_FLOOR_PCT, aliases: [] };
    const marginRuleForPricingSave = savedMarginRule ?? provisionalRuleSave;
    const premiumEligibleSave = savedEngineFamily === "stickers-labels" && (Number(fRead("pwhitelayers") || 0) > 0 || Number(fRead("pglosslayers") || 0) > 0);
    const curveDefaultsSave = savedIsDtp
      ? tierQuantitiesSave.map((qty) => dtpMarginPctForQuantity(qty)) // 15C.1: same quantity-threshold rule at save
      : tierQuantitiesSave.map((qty) => marginPctForQuantity(marginRuleForPricingSave, qty));
    const tierMarginsSave = validMargins.length === tierQuantitiesSave.length ? validMargins : curveDefaultsSave;
    const freightInputsSave = {
      actualFreight: Number(fRead("efactual") || 0), handling: Number(fRead("efhandling") || 0), otherFees: Number(fRead("effees") || 0),
      estimatedAllowance: Number(fRead("efallow") || 0), allocation: ((fRead("efalloc") as any) || "per_unit") as "per_unit" | "by_value" | "manual", manualPerUnit: Number(fRead("efmanual") || 0),
    };
    const floorForFamilySave = Math.max(savedMarginRule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT);
    savedTiers = tierQuantitiesSave.map((qty, index) => {
      const run = qty === savedRequestedQty ? productSnapshot! : computeProductDrivenCost({ ...productInputSave, quantity: qty });
      const tierFreight = savedIsDtp ? { total: 0, perUnit: 0, source: "verified" as const, note: "" } : computeFreight(freightInputsSave, qty, 0);
      if (savedIsDtp) {
        // 15C.2: recompute the owner-ladder price server-side — posted totals ignored
        const dtpRow = priceDtpQuote({
          ladderSku: String(savedFetched?.meta?.vendorSku || ""),
          quantity: qty,
          landedCost: run.totalCost,
          missingCost: run.missing.length > 0,
          designs: Number(fRead("pdesigns") || 0),
          customUnitPrice: qty === savedRequestedQty && Number(fRead("pdtpcustomprice") || 0) > 0 ? Number(fRead("pdtpcustomprice")) : null,
          repeatOrder: fRead("pdtprepeat") === "1",
          passThroughFreight: fRead("pdtpfreightpass") === "1",
          freightAmount: savedDtpInput ? savedDtpInput.freightPerOrder : SPEKTRA_FREIGHT_PER_PO,
          override: { phrase: fRead("eophrase"), reason: fRead("eoreason") },
        });
        return {
          quantity: qty, requested: qty === savedRequestedQty,
          jobCost: run.totalCost, unitCost: run.unitCost,
          marginPct: Math.round(dtpRow.grossMarginPct * 10) / 10,
          unitPrice: dtpRow.unitPrice, totalPrice: dtpRow.customerTotal,
          profit: dtpRow.grossProfit, actualMarginPct: dtpRow.grossMarginPct,
          belowFloor: dtpRow.grossMarginPct < dtpRow.hardFloorPct,
          draftOnly: run.missing.length > 0,
          freightTotal: savedDtpInput ? savedDtpInput.freightPerOrder : SPEKTRA_FREIGHT_PER_PO,
          freightSource: savedDtpInput ? savedDtpInput.freightSource : "verified",
          setupTotal: run.setupTotal,
          status: dtpRow.status,
          dtp: {
            vendorTierLabel: run.lines.find((line) => line.key === "blank")?.label || null,
            ownerPriceTierUsed: dtpRow.ownerPriceTierUsed,
            defaultOwnerUnitPrice: dtpRow.defaultOwnerUnitPrice,
            customUnitPrice: dtpRow.customUnitPrice,
            baseSubtotal: dtpRow.customerBaseSubtotal,
            extraDesignCount: dtpRow.extraDesignCount,
            extraDesignFeeEach: dtpRow.extraDesignFeeEach,
            extraDesignFees: dtpRow.extraDesignFees,
            designFeeWaived: dtpRow.designFeeWaived,
            freightTreatment: dtpRow.freightTreatment,
            customerFreight: dtpRow.customerFreight,
            hardFloorPct: dtpRow.hardFloorPct,
            statusReasons: dtpRow.statusReasons,
            overrideRequired: dtpRow.overrideRequired,
            overrideSatisfied: dtpRow.overrideSatisfied,
          },
        };
      }
      // 15F.0-H: identical commercial resolution to the loader (parity).
      const overrideMarginSave = validMargins.length === tierQuantitiesSave.length ? validMargins[index] : null;
      const completeCost = run.totalCost + tierFreight.total;
      const commercial = computeCommercialPrice({
        familyKey: canonicalUiFamily(pFamilySave), quantity: qty, completeCost,
        marginRule: marginRuleForPricingSave, premiumEligible: premiumEligibleSave,
        marginPctOverride: overrideMarginSave,
        finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, // 15F.0-FINAL area floor inputs
      });
      const belowFloor = commercial.marginPctApplied < floorForFamilySave;
      return {
        quantity: qty, requested: qty === savedRequestedQty, jobCost: completeCost, unitCost: qty > 0 ? completeCost / qty : completeCost, marginPct: commercial.marginPctApplied,
        unitPrice: commercial.finalUnitPrice, totalPrice: commercial.finalTotalPrice, profit: commercial.achievedProfit, actualMarginPct: commercial.achievedMarginPct, belowFloor,
        draftOnly: run.missing.length > 0, freightTotal: tierFreight.total, freightSource: tierFreight.source, setupTotal: run.setupTotal,
        blockers: run.missing,
        commercial: { version: commercial.version, candidates: commercial.candidates, controllingRule: commercial.controllingRule, marginSource: commercial.marginSource, premiumApplied: premiumEligibleSave },
        status: run.missing.length ? "BLOCKED" : belowFloor ? "BELOW FLOOR — override required" : "READY TO QUOTE",
      };
    });
    const selectedTierQty = Math.floor(Number(fRead("pseltier") || 0));
    savedSelectedTier = savedTiers.find((tier) => tier.quantity === selectedTierQty)
      || savedTiers.find((tier) => tier.requested)
      || savedTiers[savedTiers.length - 1];
    // 15F.0-K: multi-line sticker jobs — recompute the SAME combined quote at
    // save (posted totals ignored) and make it the selected/customer figure.
    const lineCountSave = Math.floor(Number(fRead("pslcount") || 0));
    if (savedEngineFamily === "stickers-labels" && lineCountSave >= 2) {
      const lineInputsSave = buildStickerLines({
        count: lineCountSave,
        names: fReadAll("pslname"),
        quantities: fReadAll("pslqty").map(Number),
        designs: fReadAll("psldesigns").map(Number),
        widths: fReadAll("pslw").map(Number),
        heights: fReadAll("pslh").map(Number),
        materialIds: fReadAll("pslmat"),
        printers: fReadAll("pslprinter"),
        whites: fReadAll("pslwhite").map(Number),
        glosses: fReadAll("pslgloss").map(Number),
        cuts: fReadAll("pslcut"),
      });
      const lineMaterialRecords = await db.material.findMany({ where: { shop, id: { in: lineInputsSave.map((line) => line.materialId).filter(Boolean) } } });
      const lineMaterialByIdSave = new Map(lineMaterialRecords.map((record) => [record.id, record]));
      const lineResultsSave = lineInputsSave.map((line) => {
        const record = lineMaterialByIdSave.get(line.materialId);
        const resolved = record ? resolvePrintMaterialCostPerSqft(record) : null;
        const run = computeProductDrivenCost({
          family: "stickers-labels", quantity: Math.max(1, line.quantity), designs: line.designs,
          facesPerUnit: 1, widthIn: line.widthIn, heightIn: line.heightIn, labelRows: null, dtp: null,
          blank: null, lid: null, mironTop: null,
          material: record ? { name: record.name, costPerSqft: resolved && resolved.unitCost > 0 ? resolved.unitCost : null } : null,
          printer: line.printer, printerHasWhite: true, printerHasGloss: line.printer === "roland",
          whiteLayers: line.whiteLayers, glossLayers: line.glossLayers, inkMlPerSqft: 0.6,
          machineMinutesPerSqft: 0, machineSqftPerHour: line.printer === "roland" ? printerSpeedsSave.roland : printerSpeedsSave.mimaki,
          machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
          cutType: normalizeCutType(line.cutType), cutRequiresWeeding: false,
          hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated",
          recipeWastePct: null, wasteOverride: null, boxOverride: null,
        });
        const packingAmount = run.lines.find((engineLine) => engineLine.key === "packing")?.amount || 0;
        return {
          name: line.name, quantity: line.quantity, designs: line.designs,
          glossOrWhite: line.whiteLayers > 0 || line.glossLayers > 0,
          lineCost: run.totalCost - packingAmount,
          missing: run.missing,
          finishedSqft: run.derived.baseSqft, setupTotal: run.setupTotal, // 15F.0-FINAL floor inputs
        };
      });
      const totalUnitsSave = lineInputsSave.reduce((sum, line) => sum + Math.max(0, line.quantity), 0);
      savedMultiLine = combineStickerLines({
        lines: lineResultsSave,
        jobPackingCost: OWNER_STANDARDS.packoutPerBox.value * Math.max(1, Math.ceil(totalUnitsSave / 5000)),
        marginRule: resolveMarginFamily("stickers-labels"),
      });
      const combinedQty = Math.max(1, savedMultiLine.totalQuantity);
      savedSelectedTier = {
        quantity: combinedQty,
        requested: true,
        jobCost: savedMultiLine.totalCost,
        unitCost: savedMultiLine.totalCost / combinedQty,
        marginPct: Math.round(savedMultiLine.achievedMarginPct * 10) / 10,
        unitPrice: savedMultiLine.finalTotalPrice / combinedQty,
        totalPrice: savedMultiLine.finalTotalPrice,
        profit: savedMultiLine.achievedProfit,
        actualMarginPct: savedMultiLine.achievedMarginPct,
        belowFloor: savedMultiLine.achievedMarginPct < Math.max(savedMarginRule?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT),
        draftOnly: savedMultiLine.blockers.length > 0,
        freightTotal: 0,
        freightSource: "estimated",
        setupTotal: 0,
        blockers: savedMultiLine.blockers,
        commercial: { version: COMMERCIAL_PRICING_VERSION, candidates: null, controllingRule: `Multi-line sticker job — ${savedMultiLine.controllingRule}`, marginSource: "per-line researched quantity bands + area floors", premiumApplied: lineResultsSave.some((line) => line.glossOrWhite) },
        status: savedMultiLine.blockers.length ? "BLOCKED" : "READY TO QUOTE",
        multiLine: savedMultiLine,
      };
      savedTiers = [savedSelectedTier];
    }
    // 15C.2: DTP safeguards gate the SAVE — BLOCKED never saves; below-floor /
    // below-$500 requires the owner phrase + written reason (server-enforced).
    if (savedIsDtp && savedSelectedTier?.dtp) {
      if (savedSelectedTier.status === "BLOCKED") {
        return Response.json({ ok: false, message: `DTP quote BLOCKED: ${savedSelectedTier.dtp.statusReasons.join("; ")}. Fix the price/cost before saving.` });
      }
      if (savedSelectedTier.dtp.overrideRequired && !savedSelectedTier.dtp.overrideSatisfied) {
        return Response.json({ ok: false, message: `OWNER OVERRIDE REQUIRED: ${savedSelectedTier.dtp.statusReasons.join("; ")}. Type "${OVERRIDE_PHRASE}" and give a written reason in Advanced Pricing Controls.` });
      }
    }
  }
  // 14C.2: product saves gate/snapshot on the SERVER-derived family rule and
  // the recomputed automatic tiers; manual/auto saves keep the legacy path.
  const ruleForSave = productSnapshot ? savedMarginRule : familyRule;
  const snapshotTiers: any[] = productSnapshot && savedTiers ? savedTiers : tiers;
  // 15C.2: DTP uses its OWN floors (30/35/38 + $500/$350 profit rules,
  // enforced above with the owner phrase) — the generic 40% gate would wrongly
  // block owner-approved DTP prices. All other families keep the generic gate.
  const savedIsDtpGate = savedEngineFamily === "dtp-bags";
  const gate = savedIsDtpGate && savedSelectedTier?.dtp
    ? {
        allowed: true,
        belowFloor: Boolean(savedSelectedTier.dtp.overrideRequired),
        reason: savedSelectedTier.dtp.overrideRequired && savedSelectedTier.dtp.overrideSatisfied
          ? `OWNER OVERRIDE below the DTP floor/target: ${fRead("eoreason").trim()}`
          : savedSelectedTier.dtp.statusReasons.join("; ") || null,
      }
    : checkMarginGate(Math.min(...snapshotTiers.map((tier: any) => tier.marginPct)), { phrase: fRead("eophrase"), reason: fRead("eoreason") }, ruleForSave?.familyMinPct ?? MARGIN_FLOOR_PCT);
  const lines: CostLine[] = [
    { key: "variable_per_unit", label: "Per-unit variable cost (entered)", amount: eVar, source: eVar > 0 ? "manual_override" : "missing" },
    { key: "freight", label: "Freight", amount: freight.total, source: freight.source, note: freight.note },
  ];
  const verdict = canFinalize(lines.filter((line) => line.key !== "freight"), gate);
  if (!verdict.ok && !gate.allowed) return Response.json({ ok: false, message: verdict.blockers.join(" | ") });
  const primary: any = productSnapshot && savedSelectedTier ? savedSelectedTier : tiers[tiers.length - 1];
  const familyDefaults = ruleForSave ? curveForTierCount(ruleForSave.curve, snapshotTiers.length, ruleForSave.familyMinPct) : defaultTierMargins(snapshotTiers.length);
  const savedIsDtpSnapshot = savedEngineFamily === "dtp-bags";
  const snapshot = {
    // 15F.0: non-DTP product saves record the production-ready engine; DTP
    // keeps its 15C.2 version. Historical snapshots are never rewritten.
    engine: productSnapshot ? (savedIsDtpSnapshot ? DTP_PRICING_ENGINE_VERSION : PRODUCTION_READY_ENGINE_VERSION) : isAuto ? "14B.1a-auto" : "14B.0A-emergency",
    autoBreakdown: autoSnapshot ? { lines: autoSnapshot.lines, missing: autoSnapshot.missing, warnings: autoSnapshot.warnings } : null,
    productBreakdown: productSnapshot ? {
      engine: savedIsDtpSnapshot ? DTP_PRICING_ENGINE_VERSION : PRODUCTION_READY_ENGINE_VERSION,
      costEngine: savedIsDtpSnapshot ? DTP_ENGINE_VERSION : MULTILABEL_ENGINE_VERSION,
      topEngine: TOP_ENGINE_VERSION,
      // 15F.0-H/P: the commercial decision for the SELECTED tier — candidates,
      // controlling rule, and final figures (posted totals were ignored).
      commercialPricing: !savedIsDtpSnapshot && savedSelectedTier?.commercial ? {
        version: COMMERCIAL_PRICING_VERSION,
        controllingRule: savedSelectedTier.commercial.controllingRule,
        marginSource: savedSelectedTier.commercial.marginSource,
        premiumApplied: savedSelectedTier.commercial.premiumApplied,
        candidates: savedSelectedTier.commercial.candidates,
        finalTotalPrice: savedSelectedTier.totalPrice,
        finalUnitPrice: savedSelectedTier.unitPrice,
        achievedProfit: savedSelectedTier.profit,
        achievedMarginPct: savedSelectedTier.actualMarginPct,
        shippingOwnership: "Outbound customer delivery/shipping excluded from the product price (quoted separately); inbound vendor freight remains a production cost.",
      } : null,
      multiLine: savedMultiLine ? { lines: savedMultiLine.lines, totalQuantity: savedMultiLine.totalQuantity, totalCost: savedMultiLine.totalCost, finalTotalPrice: savedMultiLine.finalTotalPrice, achievedMarginPct: savedMultiLine.achievedMarginPct, blockers: savedMultiLine.blockers } : null,
      designSplit: !savedIsDtpSnapshot && savedEngineFamily === "stickers-labels" && Number(fRead("pdesigns") || 0) > 1
        ? designSplit(savedRequestedQty, Number(fRead("pdesigns"))).text
        : null,
      family: pFamilySave,
      canonicalFamily: canonicalUiFamily(pFamilySave),
      classification: savedClassification ? savedClassification.klass : null,
      includesTop: savedClassification ? savedClassification.includesTop : false,
      // physical Miron Top Type only — never a printed "Lid label" row
      topId: savedEngineFamily === "miron-jars" ? (fRead("plid") || null) : null,
      labelsPerUnit: savedLabelRows ? savedLabelRows.length : Math.max(1, Number(fRead("pfaces") || 1)),
      sameSizeLabels: savedLabelRows ? savedSameSize : null,
      labelRows: savedLabelRows,
      // 15C/15C.2: full DTP record — size, vendor tier, OWNER pricing, safeguards
      dtpPricing: savedIsDtpSnapshot && savedSelectedTier?.dtp ? {
        engine: DTP_PRICING_ENGINE_VERSION,
        ownerPriceTierUsed: savedSelectedTier.dtp.ownerPriceTierUsed,
        defaultOwnerUnitPrice: savedSelectedTier.dtp.defaultOwnerUnitPrice,
        customUnitPrice: savedSelectedTier.dtp.customUnitPrice,
        unitPrice: savedSelectedTier.unitPrice,
        baseSubtotal: savedSelectedTier.dtp.baseSubtotal,
        extraDesignCount: savedSelectedTier.dtp.extraDesignCount,
        extraDesignFeeEach: savedSelectedTier.dtp.extraDesignFeeEach,
        extraDesignFees: savedSelectedTier.dtp.extraDesignFees,
        designFeeWaived: savedSelectedTier.dtp.designFeeWaived,
        freightTreatment: savedSelectedTier.dtp.freightTreatment,
        customerFreight: savedSelectedTier.dtp.customerFreight,
        customerTotal: savedSelectedTier.totalPrice,
        landedCost: savedSelectedTier.jobCost,
        grossProfit: savedSelectedTier.profit,
        grossMarginPct: savedSelectedTier.actualMarginPct,
        hardFloorPct: savedSelectedTier.dtp.hardFloorPct,
        minJobProfit: 500,
        strategicMinJobProfit: 350,
        marginWarningTargetPct: 40,
        status: savedSelectedTier.status,
        statusReasons: savedSelectedTier.dtp.statusReasons,
        overrideRequired: savedSelectedTier.dtp.overrideRequired,
        overrideReason: savedSelectedTier.dtp.overrideSatisfied ? fRead("eoreason").trim() : null,
      } : null,
      dtp: savedIsDtpSnapshot && productSnapshot ? (() => {
        const blankLine = productSnapshot.lines.find((line) => line.key === "blank");
        const freightLine = productSnapshot.lines.find((line) => line.key === "freight");
        const artLine = productSnapshot.lines.find((line) => line.key === "art_setup");
        return {
          size: fRead("pblank") || null,
          sizeLabel: blankLine?.label || null,
          requestedQuantity: savedRequestedQty,
          vendorSubtotal: blankLine?.amount ?? null,
          vendorTierLabel: blankLine?.label ?? null,
          vendorUnitCost: blankLine ? blankLine.amount / Math.max(1, savedRequestedQty) : null,
          freight: freightLine?.amount ?? null,
          freightSource: freightLine?.source ?? null,
          designs: Number(fRead("pdesigns") || 0),
          designCharge: artLine?.amount ?? null,
          designRule: "GSO art/design $8.3333 per design; no in-house print setup (outsourced production)",
          includedFeatures: productSnapshot.lines.find((line) => line.key === "features")?.label || null,
          hangHole: fRead("phanghole") === "yes",
          moq: officialMoqForFamily("dtp-pouches") || 1000,
          freightRule: "One $85 flat charge per Spektra purchase order; multi-line orders allocate the single charge across combined units (future phase).",
        };
      })() : null,
      lines: productSnapshot.lines, derived: productSnapshot.derived, missing: productSnapshot.missing, warnings: productSnapshot.warnings,
      tiers: savedTiers,
      selectedTier: savedSelectedTier ? { quantity: savedSelectedTier.quantity, unitPrice: savedSelectedTier.unitPrice, totalPrice: savedSelectedTier.totalPrice, marginPct: savedSelectedTier.marginPct, status: savedSelectedTier.status } : null,
      selections: { blank: fRead("pblank"), lid: fRead("plid"), material: fRead("pmat"), printer: fRead("pprinter") || "mimaki", whiteLayers: Number(fRead("pwhitelayers") || 0), glossLayers: Number(fRead("pglosslayers") || 0), faces: Number(fRead("pfaces") || 1), widthIn: Number(fRead("pwidth") || 0), heightIn: Number(fRead("pheight") || 0), quantity: savedRequestedQty, designs: Number(fRead("pdesigns") || 0) },
    } : null,
    savedAt: new Date().toISOString(), tiers: snapshotTiers, freight, gate,
    marginRules: {
      family: ruleForSave ? ruleForSave.key : "unknown", familyLabel: ruleForSave?.label || "FAMILY MARGIN RULE NOT CONFIGURED",
      curveUsed: ruleForSave ? ruleForSave.curve : "provisional-universal", researchedDefaultsPerTier: familyDefaults,
      editedMarginsPerTier: snapshotTiers.map((tier: any) => tier.marginPct), familyMinPct: ruleForSave?.familyMinPct ?? MARGIN_FLOOR_PCT,
      globalFloorPct: MARGIN_FLOOR_PCT, overrideReason: gate.reason, ruleSource: ruleForSave ? MARGIN_RULE_SOURCE : "provisional",
    },
    warnings: snapshotTiers.flatMap((tier: any) => tier.warnings || []), inputs: { quantities, margins, eVar, eSetup, eBlank, eWaste },
  };
  // 15D.2: authoritative product name (placeholder fragments stripped; never
  // a concatenated placeholder): explicit entry -> record name -> family label.
  const productName = resolveProductDisplayName([
    rawProductNameEntry,
    savedBlankNameForNaming,
    pFamilySave ? familyByKeyOrAlias(pFamilySave)?.label : null,
  ]);
  const quote = await db.quote.create({
    data: {
      shop, status: "draft", customerName: String(form.get("ecustomer") || "") || fRead("pcustomer") || null,
      notes: `${productSnapshot ? (savedIsDtpSnapshot ? "15C DTP calculator draft" : "14C.2 product calculator draft") : "14B.0 emergency calculator draft"}${fRead("pnotes") ? " — " + fRead("pnotes").slice(0, 240) : ""}${verdict.ok ? "" : " — WARNINGS: " + verdict.blockers.join("; ")}`,
      items: { create: [{ productName, quantity: primary.quantity, unitCost: primary.unitCost, unitPrice: primary.unitPrice, notes: gate.reason || null, costSnapshot: JSON.stringify(snapshot), priceSnapshot: JSON.stringify({ unitPrice: primary.unitPrice, marginPct: primary.marginPct, tiers: snapshotTiers.map((tier: any) => ({ qty: tier.quantity, unitPrice: tier.unitPrice, marginPct: tier.marginPct })) }) }] },
    },
  });
  return Response.json({ ok: true, message: `Draft quote ${quote.id.slice(0, 8)}… saved with the full tier snapshot${verdict.ok ? "" : " (DRAFT ONLY — has warnings)"}. Open Quotes to finish it.` });
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, background: "white" };
const codeStyle: React.CSSProperties = { background: "#111827", color: "#f9fafb", padding: 10, borderRadius: 8, display: "block", overflowX: "auto", fontSize: 12 };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };
const secondaryButtonStyle: React.CSSProperties = { padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" };

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;
type LineData = LoaderData["form"]["lines"][number];

function blankLine(index: number): LineData {
  return {
    index,
    name: "",
    quantity: 0,
    widthIn: 0,
    heightIn: 0,
    materialId: "",
    customMaterialCostPerSqft: 0,
    wastePct: 10,
    quoteId: "",
    ripResultMode: "per-piece",
    inkEstimateProfile: "cmyk-heavy",
    customInkCostPerSqft: 0,
    labelType: "side",
    labelTypeName: "Side label",
    baseSqft: 0,
    wasteAdjustedSqft: 0,
    effectiveUnits: 0,
    materialName: "Custom material",
    materialCostPerSqft: 0,
    materialCost: 0,
    inkSource: "Estimated cmyk-heavy",
    inkCost: 0,
    inkCc: 0,
    unitCost: 0,
    totalCost: 0,
    isBlank: true,
    isComplete: false,
    warnings: [],
  };
}

// One label/print line. Material and ink-profile selects are controlled with
// local state so choosing "custom" reveals its field instantly, without the
// old requestSubmit-on-change page reload.
function LineRow({
  line,
  quoteMode,
  materials,
  rows,
}: {
  line: LineData;
  quoteMode: string;
  materials: LoaderData["materials"];
  rows: LoaderData["rows"];
}) {
  const [materialId, setMaterialId] = useState(line.materialId);
  const [inkProfile, setInkProfile] = useState(line.inkEstimateProfile);
  const selectedMaterial = materials.find((m) => m.id === materialId);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f9fafb" }}>
      <h4 style={{ margin: "0 0 10px" }}>Line {line.index + 1}: {line.name || "New label"}</h4>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr", gap: 10 }}>
        <label>Label name<br /><input name="lineName" defaultValue={line.name} placeholder="Example: Side label" style={inputStyle} /></label>
        <label>Qty<br /><input name="lineQty" type="number" defaultValue={line.quantity || ""} placeholder="Enter qty" style={inputStyle} /></label>
        <label>Width in<br /><input name="lineWidthIn" type="number" step="0.01" defaultValue={line.widthIn || ""} placeholder="Width" style={inputStyle} /></label>
        <label>Height in<br /><input name="lineHeightIn" type="number" step="0.01" defaultValue={line.heightIn || ""} placeholder="Height" style={inputStyle} /></label>
        <label>Label type<br />
          <select name="lineLabelType" defaultValue={line.labelType} style={inputStyle}>
            <option value="side">Side label</option>
            <option value="lid">Lid label</option>
            <option value="lid-side">Lid side label</option>
            <option value="front">Front label</option>
            <option value="back">Back label</option>
            <option value="warning">Warning label</option>
            <option value="box">Box label</option>
            <option value="custom">Custom label</option>
          </select>
        </label>
        <label style={{ gridColumn: "1 / 3" }}>Material / print media (from Materials)<br />
          <select name="lineMaterialId" value={materialId} onChange={(event) => setMaterialId(event.currentTarget.value)} style={inputStyle}>
            <option value="">Select material</option>
            {materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.name} - {material.costWarning ? "no cost set" : `${money(material.displayCostPerSqft)}/sqft`}
              </option>
            ))}
            <option value="custom">Custom one-time material price</option>
          </select>
          <div style={smallHelp}>
            {materialId === ""
              ? materials.length
                ? "Select a material to calculate material cost."
                : "No print materials found. Add roll media in Materials, or use the custom one-time price."
              : materialId === "custom"
                ? "Using one-time custom material price below."
                : selectedMaterial?.costWarning
                  ? selectedMaterial.costWarning
                  : `Using saved material cost: ${money(selectedMaterial?.displayCostPerSqft || 0)}/sqft.`}
          </div>
        </label>
        {materialId === "custom" ? (
          <label>Custom material $/sqft<br /><input name="lineCustomMaterialCostPerSqft" type="number" step="0.0001" defaultValue={line.customMaterialCostPerSqft || ""} placeholder="Cost/sqft" style={inputStyle} /></label>
        ) : (
          <input type="hidden" name="lineCustomMaterialCostPerSqft" value={line.customMaterialCostPerSqft} />
        )}
        <label>Waste %<br /><input name="lineWastePct" type="number" step="0.1" defaultValue={line.wastePct} style={inputStyle} /></label>

        {quoteMode === "actual" ? (
          <>
            <label style={{ gridColumn: "1 / 3" }}>GSOQ RIP result for this line<br />
              <select name="lineQuoteId" defaultValue={line.quoteId} style={inputStyle}>
                {rows.length ? rows.map((row) => <option key={`${row.quoteId}-${row.fileName}`} value={row.quoteId}>{row.quoteId} - {row.fileName}</option>) : <option value="">No synced GSOQ results yet</option>}
              </select>
              <div style={smallHelp}>Actual mode uses synced RasterLink/VersaWorks ink from the selected GSOQ result.</div>
            </label>
            <label>RIP mode<br />
              <select name="lineRipResultMode" defaultValue={line.ripResultMode} style={inputStyle}>
                <option value="per-piece">One piece/artboard</option>
                <option value="full-job">Full production layout</option>
              </select>
            </label>
            <input type="hidden" name="lineInkEstimateProfile" value={inkProfile} />
            <input type="hidden" name="lineCustomInkCostPerSqft" value={line.customInkCostPerSqft} />
          </>
        ) : (
          <>
            <input type="hidden" name="lineQuoteId" value={line.quoteId} />
            <input type="hidden" name="lineRipResultMode" value={line.ripResultMode} />
            <label>Estimated ink profile<br />
              <select name="lineInkEstimateProfile" value={inkProfile} onChange={(event) => setInkProfile(event.currentTarget.value)} style={inputStyle}>
                <option value="cmyk-heavy">CMYK Heavy - $0.50/sqft</option>
                <option value="cmyk-white-heavy">CMYK + White Heavy - $1.00/sqft</option>
                <option value="cmyk-gloss-heavy">CMYK + Gloss Heavy - $1.00/sqft</option>
                <option value="cmyk-white-gloss-heavy">CMYK + White + Gloss Heavy - $1.50/sqft</option>
                <option value="cmyk-2x-gloss-heavy">CMYK + 2X Gloss Heavy - $1.50/sqft</option>
                <option value="cmyk-3x-gloss-heavy">CMYK + 3X Gloss Heavy - $2.00/sqft</option>
                <option value="cmyk-4x-gloss-heavy">CMYK + 4X Gloss Heavy - $2.50/sqft</option>
                <option value="custom">Custom ink $/sqft</option>
              </select>
              <div style={smallHelp}>Estimated mode ignores GSOQ files until artwork is ready.</div>
            </label>
            {inkProfile === "custom" ? (
              <label>Custom ink $/sqft<br /><input name="lineCustomInkCostPerSqft" type="number" step="0.0001" defaultValue={line.customInkCostPerSqft || ""} placeholder="Ink cost/sqft" style={inputStyle} /></label>
            ) : (
              <input type="hidden" name="lineCustomInkCostPerSqft" value={line.customInkCostPerSqft} />
            )}
          </>
        )}
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
        {num(line.baseSqft, 2)} base sqft · {num(line.wasteAdjustedSqft, 2)} waste sqft · {line.materialName} · material {money(line.materialCost)} · ink {money(line.inkCost)} ({line.inkSource})
      </div>
    </div>
  );
}

export default function ErpCostCalculatorRoute() {
  const { syncEndpoint, uploadToken, rows, lastAutoImportAt, materials, blankItems, form, calc } = useLoaderData<typeof loader>();
  const location = useLocation();

  return (
    <main style={{ maxWidth: 1280, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <EmergencySection />
      <details style={{ marginTop: 18, border: "1px solid #d1d5db", borderRadius: 12, padding: 12 }}>
        <summary style={{ fontWeight: 700, cursor: "pointer" }}>Advanced Pricing Tools</summary>
      <p><a href="/app/erp/rip-imports">← RIP Imports</a> · <a href="/app/erp/product-setup">Product Setup / Recipes</a> · <a href="/app/erp/materials">Materials</a> · <a href="/app/erp/cost-health">Cost Health</a></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#14532d)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>GSO Quote Builder / Cost Calculator</h1>
        <p style={{ marginBottom: 0 }}>v2.1 (13A.3): owner labor standards are LIVE for comparable labor lines — jar/4x5/14x16 application, design setup, gloss/white setup. Print media costs come from the Materials database, blank/vendor items use quantity cost tiers, waste math matches the quote engine, and the form only recalculates when you press Calculate.</p>
      </section>

      <section style={{ marginTop: 16, border: "2px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "12px 16px", fontWeight: 700 }}>
        Estimate only — not saved to quote, recipe, or Shopify.
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: rows.length ? "#bbf7d0" : "#fde68a", background: rows.length ? "#f0fdf4" : "#fffbeb" }}>
        <h2 style={{ marginTop: 0 }}>Sync control</h2>
        {uploadToken ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div><b>Synced GSOQ results:</b> {rows.length}</div>
            <div><b>Last sync:</b> {lastAutoImportAt ? new Date(lastAutoImportAt).toLocaleString() : "Not synced yet"}</div>
            <div><b>Upload endpoint:</b> <code>{syncEndpoint}</code></div>
            <div><b>Upload token:</b> <code>{uploadToken}</code></div>
            <code style={codeStyle}>powershell -ExecutionPolicy Bypass -File .\tools\gso-sync-quote-rip-results-to-app.ps1 -AppUrl "{new URL(syncEndpoint).origin}" -Token "{uploadToken}"</code>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#92400e" }}>
            RIP sync is not initialized for this shop yet. Open <a href="/app/erp/rip-imports">RIP Imports</a> or <a href="/app/erp/print-log-settings">Print Log Settings</a> once to create the sync settings, then return here. This page never creates settings itself.
          </div>
        )}
      </section>

      <CalculatorForm key={location.search} rows={rows} materials={materials} blankItems={blankItems} form={form} calc={calc} />

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Recent synced GSOQ results</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Imported</th><th align="left">Quote</th><th align="left">File</th><th>Ink cc</th><th>RIP sec</th><th>Ink cost</th><th>Confidence</th></tr></thead>
          <tbody>
            {rows.slice(0, 25).map((row) => (
              <tr key={`${row.quoteId}-${row.fileName}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{row.importedAt}</td><td>{row.quoteId}</td><td>{row.fileName}</td><td align="center">{num(row.totalCc)}</td><td align="center">{num(row.ripSeconds, 0)}</td><td align="center">{money(row.estimatedInkCost)}</td><td align="center">{row.confidence}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={7} style={{ padding: 12, color: "#6b7280" }}>No synced GSOQ results yet. Run the local sync script after a GSOQ RasterLink capture/import.</td></tr> : null}
          </tbody>
        </table>
      </section>
      </details>
      <details style={{ marginTop: 18, border: "1px solid #d1d5db", borderRadius: 12, padding: 12 }}>
        <summary style={{ fontWeight: 700, cursor: "pointer" }}>Legacy Manual Calculator — Fallback Only</summary>
        <p style={{ color: "#92400e", fontSize: 13 }}>Use only for unsupported products or special jobs that cannot yet be calculated automatically.</p>
      </details>
    </main>
  );
}

// ---- 14B.0 Emergency pricing panel (tiers + freight + margin floor + draft save) ----
function EmergencySection() {
  const { emergency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { ok: boolean; message: string } | undefined;
  const legacySearch = useLocation().search.replace(/^\?/, ""); // identical on server and client — hydration-safe
  const money2 = (value: number) => `$${value.toFixed(2)}`;
  return (
    <section style={{ ...cardStyle, marginTop: 18, borderColor: "#b45309", borderWidth: 2 }}>
      {/* 14B.1a: Automatic Costing form (Recommended) — server computes everything */}
      <div style={{ borderTop: "2px solid #b45309", marginTop: 14, paddingTop: 12 }}>
        <h3 style={{ margin: "0 0 4px" }}>Cost Calculator</h3>
        <p style={smallHelp}>Choose a product family and enter the job details to begin.</p>
        <p style={smallHelp}>Uses verified ERP costs + owner standards. The manual fields above are the FALLBACK for unsupported/special jobs. Pick a family, fill the fields, CALCULATE COST — the server resolves and computes everything; browser totals are never trusted.</p>
        <ProductDrivenForm />
        <ProductBreakdown />
        <ProductTiers />
        {(emergency as any).autoCost ? (
          <div style={{ marginTop: 10 }}>
            <b style={{ fontSize: 13 }}>Automatic cost breakdown</b>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 6 }}>
              <tbody>
                {(emergency as any).autoCost.lines.map((line: any) => (
                  <tr key={line.key} style={{ borderTop: "1px solid #e5e7eb", background: line.source === "missing" ? "#fef2f2" : undefined }}>
                    <td style={{ padding: 5 }}>{line.label}</td>
                    <td align="right">${line.amount.toFixed(2)}</td>
                    <td style={{ paddingLeft: 8 }}><span style={{ fontWeight: 700, color: line.source === "verified" ? "#166534" : line.source === "owner_standard" ? "#1e40af" : line.source === "missing" ? "#991b1b" : "#92400e" }}>{String(line.source).replace(/_/g, " ")}</span>{line.note ? <span style={{ color: "#6b7280" }}> — {line.note}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(emergency as any).autoCost.missing.length ? (
              <div style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 8, padding: 8, fontSize: 13, fontWeight: 700, marginTop: 6 }}>
                COST NOT VERIFIED — DRAFT ONLY: {(emergency as any).autoCost.missing.join("; ")}
              </div>
            ) : <div style={{ color: "#166534", fontSize: 13, fontWeight: 700, marginTop: 6 }}>Finalizable: Yes — all lines verified/owner-standard/estimated.</div>}
            {emergency.tiers.length ? (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, fontSize: 13, marginTop: 8 }}>
                <b>Approved Customer Price summary (copy for invoice):</b>
                <pre style={{ margin: "6px 0 0", fontSize: 12, background: "#f9fafb", padding: 8, borderRadius: 6 }}>
{`Product: ${emergency.family.label}
Quantity: ${emergency.tiers[emergency.tiers.length - 1].quantity}
Unit price: $${emergency.tiers[emergency.tiers.length - 1].unitPrice.toFixed(2)}
Total: $${emergency.tiers[emergency.tiers.length - 1].totalPrice.toFixed(2)}
Freight (separate): $${emergency.freight.total.toFixed(2)} (${emergency.freight.source.toUpperCase()})
Setup/design fee included in pricing.`}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <details style={{ marginTop: 12 }}><summary style={{ fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Advanced Pricing Controls (custom tier quantities, target-margin edits, freight/handling, owner override)</summary>
      <h2 style={{ marginTop: 0 }}>Pricing Tiers &amp; Margin Review — family curves, {emergency.floor}% margin floor</h2>
      <p style={smallHelp}>
        PROVISIONAL margin curve (60/55/50/45/40 — editable per tier) until competitor research is done. Setup spreads
        across each tier quantity; every tier prices from its OWN cost (never a discount off tier 1). Freight stays a
        separate visible line. Prices below {emergency.floor}% margin are blocked without the owner override.
      </p>
      {actionData?.message ? (
        <div style={{ border: actionData.ok ? "1px solid #bbf7d0" : "1px solid #fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2", borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 600 }}>{actionData.message}</div>
      ) : null}
      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 10 }}>
        <b>Product family:</b> {emergency.family.label} · <b>Default curve:</b> {emergency.family.configured ? emergency.family.curve.join(" / ") + "%" : "provisional 60/55/50/45/40%"} ·{" "}
        <b>Family minimum:</b> {emergency.family.minPct}% · <b>Global floor:</b> {emergency.floor}% · <b>Rule source:</b> {emergency.family.source}
        {!emergency.family.configured && emergency.family.key ? <div style={{ color: "#92400e", fontWeight: 700 }}>FAMILY MARGIN RULE NOT CONFIGURED — using the provisional universal curve.</div> : null}
        <div style={{ color: "#6b7280" }}>Researched defaults for these tiers: {emergency.defaults.join(" / ")}% — edit margins freely below; edits are kept, defaults stay visible here.</div>
      </div>
      <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
        <label style={{ fontSize: 12 }}>Product family
          <select name="efamily" defaultValue={emergency.family.configured ? emergency.family.key : ""} style={inputStyle}>
            <option value="">— choose family (uses provisional curve) —</option>
            <option value="bags-4x5">4x5 sticker bags</option>
            <option value="chiron-jars">Chiron jars</option>
            <option value="miron-jars">Miron jars</option>
            <option value="stickers-labels">Standard stickers &amp; labels</option>
            <option value="spot-gloss-labels">Spot gloss labels</option>
            <option value="banners">Banners</option>
            <option value="dtp-pouches">DTP pouches</option>
            <option value="die-cut-bags">Die-cut bags</option>
            <option value="boxes">Boxes</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Tier quantities (comma list)<input name="eqty" defaultValue={emergency.quantities.join(",")} style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Tier margins % (comma list, blank = curve)<input name="emargin" defaultValue={emergency.margins.join(",")} style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Per-unit variable cost $ (material+ink+labor+machine)<input name="evar" type="number" step="0.0001" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Setup total $ (art+print, spreads by qty)<input name="esetup" type="number" step="0.01" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Blank unit cost $ (e.g. 0.09 4x5 bag)<input name="eblank" type="number" step="0.0001" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Waste %<input name="ewaste" type="number" step="0.1" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Actual freight $<input name="efactual" type="number" step="0.01" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Handling $<input name="efhandling" type="number" step="0.01" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Other landed fees $<input name="effees" type="number" step="0.01" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>ESTIMATED freight allowance $ (used only when no actuals)<input name="efallow" type="number" step="0.01" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Freight allocation<select name="efalloc" style={inputStyle}><option value="per_unit">Per unit</option><option value="by_value">By merchandise value</option><option value="manual">Manual per unit</option></select></label>
        <label style={{ fontSize: 12 }}>Manual freight $/unit<input name="efmanual" type="number" step="0.0001" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Owner override phrase (below-floor only)<input name="eophrase" placeholder="OWNER MARGIN OVERRIDE" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Override reason<input name="eoreason" style={inputStyle} /></label>
        <button type="submit" style={secondaryButtonStyle}>Recalculate tiers</button>
        <a href="/app/erp/cost-calculator" style={{ ...secondaryButtonStyle, textAlign: "center", textDecoration: "none", color: "inherit" }}>Reset</a>
      </Form>
      <p style={smallHelp}>
        Freight: {emergency.freight.note} — total {money2(emergency.freight.total)}, per unit {money2(emergency.freight.perUnit)} ({emergency.freight.source.toUpperCase()}).
        {emergency.gate.belowFloor ? ` MARGIN GATE: ${emergency.gate.reason}` : ""}
      </p>
      {emergency.tiers.some((tier) => tier.unitCost > 0) ? (
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#f3f4f6" }}><th align="left" style={{ padding: 6 }}>Qty</th><th>Blank/unit</th><th>Setup/unit</th><th>Unit cost</th><th>Margin %</th><th>Unit price</th><th>Total price</th><th>Profit</th><th align="left">Warnings</th></tr></thead>
          <tbody>
            {emergency.tiers.map((tier) => (
              <tr key={tier.quantity} style={{ borderTop: "1px solid #e5e7eb", background: tier.belowFloor ? "#fef2f2" : undefined }}>
                <td style={{ padding: 6 }}><b>{tier.quantity}</b></td>
                <td align="center">{tier.blankUnitCost == null ? "—" : money2(tier.blankUnitCost)}</td>
                <td align="center">{money2(tier.setupPerUnit)}</td>
                <td align="center">{money2(tier.unitCost)}</td>
                <td align="center">{tier.marginPct}%</td>
                <td align="center"><b>{money2(tier.unitPrice)}</b></td>
                <td align="center">{money2(tier.totalPrice)}</td>
                <td align="center">{money2(tier.profit)} ({tier.actualMarginPct.toFixed(1)}%)</td>
                <td style={{ color: "#92400e", fontSize: 12 }}>{tier.warnings.join("; ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
        <p style={{ ...smallHelp, marginTop: 8 }}>No tier rows yet — run CALCULATE COST above (or enter manual costs here) and the tier table fills in. Zero-value rows are never shown.</p>
      )}
      <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 10 }}>
        <input type="hidden" name="intent" value="saveEmergencyQuoteDraft" />
        {/* 14C.2: the full GET state (including multi-value label rows) rides in
            psearch; the single-value hidden inputs below stay for back-compat. */}
        <input type="hidden" name="psearch" value={legacySearch} />
        {["efamily", "eqty", "emargin", "evar", "esetup", "eblank", "ewaste", "efactual", "efhandling", "effees", "efallow", "efalloc", "efmanual", "eophrase", "eoreason", "pfamily", "pblank", "plid", "pmat", "pqty", "pdesigns", "pfaces", "pwidth", "pheight", "pprinter", "pwhitelayers", "pglosslayers", "pcut", "phem", "pgrommet", "pcustomname", "pcustomcost", "pcustomnote", "pwasteoverride", "pwastereason", "pboxoverride", "pboxreason", "pmachmin"].map((key) => (
          <input key={key} type="hidden" name={key} value={new URLSearchParams(legacySearch).get(key) || (key === "eqty" ? emergency.quantities.join(",") : key === "emargin" ? emergency.margins.join(",") : "")} />
        ))}
        <label style={{ fontSize: 12 }}>Product name<input name="eproduct" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Customer (optional)<input name="ecustomer" style={inputStyle} /></label>
        <button type="submit" style={{ padding: "10px 14px", borderRadius: 10, border: 0, background: "#111827", color: "white", fontWeight: 700 }}>Save as draft quote (snapshot)</button>
      </Form>
      <p style={smallHelp}>Saving creates a DRAFT quote with the full tier/freight/override snapshot — historical quotes are never touched. Finish it in Quotes / CRM.</p>

      </details>
    </section>
  );
}

// The whole form remounts (via key on location.search) after each Calculate,
// so client state re-seeds from the freshly parsed loader values.
function CalculatorForm({
  rows,
  materials,
  blankItems,
  form,
  calc,
}: {
  rows: LoaderData["rows"];
  materials: LoaderData["materials"];
  blankItems: LoaderData["blankItems"];
  form: LoaderData["form"];
  calc: LoaderData["calc"];
}) {
  const [quoteMode, setQuoteMode] = useState(form.quoteMode);
  const [lineCount, setLineCount] = useState(form.lineCount);
  const [itemMode, setItemMode] = useState(form.itemMode);
  const [itemId, setItemId] = useState(form.itemId);
  const [applicationMode, setApplicationMode] = useState(form.applicationMode);
  const [cuttingMode, setCuttingMode] = useState(form.cuttingMode);
  const [prepressMode, setPrepressMode] = useState(form.prepressMode);
  const [packoutMode, setPackoutMode] = useState(form.packoutMode);

  const visibleLines = Array.from({ length: lineCount }, (_, index) => form.lines[index] || blankLine(index));
  const selectedBlankItem = blankItems.find((item) => item.id === itemId) || null;

  return (
    <Form method="get" style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, marginTop: 16 }}>
      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Quote inputs</h2>
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13, color: "#1e3a8a" }}>
          <b>Staff flow:</b> enter all job info first, then press <b>Calculate cost</b> (Enter also calculates — it never adds or removes lines). Choose estimated mode before customer art, or actual GSOQ mode after RIP. Incomplete label lines are ignored until fixed.
        </div>
        {form.safetyWarnings.length ? (
          <div style={{ background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13, color: "#92400e" }}>
            <b>Quote check:</b>
            <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
              {form.safetyWarnings.map((warning: string) => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>Quote mode<br />
            <select name="quoteMode" value={quoteMode} onChange={(event) => setQuoteMode(event.currentTarget.value)} style={inputStyle}>
              <option value="estimated">Estimated quote - no customer art yet</option>
              <option value="actual">Actual GSOQ RIP quote - artwork is ready</option>
            </select>
            <div style={smallHelp}>Estimated uses ink/sqft profiles. Actual uses synced GSOQ RIP ink.</div>
          </label>
          <label>Target margin %<br /><input name="targetMarginPct" type="number" step="0.1" defaultValue={form.targetMarginPct} style={inputStyle} /></label>
          <label>Labor $ / hour<br /><input name="laborRatePerHour" type="number" step="0.01" defaultValue={form.laborRatePerHour} style={inputStyle} /></label>
          <label>Machine $ / hour<br /><input name="machineCostPerHour" type="number" step="0.01" defaultValue={form.machineCostPerHour} style={inputStyle} /></label>
          <label>Setup minutes<br /><input name="setupMinutes" type="number" step="0.1" defaultValue={form.setupMinutes} style={inputStyle} /></label>
          <label>Finishing minutes<br /><input name="finishingMinutes" type="number" step="0.1" defaultValue={form.finishingMinutes} style={inputStyle} /></label>
        </div>

        <h3>Label / print lines</h3>
        <input type="hidden" name="lineCount" value={lineCount} />
        <div style={{ display: "grid", gap: 12 }}>
          {visibleLines.map((line) => (
            <LineRow key={line.index} line={line} quoteMode={quoteMode} materials={materials} rows={rows} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => setLineCount((count) => Math.min(count + 1, 8))} style={secondaryButtonStyle}>+ Add label size</button>
          <button type="button" onClick={() => setLineCount((count) => Math.max(count - 1, 1))} style={secondaryButtonStyle}>Remove last label</button>
        </div>

        <h3>Blank item / product being labeled</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>Item mode<br />
            <select name="itemMode" value={itemMode} onChange={(event) => setItemMode(event.currentTarget.value)} style={inputStyle}>
              <option value="none">No blank item</option>
              <option value="inventory">Use inventory/vendor item</option>
              <option value="custom">Custom one-time item</option>
            </select>
            <div style={smallHelp}>{itemMode === "none" ? "No blank item selected." : `Item quantity auto-matches the main label quantity after Calculate: ${num(form.itemQty, 0)}.`}</div>
          </label>
          {itemMode === "inventory" ? (
            <label style={{ gridColumn: "1 / -1" }}>Inventory item<br />
              <select name="itemId" value={itemId} onChange={(event) => setItemId(event.currentTarget.value)} style={inputStyle}>
                <option value="custom">Custom item</option>
                {blankItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} - {item.hasTiers ? "tiered" : `${money(item.unitCost)} each`}{item.isPreset ? ` ${PRESET_LABEL}` : ""}
                  </option>
                ))}
              </select>
              {selectedBlankItem?.isPreset ? (
                <div style={{ ...smallHelp, color: "#92400e" }}>
                  {PRESET_LABEL} This cost is hardcoded in the app, not from the database. Enter it as a Vendor Product with tiers and verify against the vendor invoice, then the preset disappears automatically.
                </div>
              ) : null}
            </label>
          ) : <input type="hidden" name="itemId" value={itemId} />}
          {itemMode === "custom" ? (
            <>
              <label>Custom item name<br /><input name="customItemName" defaultValue={form.customItemName} style={inputStyle} /></label>
              <label>Custom item unit cost<br /><input name="customItemUnitCost" type="number" step="0.0001" defaultValue={form.customItemUnitCost} style={inputStyle} /></label>
            </>
          ) : (
            <>
              <input type="hidden" name="customItemName" value={form.customItemName} />
              <input type="hidden" name="customItemUnitCost" value={form.customItemUnitCost} />
            </>
          )}
          {itemMode !== "none" ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "#374151", background: "#f3f4f6", borderRadius: 10, padding: 10 }}>
              Item cost preview (updates on Calculate): {calc.itemName}. Base qty {num(calc.itemQty, 0)}{calc.itemWastePct ? ` + ${num(calc.itemWastePct, 1)}% waste = ${num(calc.itemCostQty, 0)} costed units` : ""} × {money(calc.itemUnitCost)} {calc.itemTierLabel !== "fixed" ? `(tier ${calc.itemTierLabel})` : ""} = {money(calc.itemCost)}.
            </div>
          ) : null}
        </div>

        <h3>Application / finishing</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>Application type<br />
            <select name="applicationMode" value={applicationMode} onChange={(event) => setApplicationMode(event.currentTarget.value)} style={inputStyle}>
              <option value="none">No application</option>
              <option value="apply-flat-bag">Apply label to flat bag/pouch</option>
              <option value="apply-jar">Apply label to jar</option>
              <option value="apply-box">Apply label to box</option>
              <option value="apply-tube">Apply label to round tube</option>
              <option value="apply-label-set">Apply full label set to item</option>
              <option value="custom">Custom application</option>
            </select>
            <div style={smallHelp}>Application quantity and seconds are calculated from the selected blank item and each line label type when you press Calculate.</div>
          </label>
          {applicationMode === "custom" ? (
            <>
              <label>Custom seconds per unit<br /><input name="applicationSecondsPerUnit" type="number" step="0.1" defaultValue={form.applicationSecondsPerUnit || 8} style={inputStyle} /></label>
              <label>Extra application $/unit<br /><input name="applicationUnitCost" type="number" step="0.0001" defaultValue={form.applicationUnitCost} style={inputStyle} /></label>
            </>
          ) : (
            <>
              <input type="hidden" name="applicationSecondsPerUnit" value={form.applicationSecondsPerUnit} />
              <input type="hidden" name="applicationUnitCost" value={form.applicationUnitCost} />
            </>
          )}
          {applicationMode !== "none" ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "#374151", background: "#f3f4f6", borderRadius: 10, padding: 10 }}>
              {calc.applicationWired
                ? <>Owner-standard application labor: {form.applicationLineDetails.map((detail) => `${detail.lineName} ${detail.labelType}: ${num(detail.apps, 0)} × ${money(detail.ratePerApp || 0)}/app`).join("; ")} = {money(calc.applicationLaborCost)} (all-in rate; no separate setup minutes).</>
                : <>Auto application labor rule: {form.applicationName}. {form.applicationLineDetails.map((detail) => `${detail.lineName} ${detail.labelType}: ${num(detail.apps, 0)} × ${num(detail.seconds, 2)} sec`).join("; ")} + {num(form.applicationSetupMinutes, 1)} min application setup = {num(calc.applicationLaborMinutes, 1)} min / {money(calc.applicationLaborCost)} (legacy heuristic — no owner standard for this item yet).</>}
            </div>
          ) : null}
        </div>

        <h3>Optional cutting / finishing</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label>Cutting / finishing type<br />
            <select name="cuttingMode" value={cuttingMode} onChange={(event) => setCuttingMode(event.currentTarget.value)} style={inputStyle}>
              <option value="none">No cutting / finishing</option>
              <option value="square">Square/rectangle cut</option>
              <option value="contour">Contour cut</option>
              <option value="diecut">Die-cut sticker</option>
              <option value="sheet">Sheet cut / trim down</option>
              <option value="weed">Weeded decal</option>
              <option value="custom">Custom cutting / finishing</option>
            </select>
          </label>
          {cuttingMode === "custom" ? (
            <>
              <label>Custom cutting minutes<br /><input name="cuttingCustomMinutes" type="number" step="0.1" defaultValue={form.cuttingCustomMinutes || ""} placeholder="Minutes" style={inputStyle} /></label>
              <label>Custom cutting flat cost<br /><input name="cuttingCustomFlatCost" type="number" step="0.01" defaultValue={form.cuttingCustomFlatCost || ""} placeholder="Flat cost" style={inputStyle} /></label>
            </>
          ) : (
            <>
              <input type="hidden" name="cuttingCustomMinutes" value={form.cuttingCustomMinutes} />
              <input type="hidden" name="cuttingCustomFlatCost" value={form.cuttingCustomFlatCost} />
            </>
          )}
        </div>
        {cuttingMode !== "none" ? <div style={smallHelp}>Cutting estimate: {calc.cuttingName} = {num(calc.cuttingMinutes, 1)} min / {money(calc.cuttingCost)}.</div> : null}

        <h3>Optional prepress / design setup</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label>Prepress type<br />
            <select name="prepressMode" value={prepressMode} onChange={(event) => setPrepressMode(event.currentTarget.value)} style={inputStyle}>
              <option value="none">No prepress/design</option>
              <option value="basic">Basic proof / file check</option>
              <option value="repair">File repair</option>
              <option value="dieline">Dieline setup</option>
              <option value="color">Color match / test setup</option>
              <option value="custom">Custom prepress/design</option>
            </select>
          </label>
          {prepressMode === "custom" ? (
            <>
              <label>Custom prepress minutes<br /><input name="prepressCustomMinutes" type="number" step="0.1" defaultValue={form.prepressCustomMinutes || ""} placeholder="Minutes" style={inputStyle} /></label>
              <label>Custom prepress flat cost<br /><input name="prepressCustomFlatCost" type="number" step="0.01" defaultValue={form.prepressCustomFlatCost || ""} placeholder="Flat cost" style={inputStyle} /></label>
            </>
          ) : (
            <>
              <input type="hidden" name="prepressCustomMinutes" value={form.prepressCustomMinutes} />
              <input type="hidden" name="prepressCustomFlatCost" value={form.prepressCustomFlatCost} />
            </>
          )}
        </div>
        {prepressMode !== "none" ? <div style={smallHelp}>Prepress estimate: {calc.prepressName} = {num(calc.prepressMinutes, 1)} min / {money(calc.prepressCost)}.</div> : null}

        <h3>Optional packout / packing supplies</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label>Packout type<br />
            <select name="packoutMode" value={packoutMode} onChange={(event) => setPackoutMode(event.currentTarget.value)} style={inputStyle}>
              <option value="none">No packout</option>
              <option value="standard">Standard packout</option>
              <option value="bulk">Bulk packout</option>
              <option value="individual">Individual packout</option>
              <option value="custom">Custom packout</option>
            </select>
          </label>
          {packoutMode === "custom" ? (
            <>
              <label>Custom packout $/unit<br /><input name="packoutCustomUnitCost" type="number" step="0.0001" defaultValue={form.packoutCustomUnitCost || ""} placeholder="Cost/unit" style={inputStyle} /></label>
              <label>Custom packout flat cost<br /><input name="packoutCustomFlatCost" type="number" step="0.01" defaultValue={form.packoutCustomFlatCost || ""} placeholder="Flat cost" style={inputStyle} /></label>
            </>
          ) : (
            <>
              <input type="hidden" name="packoutCustomUnitCost" value={form.packoutCustomUnitCost} />
              <input type="hidden" name="packoutCustomFlatCost" value={form.packoutCustomFlatCost} />
            </>
          )}
        </div>
        {packoutMode !== "none" ? <div style={smallHelp}>Packout estimate: {calc.packoutName} = {money(calc.packoutFlatCost)} flat + {num(calc.itemQty || form.lines[0]?.quantity || 0, 0)} × {money(calc.packoutUnitCost)} = {money(calc.packoutCost)}.</div> : null}

        <button type="submit" style={{ marginTop: 16, width: "100%", background: "#111827", color: "white", border: 0, borderRadius: 10, padding: 14, fontWeight: 800 }}>Calculate cost</button>
      </section>

      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Estimate</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td>Quote mode</td><td align="right"><b>{form.quoteMode === "actual" ? "Actual GSOQ RIP" : "Estimated before art"}</b></td></tr>
            <tr><td>Label base sqft</td><td align="right">{num(calc.lineBaseSqft, 2)}</td></tr>
            <tr><td>Waste-adjusted label sqft</td><td align="right">{num(calc.lineWasteAdjustedSqft, 2)}</td></tr>
            <tr><td>Calculated job ink cc</td><td align="right">{num(calc.lineInkCc, 2)}</td></tr>
            <tr><td>Label material cost</td><td align="right">{money(calc.lineMaterialCost)}</td></tr>
            <tr><td>Ink cost</td><td align="right">{money(calc.lineInkCost)}</td></tr>
            <tr><td>{calc.itemName}</td><td align="right">{calc.itemQty ? `${num(calc.itemCostQty, 0)} x ${money(calc.itemUnitCost)} = ${money(calc.itemCost)}` : money(0)}</td></tr>
            <tr><td>Application labor{calc.applicationWired ? " (owner standard)" : ""}</td><td align="right">{form.applicationMode === "none" ? "No application / $0.00" : calc.applicationWired ? `${num(calc.applicationQty, 0)} apps × ${money(calc.applicationRatePerApp || 0)}/app · ${money(calc.applicationLaborCost)}` : `${num(calc.applicationQty, 0)} apps · ${num(calc.applicationLaborMinutes, 1)} min incl. setup · ${money(calc.applicationLaborCost)}`}</td></tr>
            <tr><td>Gloss/white setup (labor only)</td><td align="right">{calc.glossWhiteApplies ? `${money(calc.glossWhiteSetupCost)} — owner standard, ink usage unchanged` : money(0)}</td></tr>
            <tr><td>Print/setup labor</td><td align="right">{money(calc.processLaborCost)}</td></tr>
            <tr><td>Machine/setup cost</td><td align="right">{money(calc.processMachineCost)}</td></tr>
            <tr><td>Cutting / finishing</td><td align="right">{calc.cuttingCost ? `${calc.cuttingName}: ${num(calc.cuttingMinutes, 1)} min / ${money(calc.cuttingCost)}` : money(0)}</td></tr>
            <tr><td>Prepress / design</td><td align="right">{calc.prepressCost ? `${calc.prepressName}: ${num(calc.prepressMinutes, 1)} min / ${money(calc.prepressCost)}` : money(0)}</td></tr>
            <tr><td>Packout / supplies</td><td align="right">{calc.packoutCost ? `${calc.packoutName}: ${money(calc.packoutCost)}` : money(0)}</td></tr>
            <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Total cost</b></td><td align="right"><b>{money(calc.totalCost)}</b></td></tr>
            <tr><td><b>Unit cost</b></td><td align="right"><b>{money(calc.unitCost)}</b></td></tr>
            <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Suggested total</b></td><td align="right"><b>{money(calc.suggestedTotal)}</b></td></tr>
            <tr><td><b>Suggested unit</b></td><td align="right"><b>{money(calc.suggestedUnit)}</b></td></tr>
            <tr><td>Gross profit</td><td align="right">{money(calc.grossProfit)}</td></tr>
          </tbody>
        </table>

        <div style={{ marginTop: 10, border: "1px solid #86efac", background: "#f0fdf4", color: "#166534", borderRadius: 10, padding: "8px 12px", fontSize: 12 }}>
          <b>Owner labor standards are now live for comparable labor lines</b> (jar $0.20/app, 4x5 bag $0.1111/side, 14x16 bag $1.00/side, design
          setup $9.33/design, gloss/white setup $8.33 labor-only). Cutting, weeding, and packout remain under review unless exact basis is
          available — they still use the previous calculator rules. Details in <a href="/app/erp/cost-verification">Cost Verification</a>.
        </div>

        <h3>Line breakdown</h3>
        <div style={{ display: "grid", gap: 10 }}>
          {form.lines.map((line) => {
            const appDetail = calc.applicationLineDetails.find((detail) => detail.lineIndex === line.index);
            const appCost = appDetail?.laborCost || 0;
            const appMinutes = appDetail?.minutes || 0;
            const appSeconds = appDetail?.seconds || 0;
            const lineSubtotal = line.materialCost + line.inkCost + appCost;
            return (
              <div key={`summary-${line.index}`} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, fontSize: 13, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                  <b>{line.name || `Line ${line.index + 1}`}</b>
                  <b>{line.isComplete ? money(lineSubtotal) : "Not calculated"}</b>
                </div>
                {!line.isComplete ? <div style={{ color: "#b45309", marginBottom: 6 }}>Needs: {line.warnings.length ? line.warnings.join(", ") : "Complete this line to calculate it."}</div> : null}
                <div>{num(line.quantity, 0)} pcs · {line.labelTypeName} · {num(line.widthIn, 2)} x {num(line.heightIn, 2)} in</div>
                <div style={{ color: "#4b5563", marginTop: 4 }}>Base sqft {num(line.baseSqft, 2)} · Waste-adjusted sqft {num(line.wasteAdjustedSqft, 2)} · Waste {num(line.wastePct, 1)}%</div>
                <div style={{ marginTop: 6 }}>Material: {line.materialName} @ {money(line.materialCostPerSqft)}/sqft = <b>{money(line.materialCost)}</b></div>
                <div>Ink: {line.inkSource} = <b>{money(line.inkCost)}</b>{line.inkCc ? ` (${num(line.inkCc, 2)} cc)` : ""}</div>
                {form.applicationMode !== "none" ? (
                  appDetail?.wired
                    ? <div>Application labor (owner standard): {num(line.quantity, 0)} × {money(appDetail.ratePerApp || 0)}/app = <b>{money(appCost)}</b></div>
                    : <div>Application labor: {num(line.quantity, 0)} × {num(appSeconds, 2)} sec = {num(appMinutes, 1)} min / <b>{money(appCost)}</b></div>
                ) : null}
                <div style={{ color: "#6b7280", marginTop: 6 }}>Line subtotal includes material + ink{form.applicationMode !== "none" ? " + direct application labor" : ""}. Shared setup, blank item, and machine costs are listed below.</div>
              </div>
            );
          })}
        </div>

        <h3>Shared job costs</h3>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, fontSize: 13, background: "#f9fafb" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Blank item / product</span><b>{money(calc.itemCost)}</b></div>
          <div style={{ color: "#6b7280", marginBottom: 6 }}>{calc.itemQty ? `${calc.itemName}: base qty ${num(calc.itemQty, 0)}${calc.itemWastePct ? ` + ${num(calc.itemWastePct, 1)}% waste = ${num(calc.itemCostQty, 0)} costed units` : ""} × ${money(calc.itemUnitCost)}${calc.itemTierLabel !== "fixed" ? ` tier ${calc.itemTierLabel}` : ""}` : "No blank item selected."}</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>{calc.applicationWired ? "Application setup (included in owner-standard rate)" : "Application setup included in application labor"}</span><b>{form.applicationMode === "none" ? money(0) : calc.applicationWired ? "included" : `${num(calc.applicationSetupMinutes, 1)} min`}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Gloss/white setup (labor only)</span><b>{calc.glossWhiteApplies ? money(calc.glossWhiteSetupCost) : money(0)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Print/setup labor</span><b>{money(calc.processLaborCost)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Machine/setup cost</span><b>{money(calc.processMachineCost)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Cutting / finishing</span><b>{calc.cuttingCost ? `${calc.cuttingName}: ${money(calc.cuttingCost)}` : money(0)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Prepress / design</span><b>{calc.prepressCost ? `${calc.prepressName}: ${money(calc.prepressCost)}` : money(0)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Packout / supplies</span><b>{calc.packoutCost ? `${calc.packoutName}: ${money(calc.packoutCost)}` : money(0)}</b></div>
        </div>
      </section>
    </Form>
  );
}

// ---- 14C.1 product-driven form (family-conditional; posts IDs + business inputs only) ----
function ProductDrivenForm() {
  const { emergency } = useLoaderData<typeof loader>() as any;
  const submit = useSubmit();
  const navigation = useNavigation();
  const loadingFamily = navigation.state === "loading";
  const pm = emergency.productMode;
  const family = pm?.family || "";
  const canonicalFamily = pm?.canonicalFamily || "";
  const isBags = canonicalFamily === "sticker-bags";
  const isStandardJars = canonicalFamily === "standard-jars";
  const isPremium = canonicalFamily === "premium-jars";
  const isStickers = canonicalFamily === "stickers-labels";
  const isBanners = canonicalFamily === "banners";
  const isCustom = canonicalFamily === "custom-item";
  const jars = isStandardJars || isPremium;
  const isDtp = canonicalFamily === "dtp-bags"; // 15C: vendor-finished pouches
  const topRequired = Boolean(pm?.topRequired);
  // ---- 14C.2 jar label builder (client state seeds from the server echo and
  // survives calculation/validation/save; the SERVER rebuilds rows via
  // buildLabelRows on every request, discarding stale extras).
  const lf = pm?.labelForm || null;
  const clientDefaultType = (index: number) => (index === 0 ? "side" : index === 1 ? "lid" : "additional");
  const [labelCountSel, setLabelCountSel] = useState<string>(() => (lf ? (lf.count <= 3 ? String(lf.count) : "custom") : "1"));
  const [labelCountCustom, setLabelCountCustom] = useState<number>(() => (lf && lf.count > 3 ? lf.count : 4));
  const [sameSize, setSameSize] = useState<string>(() => (lf && lf.same === false ? "no" : "yes"));
  const [labelRows, setLabelRows] = useState<Array<{ type: string; widthIn: string; heightIn: string }>>(() =>
    lf && !lf.same && Array.isArray(lf.rows)
      ? lf.rows.map((row: any) => ({ type: row.type, widthIn: row.widthIn > 0 ? String(row.widthIn) : "", heightIn: row.heightIn > 0 ? String(row.heightIn) : "" }))
      : Array.from({ length: lf ? lf.count : 1 }, (_v, index) => ({ type: clientDefaultType(index), widthIn: "", heightIn: "" })),
  );
  const effectiveLabels = Math.min(Math.max(1, Math.floor(labelCountSel === "custom" ? labelCountCustom || 1 : Number(labelCountSel))), 6);
  const resizeRows = (count: number) =>
    setLabelRows((previous) => Array.from({ length: count }, (_v, index) => previous[index] || { type: clientDefaultType(index), widthIn: "", heightIn: "" }));
  const updateRow = (index: number, patch: Partial<{ type: string; widthIn: string; heightIn: string }>) =>
    setLabelRows((previous) => {
      const next = [...previous];
      while (next.length <= index) next.push({ type: clientDefaultType(next.length), widthIn: "", heightIn: "" });
      next[index] = { ...next[index], ...patch };
      return next;
    });
  // UI copy of LABEL_TYPES (the .server module cannot be imported client-side)
  const LABEL_TYPE_CHOICES = [
    { value: "side", label: "Side label" },
    { value: "lid", label: "Lid label" },
    { value: "bottom", label: "Bottom label" },
    { value: "neck", label: "Neck label" },
    { value: "tamper", label: "Tamper label" },
    { value: "additional", label: "Additional label" },
    { value: "custom", label: "Custom" },
  ];
  const chironOptions = (pm?.blankOptions || []).filter((option: any) => option.group === "CHIRON");
  const mironOptions = (pm?.blankOptions || []).filter((option: any) => option.group === "MIRON");
  return (
    <Form method="get" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 8 }}>
      <label style={{ fontSize: 12, gridColumn: "1 / -1" }}><b>STEP 1 — What are you pricing?</b>
        <select
          name="pfamily"
          key={canonicalFamily}
          defaultValue={canonicalFamily}
          style={inputStyle}
          onChange={(event) => submit(event.currentTarget.form, { method: "get" })}
        >
          <option value="">— choose a product —</option>
          {/* 15B: options render from the shared registry — one family list.
              Reserved families (dtp-bags) are excluded until enabled. */}
          {calculatorFamilies().map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
        </select>
      </label>
      {!family ? (
        <p style={{ ...smallHelp, gridColumn: "1 / -1" }}>
          Choose a product family to begin.{" "}
          <button type="submit" style={{ ...secondaryButtonStyle, padding: "4px 10px" }}>CONTINUE</button>
        </p>
      ) : null}
      {loadingFamily ? <p style={{ ...smallHelp, gridColumn: "1 / -1", fontWeight: 700 }}>Loading products…</p> : null}
      {family && (isBags || jars || isCustom) && !(pm.blankOptions || []).length ? (
        <p style={{ ...smallHelp, gridColumn: "1 / -1", color: "#92400e", fontWeight: 700 }}>No active products are configured for this family — pick No Blank Item or Custom Item, or add records in the Vendor Cost Book.</p>
      ) : null}
      {isBags && pm?.autoBag ? (<>
        <input type="hidden" name="pblank" value={pm.autoBag.value} />
        <p style={{ fontSize: 12, gridColumn: "1 / -1", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 8 }}><b>Blank bag:</b> {pm.autoBag.label}</p>
      </>) : null}
      {isBags && !pm?.autoBag && pm?.bagCount === 0 ? (
        <p style={{ fontSize: 12, gridColumn: "1 / -1", color: "#991b1b", fontWeight: 700 }}>No active sticker-bag products are configured.</p>
      ) : null}
      {((isBags && !pm?.autoBag) || jars || isCustom || isDtp) && family ? (
        <label style={{ fontSize: 12 }}>* {isDtp ? "DTP size / product" : "Select product / blank item"}
          <select name="pblank" onChange={(event) => submit(event.currentTarget.form, { method: "get" })} style={inputStyle}>
            <option value="">— select —</option>
            {isPremium ? (<>
              {chironOptions.length ? <optgroup label="CHIRON">{chironOptions.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup> : null}
              {mironOptions.length ? <optgroup label="MIRON">{mironOptions.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup> : null}
            </>) : (pm.blankOptions || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
            <option value="none">No Blank Item (Advanced)</option>
            <option value="custom">Custom Item (Advanced — enter below)</option>
          </select>
        </label>
      ) : null}
      {isStandardJars && family && !(pm?.blankOptions || []).length ? (
        <p style={{ fontSize: 12, gridColumn: "1 / -1", color: "#991b1b", fontWeight: 700 }}>No active standard jar products are configured.</p>
      ) : null}
      {isPremium && family && !(pm?.blankOptions || []).length ? (
        <p style={{ fontSize: 12, gridColumn: "1 / -1", color: "#991b1b", fontWeight: 700 }}>No active Chiron or Miron jar sizes are configured.</p>
      ) : null}
      {topRequired ? (
        <label style={{ fontSize: 12 }}>* Top type (required for Miron)
          <select name="plid" style={inputStyle}>
            <option value="">— select top —</option>
            {(pm.lidOptions || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <div style={smallHelp}>Physical Miron jar top. A printed "Lid label" is artwork and belongs in the label rows below — the two are never combined.</div>
        </label>
      ) : null}
      {topRequired && !(pm?.lidOptions || []).length ? (
        <p style={{ fontSize: 12, gridColumn: "1 / -1", color: "#991b1b", fontWeight: 700 }}>No verified compatible tops are configured for this Miron jar.</p>
      ) : null}
      {family ? (<>
        <label style={{ fontSize: 12 }}>* Quantity{isDtp ? ` (MOQ ${(pm?.dtpSpec?.moq || 1000).toLocaleString()})` : ""}<input name="pqty" type="number" min={isDtp ? pm?.dtpSpec?.moq || 1000 : 1} style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>* Number of designs<input name="pdesigns" type="number" min={0} defaultValue={1} style={inputStyle} /></label>
        {isBags ? (
          <label style={{ fontSize: 12 }}>Print / application
            <select name="pfaces" style={inputStyle}><option value="1">Front only</option><option value="2">Front and back</option></select>
          </label>
        ) : null}
        {jars ? (<>
          <label style={{ fontSize: 12 }}>How many labels per jar?
            <select
              value={labelCountSel}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setLabelCountSel(value);
                resizeRows(Math.min(Math.max(1, Math.floor(value === "custom" ? labelCountCustom || 1 : Number(value))), 6));
              }}
              style={inputStyle}
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="custom">Custom (up to 6)</option>
            </select>
          </label>
          {labelCountSel === "custom" ? (
            <label style={{ fontSize: 12 }}>Labels per jar (1–6)
              <input
                type="number" min={1} max={6} value={labelCountCustom}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value) || 1;
                  setLabelCountCustom(value);
                  resizeRows(Math.min(Math.max(1, Math.floor(value)), 6));
                }}
                style={inputStyle}
              />
            </label>
          ) : null}
          <input type="hidden" name="plabelcount" value={effectiveLabels} />
          <label style={{ fontSize: 12 }}>Are all label sizes the same?
            <select name="psame" value={sameSize} onChange={(event) => setSameSize(event.currentTarget.value)} style={inputStyle}>
              <option value="yes">Yes — one size for every label</option>
              <option value="no">No — set each label separately</option>
            </select>
          </label>
        </>) : null}
        {isBanners ? (
          <label style={{ fontSize: 12 }}>Print
            <select name="pfaces" style={inputStyle}><option value="1">Single-sided</option><option value="2">Double-sided</option></select>
          </label>
        ) : null}
        {isCustom ? <label style={{ fontSize: 12 }}>Printed faces/labels<input name="pfaces" type="number" min={1} defaultValue={1} style={inputStyle} /></label> : null}
        {isDtp ? (<>
          <label style={{ fontSize: 12 }}>Hang hole (optional, $0)
            <select name="phanghole" style={inputStyle}><option value="no">No</option><option value="yes">Yes — $0</option></select>
          </label>
          <label style={{ fontSize: 12 }}>Customer name<input name="pcustomer" style={inputStyle} /></label>
          <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>Notes<input name="pnotes" style={inputStyle} placeholder="Quote notes (saved with the draft)" /></label>
          <div style={{ gridColumn: "1 / -1", border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 8, padding: 8, fontSize: 12 }}>
            <b>Included product specification (Spektra — inside the unit cost, never charged again):</b>{" "}
            {(pm?.dtpSpec?.included || []).length ? (pm.dtpSpec.included as string[]).join(" · ") : "Select a DTP size to load its feature records."}
            {(pm?.dtpSpec?.optional || []).length ? <span> · Optional: {(pm.dtpSpec.optional as any[]).map((option: any) => `${option.name} ($${Number(option.amount).toFixed(2)})`).join(", ")}</span> : null}
            <div style={{ color: "#166534" }}>Vendor-finished pouches — no in-house print inputs (dimensions/material/printer/layers do not apply). Freight: ${(pm?.dtpSpec?.freightDefault ?? 85).toFixed ? (pm?.dtpSpec?.freightDefault ?? 85).toFixed(2) : pm?.dtpSpec?.freightDefault} flat per Spektra PO.</div>
          </div>
          {/* 15C.2: owner pricing controls — ladder is the default; custom price
              is owner-authorized and recomputed server-side with floor rules */}
          <label style={{ fontSize: 12 }}>Custom unit price $ (owner — blank = owner ladder)
            <input name="pdtpcustomprice" type="number" step="0.0001" min={0} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12 }}><input type="checkbox" name="pdtprepeat" value="1" /> Exact repeat order — waive customer design fee (no art changes)</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" name="pdtpfreightpass" value="1" /> Pass freight through to customer (backs the $85 out of the ladder subtotal — never recovered twice)</label>
          <p style={{ ...smallHelp, gridColumn: "1 / -1", margin: 0 }}>One production-ready design included; extra designs bill $25 (1,000–2,499) / $20 (2,500–4,999) / $15 (5,000+) each. Below-floor or below-$500-profit prices need the owner phrase + reason in Advanced Pricing Controls.</p>
        </>) : null}
        {!isDtp && (!jars || sameSize === "yes") ? (<>
          <label style={{ fontSize: 12 }}>* {isBanners ? "Banner width (in)" : jars ? "Label width (in) — every label" : "Print width (in)"}<input name="pwidth" type="number" step="0.01" style={inputStyle} /></label>
          <label style={{ fontSize: 12 }}>* {isBanners ? "Banner height (in)" : jars ? "Label height (in) — every label" : "Print height (in)"}<input name="pheight" type="number" step="0.01" style={inputStyle} /></label>
        </>) : null}
        {jars && sameSize === "no" ? (
          <div style={{ gridColumn: "1 / -1", display: "grid", gap: 6 }}>
            {Array.from({ length: effectiveLabels }, (_v, index) => {
              const row = labelRows[index] || { type: clientDefaultType(index), widthIn: "", heightIn: "" };
              return (
                <div key={index} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 8, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, background: "#f9fafb" }}>
                  <label style={{ fontSize: 12 }}>Label {index + 1} type
                    <select name="plabeltype" value={row.type} onChange={(event) => updateRow(index, { type: event.currentTarget.value })} style={inputStyle}>
                      {LABEL_TYPE_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 12 }}>* Width (in)<input name="plabelw" type="number" step="0.01" min={0.01} value={row.widthIn} onChange={(event) => updateRow(index, { widthIn: event.currentTarget.value })} style={inputStyle} /></label>
                  <label style={{ fontSize: 12 }}>* Height (in)<input name="plabelh" type="number" step="0.01" min={0.01} value={row.heightIn} onChange={(event) => updateRow(index, { heightIn: event.currentTarget.value })} style={inputStyle} /></label>
                </div>
              );
            })}
            <p style={{ ...smallHelp, margin: 0 }}>Every label row needs its own positive width and height. The server rebuilds these rows on Calculate and Save — stale hidden rows never affect cost.</p>
          </div>
        ) : null}
        {!isDtp ? (<label style={{ fontSize: 12 }}>* Material
          <select name="pmat" style={inputStyle}>
            <option value="">— select material —</option>
            {(pm.materialOptions || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>) : null}
        {!isDtp ? (<>
        <label style={{ fontSize: 12 }}>Printer
          <select name="pprinter" style={inputStyle}><option value="mimaki">Mimaki</option><option value="roland">Roland</option></select>
        </label>
        <label style={{ fontSize: 12 }}>White layers (0–14)<input name="pwhitelayers" type="number" min={0} max={14} defaultValue={0} style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Gloss layers (0–14)<input name="pglosslayers" type="number" min={0} max={14} defaultValue={0} style={inputStyle} /></label>
        </>) : null}
        {isStickers ? (
          <label style={{ fontSize: 12 }}>Cut type
            {/* 15F.0-E: square/rectangle has the owner-documented model ($6.53
                per 54x54 page); contour/die types BLOCK until the owner
                provides their cutting standard. Legacy kiss/weeded map to
                square-rect. defaultValue echoes the calculated state. */}
            <select name="pcut" defaultValue={pm.cutSelected || "square-rect"} style={inputStyle}>
              <option value="square-rect">Square / rectangle cut</option>
              <option value="weeded">Square / rectangle + weeded transfer</option>
              <option value="kiss-simple">Kiss cut — simple contour (circles, ovals, rounded)</option>
              <option value="kiss-moderate">Kiss cut — moderate contour (multi-curve outline)</option>
              <option value="kiss-complex">Kiss cut — complex contour (detailed outline)</option>
              <option value="die-irregular">Die cut / irregular (needs owner standard)</option>
              <option value="none">No cutting required</option>
            </select>
          </label>
        ) : null}
        {isStickers && pm.designSplitText ? (
          <div style={{ gridColumn: "1 / -1", border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 8, padding: 8, fontSize: 12, fontWeight: 600 }}>
            {pm.designSplitText} — quantity is the TOTAL physical labels; designs share it (art + print setup charged per design; production charged on the total).
          </div>
        ) : null}
        {isStickers ? <MultiLineStickerRows /> : null}
        {isBanners ? (<>
          <label style={{ fontSize: 12 }}><input type="checkbox" name="phem" value="1" /> Hemming</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" name="pgrommet" value="1" /> Grommets</label>
        </>) : null}
        <details style={{ gridColumn: "1 / -1" }}>
          <summary style={{ fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Advanced Options (custom item, waste/box overrides)</summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 6 }}>
            <label style={{ fontSize: 12 }}>Custom item name<input name="pcustomname" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Custom item unit cost $<input name="pcustomcost" type="number" step="0.0001" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Custom cost source/reason (required)<input name="pcustomnote" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Waste override %<input name="pwasteoverride" type="number" step="0.1" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Waste override reason<input name="pwastereason" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Units-per-box override<input name="pboxoverride" type="number" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Box override reason<input name="pboxreason" style={inputStyle} /></label>
            <label style={{ fontSize: 12 }}>Machine minutes/sqft<input name="pmachmin" type="number" step="0.01" style={inputStyle} /></label>
          </div>
        </details>
        <button type="submit" style={{ padding: "10px 14px", borderRadius: 10, border: 0, background: "#b45309", color: "white", fontWeight: 700 }}>CALCULATE COST</button>
        <a href="/app/erp/cost-calculator" style={{ ...secondaryButtonStyle, textAlign: "center", textDecoration: "none", color: "inherit" }}>RESET</a>
      </>) : null}
    </Form>
  );
}

// 15F.0-K: multi-line sticker/label jobs — different sizes/finishes get their
// own lines (never averaged into one). Rendered inside the product form so
// the psl* fields ride the same GET state (and the save's psearch replay).
// A same-size/same-finish multi-design job stays ONE line (use "Number of
// designs" above).
function MultiLineStickerRows() {
  const { emergency } = useLoaderData<typeof loader>() as any;
  const pm = emergency.productMode;
  const params = new URLSearchParams(useLocation().search);
  const initialCount = Math.max(0, Math.floor(Number(params.get("pslcount") || 0)));
  const [count, setCount] = useState<number>(initialCount);
  const readAll = (key: string) => params.getAll(key);
  if (!pm) return null;
  return (
    <details open={count >= 2} style={{ gridColumn: "1 / -1", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
      <summary style={{ fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Multiple sticker/label lines (different sizes or finishes)</summary>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "6px 0" }}>
        Each line calculates independently (own size, material, printer, layers, cut) and prices on its own quantity band — premium gloss/white lines use the premium curve. Packing is charged once at job level. Same size + same finish with several designs? Keep ONE line and set "Number of designs".
      </p>
      <label style={{ fontSize: 12 }}>Number of lines (2–8; 0 = single-line job)
        <input name="pslcount" type="number" min={0} max={8} value={count} onChange={(event) => setCount(Math.max(0, Math.min(8, Math.floor(Number(event.currentTarget.value) || 0))))} style={inputStyle} />
      </label>
      {Array.from({ length: Math.min(Math.max(count, 0), 8) }, (_v, index) => (
        <div key={index} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, marginTop: 6, background: "#f9fafb" }}>
          <label style={{ fontSize: 11 }}>Line name<input name="pslname" defaultValue={readAll("pslname")[index] || ""} placeholder={`Line ${index + 1}`} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>* Quantity<input name="pslqty" type="number" min={1} defaultValue={readAll("pslqty")[index] || ""} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>* Designs<input name="psldesigns" type="number" min={1} defaultValue={readAll("psldesigns")[index] || "1"} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>* Width (in)<input name="pslw" type="number" step="0.01" min={0.01} defaultValue={readAll("pslw")[index] || ""} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>* Height (in)<input name="pslh" type="number" step="0.01" min={0.01} defaultValue={readAll("pslh")[index] || ""} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>* Material
            <select name="pslmat" defaultValue={readAll("pslmat")[index] || ""} style={inputStyle}>
              <option value="">— select —</option>
              {(pm.materialOptions || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 11 }}>Printer
            <select name="pslprinter" defaultValue={readAll("pslprinter")[index] || "mimaki"} style={inputStyle}><option value="mimaki">Mimaki</option><option value="roland">Roland</option></select>
          </label>
          <label style={{ fontSize: 11 }}>White layers<input name="pslwhite" type="number" min={0} max={14} defaultValue={readAll("pslwhite")[index] || "0"} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>Gloss layers<input name="pslgloss" type="number" min={0} max={14} defaultValue={readAll("pslgloss")[index] || "0"} style={inputStyle} /></label>
          <label style={{ fontSize: 11 }}>Cut type
            <select name="pslcut" defaultValue={readAll("pslcut")[index] || "square-rect"} style={inputStyle}>
              <option value="square-rect">Square / rectangle</option>
              <option value="kiss-simple">Kiss — simple contour</option>
              <option value="kiss-moderate">Kiss — moderate contour</option>
              <option value="kiss-complex">Kiss — complex contour</option>
              <option value="die-irregular">Die / irregular (needs standard)</option>
              <option value="none">No cutting</option>
            </select>
          </label>
        </div>
      ))}
    </details>
  );
}

function ProductBreakdown() {
  const { emergency } = useLoaderData<typeof loader>() as any;
  const result = emergency.productMode?.result;
  if (!result) return null;
  const derived = result.derived;
  return (
    <div style={{ marginTop: 10 }}>
      <b style={{ fontSize: 13 }}>Cost breakdown (engine {emergency.productMode?.isDtp ? "15C-spektra-dtp" : "14C.2"} — all values derived by the server)</b>
      {emergency.productMode?.isDtp ? (
        <p style={smallHelp}>Vendor-finished Spektra pouches — no in-house sqft/material/machine derivation. Vendor tier cost + GSO design charge + flat per-PO freight only.</p>
      ) : (
      <p style={smallHelp}>
        {derived.totalPieces} printed piece(s) · {derived.baseSqft.toFixed(2)} sqft base · waste {derived.wastePct}% ({derived.wasteSource}) · {derived.wasteAdjustedSqft.toFixed(2)} sqft adjusted
        {derived.boxes != null ? ` · ${derived.boxes} box(es) @ ${derived.unitsPerBox}/box` : ""} · {derived.printPasses} print pass(es)
      </p>
      )}
      {derived.labelRows && derived.labelRows.length ? (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, fontSize: 12, marginBottom: 6 }}>
          {derived.labelRows.map((row: any) => (
            <div key={row.index} style={{ padding: "2px 0" }}>
              <b>{row.typeLabel}</b> — {row.pieces.toLocaleString()} pieces — {row.widthIn} x {row.heightIn} in — {row.baseSqft.toFixed(2)} sqft
              <span style={{ color: "#6b7280" }}> · material ${row.materialCostShare.toFixed(2)} · ink ${row.inkCostShare.toFixed(2)}{row.whiteLayers ? ` · white x${row.whiteLayers}` : ""}{row.glossLayers ? ` · gloss x${row.glossLayers}` : ""} · {row.applications.toLocaleString()} application(s)</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 4, paddingTop: 4, fontWeight: 700 }}>
            Total printed labels: {derived.totalPieces.toLocaleString()} · Total base label sqft: {derived.baseSqft.toFixed(2)} · Waste: {derived.wastePct}% · Waste-adjusted sqft: {derived.wasteAdjustedSqft.toFixed(2)} · Application count: {derived.applicationCount.toLocaleString()}
          </div>
        </div>
      ) : null}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <tbody>
          {result.lines.filter((line: any) => line.amount !== 0 || line.source === "missing").map((line: any) => (
            <tr key={line.key} style={{ borderTop: "1px solid #e5e7eb", background: line.source === "missing" ? "#fef2f2" : undefined }}>
              <td style={{ padding: 5 }}>{line.label}</td>
              <td align="right">${line.amount.toFixed(2)}</td>
              <td style={{ paddingLeft: 8 }}><span style={{ fontWeight: 700, color: line.source === "verified" ? "#166534" : line.source === "owner_standard" ? "#1e40af" : line.source === "missing" ? "#991b1b" : line.source === "manual_override" ? "#7c2d12" : "#92400e" }}>{String(line.source).replace(/_/g, " ")}</span>{line.note ? <span style={{ color: "#6b7280" }}> — {line.note}</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.missing.length ? (
        <div style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 8, padding: 8, fontSize: 13, fontWeight: 700, marginTop: 6 }}>
          COST NOT VERIFIED — DRAFT ONLY: {result.missing.join("; ")}
        </div>
      ) : <div style={{ color: "#166534", fontSize: 13, fontWeight: 700, marginTop: 6 }}>Finalizable: Yes</div>}
      <p style={smallHelp}>Total cost ${result.totalCost.toFixed(2)} · Unit cost ${result.unitCost.toFixed(4)} — the automatic pricing tiers below are generated from these values.</p>
    </div>
  );
}

// ---- 14C.2: automatic family pricing tiers + customer price selection ----
// Rendered only after CALCULATE COST produced a job with a real quantity. The
// rows come fully computed from the loader (per-quantity engine reruns); the
// save form posts the SAME GET state via psearch plus the selected tier
// QUANTITY — the action recomputes everything and ignores posted totals.
function ProductTiers() {
  const { emergency } = useLoaderData<typeof loader>() as any;
  const actionData = useActionData<typeof action>() as { ok: boolean; message: string } | undefined;
  const search = useLocation().search.replace(/^\?/, "");
  const [selectedQty, setSelectedQty] = useState<number | null>(null);
  const pm = emergency.productMode;
  const tiers: any[] | null = pm?.tiers || null;
  const multiLine = pm?.multiLine || null; // 15F.0-K
  if ((!tiers || !tiers.length) && !multiLine) return null;
  const money2 = (value: number) => `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // 15F.0-K: multi-line sticker jobs replace the quantity ladder with ONE
  // combined job quote (per-line detail + job totals + save).
  if (multiLine?.combined) {
    const combined = multiLine.combined;
    const blocked = combined.blockers.length > 0;
    return (
      <div style={{ marginTop: 12, borderTop: "2px solid #b45309", paddingTop: 10 }}>
        <b style={{ fontSize: 13 }}>Multi-line sticker job — {combined.lines.length} line(s), {combined.totalQuantity.toLocaleString()} total labels</b>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 6 }}>
            <thead><tr style={{ background: "#f3f4f6" }}><th align="left" style={{ padding: 5 }}>Line</th><th>Quantity</th><th>Line cost</th><th>Margin band</th><th>Line price</th><th>Unit price</th><th align="left">Pricing rule</th></tr></thead>
            <tbody>
              {combined.lines.map((line: any) => (
                <tr key={line.name} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 5 }}><b>{line.name}</b>{line.premiumApplied ? <span style={{ color: "#7c2d12" }}> (premium finish)</span> : null}</td>
                  <td align="center">{line.quantity.toLocaleString()}</td>
                  <td align="center">{money2(line.pricedCost)}</td>
                  <td align="center">{line.marginPctApplied}%</td>
                  <td align="center"><b>{money2(line.finalPrice)}</b></td>
                  <td align="center">{money2(line.unitPrice)}</td>
                  <td style={{ fontSize: 11, color: "#6b7280" }}>{line.controllingRule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(multiLine.perLine || []).filter((line: any) => line.splitText && line.designs > 1).map((line: any) => (
          <p key={line.name} style={{ ...smallHelp, margin: "4px 0 0" }}>{line.name}: {line.splitText}</p>
        ))}
        <p style={{ ...smallHelp, margin: "4px 0 0" }}>{multiLine.packingNote}</p>
        {blocked ? (
          <div style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 700, marginTop: 8 }}>
            BLOCKED — fix before quoting:
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontWeight: 400 }}>{combined.blockers.map((blocker: string) => <li key={blocker}>{blocker}</li>)}</ul>
          </div>
        ) : (
          <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 8 }}>
            <div style={{ fontWeight: 800, color: "#166534", fontSize: 15 }}>READY TO QUOTE</div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}>Recommended customer price: {money2(combined.finalTotalPrice)} total</div>
            <div style={{ fontSize: 13 }}>{combined.totalQuantity.toLocaleString()} labels · blended {money2(combined.finalTotalPrice / Math.max(1, combined.totalQuantity))}/unit · gross margin {combined.achievedMarginPct.toFixed(1)}% · gross profit {money2(combined.achievedProfit)}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Price based on: {combined.controllingRule} (researched quantity bands; area floors; premium curve on gloss/white lines)</div>
            <div style={{ fontSize: 12 }}>Includes: material, ink, machine recovery, cutting, setup, packing</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>Does not include: Customer delivery/shipping (quoted separately)</div>
          </div>
        )}
        {actionData?.message ? (
          <div style={{ border: actionData.ok ? "1px solid #bbf7d0" : "1px solid #fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2", borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 600, marginTop: 8 }}>{actionData.message}</div>
        ) : null}
        <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 8 }}>
          <input type="hidden" name="intent" value="saveEmergencyQuoteDraft" />
          <input type="hidden" name="psearch" value={search} />
          <input type="hidden" name="pseltier" value={0} />
          <label style={{ fontSize: 12 }}>Product name<input name="eproduct" defaultValue="Multi-line sticker job" style={inputStyle} /></label>
          <label style={{ fontSize: 12 }}>Customer (optional)<input name="ecustomer" style={inputStyle} /></label>
          <button type="submit" style={{ padding: "10px 14px", borderRadius: 10, border: 0, background: "#111827", color: "white", fontWeight: 700 }}>SAVE DRAFT QUOTE</button>
        </Form>
        <p style={smallHelp}>Saving recomputes every line server-side from the posted state — totals are never trusted from the client.</p>
      </div>
    );
  }
  if (!tiers || !tiers.length) return null;
  const requested = tiers.find((tier) => tier.requested) || tiers[tiers.length - 1];
  const selected = tiers.find((tier) => tier.quantity === selectedQty) || requested;
  const mf = pm.marginFamily;
  // 15D.2: never prefill with panel placeholders; real record name, else the
  // registry family label, else blank for the owner to type.
  const familyEntryForLabel = calculatorFamilies().find((entry) => entry.key === pm.canonicalFamily);
  const productLabel = pm.productLabel || familyEntryForLabel?.label || "";
  return (
    <div style={{ marginTop: 12, borderTop: "2px solid #b45309", paddingTop: 10 }}>
      <b style={{ fontSize: 13 }}>Automatic pricing tiers — generated from the calculated job (no re-entry)</b>
      <p style={{ ...smallHelp, marginTop: 4 }}>
        {mf.configured
          ? <>Margin family: <b>{mf.label}</b> · researched curve {mf.curve.join(" / ")}% · family minimum {mf.minPct}% · global floor {emergency.floor}% · source: {mf.source}</>
          : <><b style={{ color: "#92400e" }}>FAMILY MARGIN RULE NOT CONFIGURED</b> — provisional universal curve with the {emergency.floor}% global floor. Margins are editable in Advanced Pricing Controls.</>}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          {pm.isDtp ? (
            <thead><tr style={{ background: "#f3f4f6" }}><th style={{ padding: 5 }}>Use</th><th align="left">Quantity</th><th>Vendor tier</th><th>Owner tier</th><th>Job cost</th><th>Unit cost</th><th>Owner unit price</th><th>Customer total</th><th>Gross profit</th><th>Gross margin</th><th align="left">Status</th></tr></thead>
          ) : (
            <thead><tr style={{ background: "#f3f4f6" }}><th style={{ padding: 5 }}>Use</th><th align="left">Quantity</th><th>Job Cost</th><th>Unit Cost</th><th>Margin</th><th>Unit Price</th><th>Total Price</th><th>Profit</th><th align="left">Status</th></tr></thead>
          )}
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.quantity} style={{ borderTop: "1px solid #e5e7eb", background: tier.requested ? "#fef9c3" : tier.draftOnly || tier.belowFloor || String(tier.status).startsWith("BLOCKED") ? "#fef2f2" : undefined }}>
                <td align="center"><input type="radio" name="ptierpick" checked={selected.quantity === tier.quantity} onChange={() => setSelectedQty(tier.quantity)} aria-label={`Use ${tier.quantity} price`} /></td>
                <td style={{ padding: 5 }}><b>{tier.quantity.toLocaleString()}</b>{tier.requested ? <span style={{ color: "#92400e", fontWeight: 700 }}> ← requested</span> : null}</td>
                {tier.dtp ? (<>
                  <td align="center">{(() => { const match = String(tier.dtp.vendorTierLabel || "").match(/tier ([\d,+\-]+)/); return match ? match[1] : "—"; })()}</td>
                  <td align="center">{tier.dtp.ownerPriceTierUsed ? tier.dtp.ownerPriceTierUsed.toLocaleString() : "—"}</td>
                  <td align="center">{money2(tier.jobCost)}</td>
                  <td align="center">{money2(tier.unitCost)}</td>
                  <td align="center"><b>{money2(tier.unitPrice)}</b>{tier.dtp.customUnitPrice != null ? <span style={{ color: "#7c2d12" }}> (custom)</span> : null}</td>
                  <td align="center">{money2(tier.totalPrice)}</td>
                  <td align="center">{money2(tier.profit)}</td>
                  <td align="center">{tier.actualMarginPct.toFixed(1)}%</td>
                  <td style={{ color: tier.status === "READY" ? "#166534" : String(tier.status).startsWith("BLOCKED") ? "#991b1b" : "#92400e", fontWeight: 700 }}>
                    {tier.status}
                    {tier.dtp.statusReasons.length ? <div style={{ fontWeight: 400, color: "#6b7280" }}>{tier.dtp.statusReasons.join("; ")}</div> : null}
                  </td>
                </>) : (<>
                  <td align="center">{money2(tier.jobCost)}</td>
                  <td align="center">{money2(tier.unitCost)}</td>
                  <td align="center">{tier.marginPct}%</td>
                  <td align="center"><b>{money2(tier.unitPrice)}</b></td>
                  <td align="center">{money2(tier.totalPrice)}</td>
                  <td align="center">{money2(tier.profit)} ({tier.actualMarginPct.toFixed(1)}%)</td>
                  <td style={{ color: tier.draftOnly || tier.belowFloor ? "#991b1b" : "#166534", fontWeight: 700 }}>
                    {tier.status}
                    {tier.commercial && !tier.draftOnly ? <div style={{ fontWeight: 400, color: "#6b7280", fontSize: 11 }}>{tier.commercial.controllingRule}</div> : null}
                  </td>
                </>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pm.isDtp ? (
        <p style={smallHelp}>Owner ladder prices (DTP pricing study, owner-approved 2026-07-24). "Owner price tier used" follows the highest reached ladder step — never interpolated. 40% is the warning target; DTP hard floors are 30% (1,000–2,499) / 35% (2,500–4,999) / 38% (5,000+); job profit target $500, strategic floor $350. Freight is embedded in prices by default ($85 stays an internal cost line).</p>
      ) : null}
      <button type="button" onClick={() => setSelectedQty(selected.quantity)} style={{ ...secondaryButtonStyle, marginTop: 8, fontWeight: 700 }}>
        Use this price — {selected.quantity.toLocaleString()} @ {money2(selected.unitPrice)}/unit
      </button>
      <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 8 }}>
        <b>Customer price summary</b> (internal costs and profit are not shown here):
        {selected.dtp ? (
        <pre style={{ margin: "6px 0 0", fontSize: 12, background: "white", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap" }}>
{`Product: ${productLabel}
Quantity: ${selected.quantity.toLocaleString()} (owner price tier used: ${selected.dtp.ownerPriceTierUsed ? selected.dtp.ownerPriceTierUsed.toLocaleString() : "—"})
Configuration: ${pm.printConfig || "—"}
Unit price: ${money2(selected.unitPrice)}${selected.dtp.customUnitPrice != null ? " (owner custom)" : " (owner ladder)"}
Base pouch subtotal: ${money2(selected.dtp.baseSubtotal)}
Additional design fees: ${selected.dtp.designFeeWaived ? "$0.00 (repeat order — waived)" : `${money2(selected.dtp.extraDesignFees)}${selected.dtp.extraDesignCount ? ` (${selected.dtp.extraDesignCount} extra @ ${money2(selected.dtp.extraDesignFeeEach)})` : " (first design included)"}`}
Freight: ${selected.dtp.freightTreatment === "pass_through" ? `${money2(selected.dtp.customerFreight)} (passed through)` : "included in unit pricing"}
Total: ${money2(selected.totalPrice)}`}
        </pre>
        ) : (
        <>
        {/* 15F.0-M: employee-facing price result — READY TO QUOTE / BLOCKED */}
        {selected.draftOnly ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 800, color: "#991b1b", fontSize: 15 }}>BLOCKED — not customer-ready</div>
            <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 12, color: "#991b1b" }}>
              {(selected.blockers || []).map((blocker: string) => <li key={blocker}>{blocker}</li>)}
            </ul>
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 800, color: "#166534", fontSize: 15 }}>READY TO QUOTE</div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>Recommended customer price: {money2(selected.totalPrice)} total · {money2(selected.unitPrice)} per unit</div>
            {selected.commercial ? <div style={{ fontSize: 12, marginTop: 2 }}>Price based on: {selected.commercial.controllingRule}</div> : null}
          </div>
        )}
        <pre style={{ margin: "6px 0 0", fontSize: 12, background: "white", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap" }}>
{`Product: ${productLabel}
Quantity: ${selected.quantity.toLocaleString()}${pm.designSplitText ? `\n${pm.designSplitText}` : ""}
Configuration: ${pm.printConfig || "—"}
Unit price: ${money2(selected.unitPrice)}
Product subtotal: ${money2(selected.totalPrice)}
Setup/design: included in unit pricing
Includes: material, ink, machine recovery, cutting, application (where applicable), packing
Does not include: Customer delivery/shipping — quoted separately${selected.freightTotal > 0 ? `\nFreight/handling entered: ${money2(selected.freightTotal)} (${String(selected.freightSource).toUpperCase()}) — included in unit pricing` : ""}
Total: ${money2(selected.totalPrice)}`}
        </pre>
        </>
        )}
        {selected.draftOnly && selected.dtp ? <div style={{ color: "#991b1b", fontWeight: 700, marginTop: 6 }}>DRAFT ONLY — missing costs must be verified before this price is final.</div> : null}
      </div>
      {actionData?.message ? (
        <div style={{ border: actionData.ok ? "1px solid #bbf7d0" : "1px solid #fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2", borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 600, marginTop: 8 }}>{actionData.message}</div>
      ) : null}
      <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 8 }}>
        <input type="hidden" name="intent" value="saveEmergencyQuoteDraft" />
        <input type="hidden" name="psearch" value={search} />
        <input type="hidden" name="pseltier" value={selected.quantity} />
        <label style={{ fontSize: 12 }}>Product name<input name="eproduct" defaultValue={productLabel} placeholder="e.g. Production Test Sticker" style={inputStyle} /></label>
        <label style={{ fontSize: 12 }}>Customer (optional)<input name="ecustomer" style={inputStyle} /></label>
        <button type="submit" style={{ padding: "10px 14px", borderRadius: 10, border: 0, background: "#111827", color: "white", fontWeight: 700 }}>SAVE DRAFT QUOTE</button>
      </Form>
      <p style={smallHelp}>Saving re-fetches every selected record and recomputes cost, label totals, tiers, and the customer total on the server — posted totals are never trusted. Historical quotes are never modified.</p>
    </div>
  );
}
