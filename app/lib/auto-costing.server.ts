// Automatic full product costing (14B.1). Pure — routes pass verified data
// in; save actions RE-COMPUTE server-side. Reuses the shared verified sources:
// blankItemUnitCostAtQty (vendor tiers), material $/sqft resolvers, INK_RATES,
// OWNER_LABOR, machineRatePerHour(), computeFreight, family margin curves.
// Never guesses: any required-but-absent cost becomes a MISSING line that
// blocks finalization (draft preview stays allowed).

import { INK_RATES, OWNER_LABOR, type CostLine } from "./calculator-emergency.server";

export const AUTO_ENGINE_VERSION = "14B.1";
export type AutoFamily = "bags-4x5" | "chiron-jars" | "miron-jars" | "stickers-labels" | "banners";

export type AutoInputs = {
  quantity: number;
  designs: number;
  sides: 1 | 2; // bags: labels per bag
  labelWidthIn: number;
  labelHeightIn: number;
  materialCostPerSqft: number | null; // verified resolver result (null = missing)
  materialLabel: string;
  printer: "mimaki" | "roland";
  whiteInk: boolean;
  spotGloss: boolean;
  inkMlPerSqft: number; // channel-based usage assumption passed in (seeded/calibrated)
  machineMinutesPerSqft: number; // observed/entered; 0 = unknown
  machineRatePerHour: number;
  blankUnitCost: number | null; // qty-aware resolved blank (bag/jar) or null
  blankLabel: string;
  lidUnitCost: number | null; // Miron only
  lidLabel: string;
  boxes: number;
  wastePct: number; // from recipe rule or entered; -1 = no rule (estimated 10 with label)
  freightPerUnit: number;
  freightSource: "verified" | "estimated" | "missing";
  cutIsProvisional: boolean;
  weedingPages: number; // stickers: 54x54 pages to weed (0 = none)
  hemming: boolean;
  grommets: boolean;
};

const sqftOf = (widthIn: number, heightIn: number, quantity: number) => (widthIn > 0 && heightIn > 0 ? (widthIn * heightIn * quantity) / 144 : 0);

export function computeAutoCost(family: AutoFamily, input: AutoInputs): {
  lines: CostLine[]; perUnitVariable: number; setupTotal: number; totalPerUnit: number;
  missing: string[]; warnings: string[];
} {
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  const quantity = Math.max(1, input.quantity);
  const wastePct = input.wastePct >= 0 ? input.wastePct : 10;
  if (input.wastePct < 0) warnings.push("No waste rule found — ESTIMATED 10% used.");
  const wasteMult = 1 / (1 - Math.min(wastePct, 90) / 100); // single application, materials+ink only
  const labelsPerUnit = family === "bags-4x5" ? input.sides : 1;
  const areaSqft = family === "banners" ? sqftOf(input.labelWidthIn, input.labelHeightIn, quantity) : sqftOf(input.labelWidthIn, input.labelHeightIn, quantity * labelsPerUnit);
  const needsArea = family !== "chiron-jars" && family !== "miron-jars" ? true : input.labelWidthIn > 0;
  if (needsArea && areaSqft <= 0) {
    lines.push({ key: "dimensions", label: "Label/banner dimensions", amount: 0, source: "missing", note: "Width and height required — square footage is never guessed." });
  }

  // blank/component
  if (family === "bags-4x5" || family === "chiron-jars" || family === "miron-jars") {
    if (input.blankUnitCost != null) lines.push({ key: "blank", label: input.blankLabel, amount: input.blankUnitCost * quantity, source: "verified", note: family === "chiron-jars" ? "Cap included — never double-counted." : undefined });
    else lines.push({ key: "blank", label: input.blankLabel || "Blank item", amount: 0, source: "missing" });
    if (family === "miron-jars") {
      if (input.lidUnitCost != null) lines.push({ key: "lid", label: input.lidLabel || "Miron lid (tiered)", amount: input.lidUnitCost * quantity, source: "verified" });
      else lines.push({ key: "lid", label: "Miron lid", amount: 0, source: "missing" });
    }
  }
  // material (waste applied once, here)
  if (areaSqft > 0) {
    if (input.materialCostPerSqft != null) lines.push({ key: "material", label: `${input.materialLabel} @ $${input.materialCostPerSqft.toFixed(4)}/sqft x ${areaSqft.toFixed(2)} sqft (+${wastePct}% waste)`, amount: input.materialCostPerSqft * areaSqft * wasteMult, source: "verified" });
    else lines.push({ key: "material", label: input.materialLabel || "Material", amount: 0, source: "missing" });
    // ink (channel rates; waste applied once)
    const cmykRate = input.printer === "mimaki" ? INK_RATES.mimakiCmykPerMl : INK_RATES.rolandPerMl;
    lines.push({ key: "ink_cmyk", label: `CMYK ink (${input.printer}) ${input.inkMlPerSqft} ml/sqft`, amount: cmykRate * input.inkMlPerSqft * areaSqft * wasteMult, source: input.printer === "roland" ? "estimated" : "verified", note: input.printer === "roland" ? "Roland uniform channel rate — owner-approved provisional." : undefined });
    if (input.whiteInk) {
      const whiteRate = input.printer === "mimaki" ? INK_RATES.mimakiWhitePerMl : INK_RATES.rolandPerMl;
      lines.push({ key: "ink_white", label: "White ink", amount: whiteRate * input.inkMlPerSqft * areaSqft * wasteMult, source: "verified" });
    }
    if (input.spotGloss) {
      const glossRate = input.printer === "mimaki" ? INK_RATES.mimakiGlossPerMl : INK_RATES.rolandPerMl;
      if (glossRate == null) lines.push({ key: "ink_gloss", label: "Spot gloss ink (Mimaki)", amount: 0, source: "missing", note: "Mimaki clear/gloss $/ml unknown — blocks finalization." });
      else lines.push({ key: "ink_gloss", label: "Spot gloss ink", amount: glossRate * input.inkMlPerSqft * areaSqft * wasteMult, source: "estimated" });
    }
    // machine
    if (input.machineMinutesPerSqft > 0) lines.push({ key: "machine", label: `Machine @ $${input.machineRatePerHour}/hr`, amount: (input.machineMinutesPerSqft * areaSqft / 60) * input.machineRatePerHour, source: "owner_standard" });
    else lines.push({ key: "machine", label: "Machine time", amount: 0, source: "estimated", note: "No minutes/sqft available — machine time not included." });
  }
  // setup (spread by tier later)
  const setupTotal = input.designs > 0 ? input.designs * (OWNER_LABOR.artSetupPerDesign + OWNER_LABOR.printSetupPerDesign) : 0;
  if (input.designs > 0) {
    lines.push({ key: "art_setup", label: `Art setup ${input.designs} design(s) (cut setup included)`, amount: input.designs * OWNER_LABOR.artSetupPerDesign, source: "owner_standard" });
    lines.push({ key: "print_setup", label: "Print setup", amount: input.designs * OWNER_LABOR.printSetupPerDesign, source: "owner_standard" });
  } else lines.push({ key: "setup", label: "Design count", amount: 0, source: "missing", note: "Number of designs required." });
  // family labor
  if (family === "bags-4x5") lines.push({ key: "application", label: `Bag-label application x${labelsPerUnit}/bag`, amount: OWNER_LABOR.bagLabelApplicationPer * labelsPerUnit * quantity, source: "owner_standard" });
  if (family === "chiron-jars" || family === "miron-jars") lines.push({ key: "application", label: "Jar application", amount: OWNER_LABOR.jarApplicationPer * quantity, source: "owner_standard" });
  if (family === "stickers-labels") {
    if (input.weedingPages > 0) lines.push({ key: "weeding", label: `Weeding ${input.weedingPages} page(s)`, amount: OWNER_LABOR.weedingPerPage54x54 * input.weedingPages, source: "owner_standard" });
    if (input.cutIsProvisional) warnings.push("Cutting labor model is PROVISIONAL — owner standards pending.");
  }
  if (family === "banners" && (input.hemming || input.grommets)) {
    lines.push({ key: "finishing", label: "Banner hemming/grommets", amount: 0, source: "missing", note: "Finishing labor standard not set — blocks finalization." });
  }
  if (input.boxes > 0) lines.push({ key: "packing", label: `Packing ${input.boxes} box(es)`, amount: OWNER_LABOR.packoutPerBox * input.boxes, source: "owner_standard" });
  // freight (visible, computed by the existing panel; never buried)
  lines.push({ key: "freight", label: "Freight/handling (separate line)", amount: input.freightPerUnit * quantity, source: input.freightSource, note: input.freightSource === "estimated" ? "ESTIMATED allowance" : undefined });

  const totalJob = lines.reduce((sum, line) => sum + line.amount, 0);
  const perUnitVariable = (totalJob - setupTotal) / quantity;
  const missing = lines.filter((line) => line.source === "missing").map((line) => line.label);
  return { lines, perUnitVariable, setupTotal, totalPerUnit: totalJob / quantity, missing, warnings };
}
