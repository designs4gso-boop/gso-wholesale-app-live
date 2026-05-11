import db from "../db.server";

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
    const rowText = JSON.stringify(row);
    const sourceJobName = findField(row, "jobName") || rowText.slice(0, 140);
    const itemTicket = extractItemTicket(sourceJobName) || extractItemTicket(rowText);
    const jobTicket = itemTicket || extractJobTicket(sourceJobName) || extractJobTicket(rowText);
    const inkMl = numberFromPrintLog(findField(row, "inkMl"));
    const cmykInkMl = numberFromPrintLog(findField(row, "cmykInkMl"));
    const whiteInkMl = numberFromPrintLog(findField(row, "whiteInkMl"));
    const glossInkMl = numberFromPrintLog(findField(row, "glossInkMl"));

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
      rawRow: rowText,
    };
  });
}

export async function findMatchingProductionJob(shop: string, row: any) {
  const ticket = row.jobTicket;
  const itemTicket = row.itemTicket || ticket;
  const sourceJobName = row.sourceJobName || "";

  if (itemTicket) {
    const exactItem = await db.productionJobItem.findFirst({
      where: { shop, OR: [{ itemTicket }, { ripJobName: itemTicket }] },
      include: { job: true },
    });
    if (exactItem?.job) return { job: exactItem.job, item: exactItem };
  }

  if (ticket) {
    const exact = await db.productionJob.findFirst({ where: { shop, jobTicket: ticket } });
    if (exact) return { job: exact, item: null };

    const itemContains = await db.productionJobItem.findFirst({
      where: {
        shop,
        OR: [
          { itemTicket: { contains: ticket } },
          { ripJobName: { contains: ticket } },
        ],
      },
      include: { job: true },
    });
    if (itemContains?.job) return { job: itemContains.job, item: itemContains };

    const contains = await db.productionJob.findFirst({ where: { shop, jobTicket: { contains: ticket } } });
    if (contains) return { job: contains, item: null };
  }

  const jobs = await db.productionJob.findMany({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { items: true },
  });

  for (const job of jobs as any[]) {
    const matchedItem = (job.items || []).find((item: any) => {
      if (item.itemTicket && sourceJobName.includes(item.itemTicket)) return true;
      if (item.ripJobName && sourceJobName.includes(item.ripJobName)) return true;
      return false;
    });
    if (matchedItem) return { job, item: matchedItem };
    if (job.jobTicket && sourceJobName.includes(job.jobTicket)) return { job, item: null };
    if (job.id && sourceJobName.includes(job.id)) return { job, item: null };
  }

  return { job: null, item: null };
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
    const match = await findMatchingProductionJob(shop, row);
    const matchedJob = match.job;
    const matchedItem = match.item;
    const matchedJobId = matchedJob?.id || null;
    const matchedItemId = matchedItem?.id || null;
    if (matchedJobId) matchedCount += 1;
    else unmatchedCount += 1;

    totalSqft += Number(row.sqft || 0);
    totalInkMl += Number(row.inkMl || 0);
    totalPrintMinutes += Number(row.printMinutes || 0);

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
        rawRow: row.rawRow || null,
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
      unmatchedCount,
      totalSqft,
      totalInkMl,
      totalPrintMinutes,
    },
  });

  return {
    importId: createdImport.id,
    rowCount: rows.length,
    matchedCount,
    unmatchedCount,
    totalSqft,
    totalInkMl,
    totalPrintMinutes,
  };
}
