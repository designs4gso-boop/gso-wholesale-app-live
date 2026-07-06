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
import { Form, Link, redirect, useLoaderData, useNavigate } from "react-router";
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
  convertedQuoteId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type LoaderData = {
  shop: string;
  items: QueueItem[];
  activeFilter: string;
  activeFilterLabel: string;
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
  conversionError: string | null;
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
const STATUS_FILTERS = [
  { label: "All", value: "all", href: "/app/erp/agent-review-queue" },
  { label: "Staff review", value: "needs_staff_review", href: "/app/erp/agent-review-queue?status=needs_staff_review" },
  { label: "Missing info", value: "missing_customer_info", href: "/app/erp/agent-review-queue?status=missing_customer_info" },
  { label: "Cost review", value: "needs_cost_review", href: "/app/erp/agent-review-queue?status=needs_cost_review" },
  { label: "Ready", value: "ready_to_quote", href: "/app/erp/agent-review-queue?status=ready_to_quote" },
  { label: "Rejected", value: "rejected", href: "/app/erp/agent-review-queue?status=rejected" },
  { label: "Archived", value: "archived", href: "/app/erp/agent-review-queue?status=archived" },
  { label: "Converted", value: "converted_by_staff", href: "/app/erp/agent-review-queue?status=converted_by_staff" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const QUOTE_RECIPE_INCLUDE = {
  tiers: { orderBy: { minQty: "asc" as const } },
  sourcedTiers: { orderBy: { minQty: "asc" as const } },
  vendorProduct: {
    include: {
      tiers: { orderBy: { minQty: "asc" as const } },
    },
  },
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

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parsePositiveQuantity(value: unknown) {
  const text = String(value || "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function bestRange<T extends { minQty?: number | null; maxQty?: number | null }>(ranges: T[] | undefined, quantity: number) {
  return (
    [...(ranges || [])]
      .filter((range) => Number(range.minQty || 0) <= quantity)
      .sort((left, right) => Number(right.minQty || 0) - Number(left.minQty || 0))[0] || null
  );
}

function compactTerms(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => textValue(value))
        .filter(Boolean),
    ),
  ).slice(0, 8);
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
    convertedQuoteId: item.convertedQuoteId,
    requiresStaffApproval: item.requiresStaffApproval,
    canBecomeRealQuoteAutomatically: item.canBecomeRealQuoteAutomatically,
    createdBy: item.createdBy,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
  };
}

function allowedActionsForStatus(status: string): StaffIntent[] {
  return TRANSITIONS[status] || [];
}

function statusFilterFromUrl(requestUrl: string): StatusFilter {
  const status = new URL(requestUrl).searchParams.get("status") || "all";
  return STATUS_FILTERS.some((filter) => filter.value === status) ? (status as StatusFilter) : "all";
}

function filterLabel(filterValue: string) {
  return STATUS_FILTERS.find((filter) => filter.value === filterValue)?.label || "All";
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

async function resolveQuoteReadyRecipe(shop: string, item: any) {
  const productRequest = jsonObject(item.productRequest);
  const terms = compactTerms([
    item.productType,
    item.productFamily,
    productRequest.productType,
    productRequest.productFamily,
    productRequest.productFamilyKey,
    productRequest.recipeName,
    productRequest.sku,
  ]);

  const whereBase = {
    shop,
    active: true,
    useInQuotes: true,
    costReviewNeeded: false,
  };

  for (const term of terms) {
    const exactMatches = await db.productRecipe.findMany({
      where: {
        ...whereBase,
        OR: [
          { id: term },
          { sku: { equals: term, mode: "insensitive" } },
          { productType: { equals: term, mode: "insensitive" } },
          { name: { equals: term, mode: "insensitive" } },
        ],
      },
      include: QUOTE_RECIPE_INCLUDE,
      take: 2,
    });
    if (exactMatches.length > 1) return null;
    if (exactMatches.length === 1) return exactMatches[0];
  }

  if (!terms.length) return null;

  const candidates = await db.productRecipe.findMany({
    where: {
      ...whereBase,
      OR: terms.flatMap((term) => [
        { sku: { contains: term, mode: "insensitive" } },
        { productType: { contains: term, mode: "insensitive" } },
        { productFamily: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ]),
    },
    include: QUOTE_RECIPE_INCLUDE,
    take: 2,
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function resolveRecipePricing(recipe: any, quantity: number) {
  const recipeTier = bestRange(recipe.tiers, quantity);
  const sourcedTier = bestRange(recipe.sourcedTiers, quantity);
  const vendorTier = bestRange(recipe.vendorProduct?.tiers, quantity);
  const unitPrice = positiveNumber(recipeTier?.fixedPrice) || positiveNumber(recipe.defaultSellPrice);
  const unitCost =
    positiveNumber(sourcedTier?.unitCost) ||
    positiveNumber(vendorTier?.unitCost) ||
    positiveNumber(recipe.vendorProduct?.defaultUnitCost);

  if (!unitPrice || !unitCost) return null;

  return {
    unitPrice,
    unitCost,
    recipeTier,
    sourcedTier,
    vendorTier,
  };
}

function quoteLineFromQueueItem(item: any, recipe: any, quantity: number) {
  const productRequest = jsonObject(item.productRequest);
  const pricing = resolveRecipePricing(recipe, quantity);
  if (!pricing) return null;

  const { recipeTier, sourcedTier, vendorTier, unitPrice, unitCost } = pricing;
  const productName =
    textValue(productRequest.productType) ||
    textValue(item.productType) ||
    textValue(recipe.name) ||
    textValue(item.productFamily) ||
    textValue(item.customerSafeSummary) ||
    "Custom item";
  const costSnapshot = {
    source: "agent_review_queue_conversion",
    queueItemId: item.id,
    recipeId: recipe.id,
    recipeName: recipe.name,
    quantity,
    unitCost,
    sourcedTier: sourcedTier ? `${sourcedTier.minQty}+` : null,
    vendorTier: vendorTier ? `${vendorTier.minQty}${vendorTier.maxQty ? `-${vendorTier.maxQty}` : "+"}` : null,
    note: "Internal draft quote created for staff review. No Shopify order, invoice, customer message, or production job was created.",
  };
  const priceSnapshot = {
    source: "agent_review_queue_conversion",
    pricingMode: recipeTier?.fixedPrice ? "recipe_fixed_tier" : "recipe_default_sell_price",
    unitPrice,
    unitCost,
    tierLabel: recipeTier ? `${recipeTier.minQty}${recipeTier.maxQty ? `-${recipeTier.maxQty}` : "+"}` : null,
    requiresStaffApproval: true,
  };

  return {
    productName,
    variant: textValue(productRequest.finish) || textValue(item.finish) || null,
    sku: recipe.sku || null,
    quantity,
    unitPrice,
    unitCost,
    notes: [
      "Created from Agent Review Queue for internal staff quote drafting.",
      "Pricing seeded from quote-ready recipe data.",
      textValue(item.internalNotes) ? `Queue notes: ${textValue(item.internalNotes)}` : "",
    ].filter(Boolean).join("\n"),
    recipeId: recipe.id,
    recipeName: recipe.name,
    selectedFinish: textValue(productRequest.finish) || textValue(item.finish) || null,
    pricingSource: "agent_review_queue_recipe",
    tierLabel: recipeTier ? `${recipeTier.minQty}${recipeTier.maxQty ? `-${recipeTier.maxQty}` : "+"}` : null,
    minQuantity: recipe.minQuantity || null,
    marginPct: recipeTier?.marginPct ?? recipe.targetMarginPct ?? null,
    costSnapshot: JSON.stringify(costSnapshot),
    priceSnapshot: JSON.stringify(priceSnapshot),
  };
}

async function writeConversionFailedEvent(
  item: any,
  shop: string,
  actorId: string | null,
  actorName: string | null,
  actorEmail: string | null,
  reason: string,
) {
  try {
    await db.agentReviewQueueEvent.create({
      data: {
        shop,
        queueItemId: item.id,
        eventType: "quote_draft_conversion_failed",
        actorType: "staff",
        actorId,
        actorName,
        actorEmail,
        message: `Draft quote conversion failed: ${reason}`,
        beforeSnapshot: safeItemSnapshot(item),
        metadata: {
          phase: "8B",
          action: "create_quote_draft",
          reason,
          itemId: item.id,
          itemStatus: item.status,
          actorId,
          actorName,
          actorEmail,
        },
      },
    });
  } catch (_err) {
    // Never let event write failure affect the response.
  }
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const itemId = String(formData.get("itemId") || "");
  const note = cappedNote(formData.get("note"));
  const actorId = (session as any).userId ? String((session as any).userId) : null;
  const actorName = actorNameFromSession(session);
  const actorEmail = (session as any).email || null;
  const actorLabel = actorEmail || actorName || actorId || "staff";

  if (intent === "create_quote_draft") {
    if (!itemId) return redirect("/app/erp/agent-review-queue");

    const item = await db.agentReviewQueueItem.findFirst({
      where: { id: itemId, shop: session.shop },
    });

    if (!item) return redirect("/app/erp/agent-review-queue");
    if (item.convertedQuoteId) return redirect("/app/erp/agent-review-queue");
    if (item.status !== "ready_to_quote") return redirect("/app/erp/agent-review-queue");
    if (item.requiresStaffApproval !== true) return redirect("/app/erp/agent-review-queue");
    if (item.canBecomeRealQuoteAutomatically !== false) return redirect("/app/erp/agent-review-queue");

    const productRequest = jsonObject(item.productRequest);
    const quantity = parsePositiveQuantity(item.quantity || productRequest.quantity);
    const hasCustomer = Boolean(item.customerName || item.company || item.email);
    const hasProductContext = Boolean(item.productFamily || item.productType || Object.keys(productRequest).length);
    const missingFields = jsonArray(item.missingFields).filter(Boolean);

    if (!quantity || !hasCustomer || !hasProductContext || missingFields.length) {
      const reason = !quantity
        ? "no valid quantity"
        : !hasCustomer
        ? "no customer name, company, or email"
        : !hasProductContext
        ? "no product context"
        : `missing required fields: ${missingFields.join(", ")}`;
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason);
      return redirect("/app/erp/agent-review-queue?conversionError=missing_fields");
    }

    const recipe = await resolveQuoteReadyRecipe(session.shop, item);
    if (!recipe) {
      const reason = "no unambiguous quote-ready recipe was found for this item";
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason);
      return redirect("/app/erp/agent-review-queue?conversionError=no_recipe");
    }

    const quoteLine = quoteLineFromQueueItem(item, recipe, quantity);
    if (!quoteLine) {
      const reason = "the matched recipe is missing positive sell price or unit cost";
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason);
      return redirect("/app/erp/agent-review-queue?conversionError=no_pricing");
    }

    const now = new Date();
    await db.$transaction(async (tx) => {
      const draftQuote = await tx.quote.create({
        data: {
          shop: session.shop,
          customerName: item.customerName || null,
          company: item.company || null,
          email: item.email || null,
          phone: item.phone || null,
          status: "draft",
          notes: [
            `Created from Agent Review Queue item ${item.id}.`,
            "Internal draft quote only. No Shopify order, invoice, customer message, or production job was created.",
            item.customerSafeSummary ? `Customer-safe summary: ${item.customerSafeSummary}` : "",
            item.internalNotes ? `Internal notes: ${item.internalNotes}` : "",
          ].filter(Boolean).join("\n"),
          items: {
            create: [quoteLine],
          },
        },
      });

      const updated = await tx.agentReviewQueueItem.updateMany({
        where: {
          id: item.id,
          shop: session.shop,
          status: "ready_to_quote",
          convertedQuoteId: null,
        },
        data: {
          status: "converted_by_staff",
          convertedQuoteId: draftQuote.id,
          convertedAt: now,
          convertedBy: actorLabel,
          requiresStaffApproval: true,
          canBecomeRealQuoteAutomatically: false,
        },
      });

      if (updated.count !== 1) {
        throw new Error("Queue item was already converted.");
      }

      await tx.agentReviewQueueEvent.create({
        data: {
          shop: session.shop,
          queueItemId: item.id,
          eventType: "converted_to_real_quote_by_staff",
          actorType: "staff",
          actorId,
          actorName,
          actorEmail,
          message: `Staff created internal draft quote ${draftQuote.id}.`,
          beforeSnapshot: safeItemSnapshot(item),
          afterSnapshot: {
            ...safeItemSnapshot(item),
            status: "converted_by_staff",
            convertedQuoteId: draftQuote.id,
            convertedAt: now.toISOString(),
            convertedBy: actorLabel,
          },
          metadata: {
            phase: "8B",
            action: "create_quote_draft",
            quoteId: draftQuote.id,
            priorStatus: item.status,
            newStatus: "converted_by_staff",
            actorId,
            actorName,
            actorEmail,
            recipeId: recipe.id,
          },
        },
      });

      return draftQuote;
    });

    return redirect("/app/erp/agent-review-queue?status=converted_by_staff");
  }

  if (!Object.prototype.hasOwnProperty.call(ACTIONS, intent) || !itemId) {
    return redirect("/app/erp/agent-review-queue");
  }

  const staffIntent = intent as StaffIntent;

  if (NOTE_REQUIRED_ACTIONS.has(staffIntent) && !note) {
    return redirect("/app/erp/agent-review-queue");
  }

  const item = await db.agentReviewQueueItem.findFirst({
    where: { id: itemId, shop: session.shop },
  });

  if (!item) {
    return redirect("/app/erp/agent-review-queue");
  }

  if (!allowedActionsForStatus(item.status).includes(staffIntent)) {
    return redirect("/app/erp/agent-review-queue");
  }

  const actionConfig = ACTIONS[staffIntent];
  const now = new Date();
  const updateData: any = {
    ...actionConfig.data,
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };

  if (staffIntent === "mark_ready_to_quote" && !item.reviewLevel) {
    updateData.reviewLevel = "basic_staff_review";
  }

  if (staffIntent === "reject") {
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
        metadata: { phase: "6N", action: staffIntent, note: note || null },
      },
    });
  });

  return redirect("/app/erp/agent-review-queue");
}

const CONVERSION_ERROR_MESSAGES: Record<string, string> = {
  missing_fields: "Draft quote was not created: item is missing required fields (quantity, customer, or product context).",
  no_recipe: "Draft quote was not created: no unambiguous quote-ready recipe was found.",
  no_pricing: "Draft quote was not created: the matched recipe is missing positive sell price or unit cost.",
};

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const activeFilter = statusFilterFromUrl(request.url);
  const conversionErrorCode = new URL(request.url).searchParams.get("conversionError") || "";
  const conversionError = CONVERSION_ERROR_MESSAGES[conversionErrorCode] || null;
  const where: any = { shop: session.shop };

  if (activeFilter === "needs_staff_review") {
    where.status = { in: ["new", "needs_staff_review"] };
  } else if (activeFilter !== "all") {
    where.status = activeFilter;
  }

  const rows = await db.agentReviewQueueItem.findMany({
    where,
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
      convertedQuoteId: true,
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
    activeFilter,
    activeFilterLabel: filterLabel(activeFilter),
    auditByItemId,
    conversionError,
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
  const navigate = useNavigate();

  return (
    <Page
      title="Agent Review Queue"
      subtitle={`Read-only staff queue for ${data.shop}`}
      primaryAction={{ content: "New internal queue item", onAction: () => navigate("/app/erp/agent-review-queue/new") }}
    >
      <BlockStack gap="400">
        {data.conversionError ? (
          <Banner tone="critical" title="Draft quote not created">
            <Text as="p">{data.conversionError}</Text>
          </Banner>
        ) : null}
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
              <Text as="p" tone="subdued">
                Showing: {data.activeFilterLabel}
              </Text>
            </BlockStack>

            <InlineStack gap="150">
              {STATUS_FILTERS.map((filter) => {
                const active = data.activeFilter === filter.value;
                return (
                  <Link
                    to={filter.href}
                    key={filter.value}
                    style={{
                      background: active ? "#303030" : "#ffffff",
                      border: "1px solid #c9cccf",
                      borderRadius: 6,
                      color: active ? "#ffffff" : "#202223",
                      fontSize: 13,
                      fontWeight: active ? 600 : 400,
                      lineHeight: "20px",
                      padding: "5px 10px",
                      textDecoration: "none",
                    }}
                  >
                    {filter.label}
                  </Link>
                );
              })}
            </InlineStack>

            {data.items.length === 0 ? (
              <EmptyState heading="No agent review queue items yet" image="">
                <BlockStack gap="300">
                  <Text as="p">Agent-prepared quote drafts will appear here after staff intake is enabled.</Text>
                  <Button onClick={() => navigate("/app/erp/agent-review-queue/new")}>New internal queue item</Button>
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
                            {item.convertedQuoteId ? (
                              <Text as="span" variant="bodySm" tone="subdued">
                                Draft quote created: {item.convertedQuoteId}
                              </Text>
                            ) : null}
                            {item.status === "ready_to_quote" && !item.convertedQuoteId ? (
                              <Form method="post">
                                <input type="hidden" name="intent" value="create_quote_draft" />
                                <input type="hidden" name="itemId" value={item.id} />
                                <Button size="slim" submit>
                                  Create draft quote
                                </Button>
                              </Form>
                            ) : null}
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
