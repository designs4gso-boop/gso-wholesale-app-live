// Product-driven costing (14C.1). Pure — the route resolves DB records by
// posted ID and passes VALUES in; the server derives every technical number
// (sqft, waste, boxes, weeding pages, layer ink, passes). Client-posted costs,
// sqft, boxes, and waste are never trusted; the save action re-runs this.
//
// PROVISIONAL LAYER MODEL (documented; replace after 13A.8 calibration): no
// verified per-layer usage formula exists, so each white/gloss layer is
// modeled as ONE additional full-coverage pass using the same ml/sqft as the
// base CMYK pass (linear). Passes = 1 + whiteLayers + glossLayers; machine
// minutes scale by passes when a minutes/sqft model is supplied. All layer
// lines are labeled with the layer count and "provisional linear model".

import { INK_RATES, OWNER_LABOR, type CostLine, type SourceLabel } from "./calculator-emergency.server";
import { blankItemUnitCostAtQty } from "./cost-calculator.server";

export const PRODUCT_ENGINE_VERSION = "14C.1";
export const MAX_LAYERS = 14;
export const WEEDING_PAGE_SQFT = (54 * 54) / 144; // 20.25 sqft per 54x54in page

// Owner-verified Safe Care packing (documented constants until an ERP
// units-per-box field exists). Missing entries = Estimated/Missing packout.
export const PACKOUT_RULES: Array<{ match: RegExp; unitsPerBox: number; label: string }> = [
  { match: /4\s?x\s?5.*bag|bag.*4\s?x\s?5/i, unitsPerBox: 1000, label: "4x5 blank bags: 1,000/box (Safe Care)" },
  { match: /3\s?oz/i, unitsPerBox: 150, label: "3 oz jars: 150/box (Safe Care)" },
  { match: /4\s?oz/i, unitsPerBox: 100, label: "4 oz jars: 100/box (Safe Care)" },
];

export function unitsPerBoxFor(productName: string): { unitsPerBox: number | null; label: string | null } {
  const rule = PACKOUT_RULES.find((candidate) => candidate.match.test(productName));
  return rule ? { unitsPerBox: rule.unitsPerBox, label: rule.label } : { unitsPerBox: null, label: null };
}

export function validateLayers(value: number): { ok: boolean; value: number; error: string | null } {
  if (!Number.isFinite(value) || value < 0) return { ok: false, value: 0, error: "Layers cannot be negative." };
  if (value > MAX_LAYERS) return { ok: false, value: MAX_LAYERS, error: `Layers cannot exceed ${MAX_LAYERS}.` };
  return { ok: true, value: Math.floor(value), error: null };
}

export type ProductFamilyKey = "bags-4x5" | "chiron-jars" | "miron-jars" | "stickers-labels" | "banners" | "custom";

export type ResolvedComponent = {
  name: string;
  unitCost: number | null; // resolved default; tiers refine by quantity
  tiers: Array<{ minQty: number; maxQty: number | null; unitCost: number }>;
  status: SourceLabel; // verified when priced from a DB record; estimated for custom-with-note
  includesCap?: boolean;
  note?: string;
};

export type ProductDrivenInput = {
  family: ProductFamilyKey;
  quantity: number;
  designs: number;
  facesPerUnit: number; // normalized from Front only/Front+back, labels per jar, sides, custom faces
  widthIn: number;
  heightIn: number;
  blank: ResolvedComponent | null; // null = No Blank Item
  lid: ResolvedComponent | null; // Miron only
  material: { name: string; costPerSqft: number | null; rollLabel?: string } | null;
  printer: "mimaki" | "roland";
  printerHasWhite: boolean;
  printerHasGloss: boolean;
  whiteLayers: number;
  glossLayers: number;
  inkMlPerSqft: number; // active base usage assumption (seeded 0.0075-derived / entered)
  machineMinutesPerSqft: number; // 0 = unknown
  machineRatePerHour: number;
  cutRequiresWeeding: boolean;
  hemming: boolean;
  grommets: boolean;
  freightPerUnit: number;
  freightSource: SourceLabel;
  recipeWastePct: number | null; // precedence 1; null = fall through
  wasteOverride: { pct: number; reason: string } | null;
  boxOverride: { unitsPerBox: number; reason: string } | null;
};

export type DerivedValues = {
  sqinPerPiece: number;
  totalPieces: number;
  baseSqft: number;
  wastePct: number;
  wasteSource: string;
  wasteAdjustedSqft: number;
  unitsPerBox: number | null;
  boxes: number | null;
  boxSource: string;
  weedingPages: number;
  weedingBasis: string;
  printPasses: number;
};

export function computeProductDrivenCost(input: ProductDrivenInput): {
  lines: CostLine[]; derived: DerivedValues; missing: string[]; warnings: string[];
  totalCost: number; unitCost: number; setupTotal: number; perUnitVariable: number;
} {
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  const quantity = Math.max(1, Math.floor(input.quantity));

  // ---- layers (validated; capability-gated) ----
  const white = validateLayers(input.printerHasWhite ? input.whiteLayers : 0);
  const gloss = validateLayers(input.printerHasGloss || input.printer === "roland" ? input.glossLayers : 0);
  if (white.error) warnings.push(`White layers: ${white.error}`);
  if (gloss.error) warnings.push(`Gloss layers: ${gloss.error}`);
  if (!input.printerHasWhite && input.whiteLayers > 0) warnings.push("Selected printer has no white channel — white layers ignored.");
  if (!input.printerHasGloss && input.printer === "mimaki" && input.glossLayers > 0) {
    // still counted so the MISSING blocker fires (never silently dropped)
  }
  const whiteLayers = white.value;
  const glossLayers = input.printer === "mimaki" && !input.printerHasGloss ? Math.floor(Math.max(0, Math.min(MAX_LAYERS, input.glossLayers))) : gloss.value;

  // ---- geometry (server-derived; dimensions required for printed families) ----
  const faces = Math.max(1, Math.floor(input.facesPerUnit));
  const totalPieces = quantity * faces;
  const sqinPerPiece = input.widthIn > 0 && input.heightIn > 0 ? input.widthIn * input.heightIn : 0;
  const baseSqft = (sqinPerPiece * totalPieces) / 144;
  const printedFamily = input.family !== "custom" || sqinPerPiece > 0;
  if (printedFamily && baseSqft <= 0) {
    lines.push({ key: "dimensions", label: "Print width and height", amount: 0, source: "missing", note: "Dimensions required — square footage is never assumed." });
  }

  // ---- waste precedence: recipe -> override -> provisional 10% ----
  let wastePct: number;
  let wasteSource: string;
  if (input.wasteOverride) {
    wastePct = input.wasteOverride.pct;
    wasteSource = `OVERRIDE (${input.wasteOverride.reason}) — original ${input.recipeWastePct ?? "provisional 10"}%`;
  } else if (input.recipeWastePct != null && input.recipeWastePct >= 0) {
    wastePct = input.recipeWastePct;
    wasteSource = "Product/recipe waste rule";
  } else {
    wastePct = 10;
    wasteSource = "PROVISIONAL default 10% (no recipe rule)";
    warnings.push("Waste: no recipe rule — provisional 10% applied (labeled).");
  }
  const wasteMult = 1 / (1 - Math.min(Math.max(wastePct, 0), 90) / 100);
  const wasteAdjustedSqft = baseSqft * wasteMult;

  // ---- blank/lid components (qty-aware tiers, server-resolved) ----
  const componentLine = (component: ResolvedComponent, key: string, capNote: boolean) => {
    const resolved = blankItemUnitCostAtQty(component.tiers, component.unitCost ?? 0, quantity, component.name);
    const unit = resolved.unitCost > 0 ? resolved.unitCost : component.unitCost;
    if (unit != null && unit > 0) {
      lines.push({
        key, label: `${component.name} @ $${unit.toFixed(4)} x ${quantity}${resolved.tierLabel !== "fixed" ? ` (tier ${resolved.tierLabel})` : ""}`,
        amount: unit * quantity, source: component.status,
        note: capNote ? "Cap included — never double-counted." : component.note,
      });
      if (resolved.warning) warnings.push(resolved.warning);
    } else {
      lines.push({ key, label: component.name || "Component", amount: 0, source: "missing", note: "No verified cost on the selected record." });
    }
  };
  if (input.blank) componentLine(input.blank, "blank", input.family === "chiron-jars" || Boolean(input.blank.includesCap));
  if (input.family === "miron-jars") {
    if (input.lid) componentLine(input.lid, "lid", false);
    else lines.push({ key: "lid", label: "Miron lid", amount: 0, source: "missing", note: "Select a lid type." });
  }

  // ---- material + ink + machine ----
  if (baseSqft > 0) {
    if (input.material && input.material.costPerSqft != null) {
      lines.push({ key: "material", label: `${input.material.name}${input.material.rollLabel ? ` (${input.material.rollLabel})` : ""} — ${baseSqft.toFixed(2)} sqft +${wastePct}% waste`, amount: input.material.costPerSqft * wasteAdjustedSqft, source: "verified" });
    } else {
      lines.push({ key: "material", label: input.material?.name || "Material", amount: 0, source: "missing", note: "Select a verified material." });
    }
    const cmykRate = input.printer === "mimaki" ? INK_RATES.mimakiCmykPerMl : INK_RATES.rolandPerMl;
    lines.push({ key: "ink_cmyk", label: `CMYK ink — base print (${input.inkMlPerSqft} ml/sqft)`, amount: cmykRate * input.inkMlPerSqft * wasteAdjustedSqft, source: input.printer === "roland" ? "estimated" : "verified", note: input.printer === "roland" ? "Roland uniform rate — owner-approved provisional." : undefined });
    if (whiteLayers > 0) {
      const whiteRate = input.printer === "mimaki" ? INK_RATES.mimakiWhitePerMl : INK_RATES.rolandPerMl;
      lines.push({ key: "ink_white", label: `White ink — ${whiteLayers} layer(s), provisional linear model`, amount: whiteRate * input.inkMlPerSqft * wasteAdjustedSqft * whiteLayers, source: input.printer === "mimaki" ? "verified" : "estimated" });
    }
    if (glossLayers > 0) {
      const glossRate = input.printer === "mimaki" ? INK_RATES.mimakiGlossPerMl : INK_RATES.rolandPerMl;
      if (glossRate == null) {
        lines.push({ key: "ink_gloss", label: `Gloss ink — ${glossLayers} layer(s)`, amount: 0, source: "missing", note: "GLOSS INK COST NOT VERIFIED — DRAFT ONLY (never priced as $0-final)." });
      } else {
        lines.push({ key: "ink_gloss", label: `Gloss ink — ${glossLayers} layer(s), provisional linear model`, amount: glossRate * input.inkMlPerSqft * wasteAdjustedSqft * glossLayers, source: "estimated" });
      }
    }
    const passes = 1 + whiteLayers + glossLayers;
    if (passes > 1) lines.push({ key: "passes", label: `Additional print passes — ${passes - 1}`, amount: 0, source: "estimated", note: "Represented once via machine time below (provisional linear model)." });
    if (input.machineMinutesPerSqft > 0) {
      lines.push({ key: "machine", label: `Machine @ $${input.machineRatePerHour}/hr x ${passes} pass(es)`, amount: (input.machineMinutesPerSqft * wasteAdjustedSqft * passes / 60) * input.machineRatePerHour, source: "owner_standard" });
    } else {
      lines.push({ key: "machine", label: "Machine time", amount: 0, source: "estimated", note: "No minutes/sqft model yet — not included." });
    }
  }

  // ---- setup + family labor ----
  const setupTotal = input.designs > 0 ? input.designs * (OWNER_LABOR.artSetupPerDesign + OWNER_LABOR.printSetupPerDesign) : 0;
  if (input.designs > 0) {
    lines.push({ key: "art_setup", label: `Art setup — ${input.designs} design(s), cut setup included`, amount: input.designs * OWNER_LABOR.artSetupPerDesign, source: "owner_standard" });
    lines.push({ key: "print_setup", label: "Print setup", amount: input.designs * OWNER_LABOR.printSetupPerDesign, source: "owner_standard" });
  } else {
    lines.push({ key: "designs", label: "Number of designs", amount: 0, source: "missing", note: "Required." });
  }
  if (input.family === "bags-4x5") lines.push({ key: "application", label: `Bag-label application — ${faces} label(s)/bag`, amount: OWNER_LABOR.bagLabelApplicationPer * totalPieces, source: "owner_standard" });
  if (input.family === "chiron-jars" || input.family === "miron-jars") lines.push({ key: "application", label: `Jar application (${faces} label(s)/jar)`, amount: OWNER_LABOR.jarApplicationPer * quantity, source: "owner_standard" });

  // ---- automatic weeding (stickers only, when the cut requires it) ----
  let weedingPages = 0;
  let weedingBasis = "Not required for this product/cut.";
  if (input.family === "stickers-labels" && input.cutRequiresWeeding && baseSqft > 0) {
    weedingPages = Math.ceil(baseSqft / WEEDING_PAGE_SQFT);
    weedingBasis = `ESTIMATED: ceil(${baseSqft.toFixed(2)} sqft / ${WEEDING_PAGE_SQFT} sqft per 54x54 page)`;
    lines.push({ key: "weeding", label: `Weeding — ${weedingPages} page(s)`, amount: OWNER_LABOR.weedingPerPage54x54 * weedingPages, source: "estimated", note: weedingBasis });
  }
  if (input.family === "banners" && (input.hemming || input.grommets)) {
    lines.push({ key: "finishing", label: "Banner hemming/grommets", amount: 0, source: "missing", note: "Finishing labor standard not set." });
  }

  // ---- automatic boxes/packout ----
  const packRule = input.boxOverride
    ? { unitsPerBox: input.boxOverride.unitsPerBox, label: `OVERRIDE (${input.boxOverride.reason})` }
    : unitsPerBoxFor(input.blank?.name || "");
  let boxes: number | null = null;
  let boxSource = "No units-per-box rule — packout Estimated/Missing (override in Advanced).";
  if (packRule.unitsPerBox && packRule.unitsPerBox > 0) {
    boxes = Math.ceil(quantity / packRule.unitsPerBox);
    boxSource = packRule.label || "rule";
    lines.push({ key: "packing", label: `Packing — ${boxes} box(es) @ ${packRule.unitsPerBox}/box`, amount: OWNER_LABOR.packoutPerBox * boxes, source: input.boxOverride ? "manual_override" : "owner_standard", note: boxSource });
  } else if (input.family !== "custom") {
    lines.push({ key: "packing", label: "Packing/boxes", amount: 0, source: "estimated", note: boxSource });
  }

  // ---- freight (single visible line; computed by the freight panel) ----
  lines.push({ key: "freight", label: "Freight/handling (separate line)", amount: input.freightPerUnit * quantity, source: input.freightSource, note: input.freightSource === "estimated" ? "ESTIMATED allowance" : undefined });

  const totalCost = lines.reduce((sum, line) => sum + line.amount, 0);
  const missing = lines.filter((line) => line.source === "missing").map((line) => line.label);
  return {
    lines,
    derived: {
      sqinPerPiece, totalPieces, baseSqft, wastePct, wasteSource, wasteAdjustedSqft,
      unitsPerBox: packRule.unitsPerBox ?? null, boxes, boxSource, weedingPages, weedingBasis,
      printPasses: 1 + whiteLayers + glossLayers,
    },
    missing,
    warnings,
    totalCost,
    unitCost: totalCost / quantity,
    setupTotal,
    perUnitVariable: (totalCost - setupTotal) / quantity,
  };
}
