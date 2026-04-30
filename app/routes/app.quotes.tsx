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
import db from "../db.server";

type QuoteItemInput = {
  id?: string;
  productName: string;
  variant: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  notes: string;
};

type ShopifyVariantOption = {
  label: string;
  value: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  price: string;
};

type QuoteInput = {
  id?: string | null;
  customerName: string;
  company: string;
  email: string;
  phone: string;
  status: string;
  notes: string;
  items: QuoteItemInput[];
};

const statuses = [
  { label: "Draft", value: "draft" },
  { label: "Sent", value: "sent" },
  { label: "Approved", value: "approved" },
  { label: "Paid", value: "paid" },
  { label: "In Production", value: "production" },
  { label: "Completed", value: "completed" },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clean(value: any) {
  return String(value || "").trim().toLowerCase();
}

function emptyItem(): QuoteItemInput {
  return {
    id: uid(),
    productName: "",
    variant: "",
    sku: "",
    quantity: "1000",
    unitPrice: "1.25",
    unitCost: "0.75",
    notes: "",
  };
}

function normalizeQuote(quote: any): QuoteInput {
  return {
    id: quote.id,
    customerName: quote.customerName || "",
    company: quote.company || "",
    email: quote.email || "",
    phone: quote.phone || "",
    status: quote.status || "draft",
    notes: quote.notes || "",
    items: (quote.items || []).map((item: any) => ({
      id: item.id,
      productName: item.productName || "",
      variant: item.variant || "",
      sku: item.sku || "",
      quantity: String(item.quantity || 1),
      unitPrice: String(item.unitPrice || 0),
      unitCost: String(item.unitCost || 0),
      notes: item.notes || "",
    })),
  };
}

async function getQuotes(shop: string) {
  return db.quote.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { items: true },
  });
}

async function searchShopifyProducts(admin: any, search: string) {
  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String!) {
        products(first: 20, query: $query) {
          nodes {
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

  const quotes = await getQuotes(session.shop);
  const productOptions = await searchShopifyProducts(admin, "");

  const productCosts = await db.productCost.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({
    quotes,
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
    await db.quote.deleteMany({ where: { id: payload.id, shop } });
    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  if (payload.intent === "status") {
    await db.quote.updateMany({
      where: { id: payload.id, shop },
      data: { status: payload.status },
    });

    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  if (payload.intent === "approveCreateOrder") {
  const quote = await db.quote.findFirst({
    where: {
      id: payload.quoteId,
      shop,
    },
    include: {
      items: true,
    },
  });

  if (!quote) {
    return Response.json({
      intent: "approveCreateOrder",
      ok: false,
      error: "Quote not found",
    });
  }

  const lineItems = quote.items.map((item: any) => ({
    title: item.productName || "Custom print item",
    quantity: Number(item.quantity) || 1,
    originalUnitPrice: String(Number(item.unitPrice) || 0),
    customAttributes: [
      { key: "Variant", value: item.variant || "" },
      { key: "SKU", value: item.sku || "" },
      { key: "Notes", value: item.notes || "" },
    ],
  }));

  const response = await admin.graphql(
    `#graphql
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          email: quote.email || undefined,
          note: `Created from GSO Quote Builder. Quote ID: ${quote.id}`,
          tags: ["GSO Quote", "Wholesale"],
          lineItems,
        },
      },
    }
  );

  const data = await response.json();
  const errors = data.data?.draftOrderCreate?.userErrors || [];

  if (errors.length) {
    return Response.json({
      intent: "approveCreateOrder",
      ok: false,
      errors,
    });
  }

  await db.quote.update({
    where: { id: quote.id },
    data: { status: "approved" },
  });

  const quotes = await getQuotes(shop);

  return Response.json({
    intent: "approveCreateOrder",
    ok: true,
    quotes,
    invoiceUrl: data.data?.draftOrderCreate?.draftOrder?.invoiceUrl,
  });
}

  if (payload.intent === "save") {
    const quote = payload.quote as QuoteInput;

    if (quote.id) {
      await db.$transaction([
        db.quote.updateMany({
          where: { id: quote.id, shop },
          data: {
            customerName: quote.customerName,
            company: quote.company,
            email: quote.email,
            phone: quote.phone,
            status: quote.status,
            notes: quote.notes,
          },
        }),
        db.quoteItem.deleteMany({ where: { quoteId: quote.id } }),
        db.quoteItem.createMany({
          data: quote.items.map((item) => ({
            quoteId: quote.id as string,
            productName: item.productName,
            variant: item.variant,
            sku: item.sku,
            quantity: Number(item.quantity) || 1,
            unitPrice: Number(item.unitPrice) || 0,
            unitCost: Number(item.unitCost) || 0,
            notes: item.notes,
          })),
        }),
      ]);
    } else {
      await db.quote.create({
        data: {
          shop,
          customerName: quote.customerName,
          company: quote.company,
          email: quote.email,
          phone: quote.phone,
          status: quote.status,
          notes: quote.notes,
          items: {
            create: quote.items.map((item) => ({
              productName: item.productName,
              variant: item.variant,
              sku: item.sku,
              quantity: Number(item.quantity) || 1,
              unitPrice: Number(item.unitPrice) || 0,
              unitCost: Number(item.unitCost) || 0,
              notes: item.notes,
            })),
          },
        },
      });
    }

    const quotes = await getQuotes(shop);
    return Response.json({ ok: true, quotes });
  }

  const quotes = await getQuotes(shop);
  return Response.json({ ok: false, quotes });
}

export default function QuotesPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [quotes, setQuotes] = useState<any[]>(loaderData.quotes || []);
  const [productOptions, setProductOptions] = useState<ShopifyVariantOption[]>(
    loaderData.productOptions || []
  );
  const [productCosts, setProductCosts] = useState<any[]>(
    loaderData.productCosts || []
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState("draft");
  const [notes, setNotes] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [items, setItems] = useState<QuoteItemInput[]>([emptyItem()]);

useEffect(() => {
  if (fetcher.data?.quotes) setQuotes(fetcher.data.quotes);
  if (fetcher.data?.productOptions) setProductOptions(fetcher.data.productOptions);
  if (fetcher.data?.productCosts) setProductCosts(fetcher.data.productCosts);

  if (fetcher.data?.intent === "approveCreateOrder") {
    if (!fetcher.data.ok) {
      alert("Draft order failed. Check Render logs.");
      console.log("Draft order error:", fetcher.data);
      return;
    }

    alert("Draft order created!");

    if (fetcher.data.invoiceUrl) {
      window.open(fetcher.data.invoiceUrl, "_blank");
    }
  }
}, [fetcher.data]);

  function resetQuote() {
    setEditingId(null);
    setCustomerName("");
    setCompany("");
    setEmail("");
    setPhone("");
    setStatus("draft");
    setNotes("");
    setItems([emptyItem()]);
  }

  function searchProducts() {
    fetcher.submit(
      { intent: "searchProducts", search: productSearch },
      { method: "post", encType: "application/json" }
    );
  }

  function addItem() {
    setItems([...items, emptyItem()]);
  }

  function updateItem(id: string | undefined, field: keyof QuoteItemInput, value: string) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function getMatchedProductCost(selected: ShopifyVariantOption, variantId: string) {
    return productCosts.find((cost: any) => {
      const costVariantId = clean(cost.variantId);
      const selectedVariantId = clean(variantId);
      const costSku = clean(cost.sku);
      const selectedSku = clean(selected.sku);
      const costProductName = clean(cost.productName || cost.name || cost.title || cost.productTitle);
      const selectedProductTitle = clean(selected.productTitle);

      return (
        (costVariantId && costVariantId === selectedVariantId) ||
        (costSku && selectedSku && costSku === selectedSku) ||
        (costProductName && selectedProductTitle && costProductName === selectedProductTitle)
      );
    });
  }

  function selectProductVariant(itemId: string | undefined, variantId: string) {
    const selected = productOptions.find((option) => option.value === variantId);
    if (!selected) return;

    const matchedCost = getMatchedProductCost(selected, variantId);

    const savedUnitCost = matchedCost
      ? (
          Number(matchedCost.materialCost || 0) +
          Number(matchedCost.printCost || 0) +
          Number(matchedCost.laborCost || 0) +
          Number(matchedCost.machineCost || 0) +
          Number(matchedCost.packagingCost || 0)
        ).toFixed(2)
      : undefined;

    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? {
              ...item,
              productName: selected.productTitle,
              variant: selected.variantTitle,
              sku: selected.sku,
              unitPrice: selected.price,
              unitCost: savedUnitCost || item.unitCost,
            }
          : item
      )
    );
  }

  function deleteItem(id: string | undefined) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  const totals = useMemo(() => {
    let revenue = 0;
    let cost = 0;

    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      revenue += qty * (Number(item.unitPrice) || 0);
      cost += qty * (Number(item.unitCost) || 0);
    }

    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    return { revenue, cost, profit, margin };
  }, [items]);

  function currentQuote(): QuoteInput {
    return {
      id: editingId,
      customerName,
      company,
      email,
      phone,
      status,
      notes,
      items,
    };
  }

  function saveQuote() {
    fetcher.submit(
      { intent: "save", quote: currentQuote() },
      { method: "post", encType: "application/json" }
    );
  }

  function loadQuote(quote: any) {
    const normalized = normalizeQuote(quote);

    setEditingId(normalized.id || null);
    setCustomerName(normalized.customerName);
    setCompany(normalized.company);
    setEmail(normalized.email);
    setPhone(normalized.phone);
    setStatus(normalized.status);
    setNotes(normalized.notes);
    setItems(normalized.items.length ? normalized.items : [emptyItem()]);
  }

  function deleteQuote(id: string) {
    fetcher.submit(
      { intent: "delete", id },
      { method: "post", encType: "application/json" }
    );

    if (editingId === id) resetQuote();
  }

  function updateQuoteStatus(id: string, nextStatus: string) {
    fetcher.submit(
      { intent: "status", id, status: nextStatus },
      { method: "post", encType: "application/json" }
    );
  }

  function printQuote() {
    window.print();
  }

  function emailQuote() {
    const body = encodeURIComponent(
      `GSO Packaging Quote\n\nCustomer: ${customerName}\nCompany: ${company}\n\nTotal: $${totals.revenue.toFixed(
        2
      )}\nProfit: $${totals.profit.toFixed(2)}\nMargin: ${totals.margin.toFixed(
        1
      )}%\n\nNotes:\n${notes}`
    );

    window.location.href = `mailto:${email}?subject=GSO Packaging Quote&body=${body}`;
  }

  function approveAndCreateOrder(quoteId: string) {
  fetcher.submit(
    {
      intent: "approveCreateOrder",
      quoteId,
    },
    {
      method: "post",
      encType: "application/json",
    }
  );
}

  let tone: "success" | "warning" | "critical" = "success";
  if (totals.margin < 25) tone = "critical";
  else if (totals.margin < 40) tone = "warning";

  const productSelectOptions = [
    { label: "Select Shopify product / variant", value: "" },
    ...productOptions.map((option) => ({
      label: option.label,
      value: option.value,
    })),
  ];

  return (
    <Page
      title="GSO Quote Builder"
      subtitle="Database CRM quotes with Shopify product picker, margins, pipeline, print, and email tools."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{
        content: editingId ? "Update Quote" : "Save Quote",
        onAction: saveQuote,
      }}
      secondaryActions={[
        { content: "New Quote", onAction: resetQuote },
        { content: "Print / PDF", onAction: printQuote },
        { content: "Email Quote", onAction: emailQuote },
        {
          content: "Pricing Calculator",
          onAction: () => navigate("/app/wholesale/calculator"),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Customer Info</Text>
                <Badge tone={tone}>Margin {totals.margin.toFixed(1)}%</Badge>
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Customer Name" value={customerName} onChange={setCustomerName} autoComplete="off" />
                <TextField label="Company" value={company} onChange={setCompany} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Email" value={email} onChange={setEmail} autoComplete="off" />
                <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
              </InlineStack>

              <Select label="Quote Status" value={status} onChange={setStatus} options={statuses} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Shopify Product Picker</Text>

              <InlineStack gap="300" blockAlign="end">
                <TextField
                  label="Search Shopify products"
                  value={productSearch}
                  onChange={setProductSearch}
                  autoComplete="off"
                  placeholder="Example: Ritz, bag, jar, label"
                />

                <Button onClick={searchProducts}>Search Products</Button>
              </InlineStack>

              <Text as="p" tone="subdued">
                Search products, then choose a product/variant inside each quote item.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Quote Items</Text>
                <Button onClick={addItem}>Add Item</Button>
              </InlineStack>

              {items.map((item) => (
                <Card key={item.id}>
                  <BlockStack gap="300">
                    <Select
                      label="Pick Shopify product / variant"
                      value=""
                      onChange={(variantId) => selectProductVariant(item.id, variantId)}
                      options={productSelectOptions}
                    />

                    <InlineStack gap="300">
                      <TextField label="Product / Service" value={item.productName} onChange={(v) => updateItem(item.id, "productName", v)} autoComplete="off" />
                      <TextField label="Variant / Options" value={item.variant} onChange={(v) => updateItem(item.id, "variant", v)} autoComplete="off" />
                      <TextField label="SKU" value={item.sku} onChange={(v) => updateItem(item.id, "sku", v)} autoComplete="off" />
                    </InlineStack>

                    <InlineStack gap="300">
                      <TextField label="Qty" value={item.quantity} onChange={(v) => updateItem(item.id, "quantity", v)} autoComplete="off" />
                      <TextField label="Unit Price" prefix="$" value={item.unitPrice} onChange={(v) => updateItem(item.id, "unitPrice", v)} autoComplete="off" />
                      <TextField label="Unit Cost" prefix="$" value={item.unitCost} onChange={(v) => updateItem(item.id, "unitCost", v)} autoComplete="off" />
                    </InlineStack>

                    <TextField label="Item Notes" value={item.notes} onChange={(v) => updateItem(item.id, "notes", v)} autoComplete="off" />

                    <Button tone="critical" onClick={() => deleteItem(item.id)}>
                      Delete Item
                    </Button>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Quote Summary</Text>
              <Divider />
              <Text as="p">Total Revenue: ${totals.revenue.toFixed(2)}</Text>
              <Text as="p">Total Cost: ${totals.cost.toFixed(2)}</Text>
              <Text as="p">Total Profit: ${totals.profit.toFixed(2)}</Text>
              <Text as="p">Margin: {totals.margin.toFixed(1)}%</Text>

              <TextField label="Quote Notes" value={notes} onChange={setNotes} multiline={4} autoComplete="off" />

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveQuote}>
                  {editingId ? "Update Quote" : "Save Quote"}
                </Button>
                <Button onClick={printQuote}>Download / Print PDF</Button>
                <Button onClick={emailQuote}>Email Quote</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">CRM Pipeline</Text>

              <InlineStack gap="300" align="start">
                {statuses.map((stage) => {
                  const stageQuotes = quotes.filter((q) => q.status === stage.value);

                  return (
                    <Card key={stage.value}>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          {stage.label} ({stageQuotes.length})
                        </Text>

                        {stageQuotes.length === 0 ? (
                          <Text as="p" tone="subdued">No quotes</Text>
                        ) : (
                          stageQuotes.map((quote) => (
                            <Card key={quote.id}>
                              <BlockStack gap="200">
                                <Text as="p" fontWeight="bold">
                                  {quote.company || quote.customerName || "Unnamed Quote"}
                                </Text>

                                <Text as="p" tone="subdued">
                                  {new Date(quote.updatedAt || quote.createdAt).toLocaleString()}
                                </Text>

                                <Select
                                  label="Move"
                                  value={quote.status}
                                  onChange={(v) => updateQuoteStatus(quote.id, v)}
                                  options={statuses}
                                />

                                <InlineStack gap="200">
                                  <Button onClick={() => loadQuote(quote)}>Open</Button>

                                  <Button
                                    variant="primary"
                                    onClick={() => approveAndCreateOrder(quote.id)}
                                  >
                                    Approve & Create Order
                                  </Button>

                                  <Button tone="critical" onClick={() => deleteQuote(quote.id)}>
                                    Delete
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          ))
                        )}
                      </BlockStack>
                    </Card>
                  );
                })}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}