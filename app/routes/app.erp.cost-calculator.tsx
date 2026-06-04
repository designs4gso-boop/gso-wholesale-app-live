import fs from "fs";
import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

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

function readQuoteRipRows(csvPath: string): QuoteRipRow[] {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, "utf8");
  return parseCsv(raw).map((row) => ({
    importedAt: cleanText(row.importedAt),
    quoteId: cleanText(row.quoteId),
    workflow: cleanText(row.workflow || "cost-calculation"),
    source: cleanText(row.source),
    fileName: cleanText(row.fileName),
    status: cleanText(row.status),
    cyanCc: parseNumber(row.cyanCc),
    magentaCc: parseNumber(row.magentaCc),
    yellowCc: parseNumber(row.yellowCc),
    blackCc: parseNumber(row.blackCc),
    whiteCc: parseNumber(row.whiteCc),
    clearCc: parseNumber(row.clearCc),
    totalCc: parseNumber(row.totalCc),
    ripSeconds: parseNumber(row.ripSeconds),
    estimatedInkCost: parseNumber(row.estimatedInkCost),
    confidence: cleanText(row.confidence),
    sourceFile: cleanText(row.sourceFile),
  })).filter((row) => row.quoteId || row.fileName);
}

function money(value: number) {
  return `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: number, digits = 3) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function newestFirst(rows: QuoteRipRow[]) {
  return [...rows].sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

function uniqueLatestByQuote(rows: QuoteRipRow[]) {
  const seen = new Set<string>();
  const out: QuoteRipRow[] = [];
  for (const row of newestFirst(rows)) {
    const key = row.quoteId || row.fileName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function fieldNumber(url: URL, name: string, fallback: number) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const quoteResultsPath = "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today\\COST CALCULATION\\_Quote RIP\\results\\gso-quote-rip-results-summary.csv";
  const rows = uniqueLatestByQuote(readQuoteRipRows(quoteResultsPath));
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

  const sqftPerUnit = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
  const totalSqft = sqftPerUnit * quantity;
  const wasteMultiplier = 1 + wastePct / 100;
  const materialCost = totalSqft * materialCostPerSqft * wasteMultiplier;
  const inkCostPerUnit = selected && quantity > 0 ? selected.estimatedInkCost / quantity : 0;
  const inkCost = selected?.estimatedInkCost || 0;
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
    quoteResultsPath,
    pathExists: fs.existsSync(quoteResultsPath),
    rows,
    selected,
    form: { selectedId, quantity, widthIn, heightIn, materialCostPerSqft, laborRatePerHour, setupMinutes, finishingMinutes, machineCostPerHour, wastePct, targetMarginPct },
    calc: { sqftPerUnit, totalSqft, materialCost, inkCost, inkCostPerUnit, ripMinutes, totalMachineMinutes, laborCost, machineCost, totalCost, unitCost, suggestedTotal, suggestedUnit, grossProfit },
  };
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, background: "white" };

export default function ErpCostCalculatorRoute() {
  const { quoteResultsPath, pathExists, rows, selected, form, calc } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1200, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p><a href="/app/erp/rip-imports">← RIP Imports</a> · <a href="/app/erp/product-setup">Product Setup / Recipes</a></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#7c2d12)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>GSO Cost Calculator</h1>
        <p style={{ marginBottom: 0 }}>v1.0 reads Cost Calculation RIP results from the NAS and turns exact ink usage into a quote estimate.</p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: pathExists ? "#bbf7d0" : "#fecaca", background: pathExists ? "#f0fdf4" : "#fef2f2" }}>
        <b>Quote result source</b>
        <div style={{ fontSize: 13, marginTop: 6 }}><code>{quoteResultsPath}</code></div>
        <div style={{ marginTop: 8 }}>{pathExists ? `Loaded ${rows.length} quote result(s).` : "No quote result CSV found yet. RIP/import one GSOQ job first."}</div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16, marginTop: 16 }}>
        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Quote inputs</h2>
          <Form method="get" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ gridColumn: "1 / -1" }}>RIP quote result<br />
              <select name="quoteId" defaultValue={form.selectedId} style={inputStyle}>
                {rows.length ? rows.map((row) => (
                  <option key={`${row.quoteId}-${row.fileName}`} value={row.quoteId}>{row.quoteId} — {row.fileName}</option>
                )) : <option value="">No GSOQ results yet</option>}
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
                  <tr><td>Total ink</td><td align="right"><b>{num(selected.totalCc)} cc</b></td></tr>
                  <tr><td>Ink cost from RIP</td><td align="right"><b>{money(calc.inkCost)}</b></td></tr>
                  <tr><td>Total sqft</td><td align="right">{num(calc.totalSqft, 2)}</td></tr>
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
          ) : <p>No RIP quote result selected yet.</p>}
        </section>
      </div>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Recent GSOQ results</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#f3f4f6" }}><th align="left">Imported</th><th align="left">Quote</th><th align="left">File</th><th>Ink cc</th><th>RIP sec</th><th>Ink cost</th><th>Confidence</th></tr></thead>
          <tbody>
            {rows.slice(0, 25).map((row) => (
              <tr key={`${row.quoteId}-${row.fileName}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{row.importedAt}</td><td>{row.quoteId}</td><td>{row.fileName}</td><td align="center">{num(row.totalCc)}</td><td align="center">{num(row.ripSeconds, 0)}</td><td align="center">{money(row.estimatedInkCost)}</td><td align="center">{row.confidence}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={7} style={{ padding: 12, color: "#6b7280" }}>No quote RIP results yet. Run RasterLink capture/import on a GSOQ job first.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
