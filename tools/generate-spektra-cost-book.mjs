#!/usr/bin/env node
// Generates app/lib/generated/spektra-live-price-matrix-2026-10-06.ts from the
// live Flex Packaging / Spektra research CSV. Deterministic: same CSV in, same
// file out. REFUSES to run without the CSV, with a missing required column,
// with ANY rejected row, or with conflicting duplicate prices — it never
// invents or alters a vendor price and never edits the CSV.
//
// Import contract (header names matched case-insensitively after stripping
// spaces / underscores / dashes): see tools/lib/spektra-csv-import.mjs.
// The research `features` column ("Sombrero + Clear Gusset") is parsed into
// topFeature + clearGusset. Exact duplicate rows (same key, same price) are
// collapsed and reported; a duplicate key with a different price is a
// conflict and refuses the run.
//
// Usage: node tools/generate-spektra-cost-book.mjs [path/to/matrix.csv]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RESEARCH_DATE, importSpektraCsv } from "./lib/spektra-csv-import.mjs";

const DEFAULT_CSV = "docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv";
const OUT = "app/lib/generated/spektra-live-price-matrix-2026-10-06.ts";

const csvPath = resolve(process.argv[2] || DEFAULT_CSV);
if (!existsSync(csvPath)) {
  console.error(`REFUSED: research CSV not found at ${csvPath}. No rows generated; the existing artifact is left untouched.`);
  process.exit(2);
}
const result = importSpektraCsv(readFileSync(csvPath, "utf8"));
if (result.missingColumns.length) {
  console.error(`REFUSED: ${result.reason}`);
  process.exit(3);
}
for (const r of result.rejected.slice(0, 25)) console.error(`REJECTED line ${r.lineNumber}: ${r.errors.join("; ")}`);
for (const c of result.conflicts.slice(0, 25)) console.error(`CONFLICT line ${c.lineNumber}: same configuration priced $${c.priorTotal} and $${c.total}`);
console.log(`CSV rows read: ${result.read}`);
console.log(`unique rows accepted: ${result.accepted.length}`);
console.log(`rows rejected: ${result.rejected.length}`);
console.log(`exact duplicate rows collapsed: ${result.duplicates.length}`);
console.log(`conflicting duplicates: ${result.conflicts.length}`);
if (!result.ok) {
  console.error("REFUSED: validation failed; the existing artifact is left untouched.");
  process.exit(4);
}

const rows = result.accepted;
const out = `// GENERATED ARTIFACT — do not edit by hand.
// Source CSV: ${DEFAULT_CSV}
// Generator:  tools/generate-spektra-cost-book.mjs (import contract: tools/lib/spektra-csv-import.mjs)
// Generated from ${result.read} CSV rows -> ${rows.length} unique directly observed rows
// (${result.duplicates.length} exact duplicates collapsed, ${result.rejected.length} rejected). Re-run after any research update.
// Every row is a DIRECTLY OBSERVED public-calculator price; derived/estimated prices are never stored here.

export const SPEKTRA_MATRIX_GENERATED_AT = "${RESEARCH_DATE}";
export const SPEKTRA_MATRIX_SOURCE_FILE = "${DEFAULT_CSV}";
export const SPEKTRA_MATRIX_SOURCE_PRESENT = true;
export const SPEKTRA_MATRIX_ROW_COUNT = ${rows.length};

/** One directly observed public-calculator price. */
export type SpektraObservedRow = {
  size: string;
  material: string;
  finish: string;
  spot: string;
  zipper: string;
  topFeature: string;
  clearGusset: boolean;
  quantity: number;
  skuCount: number;
  /** EXACT public order total as displayed by the calculator (before the GSO discount). */
  publicTotal: number;
  /** Rounded public unit price as displayed (informational; never discounted directly). */
  publicUnitDisplayed: number | null;
  observedAt: string;
  note: string | null;
};

export const SPEKTRA_OBSERVED_ROWS: SpektraObservedRow[] = ${JSON.stringify(rows.map((r) => ({ ...r, note: null })), null, 0).replace(/\},\{/g, "},\n{")};
`;
writeFileSync(resolve(OUT), out);
console.log(`generated artifact row count: ${rows.length} -> ${OUT}`);
