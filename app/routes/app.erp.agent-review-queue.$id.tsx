import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type QueueEvent = {
  id: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  message: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  metadata: unknown;
  createdAt: string;
};

type QueueItem = {
  id: string;
  source: string;
  status: string;
  reviewLevel: string;
  customerName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  preferredContactMethod: string | null;
  productFamily: string | null;
  productType: string | null;
  quantity: string | null;
  dimensionsOrSize: string | null;
  materialOrSubstrate: string | null;
  finish: string | null;
  deadline: string | null;
  shippingCityState: string | null;
  recommendedStaffAction: string | null;
  customerSafeSummary: string | null;
  customerSafeDraftReply: string | null;
  internalNotes: string | null;
  missingFields: unknown;
  escalationReasons: unknown;
  originalAgentDraftSnapshot: unknown;
  normalizedDraft: unknown;
  staffEditedDraft: unknown;
  requiresStaffApproval: boolean;
  canBecomeRealQuoteAutomatically: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  events: QueueEvent[];
};

type LoaderData = {
  shop: string;
  item: QueueItem;
};

function label(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "Not set";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
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

function ValueRow({ label, value }: { label: string; value: unknown }) {
  return (
    <InlineStack align="space-between" gap="300" wrap={false}>
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodySm">
        {value ? String(value) : "Not set"}
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
          maxHeight: 360,
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

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  const { session } = await authenticate.admin(request);
  const id = params.id || "";

  const item = await db.agentReviewQueueItem.findFirst({
    where: { id, shop: session.shop },
    include: {
      events: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });

  if (!item) {
    throw new Response("Agent review queue item not found.", { status: 404 });
  }

  return {
    shop: session.shop,
    item: {
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      events: item.events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    },
  } satisfies LoaderData;
}

export default function AgentReviewQueueItemDetailPage() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const item = data.item;

  return (
    <Page
      title="Agent Review Queue Item"
      subtitle={`Read-only detail for ${data.shop}`}
      backAction={{ content: "Agent Review Queue", url: "/app/erp/agent-review-queue" }}
    >
      <BlockStack gap="400">
        <Banner tone="info">
          <Text as="p">
            Read-only detail view. Staff actions will be added later. This page does not create a quote,
            send a customer message, create a Shopify order, or start production.
          </Text>
        </Banner>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
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
              <ValueRow label="Created" value={formatDate(item.createdAt)} />
              <ValueRow label="Updated" value={formatDate(item.updatedAt)} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
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
            <Text as="h2" variant="headingMd">
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
            <Text as="h2" variant="headingMd">
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
            <Text as="h2" variant="headingMd">
              Snapshots
            </Text>
            <JsonBlock title="Original draft snapshot" value={item.originalAgentDraftSnapshot} />
            <JsonBlock title="Normalized draft" value={item.normalizedDraft} />
            <JsonBlock title="Staff edited draft" value={item.staffEditedDraft} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Audit events
            </Text>
            {item.events.length === 0 ? (
              <Text as="p" tone="subdued">
                No audit events found.
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
                  <thead>
                    <tr>
                      {["Created", "Event", "Actor", "Message", "Metadata", "After snapshot"].map((heading) => (
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
                            {formatDate(event.createdAt)}
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
                          <pre style={{ margin: 0, maxWidth: 260, whiteSpace: "pre-wrap" }}>
                            {event.metadata ? JSON.stringify(event.metadata, null, 2) : "Not set"}
                          </pre>
                        </td>
                        <td style={{ borderBottom: "1px solid #f1f2f4", padding: 10, verticalAlign: "top" }}>
                          <pre style={{ margin: 0, maxWidth: 320, whiteSpace: "pre-wrap" }}>
                            {event.afterSnapshot ? JSON.stringify(event.afterSnapshot, null, 2) : "Not set"}
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
    </Page>
  );
}
