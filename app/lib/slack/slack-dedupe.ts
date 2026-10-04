// Client-safe de-duplication keys shared by the HTTP route, Socket Mode and
// the interaction handler (OPS-2 split out of slack-security.server.ts so the
// pure interaction module has no node:crypto import).

/** Stable key for an Events API delivery. */
export function eventDedupKey(body: any): string | null {
  const id = body?.event_id || body?.envelope_id;
  return id ? `event:${id}` : null;
}

/** Stable key for a block-action click: same user, same message, same action, same intent. */
export function interactionDedupKey(payload: any): string | null {
  const action = payload?.actions?.[0];
  if (!action) return null;
  return `interaction:${payload?.user?.id ?? "?"}:${payload?.container?.message_ts ?? payload?.message?.ts ?? "?"}:${action.action_id}:${action.value ?? ""}`;
}
