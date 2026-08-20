import crypto from "crypto";

// RasterLink result-CSV parser (13A.6A). Pure module: no Prisma, no network.
// Validated conversion (owner-confirmed 2026-07-18):
//   - JobInfo.ini inkUsed codes: 1=Cyan, 2=Magenta, 3=Yellow, 4=Black
//   - raw JobInfo value / 1000 = cc PER ARRANGED ITEM
//   - KEY_INKUSE values are rounded per-item estimates; per-item x arrange
//     count is therefore an ESTIMATE and must never be presented as exact
//     measured ink (RasterLink's internal UI total is higher precision).

export const RASTERLINK_SOURCE = "rasterlink";
export const INK_BASIS_ESTIMATE = "rasterlink_rounded_per_item_estimate";
export const INK_BASIS_MISSING = "missing_inkuse";
export const INK_BASIS_CUT = "cut_row_no_ink";

// ---------- CSV / header detection ----------

export function parseDelimited(text: string): Record<string, string>[] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { field += '"'; i += 1; } else quoted = !quoted;
    } else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((cell) => cell.trim())) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => { record[header] = String(cells[index] ?? "").trim(); });
    return record;
  });
}

// RasterLink CSVs are identified by their KEY_* headers. VersaWorks CSVs
// ("Event", "Nick Name", ...) must never match, so the existing parser branch
// stays untouched for them.
export function looksLikeRasterlinkCsv(text: string): boolean {
  const firstLine = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  return /(^|,)\s*"?KEY_FILENAME"?\s*(,|$)/i.test(firstLine) || /(^|,)\s*"?KEY_[A-Z_]+"?\s*(,|$)/i.test(firstLine);
}

// ---------- ink parsing ----------

export type InkUse = {
  present: boolean;
  cyanCc: number;
  magentaCc: number;
  yellowCc: number;
  blackCc: number;
  whiteCc: number; // repeated W channels summed
  clearCc: number; // repeated Cl channels summed
  perItemTotalCc: number;
};

// "C:0.067cc M:0.070cc Y:0.014cc K:0.017cc W:0.000cc W:0.000cc Cl:0.000cc Cl:0.000cc"
export function parseInkUse(value: unknown): InkUse {
  const text = String(value ?? "").trim();
  const empty: InkUse = { present: false, cyanCc: 0, magentaCc: 0, yellowCc: 0, blackCc: 0, whiteCc: 0, clearCc: 0, perItemTotalCc: 0 };
  if (!text) return empty;
  const matches = [...text.matchAll(/([A-Za-z]+)\s*:\s*([0-9.]+)\s*cc/gi)];
  if (!matches.length) return empty;
  const out = { ...empty, present: true };
  for (const match of matches) {
    const channel = match[1].toLowerCase();
    const cc = Number(match[2]);
    if (!Number.isFinite(cc)) continue;
    if (channel === "c") out.cyanCc += cc;
    else if (channel === "m") out.magentaCc += cc;
    else if (channel === "y") out.yellowCc += cc;
    else if (channel === "k") out.blackCc += cc;
    else if (channel === "w") out.whiteCc += cc;
    else if (channel === "cl") out.clearCc += cc;
    else out.perItemTotalCc += 0; // unknown channel codes are ignored, never guessed
  }
  out.perItemTotalCc = out.cyanCc + out.magentaCc + out.yellowCc + out.blackCc + out.whiteCc + out.clearCc;
  return out;
}

// JobInfo.ini "inkUsed=1;67,2;70,3;14,4;17" -> cc per arranged item.
// PURE CONVERTER ONLY in 13A.6A: validated and tested now, wired into the
// upload path as a blank-KEY_INKUSE fallback in a later patch.
export function parseJobInfoInkUsed(value: unknown): InkUse {
  const text = String(value ?? "").replace(/^inkUsed=/i, "").trim();
  const empty: InkUse = { present: false, cyanCc: 0, magentaCc: 0, yellowCc: 0, blackCc: 0, whiteCc: 0, clearCc: 0, perItemTotalCc: 0 };
  if (!text) return empty;
  const out = { ...empty, present: true };
  for (const pair of text.split(",")) {
    const [codeRaw, rawValue] = pair.split(";");
    const code = Number(codeRaw);
    const cc = Number(rawValue) / 1000; // validated: raw / 1000 = cc per item
    if (!Number.isFinite(cc)) continue;
    if (code === 1) out.cyanCc += cc;
    else if (code === 2) out.magentaCc += cc;
    else if (code === 3) out.yellowCc += cc;
    else if (code === 4) out.blackCc += cc;
    // codes beyond 1-4 are not yet confirmed — ignored, never guessed.
  }
  out.perItemTotalCc = out.cyanCc + out.magentaCc + out.yellowCc + out.blackCc + out.whiteCc + out.clearCc;
  return out;
}

// ---------- row building ----------

// 2C-1: RasterLink writes its NATIVE stamps as YYYYMMDD_HHMMSS
// ("20260601_231501"). `new Date()` cannot read that at all — it returns
// Invalid Date — so before this fix every real production stamp resolved to
// null. For a cut-format CSV that also meant the ROW was dropped entirely
// (no KEY_INKUSE column, no parsable cut stamps -> neither side present), and
// print rows imported with null timings. Parsed explicitly here; the previous
// `new Date()` path is kept underneath for the ISO-style values that path
// already accepted.
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return DAYS_PER_MONTH[month - 1];
}

/**
 * RasterLink native stamp: exactly 8 digits, "_", exactly 6 digits.
 * Every component is range-checked and an impossible value is REJECTED, never
 * normalised — `new Date(2026, 1, 30)` would silently roll 30 Feb into March.
 * Returns a LOCAL-time Date, matching the convention below (see parseStamp).
 */
function parseRasterlinkNativeStamp(raw: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1970 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

/**
 * TIMEZONE CONVENTION (unchanged by 2C-1): RIP stamps carry no offset, so they
 * are naive SHOP-LOCAL times and are materialised as local-time Dates — the
 * same behaviour `new Date("2026-06-01T23:15:01")` has always had here and in
 * versaworks-parse.server.ts. No timezone policy exists anywhere in the repo
 * and this patch does not introduce one. Durations are offset-invariant
 * because both ends parse identically.
 */
function parseStamp(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const native = parseRasterlinkNativeStamp(raw);
  if (native) return native;
  const d = new Date(raw.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function minutesBetween(start: Date | null, end: Date | null): number {
  if (!start || !end) return 0;
  const ms = end.getTime() - start.getTime();
  return ms > 0 ? ms / 60000 : 0;
}

export function extractTicket(jobName: string, fileName = ""): string {
  // Intake-watcher-renamed files are "TICKET_Customer_Product_SIDE_...", so
  // the FIRST underscore segment is the ticket (the endpoint's greedy pattern
  // would swallow the whole name and never equal ProductionJob.jobTicket).
  for (const candidate of [jobName, fileName]) {
    const first = String(candidate || "").split("_", 1)[0]?.trim() || "";
    if (/^GSO-?(?:TEST-?)?[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(first)) {
      return first.replace(/\s+/g, "-").toUpperCase();
    }
  }
  // Legacy fallback: the same greedy pattern the existing endpoint uses.
  const match = `${jobName} ${fileName}`.match(/\bGSO[-_ ]?(?:TEST[-_ ]?)?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\b/i);
  return match ? match[0].replace(/_/g, "-").replace(/\s+/g, "-").toUpperCase() : "";
}

export type RasterlinkEntry = {
  kind: "print" | "cut";
  fileName: string; // KEY_FILENAME -> stored in sourceJobName
  jobTicket: string;
  status: string; // "print:<result>" / "cut:<result>" (kind is part of the natural key)
  startedAt: Date | null;
  completedAt: Date | null;
  printMinutes: number; // print rows only, and ONLY from print timestamps
  inkMl: number; // multiplied ESTIMATE (cc == ml); 0 when ink missing or cut row
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  raw: Record<string, unknown>;
};

export function parseRasterlinkRows(text: string, uploadFileName: string): RasterlinkEntry[] {
  const entries: RasterlinkEntry[] = [];
  for (const row of parseDelimited(text)) {
    const fileName = row.KEY_FILENAME || "";
    const result = row.KEY_RESULT || "";
    const detail = row.KEY_RESULT_DETAIL || "";
    const arrangeRaw = Number(row.KEY_ARRANGE_CNT);
    const arrangeCnt = Number.isFinite(arrangeRaw) && arrangeRaw > 0 ? Math.round(arrangeRaw) : null;
    const jobTicket = extractTicket(fileName, uploadFileName);

    const ripStart = parseStamp(row.KEY_RIP_S_TIME);
    const ripEnd = parseStamp(row.KEY_RIP_E_TIME);
    const printStart = parseStamp(row.KEY_PRINT_S_TIME);
    const printEnd = parseStamp(row.KEY_PRINT_E_TIME);
    const vecStart = parseStamp(row.KEY_VEC_S_TIME);
    const vecEnd = parseStamp(row.KEY_VEC_E_TIME);
    const cutStart = parseStamp(row.KEY_CUT_S_TIME);
    const cutEnd = parseStamp(row.KEY_CUT_E_TIME);

    const ink = parseInkUse(row.KEY_INKUSE);
    const hasCutSide = Boolean(vecStart || vecEnd || cutStart || cutEnd);
    // Print side = any print evidence by VALUE (ink or rip/print stamps).
    // Fallback: in a print-format CSV (the KEY_INKUSE column exists), a row
    // with no cut values is still a print row even when everything is blank —
    // that is the "blank KEY_INKUSE" case, imported with INK_BASIS_MISSING
    // rather than silently dropped or zero-faked. Cut-format CSVs have no
    // KEY_INKUSE column, so they can never produce phantom print rows.
    const hasPrintSide = ink.present || Boolean(ripStart || ripEnd || printStart || printEnd) || ("KEY_INKUSE" in row && !hasCutSide);

    if (hasPrintSide) {
      // Multiplication rule: per-item cc x arrange count = ESTIMATED total.
      // When the arrange count is missing, 1 is assumed and flagged.
      const multiplier = arrangeCnt ?? 1;
      const estimated = ink.present;
      const cmyk = (ink.cyanCc + ink.magentaCc + ink.yellowCc + ink.blackCc) * multiplier;
      const white = ink.whiteCc * multiplier;
      const gloss = ink.clearCc * multiplier;
      entries.push({
        kind: "print",
        fileName,
        jobTicket,
        status: `print:${result || "unknown"}`,
        startedAt: printStart, // NEVER RIP time in the print slots
        completedAt: printEnd,
        printMinutes: minutesBetween(printStart, printEnd), // print duration only; RIP duration never counts
        inkMl: estimated ? cmyk + white + gloss : 0,
        cmykInkMl: estimated ? cmyk : 0,
        whiteInkMl: estimated ? white : 0,
        glossInkMl: estimated ? gloss : 0,
        raw: {
          format: "rasterlink_print",
          uploadFileName,
          result,
          resultDetail: detail,
          arrangeCnt,
          arrangeAssumed: arrangeCnt == null,
          perItem: estimated ? { cyanCc: ink.cyanCc, magentaCc: ink.magentaCc, yellowCc: ink.yellowCc, blackCc: ink.blackCc, whiteCc: ink.whiteCc, clearCc: ink.clearCc, totalCc: ink.perItemTotalCc } : null,
          inkBasis: estimated ? INK_BASIS_ESTIMATE : INK_BASIS_MISSING,
          ripStart: ripStart?.toISOString() || null,
          ripEnd: ripEnd?.toISOString() || null,
          ripMinutes: minutesBetween(ripStart, ripEnd),
          timingBasis: printStart && printEnd ? "print_times" : ripStart || ripEnd ? "rip_only_no_print_times" : "no_times",
        },
      });
    }

    if (hasCutSide) {
      const start = cutStart || vecStart;
      const end = cutEnd || vecEnd;
      entries.push({
        kind: "cut",
        fileName,
        jobTicket,
        status: `cut:${result || "unknown"}`,
        startedAt: start,
        completedAt: end,
        printMinutes: 0, // cut time is NOT print time; stored in raw until schema adds cut fields
        inkMl: 0,
        cmykInkMl: 0,
        whiteInkMl: 0,
        glossInkMl: 0,
        raw: {
          format: "rasterlink_cut",
          uploadFileName,
          result,
          resultDetail: detail,
          arrangeCnt,
          inkBasis: INK_BASIS_CUT,
          vecStart: vecStart?.toISOString() || null,
          vecEnd: vecEnd?.toISOString() || null,
          cutStart: cutStart?.toISOString() || null,
          cutEnd: cutEnd?.toISOString() || null,
          cutMinutes: minutesBetween(cutStart, cutEnd),
          vecMinutes: minutesBetween(vecStart, vecEnd),
        },
      });
    }
  }
  return entries;
}

// ---------- deduplication + matching helpers (pure, unit-tested) ----------

export function fileHashOf(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function fileHashMarker(text: string): string {
  return `sha256:${fileHashOf(text)}`;
}

// Forensic row key stored INSIDE rawRow (display/debug only — never queried;
// the queryable dedupe uses rowDedupeWhere below on real columns).
export function resultKeyOf(entry: RasterlinkEntry): string {
  const stamp = (date: Date | null) => (date ? date.toISOString() : "");
  return crypto.createHash("sha256")
    .update([RASTERLINK_SOURCE, entry.kind, entry.fileName, entry.status, stamp(entry.startedAt), stamp(entry.completedAt), String(entry.inkMl)].join("|"), "utf8")
    .digest("hex")
    .slice(0, 24);
}

// Natural-key WHERE clause for row-level duplicate detection on plain,
// reliably queryable columns (sourceJobName is indexed; the print/cut kind
// lives inside status). When both timestamps are null, inkMl joins the key so
// distinct blank-time rows with different ink are not conflated.
export function rowDedupeWhere(shop: string, entry: RasterlinkEntry): Record<string, unknown> {
  const where: Record<string, unknown> = {
    shop,
    printerSoftware: RASTERLINK_SOURCE,
    sourceJobName: entry.fileName,
    status: entry.status,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
  if (!entry.startedAt && !entry.completedAt) where.inkMl = entry.inkMl;
  return where;
}

// Count of rows that imported with a caveat flag (missing ink, assumed
// arrange count, or RIP-only timing) — surfaced in the upload response and
// import notes so the watcher/audit trail can see parse quality per file.
export function parseWarningCount(entries: RasterlinkEntry[]): number {
  return entries.filter((entry) =>
    entry.raw.inkBasis === INK_BASIS_MISSING ||
    entry.raw.arrangeAssumed === true ||
    entry.raw.timingBasis === "rip_only_no_print_times",
  ).length;
}

// Conservative production-job matching: attach ONLY on exactly one match.
// Zero -> unmatched. Two or more -> unmatched + flagged for manual review;
// never silently pick the first.
export function decideMatch(matches: Array<{ id: string }>): { productionJobId: string | null; ambiguous: boolean } {
  if (matches.length === 1) return { productionJobId: matches[0].id, ambiguous: false };
  return { productionJobId: null, ambiguous: matches.length > 1 };
}
