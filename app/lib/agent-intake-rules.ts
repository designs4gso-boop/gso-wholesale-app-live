export const AGENT_INTAKE_RULES_VERSION = "2026-07-01-phase-4e";

export const AGENT_INTAKE_MODE = "read_only_draft_only";

export const AGENT_INTAKE_GUARDRAILS = {
  canSendCustomerMessagesAutomatically: false,
  canGiveFirmPricing: false,
  canApproveQuotes: false,
  canCreateShopifyProducts: false,
  canEditShopifyProducts: false,
  canCreateDraftOrders: false,
  canApplyDiscounts: false,
  canPromiseTurnaround: false,
  canStartProduction: false,
  canCreateProductionJobs: false,
  canEditERPData: false,
  canRunMarketingCampaignsAutomatically: false,
};

export const AGENT_ALLOWED_ACTIONS = [
  "Read approved product family MOQ/sales rules",
  "Explain general product availability and typical MOQs",
  "Ask customer intake questions",
  "Collect size, quantity, material, finish, artwork, deadline, and shipping details",
  "Draft customer-safe replies for staff review",
  "Prepare internal quote-prep notes for staff review",
  "Recommend staff review before final pricing, turnaround, or order approval",
  "Route unclear/custom requests to staff",
];

export const AGENT_BLOCKED_ACTIONS = [
  "Giving firm final pricing",
  "Approving quotes",
  "Creating or editing Shopify products",
  "Creating draft orders",
  "Sending invoices",
  "Applying discounts",
  "Promising production turnaround",
  "Starting production",
  "Creating or editing production jobs",
  "Sending customer messages without staff approval",
  "Editing ERP records",
  "Accessing costs, margins, vendor costs, customer records, orders, Shopify tokens, or production jobs",
  "Running marketing campaigns automatically",
];

export const CUSTOMER_SAFE_RESPONSE_RULES = {
  allowed: [
    'Use "usually starts at" for MOQ language',
    'Use "final pricing depends on..." for pricing variables',
    'Use "staff review" or "team review" for final approval',
    "Say the agent can collect details and prepare the request for review",
    "Ask for artwork, size, quantity, material, finish, deadline, and shipping details",
  ],
  blocked: [
    "Your final price is...",
    "Your quote is approved",
    "I created your order",
    "Production has started",
    "We guarantee this will be ready by...",
    "I applied a discount",
    "This is the final cost",
    "No review is needed",
  ],
};

export const AGENT_ESCALATION_TRIGGERS = [
  "Customer asks for final price",
  "Customer asks for rush/guaranteed turnaround",
  "Customer asks for discount",
  "Customer wants to approve/pay/order now",
  "Customer asks for custom shape/tooling",
  "Customer asks for DTP, boxes, die-cut/shaped bags, sourced resale, or custom/other",
  "Customer provides incomplete specs",
  "Customer asks legal/compliance questions",
  "Customer asks for production status",
  "Customer complains or threatens chargeback/refund",
  "Customer requests changes to Shopify order, invoice, or production job",
];

export const AGENT_STANDARD_INTAKE_FIELDS = [
  "customerName",
  "company",
  "email",
  "phone",
  "productFamily",
  "productType",
  "quantity",
  "dimensions",
  "material",
  "finish",
  "sides",
  "artworkReady",
  "artworkLink",
  "deadline",
  "shippingCityState",
  "notes",
];

export const PRODUCT_FAMILY_INTAKE_QUESTIONS: Record<string, string[]> = {
  jars: [
    "What jar size/type do you need?",
    "Do you need blank jars, labels, application, or both?",
    "What quantity are you looking for?",
    "Do you have artwork ready?",
    "Do you need side label, lid label, or side + lid?",
  ],
  "sticker-bags": [
    "What bag size do you need?",
    "What quantity are you looking for?",
    "Is it single-sided or double-sided?",
    "What label material/finish do you want?",
    "Do you have artwork ready?",
  ],
  "labels-stickers": [
    "What label/sticker size do you need?",
    "What quantity are you looking for?",
    "What material and finish do you want?",
    "Do you need roll labels, sheets, or die-cut stickers?",
    "Do you have print-ready artwork?",
  ],
  banners: [
    "What finished banner size do you need?",
    "Indoor or outdoor use?",
    "Do you need grommets, hems, pole pockets, or other finishing?",
    "What quantity do you need?",
    "Do you have artwork ready?",
  ],
  "apparel-dtf": [
    "What garment type do you need?",
    "What quantity and size/color breakdown?",
    "What print size/location?",
    "Do you have artwork ready?",
    "Do you need garments supplied or transfers only?",
  ],
  "dtp-pouches": [
    "What pouch size and style do you need?",
    "What quantity are you looking for?",
    "Stock shape or custom shape?",
    "What material/finish?",
    "Do you have artwork ready?",
  ],
  boxes: [
    "What box size/style do you need?",
    "What quantity are you looking for?",
    "What board/material/finish?",
    "Do you have dielines or artwork ready?",
    "Is this for a bag+box combo?",
  ],
  "die-cut-shaped-bags": [
    "What shape or die-cut style do you want?",
    "What size and quantity?",
    "Do you already have a dieline/tooling file?",
    "What material/finish?",
    "Do you have artwork ready?",
  ],
  "sourced-blank-resale": [
    "What blank/sourced item do you need?",
    "What quantity?",
    "Do you have a target supplier or sample?",
    "What deadline and shipping location?",
    "Are substitutions acceptable?",
  ],
  "custom-other": [
    "What are you trying to create?",
    "What quantity do you need?",
    "Do you have specs, samples, or references?",
    "Do you have artwork ready?",
    "What deadline are you working toward?",
  ],
};

function normalizeFamilyKey(family: string) {
  const text = String(family || "").trim().toLowerCase();

  if (text.includes("jar")) return "jars";
  if (text.includes("sticker") && text.includes("bag")) return "sticker-bags";
  if (text.includes("label") || text.includes("sticker")) return "labels-stickers";
  if (text.includes("banner")) return "banners";
  if (text.includes("apparel") || text.includes("dtf") || text.includes("shirt") || text.includes("hoodie")) return "apparel-dtf";
  if (text.includes("dtp") || text.includes("pouch")) return "dtp-pouches";
  if (text.includes("box")) return "boxes";
  if (text.includes("die") || text.includes("shape")) return "die-cut-shaped-bags";
  if (text.includes("sourced") || text.includes("blank") || text.includes("resale")) return "sourced-blank-resale";

  return PRODUCT_FAMILY_INTAKE_QUESTIONS[text] ? text : "custom-other";
}

export function allAgentIntakeRules() {
  return {
    version: AGENT_INTAKE_RULES_VERSION,
    mode: AGENT_INTAKE_MODE,
    guardrails: AGENT_INTAKE_GUARDRAILS,
    allowedActions: AGENT_ALLOWED_ACTIONS,
    blockedActions: AGENT_BLOCKED_ACTIONS,
    customerSafeResponseRules: CUSTOMER_SAFE_RESPONSE_RULES,
    escalationTriggers: AGENT_ESCALATION_TRIGGERS,
    standardIntakeFields: AGENT_STANDARD_INTAKE_FIELDS,
    productFamilyIntakeQuestions: PRODUCT_FAMILY_INTAKE_QUESTIONS,
  };
}

export function intakeQuestionsForFamily(family: string): string[] {
  return PRODUCT_FAMILY_INTAKE_QUESTIONS[normalizeFamilyKey(family)] || PRODUCT_FAMILY_INTAKE_QUESTIONS["custom-other"];
}
