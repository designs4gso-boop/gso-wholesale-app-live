// GSO structured output schemas (OPS-2, Phase 10). Provider-neutral.
//
// Every model output that affects workflow is validated here BEFORE the
// deterministic layer looks at it. Schemas are expressed as JSON Schema (for
// providers that accept it) plus a hand-written validator (so GSO never
// depends on a provider's schema library for authority). Malformed output
// fails closed.

export const REASONING_SCHEMAS_VERSION = "reasoning-schemas/1.0.0-2026-10-04";

export type JsonSchema = Record<string, unknown>;

export type SchemaDef<T> = { name: string; jsonSchema: JsonSchema; validate(value: unknown): { ok: true; value: T } | { ok: false; errors: string[] } };

const str = (v: unknown, max = 2000) => typeof v === "string" && v.length <= max;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
const strArray = (v: unknown, max = 50) => Array.isArray(v) && v.length <= max && v.every((x) => str(x, 500));
const obj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const SPECIALIST_KEYS = ["operations_supervisor", "cannabis_packaging_sales", "commercial_print_sales", "marketing_agent"] as const;
export type SpecialistKey = (typeof SPECIALIST_KEYS)[number];

export const LEAD_FAMILIES = ["stickers-labels", "sticker-bags", "stock-bags", "banners", "standard-jars", "premium-jars", "dtp-bags", "boxes", "custom-item", "unknown"] as const;

function def<T>(name: string, jsonSchema: JsonSchema, check: (v: Record<string, unknown>, errors: string[]) => void): SchemaDef<T> {
  return {
    name,
    jsonSchema: { type: "object", additionalProperties: false, ...jsonSchema },
    validate(value: unknown) {
      const errors: string[] = [];
      if (!obj(value)) return { ok: false, errors: [`${name}: expected an object`] };
      const allowed = Object.keys((jsonSchema.properties as Record<string, unknown>) ?? {});
      for (const k of Object.keys(value)) if (!allowed.includes(k)) errors.push(`${name}: unexpected field "${k}"`);
      check(value, errors);
      return errors.length ? { ok: false, errors } : { ok: true, value: value as T };
    },
  };
}

export type SalesClassification = { family: (typeof LEAD_FAMILIES)[number]; specialist: SpecialistKey; confidence: Confidence; reason: string };
export const SalesClassificationSchema = def<SalesClassification>("SalesClassification", {
  properties: { family: { type: "string", enum: [...LEAD_FAMILIES] }, specialist: { type: "string", enum: [...SPECIALIST_KEYS] }, confidence: { type: "string", enum: [...CONFIDENCE] }, reason: { type: "string" } },
  required: ["family", "specialist", "confidence", "reason"],
}, (v, e) => {
  if (!oneOf(v.family, LEAD_FAMILIES)) e.push("family invalid");
  if (!oneOf(v.specialist, SPECIALIST_KEYS)) e.push("specialist invalid");
  if (!oneOf(v.confidence, CONFIDENCE)) e.push("confidence invalid");
  if (!str(v.reason, 500)) e.push("reason invalid");
});

export type MissingInformationRequest = { missingFields: string[]; questions: string[]; reason: string };
export const MissingInformationRequestSchema = def<MissingInformationRequest>("MissingInformationRequest", {
  properties: { missingFields: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
  required: ["missingFields", "questions", "reason"],
}, (v, e) => { if (!strArray(v.missingFields)) e.push("missingFields invalid"); if (!strArray(v.questions, 10)) e.push("questions invalid"); if (!str(v.reason, 500)) e.push("reason invalid"); });

export type CustomerReplyDraft = { draft: string; tone: "friendly" | "formal"; containsPricing: false; containsPromises: false; reason: string };
export const CustomerReplyDraftSchema = def<CustomerReplyDraft>("CustomerReplyDraft", {
  properties: { draft: { type: "string" }, tone: { type: "string", enum: ["friendly", "formal"] }, containsPricing: { type: "boolean", enum: [false] }, containsPromises: { type: "boolean", enum: [false] }, reason: { type: "string" } },
  required: ["draft", "tone", "containsPricing", "containsPromises", "reason"],
}, (v, e) => {
  if (!str(v.draft, 3000)) e.push("draft invalid");
  if (!oneOf(v.tone, ["friendly", "formal"] as const)) e.push("tone invalid");
  if (v.containsPricing !== false) e.push("containsPricing must be false — the model may not price");
  if (v.containsPromises !== false) e.push("containsPromises must be false — the model may not promise turnaround");
  // Belt and braces (Phase 10): the flags are self-reported by the model, so the
  // text itself is also scanned. Any price-like or guarantee-like content fails.
  const draft = String(v.draft ?? "");
  if (/\$\s?\d|\d[\d,]*(\.\d+)?\s?(usd|dollars?)\b|\bper (unit|bag|label|jar|piece)\b.*\d|\bunit price\b|\bdiscount\b|\d{1,2}\s?% ?off/i.test(draft)) e.push("draft contains price/discount language — GSO prices only through the Cost Calculator");
  if (/\bguarantee[ds]?\b|\brush\b.*\bfree\b|\bships? in \d+ (business )?days?\b|\bturnaround (is|of) \d/i.test(draft)) e.push("draft contains a turnaround promise");
  if (!str(v.reason, 500)) e.push("reason invalid");
});

export const PROPOSABLE_ACTIONS = ["proposeQuoteAction", "proposeFollowup", "proposeArtReview", "proposeProductionTransition", "proposePurchaseRequest", "proposeExceptionEscalation", "none"] as const;
export type NextActionProposal = { recommendedAction: (typeof PROPOSABLE_ACTIONS)[number]; entityType: string; entityId: string; parameters: Record<string, string | number | boolean>; reason: string; confidence: Confidence; requiresApproval: true };
export const NextActionProposalSchema = def<NextActionProposal>("NextActionProposal", {
  properties: { recommendedAction: { type: "string", enum: [...PROPOSABLE_ACTIONS] }, entityType: { type: "string" }, entityId: { type: "string" }, parameters: { type: "object" }, reason: { type: "string" }, confidence: { type: "string", enum: [...CONFIDENCE] }, requiresApproval: { type: "boolean", enum: [true] } },
  required: ["recommendedAction", "entityType", "entityId", "parameters", "reason", "confidence", "requiresApproval"],
}, (v, e) => {
  if (!oneOf(v.recommendedAction, PROPOSABLE_ACTIONS)) e.push("recommendedAction invalid");
  if (!str(v.entityType, 50) || !str(v.entityId, 100)) e.push("entity invalid");
  if (!obj(v.parameters) || Object.values(v.parameters).some((x) => !["string", "number", "boolean"].includes(typeof x))) e.push("parameters must be flat scalars");
  if (!str(v.reason, 500)) e.push("reason invalid");
  if (!oneOf(v.confidence, CONFIDENCE)) e.push("confidence invalid");
  if (v.requiresApproval !== true) e.push("requiresApproval must be true — the model never self-approves");
});

export type AgentRecommendation = { summary: string; nextSteps: string[]; escalate: boolean; escalationReason: string | null; proposals: NextActionProposal[] };
export const AgentRecommendationSchema = def<AgentRecommendation>("AgentRecommendation", {
  properties: { summary: { type: "string" }, nextSteps: { type: "array", items: { type: "string" } }, escalate: { type: "boolean" }, escalationReason: { type: ["string", "null"] }, proposals: { type: "array", items: NextActionProposalSchema.jsonSchema } },
  required: ["summary", "nextSteps", "escalate", "escalationReason", "proposals"],
}, (v, e) => {
  if (!str(v.summary, 2000)) e.push("summary invalid");
  if (!strArray(v.nextSteps, 10)) e.push("nextSteps invalid");
  if (typeof v.escalate !== "boolean") e.push("escalate invalid");
  if (v.escalationReason !== null && !str(v.escalationReason, 500)) e.push("escalationReason invalid");
  if (!Array.isArray(v.proposals) || v.proposals.length > 5) e.push("proposals invalid");
  else for (const p of v.proposals) { const r = NextActionProposalSchema.validate(p); if (!r.ok) e.push(...r.errors); }
});

export type LeadQualification = { qualified: boolean; family: (typeof LEAD_FAMILIES)[number]; quantityKnown: boolean; artworkKnown: boolean; deadlineKnown: boolean; blockers: string[]; reason: string };
export const LeadQualificationSchema = def<LeadQualification>("LeadQualification", {
  properties: { qualified: { type: "boolean" }, family: { type: "string", enum: [...LEAD_FAMILIES] }, quantityKnown: { type: "boolean" }, artworkKnown: { type: "boolean" }, deadlineKnown: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
  required: ["qualified", "family", "quantityKnown", "artworkKnown", "deadlineKnown", "blockers", "reason"],
}, (v, e) => {
  for (const k of ["qualified", "quantityKnown", "artworkKnown", "deadlineKnown"]) if (typeof v[k] !== "boolean") e.push(`${k} invalid`);
  if (!oneOf(v.family, LEAD_FAMILIES)) e.push("family invalid");
  if (!strArray(v.blockers)) e.push("blockers invalid");
  if (!str(v.reason, 500)) e.push("reason invalid");
});

export type MarketingBriefOutput = { concept: string; audience: string; cta: string; copyDraft: string; subjectLines: string[]; containsDiscount: false; containsPricing: false };
export const MarketingBriefSchema = def<MarketingBriefOutput>("MarketingBrief", {
  properties: { concept: { type: "string" }, audience: { type: "string" }, cta: { type: "string" }, copyDraft: { type: "string" }, subjectLines: { type: "array", items: { type: "string" } }, containsDiscount: { type: "boolean", enum: [false] }, containsPricing: { type: "boolean", enum: [false] } },
  required: ["concept", "audience", "cta", "copyDraft", "subjectLines", "containsDiscount", "containsPricing"],
}, (v, e) => {
  for (const k of ["concept", "audience", "cta", "copyDraft"]) if (!str(v[k], 3000)) e.push(`${k} invalid`);
  if (!strArray(v.subjectLines, 8)) e.push("subjectLines invalid");
  if (v.containsDiscount !== false) e.push("containsDiscount must be false");
  if (v.containsPricing !== false) e.push("containsPricing must be false");
  if (/\d{1,2}\s?%\s?off|discount|free shipping|\$\d/i.test(String(v.copyDraft))) e.push("copyDraft contains discount/price language");
});

export type ExceptionAnalysis = { code: string; likelyCause: string; recommendedOwner: string; nextAction: string; severity: "info" | "warning" | "high" | "critical" };
export const ExceptionAnalysisSchema = def<ExceptionAnalysis>("ExceptionAnalysis", {
  properties: { code: { type: "string" }, likelyCause: { type: "string" }, recommendedOwner: { type: "string" }, nextAction: { type: "string" }, severity: { type: "string", enum: ["info", "warning", "high", "critical"] } },
  required: ["code", "likelyCause", "recommendedOwner", "nextAction", "severity"],
}, (v, e) => {
  for (const k of ["code", "likelyCause", "recommendedOwner", "nextAction"]) if (!str(v[k], 1000)) e.push(`${k} invalid`);
  if (!oneOf(v.severity, ["info", "warning", "high", "critical"] as const)) e.push("severity invalid");
});

export const SCHEMAS = {
  SalesClassification: SalesClassificationSchema,
  LeadQualification: LeadQualificationSchema,
  MissingInformationRequest: MissingInformationRequestSchema,
  CustomerReplyDraft: CustomerReplyDraftSchema,
  NextActionProposal: NextActionProposalSchema,
  AgentRecommendation: AgentRecommendationSchema,
  MarketingBrief: MarketingBriefSchema,
  ExceptionAnalysis: ExceptionAnalysisSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

export function validateOutput(schemaName: string, value: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const schema = (SCHEMAS as Record<string, SchemaDef<unknown>>)[schemaName];
  if (!schema) return { ok: false, errors: [`unknown output schema "${schemaName}"`] };
  return schema.validate(value);
}
