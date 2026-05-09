import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Select,
  Badge,
  Divider,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const materialTypes = [
  { label: "Roll Media", value: "roll_media" },
  { label: "Blanks", value: "blanks" },
  { label: "Ink / Coating", value: "ink_coating" },
  { label: "Packaging Supplies", value: "packaging_supplies" },
  { label: "Sourced Products", value: "sourced_products" },
  { label: "General", value: "general" },
];

const purchaseUnits = [
  { label: "Roll - calculate cost per sq ft / sq in", value: "roll" },
  { label: "Liquid / Cartridge - calculate cost per ml", value: "cartridge" },
  { label: "Gallon - calculate cost per ml", value: "gallon" },
  { label: "Case / Box - calculate cost per each", value: "case" },
  { label: "Each - use purchase cost per each", value: "each" },
  { label: "Hour - use purchase cost per hour", value: "hour" },
];

const legacyMaterialTypeMap: Record<string, string> = {
  label: "roll_media",
  laminate: "roll_media",
  dtp: "blanks",
  box: "blanks",
  die_cut: "packaging_supplies",
  ink: "ink_coating",
  adhesive: "packaging_supplies",
  packaging: "packaging_supplies",
  sourced_product: "sourced_products",
  labor: "general",
  machine: "general",
  shipping: "packaging_supplies",
};

const baseUnitLabels: Record<string, string> = {
  each: "Each",
  sqft: "Sq Ft",
  sqin: "Sq In",
  ml: "ML",
  hour: "Hour",
};

const ML_PER_GALLON = 3785.41;

function normalizeMaterialType(value?: string) {
  if (!value) return "general";
  return legacyMaterialTypeMap[value] || value;
}

function getMaterialTypeLabel(value?: string) {
  const normalizedValue = normalizeMaterialType(value);
  return (
    materialTypes.find((type) => type.value === normalizedValue)?.label ||
    value ||
    "General"
  );
}

function normalizePurchaseUnit(value?: string) {
  if (!value) return "each";
  if (value === "box") return "case";
  return value;
}

function getBaseUnitForPurchaseUnit(value?: string) {
  const purchaseUnit = normalizePurchaseUnit(value);

  if (purchaseUnit === "roll") return "sqft";
  if (purchaseUnit === "cartridge" || purchaseUnit === "gallon") return "ml";
  if (purchaseUnit === "hour") return "hour";

  return "each";
}

function getPurchaseUnitLabel(value?: string) {
  const normalizedValue = normalizePurchaseUnit(value);
  return (
    purchaseUnits.find((unit) => unit.value === normalizedValue)?.label ||
    normalizedValue ||
    "Each"
  );
}

function getBaseUnitLabel(value?: string) {
  return baseUnitLabels[value || "each"] || value || "Each";
}

function numberOrNull(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function numberOrZero(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function calculateRollAreaSqIn(payload: any) {
  const widthIn = numberOrZero(payload.rollWidthIn);
  const lengthFt = numberOrZero(payload.rollLengthFt);
  return widthIn * lengthFt * 12;
}

function calculateRollAreaSqFt(payload: any) {
  return calculateRollAreaSqIn(payload) / 144;
}

function calculateMaterialUnitCost(payload: any) {
  const purchaseCost = numberOrZero(payload.purchaseCost);
  const purchaseUnit = normalizePurchaseUnit(payload.purchaseUnit);

  if (purchaseUnit === "roll") {
    const totalSqFt = calculateRollAreaSqFt(payload);
    return totalSqFt > 0 ? purchaseCost / totalSqFt : 0;
  }

  if (purchaseUnit === "cartridge") {
    const volumeMl = numberOrZero(payload.volumeMl);
    return volumeMl > 0 ? purchaseCost / volumeMl : 0;
  }

  if (purchaseUnit === "gallon") {
    return purchaseCost / ML_PER_GALLON;
  }

  if (purchaseUnit === "case") {
    const caseQty = numberOrZero(payload.caseQuantity);
    return caseQty > 0 ? purchaseCost / caseQty : 0;
  }

  return purchaseCost;
}

function getMaterialUnitCost(material: any) {
  return Number(material.calculatedUnitCost || material.costPerUnit || 0);
}

function getCostLines(material: any) {
  const unitCost = getMaterialUnitCost(material);
  const purchaseUnit = normalizePurchaseUnit(material.purchaseUnit);
  const baseUnit = material.baseUnit || material.unit || getBaseUnitForPurchaseUnit(purchaseUnit);

  if (purchaseUnit === "roll") {
    const costPerSqFt = baseUnit === "sqin" ? unitCost * 144 : unitCost;
    const costPerSqIn = costPerSqFt / 144;

    return [
      `$${costPerSqFt.toFixed(6)} / sq ft`,
      `$${costPerSqIn.toFixed(6)} / sq in`,
    ];
  }

  if (purchaseUnit === "cartridge" || purchaseUnit === "gallon") {
    return [`$${unitCost.toFixed(6)} / ml`];
  }

  if (purchaseUnit === "hour") {
    return [`$${unitCost.toFixed(6)} / hour`];
  }

  return [`$${unitCost.toFixed(6)} / each`];
}

function materialInputData(payload: any, calculatedUnitCost: number) {
  const purchaseUnit = normalizePurchaseUnit(payload.purchaseUnit);
  const baseUnit = getBaseUnitForPurchaseUnit(purchaseUnit);

  return {
    name: payload.name,
    materialType: normalizeMaterialType(payload.materialType),
    vendor: payload.vendor || null,
    sku: payload.sku || null,
    stockOnHand: numberOrNull(payload.stockOnHand),
    reorderPoint: numberOrNull(payload.reorderPoint),
    leadTimeDays: numberOrNull(payload.leadTimeDays),
    notes: payload.notes || null,
    active: payload.active !== false,
    purchaseUnit,
    purchaseCost: numberOrZero(payload.purchaseCost),
    baseUnit,
    rollWidthIn: purchaseUnit === "roll" ? numberOrNull(payload.rollWidthIn) : null,
    rollLengthFt: purchaseUnit === "roll" ? numberOrNull(payload.rollLengthFt) : null,
    volumeMl: purchaseUnit === "cartridge" ? numberOrNull(payload.volumeMl) : null,
    caseQuantity: purchaseUnit === "case" ? numberOrNull(payload.caseQuantity) : null,
    calculatedUnitCost,
    costPerUnit: calculatedUnitCost,
    unit: baseUnit,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const materials = await db.material.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    include: {
      vendors: true,
      costHistory: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });

  return Response.json({ materials });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveMaterial") {
    const oldMaterial = payload.id
      ? await db.material.findFirst({ where: { id: payload.id, shop } })
      : null;

    const normalizedPayload = {
      ...payload,
      materialType: normalizeMaterialType(payload.materialType),
      purchaseUnit: normalizePurchaseUnit(payload.purchaseUnit),
    };
    const calculatedUnitCost = calculateMaterialUnitCost(normalizedPayload);
    const data = materialInputData(normalizedPayload, calculatedUnitCost);

    let material;

    if (payload.id) {
      material = await db.material.update({
        where: { id: payload.id },
        data,
      });

      if (
        oldMaterial &&
        Number(oldMaterial.costPerUnit) !== Number(calculatedUnitCost)
      ) {
        await db.materialCostHistory.create({
          data: {
            shop,
            materialId: material.id,
            oldCost: Number(oldMaterial.costPerUnit) || 0,
            newCost: calculatedUnitCost,
            vendor: payload.vendor || null,
            reason: payload.reason || "Cost updated",
            changedBy: session.shop,
          },
        });
      }
    } else {
      material = await db.material.create({
        data: {
          shop,
          ...data,
          active: true,
        },
      });

      await db.materialCostHistory.create({
        data: {
          shop,
          materialId: material.id,
          oldCost: 0,
          newCost: calculatedUnitCost,
          vendor: payload.vendor || null,
          reason: "Material created",
          changedBy: session.shop,
        },
      });
    }

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    return Response.json({ ok: true, materials });
  }

  if (payload.intent === "deleteMaterial") {
    await db.material.update({
      where: { id: payload.id },
      data: { active: false },
    });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    return Response.json({ ok: true, materials });
  }

  if (payload.intent === "addVendor") {
    await db.materialVendor.create({
      data: {
        shop,
        materialId: payload.materialId,
        vendorName: payload.vendorName,
        vendorSku: payload.vendorSku || null,
        unitCost: numberOrZero(payload.unitCost),
        unit: payload.unit || "each",
        moq: numberOrNull(payload.moq),
        leadTimeDays: numberOrNull(payload.leadTimeDays),
        notes: payload.notes || null,
        preferred: false,
        active: true,
      },
    });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    return Response.json({ ok: true, materials });
  }

  const materials = await db.material.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: {
      vendors: true,
      costHistory: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });

  return Response.json({ ok: false, materials });
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [materials, setMaterials] = useState<any[]>(loaderData.materials || []);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materialType, setMaterialType] = useState("roll_media");
  const [vendor, setVendor] = useState("");
  const [sku, setSku] = useState("");
  const [stockOnHand, setStockOnHand] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("roll");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [baseUnit, setBaseUnit] = useState("sqft");
  const [rollWidthIn, setRollWidthIn] = useState("");
  const [rollLengthFt, setRollLengthFt] = useState("");
  const [volumeMl, setVolumeMl] = useState("");
  const [caseQuantity, setCaseQuantity] = useState("");
  const [filter, setFilter] = useState("all");
  const [vendorMaterialId, setVendorMaterialId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorUnitCost, setVendorUnitCost] = useState("");
  const [vendorMoq, setVendorMoq] = useState("");
  const [vendorLeadTimeDays, setVendorLeadTimeDays] = useState("");

  useEffect(() => {
    if (fetcher.data?.materials) setMaterials(fetcher.data.materials);
  }, [fetcher.data]);

  useEffect(() => {
    setBaseUnit(getBaseUnitForPurchaseUnit(purchaseUnit));
  }, [purchaseUnit]);

  const previewPayload = {
    purchaseUnit,
    purchaseCost,
    baseUnit,
    rollWidthIn,
    rollLengthFt,
    volumeMl,
    caseQuantity,
  };
  const previewCost = calculateMaterialUnitCost(previewPayload);
  const previewLines = getCostLines({
    ...previewPayload,
    calculatedUnitCost: previewCost,
    costPerUnit: previewCost,
  });
  const previewRollSqFt = calculateRollAreaSqFt(previewPayload);
  const previewRollSqIn = calculateRollAreaSqIn(previewPayload);

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaterialType("roll_media");
    setVendor("");
    setSku("");
    setStockOnHand("");
    setReorderPoint("");
    setLeadTimeDays("");
    setReason("");
    setNotes("");
    setPurchaseUnit("roll");
    setPurchaseCost("");
    setBaseUnit("sqft");
    setRollWidthIn("");
    setRollLengthFt("");
    setVolumeMl("");
    setCaseQuantity("");
  }

  function saveMaterial() {
    if (!name.trim()) return;

    fetcher.submit(
      {
        intent: "saveMaterial",
        id: editingId,
        name,
        materialType,
        vendor,
        sku,
        stockOnHand,
        reorderPoint,
        leadTimeDays,
        reason,
        notes,
        purchaseUnit,
        purchaseCost,
        baseUnit,
        rollWidthIn,
        rollLengthFt,
        volumeMl,
        caseQuantity,
      },
      { method: "post", encType: "application/json" }
    );

    resetForm();
  }

  function editMaterial(material: any) {
    const normalizedPurchaseUnit = normalizePurchaseUnit(material.purchaseUnit);

    setEditingId(material.id);
    setName(material.name || "");
    setMaterialType(normalizeMaterialType(material.materialType));
    setVendor(material.vendor || "");
    setSku(material.sku || "");
    setStockOnHand(
      material.stockOnHand !== null && material.stockOnHand !== undefined
        ? String(material.stockOnHand)
        : ""
    );
    setReorderPoint(
      material.reorderPoint !== null && material.reorderPoint !== undefined
        ? String(material.reorderPoint)
        : ""
    );
    setLeadTimeDays(
      material.leadTimeDays !== null && material.leadTimeDays !== undefined
        ? String(material.leadTimeDays)
        : ""
    );
    setReason("");
    setNotes(material.notes || "");
    setPurchaseUnit(normalizedPurchaseUnit);
    setPurchaseCost(
      material.purchaseCost !== null && material.purchaseCost !== undefined
        ? String(material.purchaseCost)
        : ""
    );
    setBaseUnit(getBaseUnitForPurchaseUnit(normalizedPurchaseUnit));
    setRollWidthIn(
      material.rollWidthIn !== null && material.rollWidthIn !== undefined
        ? String(material.rollWidthIn)
        : ""
    );
    setRollLengthFt(
      material.rollLengthFt !== null && material.rollLengthFt !== undefined
        ? String(material.rollLengthFt)
        : ""
    );
    setVolumeMl(
      material.volumeMl !== null && material.volumeMl !== undefined
        ? String(material.volumeMl)
        : ""
    );
    setCaseQuantity(
      material.caseQuantity !== null && material.caseQuantity !== undefined
        ? String(material.caseQuantity)
        : ""
    );
  }

  function deleteMaterial(id: string) {
    fetcher.submit(
      { intent: "deleteMaterial", id },
      { method: "post", encType: "application/json" }
    );
  }

  function addVendor() {
    fetcher.submit(
      {
        intent: "addVendor",
        materialId: vendorMaterialId,
        vendorName,
        vendorSku,
        unitCost: vendorUnitCost,
        moq: vendorMoq,
        leadTimeDays: vendorLeadTimeDays,
      },
      { method: "post", encType: "application/json" }
    );

    setVendorMaterialId("");
    setVendorName("");
    setVendorSku("");
    setVendorUnitCost("");
    setVendorMoq("");
    setVendorLeadTimeDays("");
  }

  const filteredMaterials =
    filter === "all"
      ? materials
      : materials.filter((m) => normalizeMaterialType(m.materialType) === filter);

  return (
    <Page
      title="Material Center"
      subtitle="Simple material costing for rolls, ink, cases, each items, and labor."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "New Material", onAction: resetForm }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {editingId ? "Edit Material" : "Add Material"}
              </Text>

              <InlineStack gap="300">
                <TextField
                  label="Material Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                />

                <Select
                  label="Material Category"
                  value={materialType}
                  onChange={setMaterialType}
                  options={materialTypes}
                />
              </InlineStack>

              <InlineStack gap="300">
                <Select
                  label="Costing Method"
                  value={purchaseUnit}
                  onChange={setPurchaseUnit}
                  options={purchaseUnits}
                />

                <TextField
                  label="Purchase Cost"
                  prefix="$"
                  value={purchaseCost}
                  onChange={setPurchaseCost}
                  autoComplete="off"
                />
              </InlineStack>

              <Text as="p" tone="subdued">
                Recipes will consume this material as: {getBaseUnitLabel(baseUnit)}.
              </Text>

              {purchaseUnit === "roll" && (
                <InlineStack gap="300">
                  <TextField
                    label="Roll Width Inches"
                    value={rollWidthIn}
                    onChange={setRollWidthIn}
                    autoComplete="off"
                  />

                  <TextField
                    label="Roll Length Feet"
                    value={rollLengthFt}
                    onChange={setRollLengthFt}
                    autoComplete="off"
                  />
                </InlineStack>
              )}

              {purchaseUnit === "cartridge" && (
                <TextField
                  label="Volume ML"
                  value={volumeMl}
                  onChange={setVolumeMl}
                  autoComplete="off"
                />
              )}

              {purchaseUnit === "gallon" && (
                <Text as="p" tone="subdued">
                  One gallon is treated as {ML_PER_GALLON.toLocaleString()} ml.
                </Text>
              )}

              {purchaseUnit === "case" && (
                <TextField
                  label="Quantity In Case/Box"
                  value={caseQuantity}
                  onChange={setCaseQuantity}
                  autoComplete="off"
                />
              )}

              <Divider />

              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Calculated Cost Preview
                </Text>

                {previewLines.map((line) => (
                  <Text as="p" key={line}>
                    {line}
                  </Text>
                ))}

                {purchaseUnit === "roll" && previewRollSqFt > 0 && (
                  <Text as="p" tone="subdued">
                    Total usable roll area: {previewRollSqFt.toFixed(2)} sq ft / {previewRollSqIn.toFixed(0)} sq in.
                  </Text>
                )}
              </BlockStack>

              <Divider />

              <InlineStack gap="300">
                <TextField
                  label="Vendor"
                  value={vendor}
                  onChange={setVendor}
                  autoComplete="off"
                />

                <TextField
                  label="Vendor / Material SKU"
                  value={sku}
                  onChange={setSku}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Stock On Hand"
                  value={stockOnHand}
                  onChange={setStockOnHand}
                  autoComplete="off"
                />

                <TextField
                  label="Reorder Point"
                  value={reorderPoint}
                  onChange={setReorderPoint}
                  autoComplete="off"
                />

                <TextField
                  label="Lead Time Days"
                  value={leadTimeDays}
                  onChange={setLeadTimeDays}
                  autoComplete="off"
                />
              </InlineStack>

              <TextField
                label="Reason For Cost Change"
                value={reason}
                onChange={setReason}
                autoComplete="off"
              />

              <TextField
                label="Notes"
                value={notes}
                onChange={setNotes}
                multiline={3}
                autoComplete="off"
              />

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveMaterial}>
                  {editingId ? "Update Material" : "Save Material"}
                </Button>

                <Button onClick={resetForm}>Clear</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Vendor Comparison
              </Text>

              <Select
                label="Material"
                value={vendorMaterialId}
                onChange={setVendorMaterialId}
                options={[
                  { label: "Select material", value: "" },
                  ...materials.map((m) => ({
                    label: m.name,
                    value: m.id,
                  })),
                ]}
              />

              <InlineStack gap="300">
                <TextField
                  label="Vendor Name"
                  value={vendorName}
                  onChange={setVendorName}
                  autoComplete="off"
                />

                <TextField
                  label="Vendor SKU"
                  value={vendorSku}
                  onChange={setVendorSku}
                  autoComplete="off"
                />

                <TextField
                  label="Unit Cost"
                  prefix="$"
                  value={vendorUnitCost}
                  onChange={setVendorUnitCost}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="MOQ"
                  value={vendorMoq}
                  onChange={setVendorMoq}
                  autoComplete="off"
                />

                <TextField
                  label="Lead Time Days"
                  value={vendorLeadTimeDays}
                  onChange={setVendorLeadTimeDays}
                  autoComplete="off"
                />
              </InlineStack>

              <Button onClick={addVendor}>Add Vendor Option</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Materials
                </Text>

                <Select
                  label="Filter"
                  labelHidden
                  value={filter}
                  onChange={setFilter}
                  options={[{ label: "All", value: "all" }, ...materialTypes]}
                />
              </InlineStack>

              <Divider />

              {filteredMaterials.length === 0 ? (
                <Text as="p" tone="subdued">
                  No materials yet.
                </Text>
              ) : (
                filteredMaterials.map((material) => {
                  const lowStock =
                    material.stockOnHand !== null &&
                    material.reorderPoint !== null &&
                    Number(material.stockOnHand) <= Number(material.reorderPoint);
                  const costLines = getCostLines(material);

                  return (
                    <Card key={material.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="p" fontWeight="bold">
                            {material.name}
                          </Text>

                          <InlineStack gap="200">
                            <Badge>{getMaterialTypeLabel(material.materialType)}</Badge>

                            {lowStock && <Badge tone="critical">LOW STOCK</Badge>}
                          </InlineStack>
                        </InlineStack>

                        <Text as="p" tone="subdued">
                          Costing method: {getPurchaseUnitLabel(material.purchaseUnit)}
                        </Text>

                        <BlockStack gap="100">
                          {costLines.map((line) => (
                            <Text as="p" key={line}>
                              Cost: {line}
                            </Text>
                          ))}
                        </BlockStack>

                        <Text as="p">Vendor: {material.vendor || "N/A"}</Text>

                        <InlineStack gap="200">
                          <Button onClick={() => editMaterial(material)}>Edit</Button>

                          <Button
                            tone="critical"
                            onClick={() => deleteMaterial(material.id)}
                          >
                            Deactivate
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  );
                })
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
