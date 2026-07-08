import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useNavigate } from "react-router";

import { authenticate } from "../shopify.server";

// Staff-facing SOP. Deliberately the safest page in the app: the loader only
// authenticates, there is no action export, no database access, and no
// Shopify API usage. Content must stay in sync with actual app behavior -
// update this page whenever a patch changes a described flow.
export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  return null;
}

type SopSection = {
  title: string;
  what: string;
  why: string;
  path: string;
  links: { label: string; url: string }[];
  callouts?: string[];
};

const SECTIONS: SopSection[] = [
  {
    title: "1. Daily flow at a glance",
    what: "The whole pipeline in one line: agent or staff intake -> Agent Review Queue -> pick a quote-ready recipe -> internal draft quote -> margin gate -> staff approval -> payment request -> customer pays -> production job -> proof -> reporting.",
    why: "Every screen in this app is one station on that line. If you know where you are on the line, you know which page to open.",
    path: "Start each day at the Setup Wizard for a health check, then work the Agent Review Queue and the Quotes / CRM board.",
    links: [
      { label: "Setup Wizard", url: "/app/erp/setup-wizard" },
      { label: "Agent Review Queue", url: "/app/erp/agent-review-queue" },
      { label: "Quotes / CRM", url: "/app/quotes" },
    ],
  },
  {
    title: "2. Setup Wizard: blockers vs warnings",
    what: "A read-only readiness dashboard. Launch blockers stop any launch; warnings are fine for internal beta but should be reviewed before full customer launch.",
    why: "It separates 'cannot launch' from 'do not forget'. The Quote Pipeline card also deep-checks a sample of 10 quote-ready recipes with the same engine the queue uses.",
    path: "Sidebar -> Setup Wizard. Fix anything in the Launch blockers list first; each blocker has a direct action button.",
    links: [{ label: "Setup Wizard", url: "/app/erp/setup-wizard" }],
  },
  {
    title: "3. Product Setup / recipe readiness",
    what: "Recipes are the cost and pricing source of truth. The Recipe readiness box shows exact blockers; the Fix readiness blockers card repairs them (width/height, minimum quantity, preferred machine, materials, tiers).",
    why: "A recipe that is not conversion-ready cannot become a draft quote from the Agent Review Queue. Every conversion failure reason points back to something fixable here.",
    path: "Sidebar -> Product Setup -> open a recipe -> read the readiness box -> use the fix card -> Test price at a quantity -> enable Use in Quotes / CRM once green.",
    links: [
      { label: "Product Setup", url: "/app/erp/product-setup" },
      { label: "Materials", url: "/app/erp/materials" },
      { label: "Machines", url: "/app/erp/machines" },
    ],
    callouts: [
      "Attach print substrates with the printed-material form and jars/bags/boxes with the blank-item form - they are separate on purpose.",
      "Use in Quotes / CRM will refuse to switch on while blockers exist; the save message lists the exact reasons.",
    ],
  },
  {
    title: "4. Creating a quote",
    what: "The Quotes / CRM builder prices lines from quote-ready recipes (or manual entry), tracks customer tier, and moves quotes through draft -> sent -> approved -> paid stages on the board.",
    why: "The quote is the contract-in-progress. Everything customer-facing (payment requests, invoices, the portal link) hangs off it.",
    path: "Sidebar -> Quotes / CRM -> build items (pick a recipe and Price from recipe, or type manually) -> Save.",
    links: [{ label: "Quotes / CRM", url: "/app/quotes" }],
    callouts: [
      "Save Quote never sends anything to the customer.",
      "Customer tier is display/policy metadata today - it does not change pricing.",
    ],
  },
  {
    title: "5. Low-margin / unknown-cost approval",
    what: "Any quote with an item below 40% actual margin, an unknown cost (unit cost 0), or an invalid price is blocked from sending, invoicing, and payment requests until a staff member approves it with a reason.",
    why: "Profit safety. The badge tells you which case you are in: Low margin, Unknown cost, or both.",
    path: "On the quote card: read the margin line -> type an approval reason -> Approve low margin. The approval records who, when, threshold, and a snapshot of the items.",
    links: [{ label: "Quotes / CRM", url: "/app/quotes" }],
    callouts: [
      "If item prices/quantities change after approval, the approval goes stale and the quote re-blocks until re-approved.",
      "Unknown-cost approvals are for things like resale items with offline cost tracking - say so in the reason.",
    ],
  },
  {
    title: "6. Payment request flow",
    what: "Approved quotes can create a full payment order OR a 50% deposit order (mutually exclusive tracks). Deposit-paid quotes can create the remaining balance order. Each order gets its own explicit Email invoice button.",
    why: "Creating an order does NOT email the customer. Sending the invoice email is a separate, deliberate staff action - so you can review everything in Shopify first.",
    path: "Move the quote to Approved -> Create Full Payment Order or Create 50% Deposit -> review -> Email invoice when ready. After the deposit is paid, Create Remaining Balance appears.",
    links: [{ label: "Quotes / CRM", url: "/app/quotes" }],
    callouts: [
      "Draft and sent quotes cannot create payment requests at all.",
      "Paying the deposit marks the quote deposit_paid - never fully paid.",
      "The webhook classifies deposit/balance/full payments automatically; balance amounts always come from the stored deposit record.",
    ],
  },
  {
    title: "7. Paid quote to production",
    what: "Production jobs can only be created from quotes with status paid (or already in production). The button does not appear before that, and the server enforces it even if it did.",
    why: "Owner rule: production starts after full payment. Deposit paid is not enough.",
    path: "Quote reaches paid -> Create Production Job on the card (or from the Production page) -> job gets a ticket, checklist, and proof sheet.",
    links: [{ label: "Production", url: "/app/erp/production" }],
    callouts: [
      "Move-to-Paid on the board is ONLY for real offline payments (check/wire already received). It is the sanctioned override - treat it like recording money.",
    ],
  },
  {
    title: "8. Agent Security / credential creation",
    what: "Create, revoke, and monitor external agent credentials. New credentials carry the intake:create scope and optional product-family restrictions.",
    why: "External agents can ONLY submit leads. They cannot create quotes, orders, invoices, messages, or production jobs - the credential system is how that stays true.",
    path: "Sidebar -> Agent Security -> Create agent credential -> copy the one-time token -> test with tools/test-agent-intake.ps1 -> expect 201 accepted then 200 duplicate.",
    links: [{ label: "Agent Security", url: "/app/erp/agent-security" }],
    callouts: [
      "The one-time token is shown exactly once and stored only as a hash. If it is lost, revoke and create a new credential.",
      "Revoking is permanent - there is no re-enable. Issue a fresh credential instead.",
      "Every failed intake attempt shows its exact error code and explanation in Recent Submissions.",
    ],
  },
  {
    title: "9. Agent Review Queue to draft quote",
    what: "Every agent lead (and staff-entered lead) lands here for review. Details expands the full request inline. Converting requires explicitly choosing a quote-ready recipe.",
    why: "This is the only bridge from external leads to real quotes, and it is staff-gated on purpose. The draft it creates is internal - nothing is sent to the customer.",
    path: "Sidebar -> Agent Review Queue -> Details on a row -> mark Ready to quote -> pick a recipe in the dropdown -> Create draft quote -> continue in Quotes / CRM.",
    links: [
      { label: "Agent Review Queue", url: "/app/erp/agent-review-queue" },
      { label: "Product Setup", url: "/app/erp/product-setup" },
    ],
    callouts: [
      "If conversion fails, the row's audit shows the exact blocking reasons - fix them in Product Setup, not by working around the gate.",
    ],
  },
  {
    title: "10. Portal privacy check",
    what: "Customers see their quote at /quote/<id>: items, prices, totals, and pay buttons only. No costs, margins, internal notes, approval data, or tier information.",
    why: "The portal payload is an explicit allowlist. Keeping it customer-safe is a launch requirement.",
    path: "From a quote card: Client Portal to preview. Sixty-second check: view the page source and search for unitCost and [GSO] - both must be absent.",
    links: [{ label: "Quotes / CRM", url: "/app/quotes" }],
    callouts: [
      "Copy Portal Link / Email Client Portal are customer-facing actions - use them deliberately.",
    ],
  },
  {
    title: "11. Reporting / margin review",
    what: "Reports mature as production jobs log actual costs and print logs import. Margin review compares expected vs actual.",
    why: "This is where quoted margins meet reality. It is a warning on the wizard until real jobs flow through - that is normal.",
    path: "Sidebar -> Reports Dashboard / Print Logs / Margin Review after jobs complete.",
    links: [
      { label: "Reports Dashboard", url: "/app/erp/reports-dashboard" },
      { label: "Print Logs", url: "/app/erp/print-logs" },
      { label: "Margin Review", url: "/app/erp/margin-review" },
    ],
  },
];

const DO_NOT = [
  "Do not share or re-display one-time agent tokens. Shown once, stored as a hash, gone.",
  "Do not use Move-to-Paid unless real money was actually received offline (check/wire). It is a payment record, not a shortcut.",
  "Do not hand-type approval markers into quote notes - use the Approve low margin button so the audit fields are written.",
  "Do not edit paid quotes - they are locked for a reason.",
  "Do not send portal links or invoice emails casually - both are customer-facing.",
  "Do not run seed-*/clear-* tools against production data.",
  "Developers: never run prisma migrate dev / db push / migrate reset against production. The rules live in docs/MIGRATIONS.md; Render owns migrate deploy.",
];

const FULL_LAUNCH = [
  "Shopify links / product mappings verified for everything customers can buy.",
  "Storefront configurator flow tested end to end on the live theme.",
  "Portal flow tested with a real customer link (customer-safe data only).",
  "Agent vendor onboarded if using agents: credential issued, signed intake proven live.",
  "Actual-cost reporting loop running: completed jobs log costs, margins get reviewed.",
];

function SectionCard({ section }: { section: SopSection }) {
  const navigate = useNavigate();

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {section.title}
        </Text>
        <Text as="p">{section.what}</Text>
        <Text as="p" tone="subdued">
          Why it matters: {section.why}
        </Text>
        <Text as="p" tone="subdued">
          How: {section.path}
        </Text>
        {section.callouts?.length ? (
          <BlockStack gap="100">
            {section.callouts.map((callout) => (
              <InlineStack key={callout} gap="150" blockAlign="start" wrap={false}>
                <Badge tone="attention">Note</Badge>
                <Text as="p" variant="bodySm">
                  {callout}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        ) : null}
        <InlineStack gap="200" wrap>
          {section.links.map((link, index) => (
            <Button key={link.url} variant={index === 0 ? "primary" : undefined} onClick={() => navigate(link.url)}>
              {link.label}
            </Button>
          ))}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function ErpWalkthrough() {
  const navigate = useNavigate();

  return (
    <Page
      title="ERP Walkthrough"
      subtitle="Staff SOP: how to run the shop through this app, start to finish"
      secondaryActions={[{ content: "Open Setup Wizard", onAction: () => navigate("/app/erp/setup-wizard") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Read-only guide
                </Text>
                <Badge tone="success">No write actions</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                This page changes nothing. It documents the internal-beta workflow the app enforces: quotes never
                send themselves, payment requests never email automatically, production waits for full payment, and
                external agents can only submit leads.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            {SECTIONS.map((section) => (
              <SectionCard key={section.title} section={section} />
            ))}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                12. What NOT to do
              </Text>
              {DO_NOT.map((item) => (
                <InlineStack key={item} gap="150" blockAlign="start" wrap={false}>
                  <Badge tone="critical">Never</Badge>
                  <Text as="p" variant="bodySm">
                    {item}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                13. Full customer launch additions
              </Text>
              <Text as="p" tone="subdued">
                Everything above covers internal beta (staff-only quoting and production). Before opening to
                customers, also complete:
              </Text>
              {FULL_LAUNCH.map((item) => (
                <Text as="p" key={item} variant="bodySm">
                  {item}
                </Text>
              ))}
              <InlineStack gap="200">
                <Button onClick={() => navigate("/app/erp/shopify-links")}>Shopify Links</Button>
                <Button onClick={() => navigate("/app/erp/configurator")}>Configurator</Button>
                <Button onClick={() => navigate("/app/erp/setup-wizard")}>Setup Wizard</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
