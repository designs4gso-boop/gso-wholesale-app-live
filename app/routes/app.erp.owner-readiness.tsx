// 2026-11-12 — OWNER-ONLY Staff Access & Launch Readiness.
//
// Shows the viewer's verified Shopify staff identity and resolved permissions,
// the configured role assignments (Shopify user IDs and role names only — no
// secrets), and a GREEN / AMBER / RED launch checklist. Read-only: roles are
// configured on Render (GSO_STAFF_ROLES / GSO_MANAGER_AUTHORIZED_USER_IDS);
// this page never writes environment variables, the database or Shopify.

import { Prisma } from "@prisma/client";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { MANAGER_AUTHORIZED_USER_IDS_ENV, OWNER_ENFORCEMENT_ENV, OWNER_ENFORCEMENT_TEMPORARY, configuredOwnerUserIds, requireOwner } from "../lib/owner-authorization.server";
import { ROLE_PERMISSIONS, STAFF_ROLES_ENV, configuredStaffRoles, resolveStaffAccess, type StaffPermission } from "../lib/staff-roles.server";
import { buildReadinessChecks, readinessSummary, type ReadinessCheck } from "../lib/owner-readiness";
import { PENDING_CALIBRATION_IDENTITIES } from "../lib/machine-routing.server";
import { jarGeometryAuthorityFor } from "../lib/jar-label-geometry";
import { JAR_APPLICATION_SECONDS_BY_SIZE } from "../lib/jar-cost-inputs.server";
import { BANNER_FINISHING_SUPPORT } from "../lib/banner-cost-inputs.server";
import { CANONICAL_PACKOUT } from "../lib/canonical-calculator-shared";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireOwner(auth, process.env, "Staff Access & Readiness is owner only.");
  const shop = auth.session.shop;
  const access = resolveStaffAccess(auth);
  const roles = [...configuredStaffRoles().entries()].map(([userId, role]) => ({ userId, role }));
  const authorizedManagers = String(process.env[MANAGER_AUTHORIZED_USER_IDS_ENV] || "").split(",").map((v) => v.trim()).filter(Boolean);

  const [activeConfigurator, missingIds, whiteApproved] = await Promise.all([
    db.configuratorProduct.count({ where: { shop, active: true } }),
    db.configuratorProduct.count({ where: { shop, active: true, shopifyProductGid: null } }),
    db.machineProfileCalibration.count({ where: { shop, ...PENDING_CALIBRATION_IDENTITIES["mimaki-white"], status: "approved" } }),
  ]);

  const checks = buildReadinessChecks({
    ownerIdsConfigured: configuredOwnerUserIds().length,
    temporaryAllStaff: String(process.env[OWNER_ENFORCEMENT_ENV] || "").trim().toLowerCase() === OWNER_ENFORCEMENT_TEMPORARY,
    staffRoleAssignments: roles.length,
    authorizedManagers: authorizedManagers.length,
    activeConfiguratorProducts: activeConfigurator,
    configuratorProductsMissingShopifyIds: missingIds,
    mimakiWhiteCalibrationApproved: whiteApproved > 0,
    jar50mlConfirmed: jarGeometryAuthorityFor("50ml").authorityStatus === "OWNER_CONFIRMED",
    bandSecondsMissingSizes: Object.entries(JAR_APPLICATION_SECONDS_BY_SIZE).filter(([, s]) => s.tamper == null).map(([size]) => size),
    bannerFinishingUnverified: Object.entries(BANNER_FINISHING_SUPPORT).filter(([, v]) => !v.verified).map(([k]) => k.toLowerCase().replace(/_/g, " ")),
    splitBagPackoutModeled: CANONICAL_PACKOUT["split-bags"].unitsPerBox != null,
    operationalMigrationActivated: Prisma.dmmf.datamodel.models.some((m) => m.name === "InventoryReservation"),
  });

  return {
    viewer: { userId: access.userId, role: access.role, reason: access.reason, permissions: [...access.permissions] as StaffPermission[] },
    roles,
    authorizedManagers,
    matrix: ROLE_PERMISSIONS,
    env: { roles: STAFF_ROLES_ENV, managers: MANAGER_AUTHORIZED_USER_IDS_ENV },
    checks,
    summary: readinessSummary(checks),
  };
}

const TONE: Record<ReadinessCheck["tone"], { bg: string; border: string; label: string }> = {
  green: { bg: "#f0fdf4", border: "#bbf7d0", label: "READY" },
  amber: { bg: "#fffbeb", border: "#fde68a", label: "OWNER / EXTERNAL INPUT" },
  red: { bg: "#fef2f2", border: "#fecaca", label: "ACTION REQUIRED" },
};
const PERMS: StaffPermission[] = ["viewFinancials", "ownerOverrides", "approvePurchasing", "createPurchaseRequest", "approveExceptionPricing", "sendQuote", "selectPrinter", "manageIntake", "recordQc", "recordReprint", "recordShipment"];

export default function OwnerReadiness() {
  const data = useLoaderData<typeof loader>();
  const cell = { padding: "4px 8px", borderBottom: "1px solid #e5e7eb", fontSize: 12 } as const;
  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Staff Access &amp; Launch Readiness</h1>
      <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 12px" }}>Owner only · read-only · {data.summary.red} action required · {data.summary.amber} waiting on owner / external input · {data.summary.green} ready</p>

      <h2 style={{ fontSize: 16 }}>You</h2>
      <p style={{ fontSize: 13 }}>Shopify staff user ID <b>{data.viewer.userId ?? "not available"}</b> · role <b>{data.viewer.role}</b> · {data.viewer.reason}</p>

      <h2 style={{ fontSize: 16 }}>Employee roles (configured on Render)</h2>
      {data.roles.length ? (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={cell} align="left">Shopify user ID</th><th style={cell} align="left">Role</th><th style={cell} align="left">Financials / purchasing approval</th></tr></thead>
          <tbody>{data.roles.map((r) => <tr key={r.userId}><td style={cell}>{r.userId}</td><td style={cell}>{r.role}</td><td style={cell}>{r.role === "manager" && data.authorizedManagers.includes(r.userId) ? "authorized" : "no"}</td></tr>)}</tbody>
        </table>
      ) : <p style={{ fontSize: 13, color: "#92400e" }}>No employees assigned yet — unassigned staff are denied every financial and production-write action.</p>}
      <details style={{ margin: "8px 0", fontSize: 13 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>How to add an employee safely</summary>
        <ol>
          <li>Create a separate Shopify staff account for the employee (Shopify Settings → Users) with access to this app.</li>
          <li>Have them open the ERP once; any owner-only page shows “Your Shopify staff user ID is …”. Note that ID.</li>
          <li>On Render set <code>{data.env.roles}</code>, e.g. <code>123:print_operator,456:bagger,789:sales,321:manager</code>.</li>
          <li>Only for managers who should see costs / approve purchasing, also list them in <code>{data.env.managers}</code>.</li>
          <li>Make sure <code>GSO_OWNER_ENFORCEMENT</code> is NOT <code>temporary_all_staff</code>, then redeploy (env changes restart the service).</li>
        </ol>
      </details>

      <h2 style={{ fontSize: 16 }}>Permission matrix</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", minWidth: 760 }}>
          <thead><tr><th style={cell} align="left">Role</th>{PERMS.map((p) => <th key={p} style={cell}>{p}</th>)}</tr></thead>
          <tbody>{Object.entries(data.matrix).map(([role, perms]) => (
            <tr key={role}><td style={cell}><b>{role}</b></td>{PERMS.map((p) => <td key={p} style={cell} align="center">{(perms as readonly string[]).includes(p) ? "✓" : role === "manager" && ["viewFinancials", "approvePurchasing", "approveExceptionPricing"].includes(p) ? "if authorized" : "—"}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 16 }}>Launch checklist</h2>
      {data.checks.map((c) => (
        <div key={c.key} style={{ background: TONE[c.tone].bg, border: `1px solid ${TONE[c.tone].border}`, borderRadius: 8, padding: 8, margin: "6px 0", fontSize: 13 }}>
          <b>{TONE[c.tone].label} · {c.label}</b> <span style={{ color: "#6b7280" }}>({c.kind})</span>
          <div>{c.detail}</div>
          {c.ownerAction ? <div style={{ marginTop: 2 }}><b>Next step:</b> {c.ownerAction}</div> : null}
        </div>
      ))}
    </div>
  );
}
