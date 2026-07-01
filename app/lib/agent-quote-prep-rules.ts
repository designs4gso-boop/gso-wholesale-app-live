export const AGENT_QUOTE_PREP_RULES_VERSION = "2026-07-01-phase-5a";

export const AGENT_QUOTE_PREP_MODE = "draft_prep_only";

export const AGENT_QUOTE_PREP_GUARDRAILS = {
  canCreateRealQuotes: false,
  canApproveQuotes: false,
  canGiveFirmPricing: false,
  canCreateShopifyDraftOrders: false,
  canSendInvoices: false,
  canSendCustomerMessagesAutomatically: false,
  canStartProduction: false,
  canCreateProductionJobs: false,
  canApplyDiscounts: false,
  canEditCustomerRecords: false,
  canEditERPRecipes: false,
  canEditShopifyProducts: false,
};

export const AGENT_QUOTE_PREP_ALLOWED_ACTIONS = [
  "Read approved product family rules",
  "Read agent intake rules",
  "Collect customer quote requirements",
  "Prepare internal quote-prep draft summaries",
  "Identify missing intake information",
  "Suggest product family classification",
  "Suggest staff review level",
  "Draft customer-safe response text for staff review",
  "Mark escalation reasons",
  "Recommend next staff action",
];

export const AGENT_QUOTE_PREP_BLOCKED_ACTIONS = [
  "Creating or updating real Quote records",
  "Setting final unit price",
  "Setting final total price",
  "Approving quotes",
  "Sending quotes to customers",
  "Creating Shopify draft orders",
  "Sending invoices",
  "Creating deposit or balance orders",
  "Starting production",
  "Creating production jobs",
  "Applying discounts",
  "Promising turnaround",
  "Editing ProductRecipe, ProductCost, customer, order, or production data",
];

export const AGENT_QUOTE_PREP_STATUSES = [
  "intake_started",
  "missing_info",
  "ready_for_staff_review",
  "escalated",
  "rejected_for_agent_scope",
];

export const AGENT_QUOTE_PREP_REVIEW_LEVELS = [
  "basic_staff_review",
  "cost_review_required",
  "manual_pricing_required",
  "production_review_required",
  "compliance_or_legal_review_required",
  "out_of_scope",
];

export const AGENT_QUOTE_PREP_REQUIRED_FIELDS = [
  "customerName",
  "contactMethod",
  "productFamily",
  "quantity",
  "dimensionsOrSize",
  "materialOrSubstrate",
  "finish",
  "artworkStatus",
  "deadline",
  "shippingCityState",
];

export const AGENT_QUOTE_PREP_OPTIONAL_FIELDS = [
  "company",
  "email",
  "phone",
  "productType",
  "sides",
  "labelApplication",
  "lidLabel",
  "artworkLink",
  "referenceImages",
  "budgetRange",
  "notes",
];

export const AGENT_QUOTE_PREP_MISSING_INFO_RULES = [
  "Missing product family: ask what product they need",
  "Missing quantity: ask target quantity",
  "Missing dimensions/size: ask size or product dimensions",
  "Missing material/finish: ask material and finish preference",
  "Missing artwork status: ask if artwork is ready",
  "Missing deadline: ask target in-hand date",
  "Missing shipping location: ask shipping city/state",
];

export const AGENT_QUOTE_PREP_STAFF_REVIEW_TRIGGERS = [
  "Product family requires manual review",
  "Customer asks for final price",
  "Customer asks for rush turnaround",
  "Customer asks for discount",
  "Customer asks to approve/order/pay now",
  "Product is DTP, boxes, die-cut/shaped bags, sourced resale, or custom/other",
  "Quantity is below official MOQ",
  "Artwork is not ready",
  "Customer asks legal/compliance questions",
  "Specs are incomplete or conflicting",
  "Customer asks for production status or order change",
];

export const AGENT_QUOTE_PREP_CUSTOMER_SAFE_REPLY_RULES = {
  allowed: [
    "Confirm received details",
    'State typical MOQ using "usually starts at"',
    "State pricing depends on specs and staff review",
    "Ask for missing details",
    "Say the team can review and follow up",
  ],
  blocked: [
    "Your final price is...",
    "Your quote is approved",
    "I created your quote",
    "I created your order",
    "I sent your invoice",
    "Production has started",
    "Guaranteed turnaround",
    "Discount applied",
  ],
};

export const AGENT_QUOTE_PREP_DRAFT_EXAMPLE = {
  status: "missing_info",
  reviewLevel: "basic_staff_review",
  customerSummary: "Customer is requesting quote prep for a product family and quantity.",
  internalNotes: "Collect missing specs before staff pricing review. Do not provide firm pricing.",
  missingFields: ["dimensionsOrSize", "materialOrSubstrate", "artworkStatus"],
  escalationReasons: [],
  customerSafeDraftReply:
    "Thanks, I can collect the details for the team to review. Final pricing depends on specs, artwork, and staff review.",
  recommendedStaffAction: "Review intake details, confirm missing specs, then prepare a staff-approved quote.",
  allowedNextStep: "Prepare internal quote-prep notes for staff review",
  blockedNextSteps: [
    "Create real quote",
    "Set final pricing",
    "Create Shopify draft order",
    "Send invoice",
    "Start production",
  ],
};

export function allAgentQuotePrepRules() {
  return {
    version: AGENT_QUOTE_PREP_RULES_VERSION,
    mode: AGENT_QUOTE_PREP_MODE,
    guardrails: AGENT_QUOTE_PREP_GUARDRAILS,
    allowedActions: AGENT_QUOTE_PREP_ALLOWED_ACTIONS,
    blockedActions: AGENT_QUOTE_PREP_BLOCKED_ACTIONS,
    statuses: AGENT_QUOTE_PREP_STATUSES,
    reviewLevels: AGENT_QUOTE_PREP_REVIEW_LEVELS,
    requiredFields: AGENT_QUOTE_PREP_REQUIRED_FIELDS,
    optionalFields: AGENT_QUOTE_PREP_OPTIONAL_FIELDS,
    missingInfoRules: AGENT_QUOTE_PREP_MISSING_INFO_RULES,
    staffReviewTriggers: AGENT_QUOTE_PREP_STAFF_REVIEW_TRIGGERS,
    customerSafeReplyRules: AGENT_QUOTE_PREP_CUSTOMER_SAFE_REPLY_RULES,
    draftExample: AGENT_QUOTE_PREP_DRAFT_EXAMPLE,
  };
}

export function quotePrepStatusForMissingFields(missingFields: string[]): string {
  return missingFields.length ? "missing_info" : "ready_for_staff_review";
}
