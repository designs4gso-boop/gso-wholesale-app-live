// GSO Slack integration — request security and event de-duplication.
//
//   * HTTP mode: Slack signs every request (v0 HMAC-SHA256 over
//     "v0:<timestamp>:<rawBody>" with the signing secret). We verify with a
//     timing-safe compare and a 5-minute replay window BEFORE parsing.
//   * Socket Mode: the connection itself is authenticated by the app-level
//     token at apps.connections.open; envelopes still carry event ids we
//     de-duplicate.
//   * Retries: Slack retries deliveries (X-Slack-Retry-Num) and users double
//     click. Every event_id / envelope_id / (action, message_ts, user) tuple is
//     processed once.

import crypto from "node:crypto";

export const SLACK_SIGNATURE_VERSION = "v0";
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  const base = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  return `${SLACK_SIGNATURE_VERSION}=${crypto.createHmac("sha256", signingSecret).update(base, "utf8").digest("hex")}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" | "missing_secret" };

export function verifySlackSignature(input: {
  signingSecret: string | undefined | null;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  rawBody: string;
  now?: Date;
}): SignatureCheck {
  if (!input.signingSecret) return { ok: false, reason: "missing_secret" };
  const ts = String(input.timestamp ?? "").trim();
  const sig = String(input.signature ?? "").trim();
  if (!ts || !sig) return { ok: false, reason: "missing_headers" };
  const tsNum = Number(ts);
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const expected = computeSlackSignature(input.signingSecret, ts, input.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Bounded in-memory de-duplication window (durable store is a deployment requirement). */
export class SlackEventDeduper {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = 15 * 60 * 1000, private readonly max = 5000) {}
  /** Returns true the FIRST time a key is seen; false for any replay. */
  first(key: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
  private sweep(now: number) {
    if (this.seen.size < this.max) return;
    for (const [k, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(k);
  }
}

export { eventDedupKey, interactionDedupKey } from "./slack-dedupe";

export function isSlackRetry(headers: Headers): { retry: boolean; num: number; reason: string | null } {
  const num = Number(headers.get("x-slack-retry-num") || 0);
  return { retry: num > 0, num, reason: headers.get("x-slack-retry-reason") };
}
