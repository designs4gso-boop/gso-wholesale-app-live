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

const productTypeDefaults: Record<
  string,
  {
    name: string;
    productionMode: string;
    minQuantity: number;
    defaultQuantity: number;
    tiers: number[];
    defaultMarginPct: number;
    pricingMethod: string;
    defaultTags: string[];
  }
> = {
  label: {
    name: "Labels",
    productionMode: "in_house",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 100, 250, 500, 1000, 2500, 5000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:labels", "gso:in-house", "gso:wholesale"],
  },
  dtp_bag: {
    name: "DTP Bags",
    productionMode: "in_house",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:dtp-bags", "gso:in-house", "gso:wholesale"],
  },
  stock_bag: {
    name: "Stock Bags",
    productionMode: "outsourced",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:stock-bags", "gso:outsourced", "gso:wholesale"],
  },
  box: {
    name: "Boxes",
    productionMode: "outsourced",
    minQuantity: 5,
    defaultQuantity: 5,
    tiers: [5, 10, 25, 50, 100, 250, 500],
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:boxes", "gso:outsourced", "gso:wholesale"],
  },
  die_cut_bag: {
    name: "Die Cut Bags",
    productionMode: "hybrid",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2500, 5000, 10000],
    defaultMarginPct: 45,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:die-cut-bags", "gso:hybrid", "gso:wholesale"],
  },
  sourced_product: {
    name: "Sourced Products",
    productionMode: "outsourced",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100, 250, 500],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:sourced-products", "gso:outsourced", "gso:wholesale"],
  },
  general: {
    name: "General",
    productionMode: "in_house",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100],
    defaultMarginPct: 40,
    pricingMethod: "auto_margin",
    defaultTags: ["gso:general", "gso:wholesale"],
  },
};

const productionModeOptions = [
  { label: "In-house production", value: "in_house" },
  { label: "Outsourced / vendor produced", value: "outsourced" },
  { label: "Hybrid: vendor item + GSO finishing", value: "hybrid" },
];

const pricingMethodOptions = [
  { label: "Auto margin", value: "auto_margin" },
  { label: "Fixed unit price", value: "fixed_price" },
  { label: "Discount from first tier", value: "discount_from_first" },
  { label: "Markup over cost", value: "markup_over_cost" },
];

const statusOptions = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

function numberOrZero(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function positiveInt(value: any, fallback: number) {
  const numberValue = Math.round(Number(value));
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function parseBreakpoints(value: any) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item));
}

function normalizeBreakpoints(value: any, minQuantity: number) {
  const unique = new Set<number>([minQuantity]);
  for (const qty of parseBreakpoints(value)) {
    if (qty >= minQuantity) unique.add(qty);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function defaultRows(shop: string) {
  return Object.entries(productTypeDefaults).map(([key, defaults]) => ({
    shop,
    key,
    name: defaults.name,
    productionMode: defaults.productionMode,
    minQuantity: defaults.minQuantity,
    defaultQuantity: defaults.defaultQuantity,
    tierBreakpoints: defaults.tiers.join(", "),
    defaultMarginPct: defaults.defaultMarginPct,
    pricingMethod: defaults.pricingMethod,
    defaultTags: defaults.defaultTags.join(", "),
  }));
}

async function ensureProductTypeProfiles(shop: string) {
  const count = await db.productTypeProfile.count({ where: { shop } });
  if (count === 0) {
    await db.productTypeProfile.createMany({ data: defaultRows(shop) });
  }
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  await ensureProductTypeProfiles(shop);

  const profiles = await db.productTypeProfile.findMany({
    where: { shop },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { recipes: true } } },
  });

  return Response.json({ profiles });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveProfile") {
    const key = String(payload.key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!key) return Response.json({ ok: false, error: "Product type key is required." }, { status: 400 });

    const minQuantity = positiveInt(payload.minQuantity, 1);
    const defaultQuantity = Math.max(minQuantity, positiveInt(payload.defaultQuantity, minQuantity));
    const tierBreakpoints = normalizeBreakpoints(payload.tierBreakpoints, minQuantity).join(", ");

    const data = {
      shop,
      key,
      name: payload.name || key,
      productionMode: payload.productionMode || "in_house",
      minQuantity,
      defaultQuantity,
      tierBreakpoints,
      defaultMarginPct: numberOrZero(payload.defaultMarginPct || 40),
      pricingMethod: payload.pricingMethod || "auto_margin",
      defaultTags: payload.defaultTags || null,
      notes: payload.notes || null,
      active: true,
    };

    if (payload.id) {
      await db.productTypeProfile.updateMany({ where: { id: payload.id, shop }, data });
    } else {
      await db.productTypeProfile.upsert({
        where: { shop_key: { shop, key } },
        update: data,
        create: data,
      });
    }

    return Response.json({ ok: true });
  }

  if (payload.intent === "archiveProfile") {
    await db.productTypeProfile.updateMany({ where: { id: payload.id, shop }, data: { active: false } });
    return Response.json({ ok: true });
  }

  if (payload.intent === "restoreProfile") {
    await db.productTypeProfile.updateMany({ where: { id: payload.id, shop }, data: { active: true } });
    return Response.json({ ok: true });
  }

  if (payload.intent === "deleteProfile") {
    const usageCount = await db.productRecipe.count({ where: { productTypeProfileId: payload.id, shop } });
    if (usageCount > 0) {
      return Response.json({ ok: false, error: "This product type is used by recipes, so it can only be archived." }, { status: 400 });
    }
    await db.productTypeProfile.deleteMany({ where: { id: payload.id, shop, active: false } });
    return Response.json({ ok: true });
  }

  if (payload.intent === "resetDefaults") {
    await db.productTypeProfile.deleteMany({ where: { shop } });
    await db.productTypeProfile.createMany({ data: defaultRows(shop) });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
}

export default function ProductTypesPage() {
  const { profiles } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const [key, setKey] = useState("stock_bag");
  const [name, setName] = useState("Stock Bags");
  const [productionMode, setProductionMode] = useState("outsourced");
  const [minQuantity, setMinQuantity] = useState("100");
  const [defaultQuantity, setDefaultQuantity] = useState("100");
  const [tierBreakpoints, setTierBreakpoints] = useState("100, 250, 500, 1000, 2500, 5000, 10000");
  const [defaultMarginPct, setDefaultMarginPct] = useState("50");
  const [pricingMethod, setPricingMethod] = useState("auto_margin");
  const [defaultTags, setDefaultTags] = useState("gso:stock-bags, gso:outsourced, gso:wholesale");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (fetcher.data?.ok) {
      resetForm();
      navigate(".");
    }
  }, [fetcher.data, navigate]);

  const filteredProfiles = profiles.filter((profile: any) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "archived") return profile.active === false;
    return profile.active !== false;
  });

  function resetForm() {
    setEditingId(null);
    setKey("stock_bag");
    setName("Stock Bags");
    setProductionMode("outsourced");
    setMinQuantity("100");
    setDefaultQuantity("100");
    setTierBreakpoints("100, 250, 500, 1000, 2500, 5000, 10000");
    setDefaultMarginPct("50");
    setPricingMethod("auto_margin");
    setDefaultTags("gso:stock-bags, gso:outsourced, gso:wholesale");
    setNotes("");
  }

  function editProfile(profile: any) {
    setEditingId(profile.id);
    setKey(profile.key || "");
    setName(profile.name || "");
    setProductionMode(profile.productionMode || "in_house");
    setMinQuantity(String(profile.minQuantity || 1));
    setDefaultQuantity(String(profile.defaultQuantity || profile.minQuantity || 1));
    setTierBreakpoints(profile.tierBreakpoints || String(profile.minQuantity || 1));
    setDefaultMarginPct(String(profile.defaultMarginPct ?? 40));
    setPricingMethod(profile.pricingMethod || "auto_margin");
    setDefaultTags(profile.defaultTags || "");
    setNotes(profile.notes || "");
  }

  function saveProfile() {
    fetcher.submit(
      {
        intent: "saveProfile",
        id: editingId,
        key,
        name,
        productionMode,
        minQuantity,
        defaultQuantity,
        tierBreakpoints,
        defaultMarginPct,
        pricingMethod,
        defaultTags,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  function archiveProfile(id: string) {
    fetcher.submit({ intent: "archiveProfile", id }, { method: "post", encType: "application/json" });
  }

  function restoreProfile(id: string) {
    fetcher.submit({ intent: "restoreProfile", id }, { method: "post", encType: "application/json" });
  }

  function deleteProfile(id: string) {
    if (!window.confirm("Permanently delete this product type profile? This cannot be undone.")) return;
    fetcher.submit({ intent: "deleteProfile", id }, { method: "post", encType: "application/json" });
  }

  function resetDefaults() {
    if (!window.confirm("Reset product type profiles to GSO defaults? This replaces current profile rows.")) return;
    fetcher.submit({ intent: "resetDefaults" }, { method: "post", encType: "application/json" });
  }

  return (
    <Page title="Product Type Profiles" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Default rules by product type</Text>
                  <Text as="p" tone="subdued">
                    Set the defaults once for Labels, Stock Bags, Boxes, DTP, and sourced products. Recipes use these defaults automatically, but each recipe can still be adjusted.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button onClick={resetForm}>New profile</Button>
                  <Button tone="critical" variant="secondary" onClick={resetDefaults}>Reset GSO defaults</Button>
                </InlineStack>
              </InlineStack>

              {fetcher.data?.error ? <Text as="p" tone="critical">{fetcher.data.error}</Text> : null}

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Product Type Key" value={key} onChange={setKey} autoComplete="off" helpText="Example: stock_bag. Used behind the scenes." />
                </div>
                <div style={{ flex: 2 }}>
                  <TextField label="Display Name" value={name} onChange={setName} autoComplete="off" />
                </div>
                <div style={{ flex: 2 }}>
                  <Select label="Default Production Mode" options={productionModeOptions} value={productionMode} onChange={setProductionMode} />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Minimum Quantity" value={minQuantity} onChange={setMinQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Default Quote Quantity" value={defaultQuantity} onChange={setDefaultQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Default Margin %" value={defaultMarginPct} onChange={setDefaultMarginPct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 2 }}>
                  <Select label="Default Pricing Method" options={pricingMethodOptions} value={pricingMethod} onChange={setPricingMethod} />
                </div>
              </InlineStack>

              <TextField
                label="Tier Breakpoints"
                value={tierBreakpoints}
                onChange={setTierBreakpoints}
                autoComplete="off"
                helpText="Comma-separated. The lowest tier is the starting/max unit price tier. Larger tiers can be priced lower later."
              />

              <TextField
                label="Default Shopify Tags to Apply Later"
                value={defaultTags}
                onChange={setDefaultTags}
                autoComplete="off"
                helpText="Comma-separated. When Shopify product setup is connected, the app can apply these tags automatically."
              />

              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

              <InlineStack gap="200">
                <Button variant="primary" onClick={saveProfile} loading={fetcher.state !== "idle"}>
                  {editingId ? "Update Product Type" : "Save Product Type"}
                </Button>
                {editingId ? <Button onClick={resetForm}>Cancel Edit</Button> : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Profiles</Text>
                <div style={{ width: 200 }}>
                  <Select label="Status" labelHidden options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
                </div>
              </InlineStack>

              {filteredProfiles.length === 0 ? (
                <Text as="p" tone="subdued">No product type profiles match this filter.</Text>
              ) : (
                filteredProfiles.map((profile: any) => (
                  <Card key={profile.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between">
                        <BlockStack gap="100">
                          <InlineStack gap="200">
                            <Text as="h3" variant="headingSm">{profile.name}</Text>
                            <Badge>{profile.key}</Badge>
                            {profile.active === false ? <Badge tone="critical">Archived</Badge> : <Badge tone="success">Active</Badge>}
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            {productionModeOptions.find((option) => option.value === profile.productionMode)?.label || profile.productionMode} • Min {profile.minQuantity} • Default Qty {profile.defaultQuantity} • Margin {profile.defaultMarginPct}%
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          {profile.active !== false ? (
                            <>
                              <Button onClick={() => editProfile(profile)}>Edit</Button>
                              <Button tone="critical" variant="secondary" onClick={() => archiveProfile(profile.id)}>Archive</Button>
                            </>
                          ) : (
                            <>
                              <Button onClick={() => restoreProfile(profile.id)}>Restore</Button>
                              <Button tone="critical" variant="secondary" onClick={() => deleteProfile(profile.id)}>Delete Forever</Button>
                            </>
                          )}
                        </InlineStack>
                      </InlineStack>
                      <Divider />
                      <InlineStack gap="400">
                        <BlockStack gap="100">
                          <Text as="p" tone="subdued">Tiers</Text>
                          <Text as="p">{profile.tierBreakpoints}</Text>
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text as="p" tone="subdued">Default Tags</Text>
                          <Text as="p">{profile.defaultTags || "No default tags"}</Text>
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text as="p" tone="subdued">Recipes Using This</Text>
                          <Text as="p">{profile._count?.recipes || 0}</Text>
                        </BlockStack>
                      </InlineStack>
                      {profile.notes ? <Text as="p" tone="subdued">{profile.notes}</Text> : null}
                    </BlockStack>
                  </Card>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
