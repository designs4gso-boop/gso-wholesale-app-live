// GSO Slack integration — configuration model. Client-safe (no secrets here).
//
// Logical destinations are mapped to channels through ENVIRONMENT, never
// hardcoded channel IDs. Tonight ONLY the sandbox destination may be live;
// every other destination resolves to the sandbox when SLACK_SANDBOX_ONLY is
// not explicitly "false", so a misconfiguration can never post to a real
// staff channel by accident.

export const SLACK_INTEGRATION_VERSION = "slack-integration/1.0.0-2026-10-03";

export type SlackDestination =
  | "sandbox"
  | "sales_leads"
  | "sales_quotes"
  | "art_approval"
  | "production"
  | "production_exceptions"
  | "purchasing"
  | "shipping"
  | "finance"
  | "agent_approvals"
  | "management_reports";

export const SLACK_DESTINATIONS: SlackDestination[] = [
  "sandbox", "sales_leads", "sales_quotes", "art_approval", "production", "production_exceptions",
  "purchasing", "shipping", "finance", "agent_approvals", "management_reports",
];

/** Env var that carries each destination's channel (ID or #name). */
export const SLACK_DESTINATION_ENV: Record<SlackDestination, string> = {
  sandbox: "SLACK_TEST_CHANNEL",
  sales_leads: "SLACK_CHANNEL_SALES_LEADS",
  sales_quotes: "SLACK_CHANNEL_SALES_QUOTES",
  art_approval: "SLACK_CHANNEL_ART_APPROVAL",
  production: "SLACK_CHANNEL_PRODUCTION",
  production_exceptions: "SLACK_CHANNEL_PRODUCTION_EXCEPTIONS",
  purchasing: "SLACK_CHANNEL_PURCHASING",
  shipping: "SLACK_CHANNEL_SHIPPING",
  finance: "SLACK_CHANNEL_FINANCE",
  agent_approvals: "SLACK_CHANNEL_AGENT_APPROVALS",
  management_reports: "SLACK_CHANNEL_MANAGEMENT_REPORTS",
};

/** Secret / config variable NAMES (values live outside the repo). */
export const SLACK_ENV_VARS = {
  botToken: "SLACK_BOT_TOKEN",
  appToken: "SLACK_APP_TOKEN",
  signingSecret: "SLACK_SIGNING_SECRET",
  testChannel: "SLACK_TEST_CHANNEL",
  socketMode: "SLACK_SOCKET_MODE",
  sandboxOnly: "SLACK_SANDBOX_ONLY",
  staffMap: "SLACK_STAFF_MAP", // JSON: { "U123": { "staffId": "...", "name": "...", "role": "owner|staff" } }
} as const;

export type SlackEnv = Record<string, string | undefined>;

export type SlackDestinationResolution = {
  destination: SlackDestination;
  channel: string | null;
  sandboxRedirected: boolean;
  reason: string;
};

/**
 * Resolve a logical destination to a channel. Sandbox-only mode is the
 * default: any non-sandbox destination posts to the sandbox channel and says
 * so in the message prefix.
 */
export function resolveSlackDestination(env: SlackEnv, destination: SlackDestination): SlackDestinationResolution {
  const sandboxOnly = String(env[SLACK_ENV_VARS.sandboxOnly] ?? "true").trim().toLowerCase() !== "false";
  const sandbox = normalizeChannel(env[SLACK_ENV_VARS.testChannel]);
  if (destination === "sandbox") {
    return { destination, channel: sandbox, sandboxRedirected: false, reason: sandbox ? "sandbox channel" : "SLACK_TEST_CHANNEL missing" };
  }
  if (sandboxOnly) {
    return { destination, channel: sandbox, sandboxRedirected: true, reason: "SLACK_SANDBOX_ONLY in force — redirected to sandbox" };
  }
  const configured = normalizeChannel(env[SLACK_DESTINATION_ENV[destination]]);
  if (!configured) {
    return { destination, channel: sandbox, sandboxRedirected: true, reason: `${SLACK_DESTINATION_ENV[destination]} not configured — redirected to sandbox` };
  }
  return { destination, channel: configured, sandboxRedirected: false, reason: "configured channel" };
}

export function normalizeChannel(value: string | undefined | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^[CG][A-Z0-9]{8,}$/.test(text)) return text; // channel id
  return `#${text.replace(/^#/, "")}`;
}

export type StaffIdentity = { staffId: string; name: string; role: "owner" | "staff" };

/** Parse SLACK_STAFF_MAP (JSON). Unknown users map to null -> role "unknown". */
export function parseStaffMap(raw: string | undefined | null): Record<string, StaffIdentity> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StaffIdentity> = {};
    for (const [slackUserId, entry] of Object.entries(parsed as Record<string, any>)) {
      if (!entry || typeof entry !== "object") continue;
      const role = entry.role === "owner" ? "owner" : "staff";
      out[slackUserId] = { staffId: String(entry.staffId || slackUserId), name: String(entry.name || slackUserId), role };
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveStaffIdentity(map: Record<string, StaffIdentity>, slackUserId: string | undefined | null): (StaffIdentity & { mapped: true }) | { mapped: false; role: "unknown"; slackUserId: string } {
  const id = String(slackUserId ?? "");
  const hit = map[id];
  return hit ? { ...hit, mapped: true } : { mapped: false, role: "unknown", slackUserId: id };
}
