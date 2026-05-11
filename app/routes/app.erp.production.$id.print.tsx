import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function money(value: any) {
  return (Number(value) || 0).toFixed(2);
}

const ROLAND_INK_COST_PER_ML = 156.99 / 750;
const MIMAKI_INK_COST_PER_ML = 190 / 1000;
const DEFAULT_MACHINE_RECOVERY_PER_HOUR = 5;

function inkCostRateForEntry(entry: any) {
  const text = `${entry?.printerSoftware || ""} ${entry?.machineName || ""}`.toLowerCase();
  if (text.includes("mimaki") || text.includes("raster")) return MIMAKI_INK_COST_PER_ML;
  return ROLAND_INK_COST_PER_ML;
}

function summarizeActualPrintLogs(job: any, entries: any[]) {
  const revenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const estimatedCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  const actualSqft = entries.reduce((sum, entry) => sum + Number(entry.sqft || 0), 0);
  const actualInkMl = entries.reduce((sum, entry) => sum + Number(entry.inkMl || 0), 0);
  const actualPrintMinutes = entries.reduce((sum, entry) => sum + Number(entry.printMinutes || 0), 0);
  const actualInkCost = entries.reduce((sum, entry) => sum + Number(entry.inkMl || 0) * inkCostRateForEntry(entry), 0);
  const actualMachineCost = (actualPrintMinutes / 60) * DEFAULT_MACHINE_RECOVERY_PER_HOUR;
  const roughActualPrintCost = actualInkCost + actualMachineCost;
  return {
    entryCount: entries.length,
    actualSqft,
    actualInkMl,
    actualPrintMinutes,
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
  const wastePct = usedQty > 0 ? (wasteQty / usedQty) * 100 : 0;
  return { materialCost, pulledQty, usedQty, wasteQty, reprintQty, wastePct };
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
      materialUsages: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 15 },
    },
  });

  if (!job) throw new Response("Production job not found", { status: 404 });

  const printLogEntries = await db.printLogEntry.findMany({
    where: { shop, productionJobId: job.id },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ job: { ...job, actuals: summarizeActualPrintLogs(job, printLogEntries) } });
}

export default function PrintProductionJob() {
  const { job } = useLoaderData<any>();
  const productImage = job.productImageUrl || job.items?.find((item: any) => item.productImageUrl)?.productImageUrl;
  const totalRevenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const totalCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  const materialSummary = summarizeMaterialUsage(job.materialUsages || []);

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
                <th>Ticket / RIP Name</th>
                <th>Product</th>
                <th>Variant / SKU</th>
                <th>Qty</th>
                <th>Finish / Add-ons</th>
                <th>Recipe</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(job.items || []).map((item: any) => (
                <tr key={item.id}>
                  <td>{item.itemTicket || "Not assigned"}<br />{item.ripJobName || item.itemTicket || ""}</td>
                  <td>{item.productTitle}<br /><small>{item.suggestedFileName || ""}</small></td>
                  <td>{item.variantTitle || ""}<br />{item.sku || ""}</td>
                  <td>{item.quantity}</td>
                  <td>{item.selectedFinish || item.selectedAddOns || ""}</td>
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
            <div><strong>Rough print cost:</strong> ${money(job.actuals?.roughActualPrintCost)}</div>
            <div><strong>Actual material cost:</strong> ${money(materialSummary.materialCost)}</div>
            <div><strong>Profit after logged print + material cost:</strong> ${money(Number(job.actuals?.conservativeProfitAfterLoggedPrintCost || 0) - materialSummary.materialCost)}</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h2>Material Usage + Waste</h2>
          <div><strong>Total material cost:</strong> ${money(materialSummary.materialCost)}</div>
          <div><strong>Pulled:</strong> {Number(materialSummary.pulledQty || 0).toFixed(2)} | <strong>Used:</strong> {Number(materialSummary.usedQty || 0).toFixed(2)} | <strong>Waste:</strong> {Number(materialSummary.wasteQty || 0).toFixed(2)} | <strong>Reprint:</strong> {Number(materialSummary.reprintQty || 0).toFixed(2)} | <strong>Waste %:</strong> {Number(materialSummary.wastePct || 0).toFixed(1)}%</div>
          {(job.materialUsages || []).length ? (
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Type</th>
                  <th>Unit</th>
                  <th>Est</th>
                  <th>Pulled</th>
                  <th>Used</th>
                  <th>Waste</th>
                  <th>Reprint</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {(job.materialUsages || []).map((usage: any) => (
                  <tr key={usage.id}>
                    <td>{usage.materialName}</td>
                    <td>{usage.materialType || ""}</td>
                    <td>{usage.unit}</td>
                    <td>{Number(usage.estimatedQty || 0).toFixed(2)}</td>
                    <td>{Number(usage.pulledQty || 0).toFixed(2)}</td>
                    <td>{Number(usage.usedQty || 0).toFixed(2)}</td>
                    <td>{Number(usage.wasteQty || 0).toFixed(2)}</td>
                    <td>{Number(usage.reprintQty || 0).toFixed(2)}</td>
                    <td>${money(usage.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div>No material usage logged yet.</div>
          )}
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
