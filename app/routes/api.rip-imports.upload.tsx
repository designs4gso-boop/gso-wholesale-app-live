import db from "../db.server";
import {
  RASTERLINK_SOURCE,
  decideMatch,
  fileHashMarker,
  looksLikeRasterlinkCsv,
  parseRasterlinkRows,
  parseWarningCount,
  resultKeyOf,
  rowDedupeWhere,
} from "../lib/rasterlink-parse.server";
import {
  VERSAWORKS_SOURCE,
  buildVersaworksRawRow,
  decideVersaworksMatch,
  looksLikeVersaworksCsv,
  parseVersaworksRows,
  ripNameJobIdsFor,
  versaworksParseWarningCount,
  versaworksRowDedupeWhere,
} from "../lib/versaworks-parse.server";
import {
  buildJobInfoEnrichment,
  decideJobInfoPairing,
  jobInfoFallbackEnabled,
  parseJobInfoIni,
} from "../lib/jobinfo-fallback.server";

function textResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { field += '"'; i += 1; } else quoted = !quoted;
    } else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cleanText(cell))) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((cell) => cleanText(cell))) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(cleanText);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, index) => { obj[header] = cleanText(cells[index]); });
    return obj;
  });
}

function extractTicket(jobName: string, fileName = "") {
  const match = `${jobName} ${fileName}`.match(/\bGSO[-_ ]?(?:TEST[-_ ]?)?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\b/i);
  return match ? match[0].replace(/_/g, "-").replace(/\s+/g, "-").toUpperCase() : "";
}

function parseDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const d = new Date(raw.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function inkSplit(row: Record<string, string>) {
  const values = cleanText(row["Ink Consumption[ml]"]).split(":").map(parseNumber);
  const names = cleanText(row["Ink Name"]).split(":").map((name) => name.toLowerCase());
  let cmykInkMl = 0, whiteInkMl = 0, glossInkMl = 0;
  values.forEach((ml, index) => {
    const name = names[index] || "";
    if (name.includes("white")) whiteInkMl += ml;
    else if (name.includes("gloss") || name.includes("clear") || name.includes("primer")) glossInkMl += ml;
    else cmykInkMl += ml;
  });
  return { inkMl: values.reduce((sum, value) => sum + value, 0), cmykInkMl, whiteInkMl, glossInkMl };
}

function parseRows(text: string, fileName: string, source: string) {
  if (!fileName.toLowerCase().endsWith(".csv")) {
    return [{ event: `${source} file`, machineName: source, jobName: fileName, mediaName: "", sqft: 0, ...{ inkMl: 0, cmykInkMl: 0, whiteInkMl: 0, glossInkMl: 0 }, jobTicket: extractTicket(fileName, fileName), raw: { fileName } }];
  }
  return parseCsv(text).map((row) => {
    const x = parseNumber(row["Print Area_X[mm]"]);
    const y = parseNumber(row["Print Area_Y[mm]"]);
    return {
      event: cleanText(row.Event),
      machineName: cleanText(row["Nick Name"]),
      jobName: cleanText(row["Job Name"]),
      mediaName: cleanText(row["Media Name"]),
      sqft: x > 0 && y > 0 ? (x / 25.4) * (y / 25.4) / 144 : 0,
      ...inkSplit(row),
      jobTicket: extractTicket(cleanText(row["Job Name"]), fileName),
      startedAt: parseDate(row["Print Start Time"] || row["RIP Start Time"]),
      completedAt: parseDate(row["Print End Time"] || row["RIP End Time"]),
      raw: row,
    };
  });
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const token = cleanText(form.get("token") || request.headers.get("x-gso-rip-token"));
  if (!token) return textResponse({ ok: false, error: "Missing upload token." }, 401);
  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken: token } });
  if (!setting || !setting.enabled) return textResponse({ ok: false, error: "Invalid or disabled upload token." }, 403);
  const file = form.get("file");
  if (!(file instanceof File)) return textResponse({ ok: false, error: "Missing file field." }, 400);
  const source = cleanText(form.get("source") || "auto");
  const rawText = await file.text();

  // 13A.6E: RasterLink JobInfo.ini companion uploads. FEATURE-FLAGGED OFF by
  // default (GSO_ENABLE_JOBINFO_FALLBACK=1) pending live validation with a
  // real shop sample. When enabled, the ONLY possible write is filling the ink
  // columns + rawRow provenance of exactly one blank-KEY_INKUSE RasterLink row
  // paired by exact normalized name — valid CSV ink is never overridden, and
  // blank-time rows are refused to protect the dedupe natural key. When
  // disabled, .ini uploads are rejected cleanly (previously they would have
  // created a junk placeholder row via the legacy non-CSV path).
  if (file.name.toLowerCase().endsWith(".ini")) {
    if (!jobInfoFallbackEnabled()) {
      return textResponse({ ok: false, jobInfo: true, error: "JobInfo fallback is disabled. Set GSO_ENABLE_JOBINFO_FALLBACK=1 only after live validation with a real JobInfo.ini sample (see project state doc)." }, 400);
    }
    const record = parseJobInfoIni(rawText, cleanText(form.get("jobFolder")) || file.name);
    const candidateRows = await db.printLogEntry.findMany({
      where: { shop: setting.shop, printerSoftware: RASTERLINK_SOURCE, sourceJobName: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: { id: true, sourceJobName: true, startedAt: true, completedAt: true, rawRow: true },
    });
    const pairing = decideJobInfoPairing(record, candidateRows);
    if (pairing.outcome !== "paired" || !pairing.row) {
      return textResponse({
        ok: true, jobInfo: true, outcome: pairing.outcome, sourceId: record.sourceId, jobName: record.jobName,
        candidateRowIds: pairing.candidateRowIds, ineligible: pairing.ineligible, warnings: record.warnings, updated: 0,
      });
    }
    const enrichment = buildJobInfoEnrichment(pairing.row, record);
    if (!enrichment.ok) {
      return textResponse({ ok: true, jobInfo: true, outcome: "rejected", reason: enrichment.reason, sourceId: record.sourceId, updated: 0 });
    }
    await db.printLogEntry.update({ where: { id: pairing.row.id }, data: enrichment.update });
    return textResponse({
      ok: true, jobInfo: true, outcome: "applied", sourceId: record.sourceId, jobName: record.jobName,
      updatedEntryId: pairing.row.id, inkBasis: enrichment.inkBasis, estimatedTotalCc: enrichment.estimatedTotalCc, updated: 1,
    });
  }

  // 13A.6A: RasterLink result CSVs (KEY_* headers) take a dedicated branch
  // with file- and row-level duplicate protection and conservative matching.
  // The existing VersaWorks path below is untouched.
  if (looksLikeRasterlinkCsv(rawText)) {
    const marker = fileHashMarker(rawText);
    // Only fully processed imports block a re-upload: a crashed partial
    // import (status "processing") may be retried, and the row-level dedupe
    // below makes that retry idempotent.
    const duplicateFile = await db.printLogImport.findFirst({
      where: { shop: setting.shop, source: RASTERLINK_SOURCE, fileName: file.name, status: "processed", notes: { startsWith: marker } },
    });
    if (duplicateFile) {
      return textResponse({ ok: true, format: RASTERLINK_SOURCE, duplicateFile: true, fileName: file.name, importId: duplicateFile.id, message: "File already imported (same name + content hash); nothing written." });
    }

    const entries = parseRasterlinkRows(rawText, file.name);
    const importRecord = await db.printLogImport.create({
      data: {
        shop: setting.shop,
        source: RASTERLINK_SOURCE,
        fileName: file.name,
        rawText: rawText.slice(0, 250000),
        rowCount: entries.length,
        totalInkMl: entries.reduce((sum, entry) => sum + entry.inkMl, 0),
        totalPrintMinutes: entries.reduce((sum, entry) => sum + entry.printMinutes, 0),
        status: "processing",
        notes: marker,
      },
    });

    let created = 0;
    let skippedDuplicates = 0;
    let matchedCount = 0;
    let ambiguousCount = 0;

    for (const entry of entries) {
      const existing = await db.printLogEntry.findFirst({ where: rowDedupeWhere(setting.shop, entry) as any });
      if (existing) { skippedDuplicates += 1; continue; }

      let productionJobId: string | undefined;
      let matchFlag: string | null = null;
      if (entry.jobTicket) {
        const jobs = await db.productionJob.findMany({ where: { shop: setting.shop, jobTicket: entry.jobTicket }, select: { id: true }, take: 2 });
        const decision = decideMatch(jobs);
        if (decision.productionJobId) { productionJobId = decision.productionJobId; matchedCount += 1; }
        else if (decision.ambiguous) { ambiguousCount += 1; matchFlag = "ambiguous_ticket_needs_review"; }
      }

      await db.printLogEntry.create({
        data: {
          shop: setting.shop,
          importId: importRecord.id,
          productionJobId,
          jobTicket: entry.jobTicket || null,
          sourceJobName: entry.fileName,
          printerSoftware: RASTERLINK_SOURCE,
          machineName: "",
          mediaName: "",
          status: entry.status,
          sqft: 0,
          inkMl: entry.inkMl,
          cmykInkMl: entry.cmykInkMl,
          whiteInkMl: entry.whiteInkMl,
          glossInkMl: entry.glossInkMl,
          printMinutes: entry.printMinutes,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          rawRow: JSON.stringify({ ...entry.raw, resultKey: resultKeyOf(entry), ...(matchFlag ? { matchFlag } : {}) }).slice(0, 12000),
        },
      });
      created += 1;
    }

    const parseWarnings = parseWarningCount(entries);
    await db.printLogImport.update({
      where: { id: importRecord.id },
      data: {
        matchedCount,
        unmatchedCount: Math.max(0, created - matchedCount),
        status: "processed",
        notes: `${marker}\nrows:${entries.length} created:${created} duplicatesSkipped:${skippedDuplicates} matched:${matchedCount} ambiguous:${ambiguousCount} parseWarnings:${parseWarnings} outcome:processed`,
      },
    });
    await db.printLogAutoImportSetting.update({ where: { id: setting.id }, data: { lastAutoImportAt: new Date() } });

    return textResponse({
      ok: true,
      format: RASTERLINK_SOURCE,
      fileName: file.name,
      fileHash: marker,
      rows: entries.length,
      created,
      skippedDuplicates,
      matched: matchedCount,
      ambiguous: ambiguousCount,
      unmatched: Math.max(0, created - matchedCount),
      parseWarnings,
      outcome: "processed",
    });
  }

  // 13A.6D: VersaWorks job-history CSVs take a hardened branch with the same
  // safety layers as RasterLink: sha256 file dedupe, natural-key row dedupe,
  // conservative exact-only matching (never first-match-wins, never bare
  // contains), and transparent matchMeta in rawRow that the 13A.6C review
  // page classifies via the shared top-level matchFlag. Files that do not
  // sniff as VersaWorks (non-CSV placeholder uploads, unknown CSV shapes)
  // continue through the legacy path below, byte-identical.
  if (file.name.toLowerCase().endsWith(".csv") && looksLikeVersaworksCsv(rawText)) {
    const marker = fileHashMarker(rawText);
    // Same rule as RasterLink: only fully processed imports block a re-upload,
    // so a crashed partial import may retry and row dedupe keeps it idempotent.
    const duplicateFile = await db.printLogImport.findFirst({
      where: { shop: setting.shop, source: VERSAWORKS_SOURCE, fileName: file.name, status: "processed", notes: { startsWith: marker } },
    });
    if (duplicateFile) {
      return textResponse({ ok: true, format: VERSAWORKS_SOURCE, duplicateFile: true, fileName: file.name, importId: duplicateFile.id, message: "File already imported (same name + content hash); nothing written." });
    }

    const entries = parseVersaworksRows(rawText, file.name);
    const importRecord = await db.printLogImport.create({
      data: {
        shop: setting.shop,
        source: VERSAWORKS_SOURCE,
        fileName: file.name,
        rawText: rawText.slice(0, 250000),
        rowCount: entries.length,
        totalSqft: entries.reduce((sum, entry) => sum + entry.sqft, 0),
        totalInkMl: entries.reduce((sum, entry) => sum + entry.inkMl, 0),
        status: "processing",
        notes: marker,
      },
    });

    // One bounded ripJobName index per file for the exact second-stage key.
    const ripItems = await db.productionJobItem.findMany({
      where: { shop: setting.shop, ripJobName: { not: null } },
      select: { jobId: true, ripJobName: true },
      take: 300,
    });

    let created = 0;
    let skippedDuplicates = 0;
    let matchedCount = 0;
    let ambiguousCount = 0;

    for (const entry of entries) {
      const existing = await db.printLogEntry.findFirst({ where: versaworksRowDedupeWhere(setting.shop, entry) as any });
      if (existing) { skippedDuplicates += 1; continue; }

      const ticketCandidates = entry.jobTicket
        ? await db.productionJob.findMany({ where: { shop: setting.shop, jobTicket: entry.jobTicket }, select: { id: true }, take: 5 })
        : [];
      const decision = decideVersaworksMatch({
        ticketCandidates,
        ripNameJobIds: ticketCandidates.length ? [] : ripNameJobIdsFor(entry.jobName, ripItems),
      });
      if (decision.productionJobId) matchedCount += 1;
      if (decision.matchFlag) ambiguousCount += 1;

      await db.printLogEntry.create({
        data: {
          shop: setting.shop,
          importId: importRecord.id,
          productionJobId: decision.productionJobId || undefined,
          jobTicket: entry.jobTicket || null,
          sourceJobName: entry.jobName,
          printerSoftware: VERSAWORKS_SOURCE,
          machineName: entry.machineName,
          mediaName: entry.mediaName,
          status: entry.event,
          sqft: entry.sqft,
          inkMl: entry.inkMl,
          cmykInkMl: entry.cmykInkMl,
          whiteInkMl: entry.whiteInkMl,
          glossInkMl: entry.glossInkMl,
          printMinutes: 0,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          rawRow: JSON.stringify(buildVersaworksRawRow(entry, decision)).slice(0, 12000),
        },
      });
      created += 1;
    }

    const versaworksWarnings = versaworksParseWarningCount(entries);
    await db.printLogImport.update({
      where: { id: importRecord.id },
      data: {
        matchedCount,
        unmatchedCount: Math.max(0, created - matchedCount),
        status: "processed",
        notes: `${marker}\nrows:${entries.length} created:${created} duplicatesSkipped:${skippedDuplicates} matched:${matchedCount} ambiguous:${ambiguousCount} parseWarnings:${versaworksWarnings} outcome:processed`,
      },
    });
    await db.printLogAutoImportSetting.update({ where: { id: setting.id }, data: { lastAutoImportAt: new Date() } });

    return textResponse({
      ok: true,
      format: VERSAWORKS_SOURCE,
      fileName: file.name,
      fileHash: marker,
      rows: entries.length,
      created,
      skippedDuplicates,
      matched: matchedCount,
      ambiguous: ambiguousCount,
      unmatched: Math.max(0, created - matchedCount),
      parseWarnings: versaworksWarnings,
      outcome: "processed",
    });
  }

  const rows = parseRows(rawText, file.name, source);
  let matchedCount = 0;
  const importRecord = await db.printLogImport.create({ data: { shop: setting.shop, source, fileName: file.name, rawText: rawText.slice(0, 250000), rowCount: rows.length, totalSqft: rows.reduce((s, r) => s + r.sqft, 0), totalInkMl: rows.reduce((s, r) => s + r.inkMl, 0), status: "auto_imported" } });
  for (const row of rows) {
    let productionJobId: string | undefined;
    if (row.jobTicket) {
      const job = await db.productionJob.findFirst({ where: { shop: setting.shop, jobTicket: row.jobTicket } });
      if (job) { productionJobId = job.id; matchedCount += 1; }
    }
    await db.printLogEntry.create({ data: { shop: setting.shop, importId: importRecord.id, productionJobId, jobTicket: row.jobTicket || null, sourceJobName: row.jobName, printerSoftware: source, machineName: row.machineName, mediaName: row.mediaName, status: row.event, sqft: row.sqft, inkMl: row.inkMl, cmykInkMl: row.cmykInkMl, whiteInkMl: row.whiteInkMl, glossInkMl: row.glossInkMl, startedAt: row.startedAt || null, completedAt: row.completedAt || null, rawRow: JSON.stringify(row.raw).slice(0, 12000) } });
  }
  await db.printLogImport.update({ where: { id: importRecord.id }, data: { matchedCount, unmatchedCount: Math.max(0, rows.length - matchedCount), status: "processed" } });
  await db.printLogAutoImportSetting.update({ where: { id: setting.id }, data: { lastAutoImportAt: new Date() } });
  return textResponse({ ok: true, fileName: file.name, rows: rows.length, matched: matchedCount, unmatched: Math.max(0, rows.length - matchedCount) });
}

export const loader = () => textResponse({ ok: true, endpoint: "POST multipart file + token to upload RIP logs." });
