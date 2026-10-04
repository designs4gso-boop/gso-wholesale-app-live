// GSO Slack integration — minimal Socket Mode client on Node's global
// WebSocket (Node 22+). No SDK dependency.
//
// Lifecycle: apps.connections.open (app-level token) -> wss URL (never
// logged) -> "hello" -> envelopes. Every envelope is ACKed immediately with
// its envelope_id, de-duplicated, then dispatched to the handler. Only two
// envelope types are dispatched: events_api (app_mention / message) and
// interactive (block_actions). Nothing in the payload text is executed.
//
// Socket Mode requires a long-running process. The ERP web service on Render
// is request-driven, so a Socket Mode listener is a SEPARATE worker — a
// deployment requirement recorded in docs/GSO_AGENT_DEPLOYMENT_PLAN.md. This
// module is used tonight only for a short local verification run.

import { SlackEventDeduper, eventDedupKey, interactionDedupKey } from "./slack-security.server";
import type { SlackClient } from "./slack-client.server";

export type SocketEnvelope = { envelope_id?: string; type?: string; payload?: any; accepts_response_payload?: boolean; retry_attempt?: number; retry_reason?: string };

export type SocketHandlers = {
  onHello?: (info: { connectionCount: number }) => void;
  onEvent?: (event: any, envelope: SocketEnvelope) => void | Promise<void>;
  onInteraction?: (payload: any, envelope: SocketEnvelope) => void | Promise<void>;
  onDisconnect?: (reason: string) => void;
  onDuplicate?: (key: string) => void;
};

export type SocketSession = { close: () => void; readonly connected: () => boolean };

export async function openSocketMode(client: SlackClient, handlers: SocketHandlers, options: { deduper?: SlackEventDeduper; timeoutMs?: number } = {}): Promise<{ ok: true; session: SocketSession } | { ok: false; error: string }> {
  const opened = await client.connectionsOpen();
  if (!opened.ok) return { ok: false, error: `apps.connections.open failed: ${opened.error}` };
  const WS = (globalThis as any).WebSocket;
  if (typeof WS !== "function") return { ok: false, error: "Global WebSocket is not available in this runtime (Node 22+ required)." };
  const deduper = options.deduper ?? new SlackEventDeduper();
  let connected = false;
  let ws: any;
  try {
    ws = new WS(opened.data.url);
  } catch (error: any) {
    return { ok: false, error: `WebSocket construction failed: ${String(error?.message || error)}` };
  }

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket Mode hello timeout")), options.timeoutMs ?? 15000);
    ws.addEventListener("open", () => { connected = true; });
    ws.addEventListener("message", async (msg: any) => {
      let data: SocketEnvelope;
      try { data = JSON.parse(String(msg.data)); } catch { return; }
      if (data.type === "hello") { clearTimeout(timer); handlers.onHello?.({ connectionCount: Number((data as any).num_connections || 1) }); resolve(); return; }
      if (data.type === "disconnect") { handlers.onDisconnect?.(String((data as any).reason || "disconnect")); return; }
      if (data.envelope_id) ws.send(JSON.stringify({ envelope_id: data.envelope_id })); // ACK first, always
      const key = data.type === "interactive" ? interactionDedupKey(data.payload) ?? `env:${data.envelope_id}` : eventDedupKey(data.payload) ?? `env:${data.envelope_id}`;
      if (!deduper.first(key)) { handlers.onDuplicate?.(key); return; }
      if (data.type === "events_api") await handlers.onEvent?.(data.payload?.event, data);
      else if (data.type === "interactive") await handlers.onInteraction?.(data.payload, data);
    });
    ws.addEventListener("close", () => { connected = false; handlers.onDisconnect?.("closed"); });
    ws.addEventListener("error", (e: any) => { clearTimeout(timer); reject(new Error(`WebSocket error: ${String(e?.message || "unknown")}`)); });
  });

  try {
    await ready;
  } catch (error: any) {
    try { ws.close(); } catch { /* ignore */ }
    return { ok: false, error: String(error?.message || error) };
  }
  return { ok: true, session: { close: () => { try { ws.close(); } catch { /* ignore */ } }, connected: () => connected } };
}
