// GSO ERP SIMPLE MODE (2026-11-14) — employee-friendly wording.
//
// PRESENTATION ONLY. Server messages, blocker codes and permission checks are
// unchanged: this takes the message a server action / engine already returned
// and gives the screen a plain-English first line, keeping the original text
// available under "Details". Nothing here decides whether something is
// allowed. Pure, client-safe.

export type FriendlyMessage = {
  /** Plain-English line to show first. */
  primary: string;
  /** The original technical message, shown under Details; null when the message was already plain. */
  detail: string | null;
};

/** Owner-approved wording (blueprint section 14). First match wins. */
export const EMPLOYEE_MESSAGE_RULES: readonly { match: RegExp; primary: string }[] = [
  { match: /QC PASS REQUIRED/i, primary: "Record QC PASS on every item first" },
  { match: /SHIPMENT \/ PICKUP RECORD REQUIRED/i, primary: "Record the shipment or pickup first" },
  { match: /COMPLETION REQUIRES SHIPMENT OR PICKUP/i, primary: "Ship or hand over the job before completing it" },
  { match: /SHIPMENT ALREADY RECORDED/i, primary: "A shipment is already recorded for this job" },
  { match: /CUSTOMER PICKUP ALREADY RECORDED/i, primary: "A pickup is already recorded for this job" },
  { match: /REPRINT[ _]ALREADY[ _]RECORDED|waiting for QC/i, primary: "This reprint is already recorded — record QC on it next" },
  { match: /DTP MANUAL REVIEW REQUIRED/i, primary: "Owner review needed before offering DTP" },
  { match: /BELOW FAMILY FLOOR/i, primary: "Price is too low — owner approval needed" },
  { match: /OWNER OVERRIDE REQUIRED/i, primary: "Ask the owner to approve this price" },
  { match: /PRICING[ _]AUTHORITY[ _]REQUIRED|OWNER PRICING REVIEW REQUIRED|OWNER APPROVAL REQUIRED/i, primary: "Owner approval needed" },
  { match: /AUTO_MACHINE_LOAD_UNAVAILABLE/i, primary: "Select Mimaki or Roland" },
  { match: /NO_COMPATIBLE_PRINTER/i, primary: "Choose another printer" },
  { match: /MIMAKI_GLOSS_UNSUPPORTED/i, primary: "Gloss needs the Roland" },
  { match: /MIMAKI_WHITE_CALIBRATION_REQUIRED/i, primary: "White ink on the Mimaki isn't approved yet — use the Roland or ask the owner" },
  { match: /WHITE_COVERAGE_REQUIRED/i, primary: "Enter how much of the design is white" },
  { match: /INVALID_LAYER_COUNT/i, primary: "Check the number of ink layers" },
  { match: /MISSING_INK_PRICE|COST NOT VERIFIED/i, primary: "Cost isn't set up for this — ask the owner" },
  { match: /FAMILY MARGIN RULE NOT CONFIGURED/i, primary: "Pricing isn't set up for this product — ask the owner" },
  { match: /REQUEST[ _]CURRENT[ _]VENDOR[ _]QUOTE/i, primary: "Get a current vendor price first" },
  { match: /PRICE_NOT_AVAILABLE/i, primary: "No price is available yet — ask the owner" },
  { match: /^Owner only\b/i, primary: "Only the owner can do this" },
  { match: /needs an assigned ERP role|No ERP role is assigned/i, primary: "Your account doesn't have access to this yet — ask the owner" },
  { match: /can't do this on a production job/i, primary: "Your role can't do this — ask a manager" },
  { match: /Work order print event tracked/i, primary: "Work order marked as printed" },
  { match: /reopened for reprint/i, primary: "Job reopened for reprint" },
  { match: /use the normal Reprint button/i, primary: "This job isn't completed — use NEEDS REPRINT on the item instead" },
];

/** Plain-English first line for a message; the original stays available as `detail`. */
export function friendlyMessage(raw: unknown): FriendlyMessage {
  const text = String(raw ?? "").trim();
  if (!text) return { primary: "", detail: null };
  const rule = EMPLOYEE_MESSAGE_RULES.find((candidate) => candidate.match.test(text));
  return rule ? { primary: rule.primary, detail: text } : { primary: text, detail: null };
}
