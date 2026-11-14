// GSO ERP SIMPLE MODE (2026-11-14) — New production job (manual / walk-in / internal).
//
// A short form over the EXISTING Production "createManualJob" action: same
// creation service, same idempotent requestId, same machine routing, same
// printer-selection rule (only roles with selectPrinter get a choice; the
// server ignores a forged printer from anyone else). No second creation
// engine. Who may create a manual job is the server's rule
// (production-role-access.ts): owner, manager, print operator. Sales creates
// work through the quote / order flow.

import { isRouteErrorResponse, useFetcher, useLoaderData, useNavigate, useRouteError } from "react-router";
import type { CSSProperties } from "react";
import { Page } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { action as productionAction } from "./app.erp.production";
import { friendlyMessage } from "../lib/employee-messages";
import { MANUAL_JOB_FAMILIES, MANUAL_JOB_FINISHES } from "../lib/production-job-source.server";
import { PRODUCTION_ROLE_DENIED, roleMayRunProductionIntent } from "../lib/production-role-access";
import { SIMPLE_BOARD_HREF } from "../lib/simple-nav";
import { resolveStaffAccess } from "../lib/staff-roles.server";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  const staff = resolveStaffAccess(auth);
  if (!roleMayRunProductionIntent(staff.role, "createManualJob")) throw new Response(PRODUCTION_ROLE_DENIED, { status: 403 });
  return Response.json({
    // one id per rendered form: a double tap or retry resolves to the SAME job (existing server rule)
    requestId: crypto.randomUUID(),
    families: MANUAL_JOB_FAMILIES,
    finishes: MANUAL_JOB_FINISHES,
    canChoosePrinter: staff.can("selectPrinter"),
  });
}

/** Posts to the existing Production action — nothing is re-implemented here. */
export async function action(args: { request: Request }) {
  return productionAction({ request: args.request });
}

const card: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, background: "white", padding: 16 };
const input: CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, width: "100%", boxSizing: "border-box" };
const label: CSSProperties = { fontSize: 13, color: "#6b7280", display: "grid", gap: 4 };

export default function NewProductionJob() {
  const { requestId, families, finishes, canChoosePrinter } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const friendly = friendlyMessage(result?.message);

  return (
    <Page
      title="New job"
      subtitle="Start a walk-in, internal or test job. Jobs from a quote or an order are created from Sales."
      backAction={{ content: "Production Board", onAction: () => navigate(SIMPLE_BOARD_HREF) }}
    >
      <div style={{ display: "grid", gap: 16, paddingBottom: 40, maxWidth: 720 }}>
        {result?.message ? (
          <div role="status" style={{ ...card, borderColor: result.ok ? "#86efac" : "#fca5a5", background: result.ok ? "#f0fdf4" : "#fef2f2", color: result.ok ? "#166534" : "#991b1b", display: "grid", gap: 6 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{result.ok ? "Job created" : friendly.primary}</div>
            {result.ok && result.manualJob ? (
              <>
                <div style={{ fontSize: 15 }}>Job ticket: <b>{result.manualJob.jobTicket}</b>{result.manualJob.machine ? ` · Machine: ${result.manualJob.machine}` : ""}</div>
                {result.manualJob.suggestedFileName ? <div style={{ fontSize: 14 }}>Name the print file: <b>{result.manualJob.suggestedFileName}</b></div> : null}
                <button type="button" onClick={() => navigate(SIMPLE_BOARD_HREF)} style={{ minHeight: 48, borderRadius: 12, border: "1px solid #166534", background: "#166534", color: "white", fontSize: 16, fontWeight: 700, cursor: "pointer", marginTop: 4 }}>Go to the Production Board</button>
              </>
            ) : null}
            {!result.ok && friendly.detail ? <details><summary style={{ cursor: "pointer", fontSize: 12 }}>Details</summary><div style={{ fontSize: 12 }}>{friendly.detail}</div></details> : null}
          </div>
        ) : null}

        <fetcher.Form method="post" key={requestId} style={{ ...card, display: "grid", gap: 12 }}>
          <input type="hidden" name="intent" value="createManualJob" />
          <input type="hidden" name="requestId" value={requestId} />
          <label style={label}>Customer or job name<input name="customerName" required placeholder="Walk-in — Jane D." style={input} /></label>
          <label style={label}>What are we making?<input name="itemTitle" required placeholder="4x5 bag labels" style={input} /></label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label style={label}>Quantity<input name="quantity" type="number" min={1} step={1} required style={input} /></label>
            <label style={label}>Due date (optional)<input name="dueDate" type="date" style={input} /></label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label style={label}>Product type
              <select name="family" defaultValue="default" style={input}>
                {(families as any[]).map((family) => <option key={family.value} value={family.value}>{family.label}</option>)}
              </select>
            </label>
            <label style={label}>Finish
              <select name="finish" defaultValue="CMYK" style={input}>
                {(finishes as string[]).map((finish) => <option key={finish} value={finish}>{finish}</option>)}
              </select>
            </label>
            {canChoosePrinter ? (
              <label style={label}>Printer
                <select name="printer" defaultValue="auto" style={input}>
                  <option value="auto">Auto (recommended)</option>
                  <option value="mimaki">Mimaki UCJV300</option>
                  <option value="roland">Roland LG-640</option>
                </select>
              </label>
            ) : null}
          </div>
          <label style={label}>Notes for production (optional)<textarea name="itemNotes" rows={2} style={{ ...input, minHeight: 72, padding: 12 }} /></label>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7280", minHeight: 32 }}>More details (size, SKU, reference, contact)</summary>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 8 }}>
              <label style={label}>Size<input name="size" placeholder='4" x 5"' style={input} /></label>
              <label style={label}>SKU<input name="sku" style={input} /></label>
              <label style={label}>Reference #<input name="reference" style={input} /></label>
              <label style={label}>Customer email<input name="email" type="email" style={input} /></label>
              <label style={label}>Customer phone<input name="phone" style={input} /></label>
            </div>
          </details>
          <button type="submit" disabled={busy} style={{ minHeight: 56, borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "white", fontSize: 17, fontWeight: 800, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>CREATE JOB</button>
        </fetcher.Form>
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (!(isRouteErrorResponse(error) && error.status === 403)) return boundary.error(error);
  return (
    <Page title="New job" backAction={{ content: "Home", onAction: () => navigate("/app") }}>
      <div style={{ ...card, fontSize: 16 }}>Your role can't create production jobs. Sales creates work from a quote or an order.</div>
    </Page>
  );
}
