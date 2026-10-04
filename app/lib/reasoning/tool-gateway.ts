// GSO AGENT TOOL GATEWAY (OPS-2, Phase 11). The ONLY surface a model can touch.
//
// Two kinds of tools:
//   READ      deterministic lookups through injected GSO services; results are
//             shaped (minimum context), never raw rows.
//   PROPOSAL  create an ActionIntent through the intent engine. The model never
//             executes anything; approval/execution stay with GSO.
//
// Every request passes: name allow-list -> JSON input validation ->
// specialist allow-list -> agent permission matrix (ceiling) -> service.
// No tool here can reach Prisma writes, Shopify, Slack sends, invoices, POs,
// refunds, filesystem, shell, PowerShell, computer control or arbitrary HTTP.
// Client-safe module: services are injected.

import { proposeIntent, validateIntent, type ActionIntent } from "../ops/action-intents";
import type { ActionType } from "../ops/autonomy";
import { permissionFor } from "../ops/agent-registry";
import type { ActionIntentRepository } from "../ops/repositories";
import { scanUntrustedText } from "../ops/untrusted-text";

export const TOOL_GATEWAY_VERSION = "tool-gateway/1.0.0-2026-10-04";

export type ToolKind = "read" | "proposal";

export type ToolDefinition = {
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema for the model; strict object with scalar fields only. */
  parameters: Record<string, unknown>;
  /** Scalar field validators (fail closed). */
  fields: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; enum?: readonly string[]; max?: number }>;
  /** For proposal tools: the ActionType the intent is created with. */
  actionType?: ActionType;
  /** Proposal tools pause the model run for a human (SDK needsApproval maps here). */
  needsApproval: boolean;
};

export type ToolRequest = { toolName: string; args: Record<string, unknown>; agentId: string; specialistKey: string; requestId: string; provider?: string | null; model?: string | null };

export type ToolResult =
  | { ok: true; kind: "read"; data: Record<string, unknown> }
  | { ok: true; kind: "proposal"; intentId: string; status: string; autonomyLevel: string; requiresApproval: boolean; duplicate: boolean }
  | { ok: false; error: string; code: "unknown_tool" | "not_allowed_for_specialist" | "invalid_args" | "permission_denied" | "service_error" | "untrusted_instruction" };

export type ToolCallRecord = { toolName: string; ok: boolean; code?: string; intentId?: string; at: string };

/** READ services the gateway may call. All deterministic, all GSO-owned. */
export type GatewayReadServices = {
  getProductRules(args: { family: string }): Promise<Record<string, unknown>>;
  getQuoteReadiness(args: { leadId: string }): Promise<Record<string, unknown>>;
  getCanonicalCostStatus(args: { family: string; quantity: number }): Promise<Record<string, unknown>>;
  getCustomerSummary(args: { customerId: string }): Promise<Record<string, unknown>>;
  getLeadStatus(args: { leadId: string }): Promise<Record<string, unknown>>;
  getArtStatus(args: { jobId: string }): Promise<Record<string, unknown>>;
  getProductionStatus(args: { jobId: string }): Promise<Record<string, unknown>>;
  getPurchasingStatus(args: { jobId: string }): Promise<Record<string, unknown>>;
  getShippingStatus(args: { jobId: string }): Promise<Record<string, unknown>>;
  getAgentCapabilities(args: { agentId: string }): Promise<Record<string, unknown>>;
};

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const N = (description: string) => ({ type: "number", description });

function schema(props: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, properties: props, required };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "getProductRules", kind: "read", description: "Official sales rules, MOQ and quote-prep status for a product family.", parameters: schema({ family: S("family key") }, ["family"]), fields: { family: { type: "string", required: true, max: 40 } }, needsApproval: false },
  { name: "getQuoteReadiness", kind: "read", description: "Deterministic quote readiness for a lead (READY_FOR_STAFF_QUOTE / NEEDS_INFO / CANONICAL_BLOCKED / OUTSOURCED_REVIEW / UNSUPPORTED).", parameters: schema({ leadId: S("lead id") }, ["leadId"]), fields: { leadId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getCanonicalCostStatus", kind: "read", description: "Whether the canonical cost engine can cost this family/quantity and what blocks it. Never returns a price.", parameters: schema({ family: S("family key"), quantity: N("quantity") }, ["family", "quantity"]), fields: { family: { type: "string", required: true, max: 40 }, quantity: { type: "number", required: true } }, needsApproval: false },
  { name: "getCustomerSummary", kind: "read", description: "Display name, company and open work for a customer. No contact secrets.", parameters: schema({ customerId: S("customer id") }, ["customerId"]), fields: { customerId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getLeadStatus", kind: "read", description: "Lead classification, missing fields, escalations, review queue status.", parameters: schema({ leadId: S("lead id") }, ["leadId"]), fields: { leadId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getArtStatus", kind: "read", description: "Art preflight result and approval states on the current version.", parameters: schema({ jobId: S("job id or ticket") }, ["jobId"]), fields: { jobId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getProductionStatus", kind: "read", description: "Stage, readiness, blockers and next action for a production job.", parameters: schema({ jobId: S("job id or ticket") }, ["jobId"]), fields: { jobId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getPurchasingStatus", kind: "read", description: "Open purchase requests and material readiness for a job.", parameters: schema({ jobId: S("job id or ticket") }, ["jobId"]), fields: { jobId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getShippingStatus", kind: "read", description: "Shipping readiness and tracking facts for a job.", parameters: schema({ jobId: S("job id or ticket") }, ["jobId"]), fields: { jobId: { type: "string", required: true, max: 100 } }, needsApproval: false },
  { name: "getAgentCapabilities", kind: "read", description: "What an agent may do (permission matrix row).", parameters: schema({ agentId: S("agent id") }, ["agentId"]), fields: { agentId: { type: "string", required: true, max: 60 } }, needsApproval: false },

  { name: "proposeQuoteAction", kind: "proposal", actionType: "prepare_quote_prep_draft", description: "Propose that staff prepare a quote for a lead (internal draft; never prices).", parameters: schema({ leadId: S("lead id"), reason: S("why") }, ["leadId", "reason"]), fields: { leadId: { type: "string", required: true, max: 100 }, reason: { type: "string", required: true, max: 500 } }, needsApproval: false },
  { name: "proposeFollowup", kind: "proposal", actionType: "draft_followup", description: "Propose a follow-up draft for staff to send.", parameters: schema({ leadId: S("lead id"), reason: S("why") }, ["leadId", "reason"]), fields: { leadId: { type: "string", required: true, max: 100 }, reason: { type: "string", required: true, max: 500 } }, needsApproval: false },
  { name: "proposeArtReview", kind: "proposal", actionType: "request_art_approval", description: "Propose that a human review/approve art for a job. Never approves.", parameters: schema({ jobId: S("job id"), reason: S("why") }, ["jobId", "reason"]), fields: { jobId: { type: "string", required: true, max: 100 }, reason: { type: "string", required: true, max: 500 } }, needsApproval: true },
  { name: "proposeProductionTransition", kind: "proposal", actionType: "move_production_job", description: "Propose moving a job to a target status. Always requires human approval and the transition executor.", parameters: schema({ jobId: S("job id"), targetStatus: S("target status", { enum: ["proof_sent", "proof_approved", "routed", "printing", "cutting", "production", "qc", "completed", "shipped", "on_hold"] }), reason: S("why") }, ["jobId", "targetStatus", "reason"]), fields: { jobId: { type: "string", required: true, max: 100 }, targetStatus: { type: "string", required: true, enum: ["proof_sent", "proof_approved", "routed", "printing", "cutting", "production", "qc", "completed", "shipped", "on_hold"] }, reason: { type: "string", required: true, max: 500 } }, needsApproval: true },
  { name: "proposePurchaseRequest", kind: "proposal", actionType: "prepare_purchase_order", description: "Propose a purchase request draft from known vendor data. Never invents cost.", parameters: schema({ materialName: S("material"), quantity: N("quantity"), reason: S("why") }, ["materialName", "quantity", "reason"]), fields: { materialName: { type: "string", required: true, max: 200 }, quantity: { type: "number", required: true }, reason: { type: "string", required: true, max: 500 } }, needsApproval: true },
  { name: "proposeExceptionEscalation", kind: "proposal", actionType: "post_slack_internal", description: "Route an exception to the responsible humans.", parameters: schema({ entityId: S("entity"), code: S("exception code"), summary: S("summary") }, ["entityId", "code", "summary"]), fields: { entityId: { type: "string", required: true, max: 100 }, code: { type: "string", required: true, max: 60 }, summary: { type: "string", required: true, max: 500 } }, needsApproval: false },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

/** Tools the production agents must NEVER receive (Phase 12). Checked by tests against the gateway. */
export const FORBIDDEN_TOOL_PATTERNS = [/shell/i, /apply.?patch/i, /computer/i, /file.?system|writeFile|readFile/i, /prisma|sql/i, /shopify.*(mutation|update|delete)/i, /slack.*send|postMessage/i, /invoice/i, /purchase.?order.*(send|create)/i, /refund|void/i, /http|fetch|web/i, /exec|spawn|powershell/i];

export function definitionFor(name: string): ToolDefinition | null {
  return TOOL_DEFINITIONS.find((t) => t.name === name) ?? null;
}

export function validateArgs(def: ToolDefinition, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, errors: ["args must be an object"] };
  const input = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(input)) if (!def.fields[key]) errors.push(`unexpected argument "${key}"`);
  for (const [key, rule] of Object.entries(def.fields)) {
    const v = input[key];
    if (v === undefined || v === null) { if (rule.required) errors.push(`missing "${key}"`); continue; }
    if (typeof v !== rule.type) { errors.push(`"${key}" must be ${rule.type}`); continue; }
    if (rule.type === "string" && rule.max && (v as string).length > rule.max) errors.push(`"${key}" too long`);
    if (rule.enum && !rule.enum.includes(v as string)) errors.push(`"${key}" not in ${rule.enum.join("|")}`);
    if (rule.type === "number" && !Number.isFinite(v as number)) errors.push(`"${key}" not finite`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, args: input };
}

export type GatewayDeps = { intents: ActionIntentRepository; services: GatewayReadServices; now?: () => Date };

export class ToolGateway {
  readonly calls: ToolCallRecord[] = [];
  constructor(private readonly deps: GatewayDeps, private readonly allowedBySpecialist: Record<string, readonly string[]>) {}

  toolsFor(specialistKey: string): ToolDefinition[] {
    const allowed = this.allowedBySpecialist[specialistKey] ?? [];
    return TOOL_DEFINITIONS.filter((t) => allowed.includes(t.name));
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const result = await this.run(request);
    this.calls.push({ toolName: request.toolName, ok: result.ok, code: result.ok ? undefined : result.code, intentId: result.ok && result.kind === "proposal" ? result.intentId : undefined, at: (this.deps.now?.() ?? new Date()).toISOString() });
    return result;
  }

  private async run(request: ToolRequest): Promise<ToolResult> {
    const def = definitionFor(request.toolName);
    if (!def) return { ok: false, code: "unknown_tool", error: `Tool "${request.toolName}" is not registered.` };
    const allowed = this.allowedBySpecialist[request.specialistKey] ?? [];
    if (!allowed.includes(def.name)) return { ok: false, code: "not_allowed_for_specialist", error: `Tool "${def.name}" is not allowed for ${request.specialistKey}.` };
    const parsed = validateArgs(def, request.args);
    if (!parsed.ok) return { ok: false, code: "invalid_args", error: parsed.errors.join("; ") };
    // Any free-text argument carrying instruction-like content is refused (Phase 15).
    for (const [k, v] of Object.entries(parsed.args)) {
      if (typeof v === "string" && scanUntrustedText(v).instructionLike) return { ok: false, code: "untrusted_instruction", error: `Argument "${k}" contains instruction-like text and was refused.` };
    }
    if (def.kind === "read") {
      try {
        const data = await (this.deps.services as unknown as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>)[def.name](parsed.args);
        return { ok: true, kind: "read", data };
      } catch (error: any) {
        return { ok: false, code: "service_error", error: String(error?.message || error).slice(0, 300) };
      }
    }
    const actionType = def.actionType!;
    const perm = permissionFor(request.agentId, actionType);
    if (perm === "DENIED") return { ok: false, code: "permission_denied", error: `${request.agentId} may not ${actionType} (DENIED by the permission matrix).` };
    const entityId = String(parsed.args.jobId ?? parsed.args.leadId ?? parsed.args.entityId ?? parsed.args.materialName ?? "unknown");
    const entityType = parsed.args.jobId ? "job" : parsed.args.leadId ? "lead" : parsed.args.materialName ? "material" : "entity";
    const now = this.deps.now?.() ?? new Date();
    const proposed = await proposeIntent(this.deps.intents, {
      actionType, agentId: request.agentId, entityType, entityId,
      payload: Object.fromEntries(Object.entries(parsed.args).filter(([k]) => k !== "reason")),
      reason: String(parsed.args.reason ?? parsed.args.summary ?? "model proposal"),
      idempotencyKey: `model:${request.requestId}:${def.name}:${entityId}:${String(parsed.args.targetStatus ?? "")}`,
      actor: { type: "model", id: request.agentId, source: request.provider ?? "reasoning" },
      provider: request.provider ?? null, model: request.model ?? null, now,
    });
    if (!proposed.ok) return { ok: false, code: "service_error", error: proposed.reason };
    if (!proposed.duplicate) await validateIntent(this.deps.intents, proposed.intent.id, { type: "system", id: "tool_gateway" }, now);
    const intent = (await this.deps.intents.getById(proposed.intent.id)) as ActionIntent;
    return { ok: true, kind: "proposal", intentId: intent.id, status: intent.status, autonomyLevel: intent.autonomyLevel, requiresApproval: intent.status === "AWAITING_APPROVAL", duplicate: proposed.duplicate };
  }
}
