// 2026-11-19 — Reorder a past item.
//
// A reorder is a NEW sale: this page only PICKS earlier production items and
// asks the Quotes action (createReorderQuote) to create a DRAFT quote with
// explicit lineage. Pricing is the current pricing engine's for the new
// quantity (or provisional — owner approval required); the earlier selling
// price is never copied. No production job is created here: that happens at
// the normal production-release step. Selling roles only (owner, manager,
// sales — the existing sendQuote permission); no price or cost is sent to
// this page for any role.

import { isRouteErrorResponse, useFetcher, useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { useState, type CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { PERMISSION_DENIED_MESSAGE, resolveStaffAccess } from "../lib/staff-roles.server";
import { REORDER_ARTWORK_MODES, toReorderOption } from "../lib/reorder";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const staff = resolveStaffAccess(auth);
  if (!staff.can("sendQuote")) throw new Response(PERMISSION_DENIED_MESSAGE.sendQuote, { status: 403 });
  const shop = auth.session.shop;
  const q = String(new URL(request.url).searchParams.get("q") || "").trim().slice(0, 80);
  const contains = { contains: q, mode: "insensitive" as const };
  const jobs = await db.productionJob.findMany({
    where: {
      shop,
      status: { not: "cancelled" },
      ...(q ? { OR: [{ customerName: contains }, { company: contains }, { jobTicket: contains }, { items: { some: { productTitle: contains } } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    // identity only — no price, cost or snapshot fields leave the server
    select: {
      id: true, jobTicket: true, customerName: true, company: true, status: true, completedAt: true,
      items: { orderBy: { sortOrder: "asc" }, select: { id: true, itemTicket: true, productTitle: true, quantity: true, selectedFinish: true } },
    },
  });
  const options = jobs.flatMap((job: any) => (job.items || []).map((item: any) => toReorderOption(item, job)));
  return Response.json({ options, q });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, boxSizing: "border-box" };

type Picked = { quantity: string; artworkMode: string };

export default function ReorderPage() {
  const { options, q } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState<string>(q || "");
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const pickedIds = Object.keys(picked);

  const toggle = (itemId: string) => setPicked((current) => {
    const next = { ...current };
    if (next[itemId]) delete next[itemId];
    else next[itemId] = { quantity: "", artworkMode: "same_artwork" };
    return next;
  });
  const update = (itemId: string, change: Partial<Picked>) => setPicked((current) => ({ ...current, [itemId]: { ...current[itemId], ...change } }));
  const submit = () => {
    const lines = pickedIds.map((itemId) => ({ itemId, quantity: picked[itemId].quantity, artworkMode: picked[itemId].artworkMode }));
    fetcher.submit({ intent: "createReorderQuote", lines } as any, { method: "post", action: "/app/quotes", encType: "application/json" });
  };

  return (
    <Page title="Reorder a past item" subtitle="A reorder is a new sale: it makes a new quote, and later a new job with new tickets. The earlier job is not changed." backAction={{ content: "Quotes", onAction: () => navigate("/app/quotes") }}>
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 860 }}>
        {result ? (
          <div role="status" style={{ ...card, borderColor: result.ok ? "#86efac" : "#fca5a5", background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b", display: "grid", gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{result.ok ? result.message : result.error || "The reorder quote could not be created."}</div>
            {result.ok ? <button type="button" onClick={() => navigate("/app/quotes")} style={{ minHeight: 48, borderRadius: 12, border: "1px solid #166534", background: "#166534", color: "white", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Open Quotes</button> : null}
          </div>
        ) : null}

        <form onSubmit={(event) => { event.preventDefault(); const next = new URLSearchParams(params); if (search.trim()) next.set("q", search.trim()); else next.delete("q"); setParams(next); }} style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Customer, job ticket or product" style={{ ...input, flex: "1 1 240px" }} />
          <button type="submit" style={{ ...input, background: "#111827", color: "white", fontWeight: 700, cursor: "pointer" }}>Search</button>
        </form>

        <div style={{ ...card, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>1. Pick the earlier item(s) — one customer at a time</div>
          {(options as any[]).length ? (options as any[]).map((option) => {
            const row = picked[option.itemId];
            return (
              <div key={option.itemId} style={{ border: `1px solid ${row ? "#111827" : "#e5e7eb"}`, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
                <label style={{ display: "flex", gap: 10, alignItems: "start", cursor: "pointer" }}>
                  <input type="checkbox" checked={Boolean(row)} onChange={() => toggle(option.itemId)} style={{ width: 22, height: 22, marginTop: 2 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 15, fontWeight: 700, overflowWrap: "anywhere" }}>{option.customer} — {option.product}</span>
                    <span style={{ display: "block", fontSize: 13, color: "#6b7280" }}>{option.itemTicket || option.jobTicket || "No ticket"} · earlier quantity {option.quantity}{option.finish ? ` · ${option.finish}` : ""}</span>
                  </span>
                </label>
                {row ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                    <label style={{ fontSize: 13, color: "#6b7280", display: "grid", gap: 4 }}>New quantity
                      <input type="number" min={1} step={1} value={row.quantity} onChange={(event) => update(option.itemId, { quantity: event.target.value })} style={input} />
                    </label>
                    <label style={{ fontSize: 13, color: "#6b7280", display: "grid", gap: 4 }}>Artwork
                      <select value={row.artworkMode} onChange={(event) => update(option.itemId, { artworkMode: event.target.value })} style={input}>
                        {REORDER_ARTWORK_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            );
          }) : <div style={{ fontSize: 14, color: "#6b7280" }}>No earlier items found{q ? ` for "${q}"` : ""}.</div>}
        </div>

        <div style={{ ...card, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>2. Create the reorder quote</div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>The quote uses today's pricing for the new quantity. If today's price is not available for an item, the quote is saved as a draft that needs the owner's price approval — the earlier price is never copied. The production job is created later, at the normal release step.</div>
          <button type="button" disabled={busy || !pickedIds.length} onClick={submit} style={{ minHeight: 56, borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 17, fontWeight: 800, cursor: busy || !pickedIds.length ? "default" : "pointer", opacity: busy || !pickedIds.length ? 0.6 : 1 }}>
            CREATE REORDER QUOTE{pickedIds.length ? ` (${pickedIds.length} item${pickedIds.length > 1 ? "s" : ""})` : ""}
          </button>
        </div>
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (!(isRouteErrorResponse(error) && error.status === 403)) return boundary.error(error);
  return (
    <Page title="Reorder a past item" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Reorders are created by the owner, a manager or sales. You can see an item's reorder history on its job page.</div>
    </Page>
  );
}
