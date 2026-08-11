import db from "../db.server";
import { resolveRipIdentity } from "./rip-identity-match.server";
import {
  extractMimakiExtended,
  isVersaWorksJobLogRow,
  parseVersaWorksRow,
  runtimeQualityFlags,
  sourceRecordFingerprint,
  RIP_CAPTURE_VERSION,
} from "./rip-capture.server";

export const printLogSourceOptions = [
  { label: "VersaWorks CSV/XML", value: "versaworks" },
  { label: "RasterLink CSV/TXT", value: "rasterlink" },
  { label: "Manual CSV/TSV", value: "manual_csv" },
  { label: "Auto Watch Folder", value: "auto_watch_folder" },
  { label: "Other print log", value: "other" },
];

const columnAliases: Record<string, string[]> = {
  jobName: ["job", "job name", "jobname", "name", "file", "file name", "filename", "print job", "title"],
  machineName: ["machine", "printer", "device", "output device"],
  mediaName: ["media", "material", "profile", "media name"],
  status: ["status", "result", "state"],
  sqft: ["sqft", "sq ft", "square feet", "area", "print area", "printed area", "ft2", "sq.ft"],
  inkMl: ["ink", "ink ml", "total ink", "total ink ml", "ink consumption", "consumption", "total ml", "ml"],
  cmykInkMl: ["cmyk", "process ink", "cmyk ml", "color ink", "color ml"],
  whiteInkMl: ["white", "white ml", "wh ml"],
  glossInkMl: ["gloss", "gloss ml", "clear", "clear ml", "varnish", "varnish ml"],
  printMinutes: ["minutes", "print minutes", "print time", "time", "duration", "elapsed", "elapsed time"],
  startedAt: ["start", "started", "start time", "start date", "date"],
  completedAt: ["end", "ended", "completed", "complete time", "end time", "finish", "finish time"],
};

export function normalizePrintLogValue(value: any) {
  return String(value || "").trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
}

export function numberFromPrintLog(value: any) {
  const cleaned = String(value || "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : 0;
}

function dateFrom(value: any) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function minutesFrom(value: any) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const hhmmss = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (hhmmss) {
    const hours = Number(hhmmss[1]) || 0;
    const minutes = Number(hhmmss[2]) || 0;
    const seconds = Number(hhmmss[3]) || 0;
    return hours * 60 + minutes + seconds / 60;
  }

  if (/hour|hr/i.test(text)) return numberFromPrintLog(text) * 60;
  return numberFromPrintLog(text);
}

function chooseDelimiter(line: string) {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

function splitCsvLine(line: string, delimiter: string) {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function extractXmlJobs(text: string) {
  const jobs: Record<string, string>[] = [];
  const blocks = text.match(/<job[\s\S]*?<\/job>/gi) || text.match(/<Job[\s\S]*?<\/Job>/g) || [];

  for (const block of blocks) {
    const row: Record<string, string> = {};
    const tags = [...block.matchAll(/<([A-Za-z0-9_\-]+)[^>]*>([\s\S]*?)<\/\1>/g)];
    for (const tag of tags) {
      const key = tag[1];
      const value = tag[2].replace(/<[^>]+>/g, "").trim();
      if (key && value) row[key] = value;
    }
    if (Object.keys(row).length) jobs.push(row);
  }

  return jobs;
}

function parseDelimited(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = chooseDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || "";
    });
    rows.push(row);
  }

  return rows;
}

function findField(row: Record<string, string>, field: keyof typeof columnAliases) {
  const entries = Object.entries(row);
  const aliases = columnAliases[field].map(normalizePrintLogValue);
  for (const [key, value] of entries) {
    if (aliases.includes(normalizePrintLogValue(key))) return value;
  }
  return "";
}

export function extractJobTicket(text: string) {
  const match = String(text || "").match(/GSO-[A-Z0-9][A-Z0-9\-]{5,}/i);
  return match ? match[0].toUpperCase() : "";
}

export function extractItemTicket(text: string) {
  const match = String(text || "").match(/GSO-\d{8}-\d{4}-\d{2}/i);
  return match ? match[0].toUpperCase() : "";
}

export function parsePrintLogText(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  const rawRows = /<\/?[A-Za-z][\s\S]*>/.test(trimmed) ? extractXmlJobs(trimmed) : parseDelimited(trimmed);

  return rawRows.map((row, index) => {
    // 15F.0J.4: VersaWorks job-log rows (Roland) get the dedicated parser —
    // colon ink arrays mapped BY NAME, mm dims, per-stage events, quality
    // flags, and a source-record fingerprint. Raw source preserved verbatim.
    if (isVersaWorksJobLogRow(row)) {
      const parsed = parseVersaWorksRow(row);
      const quality = runtimeQualityFlags(parsed);
      const fingerprint = sourceRecordFingerprint(parsed);
      const extended = {
        captureVersion: RIP_CAPTURE_VERSION,
        sourceRecordFingerprint: fingerprint,
        event: parsed.event,
        eventClass: parsed.eventClass,
        normalizedJobName: parsed.normalizedJobName,
        profile: parsed.profile,
        copies: parsed.copies,
        pageWidthIn: parsed.pageWidthIn,
        pageFeedIn: parsed.pageFeedIn,
        outputWidthIn: parsed.outputWidthIn,
        outputFeedIn: parsed.outputFeedIn,
        layoutSqft: parsed.layoutSqft,
        ripSeconds: parsed.ripSeconds,
        printSeconds: parsed.printSeconds,
        inkByChannel: parsed.inkByChannel,
        channelNames: parsed.channelNames,
        otherMl: parsed.otherMl,
        unknownChannels: parsed.unknownChannels,
        inkArrayMismatch: parsed.inkArrayMismatch,
        qualityFlags: quality.flags,
        calibrationEligible: quality.calibrationEligible,
        actualCostEligible: quality.actualCostEligible,
        exclusionReason: quality.exclusionReason,
      };
      return {
        rowNumber: index + 1,
        itemTicket: parsed.itemTicket,
        jobTicket: parsed.jobTicket || parsed.itemTicket,
        sourceJobName: parsed.jobName,
        machineName: parsed.printer,
        mediaName: parsed.profile,
        status: parsed.event,
        sqft: parsed.layoutSqft,
        inkMl: parsed.totalMl,
        cmykInkMl: parsed.cmykMl,
        whiteInkMl: parsed.whiteMl,
        glossInkMl: parsed.glossMl,
        printMinutes: parsed.printSeconds != null ? parsed.printSeconds / 60 : 0,
        startedAt: parsed.printStart,
        completedAt: parsed.printEnd,
        sourceFingerprint: fingerprint,
        eventClass: parsed.eventClass,
        rawRow: JSON.stringify({ ...row, _gso: extended }),
      };
    }
    const rowText = JSON.stringify(row);
    const sourceJobName = findField(row, "jobName") || rowText.slice(0, 140);
    const itemTicket = extractItemTicket(sourceJobName) || extractItemTicket(rowText);
    const jobTicket = itemTicket || extractJobTicket(sourceJobName) || extractJobTicket(rowText);
    const inkMl = numberFromPrintLog(findField(row, "inkMl"));
    const cmykInkMl = numberFromPrintLog(findField(row, "cmykInkMl"));
    let whiteInkMl = numberFromPrintLog(findField(row, "whiteInkMl"));
    let glossInkMl = numberFromPrintLog(findField(row, "glossInkMl"));
    // 15F.0J.4-F: widened Mimaki fields (resolution/passes/copies/output dims/
    // cut+spool times/dual white+clear channels) captured WHEN the converter
    // provides them; dual channels sum into the normalized totals. Old CSVs
    // without these columns parse byte-identically.
    const mimakiExtended = extractMimakiExtended(row);
    if (mimakiExtended) {
      if (typeof mimakiExtended.whiteSummedMl === "number" && mimakiExtended.whiteSummedMl > 0 && !whiteInkMl) whiteInkMl = mimakiExtended.whiteSummedMl;
      if (typeof mimakiExtended.clearSummedMl === "number" && mimakiExtended.clearSummedMl > 0 && !glossInkMl) glossInkMl = mimakiExtended.clearSummedMl;
    }

    return {
      rowNumber: index + 1,
      itemTicket,
      jobTicket,
      sourceJobName,
      machineName: findField(row, "machineName"),
      mediaName: findField(row, "mediaName"),
      status: findField(row, "status"),
      sqft: numberFromPrintLog(findField(row, "sqft")),
      inkMl: inkMl || cmykInkMl + whiteInkMl + glossInkMl,
      cmykInkMl,
      whiteInkMl,
      glossInkMl,
      printMinutes: minutesFrom(findField(row, "printMinutes")),
      startedAt: dateFrom(findField(row, "startedAt")),
      completedAt: dateFrom(findField(row, "completedAt")),
      sourceFingerprint: null as string | null,
      eventClass: null as string | null,
      rawRow: mimakiExtended ? JSON.stringify({ ...row, _gso: { captureVersion: RIP_CAPTURE_VERSION, ...mimakiExtended } }) : rowText,
    };
  });
}

// 15H.2: automatic linking goes through the ONE strict shared resolver.
// The old ladder's contains/substring/first-match tiers (which mislabeled
// themselves as exact and probable-metadata matches) are
// REMOVED from automatic linking entirely — suggestion territory belongs to
// the RIP Import Review page, which requires an explicit operator click.
// Method values are the shared confidence names; AMBIGUOUS never attaches.
export async function findMatchingProductionJob(
  shop: string,
  row: any,
): Promise<{ job: any; item: any; method: string; reasons: string[]; ambiguous: boolean }> {
  const identity = await resolveRipIdentity(db, shop, {
    jobName: row.sourceJobName || "",
    // Pre-parsed row tickets (XML/VersaWorks job-log parsers) ride along so a
    // canonical ticket carried outside the name still resolves exactly.
    fileName: [row.itemTicket, row.jobTicket].filter(Boolean).join(" "),
  });
  if (identity.status !== "matched" || !identity.productionJobId) {
    return {
      job: null,
      item: null,
      method: identity.status === "ambiguous" ? "AMBIGUOUS" : "UNMATCHED",
      reasons: identity.reasons,
      ambiguous: identity.status === "ambiguous",
    };
  }
  const job = await db.productionJob.findFirst({ where: { shop, id: identity.productionJobId } });
  const item = identity.productionJobItemId
    ? await db.productionJobItem.findFirst({ where: { shop, id: identity.productionJobItemId } })
    : null;
  if (!job) return { job: null, item: null, method: "UNMATCHED", reasons: [...identity.reasons, "matched_job_not_found"], ambiguous: false };
  return { job, item, method: identity.confidence, reasons: identity.reasons, ambiguous: false };
}

export async function createProductionEvent(shop: string, jobId: string, eventType: string, message: string, data?: { oldValue?: string; newValue?: string }) {
  return db.productionJobEvent.create({
    data: {
      shop,
      jobId,
      eventType,
      message,
      oldValue: data?.oldValue || null,
      newValue: data?.newValue || null,
    },
  });
}

export async function importPrintLogText({
  shop,
  source,
  fileName,
  rawText,
  notes,
  importedBy,
}: {
  shop: string;
  source: string;
  fileName?: string | null;
  rawText: string;
  notes?: string | null;
  importedBy?: string | null;
}) {
  const rows = parsePrintLogText(rawText);
  let matchedCount = 0;
  let unmatchedCount = 0;
  let skippedDuplicates = 0;
  let totalSqft = 0;
  let totalInkMl = 0;
  let totalPrintMinutes = 0;

  const createdImport = await db.printLogImport.create({
    data: {
      shop,
      source,
      fileName: fileName || null,
      importedBy: importedBy || null,
      rawText: rawText.slice(0, 50000),
      rowCount: rows.length,
      matchedCount: 0,
      unmatchedCount: rows.length,
      notes: notes || null,
    },
  });

  for (const row of rows) {
    // 15F.0J.4-D: incremental dedupe on the SOURCE-RECORD identity (indexed
    // fields sourceJobName + start/end + machine), never row position — a
    // cumulative/regenerated export imports only genuinely new events.
    if (row.sourceJobName && (row.startedAt || row.completedAt)) {
      const existing = await db.printLogEntry.findFirst({
        where: {
          shop,
          sourceJobName: row.sourceJobName,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          machineName: row.machineName || null,
          status: row.status || null,
        },
        select: { id: true },
      });
      if (existing) {
        skippedDuplicates += 1;
        continue;
      }
    }
    // Canceled/error events are retained for audit but never matched as
    // production actuals (no job link, no production event).
    const isCanceledOrError = row.eventClass === "canceled" || row.eventClass === "error";
    const match = isCanceledOrError
      ? { job: null, item: null, method: "UNMATCHED", reasons: ["canceled_or_error_event"], ambiguous: false }
      : await findMatchingProductionJob(shop, row);
    const matchedJob = match.job;
    const matchedItem = match.item;
    const matchedJobId = matchedJob?.id || null;
    const matchedItemId = matchedItem?.id || null;
    if (matchedJobId) matchedCount += 1;
    else unmatchedCount += 1;

    totalSqft += Number(row.sqft || 0);
    totalInkMl += Number(row.inkMl || 0);
    totalPrintMinutes += Number(row.printMinutes || 0);

    // 15H.2: record method + structured reasons inside the immutable raw
    // payload; ambiguous rows carry the shared top-level matchFlag so the
    // review page classifies them and the writeback belt-and-braces blocks.
    let rawRowOut = row.rawRow || null;
    if (rawRowOut) {
      try {
        const parsedRaw = JSON.parse(rawRowOut);
        parsedRaw._gso = { ...(parsedRaw._gso || {}), matchMethod: match.method, matchReasons: match.reasons };
        if (match.ambiguous) parsedRaw.matchFlag = "ambiguous_ticket_needs_review";
        rawRowOut = JSON.stringify(parsedRaw);
      } catch {
        // non-JSON raw rows stay verbatim
      }
    }

    await db.printLogEntry.create({
      data: {
        shop,
        importId: createdImport.id,
        productionJobId: matchedJobId,
        productionJobItemId: matchedItemId,
        jobTicket: row.jobTicket || row.itemTicket || null,
        sourceJobName: row.sourceJobName || null,
        printerSoftware: source,
        machineName: row.machineName || null,
        mediaName: row.mediaName || null,
        status: row.status || null,
        sqft: row.sqft || 0,
        inkMl: row.inkMl || 0,
        cmykInkMl: row.cmykInkMl || 0,
        whiteInkMl: row.whiteInkMl || 0,
        glossInkMl: row.glossInkMl || 0,
        printMinutes: row.printMinutes || 0,
        startedAt: row.startedAt || null,
        completedAt: row.completedAt || null,
        rawRow: rawRowOut,
      },
    });

    if (matchedJobId) {
      await createProductionEvent(
        shop,
        matchedJobId,
        importedBy === "auto_import_endpoint" ? "print_log_auto_imported" : "print_log_imported",
        `${source} print log matched. Ticket: ${row.itemTicket || row.jobTicket || row.sourceJobName}. ${matchedItem ? `Item: ${matchedItem.productTitle}. ` : ""}Sqft: ${row.sqft || 0}. Ink: ${row.inkMl || 0} ml. Print time: ${(row.printMinutes || 0).toFixed(2)} min.`
      );
    }
  }

  await db.printLogImport.update({
    where: { id: createdImport.id },
    data: {
      matchedCount,
      unmatchedCount: Math.max(0, unmatchedCount),
      totalSqft,
      totalInkMl,
      totalPrintMinutes,
      notes: skippedDuplicates ? `${notes ? `${notes} | ` : ""}${skippedDuplicates} duplicate source record(s) skipped (15F.0J.4 fingerprint dedupe).` : notes || null,
    },
  });

  return {
    importId: createdImport.id,
    rowCount: rows.length,
    matchedCount,
    unmatchedCount,
    skippedDuplicates,
    totalSqft,
    totalInkMl,
    totalPrintMinutes,
  };
}
