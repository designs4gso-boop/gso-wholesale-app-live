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
  TextField,
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
  return Number(value || 0);
}

function money(value: any) {
  return num(value).toFixed(2);
}

function qty(value: any) {
  return num(value).toFixed(2).replace(/\.00$/, "");
}

function safeDateInput(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function statusTone(status: string) {
  if (status === "received") return "success" as any;
  if (status === "ordered" || status === "partially_received") return "info" as any;
  if (status === "requested") return "warning" as any;
  if (status === "cancelled") return "critical" as any;
  return undefined as any;
}

function statusLabel(status: string) {
  return statusOptions.find((option) => option.value === status)?.label || status;
}

function materialStatus(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  if (reorderPoint <= 0) return "needs_reorder_point";
  if (stock <= 0) return "out_of_stock";
  if (stock <= reorderPoint) return "low_stock";
  return "ok";
}

function preferredVendor(material: any) {
  return material.vendors?.find((vendor: any) => vendor.preferred) || material.vendors?.[0];
}

function suggestedReorderQty(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  const recentUsage = (material.inventoryMovements || [])
    .filter((movement: any) => num(movement.quantity) < 0)
    .reduce((sum: number, movement: any) => sum + Math.abs(num(movement.quantity)), 0);
  const avgDaily = recentUsage / 30;
  const leadTimeDays = num(material.leadTimeDays) || preferredVendor(material)?.leadTimeDays || 7;
  const leadTimeNeed = avgDaily * leadTimeDays;
  const targetStock = Math.max(reorderPoint * 2, reorderPoint + leadTimeNeed, stock);
  return Math.max(0, targetStock - stock);
}

async function nextRequestNumber(shop: string) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const count = await db.purchaseRequest.count({ where: { shop, createdAt: { gte: start } } });
  return `GSO-PO-${day}-${String(count + 1).padStart(4, "0")}`;
}

async function createInventoryMovementForReceipt(shop: string, purchaseRequest: any, receiveQty: number, notes: string) {
  if (!purchaseRequest.materialId || receiveQty <= 0) return;

  const material = await db.material.findFirst({ where: { shop, id: purchaseRequest.materialId } });
  if (!material) return;

  const beforeQty = material.stockOnHand || 0;
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

  const [purchaseRequests, materials] = await Promise.all([
    db.purchaseRequest.findMany({
      where: { shop },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 150,
    }),
    db.material.findMany({
      where: { shop, active: true },
      orderBy: [{ materialType: "asc" }, { name: "asc" }],
      include: {
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
  ]);

  const lowStockMaterials = materials.filter((material: any) => ["out_of_stock", "low_stock"].includes(materialStatus(material)));
  const openRequests = purchaseRequests.filter((request: any) => !["received", "cancelled"].includes(request.status));
  const orderedRequests = purchaseRequests.filter((request: any) => ["ordered", "partially_received"].includes(request.status));
  const receivedRequests = purchaseRequests.filter((request: any) => request.status === "received");

  return Response.json({ purchaseRequests, materials, lowStockMaterials, openRequests, orderedRequests, receivedRequests });
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
      include: { vendors: { where: { active: true }, orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }], take: 1 } },
    });
    if (!material) return Response.json({ ok: false, message: "Material not found." }, { status: 404 });

    const vendor = material.vendors?.[0];
    const requestedQty = num(formData.get("requestedQty")) || suggestedReorderQty(material) || num(material.reorderPoint) || 1;
    const unitCost = vendor?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0;
    const leadTimeDays = vendor?.leadTimeDays || material.leadTimeDays || null;
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
        vendor: vendor?.vendorName || material.vendor || null,
        vendorSku: vendor?.vendorSku || material.sku || null,
        moq: vendor?.moq || null,
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
    const material = materialId ? await db.material.findFirst({ where: { shop, id: materialId } }) : null;
    const neededByRaw = String(formData.get("neededBy") || "");

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
        vendor: String(formData.get("vendor") || material?.vendor || "") || null,
        vendorSku: String(formData.get("vendorSku") || material?.sku || "") || null,
        leadTimeDays: Math.round(num(formData.get("leadTimeDays"))) || null,
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

    await db.purchaseRequest.update({
      where: { id },
      data: {
        status,
        priority: String(formData.get("priority") || purchaseRequest.priority),
        vendor: String(formData.get("vendor") || "") || null,
        vendorSku: String(formData.get("vendorSku") || "") || null,
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
    <div>
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <select name={name} defaultValue={defaultValue || options[0]?.value} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}

function RequestCard({ request }: { request: any }) {
  const remaining = Math.max(0, num(request.orderedQty || request.requestedQty) - num(request.receivedQty));
  const percentReceived = num(request.orderedQty || request.requestedQty) > 0
    ? Math.min(100, (num(request.receivedQty) / num(request.orderedQty || request.requestedQty)) * 100)
    : 0;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">{request.requestNumber}</Text>
            <Text as="p" fontWeight="bold">{request.materialName}</Text>
            <Text as="p" tone="subdued">Vendor: {request.vendor || "Not set"} | Vendor SKU: {request.vendorSku || request.sku || "Not set"}</Text>
          </BlockStack>
          <InlineStack gap="200">
            <Badge tone={statusTone(request.status)}>{statusLabel(request.status)}</Badge>
            <Badge>{request.priority}</Badge>
          </InlineStack>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Text as="p">Requested: <strong>{qty(request.requestedQty)} {request.unit}</strong></Text>
          <Text as="p">Ordered: <strong>{qty(request.orderedQty)} {request.unit}</strong></Text>
          <Text as="p">Received: <strong>{qty(request.receivedQty)} {request.unit}</strong></Text>
          <Text as="p">Remaining: <strong>{qty(remaining)} {request.unit}</strong></Text>
          <Text as="p">Est. cost: <strong>${money(request.estimatedCost)}</strong></Text>
          <Text as="p">Needed by: <strong>{request.neededBy ? new Date(request.neededBy).toLocaleDateString() : "Not set"}</strong></Text>
        </InlineStack>

        <div style={{ height: 8, background: "#eee", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${percentReceived}%`, background: "#7ee29a" }} />
        </div>

        <Divider />

        <Form method="post">
          <input type="hidden" name="intent" value="updateRequest" />
          <input type="hidden" name="id" value={request.id} />
          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <NativeSelect label="Status" name="status" defaultValue={request.status} options={statusOptions} />
              <NativeSelect label="Priority" name="priority" defaultValue={request.priority} options={priorityOptions} />
              <TextField label="Vendor" name="vendor" defaultValue={request.vendor || ""} autoComplete="off" />
              <TextField label="Vendor SKU" name="vendorSku" defaultValue={request.vendorSku || ""} autoComplete="off" />
            </InlineStack>
            <InlineStack gap="200" wrap>
              <TextField label="Requested qty" name="requestedQty" defaultValue={String(request.requestedQty || 0)} autoComplete="off" />
              <TextField label="Ordered qty" name="orderedQty" defaultValue={String(request.orderedQty || request.requestedQty || 0)} autoComplete="off" />
              <TextField label="Unit cost" name="unitCost" prefix="$" defaultValue={String(request.unitCost || 0)} autoComplete="off" />
              <TextField label="Needed by" name="neededBy" type="date" defaultValue={safeDateInput(request.neededBy)} autoComplete="off" />
            </InlineStack>
            <TextField label="Notes" name="notes" defaultValue={request.notes || ""} autoComplete="off" multiline={2} />
            <Button submit>Save request</Button>
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
            <InlineStack gap="150" blockAlign="end">
              <TextField label="Receive qty" name="receiveQty" defaultValue={String(remaining || request.orderedQty || request.requestedQty || 0)} autoComplete="off" />
              <TextField label="Receipt notes" name="notes" autoComplete="off" />
              <Button submit variant="primary">Receive</Button>
            </InlineStack>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="cancelRequest" />
            <input type="hidden" name="id" value={request.id} />
            <Button submit tone="critical">Cancel</Button>
          </Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function LowStockMaterialCard({ material }: { material: any }) {
  const vendor = preferredVendor(material);
  const suggestedQty = suggestedReorderQty(material);
  const unitCost = vendor?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0;
  const status = materialStatus(material);

  return (
    <Card>
      <BlockStack gap="250">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="050">
            <Text as="h3" variant="headingMd">{material.name}</Text>
            <Text as="p" tone="subdued">Stock: {qty(material.stockOnHand)} | Reorder point: {qty(material.reorderPoint)} | Unit: {material.unit || material.baseUnit || "each"}</Text>
            <Text as="p" tone="subdued">Vendor: {vendor?.vendorName || material.vendor || "Not set"} | Vendor SKU: {vendor?.vendorSku || material.sku || "Not set"}</Text>
          </BlockStack>
          <Badge tone={status === "out_of_stock" ? "critical" : "warning" as any}>{status === "out_of_stock" ? "Out of stock" : "Low stock"}</Badge>
        </InlineStack>
        <InlineStack gap="300">
          <Text as="p">Suggested qty: <strong>{qty(suggestedQty || material.reorderPoint || 1)}</strong></Text>
          <Text as="p">Est. cost: <strong>${money((suggestedQty || material.reorderPoint || 1) * unitCost)}</strong></Text>
        </InlineStack>
        <Form method="post">
          <input type="hidden" name="intent" value="createFromMaterial" />
          <input type="hidden" name="materialId" value={material.id} />
          <InlineStack gap="200" blockAlign="end">
            <TextField label="Request qty" name="requestedQty" defaultValue={String(qty(suggestedQty || material.reorderPoint || 1))} autoComplete="off" />
            <TextField label="Notes" name="notes" defaultValue="Created from low-stock dashboard." autoComplete="off" />
            <Button submit variant="primary">Create PO request</Button>
          </InlineStack>
        </Form>
      </BlockStack>
    </Card>
  );
}

export default function PurchaseRequestsPage() {
  const { purchaseRequests, materials, lowStockMaterials, openRequests, orderedRequests, receivedRequests } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";

  const materialOptions = [
    { label: "Manual / not tied to material", value: "" },
    ...materials.map((material: any) => ({ label: `${material.name} (${material.unit || material.baseUnit || "each"})`, value: material.id })),
  ];

  const grouped = [
    { title: "Open Requests", requests: openRequests },
    { title: "Ordered / Receiving", requests: orderedRequests },
    { title: "Recently Received", requests: receivedRequests.slice(0, 10) },
  ];

  return (
    <Page
      title="Purchasing / PO Requests"
      subtitle="Turn low-stock materials into purchase requests, track ordered/received status, and update inventory on receipt."
      primaryAction={{ content: "Open Reorder Report", onAction: () => navigate("/app/erp/reorder-report") }}
      secondaryActions={[{ content: "Production Board", onAction: () => navigate("/app/erp/production") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Purchasing overview</Text>
                  <Text as="p" tone="subdued">Create PO requests from low stock, mark them ordered, and receive material into stock when it arrives.</Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Badge tone="warning">{openRequests.length} open</Badge>
                  <Badge tone="info">{orderedRequests.length} ordered</Badge>
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
                    <TextField label="Vendor" name="vendor" autoComplete="off" />
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
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Buy / reorder now</Text>
              <Badge>{lowStockMaterials.length}</Badge>
            </InlineStack>
            {lowStockMaterials.length ? lowStockMaterials.map((material: any) => <LowStockMaterialCard key={material.id} material={material} />) : <Card><Text as="p" tone="subdued">No low-stock materials right now.</Text></Card>}
          </BlockStack>
        </Layout.Section>

        {grouped.map((group) => (
          <Layout.Section key={group.title}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">{group.title}</Text>
                <Badge>{group.requests.length}</Badge>
              </InlineStack>
              {group.requests.length ? group.requests.map((request: any) => <RequestCard key={request.id} request={request} />) : <Card><Text as="p" tone="subdued">No purchase requests in this group.</Text></Card>}
            </BlockStack>
          </Layout.Section>
        ))}
      </Layout>
    </Page>
  );
}
