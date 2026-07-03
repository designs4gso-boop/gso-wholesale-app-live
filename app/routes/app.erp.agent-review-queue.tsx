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
import { Form, redirect, useLoaderData } from "react-router";
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
  auditByItemId: Record<
    string,
    {
      eventCount: number;
      latestEventType: string | null;
      latestEventAt: string | null;
      latestActor: string | null;
      latestNote: string | null;
    }
  >;
  summary: {
    total: number;
    needsStaffReview: number;
    readyToQuote: number;
    needsCostReview: number;
    rejectedOrArchived: number;
  };
};

const ACTIONS = {
  request_missing_info: {
    label: "Missing info",
    eventType: "missing_info_requested",
    message: "Staff marked queue item as missing customer information.",
    data: { status: "missing_customer_info" },
  },
  mark_needs_cost_review: {
    label: "Needs cost review",
    eventType: "marked_needs_cost_review",
    message: "Staff marked queue item as needing cost review.",
    data: { status: "needs_cost_review", reviewLevel: "cost_review_required" },
  },
  mark_ready_to_quote: {
    label: "Ready to quote",
    eventType: "marked_ready_to_quote",
    message: "Staff marked queue item as ready for staff quote prep.",
    data: { status: "ready_to_quote" },
  },
  reject: {
    label: "Reject",
    eventType: "rejected",
    message: "Staff rejected queue item.",
    data: { status: "rejected" },
  },
  archive: {
    label: "Archive",
    eventType: "archived",
    message: "Staff archived queue item.",
    data: { status: "archived" },
  },
} as const;

type StaffIntent = keyof typeof ACTIONS;

const TRANSITIONS: Record<string, StaffIntent[]> = {
  new: ["request_missing_info", "mark_needs_cost_review", "mark_ready_to_quote", "reject", "archive"],
  needs_staff_review: ["request_missing_info", "mark_needs_cost_review", "mark_ready_to_quote", "reject", "archive"],
  missing_customer_info: ["reject", "archive"],
  needs_cost_review: ["mark_ready_to_quote", "reject", "archive"],
  ready_to_quote: ["archive"],
  rejected: ["archive"],
  converted_by_staff: ["archive"],
  archived: [],
};

const NOTE_REQUIRED_ACTIONS = new Set<StaffIntent>(["request_missing_info", "reject"]);
const NOTE_MAX_LENGTH = 500;

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

function actorNameFromSession(session: any) {
  return session.name || session.firstName || session.onlineAccessInfo?.associated_user?.first_name || null;
}

function cappedNote(value: FormDataEntryValue | null) {
  return String(value || "").trim().slice(0, NOTE_MAX_LENGTH);
}

function truncatedText(value: string, maxLength = 110) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function noteFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || !("note" in metadata)) return null;
  const note = (metadata as { note?: unknown }).note;
  return typeof note === "string" && note.trim() ? truncatedText(note.trim()) : null;
}

function safeItemSnapshot(item: any) {
  return {
    id: item.id,
    source: item.source,
    status: item.status,
    reviewLevel: item.reviewLevel,
    customerName: item.customerName,
    company: item.company,
    email: item.email,
    productFamily: item.productFamily,
    productType: item.productType,
    quantity: item.quantity,
    recommendedStaffAction: item.recommendedStaffAction,
    rejectionReason: item.rejectionReason,
    requiresStaffApproval: item.requiresStaffApproval,
    canBecomeRealQuoteAutomatically: item.canBecomeRealQuoteAutomatically,
    createdBy: item.createdBy,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
  };
}

function allowedActionsForStatus(status: string): StaffIntent[] {
  return TRANSITIONS[status] || [];
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

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as StaffIntent;
  const itemId = String(formData.get("itemId") || "");
  const note = cappedNote(formData.get("note"));

  if (!Object.prototype.hasOwnProperty.call(ACTIONS, intent) || !itemId) {
    return redirect("/app/erp/agent-review-queue");
  }

  if (NOTE_REQUIRED_ACTIONS.has(intent) && !note) {
    return redirect("/app/erp/agent-review-queue");
  }

  const item = await db.agentReviewQueueItem.findFirst({
    where: { id: itemId, shop: session.shop },
  });

  if (!item) {
    return redirect("/app/erp/agent-review-queue");
  }

  if (!allowedActionsForStatus(item.status).includes(intent)) {
    return redirect("/app/erp/agent-review-queue");
  }

  const actionConfig = ACTIONS[intent];
  const now = new Date();
  const actorId = (session as any).userId ? String((session as any).userId) : null;
  const actorName = actorNameFromSession(session);
  const actorEmail = (session as any).email || null;
  const updateData: any = {
    ...actionConfig.data,
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };

  if (intent === "mark_ready_to_quote" && !item.reviewLevel) {
    updateData.reviewLevel = "basic_staff_review";
  }

  if (intent === "reject") {
    updateData.rejectedBy = actorEmail || actorName || "staff";
    updateData.rejectedAt = now;
    updateData.rejectionReason = note;
  }

  await db.$transaction(async (tx) => {
    const updated = await tx.agentReviewQueueItem.update({
      where: { id: item.id },
      data: updateData,
    });

    await tx.agentReviewQueueEvent.create({
      data: {
        shop: session.shop,
        queueItemId: item.id,
        eventType: actionConfig.eventType,
        actorType: "staff",
        actorId,
        actorName,
        actorEmail,
        message: note ? `${actionConfig.message} Note: ${note}` : actionConfig.message,
        beforeSnapshot: safeItemSnapshot(item),
        afterSnapshot: safeItemSnapshot(updated),
        metadata: { phase: "6N", action: intent, note: note || null },
      },
    });
  });

  return redirect("/app/erp/agent-review-queue");
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
  const itemIds = items.map((item) => item.id);
  const auditByItemId: LoaderData["auditByItemId"] = {};

  if (itemIds.length) {
    const events = await db.agentReviewQueueEvent.findMany({
      where: {
        shop: session.shop,
        queueItemId: { in: itemIds },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        queueItemId: true,
        eventType: true,
        actorType: true,
        actorName: true,
        actorEmail: true,
        message: true,
        metadata: true,
        createdAt: true,
      },
    });

    for (const event of events) {
      const existing = auditByItemId[event.queueItemId];
      const latestActor = event.actorName || event.actorEmail || event.actorType || null;
      if (!existing) {
        auditByItemId[event.queueItemId] = {
          eventCount: 1,
          latestEventType: event.eventType,
          latestEventAt: event.createdAt.toISOString(),
          latestActor,
          latestNote: noteFromMetadata(event.metadata),
        };
      } else {
        existing.eventCount += 1;
        if (!existing.latestNote) {
          existing.latestNote = noteFromMetadata(event.metadata);
        }
      }
    }
  }

  return {
    shop: session.shop,
    items,
    auditByItemId,
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
                Notes and status actions only update the review queue and audit log. They do not send customer
                messages or create quotes, Shopify orders, invoices, or production jobs.
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
                        "Audit",
                        "Safety",
                        "Actions",
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
                          {data.auditByItemId[item.id] ? (
                            <BlockStack gap="050">
                              <Text as="span" variant="bodySm">
                                Last: {label(data.auditByItemId[item.id].latestEventType)}
                              </Text>
                              {data.auditByItemId[item.id].latestActor ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  By: {data.auditByItemId[item.id].latestActor}
                                </Text>
                              ) : null}
                              {data.auditByItemId[item.id].latestNote ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Note: {data.auditByItemId[item.id].latestNote}
                                </Text>
                              ) : null}
                              <Text as="span" variant="bodySm" tone="subdued">
                                Events: {data.auditByItemId[item.id].eventCount}
                              </Text>
                            </BlockStack>
                          ) : (
                            <Text as="span" variant="bodySm" tone="subdued">
                              No events yet
                            </Text>
                          )}
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
                          <InlineStack gap="100">
                            {allowedActionsForStatus(item.status).map((intent) => (
                              <Form method="post" key={intent}>
                                <input type="hidden" name="intent" value={intent} />
                                <input type="hidden" name="itemId" value={item.id} />
                                {NOTE_REQUIRED_ACTIONS.has(intent) ? (
                                  <input
                                    aria-label={intent === "reject" ? "Reject reason" : "Missing information note"}
                                    maxLength={NOTE_MAX_LENGTH}
                                    name="note"
                                    placeholder={intent === "reject" ? "Reason required" : "What is missing?"}
                                    required
                                    style={{
                                      border: "1px solid #c9cccf",
                                      borderRadius: 4,
                                      fontSize: 12,
                                      marginBottom: 4,
                                      maxWidth: 150,
                                      padding: "5px 7px",
                                      width: "100%",
                                    }}
                                  />
                                ) : null}
                                <Button size="slim" submit>
                                  {ACTIONS[intent].label}
                                </Button>
                              </Form>
                            ))}
                            {allowedActionsForStatus(item.status).length === 0 ? (
                              <Text as="span" variant="bodySm" tone="subdued">
                                No actions
                              </Text>
                            ) : null}
                          </InlineStack>
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
