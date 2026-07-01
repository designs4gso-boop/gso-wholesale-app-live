export const AGENT_QUOTE_PREP_DRAFT_VERSION = "2026-07-01-phase-5d";

export const AGENT_QUOTE_PREP_DRAFT_MODE = "internal_handoff_only";

export type AgentQuotePrepDraftStatus =
  | "intake_started"
  | "missing_info"
  | "ready_for_staff_review"
  | "escalated"
  | "rejected_for_agent_scope";

export type AgentQuotePrepReviewLevel =
  | "basic_staff_review"
  | "cost_review_required"
  | "manual_pricing_required"
  | "production_review_required"
  | "compliance_or_legal_review_required"
  | "out_of_scope";

export type AgentQuotePrepContact = {
  customerName: string;
  company?: string;
  email?: string;
  phone?: string;
  preferredContactMethod?: string;
};

export type AgentQuotePrepProductRequest = {
  productFamily: string;
  productType?: string;
  quantity?: string;
  dimensionsOrSize?: string;
  materialOrSubstrate?: string;
  finish?: string;
  sides?: string;
  labelApplication?: string;
  lidLabel?: string;
  artworkStatus?: string;
  artworkLink?: string;
  referenceImages?: string[];
  deadline?: string;
  shippingCityState?: string;
  budgetRange?: string;
  notes?: string;
};

export type AgentQuotePrepDraft = {
  version: string;
  mode: string;
  status: AgentQuotePrepDraftStatus;
  reviewLevel: AgentQuotePrepReviewLevel;
  contact: AgentQuotePrepContact;
  productRequest: AgentQuotePrepProductRequest;
  missingFields: string[];
  escalationReasons: string[];
  customerSafeSummary: string;
  customerSafeDraftReply: string;
  internalNotes: string;
  recommendedStaffAction: string;
  allowedNextStep: string;
  blockedNextSteps: string[];
  createdBy: "agent";
  requiresStaffApproval: true;
  canBecomeRealQuoteAutomatically: false;
};

export const AGENT_QUOTE_PREP_DRAFT_BLOCKED_NEXT_STEPS = [
  "Create real quote automatically",
  "Set final pricing",
  "Approve quote",
  "Send customer message",
  "Create Shopify draft order",
  "Send invoice",
  "Start production",
  "Create production job",
  "Apply discount",
  "Edit ERP or Shopify records",
];

export const AGENT_QUOTE_PREP_RECOMMENDED_STAFF_ACTIONS = [
  "Review intake details",
  "Request missing customer information",
  "Review product family and MOQ",
  "Review cost/pricing setup",
  "Prepare staff-approved quote",
  "Escalate to production review",
  "Escalate to compliance/legal review",
  "Reject as out of agent scope",
];

export function createBlankAgentQuotePrepDraft(): AgentQuotePrepDraft {
  return {
    version: AGENT_QUOTE_PREP_DRAFT_VERSION,
    mode: AGENT_QUOTE_PREP_DRAFT_MODE,
    status: "intake_started",
    reviewLevel: "basic_staff_review",
    contact: {
      customerName: "",
    },
    productRequest: {
      productFamily: "",
    },
    missingFields: [],
    escalationReasons: [],
    customerSafeSummary: "",
    customerSafeDraftReply: "",
    internalNotes: "",
    recommendedStaffAction: "Review intake details",
    allowedNextStep: "Prepare internal quote-prep notes for staff review",
    blockedNextSteps: AGENT_QUOTE_PREP_DRAFT_BLOCKED_NEXT_STEPS,
    createdBy: "agent",
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };
}

export function normalizeAgentQuotePrepDraft(input: Partial<AgentQuotePrepDraft>): AgentQuotePrepDraft {
  const blank = createBlankAgentQuotePrepDraft();
  const blockedNextSteps =
    input.blockedNextSteps && input.blockedNextSteps.length
      ? input.blockedNextSteps
      : AGENT_QUOTE_PREP_DRAFT_BLOCKED_NEXT_STEPS;

  return {
    ...blank,
    ...input,
    version: AGENT_QUOTE_PREP_DRAFT_VERSION,
    mode: AGENT_QUOTE_PREP_DRAFT_MODE,
    contact: {
      ...blank.contact,
      ...input.contact,
    },
    productRequest: {
      ...blank.productRequest,
      ...input.productRequest,
    },
    missingFields: input.missingFields || blank.missingFields,
    escalationReasons: input.escalationReasons || blank.escalationReasons,
    blockedNextSteps,
    createdBy: "agent",
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };
}

export function agentQuotePrepDraftIsReadyForStaff(draft: AgentQuotePrepDraft): boolean {
  return (
    draft.status === "ready_for_staff_review" &&
    draft.missingFields.length === 0 &&
    draft.requiresStaffApproval === true &&
    draft.canBecomeRealQuoteAutomatically === false
  );
}

export function allAgentQuotePrepDraftShape() {
  return {
    version: AGENT_QUOTE_PREP_DRAFT_VERSION,
    mode: AGENT_QUOTE_PREP_DRAFT_MODE,
    blockedNextSteps: AGENT_QUOTE_PREP_DRAFT_BLOCKED_NEXT_STEPS,
    recommendedStaffActions: AGENT_QUOTE_PREP_RECOMMENDED_STAFF_ACTIONS,
    blankDraftExample: createBlankAgentQuotePrepDraft(),
  };
}
