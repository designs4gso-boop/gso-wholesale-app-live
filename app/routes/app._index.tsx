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

} from "@shopify/polaris";
import { useNavigate, useLoaderData, useLocation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveStaffAccess } from "../lib/staff-roles.server";
import { ROLE_LABEL, SIMPLE_BOARD_HREF, navForRole } from "../lib/simple-nav";

// Dashboard loader is READ-ONLY: Prisma count() calls only. Every status
// filter below mirrors the vocabulary the owning route actually uses, cited
// inline, so the tile count matches what staff see when they click through.
export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const { session } = auth;
  const shop = session.shop;
  const now = new Date();
  // SIMPLE MODE (2026-11-14): the role only chooses which tiles / areas are SHOWN on Home.
  const staff = resolveStaffAccess(auth);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
    jobsReadyToPrint,
    jobsPrinting,
    jobsFinishing,
    jobsReadyForPickup,
    jobsOverdue,
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
    // Simple Mode shop-floor tiles: same status vocabulary as app/lib/simple-production.ts.
    db.productionJob.count({ where: { shop, active: true, status: "ready_to_print" } }),
    db.productionJob.count({ where: { shop, active: true, status: "printing" } }),
    db.productionJob.count({ where: { shop, active: true, status: { in: ["cutting", "laminating", "qc", "packing"] } } }),
    db.productionJob.count({ where: { shop, active: true, status: "ready_for_pickup" } }),
    db.productionJob.count({ where: { shop, active: true, dueDate: { lt: startOfToday }, status: { notIn: ["completed", "shipped", "picked_up", "cancelled"] } } }),
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
      jobsReadyToPrint,
      jobsPrinting,
      jobsFinishing,
      jobsReadyForPickup,
      jobsOverdue,
    },
    role: staff.role,
    viewFinancials: staff.can("viewFinancials"),
    roleReason: staff.role === "unassigned" ? staff.reason : null,
    setup: { recipes, materials, machines, vendorProducts },
  });
}

type Tile = { key: string; label: string; value: number; href: string; helper: string };

// SIMPLE MODE (2026-11-14): which attention tiles each role sees on Home (display only).
const ROLE_TILES: Record<string, readonly string[] | "all"> = {
  owner: "all",
  manager: "all",
  // Sales may not open Production pages (server rule), so no tile here may lead there.
  sales: ["quotesToWork", "quotesAwaitingPayment", "reviewNeedsStaff", "reviewReadyToQuote"],
  print_operator: ["jobsReadyToPrint", "jobsPrinting", "jobsHeld", "jobsOverdue"],
  bagger: ["jobsFinishing", "jobsReadyForPickup", "jobsHeld", "jobsOverdue"],
  unassigned: [],
};
const ROLE_HOME: Record<string, { purpose: string; action: string; href: string }> = {
  owner: { purpose: "What needs your attention across the shop today.", action: "Open Quotes", href: "/app/quotes" },
  manager: { purpose: "What needs attention across the shop today.", action: "Open Production Board", href: SIMPLE_BOARD_HREF },
  sales: { purpose: "Leads, quotes and customers waiting on you.", action: "Open Quotes", href: "/app/quotes" },
  print_operator: { purpose: "Jobs ready to print and anything that needs a reprint.", action: "Open Production Board", href: SIMPLE_BOARD_HREF },
  bagger: { purpose: "Jobs to finish, check, pack and hand over.", action: "Open Production Board", href: SIMPLE_BOARD_HREF },
  unassigned: { purpose: "Your account does not have an ERP role yet.", action: "Open the ERP walkthrough", href: "/app/erp/walkthrough" },
};
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
    } else if (location.hash.startsWith("#area-")) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
    }
  }, [location.hash]);

  const a = data.attention;
  const role: string = data.role || "owner";
  const isOwner = role === "owner";
  const home = ROLE_HOME[role] || ROLE_HOME.owner;
  const areas = navForRole(role, { viewFinancials: Boolean(data.viewFinancials) }).filter((section) => section.key !== "home");
  const allTiles: Tile[] = [
    { key: "quotesToWork", label: "Quotes to work", value: a.quotesToWork, href: "/app/quotes", helper: "Draft or sent, not yet approved" },
    { key: "quotesAwaitingPayment", label: "Quotes awaiting payment", value: a.quotesAwaitingPayment, href: "/app/quotes", helper: "Approved or deposit paid" },
    { key: "reviewNeedsStaff", label: "Leads to review", value: a.reviewNeedsStaff, href: "/app/erp/agent-review-queue?status=needs_staff_review", helper: "New or waiting on staff" },
    { key: "reviewReadyToQuote", label: "Leads ready to quote", value: a.reviewReadyToQuote, href: "/app/erp/agent-review-queue?status=ready_to_quote", helper: "Create a draft quote" },
    { key: "jobsOverdue", label: "Late jobs", value: a.jobsOverdue, href: SIMPLE_BOARD_HREF, helper: "Due date has passed" },
    { key: "jobsHeld", label: "Jobs on hold / reprint", value: a.jobsHeld, href: SIMPLE_BOARD_HREF, helper: "On hold or reprint needed" },
    { key: "jobsReadyToPrint", label: "Ready to print", value: a.jobsReadyToPrint, href: SIMPLE_BOARD_HREF, helper: "Waiting for a printer" },
    { key: "jobsPrinting", label: "Printing now", value: a.jobsPrinting, href: SIMPLE_BOARD_HREF, helper: "On a machine" },
    { key: "jobsFinishing", label: "Finishing / QC / packing", value: a.jobsFinishing, href: SIMPLE_BOARD_HREF, helper: "Cut, check and pack" },
    { key: "jobsReadyForPickup", label: "Ready for pickup", value: a.jobsReadyForPickup, href: SIMPLE_BOARD_HREF, helper: "Waiting for the customer" },
    { key: "jobsOpen", label: "Open production jobs", value: a.jobsOpen, href: SIMPLE_BOARD_HREF, helper: "Not completed, shipped or cancelled" },
    { key: "jobsProofSent", label: "Proofs out to customers", value: a.jobsProofSent, href: SIMPLE_BOARD_HREF, helper: "Waiting for customer approval" },
    { key: "purchaseOpen", label: "Open purchase requests", value: a.purchaseOpen, href: "/app/erp/purchase-requests", helper: "Not received or cancelled" },
    { key: "purchaseLate", label: "Late purchase requests", value: a.purchaseLate, href: "/app/erp/purchase-requests", helper: "Expected arrival has passed" },
    { key: "opsIntentsAwaiting", label: "Agent requests needing a decision", value: a.opsIntentsAwaiting, href: "/app/erp/ops-hub", helper: "Waiting for a person to approve" },
    { key: "ripUnresolved", label: "Print-log rows not matched to a job", value: a.ripUnresolved, href: "/app/erp/rip-import-review", helper: "Last 30 days" },
  ];
  const allowed = ROLE_TILES[role] ?? "all";
  // owners / managers keep the shop-wide tiles; the shop-floor stage tiles are for the roles that work them
  const SHOP_FLOOR_ONLY = ["jobsReadyToPrint", "jobsPrinting", "jobsFinishing", "jobsReadyForPickup"];
  const tiles = allowed === "all" ? allTiles.filter((tile) => !SHOP_FLOOR_ONLY.includes(tile.key)) : allTiles.filter((tile) => allowed.includes(tile.key));
  const totalAttention = tiles.reduce((sum, tile) => sum + tile.value, 0);

  return (
    <Page
      title="Home"
      subtitle={home.purpose}
      primaryAction={{ content: home.action, onAction: () => navigate(home.href) }}
      // the Cost Calculator stays one click from Home for the owner (the route itself is owner-only)
      secondaryActions={isOwner ? [{ content: "Cost Calculator", onAction: () => navigate("/app/erp/cost-calculator") }] : []}
    >
      <Layout>
        {role === "unassigned" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Ask the owner to give your account an ERP role</Text>
                <Text as="p" tone="subdued">Until a role is assigned you can read the walkthrough, but the work areas stay hidden.</Text>
                {data.roleReason ? <details><summary style={{ cursor: "pointer", fontSize: 12, color: "#6b7280" }}>Details</summary><Text as="p" tone="subdued" variant="bodySm">{data.roleReason}</Text></details> : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {tiles.length ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Needs attention today</Text>
                    <Text as="p" tone="subdued">Tap Open to go straight to the page that handles it.</Text>
                  </BlockStack>
                  <Badge tone={totalAttention > 0 ? "attention" : "success"}>{totalAttention > 0 ? `${totalAttention} items` : "All clear"}</Badge>
                </InlineStack>
                <InlineStack gap="300" wrap>
                  {tiles.map((tile) => <AttentionTile key={tile.key} tile={tile} onOpen={navigate} />)}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {areas.length ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Your areas</Text>
                  <Text as="p" tone="subdued">{`${ROLE_LABEL[role] || "Staff"} view — the same areas as the menu, with every page inside them.`}</Text>
                </BlockStack>
                {areas.map((section) => (
                  <div key={section.key} id={`area-${section.key}`}>
                    <BlockStack gap="200">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h3" variant="headingSm">{section.label}</Text>
                        <Text as="span" tone="subdued">{section.purpose}</Text>
                      </InlineStack>
                      <InlineStack gap="200" wrap>
                        {section.links.map((link, index) => (
                          <Button key={link.href + link.label} variant={index === 0 ? "primary" : undefined} onClick={() => navigate(link.href)}>{link.label}</Button>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  </div>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {isOwner ? (
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
        ) : null}

        {isOwner ? (
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
        ) : null}
      </Layout>
    </Page>
  );
}
