#!/usr/bin/env node
// Generates app/lib/generated/spektra-live-price-matrix-2026-10-06.ts from the
// live Flex Packaging / Spektra research CSV. Deterministic: same CSV in, same
// file out. REFUSES to run without the CSV — it never invents rows.
//
// Expected CSV columns (header names are matched case-insensitively after
// stripping spaces/underscores; extra columns are ignored):
//   size, material, finish, spot (or spot_gloss), zipper, top_feature (or feature),
//   clear_gusset (true/false/yes/no/1/0), quantity, sku_count (or skus; default 1),
//   public_total (or order_total / total), public_unit (optional, displayed unit),
//   observed_at (optional; defaults to the research date), note (optional)
//
// Usage: node tools/generate-spektra-cost-book.mjs [path/to/matrix.csv]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RESEARCH_DATE = "2026-10-06";
const DEFAULT_CSV = "docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv";
const OUT = "app/lib/generated/spektra-live-price-matrix-2026-10-06.ts";

const csvPath = resolve(process.argv[2] || DEFAULT_CSV);
if (!existsSync(csvPath)) {
  console.error(`REFUSED: research CSV not found at ${csvPath}. No rows generated; the existing artifact is left untouched.`);
  process.exit(2);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-]+/g, "");
const ALIASES = {
  size: ["size", "pouchsize", "bagsize"],
  material: ["material"],
  finish: ["finish", "laminate", "lamination"],
  spot: ["spot", "spotgloss", "spotuv"],
  zipper: ["zipper", "zip"],
  topFeature: ["topfeature", "feature", "top"],
  clearGusset: ["cleargusset", "gusset"],
  quantity: ["quantity", "qty", "totalquantity"],
  skuCount: ["skucount", "skus", "designs", "designcount"],
  publicTotal: ["publictotal", "ordertotal", "total", "publicordertotal"],
  publicUnitDisplayed: ["publicunit", "unitprice", "displayedunit", "publicunitdisplayed"],
  observedAt: ["observedat", "date", "observed"],
  note: ["note", "notes"],
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i += 1; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

const text = readFileSync(csvPath, "utf8");
const [header, ...lines] = parseCsv(text);
const col = {};
for (const [key, names] of Object.entries(ALIASES)) {
  const idx = header.findIndex((h) => names.includes(norm(h)));
  if (idx >= 0) col[key] = idx;
}
for (const required of ["size", "material", "finish", "spot", "zipper", "topFeature", "quantity", "publicTotal"]) {
  if (col[required] == null) { console.error(`REFUSED: CSV is missing a required column for "${required}" (accepted names: ${ALIASES[required].join(", ")})`); process.exit(3); }
}
const bool = (v) => /^(true|yes|y|1)$/i.test(String(v || "").trim());
const money = (v) => Number(String(v || "").replace(/[$,\s]/g, ""));
const rows = lines.map((line, i) => {
  const get = (k) => (col[k] == null ? "" : String(line[col[k]] ?? "").trim());
  const r = {
    size: get("size"), material: get("material"), finish: get("finish"), spot: get("spot") || "None", zipper: get("zipper") || "None",
    topFeature: get("topFeature") || "No Tear Notch", clearGusset: bool(get("clearGusset")),
    quantity: Math.floor(Number(get("quantity"))), skuCount: Math.max(1, Math.floor(Number(get("skuCount") || 1))),
    publicTotal: money(get("publicTotal")), publicUnitDisplayed: get("publicUnitDisplayed") ? money(get("publicUnitDisplayed")) : null,
    observedAt: get("observedAt") || RESEARCH_DATE, note: get("note") || null,
  };
  if (!r.size || !r.material || !r.finish || !(r.quantity > 0) || !(r.publicTotal > 0)) { console.error(`REFUSED: line ${i + 2} is incomplete: ${JSON.stringify(r)}`); process.exit(4); }
  return r;
});
rows.sort((a, b) => a.size.localeCompare(b.size) || a.material.localeCompare(b.material) || a.finish.localeCompare(b.finish) || a.spot.localeCompare(b.spot) || a.zipper.localeCompare(b.zipper) || a.topFeature.localeCompare(b.topFeature) || Number(a.clearGusset) - Number(b.clearGusset) || a.quantity - b.quantity || a.skuCount - b.skuCount);

const out = `// GENERATED ARTIFACT — do not edit by hand.
// Source CSV: ${DEFAULT_CSV}
// Generator:  tools/generate-spektra-cost-book.mjs
// Generated from ${rows.length} observed row(s). Re-run the generator after any research update.

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

export const SPEKTRA_OBSERVED_ROWS: SpektraObservedRow[] = ${JSON.stringify(rows, null, 1)};
`;
writeFileSync(resolve(OUT), out);
console.log(`wrote ${OUT} with ${rows.length} rows from ${csvPath}`);
