import { Form, useActionData, useLoaderData } from "react-router";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { credentialStatusLabel, maskCredential } from "../lib/security-guards-shared";

type ParsedRipRow = {
  event: string;
  machineName: string;
  jobName: string;
  mediaName: string;
  printAreaXmm: number;
  printAreaYmm: number;
  sqft: number;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  ripStartTime?: string;
  ripEndTime?: string;
  printStartTime?: string;
  printEndTime?: string;
  jobTicket?: string;
  raw: Record<string, string>;
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const normalized = raw.replace(/\//g, "-").replace(" ", "T");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractTicket(jobName: string, fileName = "") {
  const haystack = `${jobName} ${fileName}`;
  const match = haystack.match(/\bGSO[-_ ]?(?:TEST[-_ ]?)?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\b/i);
  if (!match) return "";
  return match[0].replace(/_/g, "-").replace(/\s+/g, "-").toUpperCase();
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
  if (!rows.length) return [];
  const headers = rows[0].map(cleanText);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, index) => {
      obj[header] = cleanText(cells[index]);
    });
    return obj;
  });
}

function splitInk(row: Record<string, string>) {
  const values = cleanText(row["Ink Consumption[ml]"]).split(":").map(parseNumber);
  const names = cleanText(row["Ink Name"]).split(":").map((name) => name.toLowerCase());
  let cmykInkMl = 0;
  let whiteInkMl = 0;
  let glossInkMl = 0;
  values.forEach((ml, index) => {
    const name = names[index] || "";
    if (name.includes("white")) whiteInkMl += ml;
    else if (name.includes("gloss") || name.includes("clear") || name.includes("primer")) glossInkMl += ml;
    else cmykInkMl += ml;
  });
  return { cmykInkMl, whiteInkMl, glossInkMl, inkMl: values.reduce((sum, value) => sum + value, 0) };
}

function parseVersaWorksCsv(text: string, fileName: string): ParsedRipRow[] {
  return parseCsv(text).map((row) => {
    const x = parseNumber(row["Print Area_X[mm]"]);
    const y = parseNumber(row["Print Area_Y[mm]"]);
    const sqft = x > 0 && y > 0 ? (x / 25.4) * (y / 25.4) / 144 : 0;
    const jobName = cleanText(row["Job Name"]);
    const ink = splitInk(row);
    return {
      event: cleanText(row.Event),
      machineName: cleanText(row["Nick Name"]),
      jobName,
      mediaName: cleanText(row["Media Name"]),
      printAreaXmm: x,
      printAreaYmm: y,
      sqft,
      ...ink,
      ripStartTime: cleanText(row["RIP Start Time"]),
      ripEndTime: cleanText(row["RIP End Time"]),
      printStartTime: cleanText(row["Print Start Time"]),
      printEndTime: cleanText(row["Print End Time"]),
      jobTicket: extractTicket(jobName, fileName),
      raw: row,
    };
  });
}

function parseRipFile(text: string, fileName: string, source: string): ParsedRipRow[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return parseVersaWorksCsv(text, fileName);
  // First .vw/XML foundation: save the file and create a searchable placeholder row.
  return [{
    event: lower.endsWith(".vw") ? "VersaWorks job file" : `${source} import`,
    machineName: source,
    jobName: fileName,
    mediaName: "",
    printAreaXmm: 0,
    printAreaYmm: 0,
    sqft: 0,
    inkMl: 0,
    cmykInkMl: 0,
    whiteInkMl: 0,
    glossInkMl: 0,
    jobTicket: extractTicket(fileName, fileName),
    raw: { fileName, note: "File was stored for parser mapping. CSV parsing is active now; .vw/RasterLink mapping comes after sample formats are confirmed." },
  }];
}

async function ensureSetting(shop: string) {
  return db.printLogAutoImportSetting.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      uploadToken: crypto.randomUUID(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\error",
      expectedTicketPattern: "GSO-{jobNumber}_{customer}_{product}_{side}_{material}_{route}_R{revision}",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const setting = await ensureSetting(shop);
  const imports = await db.printLogImport.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { entries: { take: 5, orderBy: { createdAt: "desc" } } },
  });
  // 15G.1A: never send the raw upload token to the browser — explicit
  // projection of the display fields plus the masked credential status only.
  return {
    setting: {
      incomingFolder: setting.incomingFolder,
      versaworksFolder: setting.versaworksFolder,
      rasterlinkFolder: setting.rasterlinkFolder,
    },
    credential: maskCredential(setting.uploadToken),
    imports,
  };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const upload = form.get("ripFile");
  const source = cleanText(form.get("source") || "versaworks");
  const notes = cleanText(form.get("notes"));
  if (!(upload instanceof File)) return { ok: false, error: "Choose a RIP log file first." };
  const fileName = upload.name;
  const rawText = await upload.text();
  const rows = parseRipFile(rawText, fileName, source);

  let matchedCount = 0;
  const importRecord = await db.printLogImport.create({
    data: {
      shop,
      source,
      fileName,
      rawText: rawText.slice(0, 250000),
      rowCount: rows.length,
      totalSqft: rows.reduce((sum, row) => sum + row.sqft, 0),
      totalInkMl: rows.reduce((sum, row) => sum + row.inkMl, 0),
      notes,
    },
  });

  for (const row of rows) {
    let productionJobId: string | undefined;
    if (row.jobTicket) {
      const job = await db.productionJob.findFirst({ where: { shop, jobTicket: row.jobTicket } });
      if (job) {
        productionJobId = job.id;
        matchedCount += 1;
      }
    }
    await db.printLogEntry.create({
      data: {
        shop,
        importId: importRecord.id,
        productionJobId,
        jobTicket: row.jobTicket || null,
        sourceJobName: row.jobName,
        printerSoftware: source,
        machineName: row.machineName,
        mediaName: row.mediaName,
        status: row.event,
        sqft: row.sqft,
        inkMl: row.inkMl,
        cmykInkMl: row.cmykInkMl,
        whiteInkMl: row.whiteInkMl,
        glossInkMl: row.glossInkMl,
        printMinutes: 0,
        startedAt: parseDate(row.printStartTime || row.ripStartTime),
        completedAt: parseDate(row.printEndTime || row.ripEndTime),
        rawRow: JSON.stringify(row.raw).slice(0, 12000),
      },
    });
  }

  await db.printLogImport.update({
    where: { id: importRecord.id },
    data: { matchedCount, unmatchedCount: Math.max(0, rows.length - matchedCount) },
  });

  return { ok: true, fileName, rowCount: rows.length, matchedCount, unmatchedCount: Math.max(0, rows.length - matchedCount), totalInkMl: rows.reduce((sum, row) => sum + row.inkMl, 0), totalSqft: rows.reduce((sum, row) => sum + row.sqft, 0) };
}

function moneyish(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function RipImports() {
  const { setting, credential, imports } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#4c1d95)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>RIP Imports</h1>
        <p style={{ margin: "8px 0 0" }}>v14.0 foundation: import VersaWorks CSV/.vw now, prepare RasterLink results next, and match files back to ERP job tickets.</p>
      </section>

      <section style={{ marginTop: 16, border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 12, padding: 16 }}>
        <b>Current shop folders</b>
        <div style={{ fontSize: 13, marginTop: 8 }}>
          <div><b>Print intake:</b> {setting.incomingFolder}</div>
          <div><b>VersaWorks logs:</b> {setting.versaworksFolder}</div>
          <div><b>RasterLink logs:</b> {setting.rasterlinkFolder}</div>
          <div><b>Print Intake Agent Credential:</b> {credentialStatusLabel(credential)} <span style={{ color: "#6b7280" }}>(full token never displayed — rotate on Print Log Settings to reveal a new one once)</span></div>
        </div>
      </section>

      <section style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" }}>
        <h2>Manual import test</h2>
        <Form method="post" encType="multipart/form-data" style={{ display: "grid", gap: 12 }}>
          <label>RIP source<br />
            <select name="source" defaultValue="versaworks" style={{ width: "100%", padding: 10 }}>
              <option value="versaworks">VersaWorks</option>
              <option value="rasterlink">RasterLink</option>
              <option value="manual_csv">Manual CSV</option>
            </select>
          </label>
          <label>RIP log file<br /><input type="file" name="ripFile" accept=".csv,.xml,.vw,.txt" /></label>
          <label>Notes<br /><textarea name="notes" rows={3} style={{ width: "100%" }} placeholder="Optional notes about this import." /></label>
          <button type="submit" style={{ background: "#111827", color: "white", border: 0, borderRadius: 8, padding: 12, fontWeight: 700 }}>Import RIP log</button>
        </Form>
        {actionData ? (
          <div style={{ marginTop: 12, border: actionData.ok ? "1px solid #bbf7d0" : "1px solid #fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2", padding: 12, borderRadius: 10 }}>
            {actionData.ok ? `Imported ${actionData.fileName}: ${actionData.rowCount} row(s), ${actionData.matchedCount} matched, ${actionData.unmatchedCount} unmatched, ${moneyish(actionData.totalInkMl || 0)} ml ink.` : actionData.error}
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" }}>
        <h2>Recent imports</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Created</th><th align="left">Source</th><th align="left">File</th><th>Rows</th><th>Matched</th><th>Total ink</th><th>Total sqft</th></tr></thead>
          <tbody>
            {imports.map((item) => (
              <tr key={item.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.source}</td><td>{item.fileName}</td><td align="center">{item.rowCount}</td><td align="center">{item.matchedCount}</td><td align="center">{moneyish(item.totalInkMl)} ml</td><td align="center">{moneyish(item.totalSqft)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
