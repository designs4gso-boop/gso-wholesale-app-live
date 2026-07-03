import crypto from "node:crypto";

import db from "../db.server";
import { productFamilySalesRuleFor } from "../lib/product-family-sales-rules";

const PHASE = "7E";
const MAX_BODY_BYTES = 32 * 1024;
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

type IntakePayload = Record<string, unknown>;

type SafePayload = {
  sourceAgentId: string;
  sourceAgentName: string;
  sourceChannel: string;
  sourceMessageId: string;
  externalLeadId: string;
  idempotencyKey: string;
  customerName: string;
  brandName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  productFamily: string;
  quantity: string;
  dimensionsOrSize: string;
  materialOrSubstrate: string;
  finish: string;
  deadline: string;
  budgetRange: string;
  artworkProvided: boolean | null;
  mockupNeeded: boolean | null;
  customerNotes: string;
  internalAgentNotes: string;
  conversationSummary: string;
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualString(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value).trim().slice(0, maxLength);
}

function boolValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(text)) return true;
    if (["false", "no", "0", "off"].includes(text)) return false;
  }
  return null;
}

function positiveQuantity(value: string) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000000;
}

function requestIpHash(request: Request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "";
  return ip ? sha256Hex(ip) : null;
}

function userAgentHash(request: Request) {
  const value = request.headers.get("user-agent") || "";
  return value ? sha256Hex(value) : null;
}

function parseBearer(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const value = match[1].trim();
  const dotIndex = value.indexOf(".");
  if (dotIndex <= 0 || dotIndex === value.length - 1) return null;
  return {
    tokenId: value.slice(0, dotIndex),
    tokenSecret: value.slice(dotIndex + 1),
  };
}

function parseTimestamp(value: string) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.abs(Date.now() - timestamp) <= TIMESTAMP_TOLERANCE_MS ? timestamp : null;
}

function verifySignature(tokenSecret: string, timestamp: string, rawBody: string, signature: string) {
  const expected = crypto
    .createHmac("sha256", tokenSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return timingSafeEqualString(expected.toLowerCase(), signature.trim().toLowerCase());
}

function safeSummary(input: {
  sourceChannel?: string | null;
  externalLeadId?: string | null;
  idempotencyKey?: string | null;
  productFamily?: string | null;
  normalizedFamily?: string | null;
  hasContact?: boolean;
  missingFields?: string[];
  escalationReasons?: string[];
}) {
  return {
    phase: PHASE,
    sourceChannel: input.sourceChannel || null,
    externalLeadId: input.externalLeadId || null,
    idempotencyKey: input.idempotencyKey || null,
    productFamily: input.productFamily || null,
    normalizedFamily: input.normalizedFamily || null,
    hasContact: Boolean(input.hasContact),
    missingFields: input.missingFields || [],
    escalationReasons: input.escalationReasons || [],
  };
}

async function logSubmission(data: {
  shop?: string | null;
  credentialId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  sourceChannel?: string | null;
  externalLeadId?: string | null;
  idempotencyKey?: string | null;
  requestId: string;
  status: string;
  outcome?: string | null;
  queueItemId?: string | null;
  errorCode?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  payloadHash?: string | null;
  safeSummary?: unknown;
}) {
  await db.agentSubmissionLog.create({
    data: {
      shop: data.shop || null,
      credentialId: data.credentialId || null,
      agentId: data.agentId || null,
      agentName: data.agentName || null,
      sourceChannel: data.sourceChannel || null,
      externalLeadId: data.externalLeadId || null,
      idempotencyKey: data.idempotencyKey || null,
      requestId: data.requestId,
      status: data.status,
      outcome: data.outcome || null,
      queueItemId: data.queueItemId || null,
      errorCode: data.errorCode || null,
      ipHash: data.ipHash || null,
      userAgentHash: data.userAgentHash || null,
      payloadHash: data.payloadHash || null,
      safeSummary: data.safeSummary || null,
    },
  });
}

function sanitizePayload(payload: IntakePayload): SafePayload {
  return {
    sourceAgentId: cleanText(payload.sourceAgentId, 120),
    sourceAgentName: cleanText(payload.sourceAgentName, 120),
    sourceChannel: cleanText(payload.sourceChannel, 120),
    sourceMessageId: cleanText(payload.sourceMessageId, 120),
    externalLeadId: cleanText(payload.externalLeadId, 120),
    idempotencyKey: cleanText(payload.idempotencyKey, 120),
    customerName: cleanText(payload.customerName, 200),
    brandName: cleanText(payload.brandName, 200),
    contactName: cleanText(payload.contactName, 200),
    contactEmail: cleanText(payload.contactEmail, 200),
    contactPhone: cleanText(payload.contactPhone, 200),
    productFamily: cleanText(payload.productFamily, 120),
    quantity: cleanText(payload.quantity, 120),
    dimensionsOrSize: cleanText(payload.dimensionsOrSize, 300),
    materialOrSubstrate: cleanText(payload.materialOrSubstrate, 300),
    finish: cleanText(payload.finish, 300),
    deadline: cleanText(payload.deadline, 300),
    budgetRange: cleanText(payload.budgetRange, 300),
    artworkProvided: boolValue(payload.artworkProvided),
    mockupNeeded: boolValue(payload.mockupNeeded),
    customerNotes: cleanText(payload.customerNotes, 1500),
    internalAgentNotes: cleanText(payload.internalAgentNotes, 1500),
    conversationSummary: cleanText(payload.conversationSummary, 1500),
  };
}

function normalizeFamily(input: string) {
  const text = input.toLowerCase();
  if (text.includes("jar")) return "jars";
  if (text.includes("banner")) return "banners";
  if (text.includes("label") || text.includes("sticker") || text.includes("die cut") || text.includes("die-cut")) {
    return "labels-stickers";
  }
  if (text.includes("custom") || text.includes("other")) return "custom-other";
  return "custom-other";
}

function validatePayload(payload: SafePayload) {
  const missingFields: string[] = [];
  const escalationReasons: string[] = [];

  if (!payload.productFamily) missingFields.push("productFamily");
  if (!payload.quantity) missingFields.push("quantity");
  if (payload.quantity && !positiveQuantity(payload.quantity)) missingFields.push("validQuantity");

  const hasContact = Boolean(
    payload.customerName ||
      payload.brandName ||
      payload.contactName ||
      payload.contactEmail ||
      payload.contactPhone,
  );
  if (!hasContact) missingFields.push("customerIdentifier");

  const normalizedFamily = normalizeFamily(payload.productFamily);
  if (normalizedFamily === "custom-other" && !["custom", "other"].some((term) => payload.productFamily.toLowerCase().includes(term))) {
    escalationReasons.push("Unsupported or ambiguous product family mapped to custom/other.");
  }

  const rule = productFamilySalesRuleFor(normalizedFamily);
  if (rule.manualReviewRequired) escalationReasons.push("Product family requires staff review.");

  return {
    valid: missingFields.length === 0,
    hasContact,
    missingFields,
    escalationReasons,
    normalizedFamily,
    productFamilyRuleKey: rule.key,
    productFamilyLabel: rule.label,
    reviewLevel: normalizedFamily === "custom-other" ? "manual_pricing_required" : "basic_staff_review",
  };
}

function buildNormalizedDraft(payload: SafePayload, validation: ReturnType<typeof validatePayload>, credential: any, requestId: string) {
  const contact = {
    customerName: payload.customerName || payload.contactName || "",
    company: payload.brandName || "",
    email: payload.contactEmail || "",
    phone: payload.contactPhone || "",
    preferredContactMethod: "",
  };

  const productRequest = {
    productFamily: validation.productFamilyLabel,
    productFamilyKey: validation.normalizedFamily,
    productType: "",
    quantity: payload.quantity,
    dimensionsOrSize: payload.dimensionsOrSize,
    materialOrSubstrate: payload.materialOrSubstrate,
    finish: payload.finish,
    deadline: payload.deadline,
    budgetRange: payload.budgetRange,
    artworkProvided: payload.artworkProvided,
    mockupNeeded: payload.mockupNeeded,
    sourceMessageId: payload.sourceMessageId,
  };

  return {
    phase: PHASE,
    requestId,
    source: credential.sourceType || "sales_agent",
    sourceChannel: payload.sourceChannel || credential.sourceChannel || null,
    sourceAgentId: payload.sourceAgentId || credential.agentId,
    sourceAgentName: payload.sourceAgentName || credential.agentName,
    externalLeadId: payload.externalLeadId || null,
    idempotencyKey: payload.idempotencyKey || null,
    status: "needs_staff_review",
    reviewLevel: validation.reviewLevel,
    contact,
    productRequest,
    customerSafeSummary: payload.customerNotes || payload.conversationSummary || "",
    customerSafeDraftReply: "",
    internalNotes: payload.internalAgentNotes || payload.conversationSummary || "",
    recommendedStaffAction: "Review intake details",
    missingFields: validation.missingFields,
    escalationReasons: validation.escalationReasons,
    createdBy: "agent",
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };
}

async function findDuplicate(shop: string, payload: SafePayload) {
  if (payload.idempotencyKey) {
    const existing = await db.agentSubmissionLog.findFirst({
      where: {
        shop,
        idempotencyKey: payload.idempotencyKey,
        status: { in: ["accepted", "duplicate"] },
        queueItemId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { queueItemId: true },
    });
    if (existing?.queueItemId) return existing.queueItemId;
  }

  if (payload.externalLeadId && payload.sourceChannel) {
    const existing = await db.agentSubmissionLog.findFirst({
      where: {
        shop,
        sourceChannel: payload.sourceChannel,
        externalLeadId: payload.externalLeadId,
        status: { in: ["accepted", "duplicate"] },
        queueItemId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { queueItemId: true },
    });
    if (existing?.queueItemId) return existing.queueItemId;
  }

  return null;
}

export async function loader() {
  return json({ ok: false, error: "POST required." }, 405);
}

export async function action({ request }: { request: Request }) {
  const requestId = crypto.randomUUID();
  const ipHash = requestIpHash(request);
  const userAgent = userAgentHash(request);

  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "POST required." }, 405);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ ok: false, error: "JSON required." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request body too large." }, 413);
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request body too large." }, 413);
  }
  const payloadHash = sha256Hex(rawBody);

  const bearer = parseBearer(request);
  const timestamp = request.headers.get("x-gso-agent-timestamp") || "";
  const signature = request.headers.get("x-gso-agent-signature") || "";

  if (!bearer || !timestamp || !signature) {
    await logSubmission({
      requestId,
      status: "rejected_auth",
      outcome: "Missing agent authentication headers.",
      errorCode: "missing_auth",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }

  const credential = await db.agentApiCredential.findFirst({
    where: { tokenId: bearer.tokenId, isActive: true },
  });

  if (!credential) {
    await logSubmission({
      requestId,
      status: "rejected_auth",
      outcome: "Invalid or inactive agent credential.",
      errorCode: "invalid_credential",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }

  if (credential.revokedAt) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      requestId,
      status: "rejected_auth",
      outcome: "Credential revoked.",
      errorCode: "credential_revoked",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Credential disabled." }, 403);
  }

  if (!timingSafeEqualString(sha256Hex(bearer.tokenSecret), credential.tokenHash)) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      requestId,
      status: "rejected_auth",
      outcome: "Credential secret did not match.",
      errorCode: "invalid_secret",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }

  if (!parseTimestamp(timestamp)) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      requestId,
      status: "rejected_auth",
      outcome: "Missing or stale timestamp.",
      errorCode: "invalid_timestamp",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }

  if (!verifySignature(bearer.tokenSecret, timestamp, rawBody, signature)) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      requestId,
      status: "rejected_auth",
      outcome: "Invalid request signature.",
      errorCode: "invalid_signature",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid agent authentication." }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      requestId,
      status: "rejected_validation",
      outcome: "Invalid JSON body.",
      errorCode: "invalid_json",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      sourceChannel: credential.sourceChannel,
      requestId,
      status: "rejected_validation",
      outcome: "JSON object required.",
      errorCode: "json_object_required",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: safeSummary({}),
    });

    return json({ ok: false, error: "JSON object required." }, 400);
  }

  const payload = sanitizePayload(parsed as IntakePayload);
  const validation = validatePayload(payload);
  const summary = safeSummary({
    sourceChannel: payload.sourceChannel || credential.sourceChannel,
    externalLeadId: payload.externalLeadId,
    idempotencyKey: payload.idempotencyKey,
    productFamily: payload.productFamily,
    normalizedFamily: validation.normalizedFamily,
    hasContact: validation.hasContact,
    missingFields: validation.missingFields,
    escalationReasons: validation.escalationReasons,
  });

  if (!validation.valid) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      sourceChannel: payload.sourceChannel || credential.sourceChannel,
      externalLeadId: payload.externalLeadId,
      idempotencyKey: payload.idempotencyKey,
      requestId,
      status: "rejected_validation",
      outcome: "Required intake fields missing.",
      errorCode: "missing_required_fields",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: summary,
    });
    return json({ ok: false, error: "Required intake fields missing.", missingFields: validation.missingFields }, 400);
  }

  const duplicateQueueItemId = await findDuplicate(credential.shop, payload);
  if (duplicateQueueItemId) {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      sourceChannel: payload.sourceChannel || credential.sourceChannel,
      externalLeadId: payload.externalLeadId,
      idempotencyKey: payload.idempotencyKey,
      requestId,
      status: "duplicate",
      outcome: "Duplicate agent intake submission.",
      queueItemId: duplicateQueueItemId,
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: summary,
    });
    return json({ ok: true, duplicate: true, queueItemId: duplicateQueueItemId }, 200);
  }

  try {
    const normalizedDraft = buildNormalizedDraft(payload, validation, credential, requestId);
    const queueItem = await db.$transaction(async (tx) => {
      const item = await tx.agentReviewQueueItem.create({
        data: {
          shop: credential.shop,
          source: credential.sourceType || "sales_agent",
          status: "needs_staff_review",
          reviewLevel: validation.reviewLevel,
          customerName: payload.customerName || payload.contactName || null,
          company: payload.brandName || null,
          email: payload.contactEmail || null,
          phone: payload.contactPhone || null,
          preferredContactMethod: null,
          productFamily: validation.productFamilyLabel,
          productType: null,
          quantity: payload.quantity,
          dimensionsOrSize: payload.dimensionsOrSize || null,
          materialOrSubstrate: payload.materialOrSubstrate || null,
          finish: payload.finish || null,
          deadline: payload.deadline || null,
          shippingCityState: null,
          contact: normalizedDraft.contact,
          productRequest: normalizedDraft.productRequest,
          missingFields: validation.missingFields,
          escalationReasons: validation.escalationReasons,
          customerSafeSummary: normalizedDraft.customerSafeSummary || null,
          customerSafeDraftReply: null,
          internalNotes: normalizedDraft.internalNotes || null,
          recommendedStaffAction: "Review intake details",
          originalAgentDraftSnapshot: normalizedDraft,
          normalizedDraft,
          staffEditedDraft: null,
          createdBy: "agent",
          requiresStaffApproval: true,
          canBecomeRealQuoteAutomatically: false,
        },
      });

      await tx.agentReviewQueueEvent.create({
        data: {
          shop: credential.shop,
          queueItemId: item.id,
          eventType: "agent_submitted_lead",
          actorType: "agent",
          actorId: credential.agentId,
          actorName: credential.agentName,
          actorEmail: credential.agentEmail || null,
          message: "Agent submitted lead for staff review.",
          afterSnapshot: normalizedDraft,
          metadata: {
            phase: PHASE,
            sourceChannel: payload.sourceChannel || credential.sourceChannel || null,
            externalLeadId: payload.externalLeadId || null,
            idempotencyKey: payload.idempotencyKey || null,
            requestId,
            normalizedFamily: validation.normalizedFamily,
            productFamilyRuleKey: validation.productFamilyRuleKey,
          },
        },
      });

      await tx.agentSubmissionLog.create({
        data: {
          shop: credential.shop,
          credentialId: credential.id,
          agentId: credential.agentId,
          agentName: credential.agentName,
          sourceChannel: payload.sourceChannel || credential.sourceChannel || null,
          externalLeadId: payload.externalLeadId || null,
          idempotencyKey: payload.idempotencyKey || null,
          requestId,
          status: "accepted",
          outcome: "Agent intake accepted for staff review.",
          queueItemId: item.id,
          ipHash,
          userAgentHash: userAgent,
          payloadHash,
          safeSummary: summary,
        },
      });

      await tx.agentApiCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date(), lastUsedIpHash: ipHash },
      });

      return item;
    });

    return json(
      {
        ok: true,
        queueItemId: queueItem.id,
        status: "needs_staff_review",
        requiresStaffApproval: true,
      },
      201,
    );
  } catch {
    await logSubmission({
      shop: credential.shop,
      credentialId: credential.id,
      agentId: credential.agentId,
      agentName: credential.agentName,
      sourceChannel: payload.sourceChannel || credential.sourceChannel,
      externalLeadId: payload.externalLeadId,
      idempotencyKey: payload.idempotencyKey,
      requestId,
      status: "error",
      outcome: "Agent intake endpoint failed.",
      errorCode: "internal_error",
      ipHash,
      userAgentHash: userAgent,
      payloadHash,
      safeSummary: summary,
    }).catch(() => undefined);
    return json({ ok: false, error: "Agent intake failed." }, 500);
  }
}
