export const AGENT_REVIEW_QUEUE_RULES_VERSION = "2026-07-01-phase-6a";

export const AGENT_REVIEW_QUEUE_MODE = "staff_review_required";

export type AgentReviewQueueStatus =
  | "new"
  | "needs_staff_review"
  | "missing_customer_info"
  | "needs_cost_review"
  | "ready_to_quote"
  | "rejected"
  | "converted_by_staff"
  | "archived";

export type AgentReviewQueueStaffAction =
  | "review"
  | "edit_draft"
  | "request_more_info"
  | "mark_needs_cost_review"
  | "mark_ready_to_quote"
  | "reject"
  | "archive"
  | "copy_to_quote_builder"
  | "convert_to_real_quote_manually";

export type AgentReviewQueueReviewLevel =
  | "basic_staff_review"
  | "cost_review_required"
  | "manual_pricing_required"
  | "production_review_required"
  | "compliance_or_legal_review_required"
  | "out_of_scope";

export const AGENT_REVIEW_QUEUE_GUARDRAILS = {
  agentsCanCreateQueueItemsWithoutStaffReview: false,
  agentsCanConvertToRealQuotes: false,
  agentsCanApproveQuotes: false,
  agentsCanSetFinalPricing: false,
  agentsCanCreateShopifyDraftOrders: false,
  agentsCanSendCustomerMessages: false,
  agentsCanCreateProductionJobs: false,
  agentsCanEditERPData: false,
  agentsCanEditShopifyData: false,
  staffReviewRequired: true,
  staffCanEditDraftBeforeQuote: true,
  staffCanRejectDraft: true,
  staffCanManuallyCreateQuoteAfterReview: true,
  auditTrailRequired: true,
};

export const AGENT_REVIEW_QUEUE_ALLOWED_STAFF_ACTIONS = [
  "Review agent-prepared draft",
  "Edit draft details before quoting",
  "Request missing customer information",
  "Mark draft as needing cost review",
  "Mark draft as ready to quote",
  "Reject draft as out of scope",
  "Archive draft",
  "Copy details into Quote Builder",
  "Manually create a real quote after review",
];

export const AGENT_REVIEW_QUEUE_BLOCKED_AGENT_ACTIONS = [
  "Convert draft to real quote",
  "Approve quote",
  "Set final price",
  "Send quote to customer",
  "Create Shopify draft order",
  "Send invoice",
  "Start production",
  "Create production job",
  "Edit ERP records",
  "Edit Shopify records",
  "Mark queue item as converted",
];

export const AGENT_REVIEW_QUEUE_REQUIRED_FIELDS = [
  "id",
  "source",
  "status",
  "reviewLevel",
  "contact",
  "productRequest",
  "missingFields",
  "escalationReasons",
  "customerSafeSummary",
  "customerSafeDraftReply",
  "internalNotes",
  "recommendedStaffAction",
  "createdBy",
  "requiresStaffApproval",
  "canBecomeRealQuoteAutomatically",
  "createdAt",
  "updatedAt",
];

export const AGENT_REVIEW_QUEUE_SOURCES = ["agent", "staff_manual", "website_intake", "imported"];

export const AGENT_REVIEW_QUEUE_AUDIT_EVENT_TYPES = [
  "queue_item_created",
  "staff_opened",
  "draft_edited",
  "missing_info_requested",
  "marked_needs_cost_review",
  "marked_ready_to_quote",
  "rejected",
  "archived",
  "copied_to_quote_builder",
  "converted_to_real_quote_by_staff",
  "note_added",
];

export const AGENT_REVIEW_QUEUE_CONVERSION_RULES = {
  realQuoteCreationRequiresStaffAction: true,
  mustHaveStatusReadyToQuote: true,
  mustHaveNoMissingFields: true,
  mustHaveStaffReviewer: true,
  mustKeepOriginalAgentDraftSnapshot: true,
  conversionMustWriteAuditEvent: true,
  agentAutoConversionAllowed: false,
};

export function allAgentReviewQueueRules() {
  return {
    version: AGENT_REVIEW_QUEUE_RULES_VERSION,
    mode: AGENT_REVIEW_QUEUE_MODE,
    guardrails: AGENT_REVIEW_QUEUE_GUARDRAILS,
    statuses: [
      "new",
      "needs_staff_review",
      "missing_customer_info",
      "needs_cost_review",
      "ready_to_quote",
      "rejected",
      "converted_by_staff",
      "archived",
    ],
    reviewLevels: [
      "basic_staff_review",
      "cost_review_required",
      "manual_pricing_required",
      "production_review_required",
      "compliance_or_legal_review_required",
      "out_of_scope",
    ],
    allowedStaffActions: AGENT_REVIEW_QUEUE_ALLOWED_STAFF_ACTIONS,
    blockedAgentActions: AGENT_REVIEW_QUEUE_BLOCKED_AGENT_ACTIONS,
    requiredFields: AGENT_REVIEW_QUEUE_REQUIRED_FIELDS,
    sources: AGENT_REVIEW_QUEUE_SOURCES,
    auditEventTypes: AGENT_REVIEW_QUEUE_AUDIT_EVENT_TYPES,
    conversionRules: AGENT_REVIEW_QUEUE_CONVERSION_RULES,
  };
}

export function agentReviewQueueCanConvertToQuote(input: {
  status: string;
  missingFields?: string[];
  staffReviewerId?: string | null;
}): boolean {
  return (
    input.status === "ready_to_quote" &&
    !input.missingFields?.length &&
    Boolean(input.staffReviewerId)
  );
}

export function agentReviewQueueNextAllowedStaffActions(status: string): AgentReviewQueueStaffAction[] {
  if (status === "new" || status === "needs_staff_review") {
    return [
      "review",
      "edit_draft",
      "request_more_info",
      "mark_needs_cost_review",
      "mark_ready_to_quote",
      "reject",
      "archive",
    ];
  }

  if (status === "missing_customer_info") {
    return ["edit_draft", "request_more_info", "reject", "archive"];
  }

  if (status === "needs_cost_review") {
    return ["edit_draft", "mark_ready_to_quote", "reject", "archive"];
  }

  if (status === "ready_to_quote") {
    return ["review", "copy_to_quote_builder", "convert_to_real_quote_manually", "reject", "archive"];
  }

  if (status === "rejected" || status === "converted_by_staff") {
    return ["archive"];
  }

  return [];
}
