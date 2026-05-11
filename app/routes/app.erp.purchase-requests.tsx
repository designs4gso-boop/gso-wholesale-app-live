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

function activeCostBookItems(costBookItems: any[]) {
  const now = new Date();
  return (costBookItems || []).filter((item: any) => {
    if (item.status !== "active") return false;
    if (item.effectiveDate && new Date(item.effectiveDate) > now) return false;
    if (item.expiresAt && new Date(item.expiresAt) < now) return false;
    return true;
  });
}

function priceFromCostBook(item: any, quantity: number) {
  if (!item) return 0;
  const qtyValue = num(quantity) || 1;
  const matchingTier = (item.tiers || [])
    .filter((tier: any) => qtyValue >= num(tier.minQty) && (!tier.maxQty || qtyValue <= num(tier.maxQty)))
    .sort((a: any, b: any) => num(b.minQty) - num(a.minQty))[0];
  return num(matchingTier?.unitCost) || num(item.unitCost);
}

function bestCostBookForMaterial(material: any, costBookItems: any[], quantity: number) {
  const candidates = activeCostBookItems(costBookItems)
    .filter((item: any) => item.itemType === "material" && item.materialId === material?.id)
    .filter((item: any) => !item.moq || num(quantity) >= num(item.moq))
    .sort((a: any, b: any) => {
      if (Boolean(b.preferred) !== Boolean(a.preferred)) return Number(Boolean(b.preferred)) - Number(Boolean(a.preferred));
      return priceFromCostBook(a, quantity) - priceFromCostBook(b, quantity);
    });
  return candidates[0] || null;
}

function bestCostBookForRequest(request: any, costBookItems: any[]) {
  const quantity = num(request.orderedQty) || num(request.requestedQty) || 1;
  const candidates = activeCostBookItems(costBookItems)
    .filter((item: any) => {
      if (request.materialId && item.materialId === request.materialId) return true;
      if (request.vendorId && item.vendorId === request.vendorId && item.itemName?.toLowerCase() === request.materialName?.toLowerCase()) return true;
      return false;
    })
    .filter((item: any) => !item.moq || quantity >= num(item.moq))
    .sort((a: any, b: any) => {
      if (Boolean(b.preferred) !== Boolean(a.preferred)) return Number(Boolean(b.preferred)) - Number(Boolean(a.preferred));
      return priceFromCostBook(a, quantity) - priceFromCostBook(b, quantity);
    });
  return candidates[0] || null;
}

function costBookOptionList(costBookItems: any[]) {
  return [
    { label: "No cost book override", value: "" },
    ...activeCostBookItems(costBookItems).map((item: any) => ({
      label: `${item.vendorName || "Vendor"} | ${item.itemName} | $${money(item.unitCost)} / ${item.unit || "unit"}${item.moq ? ` | MOQ ${qty(item.moq)}` : ""}`,
      value: item.id,
    })),
  ];
}

async function getCostBookItem(shop: string, id: string | null | undefined) {
  if (!id) return null;
  return db.vendorCostBookItem.findFirst({
    where: { shop, id, status: "active" },
    include: { tiers: { orderBy: { minQty: "asc" } } },
  });
}

async function findBestCostBookItem(shop: string, materialId: string | null | undefined, quantity: number, vendorId?: string | null) {
  if (!materialId) return null;
  const now = new Date();
  const candidates = await db.vendorCostBookItem.findMany({
    where: {
      shop,
      status: "active",
      itemType: "material",
      materialId,
      OR: [{ effectiveDate: null }, { effectiveDate: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      ...(vendorId ? { vendorId } : {}),
    },
    include: { tiers: { orderBy: { minQty: "asc" } } },
  });
  return candidates
    .filter((item: any) => !item.moq || num(quantity) >= num(item.moq))
    .sort((a: any, b: any) => {
      if (Boolean(b.preferred) !== Boolean(a.preferred)) return Number(Boolean(b.preferred)) - Number(Boolean(a.preferred));
      return priceFromCostBook(a, quantity) - priceFromCostBook(b, quantity);
    })[0] || null;
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

  const [purchaseRequests, materials, vendors, costBookItems] = await Promise.all([
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
    db.vendorCostBookItem.findMany({
      where: { shop, status: "active" },
      orderBy: [{ preferred: "desc" }, { vendorName: "asc" }, { itemName: "asc" }],
      include: { tiers: { orderBy: { minQty: "asc" } } },
    }),
  ]);

  const lowStockMaterials = materials.filter((material: any) => ["out_of_stock", "low_stock"].includes(materialStatus(material)));
  const openRequests = purchaseRequests.filter((req: any) => !["received", "cancelled"].includes(req.status));
  const orderedRequests = purchaseRequests.filter((req: any) => ["ordered", "partially_received"].includes(req.status));
  const receivedRequests = purchaseRequests.filter((req: any) => req.status === "received");

  return Response.json({ purchaseRequests, materials, vendors, costBookItems, lowStockMaterials, openRequests, orderedRequests, receivedRequests });
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
    const requestedQty = num(formData.get("requestedQty")) || suggestedReorderQty(material) || num(material.reorderPoint) || 1;
    const selectedCostBook = await getCostBookItem(shop, String(formData.get("costBookItemId") || ""));
    const bestCostBook = selectedCostBook || await findBestCostBookItem(shop, material.id, requestedQty, material.primaryVendorId || undefined);
    const vendorRecord = bestCostBook?.vendorId ? await getVendor(shop, bestCostBook.vendorId) : (material.primaryVendor || (await getVendor(shop, String(formData.get("vendorId") || ""))));
    const unitCost = bestCostBook ? priceFromCostBook(bestCostBook, requestedQty) : (materialVendor?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0);
    const leadTimeDays = bestCostBook?.leadTimeDays || vendorRecord?.leadTimeDays || materialVendor?.leadTimeDays || material.leadTimeDays || null;
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
        vendorId: vendorRecord?.id || bestCostBook?.vendorId || null,
        vendor: vendorRecord?.name || bestCostBook?.vendorName || materialVendor?.vendorName || material.vendor || null,
        vendorSku: bestCostBook?.vendorSku || materialVendor?.vendorSku || material.sku || null,
        moq: bestCostBook?.moq || materialVendor?.moq || null,
        leadTimeDays,
        requestedQty,
        orderedQty: requestedQty,
        unitCost,
        estimatedCost: requestedQty * unitCost,
        neededBy,
        source: "reorder_report",
        notes: String(formData.get("notes") || (bestCostBook ? `Created from low-stock material using Vendor Cost Book: ${bestCostBook.vendorName || "vendor"}.` : "Created from low-stock material.")),
      },
    });

    return Response.json({ ok: true, message: `Purchase request ${requestNumber} created.` });
  }

  if (intent === "createManual") {
    const requestNumber = await nextRequestNumber(shop);
    const requestedQty = num(formData.get("requestedQty"));
    const typedUnitCost = num(formData.get("unitCost"));
    const materialId = String(formData.get("materialId") || "");
    const material = materialId ? await db.material.findFirst({ where: { shop, id: materialId }, include: { primaryVendor: true } }) : null;
    const selectedCostBook = await getCostBookItem(shop, String(formData.get("costBookItemId") || ""));
    const bestCostBook = selectedCostBook || await findBestCostBookItem(shop, material?.id, requestedQty, String(formData.get("vendorId") || "") || material?.primaryVendorId || undefined);
    const selectedVendor = bestCostBook?.vendorId ? await getVendor(shop, bestCostBook.vendorId) : await getVendor(shop, String(formData.get("vendorId") || "") || material?.primaryVendorId || "");
    const unitCost = bestCostBook ? priceFromCostBook(bestCostBook, requestedQty) : typedUnitCost;
    const neededByRaw = String(formData.get("neededBy") || "");
    const leadTimeDays = bestCostBook?.leadTimeDays || Math.round(num(formData.get("leadTimeDays"))) || selectedVendor?.leadTimeDays || material?.leadTimeDays || null;

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
        vendorId: selectedVendor?.id || bestCostBook?.vendorId || null,
        vendor: selectedVendor?.name || bestCostBook?.vendorName || String(formData.get("vendor") || material?.vendor || "") || null,
        vendorSku: bestCostBook?.vendorSku || String(formData.get("vendorSku") || material?.sku || "") || null,
        moq: bestCostBook?.moq || null,
        leadTimeDays,
        requestedQty,
        orderedQty: requestedQty,
        unitCost,
        estimatedCost: requestedQty * unitCost,
        neededBy: neededByRaw ? new Date(`${neededByRaw}T12:00:00`) : null,
        source: bestCostBook ? "vendor_cost_book" : "manual",
        notes: String(formData.get("notes") || (bestCostBook ? `Cost pulled from Vendor Cost Book: ${bestCostBook.vendorName || "vendor"}.` : "")) || null,
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
    const selectedCostBook = await getCostBookItem(shop, String(formData.get("costBookItemId") || ""));
    const selectedVendor = selectedCostBook?.vendorId ? await getVendor(shop, selectedCostBook.vendorId) : await getVendor(shop, String(formData.get("vendorId") || ""));
    const appliedUnitCost = selectedCostBook ? priceFromCostBook(selectedCostBook, orderedQty || requestedQty) : unitCost;
    const appliedLeadTimeDays = selectedCostBook?.leadTimeDays || Math.round(num(formData.get("leadTimeDays"))) || selectedVendor?.leadTimeDays || null;

    await db.purchaseRequest.update({
      where: { id },
      data: {
        status,
        priority: String(formData.get("priority") || purchaseRequest.priority),
        vendorId: selectedVendor?.id || selectedCostBook?.vendorId || null,
        vendor: selectedVendor?.name || selectedCostBook?.vendorName || String(formData.get("vendor") || "") || null,
        vendorSku: selectedCostBook?.vendorSku || String(formData.get("vendorSku") || "") || null,
        moq: selectedCostBook?.moq || purchaseRequest.moq || null,
        leadTimeDays: appliedLeadTimeDays,
        requestedQty,
        orderedQty,
        unitCost: appliedUnitCost,
        estimatedCost: orderedQty * appliedUnitCost,
        neededBy: neededByRaw ? new Date(`${neededByRaw}T12:00:00`) : null,
        orderedAt: status === "ordered" && !purchaseRequest.orderedAt ? new Date() : purchaseRequest.orderedAt,
        cancelledAt: status === "cancelled" ? new Date() : purchaseRequest.cancelledAt,
        notes: String(formData.get("notes") || "") || null,
      },
    });

    return Response.json({ ok: true, message: "Purchase request updated." });
  }

  if (intent === "applyBestCost") {
    const id = String(formData.get("id") || "");
    const purchaseRequest = await db.purchaseRequest.findFirst({ where: { shop, id } });
    if (!purchaseRequest) return Response.json({ ok: false, message: "Purchase request not found." }, { status: 404 });
    const quantity = num(purchaseRequest.orderedQty) || num(purchaseRequest.requestedQty) || 1;
    const selectedCostBook = await getCostBookItem(shop, String(formData.get("costBookItemId") || ""));
    const bestCostBook = selectedCostBook || await findBestCostBookItem(shop, purchaseRequest.materialId, quantity, purchaseRequest.vendorId);
    if (!bestCostBook) return Response.json({ ok: false, message: "No active Vendor Cost Book match found for this request." }, { status: 404 });
    const vendorRecord = bestCostBook.vendorId ? await getVendor(shop, bestCostBook.vendorId) : null;
    const unitCost = priceFromCostBook(bestCostBook, quantity);
    await db.purchaseRequest.update({
      where: { id: purchaseRequest.id },
      data: {
        vendorId: vendorRecord?.id || bestCostBook.vendorId || purchaseRequest.vendorId,
        vendor: vendorRecord?.name || bestCostBook.vendorName || purchaseRequest.vendor,
        vendorSku: bestCostBook.vendorSku || purchaseRequest.vendorSku,
        unit: bestCostBook.unit || purchaseRequest.unit,
        moq: bestCostBook.moq || purchaseRequest.moq,
        leadTimeDays: bestCostBook.leadTimeDays || vendorRecord?.leadTimeDays || purchaseRequest.leadTimeDays,
        unitCost,
        estimatedCost: quantity * unitCost,
        source: "vendor_cost_book",
        notes: `${purchaseRequest.notes || ""}
Cost auto-filled from Vendor Cost Book: ${bestCostBook.vendorName || "vendor"} / ${bestCostBook.itemName}.`.trim(),
      },
    });
    return Response.json({ ok: true, message: "Best vendor cost applied to purchase request." });
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

function NativeInput({
  label,
  name,
  defaultValue = "",
  type = "text",
  prefix,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  prefix?: string;
}) {
  return (
    <label style={{ display: "block", minWidth: 180, flex: "1 1 180px" }}>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {prefix ? <span>{prefix}</span> : null}
        <input
          name={name}
          type={type}
          defaultValue={defaultValue || ""}
          autoComplete="off"
          style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}
        />
      </span>
    </label>
  );
}

function NativeTextarea({ label, name, defaultValue = "" }: { label: string; name: string; defaultValue?: string }) {
  return (
    <label style={{ display: "block", width: "100%" }}>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <textarea
        name={name}
        defaultValue={defaultValue || ""}
        rows={3}
        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}
      />
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

function PurchaseRequestCard({ request, vendors, costBookItems }: { request: any; vendors: any[]; costBookItems: any[] }) {
  const busy = useNavigation().state !== "idle";
  const navigate = useNavigate();
  const vendorOptions = vendorOptionList(vendors);
  const costBookOptions = costBookOptionList(costBookItems || []);
  const bestCost = bestCostBookForRequest(request, costBookItems || []);
  const bestCostQty = num(request.orderedQty) || num(request.requestedQty) || 1;
  const bestCostUnit = bestCost ? priceFromCostBook(bestCost, bestCostQty) : 0;
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

        {bestCost ? (
          <Card>
            <BlockStack gap="150">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="h4" variant="headingSm">Vendor Cost Suggestion</Text>
                  <Text as="p">{bestCost.vendorName || "Vendor"} - ${money(bestCostUnit)} / {bestCost.unit || request.unit || "unit"}{bestCost.moq ? ` | MOQ ${qty(bestCost.moq)}` : ""}</Text>
                </BlockStack>
                <Form method="post">
                  <input type="hidden" name="intent" value="applyBestCost" />
                  <input type="hidden" name="id" value={request.id} />
                  <input type="hidden" name="costBookItemId" value={bestCost.id} />
                  <Button submit>Apply best cost</Button>
                </Form>
              </InlineStack>
            </BlockStack>
          </Card>
        ) : null}

        <Form method="post">
          <input type="hidden" name="intent" value="updateRequest" />
          <input type="hidden" name="id" value={request.id} />
          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <NativeSelect label="Status" name="status" defaultValue={request.status} options={statusOptions} />
              <NativeSelect label="Priority" name="priority" defaultValue={request.priority} options={priorityOptions} />
              <NativeSelect label="Vendor Center Vendor" name="vendorId" defaultValue={request.vendorId || request.vendorRecord?.id || ""} options={vendorOptions} />
              <NativeInput label="Vendor fallback" name="vendor" defaultValue={request.vendor || ""} />
              <NativeInput label="Vendor SKU" name="vendorSku" defaultValue={request.vendorSku || ""} />
              <NativeSelect label="Cost Book Override" name="costBookItemId" options={costBookOptions} />
            </InlineStack>
            <InlineStack gap="200" wrap>
              <NativeInput label="Lead time days" name="leadTimeDays" defaultValue={request.leadTimeDays ? String(request.leadTimeDays) : ""} />
              <NativeInput label="Requested qty" name="requestedQty" defaultValue={String(request.requestedQty || 0)} />
              <NativeInput label="Ordered qty" name="orderedQty" defaultValue={String(request.orderedQty || request.requestedQty || 0)} />
              <NativeInput label="Unit cost" name="unitCost" prefix="$" defaultValue={String(request.unitCost || 0)} />
              <NativeInput label="Needed by" name="neededBy" type="date" defaultValue={safeDateInput(request.neededBy)} />
            </InlineStack>
            <NativeTextarea label="Notes" name="notes" defaultValue={request.notes || ""} />
            <Button submit loading={busy}>Save request</Button>
          </BlockStack>
        </Form>

        <InlineStack gap="200" wrap>
          <Button onClick={() => navigate(`/app/erp/purchase-export?id=${request.id}`)}>Print / Email PO</Button>
          <Button url={`/app/erp/purchase-export?id=${request.id}&format=csv`}>Download CSV</Button>
          <Form method="post">
            <input type="hidden" name="intent" value="markOrdered" />
            <input type="hidden" name="id" value={request.id} />
            <Button submit>Mark ordered</Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="receiveRequest" />
            <input type="hidden" name="id" value={request.id} />
            <InlineStack gap="200" blockAlign="end">
              <NativeInput label="Receive qty" name="receiveQty" />
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

function LowStockMaterialCard({ material, costBookItems }: { material: any; costBookItems: any[] }) {
  const vendor = preferredMaterialVendor(material);
  const suggestedQty = suggestedReorderQty(material);
  const bestCost = bestCostBookForMaterial(material, costBookItems || [], suggestedQty || material.reorderPoint || 1);
  const unitCost = bestCost ? priceFromCostBook(bestCost, suggestedQty || material.reorderPoint || 1) : (material.vendors?.[0]?.unitCost || material.calculatedUnitCost || material.costPerUnit || 0);
  const status = materialStatus(material);
  return (
    <Card>
      <BlockStack gap="250">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="050">
            <Text as="h3" variant="headingMd">{material.name}</Text>
            <Text as="p" tone="subdued">Stock: {qty(material.stockOnHand)} | Reorder point: {qty(material.reorderPoint)} | Unit: {material.unit || material.baseUnit || "each"}</Text>
            <Text as="p" tone="subdued">Vendor: {bestCost?.vendorName || vendor?.name || vendor?.vendorName || material.vendor || "Not set"} | Vendor SKU: {bestCost?.vendorSku || material.vendors?.[0]?.vendorSku || material.sku || "Not set"}</Text>
            {bestCost ? <Text as="p" tone="success">Best cost: ${money(unitCost)} / {bestCost.unit || material.unit || material.baseUnit || "unit"}{bestCost.moq ? ` | MOQ ${qty(bestCost.moq)}` : ""}</Text> : null}
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
          {bestCost ? <input type="hidden" name="costBookItemId" value={bestCost.id} /> : null}
          <InlineStack gap="200" blockAlign="end">
            <NativeInput label="Request qty" name="requestedQty" defaultValue={String(qty(suggestedQty || material.reorderPoint || 1))} />
            <Button submit>Create PO request</Button>
          </InlineStack>
        </Form>
      </BlockStack>
    </Card>
  );
}

export default function PurchaseRequestsPage() {
  const { purchaseRequests, materials, vendors, costBookItems, lowStockMaterials, openRequests, orderedRequests, receivedRequests } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";

  const materialOptions = [
    { label: "Manual / not tied to material", value: "" },
    ...materials.map((material: any) => ({ label: `${material.name} (${material.unit || material.baseUnit || "each"})`, value: material.id })),
  ];
  const vendorOptions = vendorOptionList(vendors || []);
  const costBookOptions = costBookOptionList(costBookItems || []);

  return (
    <Page
      title="Purchase Requests"
      subtitle="Turn low-stock materials into vendor-linked purchase requests and receive inventory into stock."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      secondaryActions={[{ content: "Vendor Center", onAction: () => navigate("/app/erp/vendors") }, { content: "Reorder Report", onAction: () => navigate("/app/erp/reorder-report") }, { content: "Purchase Export", onAction: () => navigate("/app/erp/purchase-export") }]}
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
                    <NativeInput label="Material / item name" name="materialName" />
                    <NativeInput label="Unit" name="unit" defaultValue="each" />
                    <NativeSelect label="Status" name="status" defaultValue="requested" options={statusOptions} />
                    <NativeSelect label="Priority" name="priority" defaultValue="normal" options={priorityOptions} />
                  </InlineStack>
                  <InlineStack gap="200" wrap>
                    <NativeSelect label="Vendor Center Vendor" name="vendorId" options={vendorOptions} />
                    <NativeSelect label="Cost Book Item" name="costBookItemId" options={costBookOptions} />
                    <NativeInput label="Vendor fallback" name="vendor" />
                    <NativeInput label="Vendor SKU" name="vendorSku" />
                    <NativeInput label="SKU" name="sku" />
                    <NativeInput label="Lead time days" name="leadTimeDays" />
                  </InlineStack>
                  <InlineStack gap="200" wrap>
                    <NativeInput label="Requested qty" name="requestedQty" />
                    <NativeInput label="Unit cost" name="unitCost" prefix="$" />
                    <NativeInput label="Needed by" name="neededBy" type="date" />
                  </InlineStack>
                  <NativeTextarea label="Notes" name="notes" />
                  <Button submit variant="primary" loading={busy}>Create purchase request</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Buy / reorder now</Text>
            {lowStockMaterials.length ? lowStockMaterials.map((material: any) => <LowStockMaterialCard key={material.id} material={material} costBookItems={costBookItems || []} />) : <Card><Text as="p" tone="subdued">No low-stock materials right now.</Text></Card>}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Open Requests</Text>
            {openRequests.length ? openRequests.map((request: any) => <PurchaseRequestCard key={request.id} request={request} vendors={vendors || []} costBookItems={costBookItems || []} />) : <Card><Text as="p" tone="subdued">No open purchase requests.</Text></Card>}
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
