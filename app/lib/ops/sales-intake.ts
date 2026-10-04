// GSO Operations Agent Platform — Lead Manager / Sales Intake (deterministic).
//
// Validates a lead, classifies the product family, detects duplicates,
// lists missing intake fields, detects escalation triggers and drafts a
// customer-safe reply FOR STAFF REVIEW. It never prices, never promises
// turnaround, never sends anything. Free text from the customer is
// untrusted data (see untrusted-text.ts).

import { CANONICAL_FAMILIES, NON_CANONICAL_FAMILIES } from "../canonical-calculator-shared";
import { familyByKeyOrAlias } from "../product-family-registry";
import { officialMoqForFamily } from "../product-family-sales-rules";
import { AGENT_QUOTE_PREP_REQUIRED_FIELDS } from "../agent-quote-prep-rules";
import { PRODUCT_FAMILY_INTAKE_QUESTIONS } from "../agent-intake-rules";
import { scanUntrustedText } from "./untrusted-text";
import type { AgentId } from "./agent-registry";

export const SALES_INTAKE_VERSION = "sales-intake/1.0.0-2026-10-03";

export type LeadInput = {
  source: string;
  receivedAt?: string;
  customerName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  productFamily?: string | null;
  productType?: string | null;
  quantity?: number | string | null;
  dimensions?: string | null;
  material?: string | null;
  finish?: string | null;
  sides?: string | number | null;
  artworkReady?: boolean | string | null;
  artworkLink?: string | null;
  deadline?: string | null;
  shippingCityState?: string | null;
  notes?: string | null;
  freeText?: string | null;
};

export type LeadFamily = (typeof CANONICAL_FAMILIES)[number] | (typeof NON_CANONICAL_FAMILIES)[number] | "boxes";

const KNOWN_FAMILIES: string[] = [...CANONICAL_FAMILIES, ...NON_CANONICAL_FAMILIES, "boxes"];

const KEYWORDS: Array<{ family: LeadFamily; re: RegExp }> = [
  { family: "premium-jars", re: /\b(premium jars?|chiron|glass jars?|child.?resistant jars?)\b/i },
  { family: "standard-jars", re: /\b(jars?|3 ?oz|4 ?oz|5 ?oz|soda can)\b/i },
  { family: "dtp-bags", re: /\b(dtp|direct.?to.?print|printed mylar|fully printed bags?|die.?cut bags?|shaped bags?)\b/i },
  { family: "boxes", re: /\b(box|boxes|cartons?|folding cartons?)\b/i },
  { family: "sticker-bags", re: /\b(sticker bags?|labeled bags?|bags? with (a )?labels?|mylar bags? with labels?)\b/i },
  { family: "stock-bags", re: /\b(stock bags?|blank bags?|plain mylar|unprinted bags?)\b/i },
  { family: "banners", re: /\b(banners?|vinyl banner|mesh banner)\b/i },
  { family: "stickers-labels", re: /\b(stickers?|labels?|decals?|die.?cut stickers?|roll labels?)\b/i },
];

export function normalizeFamily(value: unknown): LeadFamily | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (KNOWN_FAMILIES.includes(text)) return text as LeadFamily;
  const entry = familyByKeyOrAlias(text);
  if (entry && KNOWN_FAMILIES.includes(entry.key)) return entry.key as LeadFamily;
  const compact = text.replace(/[\s_]+/g, "-");
  if (KNOWN_FAMILIES.includes(compact)) return compact as LeadFamily;
  if (compact === "jars" || compact === "jar") return "standard-jars";
  if (compact === "labels" || compact === "stickers") return "stickers-labels";
  return null; // "bags" alone is ambiguous: sticker vs stock vs dtp
}

export function detectFamilyFromText(...texts: Array<string | null | undefined>): { family: LeadFamily | null; matched: string | null } {
  const haystack = texts.filter(Boolean).join(" \n ");
  for (const k of KEYWORDS) {
    const m = haystack.match(k.re);
    if (m) return { family: k.family, matched: m[0] };
  }
  return { family: null, matched: null };
}

export type LeadClassification = {
  family: LeadFamily | null;
  familySource: "explicit" | "keyword" | "unknown";
  familyEvidence: string | null;
  costModel: "canonical" | "outsourced" | "unknown";
  routeTo: AgentId;
  specialist: "cannabis_packaging" | "commercial_print" | "generic";
};

export function classifyLead(lead: LeadInput): LeadClassification {
  let family = normalizeFamily(lead.productFamily);
  let familySource: LeadClassification["familySource"] = family ? "explicit" : "unknown";
  let evidence: string | null = family ? String(lead.productFamily) : null;
  if (!family) {
    const hit = detectFamilyFromText(lead.productType, lead.notes, lead.freeText, lead.productFamily);
    if (hit.family) { family = hit.family; familySource = "keyword"; evidence = hit.matched; }
  }
  const costModel: LeadClassification["costModel"] = !family ? "unknown" : (CANONICAL_FAMILIES as readonly string[]).includes(family) ? "canonical" : "outsourced";
  const packaging: LeadFamily[] = ["standard-jars", "premium-jars", "sticker-bags", "stock-bags", "dtp-bags", "boxes"];
  const specialist: LeadClassification["specialist"] = !family ? "generic" : packaging.includes(family) ? "cannabis_packaging" : "commercial_print";
  const routeTo: AgentId = specialist === "cannabis_packaging" ? "cannabis_packaging_sales" : specialist === "commercial_print" ? "commercial_print_sales" : "sales_intake";
  return { family, familySource, familyEvidence: evidence, costModel, routeTo, specialist };
}

/** Required quote-prep fields mapped onto the lead shape. */
const FIELD_MAP: Record<string, (l: LeadInput) => boolean> = {
  customerName: (l) => Boolean(String(l.customerName ?? "").trim() || String(l.company ?? "").trim()),
  contactMethod: (l) => Boolean(String(l.email ?? "").trim() || String(l.phone ?? "").trim()),
  productFamily: (l) => Boolean(classifyLead(l).family),
  quantity: (l) => Number(l.quantity) > 0,
  dimensionsOrSize: (l) => Boolean(String(l.dimensions ?? "").trim()),
  materialOrSubstrate: (l) => Boolean(String(l.material ?? "").trim()),
  finish: (l) => Boolean(String(l.finish ?? "").trim()),
  artworkStatus: (l) => l.artworkReady !== null && l.artworkReady !== undefined && String(l.artworkReady).trim() !== "",
  deadline: (l) => Boolean(String(l.deadline ?? "").trim()),
  shippingCityState: (l) => Boolean(String(l.shippingCityState ?? "").trim()),
};

export function missingLeadFields(lead: LeadInput): string[] {
  return AGENT_QUOTE_PREP_REQUIRED_FIELDS.filter((f) => !(FIELD_MAP[f]?.(lead) ?? false));
}

export type EscalationTrigger =
  | "final_price_requested"
  | "rush_requested"
  | "discount_requested"
  | "wants_to_order_now"
  | "custom_shape_or_tooling"
  | "outsourced_family"
  | "legal_or_compliance"
  | "production_status_requested"
  | "complaint_or_chargeback"
  | "order_or_invoice_change"
  | "below_moq"
  | "untrusted_instruction";

export function detectEscalations(lead: LeadInput, classification = classifyLead(lead)): EscalationTrigger[] {
  const text = [lead.notes, lead.freeText].filter(Boolean).join(" \n ");
  const out: EscalationTrigger[] = [];
  const add = (t: EscalationTrigger) => { if (!out.includes(t)) out.push(t); };
  if (/\b(final|exact|best|firm) price|how much (does|will|is)|price per|unit price|total cost\b/i.test(text)) add("final_price_requested");
  if (/\b(rush|asap|urgent|guaranteed? (by|turnaround)|overnight|by (tomorrow|friday|monday))\b/i.test(text)) add("rush_requested");
  if (/\bdiscount|\d{1,2}\s?% off|free shipping|waive|price match\b/i.test(text)) add("discount_requested");
  if (/\b(place (the|my|an) order|order now|pay now|ready to (order|pay|buy)|send (me )?(the )?invoice|approve (it|this) now)\b/i.test(text)) add("wants_to_order_now");
  if (/\b(custom (shape|die|tooling)|die ?line|shaped (bag|sticker)|tooling charge)\b/i.test(text)) add("custom_shape_or_tooling");
  if (classification.costModel === "outsourced") add("outsourced_family");
  if (/\b(compliant|compliance|legal|regulation|warning label|prop ?65|state law|metrc|ftc|fda)\b/i.test(text)) add("legal_or_compliance");
  if (/\b(where is my|status of my|tracking|when will (it|my order) ship)\b/i.test(text)) add("production_status_requested");
  if (/\b(chargeback|refund|complain|dispute|unacceptable|lawyer)\b/i.test(text)) add("complaint_or_chargeback");
  if (/\b(change (my|the) (order|invoice|job)|cancel (my|the) order|edit (my|the) order)\b/i.test(text)) add("order_or_invoice_change");
  const moq = classification.family ? officialMoqForFamily(classification.family) : null;
  if (moq && Number(lead.quantity) > 0 && Number(lead.quantity) < moq) add("below_moq");
  if (scanUntrustedText(text).instructionLike) add("untrusted_instruction");
  return out;
}

export type DuplicateVerdict = { duplicate: boolean; matchedId: string | null; basis: string | null };

export type ExistingLeadRef = { id: string; email?: string | null; company?: string | null; family?: string | null; quantity?: number | null; createdAt: string };

export function detectDuplicateLead(lead: LeadInput, existing: ExistingLeadRef[], now = new Date(), windowDays = 14): DuplicateVerdict {
  const email = String(lead.email ?? "").trim().toLowerCase();
  const company = String(lead.company ?? "").trim().toLowerCase();
  const family = classifyLead(lead).family;
  const qty = Number(lead.quantity) || null;
  for (const row of existing) {
    const ageDays = (now.getTime() - new Date(row.createdAt).getTime()) / 86400000;
    if (!Number.isFinite(ageDays) || ageDays > windowDays) continue;
    if (email && String(row.email ?? "").trim().toLowerCase() === email && (!family || !row.family || row.family === family)) {
      return { duplicate: true, matchedId: row.id, basis: "same email within window" };
    }
    if (company && String(row.company ?? "").trim().toLowerCase() === company && row.family === family && qty && row.quantity === qty) {
      return { duplicate: true, matchedId: row.id, basis: "same company, family and quantity within window" };
    }
  }
  return { duplicate: false, matchedId: null, basis: null };
}

const GENERIC_QUESTIONS = ["What product are you looking for?", "What quantity are you looking for?", "Do you have artwork ready?"];

export function intakeQuestionsFor(family: LeadFamily | null): string[] {
  if (!family) return PRODUCT_FAMILY_INTAKE_QUESTIONS["unknown"] ?? GENERIC_QUESTIONS;
  const key = family === "standard-jars" || family === "premium-jars" ? "jars" : family;
  return PRODUCT_FAMILY_INTAKE_QUESTIONS[key] ?? PRODUCT_FAMILY_INTAKE_QUESTIONS["unknown"] ?? GENERIC_QUESTIONS;
}

/** Phrases that must never appear in a customer-facing draft (AGENT_QUOTE_PREP_CUSTOMER_SAFE_REPLY_RULES.blocked). */
export const BLOCKED_REPLY_PATTERNS = [/your final price/i, /quote is approved/i, /i created your/i, /i sent your invoice/i, /production has started/i, /guaranteed turnaround/i, /discount applied/i];

/**
 * Customer-safe draft. Allowed: confirm details, "usually starts at" MOQ,
 * pricing depends on specs + staff review, ask for missing details.
 */
export function draftCustomerSafeReply(lead: LeadInput): string {
  const c = classifyLead(lead);
  const missing = missingLeadFields(lead);
  const name = String(lead.customerName ?? "").trim();
  const moq = c.family ? officialMoqForFamily(c.family) : null;
  const lines: string[] = [];
  lines.push(`Hi${name ? ` ${name.split(" ")[0]}` : ""}, thanks for reaching out to GSO.`);
  if (c.family) lines.push(`I have your request down as ${c.family.replace(/-/g, " ")}${Number(lead.quantity) > 0 ? ` at roughly ${Number(lead.quantity)} units` : ""}.`);
  if (moq) lines.push(`Minimums for this product usually start at ${moq} units.`);
  if (missing.length) {
    const asks = intakeQuestionsFor(c.family).slice(0, Math.min(4, missing.length));
    lines.push(`To get this to the team for review I still need a few details: ${asks.join(" ")}`);
  }
  lines.push("Final pricing depends on the exact specs, artwork and a staff review, and the team will follow up with you.");
  return lines.join(" ");
}

export type LeadAssessment = {
  version: string;
  classification: LeadClassification;
  missingFields: string[];
  escalations: EscalationTrigger[];
  duplicate: DuplicateVerdict;
  questions: string[];
  customerSafeDraftReply: string;
  /** Agent Review Queue status this lead should enter with. */
  reviewQueueStatus: "needs_staff_review" | "missing_customer_info" | "needs_cost_review";
  reviewLevel: "basic_staff_review" | "cost_review_required" | "manual_pricing_required" | "compliance_or_legal_review_required" | "out_of_scope";
};

export function assessLead(lead: LeadInput, existing: ExistingLeadRef[] = [], now = new Date()): LeadAssessment {
  const classification = classifyLead(lead);
  const missingFields = missingLeadFields(lead);
  const escalations = detectEscalations(lead, classification);
  const duplicate = detectDuplicateLead(lead, existing, now);
  let reviewLevel: LeadAssessment["reviewLevel"] = "basic_staff_review";
  if (escalations.includes("legal_or_compliance")) reviewLevel = "compliance_or_legal_review_required";
  else if (classification.costModel === "outsourced" || escalations.includes("custom_shape_or_tooling")) reviewLevel = "manual_pricing_required";
  else if (escalations.includes("final_price_requested") || escalations.includes("discount_requested") || escalations.includes("below_moq")) reviewLevel = "cost_review_required";
  const reviewQueueStatus: LeadAssessment["reviewQueueStatus"] = missingFields.length
    ? "missing_customer_info"
    : reviewLevel === "cost_review_required" || reviewLevel === "manual_pricing_required" ? "needs_cost_review" : "needs_staff_review";
  return {
    version: SALES_INTAKE_VERSION,
    classification,
    missingFields,
    escalations,
    duplicate,
    questions: intakeQuestionsFor(classification.family),
    customerSafeDraftReply: draftCustomerSafeReply(lead),
    reviewQueueStatus,
    reviewLevel,
  };
}
