import crypto from "crypto";
import type React from "react";
import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type QuoteRipRow = {
  importedAt: string;
  quoteId: string;
  workflow: string;
  source: string;
  fileName: string;
  status: string;
  cyanCc: number;
  magentaCc: number;
  yellowCc: number;
  blackCc: number;
  whiteCc: number;
  clearCc: number;
  totalCc: number;
  ripSeconds: number;
  estimatedInkCost: number;
  confidence: string;
  sourceFile: string;
};

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function money(value: number) {
  return `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: number, digits = 3) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fieldNumber(url: URL, name: string, fallback: number) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRawRow(rawRow?: string | null) {
  if (!rawRow) return {} as Record<string, unknown>;
  try {
    return JSON.parse(rawRow) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function rowFromEntry(entry: {
  createdAt: Date;
  jobTicket: string | null;
  sourceJobName: string | null;
  printerSoftware: string | null;
  status: string | null;
  inkMl: number;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  printMinutes: number;
  rawRow: string | null;
}): QuoteRipRow {
  const raw = parseRawRow(entry.rawRow);
  return {
    importedAt: cleanText(raw.importedAt) || entry.createdAt.toISOString(),
    quoteId: cleanText(raw.quoteId) || cleanText(entry.jobTicket),
    workflow: cleanText(raw.workflow) || cleanText(entry.status || "cost-calculation"),
    source: cleanText(raw.source) || cleanText(entry.printerSoftware || "quote-rip-sync"),
    fileName: cleanText(raw.fileName) || cleanText(entry.sourceJobName),
    status: cleanText(raw.status) || cleanText(entry.status),
    cyanCc: parseNumber(raw.cyanCc),
    magentaCc: parseNumber(raw.magentaCc),
    yellowCc: parseNumber(raw.yellowCc),
    blackCc: parseNumber(raw.blackCc),
    whiteCc: parseNumber(raw.whiteCc) || entry.whiteInkMl,
    clearCc: parseNumber(raw.clearCc) || entry.glossInkMl,
    totalCc: parseNumber(raw.totalCc) || entry.inkMl,
    ripSeconds: parseNumber(raw.ripSeconds) || Math.round((entry.printMinutes || 0) * 60),
    estimatedInkCost: parseNumber(raw.estimatedInkCost),
    confidence: cleanText(raw.confidence || "medium"),
    sourceFile: cleanText(raw.sourceFile),
  };
}

function uniqueLatestByQuote(rows: QuoteRipRow[]) {
  const seen = new Set<string>();
  const out: QuoteRipRow[] = [];
  for (const row of rows) {
    const key = row.quoteId || row.fileName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
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
  const url = new URL(request.url);
  const appOrigin = new URL(request.url).origin;

  const entries = await db.printLogEntry.findMany({
    where: {
      shop,
      jobTicket: { startsWith: "GSOQ-" },
      inkMl: { gt: 0 },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const rows = uniqueLatestByQuote(entries.map(rowFromEntry));
  const selectedId = cleanText(url.searchParams.get("quoteId") || rows[0]?.quoteId || "");
  const selected = rows.find((row) => row.quoteId === selectedId) || rows[0] || null;

  const quantity = fieldNumber(url, "quantity", 1000);
  const widthIn = fieldNumber(url, "widthIn", 4);
  const heightIn = fieldNumber(url, "heightIn", 5);
  const materialCostPerSqft = fieldNumber(url, "materialCostPerSqft", 0.26);
  const laborRatePerHour = fieldNumber(url, "laborRatePerHour", 25);
  const setupMinutes = fieldNumber(url, "setupMinutes", 10);
  const finishingMinutes = fieldNumber(url, "finishingMinutes", 0);
  const machineCostPerHour = fieldNumber(url, "machineCostPerHour", 8);
  const wastePct = fieldNumber(url, "wastePct", 10);
  const targetMarginPct = fieldNumber(url, "targetMarginPct", 40);
  const ripResultMode = cleanText(url.searchParams.get("ripResultMode") || "per-piece");
  const isPerPieceRip = ripResultMode !== "full-job";

  const sqftPerUnit = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
  const baseSqft = sqftPerUnit * quantity;
  const wasteMultiplier = 1 + wastePct / 100;
  const wasteAdjustedSqft = baseSqft * wasteMultiplier;
  const effectiveUnits = quantity * wasteMultiplier;
  const materialCost = wasteAdjustedSqft * materialCostPerSqft;
  const ripInkCost = selected?.estimatedInkCost || 0;
  const ripInkCc = selected?.totalCc || 0;
  const inkCost = isPerPieceRip ? ripInkCost * effectiveUnits : ripInkCost;
  const jobInkCc = isPerPieceRip ? ripInkCc * effectiveUnits : ripInkCc;
  const inkCostPerUnit = quantity > 0 ? inkCost / quantity : 0;
  const ripMinutes = selected ? selected.ripSeconds / 60 : 0;
  const totalMachineMinutes = ripMinutes + setupMinutes + finishingMinutes;
  const laborCost = (totalMachineMinutes / 60) * laborRatePerHour;
  const machineCost = (totalMachineMinutes / 60) * machineCostPerHour;
  const totalCost = materialCost + inkCost + laborCost + machineCost;
  const unitCost = quantity > 0 ? totalCost / quantity : 0;
  const suggestedTotal = targetMarginPct >= 100 ? 0 : totalCost / (1 - targetMarginPct / 100);
  const suggestedUnit = quantity > 0 ? suggestedTotal / quantity : 0;
  const grossProfit = suggestedTotal - totalCost;

  return {
    appOrigin,
    syncEndpoint: `${appOrigin}/api/quote-rip-results/sync`,
    uploadToken: setting.uploadToken,
    rows,
    selected,
    lastAutoImportAt: setting.lastAutoImportAt ? setting.lastAutoImportAt.toISOString() : null,
    form: { selectedId, quantity, widthIn, heightIn, materialCostPerSqft, laborRatePerHour, setupMinutes, finishingMinutes, machineCostPerHour, wastePct, targetMarginPct, ripResultMode },
    calc: { sqftPerUnit, baseSqft, wasteAdjustedSqft, effectiveUnits, materialCost, ripInkCost, ripInkCc, inkCost, jobInkCc, inkCostPerUnit, ripMinutes, totalMachineMinutes, laborCost, machineCost, totalCost, unitCost, suggestedTotal, suggestedUnit, grossProfit },
  };
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, background: "white" };
const codeStyle: React.CSSProperties = { background: "#111827", color: "#f9fafb", padding: 10, borderRadius: 8, display: "block", overflowX: "auto", fontSize: 12 };

export default function ErpCostCalculatorRoute() {
  const { syncEndpoint, uploadToken, rows, selected, lastAutoImportAt, form, calc } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1200, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p><a href="/app/erp/rip-imports">← RIP Imports</a> · <a href="/app/erp/product-setup">Product Setup / Recipes</a></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#14532d)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>GSO Cost Calculator</h1>
        <p style={{ marginBottom: 0 }}>v1.3 uses synced GSOQ RIP results, separates base sqft from waste-adjusted sqft, and scales ink correctly for one-piece/artboard quote RIPs.</p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: rows.length ? "#bbf7d0" : "#fde68a", background: rows.length ? "#f0fdf4" : "#fffbeb" }}>
        <h2 style={{ marginTop: 0 }}>Sync control</h2>
        <div style={{ display: "grid", gap: 8 }}>
          <div><b>Synced GSOQ results:</b> {rows.length}</div>
          <div><b>Last sync:</b> {lastAutoImportAt ? new Date(lastAutoImportAt).toLocaleString() : "Not synced yet"}</div>
          <div><b>Upload endpoint:</b> <code>{syncEndpoint}</code></div>
          <div><b>Upload token:</b> <code>{uploadToken}</code></div>
          <div style={{ color: "#4b5563", fontSize: 13 }}>Run the local sync script after RasterLink imports a GSOQ result. The script posts the local quote result CSV to this hosted app.</div>
          <code style={codeStyle}>powershell -ExecutionPolicy Bypass -File .\tools\gso-sync-quote-rip-results-to-app.ps1 -AppUrl "{new URL(syncEndpoint).origin}" -Token "{uploadToken}"</code>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16, marginTop: 16 }}>
        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Quote inputs</h2>
          <Form method="get" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ gridColumn: "1 / -1" }}>RIP quote result<br />
              <select name="quoteId" defaultValue={form.selectedId} style={inputStyle}>
                {rows.length ? rows.map((row) => (
                  <option key={`${row.quoteId}-${row.fileName}`} value={row.quoteId}>{row.quoteId} — {row.fileName}</option>
                )) : <option value="">No synced GSOQ results yet</option>}
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>RIP result represents<br />
              <select name="ripResultMode" defaultValue={form.ripResultMode} style={inputStyle}>
                <option value="per-piece">One piece / one artboard — scale ink by quantity + waste</option>
                <option value="full-job">Full production layout — use RIP ink as total job ink</option>
              </select>
            </label>
            <label>Quantity<br /><input name="quantity" type="number" defaultValue={form.quantity} style={inputStyle} /></label>
            <label>Target margin %<br /><input name="targetMarginPct" type="number" step="0.1" defaultValue={form.targetMarginPct} style={inputStyle} /></label>
            <label>Width inches<br /><input name="widthIn" type="number" step="0.01" defaultValue={form.widthIn} style={inputStyle} /></label>
            <label>Height inches<br /><input name="heightIn" type="number" step="0.01" defaultValue={form.heightIn} style={inputStyle} /></label>
            <label>Material $ / sqft<br /><input name="materialCostPerSqft" type="number" step="0.0001" defaultValue={form.materialCostPerSqft} style={inputStyle} /></label>
            <label>Waste %<br /><input name="wastePct" type="number" step="0.1" defaultValue={form.wastePct} style={inputStyle} /></label>
            <label>Labor $ / hour<br /><input name="laborRatePerHour" type="number" step="0.01" defaultValue={form.laborRatePerHour} style={inputStyle} /></label>
            <label>Machine $ / hour<br /><input name="machineCostPerHour" type="number" step="0.01" defaultValue={form.machineCostPerHour} style={inputStyle} /></label>
            <label>Setup minutes<br /><input name="setupMinutes" type="number" step="0.1" defaultValue={form.setupMinutes} style={inputStyle} /></label>
            <label>Finishing minutes<br /><input name="finishingMinutes" type="number" step="0.1" defaultValue={form.finishingMinutes} style={inputStyle} /></label>
            <button type="submit" style={{ gridColumn: "1 / -1", background: "#111827", color: "white", border: 0, borderRadius: 10, padding: 12, fontWeight: 800 }}>Calculate quote cost</button>
          </Form>
        </section>

        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Estimate</h2>
          {selected ? (
            <>
              <div style={{ fontSize: 13, color: "#4b5563", marginBottom: 12 }}>{selected.quoteId} · {selected.fileName}</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  <tr><td>RIP ink</td><td align="right"><b>{num(calc.ripInkCc)} cc / {money(calc.ripInkCost)}</b></td></tr>
                  <tr><td>Calculated job ink</td><td align="right"><b>{num(calc.jobInkCc)} cc / {money(calc.inkCost)}</b></td></tr>
                  <tr><td>Base sqft</td><td align="right">{num(calc.baseSqft, 2)}</td></tr>
                  <tr><td>Waste-adjusted sqft</td><td align="right">{num(calc.wasteAdjustedSqft, 2)}</td></tr>
                  <tr><td>Effective pieces incl. waste</td><td align="right">{num(calc.effectiveUnits, 0)}</td></tr>
                  <tr><td>Material cost</td><td align="right">{money(calc.materialCost)}</td></tr>
                  <tr><td>Labor cost</td><td align="right">{money(calc.laborCost)}</td></tr>
                  <tr><td>Machine cost</td><td align="right">{money(calc.machineCost)}</td></tr>
                  <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Total cost</b></td><td align="right"><b>{money(calc.totalCost)}</b></td></tr>
                  <tr><td><b>Unit cost</b></td><td align="right"><b>{money(calc.unitCost)}</b></td></tr>
                  <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Suggested total</b></td><td align="right"><b>{money(calc.suggestedTotal)}</b></td></tr>
                  <tr><td><b>Suggested unit</b></td><td align="right"><b>{money(calc.suggestedUnit)}</b></td></tr>
                  <tr><td>Gross profit</td><td align="right">{money(calc.grossProfit)}</td></tr>
                </tbody>
              </table>
            </>
          ) : <p>No synced RIP quote result selected yet.</p>}
        </section>
      </div>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Recent synced GSOQ results</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Imported</th><th align="left">Quote</th><th align="left">File</th><th>Ink cc</th><th>RIP sec</th><th>Ink cost</th><th>Confidence</th></tr></thead>
          <tbody>
            {rows.slice(0, 25).map((row) => (
              <tr key={`${row.quoteId}-${row.fileName}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{row.importedAt}</td><td>{row.quoteId}</td><td>{row.fileName}</td><td align="center">{num(row.totalCc)}</td><td align="center">{num(row.ripSeconds, 0)}</td><td align="center">{money(row.estimatedInkCost)}</td><td align="center">{row.confidence}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={7} style={{ padding: 12, color: "#6b7280" }}>No synced GSOQ results yet. Run the local sync script after a GSOQ RasterLink capture/import.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
