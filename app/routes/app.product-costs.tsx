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

import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

type ShopifyVariantOption = {
  label: string;
  value: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  price: string;
};

async function searchShopifyProducts(admin: any, search: string) {
  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String!) {
        products(first: 20, query: $query) {
          nodes {
            id
            title
            variants(first: 50) {
              nodes {
                id
                title
                sku
                price
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        query: search ? `title:*${search}*` : "",
      },
    }
  );

  const json = await response.json();
  const options: ShopifyVariantOption[] = [];

  for (const product of json.data?.products?.nodes || []) {
    for (const variant of product.variants?.nodes || []) {
      options.push({
        label: `${product.title} — ${variant.title} — $${variant.price}`,
        value: variant.id,
        productId: product.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku || "",
        price: String(variant.price || "0"),
      });
    }
  }

  return options;
}

export async function loader({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);

  const productOptions = await searchShopifyProducts(admin, "");

  const productCosts = await db.productCost.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    productOptions,
    productCosts,
  });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "searchProducts") {
    const productOptions = await searchShopifyProducts(admin, payload.search || "");
    return Response.json({ ok: true, productOptions });
  }

  if (payload.intent === "delete") {
    await db.productCost.deleteMany({
      where: {
        id: payload.id,
        shop,
      },
    });

    const productCosts = await db.productCost.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
    });

    return Response.json({ ok: true, productCosts });
  }

  if (payload.intent === "save") {
    const item = payload.item;

    const materialCost = Number(item.materialCost) || 0;
    const printCost = Number(item.printCost) || 0;
    const laborCost = Number(item.laborCost) || 0;
    const machineCost = Number(item.machineCost) || 0;
    const packagingCost = Number(item.packagingCost) || 0;

    if (item.id) {
      await db.productCost.updateMany({
        where: {
          id: item.id,
          shop,
        },
        data: {
          productId: item.productId || "",
          variantId: item.variantId || "",
          sku: item.sku || "",
          productName: item.productName || "",
          name: item.variantName || "",
          materialCost,
          printCost,
          laborCost,
          machineCost,
          packagingCost,
        },
      });
    } else {
      await db.productCost.create({
        data: {
          shop,
          productId: item.productId || "",
          variantId: item.variantId || "",
          sku: item.sku || "",
          productName: item.productName || "",
          name: item.variantName || "",
          materialCost,
          printCost,
          laborCost,
          machineCost,
          packagingCost,
        },
      });
    }

    const productCosts = await db.productCost.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
    });

    return Response.json({ ok: true, productCosts });
  }

  return Response.json({ ok: false });
}

export default function ProductCostsPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [productOptions, setProductOptions] = useState<ShopifyVariantOption[]>(
    loaderData.productOptions || []
  );

  const [productCosts, setProductCosts] = useState<any[]>(
    loaderData.productCosts || []
  );

  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [productName, setProductName] = useState("");
  const [variantName, setVariantName] = useState("");
  const [sku, setSku] = useState("");

  const [materialCost, setMaterialCost] = useState("0");
  const [printCost, setPrintCost] = useState("0");
  const [laborCost, setLaborCost] = useState("0");
  const [machineCost, setMachineCost] = useState("0");
  const [packagingCost, setPackagingCost] = useState("0");

  useEffect(() => {
    if (fetcher.data?.productOptions) {
      setProductOptions(fetcher.data.productOptions);
    }

    if (fetcher.data?.productCosts) {
      setProductCosts(fetcher.data.productCosts);
    }
  }, [fetcher.data]);

  const totalUnitCost = useMemo(() => {
    return (
      (Number(materialCost) || 0) +
      (Number(printCost) || 0) +
      (Number(laborCost) || 0) +
      (Number(machineCost) || 0) +
      (Number(packagingCost) || 0)
    );
  }, [materialCost, printCost, laborCost, machineCost, packagingCost]);

  function resetForm() {
    setEditingId(null);
    setProductId("");
    setVariantId("");
    setProductName("");
    setVariantName("");
    setSku("");
    setMaterialCost("0");
    setPrintCost("0");
    setLaborCost("0");
    setMachineCost("0");
    setPackagingCost("0");
  }

  function searchProducts() {
    fetcher.submit(
      { intent: "searchProducts", search },
      { method: "post", encType: "application/json" }
    );
  }

  function selectVariant(value: string) {
    const selected = productOptions.find((option) => option.value === value);
    if (!selected) return;

    setProductId(selected.productId);
    setVariantId(selected.value);
    setProductName(selected.productTitle);
    setVariantName(selected.variantTitle);
    setSku(selected.sku);
  }

  function editCost(cost: any) {
    setEditingId(cost.id);
    setProductId(cost.productId || "");
    setVariantId(cost.variantId || "");
    setProductName(cost.productName || "");
    setVariantName(cost.name || "");
    setSku(cost.sku || "");
    setMaterialCost(String(cost.materialCost || 0));
    setPrintCost(String(cost.printCost || 0));
    setLaborCost(String(cost.laborCost || 0));
    setMachineCost(String(cost.machineCost || 0));
    setPackagingCost(String(cost.packagingCost || 0));
  }

  function saveCost() {
    fetcher.submit(
      {
        intent: "save",
        item: {
          id: editingId,
          productId,
          variantId,
          productName,
          variantName,
          sku,
          materialCost,
          printCost,
          laborCost,
          machineCost,
          packagingCost,
        },
      },
      { method: "post", encType: "application/json" }
    );

    resetForm();
  }

  function deleteCost(id: string) {
    fetcher.submit(
      { intent: "delete", id },
      { method: "post", encType: "application/json" }
    );
  }

  const productSelectOptions = [
    { label: "Select Shopify product / variant", value: "" },
    ...productOptions.map((option) => ({
      label: option.label,
      value: option.value,
    })),
  ];

  return (
    <Page
      title="Product Cost Database"
      subtitle="Save real unit costs per Shopify product or variant so quotes can auto-fill costs and margins."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{
        content: editingId ? "Update Product Cost" : "Save Product Cost",
        onAction: saveCost,
      }}
      secondaryActions={[
        {
          content: "Quotes / CRM",
          onAction: () => navigate("/app/quotes"),
        },
        {
          content: "Cost Calculator",
          onAction: () => navigate("/app/wholesale/calculator"),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Shopify Product Picker
                  </Text>
                  <Text as="p" tone="subdued">
                    Search your Shopify products, select a variant, then save cost data.
                  </Text>
                </BlockStack>

                <Badge tone="success">
                  {productCosts.length} saved costs
                </Badge>
              </InlineStack>

              <InlineStack gap="300" blockAlign="end">
                <TextField
                  label="Search Shopify products"
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder="Example: Ritz, jar, bag, label"
                />

                <Button onClick={searchProducts}>Search Products</Button>
              </InlineStack>

              <Select
                label="Pick Shopify product / variant"
                value={variantId}
                onChange={selectVariant}
                options={productSelectOptions}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Cost Setup
                </Text>

                <Badge tone="info">
                  Unit Cost ${totalUnitCost.toFixed(2)}
                </Badge>
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Product Name"
                  value={productName}
                  onChange={setProductName}
                  autoComplete="off"
                />

                <TextField
                  label="Variant / Option"
                  value={variantName}
                  onChange={setVariantName}
                  autoComplete="off"
                />

                <TextField
                  label="SKU"
                  value={sku}
                  onChange={setSku}
                  autoComplete="off"
                />
              </InlineStack>

              <Divider />

              <InlineStack gap="300">
                <TextField
                  label="Material Cost"
                  prefix="$"
                  value={materialCost}
                  onChange={setMaterialCost}
                  autoComplete="off"
                />

                <TextField
                  label="Print Cost"
                  prefix="$"
                  value={printCost}
                  onChange={setPrintCost}
                  autoComplete="off"
                />

                <TextField
                  label="Labor Cost"
                  prefix="$"
                  value={laborCost}
                  onChange={setLaborCost}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Machine Cost"
                  prefix="$"
                  value={machineCost}
                  onChange={setMachineCost}
                  autoComplete="off"
                />

                <TextField
                  label="Packaging / Application Cost"
                  prefix="$"
                  value={packagingCost}
                  onChange={setPackagingCost}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveCost}>
                  {editingId ? "Update Cost" : "Save Cost"}
                </Button>

                <Button onClick={resetForm}>Clear Form</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Saved Product Costs
              </Text>

              {productCosts.length === 0 ? (
                <Text as="p" tone="subdued">
                  No saved product costs yet.
                </Text>
              ) : (
                productCosts.map((cost) => {
                  const unit =
                    Number(cost.materialCost || 0) +
                    Number(cost.printCost || 0) +
                    Number(cost.laborCost || 0) +
                    Number(cost.machineCost || 0) +
                    Number(cost.packagingCost || 0);

                  return (
                    <Card key={cost.id}>
                      <BlockStack gap="300">
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">
                              {cost.productName || "Unnamed product"}
                            </Text>

                            <Text as="p" tone="subdued">
                              Variant: {cost.name || "Default"} | SKU: {cost.sku || "None"}
                            </Text>
                          </BlockStack>

                          <Badge tone="success">
                            ${unit.toFixed(2)} unit cost
                          </Badge>
                        </InlineStack>

                        <InlineStack gap="300">
                          <Text as="p">Material: ${Number(cost.materialCost || 0).toFixed(2)}</Text>
                          <Text as="p">Print: ${Number(cost.printCost || 0).toFixed(2)}</Text>
                          <Text as="p">Labor: ${Number(cost.laborCost || 0).toFixed(2)}</Text>
                          <Text as="p">Machine: ${Number(cost.machineCost || 0).toFixed(2)}</Text>
                          <Text as="p">Packaging: ${Number(cost.packagingCost || 0).toFixed(2)}</Text>
                        </InlineStack>

                        <InlineStack gap="300">
                          <Button onClick={() => editCost(cost)}>Edit</Button>
                          <Button tone="critical" onClick={() => deleteCost(cost.id)}>
                            Delete
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