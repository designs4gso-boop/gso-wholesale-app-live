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
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  return null;
}

type QuoteItem = {
  id: string;
  productName: string;
  variant: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  notes: string;
};

type Quote = {
  id: string;
  customerName: string;
  company: string;
  email: string;
  phone: string;
  status: string;
  items: QuoteItem[];
  notes: string;
  createdAt: string;
};

const STORAGE_KEY = "gso_quotes_v1";

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

function emptyItem(): QuoteItem {
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

export default function QuotesPage() {
  const navigate = useNavigate();

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState("draft");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<QuoteItem[]>([emptyItem()]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) setQuotes(JSON.parse(raw));
  }, []);

  function saveAll(next: Quote[]) {
    setQuotes(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

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

  function addItem() {
    setItems([...items, emptyItem()]);
  }

  function updateItem(id: string, field: keyof QuoteItem, value: string) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function deleteItem(id: string) {
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

  function saveQuote() {
    const quote: Quote = {
      id: editingId || uid(),
      customerName,
      company,
      email,
      phone,
      status,
      items,
      notes,
      createdAt: editingId
        ? quotes.find((q) => q.id === editingId)?.createdAt || new Date().toLocaleString()
        : new Date().toLocaleString(),
    };

    const next = editingId
      ? quotes.map((q) => (q.id === editingId ? quote : q))
      : [quote, ...quotes];

    saveAll(next);
    setEditingId(quote.id);
  }

  function loadQuote(quote: Quote) {
    setEditingId(quote.id);
    setCustomerName(quote.customerName);
    setCompany(quote.company);
    setEmail(quote.email);
    setPhone(quote.phone);
    setStatus(quote.status);
    setItems(quote.items);
    setNotes(quote.notes);
  }

  function deleteQuote(id: string) {
    saveAll(quotes.filter((quote) => quote.id !== id));
    if (editingId === id) resetQuote();
  }

  function updateQuoteStatus(id: string, nextStatus: string) {
    const next = quotes.map((quote) =>
      quote.id === id ? { ...quote, status: nextStatus } : quote
    );
    saveAll(next);
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

  let tone: "success" | "warning" | "critical" = "success";
  if (totals.margin < 25) tone = "critical";
  else if (totals.margin < 40) tone = "warning";

  return (
    <Page
      title="GSO Quote Builder"
      subtitle="Create quotes, save customer history, track pipeline status, and send or print quotes."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: editingId ? "Update Quote" : "Save Quote", onAction: saveQuote }}
      secondaryActions={[
        { content: "New Quote", onAction: resetQuote },
        { content: "Print / PDF", onAction: printQuote },
        { content: "Email Quote", onAction: emailQuote },
        { content: "Pricing Calculator", onAction: () => navigate("/app/wholesale/calculator") },
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
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Quote Items</Text>
                <Button onClick={addItem}>Add Item</Button>
              </InlineStack>

              {items.map((item) => (
                <Card key={item.id}>
                  <BlockStack gap="300">
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
                    <Button tone="critical" onClick={() => deleteItem(item.id)}>Delete Item</Button>
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
                                <Text as="p" tone="subdued">{quote.createdAt}</Text>

                                <Select
                                  label="Move"
                                  value={quote.status}
                                  onChange={(v) => updateQuoteStatus(quote.id, v)}
                                  options={statuses}
                                />

                                <InlineStack gap="200">
                                  <Button onClick={() => loadQuote(quote)}>Open</Button>
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