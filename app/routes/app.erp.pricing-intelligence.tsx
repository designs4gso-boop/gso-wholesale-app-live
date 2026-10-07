import type React from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
// 2026-10-06: DTP vendor economics (Spektra live cost book) + owner shaped-pouch rules — read-only.
import { SPEKTRA_COST_BOOK_META, SPEKTRA_COST_STATUS_LABEL, SPEKTRA_PUBLISHED_TIERS, lookupSpektraVendorCost } from "../lib/spektra-live-cost-book";
import { DTP_CATALOG, SPEKTRA_FREIGHT_ASSUMPTION } from "../lib/dtp-catalog";
import { DTP_CUSTOM_SHAPE_SURCHARGE_PCT, DTP_NEW_DIE_TOOLING_FEE, DTP_SHAPED_BAG_POLICY_SOURCE } from "../lib/dtp-shaped-bag-policy";
import { buildDtpLiveEconomics } from "../lib/dtp-live-economics.server";
import { buildDtpProposedLadders } from "../lib/dtp-proposed-ladders.server";
import { DESIGN_AND_CUSTOMIZE_BENCHMARK, GSO_DTP_MARKET_POSITION } from "../lib/dtp-market-benchmark";
import { DTP_SHAPED_MOQ } from "../lib/dtp-shaped-bag-policy";
import db from "../db.server";
import {
  PRE_LAUNCH_REASON,
  aggregateEvidence,
  gatherPricingEvidence,
  isPreLaunchEvidence,
  loadPricingEvidenceLiveFrom,
} from "../lib/pricing-intelligence.server";
import {
  SHOPIFY_ACCESS_BLOCKED_MESSAGE,
  buildShopifyEvidenceContext,
  evidenceKeysChanged,
  fetchShopifyOrderEvidence,
  isAccessDeniedError,
  loadShopifyEvidenceCache,
  normalizeShopifyOrderEvidence,
  saveShopifyEvidenceCache,
} from "../lib/shopify-pricing-evidence.server";

// Pricing Intelligence (15F.0K.4D + 4E) — READ-ONLY evidence counting, not
// market conclusions. 4E adds the Shopify historical-order evidence source:
// a staff-triggered, read-only refresh normalizes paid storefront orders
// into the same privacy-safe baskets and caches the summary (ErpAdminSetting
// JSON — no raw orders, no PII). Accepted-price low/median/high stay
// THRESHOLD-GATED (>=5 accepted, >=3 distinct customers, >=2 distinct
// months). No market targets are created, no quotes/products are repriced,
// and NOTHING ever writes to Shopify.

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  // 15F.0K.4G: cache loads FIRST so gathering can deduplicate production-job
  // twins of Shopify sales and exclude ERP evidence paid by Shopify test
  // orders (exact id joins only — Shopify record wins).
  const liveFrom = await loadPricingEvidenceLiveFrom(db, shop);
  const shopify = await loadShopifyEvidenceCache(db, shop);
  // 15F.0K.4H: re-apply the live-sales cutoff to the cached records too, so a
  // cache refreshed BEFORE 4H can never keep pre-launch evidence eligible.
  const keptShopifyRecords = shopify.records.filter((record) => !isPreLaunchEvidence(record.evidenceAt, liveFrom?.date ?? null));
  const staleShopifyPreLaunch = shopify.records.length - keptShopifyRecords.length;
  const local = await gatherPricingEvidence(db, shop, buildShopifyEvidenceContext(shopify.cache, keptShopifyRecords), { liveFrom: liveFrom?.date ?? null });
  const combined = [...local.records, ...keptShopifyRecords];
  const baskets = aggregateEvidence(combined);
  const localPreLaunch = local.excluded.filter((row) => row.reasons.includes(PRE_LAUNCH_REASON)).length;
  const cachedShopifyPreLaunch = (shopify.cache?.excluded ?? []).filter((row) => row.reasons.includes(PRE_LAUNCH_REASON)).length;
  const cacheAgeDays = shopify.cache?.capturedAt
    ? Math.floor((Date.now() - new Date(shopify.cache.capturedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    totals: local.totals,
    excluded: local.excluded.slice(0, 50),
    review: local.review.slice(0, 50),
    baskets: baskets.slice(0, 100),
    liveFrom: liveFrom ? { iso: liveFrom.iso, note: liveFrom.note, changedAt: liveFrom.changedAt } : null,
    // 2026-10-06: DTP live economics (current Spektra cost vs legacy seed vs current owner ladder; proposals not applied).
    dtpEconomics: buildDtpLiveEconomics("Soft Touch"),
    dtpEconomicsGlossy: buildDtpLiveEconomics("Glossy"),
    // 2026-10-07: remaining-size proposals + 4x5 25,000 recommendation (PROPOSED OWNER PRICING — not read by the quote engine).
    dtpProposals: buildDtpProposedLadders(),
    preLaunch: {
      total: localPreLaunch + cachedShopifyPreLaunch + staleShopifyPreLaunch,
      local: localPreLaunch,
      shopify: cachedShopifyPreLaunch + staleShopifyPreLaunch,
    },
    shopify: {
      connected: Boolean(shopify.cache),
      ok: shopify.cache?.ok ?? false,
      accessBlocked: shopify.cache?.accessBlocked ?? false,
      // component must not import the .server module — message travels via data
      blockedMessage: SHOPIFY_ACCESS_BLOCKED_MESSAGE,
      error: shopify.cache?.error ?? null,
      capturedAt: shopify.cache?.capturedAt ?? null,
      cacheAgeDays,
      orderCount: shopify.cache?.orderCount ?? 0,
      pagesFetched: shopify.cache?.pagesFetched ?? 0,
      truncated: shopify.cache?.truncated ?? false,
      eligible: keptShopifyRecords.length,
      excluded: (shopify.cache?.excluded ?? []).slice(0, 50),
      incomplete: (shopify.cache?.incomplete ?? []).slice(0, 50),
      earliest: shopify.cache?.earliest ?? null,
      latest: shopify.cache?.latest ?? null,
    },
  };
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  if (String(form.get("intent")) !== "refreshShopifyEvidence") {
    return Response.json({ ok: false, message: "Unknown action." });
  }
  // READ-ONLY refresh: fetch -> normalize -> cache. Errors are cached as a
  // clear state (blocked/failed) so the rest of the page keeps working.
  try {
    const liveFrom = await loadPricingEvidenceLiveFrom(db, shop);
    const previous = await loadShopifyEvidenceCache(db, shop);
    const { orders, pagesFetched, truncated } = await fetchShopifyOrderEvidence(admin);
    const normalized = normalizeShopifyOrderEvidence(orders, { liveFrom: liveFrom?.date ?? null });
    await saveShopifyEvidenceCache(db, shop, {
      capturedAt: new Date().toISOString(),
      ok: true,
      error: null,
      accessBlocked: false,
      orderCount: normalized.orderCount,
      pagesFetched,
      truncated,
      earliest: normalized.earliest,
      latest: normalized.latest,
      records: normalized.records.map((record) => ({ ...record, evidenceAt: record.evidenceAt.toISOString() })),
      excluded: normalized.excluded,
      incomplete: normalized.incomplete,
      testOrders: normalized.testOrders,
    });
    // 15F.0K.4H: when the cutoff newly re-evaluated previously-cached
    // evidence, say so with the owner-approved wording; otherwise fall back
    // to the 4G reclassification notice when basket keys changed.
    const liveFromApplied = Boolean(liveFrom) &&
      previous.records.some((record) => isPreLaunchEvidence(record.evidenceAt, liveFrom!.date));
    const reclassified = Boolean(previous.cache) &&
      evidenceKeysChanged(previous.records.map((record) => record.key), normalized.records.map((record) => record.key));
    return Response.json({
      ok: true,
      message: `Shopify evidence refreshed: ${normalized.records.length} accepted line(s) from ${normalized.orderCount} order(s).` +
        (liveFromApplied
          ? " Historical evidence was re-evaluated using the owner-approved live-sales start date."
          : reclassified ? " Historical evidence was reclassified using updated deterministic rules." : ""),
    });
  } catch (error: any) {
    const message = String(error?.message || error || "Shopify refresh failed.");
    const accessBlocked = isAccessDeniedError(message);
    await saveShopifyEvidenceCache(db, shop, {
      capturedAt: new Date().toISOString(),
      ok: false,
      error: message.slice(0, 300),
      accessBlocked,
      orderCount: 0,
      pagesFetched: 0,
      truncated: false,
      earliest: null,
      latest: null,
      records: [],
      excluded: [],
      incomplete: [],
    });
    return Response.json({ ok: false, message: accessBlocked ? SHOPIFY_ACCESS_BLOCKED_MESSAGE : `Shopify refresh failed: ${message.slice(0, 200)}` });
  }
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const stat: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", minWidth: 150, background: "#f9fafb" };

export default function PricingIntelligence() {
  const { totals, excluded, review, baskets, shopify, liveFrom, preLaunch, dtpEconomics, dtpEconomicsGlossy, dtpProposals } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main style={{ maxWidth: 1240, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#3b0764)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Pricing Intelligence — evidence readiness</h1>
        <p style={{ margin: "8px 0 0", fontSize: 14 }}>
          Counts what real, accepted sales evidence exists per product basket — it deliberately does NOT show
          market conclusions from tiny samples. Accepted-price statistics unlock per basket only after
          <b> 5+ accepted items, 3+ distinct customers, and 2+ distinct months</b>. Everything here is
          <b> advisory-only</b>: no market targets are created, no prices change, and nothing ever writes to Shopify.
        </p>
      </section>

      {actionData?.message ? (
        <section style={{ ...card, borderColor: actionData.ok ? "#bbf7d0" : "#fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2" }}>
          <b style={{ color: actionData.ok ? "#166534" : "#991b1b" }}>{actionData.message}</b>
        </section>
      ) : null}

      <section style={{ ...card, borderColor: shopify.accessBlocked ? "#fecaca" : "#bfdbfe", background: shopify.accessBlocked ? "#fef2f2" : "#eff6ff" }}>
        <b>Shopify historical-order evidence (15F.0K.4E — read-only)</b>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          {shopify.accessBlocked ? (
            <span style={{ color: "#991b1b", fontWeight: 700 }}>{shopify.blockedMessage}</span>
          ) : !shopify.connected ? (
            <>Not refreshed yet — click Refresh to pull paid storefront orders (read-only). Until the owner deploys +
            reauthorizes the new <code>read_all_orders</code> scope, Shopify returns only its recent (~60-day) order window.</>
          ) : shopify.ok ? (
            <>
              Last refreshed {shopify.capturedAt ? new Date(shopify.capturedAt).toLocaleString() : "—"}
              {shopify.cacheAgeDays != null && shopify.cacheAgeDays >= 7 ? <b style={{ color: "#92400e" }}> (STALE — {shopify.cacheAgeDays} days old; refresh recommended)</b> : null}
              {" — "}{shopify.orderCount} order(s) reviewed across {shopify.pagesFetched} page(s){shopify.truncated ? " (TRUNCATED at the defensive cap — refine later)" : ""}.
              Evidence window: {shopify.earliest || "—"} → {shopify.latest || "—"}. Orders older than ~60 days appear only
              after <code>read_all_orders</code> reauthorization.
            </>
          ) : (
            <span style={{ color: "#991b1b" }}>Last refresh failed: {shopify.error}</span>
          )}
        </div>
        <div style={{ fontSize: 13, marginTop: 10, padding: "8px 10px", borderRadius: 8, background: liveFrom ? "#f0fdf4" : "#fef2f2", border: `1px solid ${liveFrom ? "#bbf7d0" : "#fecaca"}` }}>
          {liveFrom ? (
            <>
              <b>Live sales evidence begins: {new Date(liveFrom.iso).toLocaleString()}.</b>{" "}
              Earlier Shopify, quote, and production records are retained as pre-launch test evidence but do not
              affect pricing statistics.
              {liveFrom.note ? <div style={{ color: "#166534", marginTop: 4 }}>{liveFrom.note}</div> : null}
            </>
          ) : (
            <b style={{ color: "#991b1b" }}>
              No live-sales start date is set — pre-launch test transactions could be counted as evidence. Set
              pricingEvidenceLiveFrom (owner action) before trusting any counts here.
            </b>
          )}
        </div>
        <Form method="post" style={{ marginTop: 10 }}>
          <input type="hidden" name="intent" value="refreshShopifyEvidence" />
          <button type="submit" disabled={busy} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #d1d5db", background: "#111827", color: "white", fontWeight: 600 }}>
            {busy ? "Refreshing…" : "Refresh Shopify evidence (read-only)"}
          </button>
        </Form>
      </section>

      <section style={{ ...card, borderColor: "#fde68a" }}>
        <h2 style={{ margin: "0 0 6px" }}>DTP (Spektra) economics — vendor cost book {SPEKTRA_COST_BOOK_META.sourceDate}</h2>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#374151" }}>
          Cost source: {SPEKTRA_COST_BOOK_META.source} (observed {SPEKTRA_COST_BOOK_META.sourceDate}); GSO account discount {SPEKTRA_COST_BOOK_META.discount.pct}% ({SPEKTRA_COST_BOOK_META.discount.status}) on the exact public total. Freight: <b>{SPEKTRA_FREIGHT_ASSUMPTION.status}</b> ($85 historical assumption, included in landed cost for comparability only). Public market reference: <b>no DTP market-pricing document is present in the repository</b> — commercial position cannot be stated.
        </p>
        {!SPEKTRA_COST_BOOK_META.researchFilePresent ? (
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "#991b1b", fontWeight: 700 }}>LIVE MATRIX NOT LOADED — {SPEKTRA_COST_BOOK_META.sourceFile} is not in the repository. Current and proposed sell prices cannot be recomputed; every cell below reads REQUEST CURRENT VENDOR QUOTE until the research is committed and generated.</p>
        ) : (
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "#166534", fontWeight: 700 }}>LIVE MATRIX LOADED — {SPEKTRA_COST_BOOK_META.rowCount.toLocaleString()} directly observed rows ({SPEKTRA_COST_BOOK_META.version}).</p>
        )}
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a8a", fontWeight: 700 }}>
          4x5x2 = OWNER-APPROVED DTP ladder 2026-10-06 ($1.30 / $0.71 / $0.46 / $0.37 at 1,000 / 2,500 / 5,000 / 10,000; 25,000 = OWNER PRICING REVIEW REQUIRED; the 1,000 tier is the owner acquisition exception with a $350+ gross-profit target). Market benchmark of record: {DESIGN_AND_CUSTOMIZE_BENCHMARK.competitor} — {DESIGN_AND_CUSTOMIZE_BENCHMARK.status} (published 4x5 Gloss/Matte $1.00 / $0.80 / $0.60 / $0.40 / $0.30 at 1,000 / 1,500 / 2,500 / 5,000 / 10,000; CR zipper +5% → comparable $1.05 / $0.63 / $0.42 / $0.315). GSO position: {GSO_DTP_MARKET_POSITION.label} — {GSO_DTP_MARKET_POSITION.wording}. Competitor prices are market evidence, never GSO costs. 3.5x4.5x2 / 5x5x2 / 6x5x2 / 8x5x2 customer ladders: OWNER PRICING REVIEW REQUIRED (not derived from 4x5x2).
        </p>
        {[{ label: "Comparable configuration (legacy spec): White PET / Soft Touch / no spot / CR zipper / No Tear Notch / 1 SKU", data: dtpEconomics }, { label: "Lowest-cost configuration: White PET / Glossy / no spot / CR zipper / No Tear Notch / 1 SKU", data: dtpEconomicsGlossy }].map(({ label, data }) => (
          <div key={label} style={{ overflowX: "auto", marginBottom: 10 }}>
            <b style={{ fontSize: 12 }}>{label}</b>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead><tr style={{ background: "#f3f4f6" }}><th align="left" style={{ padding: 4 }}>Size</th><th>Qty</th><th>Live vendor unit</th><th>Old seed unit</th><th>Change</th><th>Landed unit (art + $85 unverified)</th><th>Ladder</th><th>Current sell</th><th>Current GM / GP</th><th>Floor / GP target</th><th>D&amp;C comparable CR</th><th>GSO premium</th><th align="left">A hold price</th><th align="left">B pass-through</th><th align="left">C split</th></tr></thead>
              <tbody>
                {data.cells.map((c) => {
                  const p = (k: string) => c.proposals.find((x) => x.key === k);
                  const fmt = (x?: { sellUnit: number; gmPct: number; gp: number; meetsFloor: boolean; meetsMinProfit: boolean }) => (x ? `${x.sellUnit.toFixed(2)} · ${x.gmPct.toFixed(1)}% · ${x.gp.toFixed(0)}${x.meetsFloor ? "" : " BELOW FLOOR"}${x.meetsMinProfit ? "" : " <$500"}` : "—");
                  return (
                    <tr key={`${c.size}-${c.quantity}`} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td style={{ padding: 4 }}><b>{c.size}</b></td><td align="center">{c.quantity.toLocaleString()}</td>
                      <td align="center" style={{ color: c.vendorStatus === "OBSERVED_VENDOR_PRICE" ? "#166534" : "#92400e" }}>{c.vendorUnit != null ? `${c.vendorUnit.toFixed(4)}` : SPEKTRA_COST_STATUS_LABEL[c.vendorStatus as keyof typeof SPEKTRA_COST_STATUS_LABEL]}</td>
                      <td align="center">{c.oldVendorUnit != null ? `${c.oldVendorUnit.toFixed(4)}` : "—"}</td>
                      <td align="center">{c.oldVendorChangePct != null ? `${c.oldVendorChangePct.toFixed(1)}%` : "—"}</td>
                      <td align="center">{c.landedUnit != null ? `${c.landedUnit.toFixed(4)}` : "—"}</td>
                      <td align="center" title={c.ladderNote} style={{ color: c.ladderStatus === "OWNER_APPROVED" ? "#1e3a8a" : "#92400e", fontWeight: 600 }}>{c.ladderStatus === "OWNER_APPROVED" ? "APPROVED 2026-10-06" : "REVIEW REQUIRED"}</td>
                      <td align="center">{c.currentSellUnit != null ? `${c.currentSellUnit.toFixed(2)}` : c.ladderStatus === "OWNER_APPROVED" ? "—" : "no approved price"}</td>
                      <td align="center" style={{ color: c.meetsProtection === false ? "#991b1b" : undefined }}>{c.currentGmPct != null ? `${c.currentGmPct.toFixed(1)}% / ${(c.currentGp ?? 0).toFixed(0)}${c.meetsProtection === false ? " BELOW" : ""}` : "—"}</td>
                      <td align="center">{c.hardFloorPct}% / ${c.minJobProfit}</td>
                      <td align="center">{c.benchmark.competitorComparableUnit != null ? c.benchmark.competitorComparableUnit.toFixed(4) : "—"}</td>
                      <td align="center">{c.benchmark.premiumPct != null ? `+${c.benchmark.premiumPct.toFixed(1)}%` : "—"}</td>
                      <td>{fmt(p("hold_price"))}</td><td>{fmt(p("hold_margin"))}</td><td>{fmt(p("split"))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "#374151" }}>Proposals (shown only for ladders still OWNER PRICING REVIEW REQUIRED; the approved 4x5x2 ladder is decided): A holds today's owner ladder (all vendor savings become margin); B passes the vendor change through (holds the margin the ladder earned on the OLD cost); C splits the improvement. New sizes show the 30/35/38% floor and 40% target anchors only. Nothing here changes a live price — owner decision. Commercial position: NO DTP MARKET REFERENCE IN REPOSITORY.</p>
        <div style={{ overflowX: "auto", display: "none" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ background: "#f3f4f6" }}><th align="left" style={{ padding: 5 }}>Size</th><th align="left">Catalog status</th><th align="left">Owner sell ladder</th>{SPEKTRA_PUBLISHED_TIERS.map((q) => <th key={q}>{q.toLocaleString()}</th>)}</tr></thead>
            <tbody>
              {DTP_CATALOG.map((entry) => (
                <tr key={entry.size} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 5 }}><b>{entry.size}</b>{entry.capacityLabel ? ` (${entry.capacityLabel})` : ""}</td>
                  <td>{entry.status === "CURRENT_STANDARD" ? "current standard" : "LEGACY — no current catalog match"}</td>
                  <td>{entry.ownerLadder === "EXISTS_2026-07-24" ? "exists (2026-07-24)" : "none — owner decision required"}</td>
                  {SPEKTRA_PUBLISHED_TIERS.map((q) => {
                    if (entry.status !== "CURRENT_STANDARD") return <td key={q} align="center" style={{ color: "#6b7280" }}>n/a</td>;
                    const look = lookupSpektraVendorCost({ size: entry.size as any, material: "White PET", finish: "Glossy", spot: "None", zipper: "None", topFeature: "No Tear Notch", clearGusset: false, quantity: q, skuCount: 1 });
                    return <td key={q} align="center" title={look.basis} style={{ color: look.status === "REQUEST_CURRENT_VENDOR_QUOTE" ? "#92400e" : "#166534" }}>{look.wholesaleUnit != null ? `${look.wholesaleUnit.toFixed(4)}` : SPEKTRA_COST_STATUS_LABEL[look.status]}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#6b7280" }}>Reference configuration for the cells: White PET, Glossy, no spot, no zipper, no tear notch, 1 SKU (wholesale unit = exact public total x 0.75 / quantity). Old Spektra seed costs (4x5x2 $0.9897 / $0.4922 / $0.4033 / $0.3232 at 1,000 / 2,500 / 5,000 / 7,500, etc.) remain on the historical VendorProduct rows for old quotes and are not comparable until the live matrix is loaded.</p>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#374151" }}><b>Shaped / die-cut pouches ({DTP_SHAPED_BAG_POLICY_SOURCE}):</b> base = the standard DTP customer price for the same configuration; +{DTP_CUSTOM_SHAPE_SURCHARGE_PCT}% shape surcharge on the product price; ${DTP_NEW_DIE_TOOLING_FEE} per unique NEW die shown as a separate tooling line; existing die on file = $0 tooling; shaped MOQ {DTP_SHAPED_MOQ.toLocaleString()}; same physical shape with several designs = one fee, a different physical shape = a new fee (surcharge still applies).</p>
      </section>

      <section style={{ ...card, borderColor: "#c7d2fe" }}>
        <h2 style={{ margin: "0 0 6px" }}>PROPOSED OWNER PRICING — remaining DTP sizes + 25,000 tier ({dtpProposals.status})</h2>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#374151" }}>
          Method (owner direction 2026-10-07): the OWNER-APPROVED 4x5x2 ladder is the market anchor (Design &amp; Customize 4x5 = controlling competitor). Each size is priced from its REAL live Spektra landed-cost difference versus 4x5x2 at the same quantity (G = GP parity), lifted where the 30/35/38% floors (H) or the $500 job-profit rule (I) need more, then commercially rounded. Landed = live product cost + art $8.33 + freight $85 (UNVERIFIED). Nothing here is read by the quote engine until the owner approves it. {dtpProposals.marketNote}
        </p>
        {dtpProposals.anchor.recommended25k ? (
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a8a", fontWeight: 600 }}>
            4x5x2 at 25,000 — RECOMMENDED {"$"}{dtpProposals.anchor.recommended25k.price.toFixed(2)} ({dtpProposals.anchor.recommended25k.method}; landed {"$"}{dtpProposals.anchor.recommended25k.landedUnit.toFixed(4)}/unit; GM {dtpProposals.anchor.recommended25k.gmPct.toFixed(1)}% / GP {"$"}{dtpProposals.anchor.recommended25k.gp.toFixed(0)}; boundary drop vs 24,999 x {"$"}{dtpProposals.anchor.recommended25k.continuity.priceAt10k.toFixed(2)}: {dtpProposals.anchor.recommended25k.continuity.boundaryDropPct}%). {dtpProposals.anchor.recommended25k.status}. {dtpProposals.anchor.recommended25k.competitor}.
          </p>
        ) : null}
        {dtpProposals.ladders.map((ladder) => (
          <div key={ladder.size} style={{ overflowX: "auto", marginBottom: 12 }}>
            <b style={{ fontSize: 12 }}>{ladder.size}{ladder.capacityLabel ? ` (${ladder.capacityLabel})` : ""} — {ladder.status}</b>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead><tr style={{ background: "#f3f4f6" }}><th style={{ padding: 4 }}>Qty</th><th>A product</th><th>B art</th><th>C freight</th><th>D landed total</th><th>D landed/unit</th><th>E 4x5 anchor</th><th>F Δ landed/unit</th><th>G GP parity</th><th>H floor</th><th>I $500 GP</th><th>PROPOSED</th><th>GM / GP</th><th>Floor</th><th>D&amp;C 4x5 CR ref</th></tr></thead>
              <tbody>
                {ladder.rows.map((r) => (
                  <tr key={r.quantity} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td align="center" style={{ padding: 4 }}>{r.quantity.toLocaleString()}</td>
                    <td align="center">{r.A_productCost != null ? r.A_productCost.toFixed(2) : "—"}</td>
                    <td align="center">{r.B_art.toFixed(2)}</td>
                    <td align="center">{r.C_freight} (unverified)</td>
                    <td align="center">{r.D_landedTotal != null ? r.D_landedTotal.toFixed(2) : "—"}</td>
                    <td align="center">{r.D_landedUnit != null ? r.D_landedUnit.toFixed(4) : "—"}</td>
                    <td align="center">{r.E_anchorPrice != null ? `${r.E_anchorPrice.toFixed(2)}${r.E_anchorBasis.includes("RECOMMENDATION") ? " (rec.)" : ""}` : "—"}</td>
                    <td align="center">{r.F_landedDeltaUnit != null ? `${r.F_landedDeltaUnit >= 0 ? "+" : ""}${r.F_landedDeltaUnit.toFixed(4)} (${r.F_landedDeltaPct}%)` : "—"}</td>
                    <td align="center">{r.G_gpParityPrice != null ? r.G_gpParityPrice.toFixed(4) : "—"}</td>
                    <td align="center">{r.H_floorPrice != null ? r.H_floorPrice.toFixed(4) : "—"}</td>
                    <td align="center">{r.I_minProfitPrice != null ? r.I_minProfitPrice.toFixed(4) : "—"}</td>
                    <td align="center" style={{ fontWeight: 700, color: "#1e3a8a" }}>{r.proposed ? r.proposed.price.toFixed(2) : "—"}</td>
                    <td align="center">{r.proposed ? `${r.proposed.gmPct.toFixed(1)}% / ${r.proposed.gp.toFixed(0)}` : "—"}</td>
                    <td align="center">{r.floorPct}%</td>
                    <td align="center" title="Design & Customize 4x5 comparable CR reference; exact-size competitor NOT CURRENTLY VERIFIED">{r.benchmarkComparableCrUnit != null ? r.benchmarkComparableCrUnit.toFixed(3) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ladder.rows[0]?.acquisitionOption ? (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#92400e" }}>
                1,000 optional acquisition price (NOT inherited from 4x5x2; needs an explicit owner exception): {"$"}{ladder.rows[0].acquisitionOption.price.toFixed(2)} — {ladder.rows[0].acquisitionOption.gmPct.toFixed(1)}% / GP {"$"}{ladder.rows[0].acquisitionOption.gp.toFixed(0)} ({"$"}{ladder.rows[0].acquisitionOption.gpBelowNormalTarget.toFixed(0)} below the $500 target). {ladder.rows[0].acquisitionOption.recommendation}
              </p>
            ) : null}
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#374151" }}>Continuity (order-total drop at each step vs one unit below; reference = the approved 4x5x2 steps): {ladder.continuity.map((c) => `${c.fromQty.toLocaleString()}→${c.toQty.toLocaleString()} ${c.dropPct}%${c.cliff ? " CLIFF" : ""}`).join(" · ")}. Exact-size competitor: NOT CURRENTLY VERIFIED.</p>
          </div>
        ))}
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 10px" }}>Summary</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={stat}><b>{totals.reviewed}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local line items reviewed</div></div>
          <div style={stat}><b>{totals.eligible}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local ERP eligible evidence</div></div>
          <div style={stat}><b>{shopify.eligible}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify eligible evidence</div></div>
          <div style={stat}><b>{shopify.excluded.length}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify excluded</div></div>
          <div style={stat}><b>{shopify.incomplete.length}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Shopify incomplete price</div></div>
          <div style={{ ...stat, borderColor: "#fde68a", background: "#fffbeb" }}><b>{preLaunch.total}</b><div style={{ fontSize: 12, color: "#92400e" }}>Pre-launch test evidence</div></div>
          <div style={stat}><b>{totals.excluded}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local excluded test records</div></div>
          <div style={stat}><b>{totals.won}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local accepted / won</div></div>
          <div style={stat}><b>{totals.lost}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local lost / canceled / expired</div></div>
          <div style={stat}><b>{totals.open}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Local pending / open</div></div>
          <div style={stat}><b>{totals.distinctCustomers}</b><div style={{ fontSize: 12, color: "#6b7280" }}>Distinct customers (count only)</div></div>
        </div>
      </section>

      {review.length > 0 ? (
        <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
          <h2 style={{ margin: "0 0 6px" }}>Staff review — suspicious but not auto-excluded</h2>
          <p style={{ fontSize: 13, color: "#92400e", margin: "0 0 8px" }}>
            These records STILL COUNT as evidence. Only deterministic rules exclude automatically; anything that
            needs judgment lands here instead. No customer names or emails are shown — identifiers are internal ids.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
            {review.map((item: any, index: number) => (
              <li key={index}>
                <b>[{item.source}]</b> {item.id} — {item.reason}. <i>Suggested: {item.suggestedAction}.</i>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Evidence readiness by basket</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Baskets never mix: finished vs label-only, one- vs double-sided, standard vs specialty finishes, and 4X is
          never treated as 3X. Unknown attributes form their own segments. Sources stay distinguishable (ERP vs
          Shopify) while combining toward the thresholds. Accepted low/median/high appear ONLY when all three
          thresholds pass — and even then they are advisory display, never a market target.
        </p>
        {baskets.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No eligible evidence yet — mark quotes Won/Lost on the Quotes board and refresh Shopify evidence above.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: 6, textAlign: "left" }}>Basket</th>
                  <th>ERP</th><th>Shopify</th><th>Combined accepted</th>
                  <th>Exact</th><th>Near</th><th>Lost</th><th>Open</th>
                  <th>Customers</th><th>Months</th><th>First</th><th>Latest</th>
                  <th style={{ textAlign: "left" }}>Confidence</th>
                  <th>Low / Median / High</th>
                </tr>
              </thead>
              <tbody>
                {baskets.map((basket) => (
                  <tr key={basket.key} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, maxWidth: 360 }}>{basket.key}</td>
                    <td align="center">{basket.sourceCounts.erp_quote + basket.sourceCounts.production_job}</td>
                    <td align="center">{basket.sourceCounts.shopify_order}</td>
                    <td align="center"><b>{basket.accepted}</b></td>
                    <td align="center">{basket.exactMatches}</td>
                    <td align="center">{basket.nearMatches}</td>
                    <td align="center">{basket.lost}</td>
                    <td align="center">{basket.open}</td>
                    <td align="center">{basket.distinctCustomers}</td>
                    <td align="center">{basket.distinctMonths}</td>
                    <td align="center">{basket.earliest || "—"}</td>
                    <td align="center">{basket.latest || "—"}</td>
                    <td style={{ color: basket.confidence.eligible ? "#166534" : "#92400e" }}>{basket.confidence.message}</td>
                    <td align="center">
                      {basket.confidence.eligible && basket.acceptedMedian != null
                        ? `$${basket.acceptedLow?.toFixed(2)} / $${basket.acceptedMedian?.toFixed(2)} / $${basket.acceptedHigh?.toFixed(2)}`
                        : "withheld (thresholds not met)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Excluded / incomplete records</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 8px" }}>
          Conservative shared exclusion (one helper everywhere) plus Shopify-specific rules: test orders, canceled,
          not-paid financial statuses, fully refunded orders, refunded lines, gift cards, free/zero-net lines, and
          unclassifiable lines. Incomplete-price rows (discount allocation unavailable) NEVER enter medians.
          Since 15F.0K.4G, production-job twins of counted Shopify sales are excluded as "Duplicate of Shopify
          order-line evidence" (one sale = one row; Shopify wins with its realized net price), and ERP jobs created
          by Shopify TEST orders are excluded as "Paid by Shopify test order" via exact id joins.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14, fontSize: 12 }}>
          <div>
            <b>Local ERP ({excluded.length} shown)</b>
            {excluded.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {excluded.map((row, index) => <li key={index}><b>{row.label || "(unnamed)"}</b> ({row.source}) — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
          <div>
            <b>Shopify excluded ({shopify.excluded.length} shown)</b>
            {shopify.excluded.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {shopify.excluded.map((row: any, index: number) => <li key={index}><b>{row.label}</b> — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
          <div>
            <b>Shopify incomplete price ({shopify.incomplete.length} shown)</b>
            {shopify.incomplete.length === 0 ? <p style={{ color: "#6b7280" }}>None.</p> : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {shopify.incomplete.map((row: any, index: number) => <li key={index}><b>{row.label}</b> — {row.reasons.join("; ")}</li>)}
              </ul>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
