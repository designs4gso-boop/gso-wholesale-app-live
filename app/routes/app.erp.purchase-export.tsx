import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
} from "@shopify/polaris";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function num(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value: any) {
  return (num(value) || 0).toFixed(2);
}

function qty(value: any) {
  return (num(value) || 0).toFixed(2).replace(/\.00$/, "");
}

function safeDate(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

function csvEscape(value: any) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function vendorName(request: any) {
  return request.vendorRecord?.name || request.vendor || "Vendor TBD";
}

function vendorEmail(request: any) {
  return request.vendorRecord?.email || "";
}

function requestTotal(request: any) {
  return (num(request.orderedQty) || num(request.requestedQty)) * num(request.unitCost);
}

function buildCsv(requests: any[]) {
  const headers = [
    "Request Number",
    "Status",
    "Priority",
    "Material / Item",
    "SKU",
    "Vendor",
    "Vendor Email",
    "Vendor SKU",
    "Requested Qty",
    "Ordered Qty",
    "Received Qty",
    "Unit",
    "Unit Cost",
    "Estimated Cost",
    "Needed By",
    "Lead Time Days",
    "Notes",
  ];
  const rows = requests.map((request) => [
    request.requestNumber,
    request.status,
    request.priority,
    request.materialName,
    request.sku || "",
    vendorName(request),
    vendorEmail(request),
    request.vendorSku || "",
    request.requestedQty || 0,
    request.orderedQty || 0,
    request.receivedQty || 0,
    request.unit || "each",
    request.unitCost || 0,
    request.estimatedCost || requestTotal(request),
    request.neededBy ? new Date(request.neededBy).toISOString().slice(0, 10) : "",
    request.leadTimeDays || "",
    request.notes || "",
  ]);
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function buildEmailBody(request: any) {
  const orderedQty = num(request.orderedQty) || num(request.requestedQty);
  return [
    `Hello ${request.vendorRecord?.contactName || vendorName(request)},`,
    "",
    "Please confirm pricing, availability, and lead time for the purchase request below.",
    "",
    `PO / Request: ${request.requestNumber}`,
    `Item: ${request.materialName}`,
    `SKU: ${request.sku || "N/A"}`,
    `Vendor SKU: ${request.vendorSku || "N/A"}`,
    `Quantity: ${qty(orderedQty)} ${request.unit || "each"}`,
    `Unit Cost: $${money(request.unitCost)}`,
    `Estimated Total: $${money(request.estimatedCost || requestTotal(request))}`,
    request.neededBy ? `Needed By: ${safeDate(request.neededBy)}` : "Needed By: Please confirm earliest available date",
    request.leadTimeDays ? `Expected Lead Time: ${request.leadTimeDays} day(s)` : "Expected Lead Time: Please confirm",
    "",
    request.notes ? `Notes: ${request.notes}` : "Notes: Please include shipping cost and any MOQ/setup charges in your confirmation.",
    "",
    "Thank you,",
    "GSO Packaging",
  ].join("\n");
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const format = url.searchParams.get("format");
  const status = url.searchParams.get("status") || "";

  const where: any = { shop };
  if (id) where.id = id;
  if (!id && status) where.status = status;

  const purchaseRequests = await db.purchaseRequest.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    include: { vendorRecord: true },
  });

  if (format === "csv") {
    const csv = buildCsv(purchaseRequests);
    const filename = id ? `gso-po-${purchaseRequests[0]?.requestNumber || id}.csv` : "gso-purchase-requests.csv";
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const selectedRequest = id ? purchaseRequests[0] || null : null;
  return Response.json({ purchaseRequests, selectedRequest, emailBody: selectedRequest ? buildEmailBody(selectedRequest) : "" });
}

function PurchaseOrderDocument({ request, emailBody }: { request: any; emailBody: string }) {
  const orderedQty = num(request.orderedQty) || num(request.requestedQty);
  const total = request.estimatedCost || requestTotal(request);
  const mailto = vendorEmail(request)
    ? `mailto:${encodeURIComponent(vendorEmail(request))}?subject=${encodeURIComponent(`GSO Purchase Request ${request.requestNumber}`)}&body=${encodeURIComponent(emailBody)}`
    : "";

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="h2" variant="headingLg">GSO PURCHASE ORDER</Text>
            <Text as="p" tone="subdued">Request / PO: {request.requestNumber}</Text>
            <InlineStack gap="200">
              <Badge tone="attention">{request.status}</Badge>
              <Badge>{request.priority}</Badge>
            </InlineStack>
          </BlockStack>
          <InlineStack gap="200">
            <Button onClick={() => window.print()}>Print / Save PDF</Button>
            <Button url={`/app/erp/purchase-export?id=${request.id}&format=csv`}>Download CSV</Button>
            {mailto ? <Button url={mailto}>Open Email</Button> : null}
          </InlineStack>
        </InlineStack>

        <Divider />

        <InlineStack gap="400" align="start" wrap>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Card>
              <BlockStack gap="150">
                <Text as="h3" variant="headingMd">Vendor</Text>
                <Text as="p"><strong>{vendorName(request)}</strong></Text>
                {request.vendorRecord?.contactName ? <Text as="p">Contact: {request.vendorRecord.contactName}</Text> : null}
                {vendorEmail(request) ? <Text as="p">Email: {vendorEmail(request)}</Text> : null}
                {request.vendorRecord?.phone ? <Text as="p">Phone: {request.vendorRecord.phone}</Text> : null}
                {request.vendorRecord?.paymentTerms ? <Text as="p">Terms: {request.vendorRecord.paymentTerms}</Text> : null}
                {request.vendorRecord?.address1 ? <Text as="p">{request.vendorRecord.address1} {request.vendorRecord.address2 || ""}<br />{request.vendorRecord.city || ""} {request.vendorRecord.state || ""} {request.vendorRecord.zip || ""}</Text> : null}
              </BlockStack>
            </Card>
          </div>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Card>
              <BlockStack gap="150">
                <Text as="h3" variant="headingMd">Ship / Receive</Text>
                <Text as="p"><strong>GSO Packaging</strong></Text>
                <Text as="p">Receive into material inventory when delivered.</Text>
                <Text as="p">Needed by: {safeDate(request.neededBy) || "Please confirm"}</Text>
                <Text as="p">Lead time: {request.leadTimeDays ? `${request.leadTimeDays} day(s)` : "Please confirm"}</Text>
              </BlockStack>
            </Card>
          </div>
        </InlineStack>

        <Card>
          <BlockStack gap="250">
            <Text as="h3" variant="headingMd">Order Line</Text>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Item</th>
                    <th style={th}>SKU</th>
                    <th style={th}>Vendor SKU</th>
                    <th style={th}>Qty</th>
                    <th style={th}>Unit</th>
                    <th style={th}>Unit Cost</th>
                    <th style={th}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={td}>{request.materialName}</td>
                    <td style={td}>{request.sku || ""}</td>
                    <td style={td}>{request.vendorSku || ""}</td>
                    <td style={td}>{qty(orderedQty)}</td>
                    <td style={td}>{request.unit || "each"}</td>
                    <td style={td}>${money(request.unitCost)}</td>
                    <td style={td}>${money(total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {request.notes ? <Text as="p"><strong>Notes:</strong> {request.notes}</Text> : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">Vendor Email Draft</Text>
            <textarea
              readOnly
              value={emailBody}
              rows={13}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #bbb", fontFamily: "monospace" }}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Text as="p" tone="subdued">Click in the box to select all, then copy/paste into email if the Open Email button does not launch your mail app.</Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Card>
  );
}

const th = { border: "1px solid #999", padding: 8, background: "#eee", textAlign: "left" as const };
const td = { border: "1px solid #999", padding: 8, verticalAlign: "top" as const };

export default function PurchaseExportPage() {
  const { purchaseRequests, selectedRequest, emailBody } = useLoaderData<any>();
  const navigate = useNavigate();
  const openRequests = purchaseRequests.filter((request: any) => !["received", "cancelled"].includes(request.status));

  return (
    <Page
      title="Purchase Export"
      subtitle="Print purchase orders, download CSVs, and copy vendor email drafts from PO requests."
      primaryAction={{ content: "Open PO Requests", onAction: () => navigate("/app/erp/purchase-requests") }}
      secondaryActions={[{ content: "Download Open CSV", url: "/app/erp/purchase-export?format=csv" }]}
    >
      <style>{`@media print { body { background: white !important; } .Polaris-Frame__Navigation, .Polaris-TopBar, button { display: none !important; } }`}</style>
      <Layout>
        <Layout.Section>
          {selectedRequest ? (
            <PurchaseOrderDocument request={selectedRequest} emailBody={emailBody} />
          ) : (
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Purchase exports</Text>
                    <Text as="p" tone="subdued">Choose a request below to print a PO, copy a vendor email, or download CSV data.</Text>
                  </BlockStack>
                  <Badge tone="attention">{openRequests.length} open</Badge>
                </InlineStack>
                <Divider />
                {purchaseRequests.length ? purchaseRequests.map((request: any) => (
                  <Card key={request.id}>
                    <InlineStack align="space-between" blockAlign="center" wrap>
                      <BlockStack gap="050">
                        <Text as="p" fontWeight="bold">{request.requestNumber} - {request.materialName}</Text>
                        <Text as="p" tone="subdued">Vendor: {vendorName(request)} | Qty: {qty(num(request.orderedQty) || num(request.requestedQty))} {request.unit || "each"} | Est: ${money(request.estimatedCost || requestTotal(request))}</Text>
                      </BlockStack>
                      <InlineStack gap="150">
                        <Badge>{request.status}</Badge>
                        <Button url={`/app/erp/purchase-export?id=${request.id}`}>Open PO</Button>
                        <Button url={`/app/erp/purchase-export?id=${request.id}&format=csv`}>CSV</Button>
                      </InlineStack>
                    </InlineStack>
                  </Card>
                )) : <Text as="p" tone="subdued">No purchase requests yet.</Text>}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
