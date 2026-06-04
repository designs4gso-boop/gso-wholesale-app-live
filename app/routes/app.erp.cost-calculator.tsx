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

type MaterialOption = {
  id: string;
  name: string;
  materialType: string;
  unit: string;
  baseUnit: string;
  costPerUnit: number;
  calculatedUnitCost: number;
  purchaseCost: number;
};

type BlankItemOption = {
  id: string;
  source: "material" | "vendor";
  name: string;
  productType: string;
  unitCost: number;
};

type QuoteLine = {
  index: number;
  name: string;
  quantity: number;
  widthIn: number;
  heightIn: number;
  materialId: string;
  customMaterialCostPerSqft: number;
  wastePct: number;
  quoteId: string;
  ripResultMode: string;
  inkEstimateProfile: string;
  customInkCostPerSqft: number;
  baseSqft: number;
  wasteAdjustedSqft: number;
  effectiveUnits: number;
  materialName: string;
  materialCostPerSqft: number;
  materialCost: number;
  inkSource: string;
  inkCost: number;
  inkCc: number;
  unitCost: number;
  totalCost: number;
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

function getAt<T>(values: T[], index: number, fallback: T) {
  const value = values[index];
  return value === undefined || value === null || value === ("" as T) ? fallback : value;
}

function getNumberAt(values: string[], index: number, fallback: number) {
  const raw = getAt(values, index, String(fallback));
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

function materialSqftCost(material?: MaterialOption | null, fallback = 0.26) {
  if (!material) return fallback;
  const unitCost = material.calculatedUnitCost || material.costPerUnit || material.purchaseCost || fallback;
  const unit = `${material.baseUnit || material.unit || ""}`.toLowerCase();
  if (unit.includes("sqin")) return unitCost * 144;
  return unitCost;
}

function inkEstimateCostPerSqft(profile: string, custom: number) {
  if (profile === "light") return 0.12;
  if (profile === "medium") return 0.23;
  if (profile === "heavy") return 0.38;
  if (profile === "roland-gloss") return 0.35;
  if (profile === "white-gloss") return 0.55;
  if (profile === "custom") return custom;
  return 0.23;
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

  const [entries, materialRecords, vendorProducts] = await Promise.all([
    db.printLogEntry.findMany({
      where: { shop, jobTicket: { startsWith: "GSOQ-" }, inkMl: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.material.findMany({
      where: { shop, active: true, useInRecipes: true },
      orderBy: [{ materialType: "asc" }, { name: "asc" }],
      take: 200,
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true },
      orderBy: [{ productType: "asc" }, { name: "asc" }],
      take: 200,
    }),
  ]);

  const rows = uniqueLatestByQuote(entries.map(rowFromEntry));
  const rowById = new Map(rows.map((row) => [row.quoteId, row]));
  const materials: MaterialOption[] = materialRecords.map((m) => ({
    id: m.id,
    name: m.name,
    materialType: m.materialType,
    unit: m.unit,
    baseUnit: m.baseUnit,
    costPerUnit: m.costPerUnit,
    calculatedUnitCost: m.calculatedUnitCost,
    purchaseCost: m.purchaseCost,
  }));
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const defaultMaterial = materials.find((m) => `${m.baseUnit} ${m.unit}`.toLowerCase().includes("sqft")) || materials[0] || null;

  const blankItems: BlankItemOption[] = [
    ...materials
      .filter((m) => [m.unit, m.baseUnit].join(" ").toLowerCase().includes("each") || ["blank", "packaging", "general"].includes(m.materialType))
      .slice(0, 100)
      .map((m) => ({ id: `material:${m.id}`, source: "material" as const, name: m.name, productType: m.materialType, unitCost: m.calculatedUnitCost || m.costPerUnit || m.purchaseCost || 0 })),
    ...vendorProducts.slice(0, 100).map((p) => ({ id: `vendor:${p.id}`, source: "vendor" as const, name: p.name, productType: p.productType, unitCost: p.defaultUnitCost || 0 })),
  ];
  const blankItemById = new Map(blankItems.map((item) => [item.id, item]));

  const quoteMode = cleanText(url.searchParams.get("quoteMode") || "estimated");
  const targetMarginPct = fieldNumber(url, "targetMarginPct", 40);
  const laborRatePerHour = fieldNumber(url, "laborRatePerHour", 25);
  const machineCostPerHour = fieldNumber(url, "machineCostPerHour", 8);
  const setupMinutes = fieldNumber(url, "setupMinutes", 10);
  const finishingMinutes = fieldNumber(url, "finishingMinutes", 0);
  const lineCount = Math.min(Math.max(fieldNumber(url, "lineCount", 1), 1), 8);

  const lineNames = url.searchParams.getAll("lineName");
  const lineQtys = url.searchParams.getAll("lineQty");
  const lineWidths = url.searchParams.getAll("lineWidthIn");
  const lineHeights = url.searchParams.getAll("lineHeightIn");
  const lineMaterials = url.searchParams.getAll("lineMaterialId");
  const customMaterialCosts = url.searchParams.getAll("lineCustomMaterialCostPerSqft");
  const lineWastes = url.searchParams.getAll("lineWastePct");
  const lineQuoteIds = url.searchParams.getAll("lineQuoteId");
  const lineRipModes = url.searchParams.getAll("lineRipResultMode");
  const lineInkProfiles = url.searchParams.getAll("lineInkEstimateProfile");
  const lineCustomInkCosts = url.searchParams.getAll("lineCustomInkCostPerSqft");

  const lines: QuoteLine[] = Array.from({ length: lineCount }, (_, index) => {
    const name = cleanText(getAt(lineNames, index, index === 0 ? "Main label" : `Label ${index + 1}`));
    const quantity = getNumberAt(lineQtys, index, 1000);
    const widthIn = getNumberAt(lineWidths, index, 4);
    const heightIn = getNumberAt(lineHeights, index, 5);
    const materialId = cleanText(getAt(lineMaterials, index, defaultMaterial?.id || "custom"));
    const customMaterialCostPerSqft = getNumberAt(customMaterialCosts, index, 0.26);
    const wastePct = getNumberAt(lineWastes, index, 10);
    const quoteId = cleanText(getAt(lineQuoteIds, index, rows[0]?.quoteId || ""));
    const ripResultMode = cleanText(getAt(lineRipModes, index, "per-piece"));
    const inkEstimateProfile = cleanText(getAt(lineInkProfiles, index, "medium"));
    const customInkCostPerSqft = getNumberAt(lineCustomInkCosts, index, 0.23);
    const material = materialById.get(materialId);
    const materialCostPerSqft = materialId === "custom" ? customMaterialCostPerSqft : materialSqftCost(material, customMaterialCostPerSqft);
    const sqftPerUnit = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
    const baseSqft = sqftPerUnit * quantity;
    const wasteMultiplier = 1 + wastePct / 100;
    const wasteAdjustedSqft = baseSqft * wasteMultiplier;
    const effectiveUnits = quantity * wasteMultiplier;
    const materialCost = wasteAdjustedSqft * materialCostPerSqft;
    const ripRow = rowById.get(quoteId) || null;
    const useActualRip = quoteMode === "actual" && ripRow;
    const ripIsPerPiece = ripResultMode !== "full-job";
    const estimatedInkCost = inkEstimateCostPerSqft(inkEstimateProfile, customInkCostPerSqft) * wasteAdjustedSqft;
    const inkCost = useActualRip ? (ripIsPerPiece ? ripRow.estimatedInkCost * effectiveUnits : ripRow.estimatedInkCost) : estimatedInkCost;
    const inkCc = useActualRip ? (ripIsPerPiece ? ripRow.totalCc * effectiveUnits : ripRow.totalCc) : 0;
    const totalCost = materialCost + inkCost;
    return {
      index,
      name,
      quantity,
      widthIn,
      heightIn,
      materialId,
      customMaterialCostPerSqft,
      wastePct,
      quoteId,
      ripResultMode,
      inkEstimateProfile,
      customInkCostPerSqft,
      baseSqft,
      wasteAdjustedSqft,
      effectiveUnits,
      materialName: material?.name || "Custom material",
      materialCostPerSqft,
      materialCost,
      inkSource: useActualRip ? `Actual RIP ${ripRow.quoteId}` : `Estimated ${inkEstimateProfile}`,
      inkCost,
      inkCc,
      unitCost: quantity > 0 ? totalCost / quantity : 0,
      totalCost,
    };
  });

  const itemMode = cleanText(url.searchParams.get("itemMode") || "none");
  const itemId = cleanText(url.searchParams.get("itemId") || "custom");
  const itemQty = fieldNumber(url, "itemQty", lines[0]?.quantity || 1000);
  const customItemName = cleanText(url.searchParams.get("customItemName") || "Custom item");
  const customItemUnitCost = fieldNumber(url, "customItemUnitCost", 0);
  const selectedItem = blankItemById.get(itemId) || null;
  const itemUnitCost = itemMode === "none" ? 0 : itemId === "custom" ? customItemUnitCost : selectedItem?.unitCost || 0;
  const itemName = itemMode === "none" ? "No blank item" : itemId === "custom" ? customItemName : selectedItem?.name || "Selected item";
  const itemCost = itemQty * itemUnitCost;

  const applicationMode = cleanText(url.searchParams.get("applicationMode") || "none");
  const applicationQty = fieldNumber(url, "applicationQty", itemQty || lines[0]?.quantity || 1000);
  const applicationSecondsPerUnit = fieldNumber(url, "applicationSecondsPerUnit", applicationMode === "apply-one" ? 8 : applicationMode === "apply-two" ? 16 : 0);
  const applicationUnitCost = fieldNumber(url, "applicationUnitCost", 0);
  const applicationLaborMinutes = (applicationQty * applicationSecondsPerUnit) / 60;
  const applicationLaborCost = (applicationLaborMinutes / 60) * laborRatePerHour + applicationQty * applicationUnitCost;

  const lineMaterialCost = lines.reduce((sum, line) => sum + line.materialCost, 0);
  const lineInkCost = lines.reduce((sum, line) => sum + line.inkCost, 0);
  const lineBaseSqft = lines.reduce((sum, line) => sum + line.baseSqft, 0);
  const lineWasteAdjustedSqft = lines.reduce((sum, line) => sum + line.wasteAdjustedSqft, 0);
  const lineInkCc = lines.reduce((sum, line) => sum + line.inkCc, 0);
  const setupAndFinishingMinutes = setupMinutes + finishingMinutes;
  const processLaborCost = (setupAndFinishingMinutes / 60) * laborRatePerHour;
  const processMachineCost = (setupAndFinishingMinutes / 60) * machineCostPerHour;
  const totalCost = lineMaterialCost + lineInkCost + itemCost + applicationLaborCost + processLaborCost + processMachineCost;
  const primaryQuantity = Math.max(lines[0]?.quantity || 0, 1);
  const unitCost = totalCost / primaryQuantity;
  const suggestedTotal = targetMarginPct >= 100 ? 0 : totalCost / (1 - targetMarginPct / 100);
  const suggestedUnit = suggestedTotal / primaryQuantity;
  const grossProfit = suggestedTotal - totalCost;

  return {
    appOrigin,
    syncEndpoint: `${appOrigin}/api/quote-rip-results/sync`,
    uploadToken: setting.uploadToken,
    rows,
    lastAutoImportAt: setting.lastAutoImportAt ? setting.lastAutoImportAt.toISOString() : null,
    materials,
    blankItems,
    form: {
      quoteMode,
      targetMarginPct,
      laborRatePerHour,
      machineCostPerHour,
      setupMinutes,
      finishingMinutes,
      lineCount,
      lines,
      itemMode,
      itemId,
      itemQty,
      customItemName,
      customItemUnitCost,
      applicationMode,
      applicationQty,
      applicationSecondsPerUnit,
      applicationUnitCost,
    },
    calc: {
      lineMaterialCost,
      lineInkCost,
      lineBaseSqft,
      lineWasteAdjustedSqft,
      lineInkCc,
      itemName,
      itemQty,
      itemUnitCost,
      itemCost,
      applicationLaborMinutes,
      applicationLaborCost,
      processLaborCost,
      processMachineCost,
      totalCost,
      unitCost,
      suggestedTotal,
      suggestedUnit,
      grossProfit,
    },
  };
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8 };
const cardStyle: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, background: "white" };
const codeStyle: React.CSSProperties = { background: "#111827", color: "#f9fafb", padding: 10, borderRadius: 8, display: "block", overflowX: "auto", fontSize: 12 };
const smallHelp: React.CSSProperties = { color: "#6b7280", fontSize: 12, marginTop: 4 };

export default function ErpCostCalculatorRoute() {
  const { syncEndpoint, uploadToken, rows, lastAutoImportAt, materials, blankItems, form, calc } = useLoaderData<typeof loader>();
  const nextLineCount = Math.min(form.lineCount + 1, 8);
  const removeLineCount = Math.max(form.lineCount - 1, 1);

  return (
    <main style={{ maxWidth: 1280, margin: "32px auto", padding: 20, fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>
      <p><a href="/app/erp/rip-imports">← RIP Imports</a> · <a href="/app/erp/product-setup">Product Setup / Recipes</a> · <a href="/app/erp/materials">Materials</a></p>
      <section style={{ background: "linear-gradient(135deg,#111827,#14532d)", color: "white", padding: 24, borderRadius: 16 }}>
        <h1 style={{ margin: 0 }}>GSO Quote Builder / Cost Calculator</h1>
        <p style={{ marginBottom: 0 }}>v1.4 supports estimated quotes before artwork, actual GSOQ RIP costs after artwork, multiple label sizes, material picker, blank item picker, and application labor.</p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16, borderColor: rows.length ? "#bbf7d0" : "#fde68a", background: rows.length ? "#f0fdf4" : "#fffbeb" }}>
        <h2 style={{ marginTop: 0 }}>Sync control</h2>
        <div style={{ display: "grid", gap: 8 }}>
          <div><b>Synced GSOQ results:</b> {rows.length}</div>
          <div><b>Last sync:</b> {lastAutoImportAt ? new Date(lastAutoImportAt).toLocaleString() : "Not synced yet"}</div>
          <div><b>Upload endpoint:</b> <code>{syncEndpoint}</code></div>
          <div><b>Upload token:</b> <code>{uploadToken}</code></div>
          <code style={codeStyle}>powershell -ExecutionPolicy Bypass -File .\tools\gso-sync-quote-rip-results-to-app.ps1 -AppUrl "{new URL(syncEndpoint).origin}" -Token "{uploadToken}"</code>
        </div>
      </section>

      <Form method="get" style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, marginTop: 16 }}>
        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Quote inputs</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Quote mode<br />
              <select name="quoteMode" defaultValue={form.quoteMode} style={inputStyle}>
                <option value="estimated">Estimated quote - no customer art yet</option>
                <option value="actual">Actual GSOQ RIP quote - artwork is ready</option>
              </select>
              <div style={smallHelp}>Estimated uses ink/sqft profiles. Actual uses synced GSOQ RIP ink.</div>
            </label>
            <label>Target margin %<br /><input name="targetMarginPct" type="number" step="0.1" defaultValue={form.targetMarginPct} style={inputStyle} /></label>
            <label>Labor $ / hour<br /><input name="laborRatePerHour" type="number" step="0.01" defaultValue={form.laborRatePerHour} style={inputStyle} /></label>
            <label>Machine $ / hour<br /><input name="machineCostPerHour" type="number" step="0.01" defaultValue={form.machineCostPerHour} style={inputStyle} /></label>
            <label>Setup minutes<br /><input name="setupMinutes" type="number" step="0.1" defaultValue={form.setupMinutes} style={inputStyle} /></label>
            <label>Finishing minutes<br /><input name="finishingMinutes" type="number" step="0.1" defaultValue={form.finishingMinutes} style={inputStyle} /></label>
          </div>

          <h3>Label / print lines</h3>
          <input type="hidden" name="lineCount" value={form.lineCount} />
          <div style={{ display: "grid", gap: 12 }}>
            {form.lines.map((line) => (
              <div key={line.index} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f9fafb" }}>
                <h4 style={{ margin: "0 0 10px" }}>Line {line.index + 1}: {line.name}</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr", gap: 10 }}>
                  <label>Label name<br /><input name="lineName" defaultValue={line.name} style={inputStyle} /></label>
                  <label>Qty<br /><input name="lineQty" type="number" defaultValue={line.quantity} style={inputStyle} /></label>
                  <label>Width in<br /><input name="lineWidthIn" type="number" step="0.01" defaultValue={line.widthIn} style={inputStyle} /></label>
                  <label>Height in<br /><input name="lineHeightIn" type="number" step="0.01" defaultValue={line.heightIn} style={inputStyle} /></label>
                  <label style={{ gridColumn: "1 / 3" }}>Material<br />
                    <select name="lineMaterialId" defaultValue={line.materialId} style={inputStyle}>
                      {materials.map((material) => <option key={material.id} value={material.id}>{material.name} - {money(materialSqftCost(material, 0))}/sqft</option>)}
                      <option value="custom">Custom one-time material price</option>
                    </select>
                  </label>
                  <label>Custom material $/sqft<br /><input name="lineCustomMaterialCostPerSqft" type="number" step="0.0001" defaultValue={line.customMaterialCostPerSqft} style={inputStyle} /></label>
                  <label>Waste %<br /><input name="lineWastePct" type="number" step="0.1" defaultValue={line.wastePct} style={inputStyle} /></label>
                  <label style={{ gridColumn: "1 / 3" }}>GSOQ RIP result for this line<br />
                    <select name="lineQuoteId" defaultValue={line.quoteId} style={inputStyle}>
                      {rows.length ? rows.map((row) => <option key={`${row.quoteId}-${row.fileName}`} value={row.quoteId}>{row.quoteId} - {row.fileName}</option>) : <option value="">No synced GSOQ results yet</option>}
                    </select>
                  </label>
                  <label>RIP mode<br />
                    <select name="lineRipResultMode" defaultValue={line.ripResultMode} style={inputStyle}>
                      <option value="per-piece">One piece/artboard</option>
                      <option value="full-job">Full production layout</option>
                    </select>
                  </label>
                  <label>Estimated ink profile<br />
                    <select name="lineInkEstimateProfile" defaultValue={line.inkEstimateProfile} style={inputStyle}>
                      <option value="light">Light CMYK - $0.12/sqft</option>
                      <option value="medium">Medium CMYK - $0.23/sqft</option>
                      <option value="heavy">Heavy CMYK - $0.38/sqft</option>
                      <option value="roland-gloss">Roland gloss - $0.35/sqft</option>
                      <option value="white-gloss">White + gloss - $0.55/sqft</option>
                      <option value="custom">Custom ink $/sqft</option>
                    </select>
                  </label>
                  <label>Custom ink $/sqft<br /><input name="lineCustomInkCostPerSqft" type="number" step="0.0001" defaultValue={line.customInkCostPerSqft} style={inputStyle} /></label>
                </div>
                <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
                  {num(line.baseSqft, 2)} base sqft · {num(line.wasteAdjustedSqft, 2)} waste sqft · {line.materialName} · material {money(line.materialCost)} · ink {money(line.inkCost)} ({line.inkSource})
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button name="lineCount" value={nextLineCount} type="submit" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" }}>+ Add label size</button>
            <button name="lineCount" value={removeLineCount} type="submit" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" }}>Remove last label</button>
          </div>

          <h3>Blank item / product being labeled</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Item mode<br />
              <select name="itemMode" defaultValue={form.itemMode} style={inputStyle}>
                <option value="none">No blank item</option>
                <option value="inventory">Use inventory/vendor item</option>
                <option value="custom">Custom one-time item</option>
              </select>
            </label>
            <label>Item qty<br /><input name="itemQty" type="number" defaultValue={form.itemQty} style={inputStyle} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Inventory item<br />
              <select name="itemId" defaultValue={form.itemId} style={inputStyle}>
                <option value="custom">Custom item</option>
                {blankItems.map((item) => <option key={item.id} value={item.id}>{item.name} - {money(item.unitCost)} each</option>)}
              </select>
            </label>
            <label>Custom item name<br /><input name="customItemName" defaultValue={form.customItemName} style={inputStyle} /></label>
            <label>Custom item unit cost<br /><input name="customItemUnitCost" type="number" step="0.0001" defaultValue={form.customItemUnitCost} style={inputStyle} /></label>
          </div>

          <h3>Application / finishing</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Application type<br />
              <select name="applicationMode" defaultValue={form.applicationMode} style={inputStyle}>
                <option value="none">No application</option>
                <option value="apply-one">Apply 1 label per item</option>
                <option value="apply-two">Apply 2 labels per item</option>
                <option value="custom">Custom application</option>
              </select>
            </label>
            <label>Application qty<br /><input name="applicationQty" type="number" defaultValue={form.applicationQty} style={inputStyle} /></label>
            <label>Seconds per unit<br /><input name="applicationSecondsPerUnit" type="number" step="0.1" defaultValue={form.applicationSecondsPerUnit} style={inputStyle} /></label>
            <label>Extra application $/unit<br /><input name="applicationUnitCost" type="number" step="0.0001" defaultValue={form.applicationUnitCost} style={inputStyle} /></label>
          </div>

          <button type="submit" style={{ marginTop: 16, width: "100%", background: "#111827", color: "white", border: 0, borderRadius: 10, padding: 14, fontWeight: 800 }}>Calculate quote cost</button>
        </section>

        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Estimate</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr><td>Quote mode</td><td align="right"><b>{form.quoteMode === "actual" ? "Actual GSOQ RIP" : "Estimated before art"}</b></td></tr>
              <tr><td>Label base sqft</td><td align="right">{num(calc.lineBaseSqft, 2)}</td></tr>
              <tr><td>Label waste sqft</td><td align="right">{num(calc.lineWasteAdjustedSqft, 2)}</td></tr>
              <tr><td>Calculated job ink cc</td><td align="right">{num(calc.lineInkCc, 2)}</td></tr>
              <tr><td>Label material cost</td><td align="right">{money(calc.lineMaterialCost)}</td></tr>
              <tr><td>Ink cost</td><td align="right">{money(calc.lineInkCost)}</td></tr>
              <tr><td>{calc.itemName}</td><td align="right">{calc.itemQty ? `${num(calc.itemQty, 0)} x ${money(calc.itemUnitCost)} = ${money(calc.itemCost)}` : money(0)}</td></tr>
              <tr><td>Application labor</td><td align="right">{num(calc.applicationLaborMinutes, 1)} min / {money(calc.applicationLaborCost)}</td></tr>
              <tr><td>Setup/finishing labor</td><td align="right">{money(calc.processLaborCost)}</td></tr>
              <tr><td>Machine/setup cost</td><td align="right">{money(calc.processMachineCost)}</td></tr>
              <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Total cost</b></td><td align="right"><b>{money(calc.totalCost)}</b></td></tr>
              <tr><td><b>Unit cost</b></td><td align="right"><b>{money(calc.unitCost)}</b></td></tr>
              <tr style={{ borderTop: "1px solid #e5e7eb" }}><td><b>Suggested total</b></td><td align="right"><b>{money(calc.suggestedTotal)}</b></td></tr>
              <tr><td><b>Suggested unit</b></td><td align="right"><b>{money(calc.suggestedUnit)}</b></td></tr>
              <tr><td>Gross profit</td><td align="right">{money(calc.grossProfit)}</td></tr>
            </tbody>
          </table>

          <h3>Line breakdown</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {form.lines.map((line) => (
              <div key={`summary-${line.index}`} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, fontSize: 13 }}>
                <b>{line.name}</b><br />
                {num(line.quantity, 0)} pcs · {num(line.widthIn, 2)} x {num(line.heightIn, 2)} in · {num(line.wasteAdjustedSqft, 2)} sqft with waste<br />
                Material {money(line.materialCost)} · Ink {money(line.inkCost)} · Line cost {money(line.totalCost)}
              </div>
            ))}
          </div>
        </section>
      </Form>

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
