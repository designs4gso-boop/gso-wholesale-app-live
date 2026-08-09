import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildBrandRates,
  computeEntryCosts,
  machineCost,
  machineRatePerHour,
  type BrandInkRates,
} from "../lib/rip-actual-costs.server";

function money(value: any) {
  return (Number(value) || 0).toFixed(2);
}

// 15G.2: the printable work order prices print-log actuals through the SAME
// canonical helpers as the Production Board and Actual Cost Dashboard —
// machineRatePerHour() ($8/hr owner standard) + canonical brand ink rates.
// The retired hardcoded machine/ink rate literals are gone; this page can
// never again show different actuals than the board for the same job.
function summarizeActualPrintLogs(job: any, entries: any[], brandRates: BrandInkRates[], ratePerHour: number) {
  const revenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const estimatedCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  const actualSqft = entries.reduce((sum, entry) => sum + Number(entry.sqft || 0), 0);
  const actualInkMl = entries.reduce((sum, entry) => sum + Number(entry.inkMl || 0), 0);
  const actualPrintMinutes = entries.reduce((sum, entry) => sum + Number(entry.printMinutes || 0), 0);
  const actualInkCost = entries.reduce((sum, entry) => {
    const costs = computeEntryCosts(
      {
        machineName: entry.machineName,
        printerSoftware: entry.printerSoftware,
        sourceJobName: entry.sourceJobName,
        cmykInkMl: Number(entry.cmykInkMl || 0),
        whiteInkMl: Number(entry.whiteInkMl || 0),
        glossInkMl: Number(entry.glossInkMl || 0),
        inkMl: Number(entry.inkMl || 0),
        printMinutes: Number(entry.printMinutes || 0),
      },
      brandRates,
    );
    return sum + Number(costs.inkCost || 0);
  }, 0);
  const actualMachineCost = machineCost(actualPrintMinutes, ratePerHour);
  const roughActualPrintCost = actualInkCost + actualMachineCost;
  return {
    entryCount: entries.length,
    actualSqft,
    actualInkMl,
    actualPrintMinutes,
    machineRatePerHourUsed: ratePerHour,
    roughActualPrintCost,
    conservativeProfitAfterLoggedPrintCost: revenue - estimatedCost - roughActualPrintCost,
  };
}

function summarizeMaterialUsage(usages: any[]) {
  const materialCost = usages.reduce((sum, usage) => sum + Number(usage.totalCost || 0), 0);
  const pulledQty = usages.reduce((sum, usage) => sum + Number(usage.pulledQty || 0), 0);
  const usedQty = usages.reduce((sum, usage) => sum + Number(usage.usedQty || 0), 0);
  const wasteQty = usages.reduce((sum, usage) => sum + Number(usage.wasteQty || 0), 0);
  const reprintQty = usages.reduce((sum, usage) => sum + Number(usage.reprintQty || 0), 0);
  return { materialCost, pulledQty, usedQty, wasteQty, reprintQty };
}

function summarizeFinalActualCosts(job: any) {
  const revenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const estimatedCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  const materialSummary = summarizeMaterialUsage(job.materialUsages || []);
  const printCost = Number(job.actuals?.roughActualPrintCost || 0);
  const materialCost = Number(materialSummary.materialCost || 0);
  const laborCost = Number(job.actualLaborCost || 0);
  const packingCost = Number(job.actualPackingCost || 0);
  const shippingCost = Number(job.actualShippingCost || 0);
  const outsourceCost = Number(job.actualOutsourceCost || 0);
  const otherCost = Number(job.actualOtherCost || 0);
  const reprintCost = Number(job.actualReprintCost || 0);
  const liveActualTotal = printCost + materialCost + laborCost + packingCost + shippingCost + outsourceCost + otherCost + reprintCost;
  const finalTotal = Number(job.actualTotalCost || 0) || liveActualTotal;
  const finalProfit = revenue - finalTotal;
  const finalMargin = revenue > 0 ? (finalProfit / revenue) * 100 : 0;
  return { revenue, estimatedCost, printCost, materialCost, laborCost, packingCost, shippingCost, outsourceCost, otherCost, reprintCost, finalTotal, finalProfit, finalMargin, variance: finalTotal - estimatedCost, materialSummary };
}

function validImageUrl(value: any) {
  const url = String(value || "").trim();
  if (!url || url === "PASTE_SHOPIFY_IMAGE_URL_HERE") return "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function parseJson(value: any) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

function configFromItem(item: any) {
  const selected = parseJson(item.selectedAddOns) || {};
  const materialSummary = String(item.materialSummary || item.productionNotes || "");
  const variantParts = String(item.variantTitle || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const productType = String(selected.productType || "");
  const productFamily = String(selected.productFamily || "");
  const isJar =
    productFamily.toLowerCase() === "jars" ||
    productType.startsWith("jar_") ||
    String(item.sku || "").toUpperCase().startsWith("JAR-") ||
    /Product Family:\s*Jars/i.test(materialSummary);

  const summaryValue = (label: string) => {
    const match = materialSummary.match(new RegExp(`${label}:\\s*([^|\\n]+)`, "i"));
    return match?.[1]?.trim() || "";
  };

  return {
    isJar,
    productFamily,
    productType,
    material: selected.material || variantParts[0] || "",
    finish: selected.finish || variantParts[1] || "",
    productionFinish: selected.productionFinish || item.selectedFinish || "",
    bagColor: selected.bagColor || variantParts[2] || "",
    sides: selected.sides || "",
    jarColor: selected.jarColor || summaryValue("Jar Color") || "",
    labelSet: selected.labelSet || summaryValue("Label Set") || "",
  };
}

function lineTotalForItem(item: any) {
  return Number(item.quantity || 0) * Number(item.unitPrice || 0);
}

function safeDate(value: any) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString();
}

function labelForStatus(status: string) {
  return String(status || "new").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function loader({ request, params }: { request: Request; params: any }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id;

  const job = await db.productionJob.findFirst({
    where: { shop, id },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      files: { orderBy: { createdAt: "desc" } },
      checklistItems: { orderBy: [{ section: "asc" }, { sortOrder: "asc" }] },
      events: { orderBy: { createdAt: "desc" }, take: 15 },
      materialUsages: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!job) throw new Response("Production job not found", { status: 404 });

  const [printLogEntries, machines] = await Promise.all([
    db.printLogEntry.findMany({
      where: { shop, productionJobId: job.id },
      orderBy: { createdAt: "desc" },
    }),
    db.machine.findMany({
      where: { shop, active: true },
      select: { name: true, inkChannels: { select: { inkType: true, inkName: true, enabled: true, costPerMl: true, cartridgeCost: true, cartridgeMl: true } } },
      take: 50,
    }),
  ]);

  const brandRates = buildBrandRates(machines);
  const ratePerHour = machineRatePerHour();

  return Response.json({ job: { ...job, actuals: summarizeActualPrintLogs(job, printLogEntries, brandRates, ratePerHour) } });
}

export default function PrintProductionJob() {
  const { job } = useLoaderData<any>();
  const productImage = validImageUrl(job.productImageUrl) || validImageUrl(job.items?.find((item: any) => validImageUrl(item.productImageUrl))?.productImageUrl);
  const totalRevenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const totalCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  const finalCosts = summarizeFinalActualCosts(job);

  return (
    <div>
      <style>{`
          body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
          .no-print { margin-bottom: 18px; }
          .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 16px; }
          .logo { font-size: 28px; font-weight: 800; letter-spacing: 1px; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
          .card { border: 1px solid #999; border-radius: 10px; padding: 14px; page-break-inside: avoid; }
          .label { font-size: 11px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
          h1, h2, h3 { margin: 0 0 8px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #888; padding: 8px; text-align: left; vertical-align: top; }
          th { background: #eee; }
          img.product { width: 160px; height: 160px; object-fit: cover; border: 1px solid #999; border-radius: 8px; }
          img.item-thumb { width: 78px; height: 78px; object-fit: cover; border: 1px solid #999; border-radius: 8px; background: #f7f7f7; }
          .muted { color: #555; }
          .checkline { margin: 8px 0; }
          @media print { .no-print { display: none; } body { margin: 12px; } }
        `}</style>
        <div className="no-print">
          <button onClick={() => window.print()} style={{ padding: "10px 16px", fontSize: 16 }}>Print Work Order</button>
        </div>

        <div className="header">
          <div>
            <div className="logo">GSO PACKAGING</div>
            <h1>Production Work Order</h1>
            <div className="muted">Job Ticket: {job.jobTicket || job.id}</div>
            <div className="muted">Job ID: {job.id}</div>
            <div className="muted">Quote ID: {job.quoteId || "N/A"}</div>
          </div>
          <div>
            {productImage ? <img className="product" src={productImage} alt="Product" /> : <div className="card" style={{ width: 160, height: 160 }}>No product image</div>}
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <div className="label">Customer</div>
            <h2>{job.company || job.customerName || "Unknown"}</h2>
            <div>{job.customerName || ""}</div>
            <div>{job.email || ""}</div>
            <div>{job.phone || ""}</div>
          </div>
          <div className="card">
            <div className="label">Production Details</div>
            <div><strong>Status:</strong> {labelForStatus(job.status)}</div>
            <div><strong>Priority:</strong> {job.priority}</div>
            <div><strong>Due date:</strong> {safeDate(job.dueDate)}</div>
            <div><strong>Assigned:</strong> {job.assignedTo || "Unassigned"}</div>
            <div><strong>Asset folder:</strong> {job.assetFolderUrl || "Not linked"}</div>
            <div><strong>Source folder:</strong> {job.sourceFolderUrl || "Not linked"}</div>
            <div><strong>Printed:</strong> {new Date().toLocaleString()}</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h2>Items / Variants</h2>
          <table>
            <thead>
              <tr>
                <th>Image</th>
                <th>Ticket / RIP Name</th>
                <th>Product</th>
                <th>Variant / SKU</th>
                <th>Qty</th>
                <th>Configuration / Price</th>
                <th>Recipe</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(job.items || []).map((item: any) => (
                <tr key={item.id}>
                  <td>{validImageUrl(item.productImageUrl) ? <img className="item-thumb" src={validImageUrl(item.productImageUrl)} alt={item.productTitle || "Item"} /> : <span className="muted">No image</span>}</td>
                  <td>{item.itemTicket || "Not assigned"}<br />{item.ripJobName || item.itemTicket || ""}</td>
                  <td>{item.productTitle}<br /><small>{item.suggestedFileName || ""}</small></td>
                  <td>{item.variantTitle || ""}<br />{item.sku || ""}</td>
                  <td>{item.quantity}</td>
                  <td>
                    {(() => {
                      const config = configFromItem(item);
                      return (
                        <div>
                          <strong>Material:</strong> {config.material || "N/A"}<br />
                          <strong>Finish:</strong> {config.finish || "N/A"}<br />
                          {config.isJar ? (
                            <>
                              <strong>Label Set:</strong> {config.labelSet || "N/A"}<br />
                              {config.jarColor ? <><strong>Jar Color:</strong> {config.jarColor}<br /></> : null}
                              <strong>Production:</strong> {config.productionFinish || "N/A"}<br />
                            </>
                          ) : (
                            <>
                              <strong>Production:</strong> {config.productionFinish || "N/A"}<br />
                              <strong>Bag Color:</strong> {config.bagColor || "N/A"}<br />
                              <strong>Sides:</strong> {config.sides || "N/A"}<br />
                            </>
                          )}
                          <strong>Unit:</strong> ${money(item.unitPrice)}<br />
                          <strong>Total:</strong> ${money(lineTotalForItem(item))}
                        </div>
                      );
                    })()}
                  </td>
                  <td>{item.recipeName || item.recipeId || ""}</td>
                  <td>{item.productionNotes || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid">
          <div className="card">
            <h2>Files</h2>
            <div><strong>Job ticket:</strong> {job.jobTicket || job.id}</div>
            <div><strong>Recommended folder:</strong> {job.jobTicket ? `${job.jobTicket} - ${job.company || job.customerName || "Customer"}` : "Not assigned"}</div>
            <div><strong>Artwork:</strong> {job.artworkUrl || "Not linked"}</div>
            <div><strong>Proof:</strong> {job.proofUrl || "Not linked"}</div>
            <div><strong>Print file:</strong> {job.printFileUrl || "Not linked"}</div>
            {(job.files || []).map((file: any) => (
              <div key={file.id}>{file.fileType}: {file.fileName} - {file.fileUrl}</div>
            ))}
          </div>
          <div className="card">
            <h2>Totals</h2>
            <div><strong>Revenue:</strong> ${money(totalRevenue)}</div>
            <div><strong>Estimated cost:</strong> ${money(totalCost)}</div>
            <div><strong>Estimated profit:</strong> ${money(totalRevenue - totalCost)}</div>
            <hr />
            <h3>Actual Print Log Summary</h3>
            <div><strong>Matched print logs:</strong> {job.actuals?.entryCount || 0}</div>
            <div><strong>Actual sqft:</strong> {Number(job.actuals?.actualSqft || 0).toFixed(2)}</div>
            <div><strong>Actual ink:</strong> {Number(job.actuals?.actualInkMl || 0).toFixed(2)} ml</div>
            <div><strong>Actual print time:</strong> {Number(job.actuals?.actualPrintMinutes || 0).toFixed(2)} min</div>
            <div><strong>Machine rate:</strong> ${money(job.actuals?.machineRatePerHourUsed)}/hr (owner standard)</div>
            <div><strong>Rough print cost:</strong> ${money(job.actuals?.roughActualPrintCost)}</div>
            <div><strong>Conservative profit after logged print cost:</strong> ${money(job.actuals?.conservativeProfitAfterLoggedPrintCost)}</div>
            <hr />
            <h3>Final Job Cost</h3>
            <div><strong>Status:</strong> {job.actualCostFinalized ? "Finalized" : "Open"}</div>
            <div><strong>Actual material:</strong> ${money(finalCosts.materialCost)}</div>
            <div><strong>Labor:</strong> ${money(finalCosts.laborCost)}</div>
            <div><strong>Packing:</strong> ${money(finalCosts.packingCost)}</div>
            <div><strong>Shipping:</strong> ${money(finalCosts.shippingCost)}</div>
            <div><strong>Outsource:</strong> ${money(finalCosts.outsourceCost)}</div>
            <div><strong>Reprint / other:</strong> ${money(finalCosts.reprintCost + finalCosts.otherCost)}</div>
            <div><strong>Final actual cost:</strong> ${money(finalCosts.finalTotal)}</div>
            <div><strong>Final profit:</strong> ${money(finalCosts.finalProfit)}</div>
            <div><strong>Final margin:</strong> {Number(finalCosts.finalMargin || 0).toFixed(1)}%</div>
            {job.actualCostFinalizedAt ? <div><strong>Finalized:</strong> {new Date(job.actualCostFinalizedAt).toLocaleString()}</div> : null}
            {job.actualCostNotes ? <div><strong>Cost notes:</strong> {job.actualCostNotes}</div> : null}
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h2>Production Checklist</h2>
            {(job.checklistItems || []).map((check: any) => (
              <div className="checkline" key={check.id}>[ {check.completed ? "X" : " "} ] {check.section}: {check.label}</div>
            ))}
          </div>
          <div className="card">
            <h2>Notes</h2>
            <div><strong>Internal:</strong><br />{job.internalNotes || ""}</div>
            <br />
            <div><strong>Customer:</strong><br />{job.customerNotes || ""}</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h2>Recent Events</h2>
          {(job.events || []).map((event: any) => (
            <div key={event.id}>{new Date(event.createdAt).toLocaleString()} - {event.message}</div>
          ))}
        </div>
    </div>
  );
}


