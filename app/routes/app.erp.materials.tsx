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
  { label: "Label", value: "label" },
  { label: "DTP", value: "dtp" },
  { label: "Box", value: "box" },
  { label: "Die Cut", value: "die_cut" },
  { label: "Ink", value: "ink" },
  { label: "Laminate", value: "laminate" },
  { label: "Labor", value: "labor" },
  { label: "Machine", value: "machine" },
  { label: "Shipping", value: "shipping" },
  { label: "General", value: "general" },
];

const units = [
  { label: "Each", value: "each" },
  { label: "Sq Ft", value: "sqft" },
  { label: "Linear Ft", value: "linear_ft" },
  { label: "Roll", value: "roll" },
  { label: "Sheet", value: "sheet" },
  { label: "ML", value: "ml" },
  { label: "Hour", value: "hour" },
  { label: "Minute", value: "minute" },
  { label: "Case", value: "case" },
  { label: "Box", value: "box" },
];

const purchaseUnits = [
  { label: "Each", value: "each" },
  { label: "Roll", value: "roll" },
  { label: "Cartridge", value: "cartridge" },
  { label: "Gallon", value: "gallon" },
  { label: "Case", value: "case" },
  { label: "Box", value: "box" },
  { label: "Hour", value: "hour" },
];

const baseUnits = [
  { label: "Each", value: "each" },
  { label: "Sq Ft", value: "sqft" },
  { label: "Sq In", value: "sqin" },
  { label: "ML", value: "ml" },
  { label: "Hour", value: "hour" },
];

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

const calculatedUnitCost = calculateMaterialUnitCost(payload);

    let material;

    if (payload.id) {
      material = await db.material.update({
        where: { id: payload.id },
        data: {
          name: payload.name,
          materialType: payload.materialType,
          vendor: payload.vendor || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : null,
          notes: payload.notes || null,
          active: payload.active !== false,
          purchaseUnit: payload.purchaseUnit || "each",
          purchaseCost: Number(payload.purchaseCost) || 0,
          baseUnit: payload.baseUnit || "each",
          rollWidthIn: payload.rollWidthIn ? Number(payload.rollWidthIn) : null,
          rollLengthFt: payload.rollLengthFt ? Number(payload.rollLengthFt) : null,
          volumeMl: payload.volumeMl ? Number(payload.volumeMl) : null,
          caseQuantity: payload.caseQuantity ? Number(payload.caseQuantity) : null,
          calculatedUnitCost,
          costPerUnit: calculatedUnitCost,
          unit: payload.baseUnit || "each",
        },
      });

      if (
        oldMaterial &&
        Number(oldMaterial.costPerUnit) !== Number(payload.costPerUnit)
      ) {
        await db.materialCostHistory.create({
          data: {
            shop,
            materialId: material.id,
            oldCost: Number(oldMaterial.costPerUnit) || 0,
            newCost: calculatedUnitCost,            vendor: payload.vendor || null,
            reason: payload.reason || "Cost updated",
            changedBy: session.shop,
          },
        });
      }
    } else {
      material = await db.material.create({
        data: {
          shop,
          name: payload.name,
          materialType: payload.materialType,
          vendor: payload.vendor || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : null,
          notes: payload.notes || null,
          active: true,
          purchaseUnit: payload.purchaseUnit || "each",
          purchaseCost: Number(payload.purchaseCost) || 0,
          baseUnit: payload.baseUnit || "each",
          rollWidthIn: payload.rollWidthIn ? Number(payload.rollWidthIn) : null,
          rollLengthFt: payload.rollLengthFt ? Number(payload.rollLengthFt) : null,
          volumeMl: payload.volumeMl ? Number(payload.volumeMl) : null,
          caseQuantity: payload.caseQuantity ? Number(payload.caseQuantity) : null,
          calculatedUnitCost,
          costPerUnit: calculatedUnitCost,
          unit: payload.baseUnit || "each",
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
        unitCost: Number(payload.unitCost) || 0,
        unit: payload.unit || "each",
        moq: payload.moq ? Number(payload.moq) : null,
        leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : null,
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

function calculateMaterialUnitCost(payload: any) {
  const purchaseCost = Number(payload.purchaseCost) || 0;

  if (payload.purchaseUnit === "roll") {
    const widthIn = Number(payload.rollWidthIn) || 0;
    const lengthFt = Number(payload.rollLengthFt) || 0;
    const totalSqIn = widthIn * lengthFt * 12;
    const totalSqFt = totalSqIn / 144;

    if (payload.baseUnit === "sqin") {
      return totalSqIn > 0 ? purchaseCost / totalSqIn : 0;
    }

    return totalSqFt > 0 ? purchaseCost / totalSqFt : 0;
  }

  if (payload.purchaseUnit === "cartridge") {
    const volumeMl = Number(payload.volumeMl) || 0;
    return volumeMl > 0 ? purchaseCost / volumeMl : 0;
  }

  if (payload.purchaseUnit === "gallon") {
    const volumeMl = 3785.41;
    return purchaseCost / volumeMl;
  }

  if (payload.purchaseUnit === "case" || payload.purchaseUnit === "box") {
    const caseQty = Number(payload.caseQuantity) || 0;
    return caseQty > 0 ? purchaseCost / caseQty : 0;
  }

  return purchaseCost;
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [materials, setMaterials] = useState<any[]>(loaderData.materials || []);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materialType, setMaterialType] = useState("label");
  const [vendor, setVendor] = useState("");
  const [sku, setSku] = useState("");
  const [stockOnHand, setStockOnHand] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("each");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [baseUnit, setBaseUnit] = useState("each");
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

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaterialType("label");
    setUnit("each");
    setCostPerUnit("");
    setVendor("");
    setSku("");
    setStockOnHand("");
    setReorderPoint("");
    setLeadTimeDays("");
    setReason("");
    setNotes("");
  }

  function saveMaterial() {
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
    setEditingId(material.id);
    setName(material.name || "");
    setMaterialType(material.materialType || "label");
    setUnit(material.unit || "each");
    setCostPerUnit(String(material.costPerUnit || ""));
    setVendor(material.vendor || "");
    setSku(material.sku || "");
    setStockOnHand(material.stockOnHand ? String(material.stockOnHand) : "");
    setReorderPoint(material.reorderPoint ? String(material.reorderPoint) : "");
    setLeadTimeDays(material.leadTimeDays ? String(material.leadTimeDays) : "");
    setReason("");
    setNotes(material.notes || "");
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
      : materials.filter((m) => m.materialType === filter);

  return (
    <Page
      title="Material Center"
      subtitle="Advanced material costs, inventory, vendors, and cost history."
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
                    label="Material Type"
                    value={materialType}
                    onChange={setMaterialType}
                    options={materialTypes}
                />
                </InlineStack>

                <InlineStack gap="300">
                <Select
                    label="Purchase Unit"
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

                <Select
                    label="Recipe Base Unit"
                    value={baseUnit}
                    onChange={setBaseUnit}
                    options={baseUnits}
                />
                </InlineStack>

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

                {(purchaseUnit === "case" || purchaseUnit === "box") && (
                <TextField
                    label="Quantity In Case/Box"
                    value={caseQuantity}
                    onChange={setCaseQuantity}
                    autoComplete="off"
                />
                )}

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

                <Button onClick={resetForm}>
                    Clear
                </Button>
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

              <Button onClick={addVendor}>
                Add Vendor Option
              </Button>
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
                  options={[
                    { label: "All", value: "all" },
                    ...materialTypes,
                  ]}
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
                    Number(material.stockOnHand) <=
                      Number(material.reorderPoint);

                  return (
                    <Card key={material.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="p" fontWeight="bold">
                            {material.name}
                          </Text>

                          <InlineStack gap="200">
                            <Badge>
                              {material.materialType}
                            </Badge>

                            {lowStock && (
                              <Badge tone="critical">
                                LOW STOCK
                              </Badge>
                            )}
                          </InlineStack>
                        </InlineStack>

                        <Text as="p">
                          Cost: $
                          {Number(
                            material.calculatedUnitCost ||
                              material.costPerUnit ||
                              0
                          ).toFixed(6)}{" "}
                          / {material.baseUnit || material.unit}
                        </Text>

                        <Text as="p">
                          Vendor: {material.vendor || "N/A"}
                        </Text>

                        <InlineStack gap="200">
                          <Button
                            onClick={() => editMaterial(material)}
                          >
                            Edit
                          </Button>

                          <Button
                            tone="critical"
                            onClick={() =>
                              deleteMaterial(material.id)
                            }
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