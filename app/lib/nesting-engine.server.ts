// Patch 2B (17D.3) — THE deterministic nesting / layout engine.
//
// ONE product-agnostic engine. Jars, stickers, labels, 4x5 sticker bags, stock
// bags, DTP pouches, boxes, banners and every future roll-fed print product
// nest through this file. Product families contribute ITEMS and RUNS through
// their own adapter (jar-cost-inputs.server.ts is the first); they never get
// their own layout maths.
//
// It exists to produce two of the three areas the true-cost engine consumes:
//
//   ripLayoutSqft         — the box the RIP reports and the head traverses.
//                           MACHINE OCCUPANCY denominator.
//   materialFootprintSqft — media physically consumed by the run.
//                           MATERIALS denominator.
//
// The third area, inkableArtworkSqft, is NOT produced here. It is real printed
// shape geometry (a circular lid is pi*r^2) and stays with the adapter.
//
// NO WASTE PERCENTAGE. Physical loss is the layout itself — unused web width,
// blank slots in the last row, and the feed the run actually consumes. Adding a
// percentage on top would double-count (GSO_TRUE_COST_CONTRACT.md 8c).
//
// Pure: no db, no network, no imports.

export const NESTING_ENGINE_VERSION = "17D.3-nesting-engine";

/* ------------------------------------------------------------------ *
 * RIP box convention — per machine, NOT global
 *
 * The two RIPs report a DIFFERENT box, and the live Patch 1 calibrations were
 * measured against those different boxes. Emitting one convention for both
 * would silently change printing minutes.
 *
 *   nest_bbox    RasterLink / Mimaki — the nested bounding width
 *                (cols x itemWidth), not the media width.
 *   swept_width  VersaWorks / Roland — Print Area_X, the configured width the
 *                carriage sweeps regardless of how much art sits under it.
 * ------------------------------------------------------------------ */

export type RipBoxConvention = "nest_bbox" | "swept_width";

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

export type NestingItem = {
  key: string;
  /** Bounding-box width as placed. A circular lid supplies its DIAMETER. */
  widthIn: number;
  /** Bounding-box height as placed. */
  heightIn: number;
  quantity: number;
  /** Default true. An adapter sets false for directional/specialty substrates. */
  allowRotate?: boolean;
  /** Free-form: "rect", "circle_bbox", ... Diagnostic only. */
  shapeType?: string;
  /** Items sharing a groupKey share one band. Defaults to `key`. */
  groupKey?: string;
  /**
   * ACTUAL printable shape area per item, sq in, when it differs from the
   * bounding box (a circular lid: pi*r^2). Diagnostics only — utilisation is
   * honest about a circle in a square. Never used for placement.
   */
  shapeAreaSqIn?: number;
};

/* ------------------------------------------------------------------ *
 * Physical runs
 *
 * SETUP GROUPING AND PHYSICAL-RUN GROUPING ARE DIFFERENT CONCEPTS.
 *
 * A jar side+lid job is ONE artwork/design for setup ($12.50 art + $2.00
 * print) but TWO physical print runs — the lid labels run separately. Each run
 * gets its own layout, feed, media and occupancy; the job total is the SUM.
 * Feeds are NEVER combined across runs.
 *
 * The engine charges no setup at all. Setup is the true-cost engine's job and
 * two runs do not create a second print-setup charge.
 * ------------------------------------------------------------------ */

export type NestingRun = {
  key: string;
  label?: string;
  items: NestingItem[];
  /** Per-run override, e.g. a different media loaded for the lid run. */
  policy?: Partial<NestingPolicy>;
};

/* ------------------------------------------------------------------ *
 * Layout policy
 *
 * mediaWidthIn / printableWidthIn / sweptWidthIn are RELATED BUT DISTINCT and
 * are never collapsed into one field:
 *
 *   mediaWidthIn      nominal width of the loaded roll. MEDIA CONSUMED basis.
 *   printableWidthIn  placement window — what columns are computed against.
 *   sweptWidthIn      carriage sweep width the RIP reports (swept_width only).
 * ------------------------------------------------------------------ */

export type NestingPolicy = {
  mediaWidthIn: number;
  printableWidthIn: number;
  /** Defaults to printableWidthIn. Only consumed under `swept_width`. */
  sweptWidthIn?: number | null;
  leftMarginIn?: number;
  rightMarginIn?: number;
  topMarginIn?: number;
  bottomMarginIn?: number;
  /** Owner-approved default 0 — kept explicit and overrideable. */
  horizontalGutterIn?: number;
  /** Owner-approved default 0 — kept explicit and overrideable. */
  verticalGutterIn?: number;
  /** Owner-approved default true. An adapter may still set allowRotate=false per item. */
  allowRotation?: boolean;
  /** Feed length one media length can carry. Splits the run into layouts. */
  maxFeedLengthIn?: number | null;
  /** Only "band_per_group" exists today. Anything else BLOCKS. */
  groupingPolicy?: string;
  ripBoxConvention: RipBoxConvention;
  /** Provenance of the widths — surfaced in the ripLayoutBasis string. */
  source: string;
  /** e.g. OWNER_APPROVED_PROVISIONAL, PROVISIONAL_EMPIRICAL, HISTORICAL_ACTUAL. */
  classification: string;
};

export const DEFAULT_HORIZONTAL_GUTTER_IN = 0;
export const DEFAULT_VERTICAL_GUTTER_IN = 0;
export const DEFAULT_ALLOW_ROTATION = true;
export const DEFAULT_GROUPING_POLICY = "band_per_group";

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type NestingOrientation = "normal" | "rotated";

export type NestingBand = {
  groupKey: string;
  itemKeys: string[];
  shapeType: string;
  /** Item dimensions AS PLACED — swapped when rotated. */
  placedWidthIn: number;
  placedHeightIn: number;
  orientation: NestingOrientation;
  rotated: boolean;
  columns: number;
  rows: number;
  /** cols x placedWidth + gutters. The nested bounding width of this band. */
  nestWidthIn: number;
  /** rows x placedHeight + gutters. */
  bandFeedIn: number;
  itemsPlaced: number;
  slotsAvailable: number;
  /** Empty slots in the last row — real, physical layout loss. */
  blankSlots: number;
  usedShapeAreaSqIn: number;
  boundingItemAreaSqIn: number;
};

export type NestingRunResult = {
  key: string;
  label: string;
  mediaWidthIn: number;
  printableWidthIn: number;
  sweptWidthIn: number;
  usableWidthIn: number;
  ripBoxConvention: RipBoxConvention;
  horizontalGutterIn: number;
  verticalGutterIn: number;
  allowRotation: boolean;
  bands: NestingBand[];
  /** Total rows across bands. Per-band values live on `bands`. */
  rows: number;
  /** Widest band's column count. Per-band values live on `bands`. */
  columns: number;
  feedLengthIn: number;
  ripWidthIn: number;
  ripHeightIn: number;
  ripLayoutSqft: number;
  materialFootprintSqft: number;
  usedShapeAreaSqft: number;
  boundingItemAreaSqft: number;
  unusedAreaSqft: number;
  /** usedShapeArea / materialFootprint x 100. Honest about circles in squares. */
  utilizationPct: number;
  layouts: number;
  itemsPlaced: number;
  policySource: string;
  policyClassification: string;
  blockers: string[];
};

export type NestingResult = {
  version: string;
  ok: boolean;
  runs: NestingRunResult[];
  /** SUM across physical runs. */
  materialFootprintSqft: number;
  /** SUM across physical runs. null when any run blocked. */
  ripLayoutSqft: number | null;
  feedLengthIn: number;
  usedShapeAreaSqft: number;
  boundingItemAreaSqft: number;
  unusedAreaSqft: number;
  utilizationPct: number;
  itemsPlaced: number;
  layouts: number;
  /** Ready for TrueCostAreas.ripLayoutBasis. Never contains the word "proxy". */
  ripLayoutBasis: string;
  blockers: string[];
};

/* ------------------------------------------------------------------ *
 * Blocker codes — a missing width BLOCKS, it never falls back
 * ------------------------------------------------------------------ */

export const NESTING_BLOCKERS = {
  missingMediaWidth: "MISSING_MEDIA_WIDTH",
  missingPrintableWidth: "MISSING_PRINTABLE_WIDTH",
  itemTooWide: "ITEM_EXCEEDS_PRINTABLE_WIDTH",
  invalidItem: "INVALID_NESTING_ITEM",
  emptyRun: "EMPTY_PHYSICAL_RUN",
  unsupportedGrouping: "UNSUPPORTED_GROUPING_POLICY",
} as const;

/* ------------------------------------------------------------------ *
 * Band placement — deterministic, no optimiser, no randomness
 * ------------------------------------------------------------------ */

function columnsFor(usableWidthIn: number, itemWidthIn: number, gutterH: number): number {
  if (!(itemWidthIn > 0) || !(usableWidthIn > 0)) return 0;
  return Math.floor((usableWidthIn + gutterH) / (itemWidthIn + gutterH));
}

function feedFor(rows: number, itemHeightIn: number, gutterV: number): number {
  if (rows < 1) return 0;
  return rows * itemHeightIn + (rows - 1) * gutterV;
}

type Orientation = { columns: number; rows: number; feed: number; w: number; h: number; rotated: boolean };

function orientationFor(w: number, h: number, qty: number, usable: number, gh: number, gv: number, rotated: boolean): Orientation | null {
  const columns = columnsFor(usable, w, gh);
  if (columns < 1) return null;
  const rows = Math.ceil(qty / columns);
  return { columns, rows, feed: feedFor(rows, h, gv), w, h, rotated };
}

/**
 * Chooses the orientation with the SMALLER feed. Ties resolve UNROTATED, so
 * the result is stable and reproducible regardless of input order.
 */
function chooseOrientation(item: NestingItem, usable: number, gh: number, gv: number, allowRotation: boolean): Orientation | null {
  const normal = orientationFor(item.widthIn, item.heightIn, item.quantity, usable, gh, gv, false);
  const mayRotate = allowRotation && item.allowRotate !== false;
  const rotated = mayRotate ? orientationFor(item.heightIn, item.widthIn, item.quantity, usable, gh, gv, true) : null;
  if (!normal) return rotated;
  if (!rotated) return normal;
  return rotated.feed < normal.feed ? rotated : normal;
}

/* ------------------------------------------------------------------ *
 * One physical run
 * ------------------------------------------------------------------ */

function nestRun(run: NestingRun, base: NestingPolicy): NestingRunResult {
  const p: NestingPolicy = { ...base, ...(run.policy ?? {}) };
  const gh = p.horizontalGutterIn ?? DEFAULT_HORIZONTAL_GUTTER_IN;
  const gv = p.verticalGutterIn ?? DEFAULT_VERTICAL_GUTTER_IN;
  const allowRotation = p.allowRotation ?? DEFAULT_ALLOW_ROTATION;
  const grouping = p.groupingPolicy ?? DEFAULT_GROUPING_POLICY;
  const marginL = p.leftMarginIn ?? 0;
  const marginR = p.rightMarginIn ?? 0;
  const marginT = p.topMarginIn ?? 0;
  const marginB = p.bottomMarginIn ?? 0;

  const blockers: string[] = [];
  if (!(p.mediaWidthIn > 0)) blockers.push(`${NESTING_BLOCKERS.missingMediaWidth}: run "${run.key}" has no loaded media width.`);
  if (!(p.printableWidthIn > 0)) blockers.push(`${NESTING_BLOCKERS.missingPrintableWidth}: run "${run.key}" has no resolved placement width.`);
  if (grouping !== DEFAULT_GROUPING_POLICY) blockers.push(`${NESTING_BLOCKERS.unsupportedGrouping}: "${grouping}" is not implemented.`);
  if (!run.items.length) blockers.push(`${NESTING_BLOCKERS.emptyRun}: run "${run.key}" carries no items.`);

  const usableWidthIn = Math.max(0, (p.printableWidthIn || 0) - marginL - marginR);
  const sweptWidthIn = p.sweptWidthIn ?? p.printableWidthIn;

  // One band per groupKey, in FIRST-SEEN order. Bands stack along the feed.
  const order: string[] = [];
  const grouped = new Map<string, NestingItem[]>();
  for (const item of run.items) {
    const g = item.groupKey ?? item.key;
    if (!grouped.has(g)) {
      grouped.set(g, []);
      order.push(g);
    }
    grouped.get(g)!.push(item);
  }

  const bands: NestingBand[] = [];
  for (const groupKey of order) {
    const items = grouped.get(groupKey)!;
    for (const item of items) {
      if (!(item.widthIn > 0) || !(item.heightIn > 0) || !(item.quantity > 0)) {
        blockers.push(`${NESTING_BLOCKERS.invalidItem}: "${item.key}" needs positive width, height and quantity.`);
        continue;
      }
      // A missing placement width already blocked above — do not additionally
      // accuse the item of being too wide.
      if (!(usableWidthIn > 0)) continue;
      const chosen = chooseOrientation(item, usableWidthIn, gh, gv, allowRotation);
      if (!chosen) {
        blockers.push(
          `${NESTING_BLOCKERS.itemTooWide}: "${item.key}" ${item.widthIn}x${item.heightIn}in does not fit a ${usableWidthIn.toFixed(3)}in placement width in either orientation.`,
        );
        continue;
      }
      const slotsAvailable = chosen.columns * chosen.rows;
      const shapeSqIn = item.shapeAreaSqIn != null ? item.shapeAreaSqIn : item.widthIn * item.heightIn;
      bands.push({
        groupKey,
        itemKeys: [item.key],
        shapeType: item.shapeType ?? "rect",
        placedWidthIn: chosen.w,
        placedHeightIn: chosen.h,
        orientation: chosen.rotated ? "rotated" : "normal",
        rotated: chosen.rotated,
        columns: chosen.columns,
        rows: chosen.rows,
        nestWidthIn: chosen.columns * chosen.w + (chosen.columns - 1) * gh,
        bandFeedIn: chosen.feed,
        itemsPlaced: item.quantity,
        slotsAvailable,
        blankSlots: slotsAvailable - item.quantity,
        usedShapeAreaSqIn: shapeSqIn * item.quantity,
        boundingItemAreaSqIn: item.widthIn * item.heightIn * item.quantity,
      });
    }
  }

  const bandFeedTotal = bands.reduce((s, b) => s + b.bandFeedIn, 0);
  const feedLengthIn = bands.length ? marginT + bandFeedTotal + Math.max(0, bands.length - 1) * gv + marginB : 0;
  const nestWidthIn = bands.length ? Math.max(...bands.map((b) => b.nestWidthIn)) : 0;
  const ripWidthIn = p.ripBoxConvention === "nest_bbox" ? nestWidthIn : sweptWidthIn;

  const ripLayoutSqft = blockers.length ? 0 : (ripWidthIn * feedLengthIn) / 144;
  const materialFootprintSqft = blockers.length ? 0 : (p.mediaWidthIn * feedLengthIn) / 144;
  const usedShapeAreaSqft = bands.reduce((s, b) => s + b.usedShapeAreaSqIn, 0) / 144;
  const boundingItemAreaSqft = bands.reduce((s, b) => s + b.boundingItemAreaSqIn, 0) / 144;
  const maxFeed = p.maxFeedLengthIn ?? null;
  const layouts = maxFeed && maxFeed > 0 && feedLengthIn > 0 ? Math.ceil(feedLengthIn / maxFeed) : feedLengthIn > 0 ? 1 : 0;

  return {
    key: run.key,
    label: run.label ?? run.key,
    mediaWidthIn: p.mediaWidthIn,
    printableWidthIn: p.printableWidthIn,
    sweptWidthIn,
    usableWidthIn,
    ripBoxConvention: p.ripBoxConvention,
    horizontalGutterIn: gh,
    verticalGutterIn: gv,
    allowRotation,
    bands,
    rows: bands.reduce((s, b) => s + b.rows, 0),
    columns: bands.length ? Math.max(...bands.map((b) => b.columns)) : 0,
    feedLengthIn,
    ripWidthIn,
    ripHeightIn: feedLengthIn,
    ripLayoutSqft,
    materialFootprintSqft,
    usedShapeAreaSqft,
    boundingItemAreaSqft,
    unusedAreaSqft: Math.max(0, materialFootprintSqft - usedShapeAreaSqft),
    utilizationPct: materialFootprintSqft > 0 ? (usedShapeAreaSqft / materialFootprintSqft) * 100 : 0,
    layouts,
    itemsPlaced: bands.reduce((s, b) => s + b.itemsPlaced, 0),
    policySource: p.source,
    policyClassification: p.classification,
    blockers,
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

export function computeNesting(runs: NestingRun[], policy: NestingPolicy): NestingResult {
  const results = runs.map((run) => nestRun(run, policy));
  const blockers = results.flatMap((r) => r.blockers);
  const ok = blockers.length === 0 && results.length > 0;

  const materialFootprintSqft = results.reduce((s, r) => s + r.materialFootprintSqft, 0);
  const usedShapeAreaSqft = results.reduce((s, r) => s + r.usedShapeAreaSqft, 0);
  const feedLengthIn = results.reduce((s, r) => s + r.feedLengthIn, 0);

  const describeRun = (r: NestingRunResult) =>
    `${r.key} ${r.bands.map((b) => `${b.groupKey} ${b.columns}x${b.rows}${b.rotated ? " rot" : ""}`).join(" + ")} feed ${r.feedLengthIn.toFixed(2)}in @ ${r.ripBoxConvention} ${r.ripWidthIn.toFixed(3)}in`;

  return {
    version: NESTING_ENGINE_VERSION,
    ok,
    runs: results,
    materialFootprintSqft,
    ripLayoutSqft: ok ? results.reduce((s, r) => s + r.ripLayoutSqft, 0) : null,
    feedLengthIn,
    usedShapeAreaSqft,
    boundingItemAreaSqft: results.reduce((s, r) => s + r.boundingItemAreaSqft, 0),
    unusedAreaSqft: Math.max(0, materialFootprintSqft - usedShapeAreaSqft),
    utilizationPct: materialFootprintSqft > 0 ? (usedShapeAreaSqft / materialFootprintSqft) * 100 : 0,
    itemsPlaced: results.reduce((s, r) => s + r.itemsPlaced, 0),
    layouts: results.reduce((s, r) => s + r.layouts, 0),
    ripLayoutBasis: ok
      ? `Deterministic nesting ${NESTING_ENGINE_VERSION} — ${results.length} physical run(s): ${results.map(describeRun).join(" | ")}. Widths: ${results[0].policySource} (${results[0].policyClassification}).`
      : `Nesting blocked: ${blockers.join(" ")}`,
    blockers,
  };
}

/* ------------------------------------------------------------------ *
 * Machine width + convention policy
 *
 * Data-driven and overrideable — NOT immutable machine specification.
 * ------------------------------------------------------------------ */

export type MachineNestingPolicy = {
  machineKey: string;
  label: string;
  /** Hard machine ceiling. */
  machineMaxWidthIn: number;
  ripBoxConvention: RipBoxConvention;
  /**
   * "min_media_machine" — placement width = min(loadedMediaWidth, machineMax).
   * "media_table"       — placement width looked up per nominal roll width;
   *                       an unlisted roll BLOCKS rather than guessing.
   */
  widthRule: "min_media_machine" | "media_table";
  /** Only for widthRule "media_table". Key = nominal roll width in inches. */
  operationalWidthByMediaWidthIn?: Record<number, number>;
  classification: string;
  source: string;
};

export const MACHINE_NESTING_POLICIES: Record<string, MachineNestingPolicy> = {
  "mimaki-ucjv300-130": {
    machineKey: "mimaki-ucjv300-130",
    label: "Mimaki UCJV300-130",
    machineMaxWidthIn: 53.6,
    ripBoxConvention: "nest_bbox",
    widthRule: "min_media_machine",
    classification: "OWNER_APPROVED_PROVISIONAL",
    source:
      "Owner rule: placement width = min(loadedMediaWidthIn, 53.6in machine maximum). 54in media -> 53.6in, 50in media -> 50.0in. RasterLink reports the NESTED bounding width, so ripWidth is the nest, never the media width. Not supplier- or RIP-verified.",
  },
  "roland-lg-640": {
    machineKey: "roland-lg-640",
    label: "Roland TrueVIS LG-640",
    machineMaxWidthIn: 52.9,
    ripBoxConvention: "swept_width",
    widthRule: "media_table",
    operationalWidthByMediaWidthIn: { 54: 52.4, 50: 49.1 },
    classification: "PROVISIONAL_EMPIRICAL",
    source:
      "Operational widths from 555 accepted production jobs (analysis-output/roland/roland-cleaned-records.csv): 54in roll -> 52.4in (n=222 cluster), 50in roll -> 49.1in (n=39 cluster). VersaWorks reports Print Area_X, the swept carriage width, so ripWidth is the swept width, not the nest. 52.9in is the machine maximum and is NOT used as every job's swept width.",
  },
};

export type ResolveNestingPolicyInput = {
  machineKey: string;
  loadedMediaWidthIn: number;
  /**
   * Actual per-job RIP Print Area_X when captured. For a historical job this
   * BEATS the operational default — the effective imaging window is known, so
   * it sets both the placement width and the swept width.
   */
  actualSweptWidthIn?: number | null;
  overrides?: Partial<NestingPolicy>;
};

export type ResolvedNestingPolicy = { ok: true; policy: NestingPolicy } | { ok: false; blocker: string; message: string };

export function resolveNestingPolicy(input: ResolveNestingPolicyInput): ResolvedNestingPolicy {
  const machine = MACHINE_NESTING_POLICIES[input.machineKey];
  if (!machine) {
    return {
      ok: false,
      blocker: NESTING_BLOCKERS.missingPrintableWidth,
      message: `No nesting width policy for machine "${input.machineKey}". A placement width is never guessed.`,
    };
  }
  if (!(input.loadedMediaWidthIn > 0)) {
    return {
      ok: false,
      blocker: NESTING_BLOCKERS.missingMediaWidth,
      message: `Machine ${machine.label} needs a loaded media width. Media consumption is never inferred.`,
    };
  }

  const actual = input.actualSweptWidthIn != null && input.actualSweptWidthIn > 0 ? input.actualSweptWidthIn : null;
  let printableWidthIn: number | null = null;
  let classification = machine.classification;
  let source = machine.source;

  if (actual != null) {
    printableWidthIn = actual;
    classification = "HISTORICAL_ACTUAL_RIP";
    source = `Actual per-job RIP swept width ${actual}in (captured Print Area_X) — preferred over the operational default for ${machine.label}.`;
  } else if (machine.widthRule === "min_media_machine") {
    printableWidthIn = Math.min(input.loadedMediaWidthIn, machine.machineMaxWidthIn);
  } else {
    const table = machine.operationalWidthByMediaWidthIn ?? {};
    const found = table[input.loadedMediaWidthIn];
    if (found == null) {
      return {
        ok: false,
        blocker: NESTING_BLOCKERS.missingPrintableWidth,
        message: `${machine.label} has no operational placement width for a ${input.loadedMediaWidthIn}in roll. Known: ${Object.keys(table).join(", ") || "none"}. A width is never extrapolated.`,
      };
    }
    printableWidthIn = Math.min(found, machine.machineMaxWidthIn);
  }

  return {
    ok: true,
    policy: {
      mediaWidthIn: input.loadedMediaWidthIn,
      printableWidthIn,
      sweptWidthIn: printableWidthIn,
      horizontalGutterIn: DEFAULT_HORIZONTAL_GUTTER_IN,
      verticalGutterIn: DEFAULT_VERTICAL_GUTTER_IN,
      allowRotation: DEFAULT_ALLOW_ROTATION,
      groupingPolicy: DEFAULT_GROUPING_POLICY,
      maxFeedLengthIn: null,
      ripBoxConvention: machine.ripBoxConvention,
      source,
      classification,
      ...(input.overrides ?? {}),
    },
  };
}
