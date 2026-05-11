import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  TextField,
  Divider,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Requested", value: "requested" },
  { label: "Ordered", value: "ordered" },
  { label: "Partially Received", value: "partially_received" },
  { label: "Received", value: "received" },
  { label: "Cancelled", value: "cancelled" },
];

const priorityOptions = [
  { label: "Low", value: "low" },
  { label: "Normal", value: "normal" },
  { label: "Rush", value: "rush" },
  { label: "Critical", value: "critical" },
];

function num(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function qty(value: any) {
  return (num(value) || 0).toFixed(2).replace(/\.00$/, "");
}

function money(value: any) {
  return (num(value) || 0).toFixed(2);
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function safeDateInput(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function materialStatus(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  if (stock <= 0 && reorderPoint > 0) return "out_of_stock";
  if (reorderPoint > 0 && stock <= reorderPoint) return "low_stock";
  return "ok";
}

function preferredMaterialVendor(material: any) {
  return material.primaryVendor || material.vendors?.find((vendor: any) => vendor.preferred) || material.vendors?.[0] || null;
}

function suggestedReorderQty(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  const recentUsage = (material.inventoryMovements || [])
    .filter((movement: any) => num(movement.quantity) < 0)
    .reduce((sum: number, movement: any) => sum + Math.abs(num(movement.quantity)), 0);
  const leadTimeDays = num(material.leadTimeDays) || preferredMaterialVendor(material)?.leadTimeDays || 7;
  const averageDailyUsage = recentUsage > 0 ? recentUsage / 30 : 0;
  const leadTimeCoverage = averageDailyUsage * leadTimeDays;
  const targetStock = Math.max(reorderPoint * 2, reorderPoint + leadTimeCoverage, recentUsage || reorderPoint || 1);
  return Math.max(0, targetStock - stock);
}

async function nextRequestNumber(shop: string) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `GSO-PO-${today}`;
  const countToday = await db.purchaseRequest.count({
    where: { shop, requestNumber: { startsWith: prefix } },
  });
  return `${prefix}-${String(countToday + 1).padStart(4, "0")}`;
}

async function getVendor(shop: string, vendorId: string | null | undefined) {
  if (!vendorId) return null;
  return db.vendor.findFirst({
    where: { shop, id: vendorId, active: true },
    include: { contacts: { where: { active: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] } },
  });
}

async function createInventoryMovementForReceipt(shop: string, purchaseRequest: any, receiveQty: number, notes: string) {
  if (!purchaseRequest.materialId || receiveQty <= 0) return;

  const material = await db.material.findFirst({ where: { shop, id: purchaseRequest.materialId } });
  if (!material) return;

  const beforeQty = num(material.stockOnHand);
  const afterQty = beforeQty + receiveQty;
  const costPerUnit = num(purchaseRequest.unitCost) || material.calculatedUnitCost || material.costPerUnit || 0;

  await db.material.update({
    where: { id: material.id },
    data: { stockOnHand: afterQty },
  });

  await db.materialInventoryMovement.create({
    data: {
      shop,
      materialId: material.id,
      movementType: "purchase",
      quantity: receiveQty,
      unit: purchaseRequest.unit || material.unit || material.baseUnit || "each",
      beforeQty,
      afterQty,
      costPerUnit,
      costImpact: receiveQty * costPerUnit,
      source: "purchase_request",
      reference: purchaseRequest.requestNumber,
      notes: notes || `Received from purchase request ${purchaseRequest.requestNumber}.`,
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [purchaseRequests, materials, vendors] = await Promise.all([
    db.purchaseRequest.findMany({
      where: { shop },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 150,
      include: { vendorRecord: true },
    }),
    db.material.findMany({
      where: { shop, active: true },
      orderBy: [{ materialType: "asc" }, { name: "asc" }],
      include: {
        primaryVendor: true,
        vendors: {
          where: { active: true },
          orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
          take: 3,
        },
        inventoryMovements: {
          where: { createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    db.vendor.findMany({
      where: { shop, active: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { contacts: { where: { active: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] } },
    }),
  ]);

  const lowStockMaterials = materials.filter((material: any) => ["out_of_stock", "low_stock"].includes(materialStatus(material)));
  const openRequests = purchaseRequests.filter((req: any) => !["received", "cancelled"].includes(req.status));
  const orderedRequests = purchaseRequests.filter((req: any) => ["ordered", "partially_received"].includes(req.status));
  const receivedRequests = purchaseRequests.filter((req: any) => req.status === "received");

  return Response.json({ purchaseRequests, materials, vendors, lowStockMaterials, openRequests, orderedRequests, receivedRequests });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "createFromMaterial") {
    const materialId = String(formData.get("materialId") || "");
    const material = await db.material.findFirst({
      where: { shop, id: materialId },
      include: {
        primaryVendor: true,
        vendors: { where: { active: true }, orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }], take: 1 },
      },
    });
    if (!material) return Response.json({ ok: false, message: "Material not found." }, { status: 404 });

    const materialVendor = material.vendors?.[0];
    const vendorRecord = material.primaryVendor || (await getVendor(shop, String(formData.get("vendorId") || "")));
    const requestedQty = num(formData.get("requestedQty")) || suggestedReorderQty(material) || num(material.reorderPoint) || 1;
    const unitCost = materialVendor?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0;
    const leadTimeDays = vendorRecord?.leadTimeDays || materialVendor?.leadTimeDays || material.leadTimeDays || null;
    const neededBy = leadTimeDays ? addDays(Number(leadTimeDays)) : null;

    const existingOpen = await db.purchaseRequest.findFirst({
      where: { shop, materialId: material.id, status: { in: ["draft", "requested", "ordered", "partially_received"] } },
      orderBy: { updatedAt: "desc" },
    });

    if (existingOpen) {
      return Response.json({ ok: true, message: `Open request already exists: ${existingOpen.requestNumber}.` });
    }

    const requestNumber = await nextRequestNumber(shop);
    await db.purchaseRequest.create({
      data: {
        shop,
        requestNumber,
        status: "requested",
        priority: materialStatus(material) === "out_of_stock" ? "rush" : "normal",
        materialId: material.id,
        materialName: material.name,
        materialType: material.materialType,
        unit: material.unit || material.baseUnit || "each",
        sku: material.sku || null,
        vendorId: vendorRecord?.id || null,
        vendor: vendorRecord?.name || materialVendor?.vendorName || material.vendor || null,
        vendorSku: materialVendor?.vendorSku || material.sku || null,
        moq: materialVendor?.moq || null,
        leadTimeDays,
        requestedQty,
        orderedQty: requestedQty,
        unitCost,
        estimatedCost: requestedQty * unitCost,
        neededBy,
        source: "reorder_report",
        notes: String(formData.get("notes") || "Created from low-stock material."),
      },
    });

    return Response.json({ ok: true, message: `Purchase request ${requestNumber} created.` });
  }

  if (intent === "createManual") {
    const requestNumber = await nextRequestNumber(shop);
    const requestedQty = num(formData.get("requestedQty"));
    const unitCost = num(formData.get("unitCost"));
    const materialId = String(formData.get("materialId") || "");
    const material = materialId ? await db.material.findFirst({ where: { shop, id: materialId }, include: { primaryVendor: true } }) : null;
    const selectedVendor = await getVendor(shop, String(formData.get("vendorId") || "") || material?.primaryVendorId || "");
    const neededByRaw = String(formData.get("neededBy") || "");
    const leadTimeDays = Math.round(num(formData.get("leadTimeDays"))) || selectedVendor?.leadTimeDays || material?.leadTimeDays || null;

    await db.purchaseRequest.create({
      data: {
        shop,
        requestNumber,
        status: String(formData.get("status") || "requested"),
        priority: String(formData.get("priority") || "normal"),
        materialId: material?.id || null,
        materialName: String(formData.get("materialName") || material?.name || "Manual purchase item"),
        materialType: material?.materialType || null,
        unit: String(formData.get("unit") || material?.unit || material?.baseUnit || "each"),
        sku: String(formData.get("sku") || material?.sku || "") || null,
        vendorId: selectedVendor?.id || null,
        vendor: selectedVendor?.name || String(formData.get("vendor") || material?.vendor || "") || null,
        vendorSku: String(formData.get("vendorSku") || material?.sku || "") || null,
        leadTimeDays,
        requestedQty,
        orderedQty: requestedQty,
        unitCost,
        estimatedCost: requestedQty * unitCost,
        neededBy: neededByRaw ? new Date(`${neededByRaw}T12:00:00`) : null,
        source: "manual",
        notes: String(formData.get("notes") || "") || null,
      },
    });

    return Response.json({ ok: true, message: `Purchase request ${requestNumber} created.` });
  }

  if (intent === "updateRequest") {
    const id = String(formData.get("id") || "");
    const purchaseRequest = await db.purchaseRequest.findFirst({ where: { shop, id } });
    if (!purchaseRequest) return Response.json({ ok: false, message: "Purchase request not found." }, { status: 404 });

    const requestedQty = num(formData.get("requestedQty"));
    const orderedQty = num(formData.get("orderedQty"));
    const unitCost = num(formData.get("unitCost"));
    const status = String(formData.get("status") || purchaseRequest.status);
    const neededByRaw = String(formData.get("neededBy") || "");
    const selectedVendor = await getVendor(shop, String(formData.get("vendorId") || ""));

    await db.purchaseRequest.update({
      where: { id },
      data: {
        status,
        priority: String(formData.get("priority") || purchaseRequest.priority),
        vendorId: selectedVendor?.id || null,
        vendor: selectedVendor?.name || String(formData.get("vendor") || "") || null,
        vendorSku: String(formData.get("vendorSku") || "") || null,
        leadTimeDays: Math.round(num(formData.get("leadTimeDays"))) || selectedVendor?.leadTimeDays || null,
        requestedQty,
        orderedQty,
        unitCost,
        estimatedCost: orderedQty * unitCost,
        neededBy: neededByRaw ? new Date(`${neededByRaw}T12:00:00`) : null,
        orderedAt: status === "ordered" && !purchaseRequest.orderedAt ? new Date() : purchaseRequest.orderedAt,
        cancelledAt: status === "cancelled" ? new Date() : purchaseRequest.cancelledAt,
        notes: String(formData.get("notes") || "") || null,
      },
    });

    return Response.json({ ok: true, message: "Purchase request updated." });
  }

  if (intent === "markOrdered") {
    const id = String(formData.get("id") || "");
    await db.purchaseRequest.updateMany({ where: { shop, id }, data: { status: "ordered", orderedAt: new Date() } });
    return Response.json({ ok: true, message: "Purchase request marked ordered." });
  }

  if (intent === "receiveRequest") {
    const id = String(formData.get("id") || "");
    const receiveQty = num(formData.get("receiveQty"));
    const purchaseRequest = await db.purchaseRequest.findFirst({ where: { shop, id } });
    if (!purchaseRequest) return Response.json({ ok: false, message: "Purchase request not found." }, { status: 404 });
    if (receiveQty <= 0) return Response.json({ ok: false, message: "Receive quantity must be greater than zero." }, { status: 400 });

    const receivedQty = num(purchaseRequest.receivedQty) + receiveQty;
    const orderedQty = num(purchaseRequest.orderedQty) || num(purchaseRequest.requestedQty);
    const status = receivedQty >= orderedQty ? "received" : "partially_received";

    await db.purchaseRequest.update({
      where: { id: purchaseRequest.id },
      data: { receivedQty, status, receivedAt: status === "received" ? new Date() : purchaseRequest.receivedAt },
    });

    await createInventoryMovementForReceipt(shop, purchaseRequest, receiveQty, String(formData.get("notes") || ""));

    return Response.json({ ok: true, message: `${qty(receiveQty)} ${purchaseRequest.unit} received.` });
  }

  if (intent === "cancelRequest") {
    const id = String(formData.get("id") || "");
    await db.purchaseRequest.updateMany({ where: { shop, id }, data: { status: "cancelled", cancelledAt: new Date() } });
    return Response.json({ ok: true, message: "Purchase request cancelled." });
  }

  return Response.json({ ok: false, message: "Unknown purchase request action." }, { status: 400 });
}

function NativeSelect({ name, defaultValue, options, label }: { name: string; defaultValue?: string; options: { label: string; value: string }[]; label: string }) {
  return (
    <label style={{ display: "block", minWidth: 220 }}>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <select name={name} defaultValue={defaultValue || ""} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function statusBadge(status: string) {
  if (status === "received") return <Badge tone="success">Received</Badge>;
  if (status === "ordered" || status === "partially_received") return <Badge tone="attention">{status.replaceAll("_", " ")}</Badge>;
  if (status === "cancelled") return <Badge tone="critical">Cancelled</Badge>;
  return <Badge tone="warning">{status}</Badge>;
}

function vendorOptionList(vendors: any[]) {
  return [
    { label: "Manual / no Vendor Center link", value: "" },
    ...vendors.map((vendor: any) => ({ label: `${vendor.name}${vendor.status ? ` (${vendor.status})` : ""}`, value: vendor.id })),
  ];
}

function PurchaseRequestCard({ request, vendors }: { request: any; vendors: any[] }) {
  const busy = useNavigation().state !== "idle";
  const vendorOptions = vendorOptionList(vendors);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">{request.requestNumber}</Text>
            <Text as="p" fontWeight="bold">{request.materialName}</Text>
            <Text as="p" tone="subdued">Vendor: {request.vendorRecord?.name || request.vendor || "Not set"} | Vendor SKU: {request.vendorSku || request.sku || "Not set"}</Text>
          </BlockStack>
          <InlineStack gap="200">{statusBadge(request.status)}<Badge>{request.priority}</Badge></InlineStack>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Text as="p">Requested: <strong>{qty(request.requestedQty)} {request.unit}</strong></Text>
          <Text as="p">Ordered: <strong>{qty(request.orderedQty)} {request.unit}</strong></Text>
          <Text as="p">Received: <strong>{qty(request.receivedQty)} {request.unit}</strong></Text>
          <Text as="p">Est. cost: <strong>${money(request.estimatedCost)}</strong></Text>
        </InlineStack>

        <Form method="post">
          <input type="hidden" name="intent" value="updateRequest" />
          <input type="hidden" name="id" value={request.id} />
          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <NativeSelect label="Status" name="status" defaultValue={request.status} options={statusOptions} />
              <NativeSelect label="Priority" name="priority" defaultValue={request.priority} options={priorityOptions} />
              <NativeSelect label="Vendor Center Vendor" name="vendorId" defaultValue={request.vendorId || request.vendorRecord?.id || ""} options={vendorOptions} />
              <TextField label="Vendor fallback" name="vendor" defaultValue={request.vendor || ""} autoComplete="off" />
              <TextField label="Vendor SKU" name="vendorSku" defaultValue={request.vendorSku || ""} autoComplete="off" />
            </InlineStack>
            <InlineStack gap="200" wrap>
              <TextField label="Lead time days" name="leadTimeDays" defaultValue={request.leadTimeDays ? String(request.leadTimeDays) : ""} autoComplete="off" />
              <TextField label="Requested qty" name="requestedQty" defaultValue={String(request.requestedQty || 0)} autoComplete="off" />
              <TextField label="Ordered qty" name="orderedQty" defaultValue={String(request.orderedQty || request.requestedQty || 0)} autoComplete="off" />
              <TextField label="Unit cost" name="unitCost" prefix="$" defaultValue={String(request.unitCost || 0)} autoComplete="off" />
              <TextField label="Needed by" name="neededBy" type="date" defaultValue={safeDateInput(request.neededBy)} autoComplete="off" />
            </InlineStack>
            <TextField label="Notes" name="notes" defaultValue={request.notes || ""} autoComplete="off" multiline={2} />
            <Button submit loading={busy}>Save request</Button>
          </BlockStack>
        </Form>

        <InlineStack gap="200" wrap>
          <Form method="post">
            <input type="hidden" name="intent" value="markOrdered" />
            <input type="hidden" name="id" value={request.id} />
            <Button submit>Mark ordered</Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="receiveRequest" />
            <input type="hidden" name="id" value={request.id} />
            <InlineStack gap="200" blockAlign="end">
              <TextField label="Receive qty" name="receiveQty" autoComplete="off" />
              <Button submit>Receive</Button>
            </InlineStack>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="cancelRequest" />
            <input type="hidden" name="id" value={request.id} />
            <Button tone="critical" submit>Cancel</Button>
          </Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function LowStockMaterialCard({ material }: { material: any }) {
  const vendor = preferredMaterialVendor(material);
  const suggestedQty = suggestedReorderQty(material);
  const unitCost = material.vendors?.[0]?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0;
  const status = materialStatus(material);
  return (
    <Card>
      <BlockStack gap="250">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="050">
            <Text as="h3" variant="headingMd">{material.name}</Text>
            <Text as="p" tone="subdued">Stock: {qty(material.stockOnHand)} | Reorder point: {qty(material.reorderPoint)} | Unit: {material.unit || material.baseUnit || "each"}</Text>
            <Text as="p" tone="subdued">Vendor: {vendor?.name || vendor?.vendorName || material.vendor || "Not set"} | Vendor SKU: {material.vendors?.[0]?.vendorSku || material.sku || "Not set"}</Text>
          </BlockStack>
          <Badge tone={status === "out_of_stock" ? "critical" : "warning"}>{status.replaceAll("_", " ")}</Badge>
        </InlineStack>
        <InlineStack gap="300" wrap>
          <Text as="p">Suggested qty: <strong>{qty(suggestedQty || material.reorderPoint || 1)}</strong></Text>
          <Text as="p">Est. cost: <strong>${money((suggestedQty || material.reorderPoint || 1) * unitCost)}</strong></Text>
        </InlineStack>
        <Form method="post">
          <input type="hidden" name="intent" value="createFromMaterial" />
          <input type="hidden" name="materialId" value={material.id} />
          <InlineStack gap="200" blockAlign="end">
            <TextField label="Request qty" name="requestedQty" defaultValue={String(qty(suggestedQty || material.reorderPoint || 1))} autoComplete="off" />
            <Button submit>Create PO request</Button>
          </InlineStack>
        </Form>
      </BlockStack>
    </Card>
  );
}

export default function PurchaseRequestsPage() {
  const { purchaseRequests, materials, vendors, lowStockMaterials, openRequests, orderedRequests, receivedRequests } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";

  const materialOptions = [
    { label: "Manual / not tied to material", value: "" },
    ...materials.map((material: any) => ({ label: `${material.name} (${material.unit || material.baseUnit || "each"})`, value: material.id })),
  ];
  const vendorOptions = vendorOptionList(vendors || []);

  return (
    <Page
      title="Purchase Requests"
      subtitle="Turn low-stock materials into vendor-linked purchase requests and receive inventory into stock."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      secondaryActions={[{ content: "Vendor Center", onAction: () => navigate("/app/erp/vendors") }, { content: "Reorder Report", onAction: () => navigate("/app/erp/reorder-report") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Purchasing overview</Text>
                  <Text as="p" tone="subdued">Vendor Center now feeds PO requests. Select vendors from dropdowns and keep fallback text only for one-off purchases.</Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Badge tone="warning">{openRequests.length} open</Badge>
                  <Badge tone="attention">{orderedRequests.length} ordered</Badge>
                  <Badge tone="success">{receivedRequests.length} received</Badge>
                </InlineStack>
              </InlineStack>
              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Create manual purchase request</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="createManual" />
                <BlockStack gap="250">
                  <NativeSelect label="Material" name="materialId" options={materialOptions} />
                  <InlineStack gap="200" wrap>
                    <TextField label="Material / item name" name="materialName" autoComplete="off" />
                    <TextField label="Unit" name="unit" defaultValue="each" autoComplete="off" />
                    <NativeSelect label="Status" name="status" defaultValue="requested" options={statusOptions} />
                    <NativeSelect label="Priority" name="priority" defaultValue="normal" options={priorityOptions} />
                  </InlineStack>
                  <InlineStack gap="200" wrap>
                    <NativeSelect label="Vendor Center Vendor" name="vendorId" options={vendorOptions} />
                    <TextField label="Vendor fallback" name="vendor" autoComplete="off" />
                    <TextField label="Vendor SKU" name="vendorSku" autoComplete="off" />
                    <TextField label="SKU" name="sku" autoComplete="off" />
                    <TextField label="Lead time days" name="leadTimeDays" autoComplete="off" />
                  </InlineStack>
                  <InlineStack gap="200" wrap>
                    <TextField label="Requested qty" name="requestedQty" autoComplete="off" />
                    <TextField label="Unit cost" name="unitCost" prefix="$" autoComplete="off" />
                    <TextField label="Needed by" name="neededBy" type="date" autoComplete="off" />
                  </InlineStack>
                  <TextField label="Notes" name="notes" autoComplete="off" multiline={2} />
                  <Button submit variant="primary" loading={busy}>Create purchase request</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Buy / reorder now</Text>
            {lowStockMaterials.length ? lowStockMaterials.map((material: any) => <LowStockMaterialCard key={material.id} material={material} />) : <Card><Text as="p" tone="subdued">No low-stock materials right now.</Text></Card>}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Open Requests</Text>
            {openRequests.length ? openRequests.map((request: any) => <PurchaseRequestCard key={request.id} request={request} vendors={vendors || []} />) : <Card><Text as="p" tone="subdued">No open purchase requests.</Text></Card>}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Recent received / cancelled</Text>
              <Divider />
              {purchaseRequests.filter((request: any) => ["received", "cancelled"].includes(request.status)).slice(0, 20).map((request: any) => (
                <InlineStack key={request.id} align="space-between">
                  <Text as="p">{request.requestNumber} - {request.materialName} - {request.vendorRecord?.name || request.vendor || "No vendor"}</Text>
                  {statusBadge(request.status)}
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
