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
} from "@shopify/polaris";
import { useNavigate, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [quotes, recipes, materials, machines, vendorProducts, productTypes] = await Promise.all([
    db.quote.count({ where: { shop } }),
    db.productRecipe.count({ where: { shop, active: true } }),
    db.material.count({ where: { shop, active: true } }),
    db.machine.count({ where: { shop, active: true } }),
    db.vendorProduct.count({ where: { shop, active: true } }),
    db.productTypeProfile.count({ where: { shop, active: true } }),
  ]);

  return Response.json({ quotes, recipes, materials, machines, vendorProducts, productTypes });
}

function StatCard({ title, value, helper }: { title: string; value: number; helper: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued">{title}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        <Text as="p" tone="subdued">{helper}</Text>
      </BlockStack>
    </Card>
  );
}

export default function AppHome() {
  const data = useLoaderData<any>();
  const navigate = useNavigate();

  return (
    <Page
      title="GSO ERP Command Center"
      subtitle="Start with Product Setup. The advanced pages are here when you need to fine-tune materials, machines, vendors, or recipes."
      primaryAction={{ content: "Create product pricing", onAction: () => navigate("/app/erp/product-setup") }}
      secondaryActions={[{ content: "Create quote", onAction: () => navigate("/app/quotes") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Recommended daily workflow</Text>
                  <Text as="p" tone="subdued">
                    This keeps the app simple: create pricing-ready products first, then quote from clean recipe data.
                  </Text>
                </BlockStack>
                <Badge tone="success">Simplified flow</Badge>
              </InlineStack>

              <Divider />

              <InlineStack gap="300" wrap>
                <Button onClick={() => navigate("/app/erp/setup")}>0. Setup Center</Button>
                <Button variant="primary" onClick={() => navigate("/app/erp/product-setup")}>1. Product Setup</Button>
                <Button onClick={() => navigate("/app/quotes")}>2. Quotes / CRM</Button>
                <Button onClick={() => navigate("/app/erp/recipes")}>3. Recipes</Button>
              </InlineStack>

              <Text as="p">
                Product Setup is the front door. It creates or connects the recipe, vendor product, tiers, margins, and product-type defaults behind the scenes.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Admin setup pages</Text>
              <Button onClick={() => navigate("/app/erp/setup")}>Setup Center</Button>
              <Button onClick={() => navigate("/app/erp/product-types")}>Product Type Profiles</Button>
              <Button onClick={() => navigate("/app/erp/materials")}>Materials</Button>
              <Button onClick={() => navigate("/app/erp/machines")}>Machines</Button>
              <Button onClick={() => navigate("/app/erp/vendor-products")}>Vendor Products</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300" wrap>
            <div style={{ minWidth: 180, flex: 1 }}><StatCard title="Active recipes" value={data.recipes} helper="Products ready for costing" /></div>
            <div style={{ minWidth: 180, flex: 1 }}><StatCard title="Active materials" value={data.materials} helper="In-house consumables" /></div>
            <div style={{ minWidth: 180, flex: 1 }}><StatCard title="Active machines" value={data.machines} helper="Printers and equipment" /></div>
            <div style={{ minWidth: 180, flex: 1 }}><StatCard title="Vendor products" value={data.vendorProducts} helper="Outsourced cost records" /></div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Clean app structure</Text>
              <Text as="p"><strong>Product Setup</strong> is for employees and daily pricing work.</Text>
              <Text as="p"><strong>Materials, Machines, Vendor Products, and Product Types</strong> are admin/settings pages.</Text>
              <Text as="p"><strong>Recipes</strong> are the costing engine. Use them directly only when you need advanced edits.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
