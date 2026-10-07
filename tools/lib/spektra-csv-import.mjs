// Spektra / Flex Packaging research CSV import contract (2026-10-06).
// Pure, side-effect-free parsing + validation used by
// tools/generate-spektra-cost-book.mjs and by the vitest import-contract
// tests. FAIL CLOSED: any unknown value, malformed feature text, bad number,
// wrong discount, or wholesale figure that disagrees with
// website_total x 0.75 rejects the row (and the generator refuses the run).
// The CSV is never modified; numbers are never altered.

export const RESEARCH_DATE = "2026-10-06";
export const DISCOUNT_FACTOR = 0.75;
export const EXPECTED_DISCOUNT_PCT = 25;

export const SIZES = ["3.5x4.5x2", "4x5x2", "5x5x2", "6x5x2", "8x5x2"];
export const MATERIALS = ["White PET", "Silver PET", "Hologram", "Clear PET"];
export const FINISHES = ["Soft Touch", "Matte", "Glossy"];
export const SPOTS = ["None", "Standard", "Raised UV"];
export const ZIPPERS = ["None", "10 mm", "Child Resistant"];
export const TOP_FEATURES = ["No Tear Notch", "Punch Hole", "Sombrero"];
export const CLEAR_GUSSET_TOKEN = "Clear Gusset";

/** Header aliases: matched after lower-casing and stripping spaces / underscores / dashes. */
export const COLUMN_ALIASES = {
  sourceDate: ["sourcedate", "observedat", "date", "observed"],
  size: ["size", "pouchsize", "bagsize"],
  material: ["material"],
  finish: ["finish", "laminate", "lamination"],
  spot: ["spot", "spotgloss", "spotuv"],
  zipper: ["zipper", "zip"],
  features: ["features", "feature", "topfeature", "top"],
  clearGusset: ["cleargusset", "gusset"], // optional explicit column; `features` may also carry "+ Clear Gusset"
  quantity: ["quantity", "qty", "totalquantity"],
  skuCount: ["skucount", "skus", "designs", "designcount"],
  publicTotal: ["websitetotal", "publictotal", "ordertotal", "total", "publicordertotal"],
  publicUnitDisplayed: ["websiteunitdisplay", "publicunit", "unitprice", "displayedunit", "publicunitdisplayed"],
  discountPct: ["gsodiscountpct", "discountpct", "discount"],
  wholesaleTotal: ["gsowholesaletotal", "wholesaletotal"],
  wholesaleUnit: ["gsowholesaleunitcost", "wholesaleunit", "wholesaleunitcost"],
  note: ["note", "notes", "compatibilitynotes"],
  confidence: ["confidence"],
};
export const REQUIRED_COLUMNS = ["size", "material", "finish", "spot", "zipper", "features", "quantity", "publicTotal"];

export const normHeader = (s) => String(s || "").toLowerCase().replace(/[\s_\-]+/g, "");

export function parseCsv(text) {
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

export function mapColumns(header) {
  const col = {};
  for (const [key, names] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => names.includes(normHeader(h)));
    if (idx >= 0) col[key] = idx;
  }
  const missing = REQUIRED_COLUMNS.filter((k) => col[k] == null);
  return { col, missing };
}

/** "3.5 x 4.5 x 2" / "4 X 5 X 2" / "4x5x2" -> "4x5x2"; anything else -> null. */
export function normalizeSize(raw) {
  const compact = String(raw || "").toLowerCase().replace(/\s+/g, "").replace(/×/g, "x");
  return SIZES.includes(compact) ? compact : null;
}

const canon = (list, raw) => {
  const needle = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  return list.find((v) => v.toLowerCase() === needle) ?? null;
};
export const normalizeMaterial = (raw) => canon(MATERIALS, raw);
export const normalizeFinish = (raw) => canon(FINISHES, raw);
export const normalizeSpot = (raw) => canon(SPOTS, String(raw || "").trim() === "" ? "None" : raw);
export const normalizeZipper = (raw) => canon(ZIPPERS, String(raw || "").trim() === "" ? "None" : raw);

/**
 * `features` -> { topFeature, clearGusset }. Accepts exactly:
 *   "No Tear Notch" | "Punch Hole" | "Sombrero" | "<top> + Clear Gusset" | "Clear Gusset + <top>"
 * Separators: "+", "," or "/" with optional spaces. Anything else is an error
 * (unknown token, missing top feature, two top features, duplicate gusset token).
 */
export function parseFeatures(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "features is empty (a top feature is required)" };
  const tokens = text.split(/\s*(?:\+|,|\/)\s*/).map((t) => t.trim()).filter(Boolean);
  let clearGusset = false;
  let topFeature = null;
  for (const token of tokens) {
    const low = token.toLowerCase();
    if (low === CLEAR_GUSSET_TOKEN.toLowerCase()) {
      if (clearGusset) return { ok: false, error: `duplicate "Clear Gusset" in "${text}"` };
      clearGusset = true;
      continue;
    }
    const top = canon(TOP_FEATURES, token);
    if (!top) return { ok: false, error: `unknown feature token "${token}" in "${text}"` };
    if (topFeature) return { ok: false, error: `two top features in "${text}" (top features are mutually exclusive)` };
    topFeature = top;
  }
  if (!topFeature) return { ok: false, error: `no top feature in "${text}" (Clear Gusset is a toggle, not a top feature)` };
  return { ok: true, topFeature, clearGusset };
}

export const moneyNumber = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const bool = (v) => /^(true|yes|y|1)$/i.test(String(v || "").trim());

/** Builds one observed row or an error. Numbers are read exactly; nothing is rounded except the comparison tolerance. */
export function buildRow(line, col, lineNumber) {
  const get = (k) => (col[k] == null ? "" : String(line[col[k]] ?? "").trim());
  const errors = [];
  const size = normalizeSize(get("size")); if (!size) errors.push(`unknown size "${get("size")}"`);
  const material = normalizeMaterial(get("material")); if (!material) errors.push(`unknown material "${get("material")}"`);
  const finish = normalizeFinish(get("finish")); if (!finish) errors.push(`unknown finish "${get("finish")}"`);
  const spot = normalizeSpot(get("spot")); if (!spot) errors.push(`unknown spot "${get("spot")}"`);
  const zipper = normalizeZipper(get("zipper")); if (!zipper) errors.push(`unknown zipper "${get("zipper")}"`);
  const features = parseFeatures(get("features")); if (!features.ok) errors.push(features.error);
  let clearGusset = features.ok ? features.clearGusset : false;
  if (col.clearGusset != null && get("clearGusset") !== "") {
    const explicit = bool(get("clearGusset"));
    if (features.ok && explicit !== features.clearGusset) errors.push(`clear_gusset column (${get("clearGusset")}) contradicts features "${get("features")}"`);
    clearGusset = explicit;
  }
  if (finish === "Glossy" && spot && spot !== "None") errors.push(`spot "${spot}" is not available on the Glossy laminate`);
  const quantity = Number(get("quantity")); if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`invalid quantity "${get("quantity")}"`);
  const skuCount = get("skuCount") === "" ? 1 : Number(get("skuCount")); if (!Number.isInteger(skuCount) || skuCount < 1) errors.push(`invalid sku_count "${get("skuCount")}"`);
  const publicTotal = moneyNumber(get("publicTotal")); if (!(publicTotal > 0)) errors.push(`invalid website_total "${get("publicTotal")}"`);
  const publicUnitDisplayed = get("publicUnitDisplayed") === "" ? null : moneyNumber(get("publicUnitDisplayed"));
  if (publicUnitDisplayed != null && !(publicUnitDisplayed > 0)) errors.push(`invalid website_unit_display "${get("publicUnitDisplayed")}"`);
  if (col.discountPct != null && get("discountPct") !== "") {
    const d = Number(get("discountPct"));
    if (d !== EXPECTED_DISCOUNT_PCT) errors.push(`gso_discount_pct ${get("discountPct")} is not the owner-confirmed ${EXPECTED_DISCOUNT_PCT}`);
  }
  if (col.wholesaleTotal != null && get("wholesaleTotal") !== "" && publicTotal > 0) {
    const claimed = moneyNumber(get("wholesaleTotal"));
    const expected = publicTotal * DISCOUNT_FACTOR;
    if (!(Math.abs(claimed - expected) <= 0.005)) errors.push(`gso_wholesale_total ${get("wholesaleTotal")} != website_total x 0.75 (${expected.toFixed(6)})`);
  }
  if (col.wholesaleUnit != null && get("wholesaleUnit") !== "" && publicTotal > 0 && quantity > 0) {
    const claimed = moneyNumber(get("wholesaleUnit"));
    const expected = (publicTotal * DISCOUNT_FACTOR) / quantity;
    if (!(Math.abs(claimed - expected) <= 1e-6)) errors.push(`gso_wholesale_unit_cost ${get("wholesaleUnit")} != (website_total x 0.75) / quantity (${expected.toFixed(10)})`);
  }
  if (errors.length) return { ok: false, lineNumber, errors };
  return {
    ok: true,
    row: {
      size, material, finish, spot, zipper, topFeature: features.topFeature, clearGusset,
      quantity, skuCount, publicTotal, publicUnitDisplayed,
      observedAt: get("sourceDate") || RESEARCH_DATE,
      note: get("note") || null,
    },
  };
}

export const rowKey = (r) => [r.size, r.material, r.finish, r.spot, r.zipper, r.topFeature, r.clearGusset ? 1 : 0, r.quantity, r.skuCount].join("|");

/** Full import: returns accepted unique rows, rejections, and duplicate diagnostics. */
export function importSpektraCsv(text) {
  const parsed = parseCsv(text);
  if (!parsed.length) return { ok: false, reason: "CSV is empty", missingColumns: [], read: 0, accepted: [], rejected: [], duplicates: [], conflicts: [] };
  const [header, ...lines] = parsed;
  const { col, missing } = mapColumns(header);
  if (missing.length) return { ok: false, reason: `missing required column(s): ${missing.join(", ")}`, missingColumns: missing, read: lines.length, accepted: [], rejected: [], duplicates: [], conflicts: [] };
  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const conflicts = [];
  const seen = new Map();
  lines.forEach((line, i) => {
    const built = buildRow(line, col, i + 2);
    if (!built.ok) { rejected.push(built); return; }
    const key = rowKey(built.row);
    const prior = seen.get(key);
    if (prior) {
      if (Math.abs(prior.publicTotal - built.row.publicTotal) > 0.005) conflicts.push({ lineNumber: i + 2, key, priorTotal: prior.publicTotal, total: built.row.publicTotal });
      else duplicates.push({ lineNumber: i + 2, key });
      return;
    }
    seen.set(key, built.row);
    accepted.push(built.row);
  });
  accepted.sort((a, b) => rowKey(a).localeCompare(rowKey(b)) || a.quantity - b.quantity || a.skuCount - b.skuCount);
  return { ok: rejected.length === 0 && conflicts.length === 0, reason: null, missingColumns: [], read: lines.length, accepted, rejected, duplicates, conflicts };
}
