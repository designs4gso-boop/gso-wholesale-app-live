import db from "../db.server";

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
