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

const productTypes = [
  { label: "Boxes", value: "box" },
  { label: "DTP Bags", value: "dtp_bag" },
  { label: "Die Cut Bags", value: "die_cut_bag" },
  { label: "Sourced Product", value: "sourced_product" },
  { label: "General", value: "general" },
];

const statusOptions = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

function numberOrZero(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInt(value: any, fallback = 1) {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nullableInt(value: any) {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function dollars(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function productTypeLabel(value: string) {
  return productTypes.find((type) => type.value === value)?.label || value || "Sourced Product";
}

function parseTiers(value: any, fallbackCost = 0) {
  if (Array.isArray(value)) {
    return value
      .map((item) => ({
        minQty: positiveInt(item.minQty, 1),
        unitCost: numberOrZero(item.unitCost),
        notes: item.notes || null,
      }))
      .filter((item) => item.minQty > 0)
      .sort((a, b) => a.minQty - b.minQty);
  }

  const parsed = String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        minQty: positiveInt(parts[0], 1),
        unitCost: numberOrZero(parts[1]),
        notes: parts.slice(2).join(" | ") || null,
      };
    })
    .filter((item) => item.minQty > 0)
    .sort((a, b) => a.minQty - b.minQty);

  if (parsed.length) return parsed;
  return [{ minQty: 1, unitCost: numberOrZero(fallbackCost), notes: null }];
}

function parseAddOns(value: any) {
  if (Array.isArray(value)) {
    return value
      .map((item) => ({
        name: String(item.name || "").trim(),
        pricingType: String(item.pricingType || "per_unit").trim(),
        amount: numberOrZero(item.amount),
        enabled: item.enabled !== false,
        notes: item.notes || null,
      }))
      .filter((item) => item.name);
  }

  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,]/).map((part) => part.trim());
      return {
        name: parts[0] || "Add-on",
        pricingType: parts[1] || "per_unit",
        amount: numberOrZero(parts[2]),
        enabled: true,
        notes: parts.slice(3).join(" | ") || null,
      };
    })
    .filter((item) => item.name);
}

function tiersToText(tiers: any[]) {
  return (tiers || [])
    .map((tier) => `${tier.minQty || 1} | ${numberOrZero(tier.unitCost)}`)
    .join("\n");
}

function addOnsToText(addOns: any[]) {
  return (addOns || [])
    .map((item) => `${item.name || "Add-on"} | ${item.pricingType || "per_unit"} | ${numberOrZero(item.amount)}`)
    .join("\n");
}

function costAtQuantity(vendorProduct: any, quantity: number) {
  const tiers = [...(vendorProduct?.tiers || [])].sort((a: any, b: any) => Number(a.minQty) - Number(b.minQty));
  let selected = null;
  for (const tier of tiers) {
    if (quantity >= Number(tier.minQty || 0)) selected = tier;
  }
  return selected ? numberOrZero(selected.unitCost) : numberOrZero(vendorProduct?.defaultUnitCost);
}

function estimateVendorProduct(vendorProduct: any, quantityInput: any) {
  const quantity = Math.max(positiveInt(vendorProduct?.moq, 1), positiveInt(quantityInput, 1));
  const unitCost = costAtQuantity(vendorProduct, quantity);
  const baseCost = unitCost * quantity;
  const addOns = (vendorProduct?.addOns || []).filter((item: any) => item.enabled !== false);
  const addOnCost = addOns.reduce((sum: number, item: any) => {
    const pricingType = item.pricingType || "per_unit";
    if (pricingType === "per_unit") return sum + numberOrZero(item.amount) * quantity;
    if (pricingType === "flat_fee") return sum + numberOrZero(item.amount);
    if (pricingType === "percent") return sum + baseCost * (numberOrZero(item.amount) / 100);
    return sum;
  }, 0);
  const totalCost = baseCost + addOnCost;
  return {
    quantity,
    unitCost,
    baseCost,
    addOnCost,
    totalCost,
    costEach: quantity > 0 ? totalCost / quantity : 0,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const vendorProducts = await db.vendorProduct.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: {
      tiers: { orderBy: { minQty: "asc" } },
      addOns: { orderBy: { createdAt: "asc" } },
      recipes: { select: { id: true, name: true, active: true } },
    },
  });

  return Response.json({ vendorProducts });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveVendorProduct") {
    const moq = positiveInt(payload.moq, 1);
    const defaultUnitCost = numberOrZero(payload.defaultUnitCost);
    const tiers = parseTiers(payload.tiers, defaultUnitCost);
    const addOns = parseAddOns(payload.addOns);

    const data = {
      shop,
      name: payload.name || "Untitled vendor product",
      productType: payload.productType || "sourced_product",
      vendor: payload.vendor || null,
      vendorSku: payload.vendorSku || null,
      moq,
      defaultUnitCost,
      leadTimeDays: nullableInt(payload.leadTimeDays),
      notes: payload.notes || null,
      active: true,
    };

    const vendorProduct = await db.$transaction(async (tx) => {
      let saved;

      if (payload.id) {
        saved = await tx.vendorProduct.update({
          where: { id: payload.id },
          data,
        });
        await tx.vendorProductTier.deleteMany({ where: { vendorProductId: payload.id, shop } });
        await tx.vendorProductAddOn.deleteMany({ where: { vendorProductId: payload.id, shop } });
      } else {
        saved = await tx.vendorProduct.create({ data });
      }

      for (const tier of tiers) {
        await tx.vendorProductTier.create({
          data: {
            shop,
            vendorProductId: saved.id,
            minQty: tier.minQty,
            unitCost: tier.unitCost,
            notes: tier.notes,
          },
        });
      }

      for (const addOn of addOns) {
        await tx.vendorProductAddOn.create({
          data: {
            shop,
            vendorProductId: saved.id,
            name: addOn.name,
            pricingType: addOn.pricingType,
            amount: addOn.amount,
            enabled: addOn.enabled,
            notes: addOn.notes,
          },
        });
      }

      return saved;
    });

    return Response.json({ ok: true, vendorProduct });
  }

  if (payload.intent === "archiveVendorProduct") {
    await db.vendorProduct.update({
      where: { id: payload.id },
      data: { active: false },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "restoreVendorProduct") {
    await db.vendorProduct.update({
      where: { id: payload.id },
      data: { active: true },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "deleteVendorProduct") {
    const recipeUsageCount = await db.productRecipe.count({
      where: { shop, vendorProductId: payload.id },
    });

    if (recipeUsageCount > 0) {
      return Response.json({
        ok: false,
        error: "This vendor product is used by one or more recipes, so it can only be archived.",
      });
    }

    await db.vendorProduct.delete({ where: { id: payload.id } });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false });
}

export default function VendorProductsPage() {
  const { vendorProducts } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState("active");
  const [name, setName] = useState("");
  const [productType, setProductType] = useState("box");
  const [vendor, setVendor] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [moq, setMoq] = useState("5");
  const [defaultUnitCost, setDefaultUnitCost] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [tiersText, setTiersText] = useState("5 | 2.25\n10 | 1.75\n25 | 1.20\n50 | 0.95");
  const [addOnsText, setAddOnsText] = useState("Gloss finish | per_unit | 0.08\nSetup fee | flat_fee | 75\nFreight | flat_fee | 120");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (fetcher.data?.ok) {
      resetForm();
      navigate(".");
    }
  }, [fetcher.data, navigate]);

  const filteredVendorProducts = vendorProducts.filter((item: any) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "archived") return item.active === false;
    return item.active !== false;
  });

  function applyProductType(value: string) {
    setProductType(value);
    if (value === "box") {
      setMoq("5");
      setTiersText("5 | 2.25\n10 | 1.75\n25 | 1.20\n50 | 0.95\n100 | 0.75");
    } else if (value === "dtp_bag" || value === "die_cut_bag") {
      setMoq("100");
      setTiersText("100 | 0.90\n250 | 0.70\n500 | 0.55\n1000 | 0.42");
    } else {
      setMoq("1");
      setTiersText("1 | 0.00\n10 | 0.00\n25 | 0.00\n50 | 0.00");
    }
  }

  function resetForm() {
    setEditingId(null);
    setName("");
    setProductType("box");
    setVendor("");
    setVendorSku("");
    setMoq("5");
    setDefaultUnitCost("");
    setLeadTimeDays("");
    setTiersText("5 | 2.25\n10 | 1.75\n25 | 1.20\n50 | 0.95");
    setAddOnsText("Gloss finish | per_unit | 0.08\nSetup fee | flat_fee | 75\nFreight | flat_fee | 120");
    setNotes("");
  }

  function saveVendorProduct() {
    fetcher.submit(
      {
        intent: "saveVendorProduct",
        id: editingId,
        name,
        productType,
        vendor,
        vendorSku,
        moq,
        defaultUnitCost,
        leadTimeDays,
        tiers: tiersText,
        addOns: addOnsText,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  function editVendorProduct(item: any) {
    setEditingId(item.id);
    setName(item.name || "");
    setProductType(item.productType || "sourced_product");
    setVendor(item.vendor || "");
    setVendorSku(item.vendorSku || "");
    setMoq(item.moq ? String(item.moq) : "1");
    setDefaultUnitCost(item.defaultUnitCost !== null && item.defaultUnitCost !== undefined ? String(item.defaultUnitCost) : "");
    setLeadTimeDays(item.leadTimeDays !== null && item.leadTimeDays !== undefined ? String(item.leadTimeDays) : "");
    setTiersText(tiersToText(item.tiers || []));
    setAddOnsText(addOnsToText(item.addOns || []));
    setNotes(item.notes || "");
  }

  function archiveVendorProduct(id: string) {
    fetcher.submit({ intent: "archiveVendorProduct", id }, { method: "post", encType: "application/json" });
  }

  function restoreVendorProduct(id: string) {
    fetcher.submit({ intent: "restoreVendorProduct", id }, { method: "post", encType: "application/json" });
  }

  function deleteVendorProduct(id: string) {
    if (!window.confirm("Permanently delete this vendor product? This cannot be undone.")) return;
    fetcher.submit({ intent: "deleteVendorProduct", id }, { method: "post", encType: "application/json" });
  }

  return (
    <Page title="Vendor Products" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Vendor Product Center
                  </Text>
                  <Text as="p" tone="subdued">
                    Use this for outsourced boxes, sourced bags, vendor-produced packaging, flat gloss charges, setup fees, freight, and vendor cost tiers. Do not create fake materials for outsourced products.
                  </Text>
                </BlockStack>
                {editingId ? <Badge tone="info">Editing</Badge> : <Badge>New vendor product</Badge>}
              </InlineStack>

              {fetcher.data?.error ? <Text as="p" tone="critical">{fetcher.data.error}</Text> : null}

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 2 }}>
                  <TextField label="Vendor Product Name" value={name} onChange={setName} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <Select label="Product Type" options={productTypes} value={productType} onChange={applyProductType} />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Vendor / Supplier" value={vendor} onChange={setVendor} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Vendor SKU" value={vendorSku} onChange={setVendorSku} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="MOQ" value={moq} onChange={setMoq} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Fallback Unit Cost" value={defaultUnitCost} onChange={setDefaultUnitCost} type="number" prefix="$" autoComplete="off" helpText="Used only if no tier matches." />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Lead Time Days" value={leadTimeDays} onChange={setLeadTimeDays} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <Card background="bg-surface-secondary">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Vendor Cost Tiers</Text>
                  <Text as="p" tone="subdued">
                    One tier per line: quantity | unit cost. The calculator uses the best tier at the quoted quantity.
                  </Text>
                  <TextField
                    label="Cost tiers"
                    value={tiersText}
                    onChange={setTiersText}
                    multiline={6}
                    autoComplete="off"
                    helpText="Example: 25 | 1.20"
                  />
                </BlockStack>
              </Card>

              <Card background="bg-surface-secondary">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Vendor Add-ons</Text>
                  <Text as="p" tone="subdued">
                    One add-on per line: name | per_unit, flat_fee, percent, or included | amount. Use this for gloss, setup, freight, plates, rush fees, or vendor extras.
                  </Text>
                  <TextField
                    label="Add-ons"
                    value={addOnsText}
                    onChange={setAddOnsText}
                    multiline={5}
                    autoComplete="off"
                    helpText="Examples: Gloss finish | per_unit | 0.08, Setup fee | flat_fee | 75, Freight | flat_fee | 120"
                  />
                </BlockStack>
              </Card>

              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

              <InlineStack gap="200">
                <Button variant="primary" onClick={saveVendorProduct} disabled={!name}>
                  {editingId ? "Update Vendor Product" : "Save Vendor Product"}
                </Button>
                <Button onClick={resetForm}>Clear</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Vendor Products</Text>
                <Select label="Status" labelHidden options={statusOptions} value={activeFilter} onChange={setActiveFilter} />
              </InlineStack>

              {filteredVendorProducts.length === 0 ? (
                <Text as="p" tone="subdued">No vendor products yet.</Text>
              ) : (
                filteredVendorProducts.map((item: any) => {
                  const testQuantity = item.moq || item.tiers?.[0]?.minQty || 1;
                  const estimate = estimateVendorProduct(item, testQuantity);
                  const tierSummary = item.tiers?.map((tier: any) => `${tier.minQty}: ${money(tier.unitCost)}`).join(", ") || "No tiers";
                  const addOnSummary = item.addOns?.length
                    ? item.addOns.map((addOn: any) => `${addOn.name} (${addOn.pricingType === "percent" ? `${addOn.amount}%` : dollars(addOn.amount)})`).join(", ")
                    : "No add-ons";

                  return (
                    <Card key={item.id} background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">{item.name}</Text>
                            <Text as="p" tone="subdued">
                              {productTypeLabel(item.productType)} • {item.vendor || "No vendor"} • MOQ {item.moq || 1} • Lead time {item.leadTimeDays || 0} days
                            </Text>
                          </BlockStack>
                          <InlineStack gap="100">
                            <Badge>{productTypeLabel(item.productType)}</Badge>
                            {item.active === false && <Badge tone="warning">ARCHIVED</Badge>}
                          </InlineStack>
                        </InlineStack>
                        <Text as="p">Vendor SKU: {item.vendorSku || "Not set"}</Text>
                        <Text as="p">Cost tiers: {tierSummary}</Text>
                        <Text as="p">Add-ons: {addOnSummary}</Text>
                        <Divider />
                        <InlineStack gap="500">
                          <Text as="p">Sample qty: {estimate.quantity}</Text>
                          <Text as="p">Base unit cost: {money(estimate.unitCost)}</Text>
                          <Text as="p">Add-on cost: {dollars(estimate.addOnCost)}</Text>
                          <Text as="p" fontWeight="bold">Total cost each: {money(estimate.costEach)}</Text>
                        </InlineStack>
                        {item.recipes?.length ? (
                          <Text as="p" tone="subdued">Used by recipes: {item.recipes.map((recipe: any) => recipe.name).join(", ")}</Text>
                        ) : null}
                        <InlineStack gap="200">
                          <Button onClick={() => editVendorProduct(item)}>Edit</Button>
                          {item.active === false ? (
                            <>
                              <Button onClick={() => restoreVendorProduct(item.id)}>Restore</Button>
                              <Button tone="critical" onClick={() => deleteVendorProduct(item.id)}>Delete Forever</Button>
                            </>
                          ) : (
                            <Button tone="critical" onClick={() => archiveVendorProduct(item.id)}>Archive</Button>
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
