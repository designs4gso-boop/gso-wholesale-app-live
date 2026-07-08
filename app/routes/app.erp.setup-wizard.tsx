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
import {
  QUOTE_READY_RECIPE_WHERE,
  QUOTE_RECIPE_PRICING_INCLUDE,
  blockingConversionIssues,
  priceRecipeAtQuantity,
} from "../lib/recipe-pricing.server";

type Status = "Ready" | "Needs setup" | "Needs review" | "Needs first test order" | "Partial";

// Severity overlays status: blockers stop any launch, warnings are acceptable
// for internal beta but should be reviewed before full customer launch.
type Severity = "ready" | "warning" | "blocker";

type Step = {
  name: string;
  status: Status;
  severity: Severity;
  explanation: string;
  counts: string[];
  details?: string[];
  links: { label: string; url: string }[];
};

function severityTone(severity: Severity) {
  if (severity === "ready") return "success";
  if (severity === "warning") return "attention";
  return "critical";
}

function severityLabel(severity: Severity) {
  if (severity === "ready") return "Ready";
  if (severity === "warning") return "Warning";
  return "Launch blocker";
}

function statusTone(status: Status) {
  if (status === "Ready") return "success";
  if (status === "Partial") return "attention";
  return "warning";
}

function isReady(status: Status) {
  return status === "Ready";
}

function quotePipelineStatus(quoteReadyRecipes: number, totalQuotes: number, paidQuotes: number): Status {
  if (quoteReadyRecipes === 0) return "Needs setup";
  if (totalQuotes === 0) return "Partial";
  if (paidQuotes === 0) return "Needs review";
  return "Ready";
}

function agentPlatformStatus(activeCredentials: number, hasAcceptedIntake: boolean): Status {
  if (activeCredentials > 0 && hasAcceptedIntake) return "Ready";
  if (activeCredentials === 0 && !hasAcceptedIntake) return "Needs setup";
  return "Partial";
}

function agentPlatformExplanation(activeCredentials: number, lastAcceptedAt: Date | null) {
  if (activeCredentials > 0 && lastAcceptedAt) {
    return `External signed intake is proven. Last accepted submission: ${lastAcceptedAt.toLocaleString()}. External agents remain intake-only.`;
  }
  if (activeCredentials === 0 && lastAcceptedAt) {
    return `Signed intake was tested successfully (last accepted: ${lastAcceptedAt.toLocaleString()}); no active credential is currently issued. Issue one from Agent Security when onboarding a vendor. External agents remain intake-only.`;
  }
  if (activeCredentials > 0) {
    return "Credential exists but no signed intake has been accepted yet. Run tools/test-agent-intake.ps1 to prove the flow end to end. External agents remain intake-only.";
  }
  return "Create a credential in Agent Security and run tools/test-agent-intake.ps1 to prove signed intake end to end. External agents remain intake-only.";
}

function reportingStatus(priceApprovalRecords: number, jobsWithActualCosts: number, productionJobs: number): Status {
  if (jobsWithActualCosts > 0) return "Ready";
  if (priceApprovalRecords > 0 || productionJobs > 0) return "Partial";
  return "Needs review";
}

function reportingExplanation(priceApprovalRecords: number, jobsWithActualCosts: number) {
  if (priceApprovalRecords > 0 && jobsWithActualCosts === 0) {
    return "Margin review records exist, but actual-cost reporting needs completed jobs with logged actual costs. Warning only - reporting matures naturally after the first completed jobs; not a launch blocker.";
  }

  return "Reports become more useful once jobs have actual costs or margin review records. Warning only - not a launch blocker.";
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
    quoteReadyRecipes,
    totalQuotes,
    depositPaidQuotes,
    paidQuotes,
    lowMarginApprovedQuotes,
    activeAgentCredentials,
    latestAcceptedIntake,
    queueReadyItems,
    queueConvertedItems,
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
    db.productRecipe.count({ where: { shop, ...QUOTE_READY_RECIPE_WHERE } }),
    db.quote.count({ where: { shop } }),
    db.quote.count({ where: { shop, status: "deposit_paid" } }),
    db.quote.count({ where: { shop, status: "paid" } }),
    db.quote.count({ where: { shop, lowMarginApprovedAt: { not: null } } }),
    db.agentApiCredential.count({ where: { shop, isActive: true } }),
    db.agentSubmissionLog.findFirst({
      where: { shop, status: "accepted" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.agentReviewQueueItem.count({ where: { shop, status: "ready_to_quote" } }),
    db.agentReviewQueueItem.count({ where: { shop, status: "converted_by_staff" } }),
  ]);

  // Bounded deep readiness sample: only the 10 most recently updated
  // quote-ready recipes, run through the same engine checks the Agent Review
  // Queue conversion uses. Per-recipe failures must never crash the wizard.
  const sampleRecipes = await db.productRecipe.findMany({
    where: { shop, ...QUOTE_READY_RECIPE_WHERE },
    orderBy: { updatedAt: "desc" },
    take: 10,
    include: QUOTE_RECIPE_PRICING_INCLUDE,
  });

  let sampledReadyCount = 0;
  const failingSamples: { name: string; firstIssue: string }[] = [];

  for (const recipe of sampleRecipes) {
    try {
      const priced = priceRecipeAtQuantity(recipe, Math.max(1, Number(recipe.minQuantity) || 1), {});
      const issues = blockingConversionIssues(recipe, priced);
      if (issues.length === 0) {
        sampledReadyCount += 1;
      } else if (failingSamples.length < 3) {
        failingSamples.push({ name: recipe.name, firstIssue: issues[0] });
      }
    } catch (_error) {
      if (failingSamples.length < 3) {
        failingSamples.push({ name: recipe.name, firstIssue: "readiness check failed unexpectedly" });
      }
    }
  }

  const sampledRecipeCount = sampleRecipes.length;
  const lastAcceptedAt = latestAcceptedIntake ? latestAcceptedIntake.createdAt : null;

  const steps: Step[] = [
    {
      name: "Shop Defaults",
      status: adminSettings > 0 ? "Ready" : "Needs setup",
      severity: adminSettings > 0 ? "ready" : "warning",
      explanation: "Shop-level ERP defaults are stored in Admin Settings.",
      counts: [`${adminSettings} setting(s)`],
      links: [{ label: "Admin Settings", url: "/app/erp/admin-settings" }],
    },
    {
      name: "Cost Foundation",
      status: materials > 0 && machines > 0 && vendors > 0 ? "Ready" : "Needs review",
      severity:
        materials === 0 || machines === 0 ? "blocker" : vendors === 0 ? "warning" : "ready",
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
      severity: productTypeProfiles > 0 && productRecipes > 0 ? "ready" : "blocker",
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
      severity: pricingRules > 0 || configuratorPricingRules > 0 ? "ready" : "warning",
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
      name: "Quote Pipeline",
      status: quotePipelineStatus(quoteReadyRecipes, totalQuotes, paidQuotes),
      severity:
        quoteReadyRecipes === 0 || (sampledRecipeCount > 0 && sampledReadyCount === 0)
          ? "blocker"
          : quotePipelineStatus(quoteReadyRecipes, totalQuotes, paidQuotes) === "Ready"
            ? "ready"
            : "warning",
      explanation:
        "Quote-ready recipes feed Quotes / CRM and Agent Review Queue conversion. Flag-ready is not full conversion readiness - open a recipe in Product Setup for its complete readiness checklist and test pricing.",
      counts: [
        `${quoteReadyRecipes} quote-ready recipe(s)`,
        `${totalQuotes} quote(s)`,
        `${depositPaidQuotes} deposit-paid quote(s)`,
        `${paidQuotes} paid quote(s)`,
        `Deep check: ${sampledReadyCount}/${sampledRecipeCount} sampled recipe(s) fully conversion-ready`,
      ],
      details: failingSamples.map((sample) => `${sample.name}: ${sample.firstIssue}`),
      links: [
        { label: "Product Setup", url: "/app/erp/product-setup" },
        { label: "Quotes / CRM", url: "/app/quotes" },
      ],
    },
    {
      name: "Quote Safety Gates",
      status: "Ready",
      severity: "ready",
      explanation:
        "Enforced in code: below-40% margin and unknown-cost quotes require staff approval with a reason; production requires fully paid quotes; deposit/balance/full payments are classified by the paid-order webhook; order creation and invoice emails are separate staff actions; the public quote portal exposes no costs, margins, or internal notes; external agents are intake-only.",
      counts: [
        `${lowMarginApprovedQuotes} low-margin approval(s) recorded`,
        `${depositPaidQuotes} quote(s) currently deposit-paid`,
      ],
      links: [{ label: "Quotes / CRM", url: "/app/quotes" }],
    },
    {
      name: "Shopify Links",
      status: mappedConfiguratorProducts > 0 || recipeVariantRules > 0 ? "Ready" : "Needs review",
      severity: mappedConfiguratorProducts > 0 || recipeVariantRules > 0 ? "ready" : "warning",
      explanation:
        "Shopify mappings connect storefront products and variants to ERP records. Required for full customer launch; not an internal-beta blocker.",
      counts: [`${mappedConfiguratorProducts} mapped configurator product(s)`, `${recipeVariantRules} recipe variant rule(s)`],
      links: [{ label: "Shopify Links", url: "/app/erp/shopify-links" }],
    },
    {
      name: "Storefront Configurator",
      status:
        activeConfiguratorProducts > 0 && configuratorOptions > 0 && configuratorPricingRules > 0
          ? "Ready"
          : "Needs review",
      severity:
        activeConfiguratorProducts > 0 && configuratorOptions > 0 && configuratorPricingRules > 0
          ? "ready"
          : "warning",
      explanation:
        "Customer-facing configurator products need active products, options, and pricing rules. Required for full customer launch; not an internal-beta blocker.",
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
      name: "Agent Platform",
      status: agentPlatformStatus(activeAgentCredentials, Boolean(latestAcceptedIntake)),
      // Agents are optional until vendor onboarding: never a launch blocker.
      severity:
        agentPlatformStatus(activeAgentCredentials, Boolean(latestAcceptedIntake)) === "Ready" ? "ready" : "warning",
      explanation: agentPlatformExplanation(activeAgentCredentials, lastAcceptedAt),
      counts: [
        `${activeAgentCredentials} active credential(s)`,
        `${queueReadyItems} queue item(s) ready to quote`,
        `${queueConvertedItems} queue item(s) converted`,
      ],
      links: [
        { label: "Agent Security", url: "/app/erp/agent-security" },
        { label: "Agent Review Queue", url: "/app/erp/agent-review-queue" },
      ],
    },
    {
      name: "Production Workflow",
      status: productionJobs > 0 ? "Ready" : "Needs first test order",
      severity: productionJobs > 0 ? "ready" : "warning",
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
      severity:
        reportingStatus(priceApprovalRecords, jobsWithActualCosts, productionJobs) === "Ready" ? "ready" : "warning",
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
  const blockerSteps = steps
    .filter((step) => step.severity === "blocker")
    .map((step) => ({ name: step.name, link: step.links[0] }));
  const warningSteps = steps.filter((step) => step.severity === "warning").map((step) => step.name);
  const nextStep =
    steps.find((step) => step.severity === "blocker") || steps.find((step) => !isReady(step.status)) || null;
  const nextAction = suggestedNextAction(nextStep);

  return Response.json({
    shop,
    steps,
    readySteps,
    partialSteps,
    needsReviewSteps,
    progress,
    nextStep,
    nextAction,
    blockerSteps,
    warningSteps,
  });
}

function StepCard({ step }: { step: Step }) {
  const navigate = useNavigate();

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="h2" variant="headingMd">{step.name}</Text>
          <InlineStack gap="150">
            <Badge tone={severityTone(step.severity) as any}>{severityLabel(step.severity)}</Badge>
            <Badge tone={statusTone(step.status) as any}>{step.status}</Badge>
          </InlineStack>
        </InlineStack>
        <Text as="p" tone="subdued">{step.explanation}</Text>
        {step.details?.length ? (
          <BlockStack gap="050">
            {step.details.map((detail) => (
              <Text as="p" key={detail} variant="bodySm" tone="critical">{detail}</Text>
            ))}
          </BlockStack>
        ) : null}
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
  // Response.json makes typeof-loader inference collapse to never; use the
  // codebase convention (loader data as any, real types on Step/StepCard).
  const data = useLoaderData<any>();
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
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Launch blockers</Text>
                  <Text as="p" variant="heading2xl">{data.blockerSteps.length}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Warnings</Text>
                  <Text as="p" variant="heading2xl">{data.warningSteps.length}</Text>
                </BlockStack>
              </InlineStack>
              <div style={{ height: 10, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${data.progress}%`, background: "#008060" }} />
              </div>
              {data.blockerSteps.length ? (
                <BlockStack gap="150">
                  <Text as="h3" variant="headingMd" tone="critical">
                    Launch blockers ({data.blockerSteps.length})
                  </Text>
                  {data.blockerSteps.map((blocker: any) => (
                    <InlineStack key={blocker.name} gap="200" blockAlign="center">
                      <Badge tone="critical">Blocker</Badge>
                      <Text as="span">{blocker.name}</Text>
                      <Button size="slim" onClick={() => navigate(blocker.link.url)}>
                        {blocker.link.label}
                      </Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              ) : (
                <Text as="p" tone="success">
                  No launch blockers - warnings only. Internal beta can proceed; review warnings before full
                  customer launch.
                </Text>
              )}
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
            {data.steps.map((step: Step) => (
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
              <BlockStack gap="150">
                <Text as="p" fontWeight="semibold">
                  Internal beta launch (staff-only quoting and production):
                </Text>
                {[
                  "1. Product Setup: launch recipes show green readiness (dimensions, materials, preferred machine).",
                  "2. Quote-ready recipes exist for the launch families (jars, stickers, banners, custom/other).",
                  "3. Quote flow tested: draft, approve, create payment request, and email invoice as separate staff steps.",
                  "4. Payment flow tested: deposit invoice paid -> deposit_paid, balance paid -> paid via the orders webhook.",
                  "5. Production gate tested: paid quote creates a job; draft/approved/deposit-paid quotes are blocked.",
                  "6. Margin gate tested: a below-40% or unknown-cost quote blocks until approved with a reason.",
                  "7. Production job from the paid quote reviewed: proof sheet, print logs, and reporting sections.",
                ].map((item) => (
                  <Text as="p" key={item}>
                    {item}
                  </Text>
                ))}
                <Text as="p" fontWeight="semibold">
                  Full customer launch adds:
                </Text>
                {[
                  "8. Shopify links / product mappings verified for everything customers can buy.",
                  "9. Storefront configurator flow tested end to end on the live theme.",
                  "10. Portal flow tested with a real customer link: customer-safe data only (no costs, margins, or notes).",
                  "11. Agent vendor onboarded if using agents: credential issued, signed intake live (201 + duplicate replay).",
                  "12. Actual-cost reporting loop running: completed jobs log actual costs and margins get reviewed.",
                ].map((item) => (
                  <Text as="p" key={item}>
                    {item}
                  </Text>
                ))}
              </BlockStack>
              <Text as="p">
                {data.needsReviewSteps === 0
                  ? "All sections have setup records. Work through the checklist above before treating the system as launched."
                  : `${data.needsReviewSteps} section(s) still need review before calling the system launch-ready.`}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
