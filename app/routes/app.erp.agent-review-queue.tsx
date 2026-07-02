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

type QueueEvent = {
  id: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  message: string | null;
  afterSnapshot: unknown;
  metadata: unknown;
  createdAt: string;
};

type QueueItemDetail = QueueItem & {
  phone: string | null;
  preferredContactMethod: string | null;
  dimensionsOrSize: string | null;
  materialOrSubstrate: string | null;
  finish: string | null;
  deadline: string | null;
  shippingCityState: string | null;
  customerSafeSummary: string | null;
  customerSafeDraftReply: string | null;
  internalNotes: string | null;
  missingFields: unknown;
  escalationReasons: unknown;
  originalAgentDraftSnapshot: unknown;
  normalizedDraft: unknown;
  staffEditedDraft: unknown;
  events: QueueEvent[];
};

type LoaderData = {
  shop: string;
  items: QueueItem[];
  selectedItemId: string | null;
  selectedItem: QueueItemDetail | null;
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

function formatOptionalDate(value: string | null | undefined) {
  return value ? formatDate(value) : "Not set";
}

function statusTone(status: string) {
  if (status === "ready_to_quote") return "success";
  if (status === "rejected" || status === "archived") return "critical";
  if (status === "needs_cost_review" || status === "missing_customer_info") return "warning";
  return "attention";
}

function valueText(value: unknown) {
  return value ? String(value) : "Not set";
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

function ValueRow({ label, value }: { label: string; value: unknown }) {
  return (
    <InlineStack align="space-between" gap="300" wrap={false}>
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodySm">
        {valueText(value)}
      </Text>
    </InlineStack>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <BlockStack gap="100">
      <Text as="h3" variant="headingSm">
        {title}
      </Text>
      <pre
        style={{
          background: "#f6f6f7",
          border: "1px solid #dfe3e8",
          borderRadius: 6,
          margin: 0,
          maxHeight: 320,
          overflow: "auto",
          padding: 12,
          whiteSpace: "pre-wrap",
        }}
      >
        {value ? JSON.stringify(value, null, 2) : "Not set"}
      </pre>
    </BlockStack>
  );
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedItemId = url.searchParams.get("itemId");

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

  const selectedRow = selectedItemId
    ? await db.agentReviewQueueItem.findFirst({
        where: { id: selectedItemId, shop: session.shop },
        include: {
          events: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      })
    : null;

  const items = rows.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));
  const selectedItem = selectedRow
    ? {
        ...selectedRow,
        createdAt: selectedRow.createdAt.toISOString(),
        updatedAt: selectedRow.updatedAt.toISOString(),
        events: selectedRow.events.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })),
      }
    : null;

  return {
    shop: session.shop,
    items,
    selectedItemId,
    selectedItem,
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
                          <Button url={`/app/erp/agent-review-queue?itemId=${encodeURIComponent(item.id)}`}>View</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>

        {data.selectedItemId && !data.selectedItem ? (
          <Banner tone="warning">
            <BlockStack gap="200">
              <Text as="p">Queue item not found or not available for this shop.</Text>
              <Button url="/app/erp/agent-review-queue">Close detail</Button>
            </BlockStack>
          </Banner>
        ) : null}

        {data.selectedItem ? <QueueItemDetailPanel item={data.selectedItem} /> : null}
      </BlockStack>
    </Page>
  );
}

function QueueItemDetailPanel({ item }: { item: QueueItemDetail }) {
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Queue item detail
            </Text>
            <Text as="p" tone="subdued">
              Read-only detail view. Staff actions will be added later. This panel does not create a quote,
              send a customer message, create a Shopify order, or start production.
            </Text>
          </BlockStack>
          <Button url="/app/erp/agent-review-queue">Close detail</Button>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Status / safety
              </Text>
              <InlineStack gap="200">
                <Badge tone={statusTone(item.status)}>{label(item.status)}</Badge>
                <Badge tone={item.requiresStaffApproval ? "warning" : "critical"}>
                  {item.requiresStaffApproval ? "Staff approval" : "Review required"}
                </Badge>
                <Badge tone={item.canBecomeRealQuoteAutomatically ? "critical" : "success"}>
                  {item.canBecomeRealQuoteAutomatically ? "Auto quote risk" : "No auto quote"}
                </Badge>
              </InlineStack>
              <ValueRow label="Review level" value={label(item.reviewLevel)} />
              <ValueRow label="Source" value={label(item.source)} />
              <ValueRow label="Created by" value={item.createdBy} />
              <ValueRow label="Created" value={formatOptionalDate(item.createdAt)} />
              <ValueRow label="Updated" value={formatOptionalDate(item.updatedAt)} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Customer
              </Text>
              <ValueRow label="Customer name" value={item.customerName} />
              <ValueRow label="Company" value={item.company} />
              <ValueRow label="Email" value={item.email} />
              <ValueRow label="Phone" value={item.phone} />
              <ValueRow label="Preferred contact" value={item.preferredContactMethod} />
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Product request
            </Text>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
              <ValueRow label="Product family" value={item.productFamily} />
              <ValueRow label="Product type" value={item.productType} />
              <ValueRow label="Quantity" value={item.quantity} />
              <ValueRow label="Dimensions or size" value={item.dimensionsOrSize} />
              <ValueRow label="Material or substrate" value={item.materialOrSubstrate} />
              <ValueRow label="Finish" value={item.finish} />
              <ValueRow label="Deadline" value={item.deadline} />
              <ValueRow label="Shipping city/state" value={item.shippingCityState} />
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Staff review notes
            </Text>
            <ValueRow label="Recommended action" value={item.recommendedStaffAction} />
            <ValueRow label="Customer-safe summary" value={item.customerSafeSummary} />
            <ValueRow label="Customer-safe draft reply" value={item.customerSafeDraftReply} />
            <ValueRow label="Internal notes" value={item.internalNotes} />
            <JsonBlock title="Missing fields" value={item.missingFields} />
            <JsonBlock title="Escalation reasons" value={item.escalationReasons} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Snapshots
            </Text>
            <JsonBlock title="Original draft snapshot" value={item.originalAgentDraftSnapshot} />
            <JsonBlock title="Normalized draft" value={item.normalizedDraft} />
            {item.staffEditedDraft ? <JsonBlock title="Staff edited draft" value={item.staffEditedDraft} /> : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Audit events
            </Text>
            {item.events.length === 0 ? (
              <Text as="p" tone="subdued">
                No audit events found.
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead>
                    <tr>
                      {["Created", "Event", "Actor", "Message", "Metadata"].map((heading) => (
                        <th key={heading} style={{ borderBottom: "1px solid #dfe3e8", padding: 10, textAlign: "left" }}>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {heading}
                          </Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {item.events.map((event) => (
                      <tr key={event.id}>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {formatOptionalDate(event.createdAt)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {label(event.eventType)}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodySm">
                              {label(event.actorType)}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {event.actorName || event.actorEmail || "Not set"}
                            </Text>
                          </BlockStack>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <Text as="span" variant="bodySm">
                            {event.message || "Not set"}
                          </Text>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <pre style={{ margin: 0, maxWidth: 320, whiteSpace: "pre-wrap" }}>
                            {event.metadata ? JSON.stringify(event.metadata, null, 2) : "Not set"}
                          </pre>
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
    </Card>
  );
}
