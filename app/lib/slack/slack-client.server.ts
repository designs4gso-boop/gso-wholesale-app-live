// GSO Slack integration — Web API client (fetch, no SDK dependency).
//
// Secrets are loaded from a file OUTSIDE the repo or from process.env and are
// never logged. Posting is idempotent: a message with an idempotency key is
// posted once per process (and the key is returned so a durable store can
// extend that across processes). Only the SANDBOX destination can be live
// while SLACK_SANDBOX_ONLY is not "false" (see slack-config).

import { readFileSync, existsSync } from "node:fs";
import { SLACK_ENV_VARS, normalizeChannel, resolveSlackDestination, type SlackDestination, type SlackEnv } from "./slack-config";
import type { Block } from "./slack-blocks";

export const DEFAULT_SLACK_ENV_FILE = "C:/Users/Desig/.gso-secrets/slack.env";

/** Load KEY=VALUE pairs; values are never logged. Falls back to process.env. */
export function loadSlackEnv(path = process.env.GSO_SLACK_ENV_FILE || DEFAULT_SLACK_ENV_FILE): SlackEnv {
  const env: SlackEnv = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
  }
  for (const key of Object.values(SLACK_ENV_VARS)) if (process.env[key] && !env[key]) env[key] = process.env[key];
  for (const key of Object.keys(process.env)) if (key.startsWith("SLACK_CHANNEL_") && !env[key]) env[key] = process.env[key];
  return env;
}

export type SlackApiResult<T = any> = { ok: true; data: T } | { ok: false; error: string; needed?: string; data?: any };

export class SlackClient {
  private posted = new Map<string, { channel: string; ts: string }>();
  constructor(private readonly env: SlackEnv, private readonly fetchImpl: typeof fetch = fetch) {}

  private token(kind: "bot" | "app"): string {
    const value = this.env[kind === "bot" ? SLACK_ENV_VARS.botToken : SLACK_ENV_VARS.appToken];
    if (!value) throw new Error(`Slack ${kind} token is not configured (${kind === "bot" ? SLACK_ENV_VARS.botToken : SLACK_ENV_VARS.appToken}).`);
    return value;
  }

  async api<T = any>(method: string, body: Record<string, unknown> = {}, tokenKind: "bot" | "app" = "bot"): Promise<SlackApiResult<T>> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${this.token(tokenKind)}` },
      body: JSON.stringify(body),
    });
    const data: any = await res.json();
    if (!data?.ok) return { ok: false, error: String(data?.error || `http_${res.status}`), needed: data?.needed, data };
    return { ok: true, data };
  }

  authTest() { return this.api<{ team: string; team_id: string; user: string; user_id: string; bot_id: string }>("auth.test"); }

  /** Socket Mode handshake check. The URL is returned but callers must never log it. */
  connectionsOpen() { return this.api<{ url: string }>("apps.connections.open", {}, "app"); }

  conversationsInfo(channel: string) { return this.api("conversations.info", { channel }); }

  history(channel: string, limit = 10) { return this.api<{ messages: any[] }>("conversations.history", { channel, limit }); }

  /** Resolve a destination; never returns a non-sandbox channel in sandbox-only mode. */
  destination(destination: SlackDestination) { return resolveSlackDestination(this.env, destination); }

  /**
   * Post once per idempotency key. Returns duplicate=true (and the original
   * ts) on a replay instead of posting again.
   */
  async postBlocks(input: { destination: SlackDestination; text: string; blocks?: Block[]; idempotencyKey?: string; threadTs?: string }) {
    const target = this.destination(input.destination);
    if (!target.channel) return { ok: false as const, error: `No channel for ${input.destination}: ${target.reason}` };
    const key = input.idempotencyKey ? `${target.channel}:${input.idempotencyKey}` : null;
    if (key && this.posted.has(key)) return { ok: true as const, duplicate: true, ...this.posted.get(key)!, sandboxRedirected: target.sandboxRedirected };
    const result = await this.api<{ channel: string; ts: string }>("chat.postMessage", {
      channel: target.channel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      unfurl_links: false,
    });
    if (!result.ok) return { ok: false as const, error: result.error, needed: result.needed };
    const posted = { channel: result.data.channel, ts: result.data.ts };
    if (key) this.posted.set(key, posted);
    return { ok: true as const, duplicate: false, ...posted, sandboxRedirected: target.sandboxRedirected };
  }

  postText(destination: SlackDestination, text: string, idempotencyKey?: string, threadTs?: string) {
    return this.postBlocks({ destination, text, idempotencyKey, threadTs });
  }

  threadReply(channel: string, threadTs: string, text: string, blocks?: Block[]) {
    return this.api<{ ts: string }>("chat.postMessage", { channel: normalizeChannel(channel) ?? channel, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}) });
  }

  /** Replace a message's blocks (e.g. remove buttons after a decision). */
  update(channel: string, ts: string, text: string, blocks?: Block[]) {
    return this.api("chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
  }
}

/** Never log a token; this is what diagnostics may print. */
export function describeSlackEnv(env: SlackEnv) {
  const has = (k: string) => Boolean(env[k]);
  return {
    botToken: has(SLACK_ENV_VARS.botToken) ? "present" : "MISSING",
    appToken: has(SLACK_ENV_VARS.appToken) ? "present" : "MISSING",
    signingSecret: has(SLACK_ENV_VARS.signingSecret) ? "present" : "MISSING",
    testChannel: env[SLACK_ENV_VARS.testChannel] || "MISSING",
    socketMode: env[SLACK_ENV_VARS.socketMode] || "unset",
    sandboxOnly: String(env[SLACK_ENV_VARS.sandboxOnly] ?? "true"),
  };
}
