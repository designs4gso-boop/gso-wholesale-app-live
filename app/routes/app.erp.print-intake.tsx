import type React from "react";
import { Link, useLoaderData } from "react-router";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { decodeIntakeOutcomes, type IntakeOutcome } from "../lib/print-intake-routing.server";

// Print Intake (13A.6G): the staff workflow is now automatic — drop artwork in
// "Prints For Today" and the local intake agent asks the ERP for a
// deterministic routing plan, copies the file into the machine hot folder
// under the exact ERP RIP name, archives the original, and reports every
// outcome back here. This page shows the live outcome log (stored without any
// schema change) plus setup instructions. Loader is read-only apart from the
// long-standing ensureSetting upsert.

async function ensureSetting(shop: string) {
  return db.printLogAutoImportSetting.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      uploadToken: crypto.randomUUID(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\error",
      expectedTicketPattern: "GSO-{jobNumber}_{customer}_{product}_{side}_{material}_{route}_R{revision}",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const setting = await ensureSetting(session.shop);
  const { outcomes } = decodeIntakeOutcomes(setting.notes);
  return {
    incomingFolder: setting.incomingFolder,
    uploadToken: setting.uploadToken,
    outcomes: outcomes.slice(0, 50),
  };
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 };

const DECISION_STYLE: Record<IntakeOutcome["decision"], React.CSSProperties> = {
  routed: { ...chip, background: "#dcfce7", color: "#166534" },
  needs_review: { ...chip, background: "#fef3c7", color: "#92400e" },
  duplicate: { ...chip, background: "#e0e7ff", color: "#3730a3" },
  failed: { ...chip, background: "#fee2e2", color: "#991b1b" },
};

const DECISION_LABEL: Record<IntakeOutcome["decision"], string> = {
  routed: "Routed",
  needs_review: "Needs review",
  duplicate: "Duplicate",
  failed: "Failed",
};

export default function PrintIntake() {
  const { incomingFolder, uploadToken, outcomes } = useLoaderData<typeof loader>();
  const counts = {
    routed: outcomes.filter((outcome) => outcome.decision === "routed").length,
    needs_review: outcomes.filter((outcome) => outcome.decision === "needs_review").length,
    duplicate: outcomes.filter((outcome) => outcome.decision === "duplicate").length,
    failed: outcomes.filter((outcome) => outcome.decision === "failed").length,
  };
  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#064e3b)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Print Intake Automation</h1>
        <p style={{ margin: "8px 0 0" }}>
          Patch 13A.6G: staff drop artwork into <b>Prints For Today</b> — nothing else. The local intake agent maps each
          file to exactly one production job (item ticket, job ticket, stored filename, or job subfolder — never fuzzy),
          copies it to the machine hot folder under the exact ERP RIP name, archives the original, and logs the outcome
          below. Unresolved files stay where staff put them and appear as Needs review.
        </p>
      </section>

      <section style={card}>
        <b>Intake folder:</b> <code>{incomingFolder}</code>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
          Staff workflow: save the print-ready file into this folder (or the job&apos;s subfolder). Done. Files named with
          the item ticket (GSO-YYYYMMDD-NNNN-II) route instantly; the production board&apos;s &quot;Copy Print File
          Name&quot; button gives the exact name.
        </div>
      </section>

      <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
        <b>Machine routing (finalized rules).</b>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          <b>White and/or gloss &rarr; Roland LG-640 (the Mimaki is CMYK only).</b> CMYK-only jobs explicitly assigned to Roland in the ERP, or
          named with the standalone <code>ROLAND</code> filename tag, also route to Roland. All other CMYK-only jobs
          default to the <b>Mimaki UCJV300</b> (<code>GSO_MIMAKI_CMYK_STANDARD</code>). Contradictory data (for example
          a white/gloss job explicitly assigned to the CMYK-only Mimaki) goes to Needs review. Copies happen only where
          the config enables them: <code>MimakiRoutingEnabled</code> / <code>RolandRoutingEnabled</code> ship off, and
          Roland additionally needs its confirmed <code>VersaWorksHotFolder</code> path — until then Roland-bound plans
          appear as Needs review with the blocking reason.
        </div>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Recent intake outcomes</h2>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>
          <span style={DECISION_STYLE.routed}>Routed: {counts.routed}</span>{" "}
          <span style={DECISION_STYLE.needs_review}>Needs review: {counts.needs_review}</span>{" "}
          <span style={DECISION_STYLE.duplicate}>Duplicates: {counts.duplicate}</span>{" "}
          <span style={DECISION_STYLE.failed}>Failed: {counts.failed}</span>{" "}
          <span>(last {outcomes.length} outcomes; file names only — no local paths)</span>
        </p>
        {outcomes.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No intake outcomes reported yet — install and run the agent below.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th align="left" style={{ padding: 6 }}>When</th><th align="left">File</th><th align="left">Outcome</th>
                  <th align="left">Rule / reason</th><th align="left">Job / item</th><th align="left">RIP name</th><th align="left">Machine</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((outcome, index) => (
                  <tr key={`${outcome.fileName}-${outcome.at}-${index}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(outcome.at).toLocaleString()}</td>
                    <td>{outcome.fileName}</td>
                    <td><span style={DECISION_STYLE[outcome.decision] || chip}>{DECISION_LABEL[outcome.decision] || outcome.decision}</span></td>
                    <td>{outcome.rule || outcome.reason || "—"}</td>
                    <td>{outcome.itemTicket || outcome.jobTicket || "—"}</td>
                    <td>{outcome.ripName || "—"}</td>
                    <td>{outcome.machine || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 13, marginTop: 10 }}>
          Unmatched RIP <i>results</i> (after printing) are a separate workflow:{" "}
          <Link to="/app/erp/rip-import-review">RIP Import Review</Link>.
        </p>
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 8px" }}>Agent setup (tools/gso-print-intake-agent.ps1)</h2>
        <ol style={{ fontSize: 13, lineHeight: 1.9, margin: 0, paddingLeft: 20 }}>
          <li>On the shop PC: copy <code>tools\gso-print-intake-agent-config.example.json</code> to <code>gso-print-intake-agent-config.json</code> (git-ignored) and paste the token below.</li>
          <li>Health check (writes nothing): <code>powershell -ExecutionPolicy Bypass -File tools\gso-print-intake-agent.ps1 -Health</code></li>
          <li>Dry run (plans only, no copies/moves/reports): <code>... -DryRun</code>, then one real pass: <code>... -Once</code></li>
          <li>Enable routing by setting <code>MimakiRoutingEnabled: true</code> in the config after the dry run looks right.</li>
          <li>Install at startup: <code>schtasks /Create /TN &quot;GSO Print Intake Agent&quot; /SC ONSTART /TR &quot;powershell -ExecutionPolicy Bypass -File C:\path\to\tools\gso-print-intake-agent.ps1 -Loop&quot;</code></li>
        </ol>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
          The old <code>gso-print-intake-watcher.ps1</code> is retired — it renamed originals destructively, routed by
          filename guesses, and its upload call cannot work on Windows PowerShell 5.1. Do not schedule it.
        </p>
      </section>

      <section style={{ ...card, borderColor: "#fcd34d", background: "#fffbeb" }}>
        <b>Agent token</b>
        <p style={{ fontSize: 13 }}>Paste into <code>UploadToken</code> in the agent config (and the RasterLink sync config). Never commit the real config — it is git-ignored.</p>
        <pre style={{ background: "white", padding: 12, borderRadius: 8, overflowX: "auto" }}>{uploadToken}</pre>
      </section>
    </main>
  );
}
