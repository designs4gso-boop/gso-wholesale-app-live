import {
  Badge,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type Status = "Ready" | "Needs setup" | "Needs review" | "Needs first test order" | "Partial";

type Step = {
  name: string;
  status: Status;
  explanation: string;
  counts: string[];
  links: { label: string; url: string }[];
};

function statusTone(status: Status) {
  if (status === "Ready") return "success";
  if (status === "Partial") return "attention";
  return "warning";
}

function isReady(status: Status) {
  return status === "Ready";
}

function reportingStatus(priceApprovalRecords: number, jobsWithActualCosts: number, productionJobs: number): Status {
  if (jobsWithActualCosts > 0) return "Ready";
  if (priceApprovalRecords > 0 || productionJobs > 0) return "Partial";
  return "Needs review";
}

function reportingExplanation(priceApprovalRecords: number, jobsWithActualCosts: number) {
  if (priceApprovalRecords > 0 && jobsWithActualCosts === 0) {
    return "Margin review records exist, but actual-cost reporting needs completed jobs with logged actual costs.";
  }

  return "Reports become more useful once jobs have actual costs or margin review records.";
}

function suggestedNextAction(nextStep: Step | null) {
  if (!nextStep) return "All core setup sections look ready for final launch review.";
  if (nextStep.name === "Reporting & Margin Review" && nextStep.status === "Partial") {
    return "Storefront and production setup look ready. Next, log actual production costs or import print logs so reporting can validate real margins.";
  }
  return `Review ${nextStep.name}`;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const recentStart = new Date();
  recentStart.setDate(recentStart.getDate() - 30);

  const [
    adminSettings,
    materials,
    machines,
    vendors,
    productTypeProfiles,
    productRecipes,
    pricingRules,
    configuratorPricingRules,
    marginReviewSettings,
    mappedConfiguratorProducts,
    recipeVariantRules,
    activeConfiguratorProducts,
    configuratorOptions,
    jarConfiguratorProducts,
    jarProductTypeProfiles,
    productionJobs,
    productionJobItems,
    recentProductionJobs,
    priceApprovalRecords,
    jobsWithActualCosts,
  ] = await Promise.all([
    db.erpAdminSetting.count({ where: { shop } }),
    db.material.count({ where: { shop, active: true } }),
    db.machine.count({ where: { shop, active: true } }),
    db.vendor.count({ where: { shop, active: true } }),
    db.productTypeProfile.count({ where: { shop, active: true } }),
    db.productRecipe.count({ where: { shop, active: true } }),
    db.pricingRule.count({ where: { shop, active: true } }),
    db.configuratorPricingRule.count({ where: { shop, active: true } }),
    db.marginReviewSetting.count({ where: { shop, active: true } }),
    db.configuratorProduct.count({
      where: {
        shop,
        active: true,
        OR: [{ shopifyProductGid: { not: null } }, { shopifyHandle: { not: null } }],
      },
    }),
    db.recipeVariantRule.count({ where: { shop } }),
    db.configuratorProduct.count({ where: { shop, active: true } }),
    db.configuratorOption.count({ where: { shop, active: true } }),
    db.configuratorProduct.count({
      where: { shop, active: true, productType: { startsWith: "jar_" } },
    }),
    db.productTypeProfile.count({
      where: { shop, active: true, key: { startsWith: "jar_" } },
    }),
    db.productionJob.count({ where: { shop, active: true } }),
    db.productionJobItem.count({ where: { shop } }),
    db.productionJob.count({ where: { shop, active: true, createdAt: { gte: recentStart } } }),
    db.priceApprovalRecord.count({ where: { shop } }),
    db.productionJob.count({ where: { shop, active: true, actualTotalCost: { gt: 0 } } }),
  ]);

  const steps: Step[] = [
    {
      name: "Shop Defaults",
      status: adminSettings > 0 ? "Ready" : "Needs setup",
      explanation: "Shop-level ERP defaults are stored in Admin Settings.",
      counts: [`${adminSettings} setting(s)`],
      links: [{ label: "Admin Settings", url: "/app/erp/admin-settings" }],
    },
    {
      name: "Cost Foundation",
      status: materials > 0 && machines > 0 && vendors > 0 ? "Ready" : "Needs review",
      explanation: "Materials, machines, and vendors provide the base cost data for quoting and production.",
      counts: [`${materials} active material(s)`, `${machines} active machine(s)`, `${vendors} active vendor(s)`],
      links: [
        { label: "Materials", url: "/app/erp/materials" },
        { label: "Machines", url: "/app/erp/machines" },
        { label: "Vendors", url: "/app/erp/vendors" },
      ],
    },
    {
      name: "Product Setup",
      status: productTypeProfiles > 0 && productRecipes > 0 ? "Ready" : "Needs review",
      explanation: "Product profiles and recipes define what can be priced, quoted, and produced.",
      counts: [`${productTypeProfiles} active profile(s)`, `${productRecipes} active recipe(s)`],
      links: [
        { label: "Product Builder", url: "/app/erp/products/new" },
        { label: "Product Setup", url: "/app/erp/product-setup" },
      ],
    },
    {
      name: "Pricing Rules",
      status: pricingRules > 0 || configuratorPricingRules > 0 ? "Ready" : "Needs review",
      explanation: "Pricing can come from wholesale rules, configurator rules, and margin review assumptions.",
      counts: [
        `${pricingRules} pricing rule(s)`,
        `${configuratorPricingRules} configurator pricing rule(s)`,
        `${marginReviewSettings} margin review setting(s)`,
      ],
      links: [
        { label: "Pricing Rules", url: "/app/erp/pricing-rules" },
        { label: "Pricing Health", url: "/app/erp/pricing-health" },
        { label: "Margin Review", url: "/app/erp/margin-review" },
      ],
    },
    {
      name: "Shopify Links",
      status: mappedConfiguratorProducts > 0 || recipeVariantRules > 0 ? "Ready" : "Needs review",
      explanation: "Shopify mappings connect storefront products and variants to ERP records.",
      counts: [`${mappedConfiguratorProducts} mapped configurator product(s)`, `${recipeVariantRules} recipe variant rule(s)`],
      links: [{ label: "Shopify Links", url: "/app/erp/shopify-links" }],
    },
    {
      name: "Storefront Configurator",
      status:
        activeConfiguratorProducts > 0 && configuratorOptions > 0 && configuratorPricingRules > 0
          ? "Ready"
          : "Needs review",
      explanation: "Customer-facing configurator products need active products, options, and pricing rules.",
      counts: [
        `${activeConfiguratorProducts} active configurator product(s)`,
        `${configuratorOptions} configurator option(s)`,
        `${configuratorPricingRules} configurator pricing rule(s)`,
        `${jarConfiguratorProducts} jar configurator product(s)`,
        `${jarProductTypeProfiles} jar product profile(s)`,
      ],
      links: [
        { label: "Configurator", url: "/app/erp/configurator" },
        { label: "Jar Mapping", url: "/app/erp/configurator-jar-mapping" },
        { label: "Configurator Sync", url: "/app/erp/configurator-sync" },
        { label: "Configurator Audit", url: "/app/erp/configurator-audit" },
      ],
    },
    {
      name: "Production Workflow",
      status: productionJobs > 0 ? "Ready" : "Needs first test order",
      explanation: "Production readiness is based on whether paid orders or quotes have created jobs.",
      counts: [`${productionJobs} active production job(s)`, `${productionJobItems} production item(s)`, `${recentProductionJobs} job(s) in last 30 days`],
      links: [
        { label: "Production", url: "/app/erp/production" },
        { label: "Production Calendar", url: "/app/erp/production-calendar" },
      ],
    },
    {
      name: "Reporting & Margin Review",
      status: reportingStatus(priceApprovalRecords, jobsWithActualCosts, productionJobs),
      explanation: reportingExplanation(priceApprovalRecords, jobsWithActualCosts),
      counts: [`${priceApprovalRecords} price approval record(s)`, `${jobsWithActualCosts} job(s) with actual costs`],
      links: [
        { label: "Reports Dashboard", url: "/app/erp/reports-dashboard" },
        { label: "Pricing Health", url: "/app/erp/pricing-health" },
        { label: "Margin Review", url: "/app/erp/margin-review" },
        { label: "Print Logs", url: "/app/erp/print-logs" },
        { label: "RIP Imports", url: "/app/erp/rip-imports" },
      ],
    },
  ];

  const readySteps = steps.filter((step) => isReady(step.status)).length;
  const partialSteps = steps.filter((step) => step.status === "Partial").length;
  const progress = Math.round((readySteps / steps.length) * 100);
  const needsReviewSteps = steps.length - readySteps;
  const nextStep = steps.find((step) => !isReady(step.status)) || null;
  const nextAction = suggestedNextAction(nextStep);

  return Response.json({ shop, steps, readySteps, partialSteps, needsReviewSteps, progress, nextStep, nextAction });
}

function StepCard({ step }: { step: Step }) {
  const navigate = useNavigate();

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="h2" variant="headingMd">{step.name}</Text>
          <Badge tone={statusTone(step.status) as any}>{step.status}</Badge>
        </InlineStack>
        <Text as="p" tone="subdued">{step.explanation}</Text>
        <InlineStack gap="200" wrap>
          {step.counts.map((count) => (
            <Badge key={count}>{count}</Badge>
          ))}
        </InlineStack>
        <InlineStack gap="200" wrap>
          {step.links.map((link, index) => (
            <Button
              key={link.url}
              variant={index === 0 ? "primary" : undefined}
              onClick={() => navigate(link.url)}
            >
              {link.label}
            </Button>
          ))}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function SetupWizard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const launchStatus = data.needsReviewSteps === 0 ? "Ready" : "Needs review";

  return (
    <Page
      title="Setup Wizard"
      subtitle="System Readiness & Launch Checklist"
      primaryAction={{ content: "Go to next step", onAction: () => data.nextStep && navigate(data.nextStep.links[0].url) }}
      secondaryActions={[{ content: "Back to Dashboard", onAction: () => navigate("/app") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">System readiness for {data.shop}</Text>
                  <Text as="p" tone="subdued">
                    This page is read-only. It checks existing ERP setup records and links to the pages where staff can finish setup.
                  </Text>
                </BlockStack>
                <Badge tone={statusTone(launchStatus as Status) as any}>{launchStatus}</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="400" wrap>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Overall progress</Text>
                  <Text as="p" variant="heading2xl">{data.progress}%</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Ready sections</Text>
                  <Text as="p" variant="heading2xl">{data.readySteps}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Needs review</Text>
                  <Text as="p" variant="heading2xl">{data.needsReviewSteps}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Partial</Text>
                  <Text as="p" variant="heading2xl">{data.partialSteps}</Text>
                </BlockStack>
              </InlineStack>
              <div style={{ height: 10, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${data.progress}%`, background: "#008060" }} />
              </div>
              <Text as="p">
                Suggested next action: <strong>{data.nextAction}</strong>
              </Text>
              <Text as="p" tone="subdued">
                This wizard is read-only. It checks setup records and guides next steps; it does not change pricing, products, or production data.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="300">
            {data.steps.map((step) => (
              <StepCard key={step.name} step={step} />
            ))}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Launch Readiness</Text>
                <Badge tone={statusTone(launchStatus as Status) as any}>{launchStatus}</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                A section is marked Ready when the app can find existing setup records for that area. This checklist does not create records, sync Shopify data, seed defaults, or change live production data.
              </Text>
              <Text as="p">
                {data.needsReviewSteps === 0
                  ? "All core sections have setup records. Run a final storefront, checkout, paid-order webhook, production, proof, and reporting test before treating the system as launched."
                  : `${data.needsReviewSteps} section(s) still need review before calling the system launch-ready.`}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
