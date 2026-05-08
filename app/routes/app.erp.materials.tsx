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

    let material;

    if (payload.id) {
      material = await db.material.update({
        where: { id: payload.id },
        data: {
          name: payload.name,
          materialType: payload.materialType,
          unit: payload.unit,
          costPerUnit: Number(payload.costPerUnit) || 0,
          vendor: payload.vendor || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : null,
          notes: payload.notes || null,
          active: payload.active !== false,
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
            newCost: Number(payload.costPerUnit) || 0,
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
          name: payload.name,
          materialType: payload.materialType,
          unit: payload.unit,
          costPerUnit: Number(payload.costPerUnit) || 0,
          vendor: payload.vendor || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : null,
          notes: payload.notes || null,
          active: true,
        },
      });

      await db.materialCostHistory.create({
        data: {
          shop,
          materialId: material.id,
          oldCost: 0,
          newCost: Number(payload.costPerUnit) || 0,
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

export default function MaterialsPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [materials, setMaterials] = useState<any[]>(loaderData.materials || []);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materialType, setMaterialType] = useState("label");
  const [unit, setUnit] = useState("each");
  const [costPerUnit, setCostPerUnit] = useState("");
  const [vendor, setVendor] = useState("");
  const [sku, setSku] = useState("");
  const [stockOnHand, setStockOnHand] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

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
        unit,
        costPerUnit,
        vendor,
        sku,
        stockOnHand,
        reorderPoint,
        leadTimeDays,
        reason,
        notes,
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
        unit,
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
                <TextField label="Material Name" value={name} onChange={setName} autoComplete="off" />
                <Select label="Material Type" value={materialType} onChange={setMaterialType} options={materialTypes} />
                <Select label="Unit" value={unit} onChange={setUnit} options={units} />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Cost Per Unit" prefix="$" value={costPerUnit} onChange={setCostPerUnit} autoComplete="off" />
                <TextField label="Vendor" value={vendor} onChange={setVendor} autoComplete="off" />
                <TextField label="Vendor / Material SKU" value={sku} onChange={setSku} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Stock On Hand" value={stockOnHand} onChange={setStockOnHand} autoComplete="off" />
                <TextField label="Reorder Point" value={reorderPoint} onChange={setReorderPoint} autoComplete="off" />
                <TextField label="Lead Time Days" value={leadTimeDays} onChange={setLeadTimeDays} autoComplete="off" />
              </InlineStack>

              <TextField label="Reason For Cost Change" value={reason} onChange={setReason} autoComplete="off" />
              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

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
              <Text as="h2" variant="headingMd">Vendor Comparison</Text>

              <Select
                label="Material"
                value={vendorMaterialId}
                onChange={setVendorMaterialId}
                options={[
                  { label: "Select material", value: "" },
                  ...materials.map((m) => ({ label: m.name, value: m.id })),
                ]}
              />

              <InlineStack gap="300">
                <TextField label="Vendor Name" value={vendorName} onChange={setVendorName} autoComplete="off" />
                <TextField label="Vendor SKU" value={vendorSku} onChange={setVendorSku} autoComplete="off" />
                <TextField label="Unit Cost" prefix="$" value={vendorUnitCost} onChange={setVendorUnitCost} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="MOQ" value={vendorMoq} onChange={setVendorMoq} autoComplete="off" />
                <TextField label="Lead Time Days" value={vendorLeadTimeDays} onChange={setVendorLeadTimeDays} autoComplete="off" />
              </InlineStack>

              <Button onClick={addVendor}>Add Vendor Option</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Materials</Text>
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
                <Text as="p" tone="subdued">No materials yet.</Text>
              ) : (
                filteredMaterials.map((material) => {
                  const lowStock =
                    material.stockOnHand !== null &&
                    material.reorderPoint !== null &&
                    Number(material.stockOnHand) <= Number(material.reorderPoint);

                  return (
                    <Card key={material.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="p" fontWeight="bold">{material.name}</Text>
                          <InlineStack gap="200">
                            <Badge>{material.materialType}</Badge>
                            {lowStock && <Badge tone="critical">LOW STOCK</Badge>}
                            {!material.active && <Badge tone="warning">Inactive</Badge>}
                          </InlineStack>
                        </InlineStack>

                        <Text as="p">Cost: ${Number(material.costPerUnit || 0).toFixed(4)} / {material.unit}</Text>
                        <Text as="p">Vendor: {material.vendor || "N/A"}</Text>
                        <Text as="p">Stock: {material.stockOnHand ?? "N/A"} | Reorder: {material.reorderPoint ?? "N/A"}</Text>

                        {material.vendors?.length > 0 && (
                          <BlockStack gap="100">
                            <Text as="p" fontWeight="bold">Vendor Options</Text>
                            {material.vendors.map((v: any) => (
                              <Text as="p" key={v.id}>
                                {v.vendorName}: ${Number(v.unitCost || 0).toFixed(4)} / {v.unit}
                                {v.moq ? ` | MOQ: ${v.moq}` : ""}
                                {v.leadTimeDays ? ` | Lead: ${v.leadTimeDays} days` : ""}
                              </Text>
                            ))}
                          </BlockStack>
                        )}

                        {material.costHistory?.length > 0 && (
                          <BlockStack gap="100">
                            <Text as="p" fontWeight="bold">Recent Cost History</Text>
                            {material.costHistory.map((h: any) => (
                              <Text as="p" tone="subdued" key={h.id}>
                                ${Number(h.oldCost).toFixed(4)} → ${Number(h.newCost).toFixed(4)} | {new Date(h.createdAt).toLocaleString()} | {h.reason || "No reason"}
                              </Text>
                            ))}
                          </BlockStack>
                        )}

                        <InlineStack gap="200">
                          <Button onClick={() => editMaterial(material)}>Edit</Button>
                          {material.active && (
                            <Button tone="critical" onClick={() => deleteMaterial(material.id)}>
                              Deactivate
                            </Button>
                          )}
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