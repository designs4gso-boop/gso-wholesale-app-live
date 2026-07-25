import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import type React from "react";
import { authenticate } from "../shopify.server";
import { findLikelyDuplicates } from "../lib/product-family-registry";
import db from "../db.server";

function clean(value: FormDataEntryValue | null) {
  return String(value || "").trim();
}

function num(value: FormDataEntryValue | null) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value: FormDataEntryValue | null) {
  const n = num(value);
  return n > 0 ? n : null;
}

function nullableDate(value: FormDataEntryValue | null) {
  const raw = clean(value);
  return raw ? new Date(`${raw}T12:00:00`) : null;
}

function money(value: any) {
  return `$${(Number(value) || 0).toFixed(4)}`;
}

function qty(value: any) {
  return (Number(value) || 0).toFixed(2).replace(/\.00$/, "");
}

function todayInput() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function vendorLabel(vendor: any) {
  const status = vendor.status ? ` (${vendor.status})` : "";
  return `${vendor.name}${status}`;
}

async function resolveVendor(shop: string, vendorId: string | null, fallbackName: string | null) {
  if (vendorId) {
    const vendor = await db.vendor.findFirst({ where: { shop, id: vendorId } });
    if (vendor) return { vendorId: vendor.id, vendorName: vendor.name, leadTimeDays: vendor.leadTimeDays || null };
  }
  const name = clean(fallbackName || "");
  return { vendorId: null, vendorName: name || null, leadTimeDays: null };
}

async function createCostItemFromMaterial(shop: string, material: any) {
  const existing = await db.vendorCostBookItem.findFirst({
    where: {
      shop,
      materialId: material.id,
      vendorName: material.vendor || undefined,
      itemName: material.name,
    },
  });
  if (existing) return false;

  await db.vendorCostBookItem.create({
    data: {
      shop,
      vendorId: material.primaryVendorId || null,
      vendorName: material.vendor || null,
      itemType: "material",
      materialId: material.id,
      itemName: material.name,
      vendorSku: material.sku || null,
      unit: material.unit || material.baseUnit || "each",
      unitCost: Number(material.calculatedUnitCost || material.costPerUnit || material.purchaseCost || 0),
      moq: null,
      leadTimeDays: material.leadTimeDays || null,
      effectiveDate: new Date(),
      status: "active",
      preferred: Boolean(material.primaryVendorId || material.vendor),
      notes: "Seeded from Material Center.",
    },
  });
  return true;
}

async function createCostItemFromVendorProduct(shop: string, product: any) {
  const existing = await db.vendorCostBookItem.findFirst({
    where: {
      shop,
      vendorProductId: product.id,
      itemName: product.name,
    },
  });
  if (existing) return false;

  await db.vendorCostBookItem.create({
    data: {
      shop,
      vendorId: product.vendorId || null,
      vendorName: product.vendor || null,
      itemType: "vendor_product",
      vendorProductId: product.id,
      itemName: product.name,
      vendorSku: product.vendorSku || null,
      unit: "each",
      unitCost: Number(product.defaultUnitCost || 0),
      moq: product.moq || null,
      leadTimeDays: product.leadTimeDays || null,
      effectiveDate: new Date(),
      status: "active",
      preferred: Boolean(product.vendorId || product.vendor),
      notes: "Seeded from Vendor Product Center.",
      tiers: {
        create: (product.tiers || []).map((tier: any) => ({
          shop,
          minQty: Number(tier.minQty || 1),
          maxQty: tier.maxQty == null ? null : Number(tier.maxQty),
          unitCost: Number(tier.unitCost || 0),
          notes: tier.notes || null,
        })),
      },
    },
  });
  return true;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [vendors, materials, vendorProducts, costItems] = await Promise.all([
    db.vendor.findMany({ where: { shop, active: true }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    db.material.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
    db.vendorProduct.findMany({ where: { shop, active: true }, include: { tiers: { orderBy: { minQty: "asc" } } }, orderBy: { name: "asc" } }),
    db.vendorCostBookItem.findMany({
      where: { shop },
      include: { tiers: { orderBy: { minQty: "asc" } } },
      orderBy: [{ preferred: "desc" }, { vendorName: "asc" }, { itemName: "asc" }],
    }),
  ]);

  const vendorMap = new Map(vendors.map((vendor: any) => [vendor.id, vendor]));
  const materialMap = new Map(materials.map((material: any) => [material.id, material]));
  const vendorProductMap = new Map(vendorProducts.map((product: any) => [product.id, product]));

  const enrichedCostItems = costItems.map((item: any) => ({
    ...item,
    vendorRecord: item.vendorId ? vendorMap.get(item.vendorId) || null : null,
    material: item.materialId ? materialMap.get(item.materialId) || null : null,
    vendorProduct: item.vendorProductId ? vendorProductMap.get(item.vendorProductId) || null : null,
  }));

  const activeCount = costItems.filter((item: any) => item.status === "active").length;
  const preferredCount = costItems.filter((item: any) => item.preferred).length;
  const missingVendorCount = costItems.filter((item: any) => !item.vendorId && !item.vendorName).length;

  return Response.json({
    vendors,
    materials,
    vendorProducts,
    costItems: enrichedCostItems,
    summary: { activeCount, preferredCount, missingVendorCount, totalCount: costItems.length },
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = clean(formData.get("intent"));

  if (intent === "createCostItem") {
    const vendor = await resolveVendor(shop, clean(formData.get("vendorId")) || null, clean(formData.get("vendorName")) || null);
    const itemType = clean(formData.get("itemType")) || "material";
    const materialId = clean(formData.get("materialId")) || null;
    const vendorProductId = clean(formData.get("vendorProductId")) || null;
    let itemName = clean(formData.get("itemName"));

    if (!itemName && materialId) {
      const material = await db.material.findFirst({ where: { shop, id: materialId } });
      itemName = material?.name || "";
    }
    if (!itemName && vendorProductId) {
      const product = await db.vendorProduct.findFirst({ where: { shop, id: vendorProductId } });
      itemName = product?.name || "";
    }

    if (!itemName) return Response.json({ ok: false, message: "Item name is required." }, { status: 400 });

    // 15B duplicate prevention: WARN before creating a likely-duplicate cost
    // item (same sku, same normalized name, or same vendor + size/spec).
    const confirmDuplicate = clean(formData.get("confirmDuplicate")) === "1";
    const existingItems = await db.vendorCostBookItem.findMany({ where: { shop, status: { not: "inactive" } }, select: { id: true, itemName: true, vendorName: true, vendorSku: true }, take: 400 });
    const likelyDuplicates = findLikelyDuplicates(
      { name: itemName, vendor: vendor.vendorName, vendorSku: clean(formData.get("vendorSku")) },
      existingItems.map((row) => ({ id: row.id, name: row.itemName, vendor: row.vendorName, vendorSku: row.vendorSku })),
    );
    if (likelyDuplicates.length && !confirmDuplicate) {
      return Response.json({ ok: false, message: `Likely duplicate cost item(s): ${likelyDuplicates.slice(0, 5).map((row) => row.name).join("; ")}. Nothing was created or merged — tick "Create anyway (not a duplicate)" to confirm.` }, { status: 409 });
    }

    await db.vendorCostBookItem.create({
      data: {
        shop,
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        itemType,
        materialId,
        vendorProductId,
        itemName,
        vendorSku: clean(formData.get("vendorSku")) || null,
        unit: clean(formData.get("unit")) || "each",
        unitCost: num(formData.get("unitCost")),
        moq: nullableNum(formData.get("moq")),
        leadTimeDays: Number(formData.get("leadTimeDays") || vendor.leadTimeDays || 0) || null,
        effectiveDate: nullableDate(formData.get("effectiveDate")) || new Date(),
        expiresAt: nullableDate(formData.get("expiresAt")),
        status: clean(formData.get("status")) || "active",
        preferred: clean(formData.get("preferred")) === "true",
        currency: clean(formData.get("currency")) || "USD",
        notes: clean(formData.get("notes")) || null,
      },
    });

    return Response.json({ ok: true, message: "Vendor cost book item created." });
  }

  if (intent === "updateCostItem") {
    const id = clean(formData.get("id"));
    const vendor = await resolveVendor(shop, clean(formData.get("vendorId")) || null, clean(formData.get("vendorName")) || null);
    await db.vendorCostBookItem.updateMany({
      where: { shop, id },
      data: {
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        vendorSku: clean(formData.get("vendorSku")) || null,
        unit: clean(formData.get("unit")) || "each",
        unitCost: num(formData.get("unitCost")),
        moq: nullableNum(formData.get("moq")),
        leadTimeDays: Number(formData.get("leadTimeDays") || vendor.leadTimeDays || 0) || null,
        effectiveDate: nullableDate(formData.get("effectiveDate")),
        expiresAt: nullableDate(formData.get("expiresAt")),
        status: clean(formData.get("status")) || "active",
        preferred: clean(formData.get("preferred")) === "true",
        notes: clean(formData.get("notes")) || null,
      },
    });
    return Response.json({ ok: true, message: "Vendor cost item updated." });
  }

  if (intent === "addTier") {
    const costBookItemId = clean(formData.get("costBookItemId"));
    await db.vendorCostBookTier.create({
      data: {
        shop,
        vendorCostBookItemId: costBookItemId,
        minQty: num(formData.get("minQty")) || 1,
        maxQty: nullableNum(formData.get("maxQty")),
        unitCost: num(formData.get("tierUnitCost")),
        notes: clean(formData.get("tierNotes")) || null,
      },
    });
    return Response.json({ ok: true, message: "Price break added." });
  }

  if (intent === "deleteTier") {
    const id = clean(formData.get("id"));
    await db.vendorCostBookTier.deleteMany({ where: { shop, id } });
    return Response.json({ ok: true, message: "Price break removed." });
  }

  if (intent === "archiveCostItem") {
    const id = clean(formData.get("id"));
    await db.vendorCostBookItem.updateMany({ where: { shop, id }, data: { status: "inactive", preferred: false } });
    return Response.json({ ok: true, message: "Cost item archived." });
  }

  if (intent === "applyToMaterial") {
    const id = clean(formData.get("id"));
    const item = await db.vendorCostBookItem.findFirst({ where: { shop, id } });
    if (!item || !item.materialId) return Response.json({ ok: false, message: "This cost item is not linked to a material." }, { status: 400 });

    await db.material.update({
      where: { id: item.materialId },
      data: {
        primaryVendorId: item.vendorId || null,
        vendor: item.vendorName || null,
        sku: item.vendorSku || undefined,
        leadTimeDays: item.leadTimeDays || undefined,
        costPerUnit: item.unitCost,
        calculatedUnitCost: item.unitCost,
        purchaseCost: item.unitCost,
      },
    });

    await db.materialCostHistory.create({
      data: {
        shop,
        materialId: item.materialId,
        oldCost: 0,
        newCost: item.unitCost,
        vendor: item.vendorName || null,
        reason: `Applied from Vendor Cost Book: ${item.itemName}`,
      },
    }).catch(() => null);

    return Response.json({ ok: true, message: "Vendor cost applied to Material Center." });
  }

  if (intent === "applyToVendorProduct") {
    const id = clean(formData.get("id"));
    const item = await db.vendorCostBookItem.findFirst({ where: { shop, id }, include: { tiers: true } });
    if (!item || !item.vendorProductId) return Response.json({ ok: false, message: "This cost item is not linked to a vendor product." }, { status: 400 });

    await db.vendorProduct.update({
      where: { id: item.vendorProductId },
      data: {
        vendorId: item.vendorId || null,
        vendor: item.vendorName || null,
        vendorSku: item.vendorSku || undefined,
        moq: Math.round(item.moq || 1),
        defaultUnitCost: item.unitCost,
        leadTimeDays: item.leadTimeDays || undefined,
      },
    });

    if (item.tiers?.length) {
      await db.vendorProductTier.deleteMany({ where: { shop, vendorProductId: item.vendorProductId } });
      await db.vendorProductTier.createMany({
        data: item.tiers.map((tier: any) => ({
          shop,
          vendorProductId: item.vendorProductId!,
          minQty: Math.round(tier.minQty || 1),
          maxQty: tier.maxQty == null ? null : Math.round(tier.maxQty),
          unitCost: Number(tier.unitCost || 0),
          notes: tier.notes || null,
        })),
      });
    }

    return Response.json({ ok: true, message: "Vendor cost applied to Vendor Product Center." });
  }

  if (intent === "seedFromMaterials") {
    const materials = await db.material.findMany({ where: { shop, active: true } });
    let created = 0;
    for (const material of materials) {
      if (await createCostItemFromMaterial(shop, material)) created += 1;
    }
    return Response.json({ ok: true, message: `Seeded ${created} material cost book item(s).` });
  }

  if (intent === "seedFromVendorProducts") {
    const products = await db.vendorProduct.findMany({ where: { shop, active: true }, include: { tiers: true } });
    let created = 0;
    for (const product of products) {
      if (await createCostItemFromVendorProduct(shop, product)) created += 1;
    }
    return Response.json({ ok: true, message: `Seeded ${created} vendor product cost item(s).` });
  }

  return Response.json({ ok: false, message: "Unknown cost book action." }, { status: 400 });
}

function SelectBox({ name, defaultValue, children }: { name: string; defaultValue?: string; children: React.ReactNode }) {
  return <select name={name} defaultValue={defaultValue || ""} style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8 }}>{children}</select>;
}

function NativeLabel({ children }: { children: React.ReactNode }) {
  return <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{children}</label>;
}


function NativeInput({ label, name, defaultValue = "", type = "text", step, placeholder }: { label: string; name: string; defaultValue?: string; type?: string; step?: string; placeholder?: string }) {
  return (
    <label style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
      {label}
      <input name={name} type={type} step={step} defaultValue={defaultValue} placeholder={placeholder} style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8, marginTop: 4, fontWeight: 400 }} />
    </label>
  );
}

function NativeTextarea({ label, name, defaultValue = "", placeholder }: { label: string; name: string; defaultValue?: string; placeholder?: string }) {
  return (
    <label style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
      {label}
      <textarea name={name} defaultValue={defaultValue} placeholder={placeholder} rows={3} style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8, marginTop: 4, fontWeight: 400 }} />
    </label>
  );
}

function VendorOptions({ vendors }: { vendors: any[] }) {
  return (
    <>
      <option value="">Manual / fallback vendor</option>
      {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendorLabel(vendor)}</option>)}
    </>
  );
}

function CostItemCard({ item, vendors }: { item: any; vendors: any[] }) {
  const activeTier = (item.tiers || []).find((tier: any) => Number(tier.minQty || 0) <= Number(item.moq || 1)) || null;
  const bestCost = activeTier?.unitCost || item.unitCost;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">{item.itemName}</Text>
              {item.preferred ? <Badge tone="success">Preferred</Badge> : null}
              <Badge tone={item.status === "active" ? "success" : "warning"}>{item.status}</Badge>
              <Badge>{item.itemType}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">Vendor: {item.vendorRecord?.name || item.vendorName || "Not set"} | SKU: {item.vendorSku || "None"}</Text>
            <Text as="p">Base Cost: <strong>{money(item.unitCost)}</strong> / {item.unit} | Best Cost: <strong>{money(bestCost)}</strong> | MOQ: {item.moq ? qty(item.moq) : "None"} | Lead time: {item.leadTimeDays || "?"} days</Text>
          </BlockStack>
          <InlineStack gap="200">
            {item.materialId ? <Form method="post"><input type="hidden" name="intent" value="applyToMaterial" /><input type="hidden" name="id" value={item.id} /><Button submit>Apply to Material</Button></Form> : null}
            {item.vendorProductId ? <Form method="post"><input type="hidden" name="intent" value="applyToVendorProduct" /><input type="hidden" name="id" value={item.id} /><Button submit>Apply to Vendor Product</Button></Form> : null}
            <Form method="post"><input type="hidden" name="intent" value="archiveCostItem" /><input type="hidden" name="id" value={item.id} /><Button tone="critical" submit>Archive</Button></Form>
          </InlineStack>
        </InlineStack>

        <Divider />

        <Form method="post">
          <input type="hidden" name="intent" value="updateCostItem" />
          <input type="hidden" name="id" value={item.id} />
          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <div style={{ minWidth: 220, flex: 1 }}><NativeLabel>Vendor Center Vendor</NativeLabel><SelectBox name="vendorId" defaultValue={item.vendorId || ""}><VendorOptions vendors={vendors} /></SelectBox></div>
              <div style={{ minWidth: 200, flex: 1 }}><NativeInput label="Vendor fallback" name="vendorName" defaultValue={item.vendorName || ""} /></div>
              <div style={{ minWidth: 160 }}><NativeInput label="Vendor SKU" name="vendorSku" defaultValue={item.vendorSku || ""} /></div>
              <div style={{ minWidth: 100 }}><NativeInput label="Unit" name="unit" defaultValue={item.unit || "each"} /></div>
              <div style={{ minWidth: 120 }}><NativeInput label="Unit cost" name="unitCost" type="number" step="0.0001" defaultValue={String(item.unitCost || 0)} /></div>
            </InlineStack>
            <InlineStack gap="200" wrap>
              <div style={{ minWidth: 120 }}><NativeInput label="MOQ" name="moq" type="number" step="1" defaultValue={item.moq ? String(item.moq) : ""} /></div>
              <div style={{ minWidth: 140 }}><NativeInput label="Lead time days" name="leadTimeDays" type="number" defaultValue={item.leadTimeDays ? String(item.leadTimeDays) : ""} /></div>
              <div style={{ minWidth: 150 }}><NativeInput label="Effective date" name="effectiveDate" type="date" defaultValue={item.effectiveDate ? new Date(item.effectiveDate).toISOString().slice(0, 10) : ""} /></div>
              <div style={{ minWidth: 150 }}><NativeInput label="Expires" name="expiresAt" type="date" defaultValue={item.expiresAt ? new Date(item.expiresAt).toISOString().slice(0, 10) : ""} /></div>
              <div style={{ minWidth: 140 }}><NativeLabel>Status</NativeLabel><SelectBox name="status" defaultValue={item.status || "active"}><option value="active">Active</option><option value="draft">Draft</option><option value="expired">Expired</option><option value="inactive">Inactive</option></SelectBox></div>
              <div style={{ minWidth: 140 }}><NativeLabel>Preferred</NativeLabel><SelectBox name="preferred" defaultValue={item.preferred ? "true" : "false"}><option value="false">No</option><option value="true">Yes</option></SelectBox></div>
            </InlineStack>
            <NativeTextarea label="Notes" name="notes" defaultValue={item.notes || ""} />
            <Button submit>Save cost item</Button>
          </BlockStack>
        </Form>

        <Divider />

        <BlockStack gap="200">
          <Text as="h4" variant="headingSm">Price breaks</Text>
          {(item.tiers || []).length ? (item.tiers || []).map((tier: any) => (
            <InlineStack key={tier.id} gap="200" align="space-between" blockAlign="center">
              <Text as="p">{qty(tier.minQty)} - {tier.maxQty ? qty(tier.maxQty) : "∞"}: <strong>{money(tier.unitCost)}</strong> / {item.unit} {tier.notes ? `| ${tier.notes}` : ""}</Text>
              <Form method="post"><input type="hidden" name="intent" value="deleteTier" /><input type="hidden" name="id" value={tier.id} /><Button tone="critical" submit>Remove</Button></Form>
            </InlineStack>
          )) : <Text as="p" tone="subdued">No price breaks yet.</Text>}

          <Form method="post">
            <input type="hidden" name="intent" value="addTier" />
            <input type="hidden" name="costBookItemId" value={item.id} />
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: 100 }}><NativeInput label="Min qty" name="minQty" type="number" defaultValue="1" /></div>
              <div style={{ minWidth: 100 }}><NativeInput label="Max qty" name="maxQty" type="number" /></div>
              <div style={{ minWidth: 120 }}><NativeInput label="Tier cost" name="tierUnitCost" type="number" step="0.0001" /></div>
              <div style={{ minWidth: 240, flex: 1 }}><NativeInput label="Tier notes" name="tierNotes" /></div>
              <Button submit>Add price break</Button>
            </InlineStack>
          </Form>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

export default function VendorCostBook() {
  const { vendors, materials, vendorProducts, costItems, summary } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";

  const vendorOptions = vendors || [];
  const materialOptions = materials || [];
  const productOptions = vendorProducts || [];

  return (
    <Page
      title="Vendor Cost Book"
      subtitle="Reusable vendor pricing, MOQs, lead times, and price breaks for materials and sourced products."
      backAction={{ content: "Vendors", onAction: () => navigate("/app/erp/vendors") }}
      secondaryActions={[
        { content: "Materials", onAction: () => navigate("/app/erp/materials") },
        { content: "PO Requests", onAction: () => navigate("/app/erp/purchase-requests") },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Cost book overview</Text>
                  <Text as="p" tone="subdued">Centralize vendor costs before applying them to Material Center, Vendor Products, and PO workflows.</Text>
                </BlockStack>
                <InlineStack gap="200"><Badge tone="success">{summary.activeCount} active</Badge><Badge>{summary.preferredCount} preferred</Badge><Badge tone={summary.missingVendorCount ? "warning" : "success"}>{summary.missingVendorCount} missing vendor</Badge></InlineStack>
              </InlineStack>
              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}
              <InlineStack gap="200" wrap>
                <Form method="post"><input type="hidden" name="intent" value="seedFromMaterials" /><Button submit loading={busy}>Seed from Materials</Button></Form>
                <Form method="post"><input type="hidden" name="intent" value="seedFromVendorProducts" /><Button submit loading={busy}>Seed from Vendor Products</Button></Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Add vendor cost item</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="createCostItem" /><label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" name="confirmDuplicate" value="1" /> Create anyway (not a duplicate)</label>
                <BlockStack gap="250">
                  <InlineStack gap="200" wrap>
                    <div style={{ minWidth: 220, flex: 1 }}><NativeLabel>Vendor Center Vendor</NativeLabel><SelectBox name="vendorId"><VendorOptions vendors={vendorOptions} /></SelectBox></div>
                    <div style={{ minWidth: 220, flex: 1 }}><NativeInput label="Vendor fallback" name="vendorName" /></div>
                    <div style={{ minWidth: 160 }}><NativeLabel>Item type</NativeLabel><SelectBox name="itemType" defaultValue="material"><option value="material">Material</option><option value="vendor_product">Vendor Product</option><option value="sourced_product">Sourced Product</option><option value="service">Service</option><option value="other">Other</option></SelectBox></div>
                  </InlineStack>

                  <InlineStack gap="200" wrap>
                    <div style={{ minWidth: 260, flex: 1 }}><NativeLabel>Linked material optional</NativeLabel><SelectBox name="materialId"><option value="">Not linked to material</option>{materialOptions.map((material: any) => <option key={material.id} value={material.id}>{material.name}</option>)}</SelectBox></div>
                    <div style={{ minWidth: 260, flex: 1 }}><NativeLabel>Linked vendor product optional</NativeLabel><SelectBox name="vendorProductId"><option value="">Not linked to vendor product</option>{productOptions.map((product: any) => <option key={product.id} value={product.id}>{product.name}</option>)}</SelectBox></div>
                  </InlineStack>

                  <InlineStack gap="200" wrap>
                    <div style={{ minWidth: 260, flex: 2 }}><NativeInput label="Item name" name="itemName" /></div>
                    <div style={{ minWidth: 160 }}><NativeInput label="Vendor SKU" name="vendorSku" /></div>
                    <div style={{ minWidth: 100 }}><NativeInput label="Unit" name="unit" defaultValue="each" /></div>
                    <div style={{ minWidth: 120 }}><NativeInput label="Unit cost" name="unitCost" type="number" step="0.0001" /></div>
                  </InlineStack>

                  <InlineStack gap="200" wrap>
                    <div style={{ minWidth: 120 }}><NativeInput label="MOQ" name="moq" type="number" /></div>
                    <div style={{ minWidth: 140 }}><NativeInput label="Lead time days" name="leadTimeDays" type="number" /></div>
                    <div style={{ minWidth: 150 }}><NativeInput label="Effective date" name="effectiveDate" type="date" defaultValue={todayInput()} /></div>
                    <div style={{ minWidth: 150 }}><NativeInput label="Expires" name="expiresAt" type="date" /></div>
                    <div style={{ minWidth: 140 }}><NativeLabel>Preferred</NativeLabel><SelectBox name="preferred" defaultValue="false"><option value="false">No</option><option value="true">Yes</option></SelectBox></div>
                  </InlineStack>

                  <NativeTextarea label="Notes" name="notes" />
                  <Button submit variant="primary" loading={busy}>Create cost item</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Cost book items</Text>
              <Badge>{summary.totalCount} total</Badge>
            </InlineStack>
            {costItems.length ? costItems.map((item: any) => <CostItemCard key={item.id} item={item} vendors={vendorOptions} />) : <Card><Text as="p" tone="subdued">No vendor cost book items yet. Seed from Materials/Vendor Products or create one manually.</Text></Card>}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
