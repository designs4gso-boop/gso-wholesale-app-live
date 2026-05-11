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

function num(value: any) {
  return Number(value || 0);
}

function money(value: any) {
  return num(value).toFixed(2);
}

function qty(value: any) {
  return num(value).toFixed(2).replace(/\.00$/, "");
}

function daysBetween(start: Date, end: Date) {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

function stockStatus(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  if (reorderPoint <= 0) return { label: "No reorder point", tone: undefined as any };
  if (stock <= 0) return { label: "Out of stock", tone: "critical" as any };
  if (stock <= reorderPoint) return { label: "Low stock", tone: "warning" as any };
  return { label: "OK", tone: "success" as any };
}

function usageStats(material: any) {
  const movements = material.inventoryMovements || [];
  const usageMovements = movements.filter((movement: any) => num(movement.quantity) < 0);
  const used30 = usageMovements.reduce((sum: number, movement: any) => sum + Math.abs(num(movement.quantity)), 0);
  const firstDate = usageMovements.length
    ? new Date(usageMovements[usageMovements.length - 1].createdAt)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const days = daysBetween(firstDate, new Date());
  const avgDaily = used30 / Math.max(1, days);
  return { used30, avgDaily, days };
}

function suggestedReorder(material: any) {
  const stock = num(material.stockOnHand);
  const reorderPoint = num(material.reorderPoint);
  const { avgDaily } = usageStats(material);
  const leadTimeDays = num(material.leadTimeDays) || 7;
  const leadTimeNeed = avgDaily * leadTimeDays;
  const safetyStock = reorderPoint > 0 ? reorderPoint : leadTimeNeed;
  const targetStock = Math.max(reorderPoint * 2, leadTimeNeed + safetyStock, stock);
  const suggestedQty = Math.max(0, targetStock - stock);
  const daysRemaining = avgDaily > 0 ? stock / avgDaily : null;
  return { leadTimeNeed, safetyStock, targetStock, suggestedQty, daysRemaining };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const materials = await db.material.findMany({
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
  });

  const lowStock = materials.filter((material: any) => {
    const reorderPoint = num(material.reorderPoint);
    return reorderPoint > 0 && num(material.stockOnHand) <= reorderPoint;
  });

  const noReorderPoint = materials.filter((material: any) => !material.reorderPoint || num(material.reorderPoint) <= 0);
  const outOfStock = materials.filter((material: any) => num(material.stockOnHand) <= 0);

  const recentMovements = await db.materialInventoryMovement.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { material: true },
  });

  return Response.json({
    materials,
    lowStock,
    noReorderPoint,
    outOfStock,
    recentMovements,
    since,
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "updateMaterialInventory") {
    const materialId = String(formData.get("materialId") || "");
    const material = await db.material.findFirst({ where: { shop, id: materialId } });
    if (!material) return Response.json({ ok: false, message: "Material not found." }, { status: 404 });

    const stockOnHand = num(formData.get("stockOnHand"));
    const reorderPoint = num(formData.get("reorderPoint"));
    const leadTimeDays = Math.round(num(formData.get("leadTimeDays")));
    const oldStock = material.stockOnHand ?? 0;
    const quantityDelta = stockOnHand - oldStock;

    await db.material.update({
      where: { id: material.id },
      data: {
        stockOnHand,
        reorderPoint,
        leadTimeDays: leadTimeDays || null,
      },
    });

    if (quantityDelta !== 0) {
      await db.materialInventoryMovement.create({
        data: {
          shop,
          materialId: material.id,
          movementType: "adjustment",
          quantity: quantityDelta,
          unit: material.unit || material.baseUnit || "each",
          beforeQty: oldStock,
          afterQty: stockOnHand,
          costPerUnit: material.calculatedUnitCost || material.costPerUnit || 0,
          costImpact: quantityDelta * (material.calculatedUnitCost || material.costPerUnit || 0),
          source: "reorder_report",
          notes: "Inventory adjusted from Reorder Report.",
        },
      });
    }

    return Response.json({ ok: true, message: "Material inventory settings updated." });
  }

  if (intent === "quickPurchase") {
    const materialId = String(formData.get("materialId") || "");
    const purchaseQty = num(formData.get("purchaseQty"));
    const material = await db.material.findFirst({ where: { shop, id: materialId } });
    if (!material) return Response.json({ ok: false, message: "Material not found." }, { status: 404 });
    if (purchaseQty <= 0) return Response.json({ ok: false, message: "Purchase quantity must be greater than zero." }, { status: 400 });

    const beforeQty = material.stockOnHand || 0;
    const afterQty = beforeQty + purchaseQty;
    const costPerUnit = material.calculatedUnitCost || material.costPerUnit || 0;

    await db.material.update({
      where: { id: material.id },
      data: { stockOnHand: afterQty },
    });

    await db.materialInventoryMovement.create({
      data: {
        shop,
        materialId: material.id,
        movementType: "purchase",
        quantity: purchaseQty,
        unit: material.unit || material.baseUnit || "each",
        beforeQty,
        afterQty,
        costPerUnit,
        costImpact: purchaseQty * costPerUnit,
        source: "reorder_report",
        notes: String(formData.get("notes") || "Quick purchase received from Reorder Report."),
      },
    });

    return Response.json({ ok: true, message: "Purchase quantity added to stock." });
  }

  return Response.json({ ok: false, message: "Unknown reorder report action." }, { status: 400 });
}

function MaterialCard({ material, lowStockOnly = false }: { material: any; lowStockOnly?: boolean }) {
  const status = stockStatus(material);
  const stats = usageStats(material);
  const suggestion = suggestedReorder(material);
  const preferredVendor = material.vendors?.find((vendor: any) => vendor.preferred) || material.vendors?.[0];
  const cost = material.calculatedUnitCost || material.costPerUnit || 0;
  const suggestedCost = suggestion.suggestedQty * cost;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">{material.name}</Text>
            <Text as="p" tone="subdued">
              {material.materialType} | SKU: {material.sku || "None"} | Unit: {material.unit || material.baseUnit || "each"}
            </Text>
          </BlockStack>
          <Badge tone={status.tone}>{status.label}</Badge>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Text as="p">Stock: <strong>{qty(material.stockOnHand)}</strong></Text>
          <Text as="p">Reorder point: <strong>{qty(material.reorderPoint)}</strong></Text>
          <Text as="p">30-day usage: <strong>{qty(stats.used30)}</strong></Text>
          <Text as="p">Avg/day: <strong>{qty(stats.avgDaily)}</strong></Text>
          <Text as="p">Days left: <strong>{suggestion.daysRemaining === null ? "Unknown" : qty(suggestion.daysRemaining)}</strong></Text>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Text as="p">Suggested reorder: <strong>{qty(suggestion.suggestedQty)}</strong></Text>
          <Text as="p">Approx cost: <strong>${money(suggestedCost)}</strong></Text>
          <Text as="p">Lead time: <strong>{material.leadTimeDays || preferredVendor?.leadTimeDays || "Not set"} days</strong></Text>
        </InlineStack>

        <Text as="p" tone="subdued">
          Vendor: {preferredVendor?.vendorName || material.vendor || "Not set"} | Vendor SKU: {preferredVendor?.vendorSku || material.sku || "Not set"} | MOQ: {preferredVendor?.moq || "Not set"}
        </Text>

        <Divider />

        <Form method="post">
          <input type="hidden" name="intent" value="updateMaterialInventory" />
          <input type="hidden" name="materialId" value={material.id} />
          <InlineStack gap="200" blockAlign="end" wrap>
            <TextField label="Stock on hand" name="stockOnHand" defaultValue={String(material.stockOnHand || 0)} autoComplete="off" />
            <TextField label="Reorder point" name="reorderPoint" defaultValue={String(material.reorderPoint || 0)} autoComplete="off" />
            <TextField label="Lead time days" name="leadTimeDays" defaultValue={String(material.leadTimeDays || preferredVendor?.leadTimeDays || "")} autoComplete="off" />
            <Button submit>Save inventory settings</Button>
          </InlineStack>
        </Form>

        <Form method="post">
          <input type="hidden" name="intent" value="quickPurchase" />
          <input type="hidden" name="materialId" value={material.id} />
          <InlineStack gap="200" blockAlign="end" wrap>
            <TextField label="Receive qty" name="purchaseQty" defaultValue={suggestion.suggestedQty > 0 ? qty(suggestion.suggestedQty) : ""} autoComplete="off" />
            <TextField label="Notes" name="notes" defaultValue="Received from reorder report." autoComplete="off" />
            <Button submit variant={lowStockOnly ? "primary" : "secondary"}>Add received stock</Button>
          </InlineStack>
        </Form>
      </BlockStack>
    </Card>
  );
}

export default function ReorderReport() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";

  const lowStockMaterials = data.lowStock || [];
  const allMaterials = data.materials || [];
  const reorderValue = lowStockMaterials.reduce((sum: number, material: any) => {
    const suggestion = suggestedReorder(material);
    const cost = material.calculatedUnitCost || material.costPerUnit || 0;
    return sum + suggestion.suggestedQty * cost;
  }, 0);

  return (
    <Page
      title="Reorder Report"
      subtitle="Track low-stock materials, reorder points, recent usage, lead times, and suggested purchase quantities."
      primaryAction={{ content: "Open Materials", onAction: () => navigate("/app/erp/materials") }}
      secondaryActions={[{ content: "Production Board", onAction: () => navigate("/app/erp/production") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Inventory health</Text>
                  <Text as="p" tone="subdued">
                    Use this before buying materials. Production material deductions feed this report automatically.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Badge tone={lowStockMaterials.length ? "warning" : "success"}>{lowStockMaterials.length} low-stock</Badge>
                  <Badge tone={data.outOfStock?.length ? "critical" : "success"}>{data.outOfStock?.length || 0} out</Badge>
                </InlineStack>
              </InlineStack>

              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}

              <InlineStack gap="300" wrap>
                <Text as="p">Active materials: <strong>{allMaterials.length}</strong></Text>
                <Text as="p">Missing reorder points: <strong>{data.noReorderPoint?.length || 0}</strong></Text>
                <Text as="p">Suggested reorder value: <strong>${money(reorderValue)}</strong></Text>
                {busy ? <Badge>Saving...</Badge> : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Buy / reorder now</Text>
              <Badge tone={lowStockMaterials.length ? "warning" : "success"}>{lowStockMaterials.length}</Badge>
            </InlineStack>
            {lowStockMaterials.length ? (
              lowStockMaterials.map((material: any) => <MaterialCard key={material.id} material={material} lowStockOnly />)
            ) : (
              <Card><Text as="p" tone="subdued">No materials are below reorder point.</Text></Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recent inventory movements</Text>
              {(data.recentMovements || []).length ? (
                (data.recentMovements || []).map((movement: any) => (
                  <InlineStack key={movement.id} align="space-between" wrap>
                    <Text as="p">{new Date(movement.createdAt).toLocaleString()} | {movement.material?.name || "Material"} | {movement.movementType}</Text>
                    <Text as="p">{qty(movement.quantity)} {movement.unit} | Stock: {qty(movement.beforeQty)} → {qty(movement.afterQty)}</Text>
                  </InlineStack>
                ))
              ) : (
                <Text as="p" tone="subdued">No inventory movements yet.</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">All material inventory</Text>
              <Badge>{allMaterials.length}</Badge>
            </InlineStack>
            {allMaterials.map((material: any) => <MaterialCard key={material.id} material={material} />)}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
