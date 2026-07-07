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
import { Fragment, useState } from "react";
import { Form, Link, redirect, useLoaderData, useNavigate } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  QUOTE_READY_RECIPE_WHERE,
  QUOTE_RECIPE_PRICING_INCLUDE,
  blockingConversionIssues,
  priceRecipeAtQuantity,
} from "../lib/recipe-pricing.server";

type QueueItem = {
  id: string;
  source: string;
  status: string;
  reviewLevel: string;
  customerName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  productFamily: string | null;
  productType: string | null;
  quantity: string | null;
  dimensionsOrSize: string | null;
  materialOrSubstrate: string | null;
  finish: string | null;
  deadline: string | null;
  shippingCityState: string | null;
  missingFields: unknown;
  escalationReasons: unknown;
  customerSafeSummary: string | null;
  internalNotes: string | null;
  productRequest: unknown;
  recommendedStaffAction: string | null;
  requiresStaffApproval: boolean;
  canBecomeRealQuoteAutomatically: boolean;
  convertedQuoteId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type ConversionFailure = {
  reason: string;
  blockingIssues: string[];
  selectedRecipeId: string | null;
  recipeName: string | null;
  selectionSource: string | null;
  actor: string | null;
  at: string;
};

type RecipeOption = {
  id: string;
  name: string;
  sku: string | null;
  productFamily: string | null;
  productType: string | null;
  productionMode: string | null;
  targetMarginPct: number | null;
  minQuantity: number | null;
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
      conversionFailure: ConversionFailure | null;
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
  recipeOptions: RecipeOption[];
  suggestionByItemId: Record<string, string>;
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

function conversionFailureFromEvent(event: {
  eventType: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  message: string | null;
  metadata: unknown;
  createdAt: Date;
}): ConversionFailure {
  const metadata = jsonObject(event.metadata);
  const metadataReason = typeof metadata.reason === "string" ? metadata.reason.trim() : "";
  const messageReason = String(event.message || "")
    .replace(/^Draft quote conversion failed:\s*/i, "")
    .trim();
  const blockingIssues = jsonArray(metadata.blockingIssues).filter(
    (issue): issue is string => typeof issue === "string" && issue.trim().length > 0,
  );

  return {
    reason: metadataReason || messageReason || "Conversion failed.",
    blockingIssues,
    selectedRecipeId: typeof metadata.selectedRecipeId === "string" ? metadata.selectedRecipeId : null,
    recipeName: typeof metadata.recipeName === "string" ? metadata.recipeName : null,
    selectionSource: typeof metadata.selectionSource === "string" ? metadata.selectionSource : null,
    actor: event.actorName || event.actorEmail || event.actorType || null,
    at: event.createdAt.toISOString(),
  };
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
    ...QUOTE_READY_RECIPE_WHERE,
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
      include: QUOTE_RECIPE_PRICING_INCLUDE,
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
    include: QUOTE_RECIPE_PRICING_INCLUDE,
    take: 2,
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function quoteLineFromQueueItem(item: any, recipe: any, quantity: number) {
  const productRequest = jsonObject(item.productRequest);
  const finishText = textValue(productRequest.finish) || textValue(item.finish);
  const priced = priceRecipeAtQuantity(recipe, quantity, {
    selectedFinish: finishText.toLowerCase() || "base",
  });
  const blockingIssues = blockingConversionIssues(recipe, priced);

  if (blockingIssues.length) {
    return { ok: false as const, blockingIssues };
  }

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
    productionMode: recipe.productionMode,
    quantity: priced.quantity,
    unitCost: priced.unitCost,
    estimate: priced.estimate,
    warnings: priced.warnings,
    note: "Internal draft quote created for staff review. No Shopify order, invoice, customer message, or production job was created.",
  };
  const priceSnapshot = {
    source: "agent_review_queue_conversion",
    pricingMode: priced.fixedPrice != null ? "recipe_fixed_tier" : "recipe_margin_tier",
    tierLabel: priced.tierLabel,
    marginPct: priced.marginPct,
    fixedPrice: priced.fixedPrice,
    unitCost: priced.unitCost,
    unitPrice: priced.unitPrice,
    totalCost: priced.totalCost,
    totalPrice: priced.totalPrice,
    profit: priced.profit,
    marginActual: priced.marginActual,
    requiresStaffApproval: true,
  };

  return {
    ok: true as const,
    line: {
      productName,
      variant: finishText || null,
      sku: recipe.sku || null,
      quantity: priced.quantity,
      unitPrice: priced.unitPrice,
      unitCost: priced.unitCost,
      notes: [
        "Created from Agent Review Queue for internal staff quote drafting.",
        "Pricing seeded from the shared quote-ready recipe engine.",
        priced.warnings.length ? `Pricing warnings: ${priced.warnings.join(" ")}` : "",
        textValue(item.internalNotes) ? `Queue notes: ${textValue(item.internalNotes)}` : "",
      ].filter(Boolean).join("\n"),
      recipeId: recipe.id,
      recipeName: recipe.name,
      selectedFinish: finishText || null,
      pricingSource: priced.pricingSource,
      tierLabel: priced.tierLabel,
      minQuantity: recipe.minQuantity || null,
      marginPct: priced.marginPct,
      costSnapshot: JSON.stringify(costSnapshot),
      priceSnapshot: JSON.stringify(priceSnapshot),
    },
  };
}

async function writeConversionFailedEvent(
  item: any,
  shop: string,
  actorId: string | null,
  actorName: string | null,
  actorEmail: string | null,
  reason: string,
  extraMetadata: Record<string, unknown> = {},
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
          ...extraMetadata,
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

    const selectedRecipeId = String(formData.get("selectedRecipeId") || "").trim();
    const suggestedRecipeId = String(formData.get("suggestedRecipeId") || "").trim();
    const selectionSource =
      suggestedRecipeId && selectedRecipeId === suggestedRecipeId ? "staff_accepted_suggestion" : "staff_selected";

    if (!selectedRecipeId) {
      const reason = "no recipe was selected by staff";
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason, {
        selectionSource: "none",
      });
      return redirect("/app/erp/agent-review-queue?conversionError=no_recipe_selected");
    }

    const recipe = await db.productRecipe.findFirst({
      where: { id: selectedRecipeId, shop: session.shop, ...QUOTE_READY_RECIPE_WHERE },
      include: QUOTE_RECIPE_PRICING_INCLUDE,
    });

    if (!recipe) {
      const reason = "the selected recipe was not found or is no longer quote-ready";
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason, {
        selectedRecipeId,
        selectionSource,
      });
      return redirect("/app/erp/agent-review-queue?conversionError=no_recipe");
    }

    const quoteLineResult = quoteLineFromQueueItem(item, recipe, quantity);
    if (!quoteLineResult.ok) {
      const reason = `the matched recipe is not quote-ready: ${quoteLineResult.blockingIssues.join("; ")}`;
      await writeConversionFailedEvent(item, session.shop, actorId, actorName, actorEmail, reason, {
        blockingIssues: quoteLineResult.blockingIssues,
        recipeId: recipe.id,
        recipeName: recipe.name,
        selectionSource,
      });
      return redirect("/app/erp/agent-review-queue?conversionError=no_pricing");
    }
    const quoteLine = quoteLineResult.line;

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
            selectionSource,
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
  no_recipe_selected: "Choose a quote-ready recipe first.",
  no_recipe: "Draft quote was not created: the selected recipe was not found or is no longer quote-ready. Open Details on the row for the exact reasons.",
  no_pricing: "Draft quote was not created: the selected recipe is not quote-ready. Open Details on the row for the exact reasons.",
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
      phone: true,
      productFamily: true,
      productType: true,
      quantity: true,
      dimensionsOrSize: true,
      materialOrSubstrate: true,
      finish: true,
      deadline: true,
      shippingCityState: true,
      missingFields: true,
      escalationReasons: true,
      customerSafeSummary: true,
      internalNotes: true,
      productRequest: true,
      recommendedStaffAction: true,
      requiresStaffApproval: true,
      canBecomeRealQuoteAutomatically: true,
      convertedQuoteId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const recipeOptions = await db.productRecipe.findMany({
    where: { shop: session.shop, ...QUOTE_READY_RECIPE_WHERE },
    orderBy: { name: "asc" },
    take: 200,
    select: {
      id: true,
      name: true,
      sku: true,
      productFamily: true,
      productType: true,
      productionMode: true,
      targetMarginPct: true,
      minQuantity: true,
    },
  });

  const suggestionByItemId: Record<string, string> = {};
  for (const row of rows) {
    if (row.status !== "ready_to_quote" || row.convertedQuoteId) continue;
    const suggestion = await resolveQuoteReadyRecipe(session.shop, row);
    if (suggestion) suggestionByItemId[row.id] = suggestion.id;
  }

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
      const conversionFailure =
        event.eventType === "quote_draft_conversion_failed" ? conversionFailureFromEvent(event) : null;
      if (!existing) {
        auditByItemId[event.queueItemId] = {
          eventCount: 1,
          latestEventType: event.eventType,
          latestEventAt: event.createdAt.toISOString(),
          latestActor,
          latestNote: noteFromMetadata(event.metadata),
          conversionFailure,
        };
      } else {
        existing.eventCount += 1;
        if (!existing.latestNote) {
          existing.latestNote = noteFromMetadata(event.metadata);
        }
        if (!existing.conversionFailure && conversionFailure) {
          existing.conversionFailure = conversionFailure;
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
    recipeOptions,
    suggestionByItemId,
    summary: {
      total: items.length,
      needsStaffReview: items.filter((item) => ["new", "needs_staff_review"].includes(item.status)).length,
      readyToQuote: items.filter((item) => item.status === "ready_to_quote").length,
      needsCostReview: items.filter((item) => item.status === "needs_cost_review").length,
      rejectedOrArchived: items.filter((item) => ["rejected", "archived"].includes(item.status)).length,
    },
  } satisfies LoaderData;
}

function recipeOptionLabel(recipe: RecipeOption) {
  return [
    recipe.name,
    recipe.productFamily || "No family",
    recipe.sku || "no SKU",
    `${Math.round(Number(recipe.targetMarginPct) || 0)}% margin`,
  ].join(" — ");
}

function DetailField({ label: fieldLabel, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">
        {fieldLabel}
      </Text>
      <Text as="span" variant="bodySm">
        {value || "Not set"}
      </Text>
    </BlockStack>
  );
}

function ConversionFailureSummary({ failure }: { failure: ConversionFailure | null }) {
  if (!failure) return null;
  return (
    <Text as="span" variant="bodySm" tone="critical">
      Last failure: {truncatedText(failure.blockingIssues[0] || failure.reason)}
    </Text>
  );
}

function ConversionFailureDetails({ failure }: { failure: ConversionFailure | null }) {
  if (!failure) return null;
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm" fontWeight="semibold" tone="critical">
        Last conversion failure
      </Text>
      <Text as="span" variant="bodySm">
        {failure.reason}
      </Text>
      {failure.blockingIssues.length ? (
        <BlockStack gap="050">
          {failure.blockingIssues.map((issue) => (
            <Text as="span" variant="bodySm" key={issue}>
              • {issue}
            </Text>
          ))}
        </BlockStack>
      ) : null}
      <Text as="span" variant="bodySm" tone="subdued">
        {[
          failure.recipeName ? `Recipe: ${failure.recipeName}` : "",
          failure.selectedRecipeId ? `Recipe ID: ${failure.selectedRecipeId}` : "",
          failure.selectionSource ? `Selection: ${failure.selectionSource.replace(/_/g, " ")}` : "",
        ]
          .filter(Boolean)
          .join(" | ") || "No recipe was selected."}
      </Text>
      <Text as="span" variant="bodySm" tone="subdued">
        {failure.actor ? `By ${failure.actor} at ${formatDate(failure.at)}` : formatDate(failure.at)}
      </Text>
    </BlockStack>
  );
}

export default function AgentReviewQueuePage() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const navigate = useNavigate();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
                      <Fragment key={item.id}>
                      <tr>
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
                              {item.status !== "converted_by_staff" && !item.convertedQuoteId ? (
                                <ConversionFailureSummary failure={data.auditByItemId[item.id].conversionFailure} />
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
                            <Button size="slim" onClick={() => toggleExpanded(item.id)}>
                              {expandedIds.has(item.id) ? "Hide details" : "Details"}
                            </Button>
                            {item.convertedQuoteId ? (
                              <Text as="span" variant="bodySm" tone="subdued">
                                Draft quote created: {item.convertedQuoteId}
                              </Text>
                            ) : null}
                            {item.status === "ready_to_quote" && !item.convertedQuoteId ? (
                              data.recipeOptions.length === 0 ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  No quote-ready recipes exist yet. Finish Product Setup first.
                                </Text>
                              ) : (
                                <Form method="post">
                                  <input type="hidden" name="intent" value="create_quote_draft" />
                                  <input type="hidden" name="itemId" value={item.id} />
                                  <input type="hidden" name="suggestedRecipeId" value={data.suggestionByItemId[item.id] || ""} />
                                  <BlockStack gap="100">
                                    <select
                                      aria-label="Quote-ready recipe"
                                      name="selectedRecipeId"
                                      defaultValue={data.suggestionByItemId[item.id] || ""}
                                      required
                                      style={{
                                        border: "1px solid #c9cccf",
                                        borderRadius: 4,
                                        fontSize: 12,
                                        maxWidth: 260,
                                        padding: "5px 7px",
                                      }}
                                    >
                                      <option value="" disabled>
                                        Choose quote-ready recipe...
                                      </option>
                                      {data.recipeOptions.map((recipe) => (
                                        <option key={recipe.id} value={recipe.id}>
                                          {recipeOptionLabel(recipe)}
                                        </option>
                                      ))}
                                    </select>
                                    <Button size="slim" submit>
                                      Create draft quote
                                    </Button>
                                  </BlockStack>
                                </Form>
                              )
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
                      {expandedIds.has(item.id) ? (
                        <tr>
                          <td colSpan={10} style={{ background: "#fafbfb", borderBottom: "1px solid #f1f2f4", padding: 14 }}>
                            <BlockStack gap="300">
                              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                                <DetailField label="Customer" value={item.customerName || ""} />
                                <DetailField label="Company" value={item.company || ""} />
                                <DetailField label="Email" value={item.email || ""} />
                                <DetailField label="Phone" value={item.phone || ""} />
                                <DetailField label="Product family" value={item.productFamily || ""} />
                                <DetailField label="Product type" value={item.productType || ""} />
                                <DetailField label="Quantity" value={item.quantity || ""} />
                                <DetailField label="Dimensions / size" value={item.dimensionsOrSize || ""} />
                                <DetailField label="Material / substrate" value={item.materialOrSubstrate || ""} />
                                <DetailField label="Finish" value={item.finish || ""} />
                                <DetailField label="Deadline" value={item.deadline || ""} />
                                <DetailField label="Shipping city/state" value={item.shippingCityState || ""} />
                              </InlineGrid>
                              <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                                <DetailField label="Missing fields" value={jsonArray(item.missingFields).map(String).join(", ")} />
                                <DetailField label="Escalation reasons" value={jsonArray(item.escalationReasons).map(String).join(", ")} />
                                <DetailField label="Recommended staff action" value={item.recommendedStaffAction || ""} />
                                <DetailField label="Customer-safe summary" value={item.customerSafeSummary || ""} />
                                <DetailField label="Internal notes (staff only)" value={item.internalNotes || ""} />
                              </InlineGrid>
                              {item.status !== "converted_by_staff" && !item.convertedQuoteId ? (
                                <ConversionFailureDetails failure={data.auditByItemId[item.id]?.conversionFailure || null} />
                              ) : null}
                            </BlockStack>
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
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
