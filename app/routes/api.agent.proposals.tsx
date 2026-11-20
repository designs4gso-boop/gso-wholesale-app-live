// 2026-11-20 — signed endpoint for AGENT PROPOSALS.
//
//   outside agent -> POST /api/agent/proposals (signed) -> approval queue
//     -> a person approves or rejects in Sales -> Approvals
//
// An agent can PROPOSE: a draft outreach message, a follow-up, a lead
// assignment, a quote, a reorder. It cannot send, post, order or charge: this
// endpoint only ever writes an approval proposal (and its submission log), and
// nothing downstream of an approval reaches outside the ERP.
//
// Security (same model as /api/agent/intake, stricter scope):
//   * Bearer tokenId.tokenSecret + timestamp + HMAC-SHA256 signature of
//     "<timestamp>.<rawBody>"; auth-failure brake; per-credential rate limit.
//   * The credential must carry the explicit scope "proposal:create". A legacy
//     or intake-only credential is refused — the scope is never implied.
//   * The tenant is the credential's shop. Nothing in the body can change it.
//   * The agent key must be an agent the registry allows to propose that
//     action (ops/agent-registry.ts). Every proposal needs a person.
//   * Idempotent on shop + idempotencyKey: a replay returns the same proposal.

import crypto from "node:crypto";

import db from "../db.server";
import { isApprovalAction, submitApproval } from "../lib/agent-approvals.server";
import {
  AGENT_AUTH_FAILURE_BRAKE_LIMIT, AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES, AGENT_PROPOSAL_ENTITY_TYPES, AGENT_RATE_LIMIT_BURST_PER_MINUTE, AGENT_RATE_LIMIT_PER_HOUR,
  credentialAllowsProposals, parseAgentBearer, parseAgentTimestamp, sha256Hex, timingSafeEqualString, verifyAgentSignature,
} from "../lib/agent-security.server";
import { agentMayPropose } from "../lib/ops/agent-registry";
import { PrismaActionIntentRepository } from "../lib/ops/prisma-repositories.server";

const MAX_BODY_BYTES = 16 * 1024;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const clean = (value: unknown, max: number) => (typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "");

async function log(data: Record<string, unknown>) {
  try {
    await db.agentSubmissionLog.create({ data: { sourceChannel: "agent_proposal", ...data } as any });
  } catch {
    // the submission log is best effort; it never decides the outcome
  }
}

export async function loader() {
  return json({ ok: false, error: "POST required." }, 405);
}

export async function action({ request }: { request: Request }) {
  const requestId = crypto.randomUUID();
  if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "POST required." }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) return json({ ok: false, error: "JSON required." }, 415);
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ ok: false, error: "Request body too large." }, 413);
  const payloadHash = sha256Hex(rawBody);
  const base = { requestId, payloadHash };

  const bearer = parseAgentBearer(request.headers.get("authorization"));
  const timestamp = request.headers.get("x-gso-agent-timestamp") || "";
  const signature = request.headers.get("x-gso-agent-signature") || "";
  if (!bearer || !timestamp || !signature) {
    await log({ ...base, status: "rejected_auth", outcome: "Missing agent authentication headers.", errorCode: "missing_auth" });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }
  const brakeStart = new Date(Date.now() - AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES * 60 * 1000);
  if ((await db.agentSubmissionLog.count({ where: { status: "rejected_auth", createdAt: { gte: brakeStart } } })) >= AGENT_AUTH_FAILURE_BRAKE_LIMIT) return json({ ok: false, error: "Too many requests." }, 429);

  const credentials = await db.agentApiCredential.findMany({ where: { tokenId: bearer.tokenId, isActive: true }, take: 2 });
  if (credentials.length !== 1) {
    await log({ ...base, status: "rejected_auth", outcome: credentials.length ? "Ambiguous token id." : "Invalid or inactive agent credential.", errorCode: credentials.length ? "ambiguous_token_id" : "invalid_credential" });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }
  const credential: any = credentials[0];
  const who = { ...base, shop: credential.shop, credentialId: credential.id, agentId: credential.agentId, agentName: credential.agentName };
  const refuse = async (status: number, error: string, errorCode: string, outcome: string, logStatus = "rejected_auth") => {
    await log({ ...who, status: logStatus, outcome, errorCode });
    return json({ ok: false, error }, status);
  };
  if (credential.revokedAt) return refuse(403, "Credential disabled.", "credential_revoked", "Credential revoked.");
  if (!timingSafeEqualString(sha256Hex(bearer.tokenSecret), credential.tokenHash)) return refuse(401, "Invalid agent authentication.", "invalid_secret", "Credential secret did not match.");
  if (!parseAgentTimestamp(timestamp)) return refuse(401, "Invalid agent authentication.", "invalid_timestamp", "Missing or stale timestamp.");
  if (!verifyAgentSignature(bearer.tokenSecret, timestamp, rawBody, signature)) return refuse(401, "Invalid agent authentication.", "invalid_signature", "Invalid request signature.");
  if (!credentialAllowsProposals(credential.scopes)) return refuse(403, "Credential not permitted to submit proposals.", "missing_proposal_scope", "Credential does not have the proposal:create scope.");

  const [hourCount, minuteCount] = await Promise.all([
    db.agentSubmissionLog.count({ where: { credentialId: credential.id, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } }),
    db.agentSubmissionLog.count({ where: { credentialId: credential.id, createdAt: { gte: new Date(Date.now() - 60 * 1000) } } }),
  ]);
  if (hourCount >= AGENT_RATE_LIMIT_PER_HOUR || minuteCount >= AGENT_RATE_LIMIT_BURST_PER_MINUTE) return refuse(429, "Rate limit reached. Try again later.", "rate_limited", "Rate limit reached.", "rejected_rate_limit");

  let body: any;
  try { body = JSON.parse(rawBody); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(400, "Invalid JSON body.", "invalid_json", "Invalid JSON body.", "rejected_validation");

  const actionType = clean(body.actionType, 60);
  const agentKey = clean(body.agentKey, 60);
  const idempotencyKey = clean(body.idempotencyKey, 120);
  const reason = clean(body.reason, 500);
  const entityType = clean(body.entityType, 40) || "none";
  const entityId = clean(body.entityId, 120) || "none";
  const proposed = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
  const problems: string[] = [];
  if (!isApprovalAction(actionType)) problems.push("actionType is not a proposal type");
  if (!idempotencyKey || idempotencyKey.length < 8) problems.push("idempotencyKey (8+ characters) is required");
  if (!reason) problems.push("reason is required");
  if (!(AGENT_PROPOSAL_ENTITY_TYPES as readonly string[]).includes(entityType)) problems.push("entityType is not supported");
  if (problems.length) return refuse(422, `Invalid proposal: ${problems.join("; ")}.`, "invalid_proposal", problems.join("; "), "rejected_validation");
  if (!agentMayPropose(agentKey, actionType)) return refuse(403, "This agent may not propose that action.", "agent_not_permitted", `Agent "${agentKey}" may not propose ${actionType}.`, "rejected_validation");

  // The subject must exist in the credential's own shop. Another shop's record is simply "not found".
  if (entityType !== "none") {
    const model = entityType === "crm_lead" ? db.crmLead : entityType === "crm_account" ? db.crmAccount : entityType === "quote" ? db.quote : db.productionJobItem;
    const subject = await (model as any).findFirst({ where: { shop: credential.shop, id: entityId }, select: { id: true } });
    if (!subject) return refuse(422, "The subject of this proposal was not found.", "entity_not_found", `${entityType} not found in this shop.`, "rejected_validation");
  }

  const result = await submitApproval(new PrismaActionIntentRepository(), {
    shop: credential.shop,
    actionType,
    agentId: agentKey,
    entityType,
    entityId,
    payload: proposed,
    reason,
    idempotencyKey: `agent:${credential.id}:${idempotencyKey}`,
    proposedBy: { type: "agent", id: credential.agentId, name: credential.agentName, source: `api:agent-proposals:${credential.id}` },
  });
  if (!result.ok) return refuse(422, result.message, "invalid_proposal", result.message, "rejected_validation");
  await log({ ...who, idempotencyKey, status: result.duplicate ? "duplicate" : "accepted", outcome: `Proposal ${result.intent.id} (${actionType}) ${result.duplicate ? "already recorded" : "sent for approval"}.` });
  try { await db.agentApiCredential.update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } }); } catch { /* best effort */ }
  return json({
    ok: true,
    proposalId: result.intent.id,
    duplicate: result.duplicate,
    status: result.intent.status === "AWAITING_APPROVAL" ? "awaiting_approval" : String(result.intent.status).toLowerCase(),
    approvalRequired: true,
    createdAt: result.intent.createdAt,
    note: "A person reviews this in the ERP. Nothing is sent, ordered or charged by this endpoint.",
  }, result.duplicate ? 200 : 201);
}
