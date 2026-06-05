import crypto from "crypto";
import type React from "react";
import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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
  unit: string;
  baseUnit: string;
  costPerUnit: number;
  calculatedUnitCost: number;
  purchaseCost: number;
};

type BlankItemTier = { minQty: number; unitCost: number; label: string };

type BlankItemOption = {
  id: string;
  source: "preset" | "material" | "vendor";
  name: string;
  productType: string;
  unitCost: number;
  tiers?: BlankItemTier[];
  defaultApplicationMode: string;
  applicationKey: string;
  wastePct: number;
  vendor: string;
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

function materialSqftCost(material?: MaterialOption | null, fallback = 0) {
  if (!material) return fallback;
  const materialName = `${material.name || ""}`.toLowerCase();
  if (materialName.includes("holographic") || materialName.includes("holo")) return 0.72;
  if (materialName.includes("avery") || materialName.includes("3.5")) return 0.33;
  if (materialName.includes("matte") && materialName.includes("6")) return 0.31;
  if (materialName.includes("gloss") && materialName.includes("6")) return 0.31;
  const unitCost = material.calculatedUnitCost || material.costPerUnit || material.purchaseCost || fallback;
  const unit = `${material.baseUnit || material.unit || ""}`.toLowerCase();
  if (unit.includes("sqin")) return unitCost * 144;
  return unitCost;
}
function presetRollMaterials(): MaterialOption[] {
  return [
    { id: "preset:matte-6mil", name: "Matte 6 mil", materialType: "roll-media", unit: "sqft", baseUnit: "sqft", costPerUnit: 0.31, calculatedUnitCost: 0.31, purchaseCost: 205 },
    { id: "preset:gloss-6mil", name: "Gloss 6 mil", materialType: "roll-media", unit: "sqft", baseUnit: "sqft", costPerUnit: 0.31, calculatedUnitCost: 0.31, purchaseCost: 205 },
    { id: "preset:holographic", name: "Holographic", materialType: "roll-media", unit: "sqft", baseUnit: "sqft", costPerUnit: 0.72, calculatedUnitCost: 0.72, purchaseCost: 488 },
    { id: "preset:avery-35", name: "Avery 3.5 mil", materialType: "roll-media", unit: "sqft", baseUnit: "sqft", costPerUnit: 0.33, calculatedUnitCost: 0.33, purchaseCost: 205 },
  ];
}

function isAllowedRollMaterial(material: MaterialOption) {
  const name = `${material.name || ""}`.toLowerCase();
  const type = `${material.materialType || ""}`.toLowerCase();
  const unit = `${material.unit || ""} ${material.baseUnit || ""}`.toLowerCase();
  if (["ink", "blank", "bag", "jar", "packing", "supplies", "supply", "box", "lid", "pouch"].some((bad) => name.includes(bad))) return false;
  if (unit.includes("each")) return false;
  return type.includes("roll") || type.includes("media") || type.includes("vinyl") || unit.includes("sqft") || unit.includes("sqin");
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

function presetBlankItems(): BlankItemOption[] {
  const mironTiers = {
    jar50: [
      { minQty: 0, unitCost: 2.46, label: "<250" },
      { minQty: 250, unitCost: 2.24, label: "250+" },
      { minQty: 500, unitCost: 2.03, label: "500+" },
      { minQty: 1000, unitCost: 1.89, label: "1,000+" },
      { minQty: 2500, unitCost: 1.74, label: "2,500+" },
    ],
    jar100Tall: [
      { minQty: 0, unitCost: 2.86, label: "<250" },
      { minQty: 250, unitCost: 2.63, label: "250+" },
      { minQty: 500, unitCost: 2.41, label: "500+" },
      { minQty: 1000, unitCost: 2.22, label: "1,000+" },
      { minQty: 2500, unitCost: 2.07, label: "2,500+" },
    ],
    jar100Wide: [
      { minQty: 0, unitCost: 2.90, label: "<250" },
      { minQty: 250, unitCost: 2.67, label: "250+" },
      { minQty: 500, unitCost: 2.44, label: "500+" },
      { minQty: 1000, unitCost: 2.26, label: "1,000+" },
      { minQty: 2500, unitCost: 2.10, label: "2,500+" },
    ],
    jar150: [
      { minQty: 0, unitCost: 3.26, label: "<250" },
      { minQty: 250, unitCost: 3.00, label: "250+" },
      { minQty: 500, unitCost: 2.76, label: "500+" },
      { minQty: 1000, unitCost: 2.54, label: "1,000+" },
      { minQty: 2500, unitCost: 2.37, label: "2,500+" },
    ],
    jar250: [
      { minQty: 0, unitCost: 3.92, label: "<250" },
      { minQty: 250, unitCost: 3.60, label: "250+" },
      { minQty: 500, unitCost: 3.32, label: "500+" },
      { minQty: 1000, unitCost: 3.11, label: "1,000+" },
      { minQty: 2500, unitCost: 2.92, label: "2,500+" },
    ],
  };
  const fixed = (id: string, name: string, unitCost: number, productType: string, app: string, key: string, wastePct: number, vendor: string): BlankItemOption =>
    ({ id, source: "preset", name, productType, unitCost, defaultApplicationMode: app, applicationKey: key, wastePct, vendor });
  const tiered = (id: string, name: string, tiers: BlankItemTier[], key: string): BlankItemOption =>
    ({ id, source: "preset", name, productType: "jar", unitCost: tiers[0]?.unitCost || 0, tiers, defaultApplicationMode: "apply-jar", applicationKey: key, wastePct: 2, vendor: "MIRON" });
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

function blankItemUnitCost(item: BlankItemOption | null, qty: number) {
  if (!item) return 0;
  if (!item.tiers?.length) return item.unitCost || 0;
  const sorted = [...item.tiers].sort((a, b) => b.minQty - a.minQty);
  return sorted.find((tier) => qty >= tier.minQty)?.unitCost || item.unitCost || 0;
}

function blankItemTierLabel(item: BlankItemOption | null, qty: number) {
  if (!item?.tiers?.length) return "fixed";
  const sorted = [...item.tiers].sort((a, b) => b.minQty - a.minQty);
  const tier = sorted.find((t) => qty >= t.minQty);
  return tier?.label || "<250";
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

function prepressRule(mode: string, customMinutes: number, customFlatCost: number, laborRatePerHour: number) {
  const rules: Record<string, { name: string; minutes: number; flatCost: number }> = {
    none: { name: "No prepress/design", minutes: 0, flatCost: 0 },
    basic: { name: "Basic proof / file check", minutes: 15, flatCost: 0 },
    repair: { name: "File repair", minutes: 25, flatCost: 0 },
    dieline: { name: "Dieline setup", minutes: 35, flatCost: 0 },
    color: { name: "Color match / test setup", minutes: 30, flatCost: 0 },
  };
  if (mode === "custom") {
    const minutes = Math.max(customMinutes || 0, 0);
    return { name: "Custom prepress/design", minutes, cost: Math.max(customFlatCost || 0, 0) + (minutes / 60) * laborRatePerHour };
  }
  const rule = rules[mode] || rules.none;
  return { name: rule.name, minutes: rule.minutes, cost: rule.flatCost + (rule.minutes / 60) * laborRatePerHour };
}

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

async function ensureSetting(shop: string) {
  return db.printLogAutoImportSetting.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      uploadToken: crypto.randomUUID(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\error",
      expectedTicketPattern: "GSO-{jobNumber}_{customer}_{product}_{side}_{material}_{route}_R{revision}",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const setting = await ensureSetting(shop);
  const url = new URL(request.url);
  const appOrigin = new URL(request.url).origin;

  const [entries, materialRecords, vendorProducts] = await Promise.all([
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
      orderBy: [{ productType: "asc" }, { name: "asc" }],
      take: 200,
    }),
  ]);

  const rows = uniqueLatestByQuote(entries.map(rowFromEntry));
  const rowById = new Map(rows.map((row) => [row.quoteId, row]));
  const savedMaterials: MaterialOption[] = materialRecords.map((m) => ({
    id: m.id,
    name: m.name,
    materialType: m.materialType,
    unit: m.unit,
    baseUnit: m.baseUnit,
    costPerUnit: m.costPerUnit,
    calculatedUnitCost: m.calculatedUnitCost,
    purchaseCost: m.purchaseCost,
  }));
  const materials: MaterialOption[] = presetRollMaterials();
  const materialById = new Map(materials.map((m) => [m.id, m]));

  const blankItems: BlankItemOption[] = [
    ...presetBlankItems(),
    ...savedMaterials
      .filter((m) => [m.unit, m.baseUnit].join(" ").toLowerCase().includes("each") || ["blank", "packaging", "general"].includes(m.materialType))
      .slice(0, 100)
      .map((m) => ({
        id: `material:${m.id}`,
        source: "material" as const,
        name: m.name,
        productType: m.materialType,
        unitCost: m.calculatedUnitCost || m.costPerUnit || m.purchaseCost || 0,
        defaultApplicationMode: "none",
        applicationKey: "custom",
        wastePct: 0,
        vendor: "Saved material",
      })),
    ...vendorProducts.slice(0, 100).map((p) => ({
      id: `vendor:${p.id}`,
      source: "vendor" as const,
      name: p.name,
      productType: p.productType,
      unitCost: p.defaultUnitCost || 0,
      defaultApplicationMode: "none",
      applicationKey: "custom",
      wastePct: 0,
      vendor: "Vendor product",
    })),
  ];
  const blankItemById = new Map(blankItems.map((item) => [item.id, item]));

  const quoteMode = cleanText(url.searchParams.get("quoteMode") || "estimated");
  const targetMarginPct = fieldNumber(url, "targetMarginPct", 40);
  const laborRatePerHour = fieldNumber(url, "laborRatePerHour", 25);
  const machineCostPerHour = fieldNumber(url, "machineCostPerHour", 8);
  const setupMinutes = fieldNumber(url, "setupMinutes", 10);
  const finishingMinutes = fieldNumber(url, "finishingMinutes", 0);
  const quoteAction = cleanText(url.searchParams.get("quoteAction") || "calculate");
  const submittedLineCount = Math.min(Math.max(fieldNumber(url, "lineCount", 1), 1), 8);
  const lineCount = quoteAction === "add-label"
    ? Math.min(submittedLineCount + 1, 8)
    : quoteAction === "remove-label"
      ? Math.max(submittedLineCount - 1, 1)
      : submittedLineCount;

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
      if (quoteMode === "actual" && !quoteId) warnings.push("GSOQ RIP result required");
      if (quoteMode === "estimated" && inkEstimateProfile === "custom" && customInkCostPerSqft <= 0) warnings.push("Custom ink cost required");
    }
    const isComplete = !isBlank && warnings.length === 0;
    const materialCostPerSqft = isComplete ? (materialId === "custom" ? customMaterialCostPerSqft : materialSqftCost(material, customMaterialCostPerSqft)) : 0;
    const sqftPerUnit = isComplete && widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
    const baseSqft = sqftPerUnit * quantity;
    const wasteMultiplier = 1 + wastePct / 100;
    const wasteAdjustedSqft = baseSqft * wasteMultiplier;
    const effectiveUnits = quantity * wasteMultiplier;
    const materialCost = wasteAdjustedSqft * materialCostPerSqft;
    const ripRow = rowById.get(quoteId) || null;
    const useActualRip = isComplete && quoteMode === "actual" && ripRow;
    const ripIsPerPiece = ripResultMode !== "full-job";
    const estimatedInkCost = isComplete ? inkEstimateCostPerSqft(inkEstimateProfile, customInkCostPerSqft) * wasteAdjustedSqft : 0;
    const inkCost = useActualRip ? (ripIsPerPiece ? ripRow.estimatedInkCost * effectiveUnits : ripRow.estimatedInkCost) : estimatedInkCost;
    const inkCc = useActualRip ? (ripIsPerPiece ? ripRow.totalCc * effectiveUnits : ripRow.totalCc) : 0;
    const totalCost = materialCost + inkCost;
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
      baseSqft,
      wasteAdjustedSqft,
      effectiveUnits,
      materialName: material?.name || "Custom material",
      materialCostPerSqft,
      materialCost,
      inkSource: useActualRip ? `Actual RIP ${ripRow.quoteId}` : `Estimated ${inkEstimateProfile}`,
      inkCost,
      inkCc,
      unitCost: quantity > 0 ? totalCost / quantity : 0,
      totalCost,
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
  const itemCostQty = itemMode === "none" ? 0 : Math.ceil(itemQty * (1 + itemWastePct / 100));
  const itemUnitCost = itemMode === "none" ? 0 : itemId === "custom" ? customItemUnitCost : blankItemUnitCost(selectedItem, itemQty);
  const itemTierLabel = itemMode === "inventory" ? blankItemTierLabel(selectedItem, itemQty) : "fixed";
  const itemName = itemMode === "none" ? "No blank item" : itemId === "custom" ? customItemName : selectedItem?.name || "Selected item";
  const itemCost = itemCostQty * itemUnitCost;

  const rawApplicationMode = url.searchParams.get("applicationMode");
  const applicationMode = cleanText(rawApplicationMode || (itemMode === "inventory" ? selectedItem?.defaultApplicationMode || "none" : "none"));
  const applicationRule = estimateApplicationRule(applicationMode, averageLabelSqIn, lines.length);
  const customApplicationSecondsPerUnit = fieldNumber(url, "applicationSecondsPerUnit", 8);
  const customApplicationUnitCost = fieldNumber(url, "applicationUnitCost", 0);
  const applicationSetupMinutes = applicationMode === "none" ? 0 : applicationMode === "apply-flat-bag" ? 5 : applicationMode === "apply-box" ? 8 : 10;
  const applicationLineDetails = applicationMode === "none" ? [] : completeLines.map((line) => {
    const seconds = applicationMode === "custom" ? customApplicationSecondsPerUnit : secondsForKnownApplication(selectedItem, line, applicationMode) || applicationRule.secondsPerUnit;
    const apps = line.quantity;
    const minutes = (apps * seconds) / 60;
    return { lineIndex: line.index, lineName: line.name, labelType: line.labelTypeName, apps, seconds, minutes, laborCost: (minutes / 60) * laborRatePerHour };
  });
  const applicationQty = applicationMode === "none" ? 0 : applicationLineDetails.reduce((sum, line) => sum + line.apps, 0);
  const applicationSecondsPerUnit = applicationMode === "none" ? 0 : applicationLineDetails.length ? applicationLineDetails.reduce((sum, line) => sum + line.seconds, 0) / applicationLineDetails.length : 0;
  const applicationUnitCost = applicationMode === "custom" ? customApplicationUnitCost : applicationRule.extraCostPerUnit;
  const applicationMinutesBeforeSetup = applicationLineDetails.reduce((sum, line) => sum + line.minutes, 0);
  const applicationLaborMinutes = applicationMode === "none" ? 0 : applicationSetupMinutes + applicationMinutesBeforeSetup;
  const applicationLaborCost = (applicationLaborMinutes / 60) * laborRatePerHour + applicationQty * applicationUnitCost;

  const cuttingMode = cleanText(url.searchParams.get("cuttingMode") || "none");
  const cuttingCustomMinutes = fieldNumber(url, "cuttingCustomMinutes", 0);
  const cuttingCustomFlatCost = fieldNumber(url, "cuttingCustomFlatCost", 0);
  const cutting = cuttingRule(cuttingMode, primaryQuantity, cuttingCustomMinutes, cuttingCustomFlatCost, laborRatePerHour);

  const prepressMode = cleanText(url.searchParams.get("prepressMode") || "none");
  const prepressCustomMinutes = fieldNumber(url, "prepressCustomMinutes", 0);
  const prepressCustomFlatCost = fieldNumber(url, "prepressCustomFlatCost", 0);
  const prepress = prepressRule(prepressMode, prepressCustomMinutes, prepressCustomFlatCost, laborRatePerHour);

  const packoutMode = cleanText(url.searchParams.get("packoutMode") || "none");
  const packoutCustomUnitCost = fieldNumber(url, "packoutCustomUnitCost", 0);
  const packoutCustomFlatCost = fieldNumber(url, "packoutCustomFlatCost", 0);
  const packout = packoutRule(packoutMode, primaryQuantity, packoutCustomUnitCost, packoutCustomFlatCost);

  const safetyWarnings: string[] = [];
  if (itemMode !== "none" && applicationMode === "none") safetyWarnings.push("Blank item selected but application is No application. If GSO is applying labels, choose an application type.");
  if (applicationMode !== "none" && itemMode === "none") safetyWarnings.push("Application selected but no blank item/product is selected. Confirm this is intentional.");
  if (cuttingMode === "custom" && cuttingCustomMinutes <= 0 && cuttingCustomFlatCost <= 0) safetyWarnings.push("Custom cutting selected but no custom cutting minutes or flat cost was entered.");
  if (prepressMode === "custom" && prepressCustomMinutes <= 0 && prepressCustomFlatCost <= 0) safetyWarnings.push("Custom prepress selected but no custom prepress minutes or flat cost was entered.");
  if (packoutMode === "custom" && packoutCustomUnitCost <= 0 && packoutCustomFlatCost <= 0) safetyWarnings.push("Custom packout selected but no custom packout unit cost or flat cost was entered.");
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
  const totalCost = lineMaterialCost + lineInkCost + itemCost + applicationLaborCost + processLaborCost + processMachineCost + cuttingCost + prepressCost + packoutCost;
  const unitCost = totalCost / primaryQuantity;
  const suggestedTotal = targetMarginPct >= 100 ? 0 : totalCost / (1 - targetMarginPct / 100);
  const suggestedUnit = suggestedTotal / primaryQuantity;
  const grossProfit = suggestedTotal - totalCost;

  return {
    appOrigin,
    syncEndpoint: `${appOrigin}/api/quote-rip-results/sync`,
    uploadToken: setting.uploadToken,
    rows,
    lastAutoImportAt: setting.lastAutoImportAt ? setting.lastAutoImportAt.toISOString() : null,
    materials,
    blankItems,
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

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, background: "white" };
const codeStyle: React.CSSProperties = { background: "#111827", color: "#f9fafb", padding: 10, borderRadius: 8, display: "block", overflowX: "auto", fontSize: 12 };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };

export default function ErpCostCalculatorRoute() {
  const { syncEndpoint, uploadToken, rows, lastAutoImportAt, materials, blankItems, form, calc } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 1280, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p><a href="/app/erp/rip-imports">← RIP Imports</a> · <a href="/app/erp/product-setup">Product Setup / Recipes</a> · <a href="/app/erp/materials">Materials</a></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#14532d)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>GSO Quote Builder / Cost Calculator</h1>
        <p style={{ marginBottom: 0 }}>v2.0 staff-ready cleanup: clearer warnings, final quote checklist, required-field protection, and cleaner cost sections before tiered pricing.</p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: rows.length ? "#bbf7d0" : "#fde68a", background: rows.length ? "#f0fdf4" : "#fffbeb" }}>
        <h2 style={{ marginTop: 0 }}>Sync control</h2>
        <div style={{ display: "grid", gap: 8 }}>
          <div><b>Synced GSOQ results:</b> {rows.length}</div>
          <div><b>Last sync:</b> {lastAutoImportAt ? new Date(lastAutoImportAt).toLocaleString() : "Not synced yet"}</div>
          <div><b>Upload endpoint:</b> <code>{syncEndpoint}</code></div>
          <div><b>Upload token:</b> <code>{uploadToken}</code></div>
          <code style={codeStyle}>powershell -ExecutionPolicy Bypass -File .\tools\gso-sync-quote-rip-results-to-app.ps1 -AppUrl "{new URL(syncEndpoint).origin}" -Token "{uploadToken}"</code>
        </div>
      </section>

      <Form method="get" style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, marginTop: 16 }}>
        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Quote inputs</h2>
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13, color: "#1e3a8a" }}>
            <b>Staff flow:</b> 1) choose estimate or actual RIP, 2) fill every label line, 3) choose roll media only, 4) choose blank item/product, 5) choose application if GSO is applying labels, 6) add cutting, prepress, or packout only when needed, then calculate and review the Quote Checklist.
          </div>
          {form.safetyWarnings.length ? (
            <div style={{ background: "#fff7ed", border: "1px solid #fb923c", borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 13, color: "#92400e" }}>
              <b>Action needed:</b>
              <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                {form.safetyWarnings.map((warning: string) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Quote mode<br />
              <select name="quoteMode" defaultValue={form.quoteMode} style={inputStyle}>
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
          <input type="hidden" name="lineCount" value={form.lineCount} />
          <div style={{ display: "grid", gap: 12 }}>
            {form.lines.map((line) => (
              <div key={line.index} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f9fafb" }}>
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
                  <label style={{ gridColumn: "1 / 3" }}>Material / roll media only<br />
                    <select name="lineMaterialId" defaultValue={line.materialId} style={inputStyle}>
                      <option value="">Select material</option>
                      {materials.map((material) => <option key={material.id} value={material.id}>{material.name} - {money(materialSqftCost(material, 0))}/sqft</option>)}
                      <option value="custom">Custom one-time material price</option>
                    </select>
                    <div style={smallHelp}>{line.materialId === "" ? "Select a material to calculate material cost." : line.materialId === "custom" ? "Using one-time custom material price below." : `Using saved material cost: ${money(line.materialCostPerSqft)}/sqft.`}</div>
                  </label>
                  {line.materialId === "custom" ? (
                    <label>Custom material $/sqft<br /><input name="lineCustomMaterialCostPerSqft" type="number" step="0.0001" defaultValue={line.customMaterialCostPerSqft || ""} placeholder="Cost/sqft" style={inputStyle} /></label>
                  ) : (
                    <input type="hidden" name="lineCustomMaterialCostPerSqft" value={line.customMaterialCostPerSqft} />
                  )}
                  <label>Waste %<br /><input name="lineWastePct" type="number" step="0.1" defaultValue={line.wastePct} style={inputStyle} /></label>

                  {form.quoteMode === "actual" ? (
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
                      <input type="hidden" name="lineInkEstimateProfile" value={line.inkEstimateProfile} />
                      <input type="hidden" name="lineCustomInkCostPerSqft" value={line.customInkCostPerSqft} />
                    </>
                  ) : (
                    <>
                      <input type="hidden" name="lineQuoteId" value={line.quoteId} />
                      <input type="hidden" name="lineRipResultMode" value={line.ripResultMode} />
                      <label>Estimated ink profile<br />
                        <select name="lineInkEstimateProfile" defaultValue={line.inkEstimateProfile} style={inputStyle}>
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
                      {line.inkEstimateProfile === "custom" ? (
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
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button name="quoteAction" value="add-label" type="submit" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" }}>+ Add label size</button>
            <button name="quoteAction" value="remove-label" type="submit" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" }}>Remove last label</button>
          </div>

          <h3>Blank item / product being labeled</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Item mode<br />
              <select name="itemMode" defaultValue={form.itemMode} style={inputStyle}>
                <option value="none">No blank item</option>
                <option value="inventory">Use inventory/vendor item</option>
                <option value="custom">Custom one-time item</option>
              </select>
              <div style={smallHelp}>{form.itemMode === "none" ? "No blank item selected." : `Item quantity auto-matches the main label quantity: ${num(form.itemQty, 0)}.`}</div>
            </label>
            <input type="hidden" name="itemQty" value={form.itemQty} />
            {form.itemMode === "inventory" ? (
              <label style={{ gridColumn: "1 / -1" }}>Inventory item<br />
                <select name="itemId" defaultValue={form.itemId} style={inputStyle}>
                  <option value="custom">Custom item</option>
                  {blankItems.map((item) => <option key={item.id} value={item.id}>{item.name} - {item.tiers?.length ? "tiered" : `${money(item.unitCost)} each`}</option>)}
                </select>
              </label>
            ) : <input type="hidden" name="itemId" value={form.itemId} />}
            {form.itemMode === "custom" ? (
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
            {form.itemMode !== "none" ? (
              <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "#374151", background: "#f3f4f6", borderRadius: 10, padding: 10 }}>
                Item cost preview: {calc.itemName}. Base qty {num(calc.itemQty, 0)}{calc.itemWastePct ? ` + ${num(calc.itemWastePct, 1)}% waste = ${num(calc.itemCostQty, 0)} costed units` : ""} × {money(calc.itemUnitCost)} {form.itemTierLabel !== "fixed" ? `(tier ${form.itemTierLabel})` : ""} = {money(calc.itemCost)}.
              </div>
            ) : null}
          </div>

          <h3>Application / finishing</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Application type<br />
              <select name="applicationMode" defaultValue={form.applicationMode} style={inputStyle}>
                <option value="none">No application</option>
                <option value="apply-flat-bag">Apply label to flat bag/pouch</option>
                <option value="apply-jar">Apply label to jar</option>
                <option value="apply-box">Apply label to box</option>
                <option value="apply-tube">Apply label to round tube</option>
                <option value="apply-label-set">Apply full label set to item</option>
                <option value="custom">Custom application</option>
              </select>
              <div style={smallHelp}>Application quantity and seconds are calculated automatically from the selected blank item and each line label type.</div>
            </label>
            {form.applicationMode === "custom" ? (
              <>
                <label>Custom seconds per unit<br /><input name="applicationSecondsPerUnit" type="number" step="0.1" defaultValue={form.applicationSecondsPerUnit} style={inputStyle} /></label>
                <label>Extra application $/unit<br /><input name="applicationUnitCost" type="number" step="0.0001" defaultValue={form.applicationUnitCost} style={inputStyle} /></label>
              </>
            ) : (
              <>
                <input type="hidden" name="applicationSecondsPerUnit" value={form.applicationSecondsPerUnit} />
                <input type="hidden" name="applicationUnitCost" value={form.applicationUnitCost} />
              </>
            )}
            <input type="hidden" name="applicationQty" value={form.applicationQty} />
            {form.applicationMode !== "none" ? (
              <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "#374151", background: "#f3f4f6", borderRadius: 10, padding: 10 }}>
                Auto application labor rule: {form.applicationName}. {form.applicationLineDetails.map((detail) => `${detail.lineName} ${detail.labelType}: ${num(detail.apps, 0)} × ${num(detail.seconds, 2)} sec`).join("; ")} + {num(form.applicationSetupMinutes, 1)} min application setup = {num(calc.applicationLaborMinutes, 1)} min / {money(calc.applicationLaborCost)}.
              </div>
            ) : null}
          </div>

          <h3>Cutting / finishing add-ons</h3>
          <div style={smallHelp}>Only use this when the job needs cutting, trimming, contour cutting, die-cutting, weeding, or extra finishing beyond normal printing.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label>Cutting / finishing type<br />
              <select name="cuttingMode" defaultValue={form.cuttingMode} style={inputStyle}>
                <option value="none">No cutting / finishing</option>
                <option value="square">Square/rectangle cut</option>
                <option value="contour">Contour cut</option>
                <option value="diecut">Die-cut sticker</option>
                <option value="sheet">Sheet cut / trim down</option>
                <option value="weed">Weeded decal</option>
                <option value="custom">Custom cutting / finishing</option>
              </select>
            </label>
            {form.cuttingMode === "custom" ? (
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
          {form.cuttingMode !== "none" ? <div style={smallHelp}>Cutting estimate: {calc.cuttingName} = {num(calc.cuttingMinutes, 1)} min / {money(calc.cuttingCost)}.</div> : null}

          <h3>Prepress / design setup add-ons</h3>
          <div style={smallHelp}>Only use this when the file needs proof setup, repair, dieline setup, or color-match/test setup.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label>Prepress type<br />
              <select name="prepressMode" defaultValue={form.prepressMode} style={inputStyle}>
                <option value="none">No prepress/design</option>
                <option value="basic">Basic proof / file check</option>
                <option value="repair">File repair</option>
                <option value="dieline">Dieline setup</option>
                <option value="color">Color match / test setup</option>
                <option value="custom">Custom prepress/design</option>
              </select>
            </label>
            {form.prepressMode === "custom" ? (
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
          {form.prepressMode !== "none" ? <div style={smallHelp}>Prepress estimate: {calc.prepressName} = {num(calc.prepressMinutes, 1)} min / {money(calc.prepressCost)}.</div> : null}

          <h3>Packout / packing supplies add-ons</h3>
          <div style={smallHelp}>Only use this when GSO is packing/bundling the finished order or adding packaging supplies.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label>Packout type<br />
              <select name="packoutMode" defaultValue={form.packoutMode} style={inputStyle}>
                <option value="none">No packout</option>
                <option value="standard">Standard packout</option>
                <option value="bulk">Bulk packout</option>
                <option value="individual">Individual packout</option>
                <option value="custom">Custom packout</option>
              </select>
            </label>
            {form.packoutMode === "custom" ? (
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
          {form.packoutMode !== "none" ? <div style={smallHelp}>Packout estimate: {calc.packoutName} = {money(calc.packoutFlatCost)} flat + {num(calc.itemQty || form.lines[0]?.quantity || 0, 0)} × {money(calc.packoutUnitCost)} = {money(calc.packoutCost)}.</div> : null}

          <button name="quoteAction" value="calculate" type="submit" style={{ marginTop: 16, width: "100%", background: "#111827", color: "white", border: 0, borderRadius: 10, padding: 14, fontWeight: 800 }}>Calculate quote cost</button>
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
              <tr><td>Application labor</td><td align="right">{form.applicationMode === "none" ? "No application / $0.00" : `${num(calc.applicationQty, 0)} apps · ${num(calc.applicationLaborMinutes, 1)} min incl. setup · ${money(calc.applicationLaborCost)}`}</td></tr>
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



          <h3>Quote Checklist</h3>
          <div style={{ border: "1px solid #d1fae5", borderRadius: 12, padding: 12, fontSize: 13, background: "#ecfdf5", display: "grid", gap: 6 }}>
            <div><b>{completeLines.length ? "✓" : "□"}</b> Label lines ready: {completeLines.length} complete / {form.lines.length} total</div>
            <div><b>{calc.lineMaterialCost > 0 ? "✓" : "□"}</b> Roll media/material cost included</div>
            <div><b>{calc.lineInkCost > 0 || form.quoteMode === "actual" ? "✓" : "□"}</b> Ink cost included ({form.quoteMode === "actual" ? "actual GSOQ RIP mode" : "estimated heavy coverage mode"})</div>
            <div><b>{form.itemMode !== "none" ? "✓" : "□"}</b> Blank item/product: {form.itemMode !== "none" ? calc.itemName : "none selected"}</div>
            <div><b>{form.applicationMode !== "none" ? "✓" : "□"}</b> Application labor: {form.applicationMode !== "none" ? `${num(calc.applicationLaborMinutes, 1)} min / ${money(calc.applicationLaborCost)}` : "none selected"}</div>
            <div><b>{calc.cuttingCost || calc.prepressCost || calc.packoutCost ? "✓" : "□"}</b> Extra add-ons: cutting {money(calc.cuttingCost)}, prepress {money(calc.prepressCost)}, packout {money(calc.packoutCost)}</div>
            <div><b>{form.safetyWarnings.length ? "!" : "✓"}</b> Staff warnings: {form.safetyWarnings.length ? `${form.safetyWarnings.length} warning(s) to review` : "none"}</div>
          </div>

          <h3>Line breakdown</h3>
          <div style={{ display: "grid", gap: 10 }}>
            {form.lines.map((line) => {
              const appDetail = calc.applicationLineDetails.find((detail: any) => detail.lineIndex === line.index);
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
                    <div>Application labor: {num(line.quantity, 0)} × {num(appSeconds, 2)} sec = {num(appMinutes, 1)} min / <b>{money(appCost)}</b></div>
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
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Application setup included in application labor</span><b>{form.applicationMode === "none" ? money(0) : `${num(calc.applicationSetupMinutes, 1)} min`}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Print/setup labor</span><b>{money(calc.processLaborCost)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Machine/setup cost</span><b>{money(calc.processMachineCost)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Cutting / finishing</span><b>{calc.cuttingCost ? `${calc.cuttingName}: ${money(calc.cuttingCost)}` : money(0)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Prepress / design</span><b>{calc.prepressCost ? `${calc.prepressName}: ${money(calc.prepressCost)}` : money(0)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Packout / supplies</span><b>{calc.packoutCost ? `${calc.packoutName}: ${money(calc.packoutCost)}` : money(0)}</b></div>
          </div>
        </section>
      </Form>

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
    </main>
  );
}
