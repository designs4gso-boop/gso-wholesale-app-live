// GSO Operations Agent Platform — Quote Prep agent (deterministic).
//
// Decides quote READINESS, never price. Canonical families (stickers-labels,
// sticker-bags, stock-bags, banners, standard-jars, premium-jars) are built
// by staff in the Cost Calculator under the canonical cost authority. DTP
// bags, boxes and custom items are LEGACY_OUTSOURCED and go to staff for
// vendor-cost review. A canonical blocker (missing calibration, blank cost,
// white coverage, MOQ) is reported, never estimated around.

import { familyCostModel, isCanonicalFailClosedFamily } from "../canonical-quote-authority.server";
import { officialMoqForFamily } from "../product-family-sales-rules";
import { AGENT_QUOTE_PREP_BLOCKED_ACTIONS } from "../agent-quote-prep-rules";
import { assessLead, type LeadAssessment, type LeadInput, type LeadFamily } from "./sales-intake";

export const QUOTE_PREP_VERSION = "quote-prep/1.0.0-2026-10-03";

export type QuotePrepStatus = "READY_FOR_STAFF_QUOTE" | "NEEDS_INFO" | "CANONICAL_BLOCKED" | "OUTSOURCED_REVIEW" | "UNSUPPORTED";

export type CanonicalCheck = { usable: boolean; reason?: string | null };

export type QuotePrepResult = {
  version: string;
  status: QuotePrepStatus;
  family: LeadFamily | null;
  costModel: "CANONICAL_COST_AUTHORITY" | "CANONICAL_FAIL_CLOSED" | "LEGACY_OUTSOURCED" | "UNKNOWN";
  missingFields: string[];
  staffReviewTriggers: string[];
  canonicalBlocker: string | null;
  /** Where staff build the real quote. */
  calculatorPath: string | null;
  handoffNote: string;
  blockedNextSteps: string[];
  assessment: LeadAssessment;
};

const SUPPORTED: LeadFamily[] = ["stickers-labels", "sticker-bags", "stock-bags", "banners", "standard-jars", "premium-jars", "dtp-bags", "boxes", "custom-item"];

export function prepareQuote(lead: LeadInput, options: { canonicalCheck?: CanonicalCheck | null; existing?: Parameters<typeof assessLead>[1]; now?: Date } = {}): QuotePrepResult {
  const assessment = assessLead(lead, options.existing ?? [], options.now ?? new Date());
  const family = assessment.classification.family;
  const triggers: string[] = [];
  for (const e of assessment.escalations) {
    if (e === "final_price_requested") triggers.push("Customer asks for final price");
    if (e === "rush_requested") triggers.push("Customer asks for rush turnaround");
    if (e === "discount_requested") triggers.push("Customer asks for discount");
    if (e === "wants_to_order_now") triggers.push("Customer asks to approve/order/pay now");
    if (e === "below_moq") triggers.push(`Quantity is below official MOQ${family ? ` (${officialMoqForFamily(family)})` : ""}`);
    if (e === "legal_or_compliance") triggers.push("Customer asks legal/compliance questions");
    if (e === "untrusted_instruction") triggers.push("Customer text contains instruction-like content (flagged, ignored)");
  }
  if (String(lead.artworkReady ?? "").toLowerCase() === "false" || lead.artworkReady === false) triggers.push("Artwork is not ready");

  const base = { version: QUOTE_PREP_VERSION, family, missingFields: assessment.missingFields, staffReviewTriggers: triggers, blockedNextSteps: AGENT_QUOTE_PREP_BLOCKED_ACTIONS.slice(0, 6), assessment };

  if (!family) {
    return { ...base, status: "NEEDS_INFO", costModel: "UNKNOWN", canonicalBlocker: null, calculatorPath: null, handoffNote: "Product family unknown — ask the customer what they need before staff review." };
  }
  if (!SUPPORTED.includes(family)) {
    return { ...base, status: "UNSUPPORTED", costModel: "UNKNOWN", canonicalBlocker: null, calculatorPath: null, handoffNote: `Family "${family}" is not quotable by GSO systems; staff decide manually.` };
  }
  const model = familyCostModel(family);
  if (isCanonicalFailClosedFamily(family) || model === "CANONICAL_FAIL_CLOSED") {
    return { ...base, status: "CANONICAL_BLOCKED", costModel: "CANONICAL_FAIL_CLOSED", canonicalBlocker: "family is fail-closed in the canonical engine", calculatorPath: null, handoffNote: "Canonical engine refuses this family; owner decision required. No price may be given." };
  }
  if (model === "LEGACY_OUTSOURCED") {
    return { ...base, status: "OUTSOURCED_REVIEW", costModel: "LEGACY_OUTSOURCED", canonicalBlocker: null, calculatorPath: "/app/erp/vendor-cost-book", handoffNote: `${family} is vendor-produced: staff confirm vendor cost, freight and lead time from the vendor cost book before quoting. Nothing is estimated.` };
  }
  if (assessment.missingFields.length) {
    return { ...base, status: "NEEDS_INFO", costModel: "CANONICAL_COST_AUTHORITY", canonicalBlocker: null, calculatorPath: "/app/erp/cost-calculator", handoffNote: `Collect ${assessment.missingFields.join(", ")} before staff build the quote in the Cost Calculator.` };
  }
  if (options.canonicalCheck && !options.canonicalCheck.usable) {
    return { ...base, status: "CANONICAL_BLOCKED", costModel: "CANONICAL_COST_AUTHORITY", canonicalBlocker: options.canonicalCheck.reason ?? "canonical cost not usable", calculatorPath: "/app/erp/cost-calculator", handoffNote: `Canonical blocker: ${options.canonicalCheck.reason ?? "cost not usable"}. Owner/staff must supply the missing input; the quote must not be priced manually.` };
  }
  return { ...base, status: "READY_FOR_STAFF_QUOTE", costModel: "CANONICAL_COST_AUTHORITY", canonicalBlocker: null, calculatorPath: "/app/erp/cost-calculator", handoffNote: `Staff: build ${family} x ${Number(lead.quantity)} in the Cost Calculator (canonical authority), then review margin and send.${triggers.length ? ` Review triggers: ${triggers.join("; ")}.` : ""}` };
}
