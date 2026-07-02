import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type QueueItem = {
  id: string;
  source: string;
  status: string;
  reviewLevel: string;
  customerName: string | null;
  company: string | null;
  email: string | null;
  productFamily: string | null;
  productType: string | null;
  quantity: string | null;
  recommendedStaffAction: string | null;
  requiresStaffApproval: boolean;
  canBecomeRealQuoteAutomatically: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type LoaderData = {
  shop: string;
  items: QueueItem[];
  summary: {
    total: number;
    needsStaffReview: number;
    readyToQuote: number;
    needsCostReview: number;
    rejectedOrArchived: number;
  };
};

function label(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "Not set";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusTone(status: string) {
  if (status === "ready_to_quote") return "success";
  if (status === "rejected" || status === "archived") return "critical";
  if (status === "needs_cost_review" || status === "missing_customer_info") return "warning";
  return "attention";
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const rows = await db.agentReviewQueueItem.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      source: true,
      status: true,
      reviewLevel: true,
      customerName: true,
      company: true,
      email: true,
      productFamily: true,
      productType: true,
      quantity: true,
      recommendedStaffAction: true,
      requiresStaffApproval: true,
      canBecomeRealQuoteAutomatically: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const items = rows.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));

  return {
    shop: session.shop,
    items,
    summary: {
      total: items.length,
      needsStaffReview: items.filter((item) => ["new", "needs_staff_review"].includes(item.status)).length,
      readyToQuote: items.filter((item) => item.status === "ready_to_quote").length,
      needsCostReview: items.filter((item) => item.status === "needs_cost_review").length,
      rejectedOrArchived: items.filter((item) => ["rejected", "archived"].includes(item.status)).length,
    },
  } satisfies LoaderData;
}

export default function AgentReviewQueuePage() {
  const data = useLoaderData<typeof loader>() as LoaderData;

  return (
    <Page
      title="Agent Review Queue"
      subtitle={`Read-only staff queue for ${data.shop}`}
      primaryAction={{ content: "New internal queue item", url: "/app/erp/agent-review-queue/new" }}
    >
      <BlockStack gap="400">
        <Banner tone="info">
          <Text as="p">
            This queue is read-only in this phase. Staff review is required before any quote, order,
            customer communication, or production action.
          </Text>
        </Banner>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 5 }} gap="300">
          <SummaryCard label="Total items" value={data.summary.total} />
          <SummaryCard label="Needs staff review" value={data.summary.needsStaffReview} />
          <SummaryCard label="Ready to quote" value={data.summary.readyToQuote} />
          <SummaryCard label="Needs cost review" value={data.summary.needsCostReview} />
          <SummaryCard label="Rejected / archived" value={data.summary.rejectedOrArchived} />
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Queue items
              </Text>
              <Text as="p" tone="subdued">
                Future staff actions will be added later. This page only reads the latest 50 queue items.
              </Text>
            </BlockStack>

            {data.items.length === 0 ? (
              <EmptyState heading="No agent review queue items yet" image="">
                <BlockStack gap="300">
                  <Text as="p">Agent-prepared quote drafts will appear here after staff intake is enabled.</Text>
                  <Button url="/app/erp/agent-review-queue/new">New internal queue item</Button>
                </BlockStack>
              </EmptyState>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                  <thead>
                    <tr>
                      {[
                        "Created",
                        "Customer",
                        "Product",
                        "Qty",
                        "Status",
                        "Review level",
                        "Recommended staff action",
                        "Safety",
                        "Details",
                      ].map((heading) => (
                        <th key={heading} style={{ borderBottom: "1px solid #dfe3e8", padding: 10, textAlign: "left" }}>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {heading}
                          </Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.id}>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {formatDate(item.createdAt)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              {item.customerName || "Unknown customer"}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.company || item.email || "No company or email"}
                            </Text>
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              {item.productFamily || "Unknown family"}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.productType || "No product type"}
                            </Text>
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {item.quantity || "Not set"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Badge tone={statusTone(item.status)}>{label(item.status)}</Badge>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {label(item.reviewLevel)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {item.recommendedStaffAction || "Review intake details"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <InlineStack gap="100">
                            <Badge tone={item.requiresStaffApproval ? "warning" : "critical"}>
                              {item.requiresStaffApproval ? "Staff approval" : "Review required"}
                            </Badge>
                            <Badge tone={item.canBecomeRealQuoteAutomatically ? "critical" : "success"}>
                              {item.canBecomeRealQuoteAutomatically ? "Auto quote risk" : "No auto quote"}
                            </Badge>
                          </InlineStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Button url={`/app/erp/agent-review-queue/${item.id}`}>View</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
