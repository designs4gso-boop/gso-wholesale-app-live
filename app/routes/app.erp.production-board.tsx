// GSO ERP SIMPLE MODE (2026-11-14) — Simple Production Board.
//
// A READ-ONLY view over the same jobs as the full Production page
// (app.erp.production.tsx, which stays as the owner's Advanced view). It reuses
// that page's loader — same authentication, same job query, same financial
// redaction — and then keeps only the handful of fields a board card needs
// (toBoardCard), so no cost, price, file URL, checklist, event or technical id
// reaches this page. No action: all work happens on the job page.
//
// Six columns are UI groups of the existing backend statuses
// (app/lib/simple-production.ts). No status is added or changed.

import { formatDueDate } from "../lib/business-date";
import { Link, useLoaderData, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { loader as productionLoader } from "./app.erp.production";
import { ROLE_STAGE_FOCUS, buildSimpleBoard, toBoardCard, type BoardCard, type SimpleStageKey } from "../lib/simple-production";
import { CLASSIC_PRODUCTION_HREF, NEW_JOB_HREF, jobWorkspaceHref } from "../lib/simple-nav";
import { showsProductionControl } from "../lib/production-role-access";

export async function loader(args: { request: Request }) {
  const raw: any = await productionLoader(args);
  const data: any = raw instanceof Response ? await raw.json() : raw;
  const now = new Date();
  const cards = ((data.jobs || []) as any[]).map((job) => toBoardCard(job, now));
  return Response.json({ board: buildSimpleBoard(cards), total: cards.length });
}

const TONE: Record<string, { bg: string; fg: string; border: string }> = {
  action: { bg: "#eff6ff", fg: "#1e3a8a", border: "#bfdbfe" },
  waiting: { bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
  problem: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  done: { bg: "#f0fdf4", fg: "#166534", border: "#bbf7d0" },
};
const PRIORITY_LABEL: Record<string, string> = { critical: "CRITICAL", rush: "RUSH", low: "Low" };

function formatDue(card: BoardCard) {
  if (!card.dueDate) return "No due date";
  return formatDueDate(card.dueDate, { month: "short", day: "numeric" });
}

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: strong ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

function JobBoardCard({ card }: { card: BoardCard }) {
  const tone = TONE[card.nextTone] || TONE.action;
  const priority = PRIORITY_LABEL[card.priority];
  return (
    <div style={{ border: `1px solid ${card.overdue ? "#fca5a5" : "#e5e7eb"}`, borderRadius: 12, background: "white", padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" }}>
        <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.25, minWidth: 0, overflowWrap: "anywhere" }}>{card.customer}</div>
        {priority ? <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: card.priority === "low" ? "#f3f4f6" : "#fee2e2", color: card.priority === "low" ? "#374151" : "#991b1b", whiteSpace: "nowrap" }}>{priority}</span> : null}
      </div>
      <div style={{ fontSize: 14, color: "#111827", overflowWrap: "anywhere" }}>{card.product}</div>
      <div style={{ padding: "8px 10px", borderRadius: 8, background: tone.bg, border: `1px solid ${tone.border}`, color: tone.fg, fontSize: 15, fontWeight: 700 }}>
        NEXT: {card.next}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Quantity" value={card.quantity > 0 ? card.quantity.toLocaleString() : "Not set"} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>Due</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: card.overdue ? "#b91c1c" : "#111827" }}>{formatDue(card)}{card.overdue ? " · LATE" : ""}</div>
        </div>
        <Field label="Machine" value={card.machine || "Not assigned"} />
        <Field label="Assigned to" value={card.assignedTo || "Nobody yet"} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>{card.statusLabel}</span>
        <Link
          to={jobWorkspaceHref(card.id)}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, padding: "0 18px", borderRadius: 10, background: "#111827", color: "white", fontWeight: 700, fontSize: 14, textDecoration: "none" }}
        >
          OPEN JOB
        </Link>
      </div>
    </div>
  );
}

function AttentionGroup({ title, cards, color }: { title: string; cards: BoardCard[]; color: string }) {
  return (
    <details style={{ flex: "1 1 220px", minWidth: 0, border: `1px solid ${cards.length ? color : "#e5e7eb"}`, borderRadius: 12, background: "white", padding: "10px 12px" }}>
      <summary style={{ cursor: cards.length ? "pointer" : "default", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 44 }}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4 }}>{title}</span>
        <span style={{ fontSize: 20, fontWeight: 800, color: cards.length ? color : "#9ca3af" }}>{cards.length}</span>
      </summary>
      {cards.length ? (
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {cards.map((card) => (
            <Link key={card.id} to={jobWorkspaceHref(card.id)} style={{ display: "flex", justifyContent: "space-between", gap: 8, minHeight: 40, alignItems: "center", padding: "4px 8px", borderRadius: 8, background: "#f9fafb", color: "#111827", textDecoration: "none", fontSize: 13 }}>
              <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{card.customer} — {card.product}</span>
              <span style={{ color: "#6b7280", whiteSpace: "nowrap" }}>{card.dueDate ? formatDue(card) : ""}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </details>
  );
}

const toggleStyle = (active: boolean): CSSProperties => ({
  display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 16px", borderRadius: 10, fontWeight: 700, fontSize: 14, textDecoration: "none",
  border: `1px solid ${active ? "#111827" : "#d1d5db"}`, background: active ? "#111827" : "white", color: active ? "white" : "#111827",
});

export default function SimpleProductionBoard() {
  const { board, total } = useLoaderData<any>();
  const shell = useRouteLoaderData("routes/app") as any;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const role: string = shell?.role || "owner";
  // display only: the server decides (Advanced view redirect, createManualJob role rule)
  const canOpenAdvanced = role === "owner" || Boolean(shell?.viewFinancials);
  const canCreateJob = showsProductionControl(role, "createManualJob");
  const focus = ROLE_STAGE_FOCUS[role] as readonly SimpleStageKey[] | undefined;
  const showAll = !focus || params.get("view") === "all";
  const showCancelled = params.get("cancelled") === "1";
  const columns = (board.columns as any[]).filter((column) => showAll || focus!.includes(column.key));
  const query = (next: Record<string, string | null>) => {
    const copy = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) { if (value === null) copy.delete(key); else copy.set(key, value); }
    const text = copy.toString();
    return text ? `?${text}` : "?";
  };

  return (
    <Page
      title="Production Board"
      subtitle="Every job, where it is, and what to do next. Open a job to work on it."
      primaryAction={canCreateJob ? { content: "New job", onAction: () => navigate(NEW_JOB_HREF) } : undefined}
      secondaryActions={[
        { content: "Calendar", onAction: () => navigate("/app/erp/production-calendar") },
        ...(canOpenAdvanced ? [{ content: "Open advanced view", onAction: () => navigate(CLASSIC_PRODUCTION_HREF) }] : []),
      ]}
    >
      <div style={{ display: "grid", gap: 16, paddingBottom: 32 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <AttentionGroup title="ON HOLD" cards={board.attention.onHold} color="#b91c1c" />
          <AttentionGroup title="REPRINT NEEDED" cards={board.attention.reprintNeeded} color="#b91c1c" />
          <AttentionGroup title="OVERDUE" cards={board.attention.overdue} color="#b45309" />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {focus ? (
            <>
              <Link to={query({ view: null })} style={toggleStyle(!showAll)}>My stage</Link>
              <Link to={query({ view: "all" })} style={toggleStyle(showAll)}>All stages</Link>
            </>
          ) : null}
          <Link to={query({ cancelled: showCancelled ? null : "1" })} style={toggleStyle(showCancelled)}>{showCancelled ? "Hide cancelled" : `Show cancelled (${board.cancelled.length})`}</Link>
          <span style={{ fontSize: 13, color: "#6b7280" }}>{total} job(s)</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, alignItems: "start" }}>
          {columns.map((column) => (
            <section key={column.key} style={{ background: "#f3f4f6", borderRadius: 14, padding: 10, display: "grid", gap: 10, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px" }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>{column.label}</h2>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280" }}>{column.cards.length + column.hiddenCount}</span>
              </div>
              {column.cards.length ? column.cards.map((card: BoardCard) => <JobBoardCard key={card.id} card={card} />) : <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 4px" }}>No jobs here.</div>}
              {column.hiddenCount ? <div style={{ fontSize: 12, color: "#6b7280", padding: "0 4px" }}>{`Showing the ${column.cards.length} most recent. ${column.hiddenCount} older job(s) not shown.`}</div> : null}
            </section>
          ))}
        </div>

        {showCancelled ? (
          <section style={{ display: "grid", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: 0.6 }}>CANCELLED</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              {board.cancelled.length ? board.cancelled.map((card: BoardCard) => <JobBoardCard key={card.id} card={card} />) : <div style={{ fontSize: 13, color: "#6b7280" }}>No cancelled jobs.</div>}
            </div>
          </section>
        ) : null}
      </div>
    </Page>
  );
}
