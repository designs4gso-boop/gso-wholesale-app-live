import db from "../db.server";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
      if (quoted && next === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cleanText(cell))) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cleanText(cell))) rows.push(row);
  }

  if (!rows.length) return [] as Record<string, string>[];
  const headers = rows[0].map(cleanText);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, index) => {
      obj[header] = cleanText(cells[index]);
    });
    return obj;
  });
}

function normalizeQuoteId(value: unknown) {
  const raw = cleanText(value);
  const match = raw.match(/GSOQ[-_ ]?(\d+)/i);
  return match ? `GSOQ-${match[1]}` : "";
}

function parseDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const d = new Date(raw.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseQuoteRows(text: string) {
  return parseCsv(text)
    .map((row) => {
      const quoteId = normalizeQuoteId(row.quoteId || row.jobId || row.fileName || row.sourceFile);
      const fileName = cleanText(row.fileName);
      const totalCc = parseNumber(row.totalCc);
      const cyanCc = parseNumber(row.cyanCc);
      const magentaCc = parseNumber(row.magentaCc);
      const yellowCc = parseNumber(row.yellowCc);
      const blackCc = parseNumber(row.blackCc);
      const whiteCc = parseNumber(row.whiteCc);
      const clearCc = parseNumber(row.clearCc);
      const ripSeconds = parseNumber(row.ripSeconds);
      const estimatedInkCost = parseNumber(row.estimatedInkCost);
      const workflow = cleanText(row.workflow || "cost-calculation");
      return {
        importedAt: cleanText(row.importedAt),
        quoteId,
        workflow,
        source: cleanText(row.source || "rasterlink"),
        fileName,
        status: cleanText(row.status || workflow),
        cyanCc,
        magentaCc,
        yellowCc,
        blackCc,
        whiteCc,
        clearCc,
        totalCc,
        ripSeconds,
        estimatedInkCost,
        confidence: cleanText(row.confidence || "medium"),
        sourceFile: cleanText(row.sourceFile),
        raw: row,
      };
    })
    .filter((row) => row.quoteId && row.fileName && row.totalCc > 0);
}

export async function action({ request }: { request: Request }) {
  const token = cleanText(request.headers.get("x-gso-rip-token"));
  const contentType = request.headers.get("content-type") || "";
  let fileName = "gso-quote-rip-results-summary.csv";
  let rawText = "";
  let source = "quote-rip-sync";
  let bodyToken = "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    bodyToken = cleanText(form.get("token"));
    source = cleanText(form.get("source") || source);
    const file = form.get("file");
    if (!(file instanceof File)) return json({ ok: false, error: "Missing file field." }, 400);
    fileName = file.name;
    rawText = await file.text();
  } else {
    const body = await request.json().catch(() => null) as { token?: string; source?: string; fileName?: string; csv?: string } | null;
    bodyToken = cleanText(body?.token);
    source = cleanText(body?.source || source);
    fileName = cleanText(body?.fileName || fileName);
    rawText = String(body?.csv || "");
  }

  const uploadToken = token || bodyToken;
  if (!uploadToken) return json({ ok: false, error: "Missing upload token." }, 401);

  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken } });
  if (!setting || !setting.enabled) return json({ ok: false, error: "Invalid or disabled upload token." }, 403);
  if (!rawText.trim()) return json({ ok: false, error: "Missing CSV content." }, 400);

  const rows = parseQuoteRows(rawText);
  if (!rows.length) return json({ ok: false, error: "No valid GSOQ quote result rows found." }, 400);

  const importRecord = await db.printLogImport.create({
    data: {
      shop: setting.shop,
      source,
      fileName,
      rawText: rawText.slice(0, 250000),
      rowCount: rows.length,
      totalSqft: 0,
      totalInkMl: rows.reduce((sum, row) => sum + row.totalCc, 0),
      status: "quote_results_synced",
      notes: "Uploaded from local GSO quote RIP results sync.",
    },
  });

  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const existing = await db.printLogEntry.findFirst({
      where: {
        shop: setting.shop,
        jobTicket: row.quoteId,
        sourceJobName: row.fileName,
        printerSoftware: row.source,
        inkMl: row.totalCc,
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    await db.printLogEntry.create({
      data: {
        shop: setting.shop,
        importId: importRecord.id,
        jobTicket: row.quoteId,
        sourceJobName: row.fileName,
        printerSoftware: row.source,
        machineName: row.source,
        mediaName: "",
        status: row.workflow || "cost-calculation",
        sqft: 0,
        inkMl: row.totalCc,
        cmykInkMl: row.cyanCc + row.magentaCc + row.yellowCc + row.blackCc,
        whiteInkMl: row.whiteCc,
        glossInkMl: row.clearCc,
        printMinutes: row.ripSeconds / 60,
        startedAt: parseDate(row.importedAt),
        completedAt: parseDate(row.importedAt),
        rawRow: JSON.stringify(row).slice(0, 12000),
      },
    });
    created += 1;
  }

  await db.printLogImport.update({
    where: { id: importRecord.id },
    data: {
      matchedCount: created,
      unmatchedCount: skipped,
      status: "processed",
    },
  });
  await db.printLogAutoImportSetting.update({ where: { id: setting.id }, data: { lastAutoImportAt: new Date() } });

  return json({ ok: true, source, fileName, rows: rows.length, created, skipped });
}

export const loader = () => json({ ok: true, endpoint: "POST multipart file + x-gso-rip-token to sync GSOQ quote RIP results." });
