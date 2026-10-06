import { useEffect, useState } from "react";
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
import { useNavigate, useLoaderData, useLocation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Dashboard loader is READ-ONLY: Prisma count() calls only. Every status
// filter below mirrors the vocabulary the owning route actually uses, cited
// inline, so the tile count matches what staff see when they click through.
export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();
  // app.erp.rip-import-review.tsx defaults to status=unresolved (productionJobId null) + days=30.
  const ripCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    quotesToWork,
    quotesAwaitingPayment,
    jobsOpen,
    jobsProofSent,
    jobsHeld,
    reviewNeedsStaff,
    reviewReadyToQuote,
    opsIntentsAwaiting,
    ripUnresolved,
    purchaseOpen,
    purchaseLate,
    recipes,
    materials,
    machines,
    vendorProducts,
  ] = await Promise.all([
    // app.quotes.tsx board stages: draft -> sent -> approved -> deposit_paid -> paid -> production -> completed.
    db.quote.count({ where: { shop, status: { in: ["draft", "sent"] } } }),
    db.quote.count({ where: { shop, status: { in: ["approved", "deposit_paid"] } } }),
    // app.erp.production.tsx lists active jobs; terminal statuses per
    // app/lib/production-status-vocabulary.ts + app/lib/ops/production-planner.ts.
    db.productionJob.count({ where: { shop, active: true, status: { notIn: ["completed", "shipped", "cancelled"] } } }),
    db.productionJob.count({ where: { shop, active: true, status: "proof_sent" } }),
    db.productionJob.count({ where: { shop, active: true, status: { in: ["on_hold", "reprint_needed"] } } }),
    // app.erp.agent-review-queue.tsx: "needs_staff_review" filter = status in [new, needs_staff_review].
    db.agentReviewQueueItem.count({ where: { shop, status: { in: ["new", "needs_staff_review"] } } }),
    db.agentReviewQueueItem.count({ where: { shop, status: "ready_to_quote", convertedQuoteId: null } }),
    // app.erp.ops-hub.tsx "Needs a decision" = OpsActionIntent.status AWAITING_APPROVAL. The hub lists
    // intents without a shop filter (OpsActionIntent.shop is nullable), so this mirrors it exactly.
    db.opsActionIntent.count({ where: { status: "AWAITING_APPROVAL" } }),
    db.printLogEntry.count({ where: { shop, productionJobId: null, createdAt: { gte: ripCutoff } } }),
    // app/lib/purchase-request-groups.ts: CLOSED = [received, cancelled]; late = open + expectedArrivalDate past.
    db.purchaseRequest.count({ where: { shop, status: { notIn: ["received", "cancelled"] } } }),
    db.purchaseRequest.count({ where: { shop, status: { notIn: ["received", "cancelled"] }, expectedArrivalDate: { lt: now } } }),
    db.productRecipe.count({ where: { shop, active: true } }),
    db.material.count({ where: { shop, active: true } }),
    db.machine.count({ where: { shop, active: true } }),
    db.vendorProduct.count({ where: { shop, active: true } }),
  ]);

  return Response.json({
    attention: {
      quotesToWork,
      quotesAwaitingPayment,
      jobsOpen,
      jobsProofSent,
      jobsHeld,
      reviewNeedsStaff,
      reviewReadyToQuote,
      opsIntentsAwaiting,
      ripUnresolved,
      purchaseOpen,
      purchaseLate,
    },
    setup: { recipes, materials, machines, vendorProducts },
  });
}

type Tile = { label: string; value: number; href: string; helper: string };
type LinkGroup = { title: string; links: { label: string; href: string }[] };

// Everything removed from the sidebar on 2026-10-05 lives here (id="advanced").
const ADVANCED_GROUPS: LinkGroup[] = [
  {
    title: "Configurator",
    links: [
      { label: "Configurator", href: "/app/erp/configurator" },
      { label: "Configurator Sync", href: "/app/erp/configurator-sync" },
      { label: "Manual Mapping", href: "/app/erp/configurator-mapping" },
      { label: "Jar Mapping", href: "/app/erp/configurator-jar-mapping" },
      { label: "Shopify Links", href: "/app/erp/shopify-links" },
      { label: "Configurator Audit", href: "/app/erp/configurator-audit" },
    ],
  },
  {
    title: "Audit",
    links: [
      { label: "Cost Health", href: "/app/erp/cost-health" },
      { label: "Shopify Cost Audit", href: "/app/erp/shopify-cost-audit" },
      { label: "Actual Costs", href: "/app/erp/actual-costs" },
      { label: "Calibration", href: "/app/erp/calibration" },
      { label: "Pricing Health", href: "/app/erp/pricing-health" },
    ],
  },
  {
    title: "Owner",
    links: [
      { label: "Admin Settings", href: "/app/erp/admin-settings" },
      { label: "Agent Security", href: "/app/erp/agent-security" },
      { label: "Pricing Rules", href: "/app/erp/pricing-rules" },
    ],
  },
  {
    title: "Production extras",
    links: [
      { label: "Production Calendar", href: "/app/erp/production-calendar" },
      { label: "RIP Import Review", href: "/app/erp/rip-import-review" },
      { label: "Print Log Settings", href: "/app/erp/print-log-settings" },
      { label: "Purchase Export", href: "/app/erp/purchase-export" },
      { label: "Add Product wizard", href: "/app/erp/products/new" },
      { label: "New Internal Queue Item", href: "/app/erp/agent-review-queue/new" },
    ],
  },
];

function AttentionTile({ tile, onOpen }: { tile: Tile; onOpen: (href: string) => void }) {
  return (
    <div style={{ minWidth: 200, flex: 1 }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" tone="subdued">{tile.label}</Text>
          <Text as="p" variant="headingLg" tone={tile.value > 0 ? undefined : "subdued"}>{tile.value}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{tile.helper}</Text>
          <Button size="slim" onClick={() => onOpen(tile.href)}>Open</Button>
        </BlockStack>
      </Card>
    </div>
  );
}

function StatCard({ title, value, helper }: { title: string; value: number; helper: string }) {
  return (
    <div style={{ minWidth: 180, flex: 1 }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" tone="subdued">{title}</Text>
          <Text as="p" variant="headingLg">{value}</Text>
          <Text as="p" tone="subdued">{helper}</Text>
        </BlockStack>
      </Card>
    </div>
  );
}

export default function AppHome() {
  const data = useLoaderData<any>();
  const navigate = useNavigate();
  const location = useLocation();
  // <details> renders closed on the server; the sidebar "Admin · Advanced Tools"
  // link targets /app#advanced, so open + scroll when that hash is present.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (location.hash === "#advanced") {
      setAdvancedOpen(true);
      document.getElementById("advanced")?.scrollIntoView({ block: "start" });
    }
  }, [location.hash]);

  const a = data.attention;
  const tiles: Tile[] = [
    { label: "Quotes to work", value: a.quotesToWork, href: "/app/quotes", helper: "Draft or sent, not yet approved" },
    { label: "Quotes awaiting payment", value: a.quotesAwaitingPayment, href: "/app/quotes", helper: "Approved or deposit paid" },
    { label: "Leads needing staff review", value: a.reviewNeedsStaff, href: "/app/erp/agent-review-queue?status=needs_staff_review", helper: "New or needs staff review" },
    { label: "Leads ready to quote", value: a.reviewReadyToQuote, href: "/app/erp/agent-review-queue?status=ready_to_quote", helper: "Pick a recipe, create draft quote" },
    { label: "Agent intents needing a decision", value: a.opsIntentsAwaiting, href: "/app/erp/ops-hub", helper: "Awaiting human approval" },
    { label: "Open production jobs", value: a.jobsOpen, href: "/app/erp/production", helper: "Not completed, shipped or cancelled" },
    { label: "Proofs out to customers", value: a.jobsProofSent, href: "/app/erp/production", helper: "Status: proof sent" },
    { label: "Jobs on hold / reprint", value: a.jobsHeld, href: "/app/erp/production", helper: "On hold or reprint needed" },
    { label: "RIP rows not attached to a job", value: a.ripUnresolved, href: "/app/erp/rip-import-review", helper: "Unresolved, last 30 days" },
    { label: "Open purchase requests", value: a.purchaseOpen, href: "/app/erp/purchase-requests", helper: "Not received or cancelled" },
    { label: "Late purchase requests", value: a.purchaseLate, href: "/app/erp/purchase-requests", helper: "Open, expected arrival passed" },
  ];
  const totalAttention = tiles.reduce((sum, tile) => sum + tile.value, 0);

  return (
    <Page
      title="GSO ERP Command Center"
      subtitle="Start with what needs attention, then follow the daily workflow. Owner and audit tools are collapsed at the bottom."
      primaryAction={{ content: "Open Quotes / CRM", onAction: () => navigate("/app/quotes") }}
      secondaryActions={[
        { content: "Production Board", onAction: () => navigate("/app/erp/production") },
        { content: "Setup Wizard", onAction: () => navigate("/app/erp/setup-wizard") },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Needs attention today</Text>
                  <Text as="p" tone="subdued">Live counts from the ERP database. Click Open to go to the page that handles each item.</Text>
                </BlockStack>
                <Badge tone={totalAttention > 0 ? "attention" : "success"}>{totalAttention > 0 ? `${totalAttention} items` : "All clear"}</Badge>
              </InlineStack>
              <InlineStack gap="300" wrap>
                {tiles.map((tile) => <AttentionTile key={tile.label} tile={tile} onOpen={navigate} />)}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Recommended daily workflow</Text>
                  <Text as="p" tone="subdued">Same order as the sidebar groups: check readiness, triage leads, quote, produce, review.</Text>
                </BlockStack>
                <Badge tone="success">Read-only guide</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" wrap>
                <Button onClick={() => navigate("/app/erp/setup-wizard")}>1. Help · Setup Wizard</Button>
                <Button onClick={() => navigate("/app/erp/agent-review-queue")}>2. Operations · Agent Review Queue</Button>
                <Button variant="primary" onClick={() => navigate("/app/quotes")}>3. Sales · Quotes / CRM</Button>
                <Button onClick={() => navigate("/app/erp/production")}>4. Production · Production Board</Button>
                <Button onClick={() => navigate("/app/erp/reports-dashboard")}>5. Reporting · Reports Dashboard</Button>
              </InlineStack>
              <Text as="p" tone="subdued">
                Setup · Product Setup is the front door for new products: it creates the recipe, vendor product, tiers, margins, and product-type defaults behind the scenes.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Setup data on file</Text>
            <InlineStack gap="300" wrap>
              <StatCard title="Active recipes" value={data.setup.recipes} helper="Products ready for costing" />
              <StatCard title="Active materials" value={data.setup.materials} helper="In-house consumables" />
              <StatCard title="Active machines" value={data.setup.machines} helper="Printers and equipment" />
              <StatCard title="Vendor products" value={data.setup.vendorProducts} helper="Outsourced cost records" />
            </InlineStack>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <details
              id="advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary style={{ cursor: "pointer", listStyle: "none" }}>
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Advanced & owner tools</Text>
                    <Text as="p" tone="subdued">Configurator, audits, owner settings, and production extras. These pages can change live pricing, mappings, or Shopify behavior.</Text>
                  </BlockStack>
                  <Badge>{advancedOpen ? "Hide" : "Show"}</Badge>
                </InlineStack>
              </summary>
              <div style={{ paddingTop: 16 }}>
                <BlockStack gap="400">
                  {ADVANCED_GROUPS.map((group) => (
                    <BlockStack key={group.title} gap="200">
                      <Text as="h3" variant="headingSm">{group.title}</Text>
                      <InlineStack gap="200" wrap>
                        {group.links.map((link) => (
                          <Button key={link.href} size="slim" onClick={() => navigate(link.href)}>{link.label}</Button>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  ))}
                </BlockStack>
              </div>
            </details>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
