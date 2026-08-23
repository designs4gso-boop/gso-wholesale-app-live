// Patch 2D-1 (17D.6) — canonical LABELS / STICKERS adapter.
//
// One adapter, many lines. Each line keeps its own size, material, finish and
// cutline, and each gets its OWN physical print run — different sizes are
// never flattened into one fake layout.
//
// 2D-3D — A PRODUCTION LINE IS NOT AN ARTWORK.
// Three counts are tracked separately because they are three different things:
//
//   physical lines        what actually runs: size, material, finish, cutline.
//   distinct artwork      what an artist had to prepare. Lines sharing an
//                         artworkKey share ONE art setup event.
//   print setup events    what has to be set up on the press. Two lines of the
//                         same artwork on different media are still two press
//                         setups.
//
// So one artwork on a 3x3 matte line and a 3x3 holographic line is 1 art setup
// and 2 print setups. Charging 2 art setups there would bill artwork nobody
// made; collapsing to 1 print setup would give away a real press setup.
//
// PRINT/ARTBOARD geometry and CUTLINE geometry are strictly separate:
//   printWidthIn  x printHeightIn   -> nesting, material, ink, occupancy
//   cutWidthIn    x cutHeightIn     -> the cutter path, and nothing else
//
// Material costs come from the verified APPROVED_ROLL_COSTS table. Nothing is
// invented: an unknown material blocks.
//
// Pure: no db, no network, no clock.

import { APPROVED_ROLL_COSTS } from "./approved-cost-updates.server";
import { computeNesting, resolveNestingPolicy, type NestingResult, type NestingRun } from "./nesting-engine.server";
import { SETUP_BASIS, type CostBasis } from "./true-cost-engine.server";
import { computeFinishing, type CutGeometryMap, type CutMode, type FinishingResult } from "./finishing-cost.server";
import { OWNER_STANDARDS } from "./owner-standards";

export const LABEL_COST_INPUTS_VERSION = "17D.6-label-cost-inputs";

export const LABEL_REASONS = {
  materialCostRequired: "LABEL_MATERIAL_COST_REQUIRED",
  printGeometryRequired: "LABEL_PRINT_GEOMETRY_REQUIRED",
} as const;

/** Verified roll media only. An unlisted material is never guessed. */
export const LABEL_MATERIALS = {
  matte: { key: "matte", label: "Poseidon Matte", costPerSqft: APPROVED_ROLL_COSTS.poseidonMattePerSqft, rollWidthIn: 54 },
  gloss: { key: "gloss", label: "Poseidon Gloss", costPerSqft: APPROVED_ROLL_COSTS.poseidonGlossPerSqft, rollWidthIn: 54 },
  holographic: { key: "holographic", label: "Holographic", costPerSqft: APPROVED_ROLL_COSTS.holographicPerSqft, rollWidthIn: 50 },
} as const;

export type LabelMaterialKey = keyof typeof LABEL_MATERIALS;

export function resolveLabelMaterial(key: string) {
  return (LABEL_MATERIALS as Record<string, (typeof LABEL_MATERIALS)[LabelMaterialKey]>)[key] ?? null;
}

/** One sticker/label line. Lines are physically independent. */
export type LabelLine = {
  key: string;
  quantity: number;
  /** ARTBOARD / print size — drives nesting, material and ink. */
  printWidthIn: number;
  printHeightIn: number;
  /** ACTUAL cutline. Omit for a contour line and supply contour geometry. */
  cutWidthIn?: number;
  cutHeightIn?: number;
  /** Die-cut / irregular: the real outline length per item, when known. */
  contourPerimeterIn?: number;
  cutType?: "rectangular" | "contour" | "none";
  materialKey: string;

  /**
   * ARTWORK IDENTITY. Lines sharing an artworkKey are the SAME artwork and
   * together create ONE art setup event, however many lines there are.
   *
   * Omitted, a line is its own distinct artwork (its `key` is used), which
   * keeps the safe default: nothing is silently treated as shared.
   *
   * This is deliberately a free string, not a persisted id — no artwork
   * catalog, no database, nothing to maintain. It only has to be stable
   * within one job.
   */
  artworkKey?: string;

  /**
   * Shared artwork that nevertheless needs its own real artwork
   * modification/prep on THIS line (a resize that is genuinely re-drawn, a
   * material-specific rework). Adds art setup events on top of the artwork's
   * single base event. Default 0 — a size or material change alone is not
   * artwork work.
   */
  additionalArtSetupEvents?: number;

  /**
   * Legitimate PRINT-design setup events this line creates. Each label line is
   * its own physical run on the press, so the default is 1. Set 0 only when a
   * line genuinely rides an existing setup rather than creating its own.
   */
  printSetupEvents?: number;
};

export type LabelJobInput = {
  lines: LabelLine[];
  machineKey?: string;
  cutMode?: CutMode;
  loadedMediaWidthIn?: number;
};

export type LabelLineResult = {
  key: string;
  quantity: number;
  material: { label: string; costPerSqft: number } | null;
  nesting: NestingResult | null;
  materialCost: number;
  reasons: string[];
  blockers: string[];
};

export type LabelJobResult = {
  version: string;
  lines: LabelLineResult[];
  /** Total labels printed across every line — the application shortfall basis. */
  printedLabels: number;
  materialCost: number;
  finishing: FinishingResult | null;
  /**
   * Art AND print are both PER_DESIGN, but they count DIFFERENT events and
   * neither counts copies. `designs` is retained as the art-event count.
   */
  setup: {
    art: number;
    print: number;
    total: number;
    designs: number;
    /** Distinct artworks + genuinely separate per-line artwork prep. */
    artSetupEvents: number;
    /** Press setups. May exceed artSetupEvents when artwork is shared. */
    printSetupEvents: number;
    /** How many distinct artworks the job actually contains. */
    distinctArtworkCount: number;
    /** Extra artwork prep declared on individual lines. */
    additionalArtSetupEvents: number;
    /** Physical production lines — NEVER the art-setup multiplier. */
    physicalLines: number;
    artBasis: CostBasis;
    printBasis: CostBasis;
    basisNote: string;
  };
  reasons: string[];
  blockers: string[];
};

function lineCutGeometry(line: LabelLine): CutGeometryMap {
  const type = line.cutType ?? "rectangular";
  if (type === "contour") {
    return line.contourPerimeterIn && line.contourPerimeterIn > 0
      // A known outline is expressed as an equivalent rectangle of the same
      // perimeter, so the contour path length is exact.
      ? { [line.key]: { model: "contour", cutWidthIn: line.contourPerimeterIn / 4, cutHeightIn: line.contourPerimeterIn / 4, note: "Owner-supplied contour outline length." } }
      : { [line.key]: { model: "contour" } }; // no geometry -> blocks
  }
  return line.cutWidthIn != null && line.cutHeightIn != null
    ? { [line.key]: { model: "separated_rectangle", cutWidthIn: line.cutWidthIn, cutHeightIn: line.cutHeightIn, note: "Owner-supplied actual cutline." } }
    : { [line.key]: { model: "separated_rectangle" } }; // artboard fallback -> blocks
}

export function computeLabelJob(input: LabelJobInput): LabelJobResult {
  const machineKey = input.machineKey ?? "mimaki-ucjv300-130";
  const cutMode = input.cutMode ?? "normal";
  const reasons: string[] = [];
  const blockers: string[] = [];

  const runs: NestingRun[] = [];
  let cutGeometry: CutGeometryMap = {};
  const lineResults: LabelLineResult[] = [];
  let printedLabels = 0;
  let materialCost = 0;

  // Three separate counters — see the 2D-3D note in the header.
  const artworkKeys = new Set<string>();
  let additionalArtSetupEvents = 0;
  let printSetupEvents = 0;

  for (const line of input.lines) {
    const lineReasons: string[] = [];
    const lineBlockers: string[] = [];
    const material = resolveLabelMaterial(line.materialKey);
    if (!material) {
      lineReasons.push(LABEL_REASONS.materialCostRequired);
      lineBlockers.push(`${LABEL_REASONS.materialCostRequired}: "${line.materialKey}" has no verified $/sqft. A material cost is never invented.`);
    }
    if (!(line.printWidthIn > 0) || !(line.printHeightIn > 0) || !(line.quantity > 0)) {
      lineReasons.push(LABEL_REASONS.printGeometryRequired);
      lineBlockers.push(`${LABEL_REASONS.printGeometryRequired}: line "${line.key}" needs a positive quantity and print size.`);
    }

    let nesting: NestingResult | null = null;
    let lineMaterialCost = 0;
    if (material && line.quantity > 0 && line.printWidthIn > 0 && line.printHeightIn > 0) {
      const policy = resolveNestingPolicy({
        machineKey,
        loadedMediaWidthIn: input.loadedMediaWidthIn ?? material.rollWidthIn,
      });
      if (!policy.ok) {
        lineBlockers.push(`${policy.blocker}: ${policy.message}`);
      } else {
        // Each line is its OWN physical run — sizes are never merged.
        const run: NestingRun = {
          key: `${line.key}-run`,
          items: [{
            key: line.key, groupKey: line.key, shapeType: line.cutType === "contour" ? "contour" : "rect",
            widthIn: line.printWidthIn, heightIn: line.printHeightIn, quantity: line.quantity, allowRotate: true,
          }],
        };
        runs.push(run);
        cutGeometry = { ...cutGeometry, ...lineCutGeometry(line) };
        nesting = computeNesting([run], policy.policy);
        lineMaterialCost = nesting.materialFootprintSqft * material.costPerSqft;
        materialCost += lineMaterialCost;
        printedLabels += line.quantity;
      }
    }
    // Artwork identity, NOT line identity, is what art setup counts.
    artworkKeys.add(line.artworkKey ?? line.key);
    additionalArtSetupEvents += Math.max(0, Math.floor(line.additionalArtSetupEvents ?? 0));
    printSetupEvents += Math.max(0, Math.floor(line.printSetupEvents ?? 1));
    lineResults.push({
      key: line.key, quantity: line.quantity,
      material: material ? { label: material.label, costPerSqft: material.costPerSqft } : null,
      nesting, materialCost: lineMaterialCost, reasons: lineReasons, blockers: lineBlockers,
    });
    reasons.push(...lineReasons);
    blockers.push(...lineBlockers);
  }

  // ONE finishing pass over every run, so cutting and weeding stay canonical.
  const policy = resolveNestingPolicy({ machineKey, loadedMediaWidthIn: input.loadedMediaWidthIn ?? 54 });
  const finishing = runs.length && policy.ok
    ? computeFinishing({
        nesting: computeNesting(runs, policy.policy),
        machineKey, cutMode, cutGeometry, requiresWeeding: true,
      })
    : null;
  if (finishing) {
    reasons.push(...finishing.reasons);
    blockers.push(...finishing.stages.filter((s) => s.blocker).map((s) => s.blocker!));
  }

  // 2D-3C: print setup is PER DESIGN ($25/hr at 25 designs/hr), not once per
  // job. 2D-3D: art counts DISTINCT ARTWORK events, print counts PRESS setup
  // events, and the two are allowed to differ. Copy quantity enters neither.
  const distinctArtworkCount = artworkKeys.size;
  const artSetupEvents = distinctArtworkCount + additionalArtSetupEvents;
  const art = OWNER_STANDARDS.artSetupPerDesign.value * artSetupEvents;
  const print = OWNER_STANDARDS.printSetupPerDesign.value * printSetupEvents;

  return {
    version: LABEL_COST_INPUTS_VERSION,
    lines: lineResults,
    printedLabels,
    materialCost,
    finishing,
    setup: {
      art,
      print,
      total: art + print,
      designs: artSetupEvents,
      artSetupEvents,
      printSetupEvents,
      distinctArtworkCount,
      additionalArtSetupEvents,
      physicalLines: input.lines.length,
      artBasis: SETUP_BASIS,
      printBasis: SETUP_BASIS,
      basisNote: `${input.lines.length} physical line(s) -> ${distinctArtworkCount} distinct artwork(s)${additionalArtSetupEvents > 0 ? ` + ${additionalArtSetupEvents} separate artwork prep event(s)` : ""} = ${artSetupEvents} art setup(s) x ${OWNER_STANDARDS.artSetupPerDesign.value.toFixed(10)}; ${printSetupEvents} print-design setup(s) x ${OWNER_STANDARDS.printSetupPerDesign.value.toFixed(2)}. Label quantity appears in neither: art follows ARTWORK identity and print follows PRESS setups, never line count and never copies.`,
    },
    reasons: Array.from(new Set(reasons)),
    blockers,
  };
}
