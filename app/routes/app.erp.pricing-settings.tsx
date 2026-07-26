import type React from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  OWNER_CONFIG_MIN_NOTE_LENGTH,
  PRICING_AREA_FLOOR_BANDS_KEY,
  PRICING_MARGIN_CURVES_KEY,
  PRICING_MIN_GROSS_PROFIT_KEY,
  PRICING_MIN_ORDER_TOTALS_KEY,
  PRICING_TIER_LADDERS_KEY,
  clearOwnerConfigKey,
  ownerConfigKeyDefinition,
  resolvePricingPolicyConfig,
  restoreOwnerConfigPrevious,
  saveOwnerConfigKey,
} from "../lib/owner-config.server";
import {
  FAMILY_COMMERCIAL_POLICIES,
  MARGIN_CURVE_CONFIGURABLE_KEYS,
  MARGIN_CURVE_VARIANT_BASE,
  defaultPricingPolicyValues,
} from "../lib/commercial-pricing-policy.server";
import { FAMILY_MARGIN_RULES } from "../lib/calculator-emergency.server";
import { resolveActorFromSession } from "../lib/actual-cost-finalize.server";

// Pricing Settings (15F.0K.1) — the FIRST ownerConfig surface. Scope is
// deliberately narrow: the three provisional value groups the commercial
// pricing policy already uses (minimum gross profits, minimum order totals,
// sticker area-floor bands) become owner-editable with validated JSON
// envelopes, actor + note audit, and one-step rollback. Everything else
// (margin curves, market targets, unit-price floors, rounding, override
// rules) stays code-only until its later 15F.0K phase. With no saved config,
// pricing is byte-for-byte identical to the code constants.
//
// Client/server split rule (12B.1a / 13A.7B convention): the component below
// consumes ONLY loader data — key strings, defaults, and resolutions all
// travel through the loader so no .server export is referenced client-side.

const MAX_BAND_ROWS = 8;

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const resolved = await resolvePricingPolicyConfig(db, shop);
  const ruleLabel = (key: string) => FAMILY_MARGIN_RULES.find((rule) => rule.key === key)?.label || key;
  return {
    resolutions: resolved.resolutions,
    effective: resolved.values,
    defaults: defaultPricingPolicyValues(),
    families: FAMILY_COMMERCIAL_POLICIES.map((policy) => ({ key: policy.familyKey, label: policy.label })),
    // 15F.0K.2-A: configurable margin families (DTP + provisional excluded)
    // plus the optional allowlisted variant rows (bags-4x5-double).
    marginFamilies: MARGIN_CURVE_CONFIGURABLE_KEYS.map((key) => ({ key, label: ruleLabel(key), optional: false })),
    marginVariants: Object.entries(MARGIN_CURVE_VARIANT_BASE).map(([key, baseKey]) => ({ key, baseKey, label: `${ruleLabel(baseKey)} — DOUBLE-SIDED variant (optional; blank = use the base curve)`, optional: true })),
    minNoteLength: OWNER_CONFIG_MIN_NOTE_LENGTH,
    keys: {
      minGrossProfit: PRICING_MIN_GROSS_PROFIT_KEY,
      minOrderTotals: PRICING_MIN_ORDER_TOTALS_KEY,
      areaFloorBands: PRICING_AREA_FLOOR_BANDS_KEY,
      marginCurves: PRICING_MARGIN_CURVES_KEY,
      tierLadders: PRICING_TIER_LADDERS_KEY,
    },
    maxBandRows: MAX_BAND_ROWS,
  };
}

// "1:65, 128:58, 256:52" -> [{minQty:1,targetPct:65}, ...]; malformed tokens
// become NaN fields the validator rejects with an exact message.
function parseBandPairsText(text: string): unknown[] {
  return String(text || "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      const [minRaw, pctRaw] = token.split(":").map((part) => String(part ?? "").trim());
      return { minQty: minRaw === "" ? Number.NaN : Number(minRaw), targetPct: pctRaw == null || pctRaw === "" ? Number.NaN : Number(pctRaw) };
    });
}

function parseMarginCurvesForm(form: FormData): unknown {
  const families: Record<string, unknown> = {};
  for (const key of MARGIN_CURVE_CONFIGURABLE_KEYS) {
    const minRaw = String(form.get(`curve_min_${key}`) ?? "").trim();
    families[key] = {
      familyMinPct: minRaw === "" ? Number.NaN : Number(minRaw),
      bands: parseBandPairsText(String(form.get(`curve_bands_${key}`) ?? "")),
    };
  }
  for (const key of Object.keys(MARGIN_CURVE_VARIANT_BASE)) {
    const minRaw = String(form.get(`curve_min_${key}`) ?? "").trim();
    const bandsRaw = String(form.get(`curve_bands_${key}`) ?? "").trim();
    if (minRaw === "" && bandsRaw === "") continue; // optional variant left absent
    families[key] = { familyMinPct: minRaw === "" ? Number.NaN : Number(minRaw), bands: parseBandPairsText(bandsRaw) };
  }
  return { families };
}

function parseLadderText(text: string): unknown[] {
  return String(text || "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => Number(token));
}

function parseTierLaddersForm(form: FormData, familyKeys: string[]): unknown {
  const families: Record<string, unknown> = {};
  for (const family of familyKeys) families[family] = parseLadderText(String(form.get(`ladder_${family}`) ?? ""));
  return { defaultLadder: parseLadderText(String(form.get("ladder_default") ?? "")), families };
}

function parseMoneyMapForm(form: FormData, families: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const family of families) {
    const raw = String(form.get(`money_${family}`) ?? "").trim();
    if (raw === "") {
      payload[family] = null;
    } else {
      payload[family] = Number(raw); // NaN flows to the validator -> exact refusal message
    }
  }
  return payload;
}

function parseBandsForm(form: FormData): unknown[] {
  const rows: unknown[] = [];
  for (let index = 0; index < MAX_BAND_ROWS; index += 1) {
    const maxRaw = String(form.get(`band_max_${index}`) ?? "").trim();
    const rateRaw = String(form.get(`band_rate_${index}`) ?? "").trim();
    if (maxRaw === "" && rateRaw === "") continue; // untouched row
    rows.push({
      maxSqft: maxRaw === "" ? null : Number(maxRaw),
      ratePerSqft: rateRaw === "" ? Number.NaN : Number(rateRaw),
    });
  }
  return rows;
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = resolveActorFromSession(session, shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const key = String(form.get("key") || "");
  const definition = ownerConfigKeyDefinition(key);
  if (!definition) return Response.json({ ok: false, message: "Unknown settings key." });

  if (intent === "save") {
    const note = String(form.get("note") || "");
    const familyKeys = FAMILY_COMMERCIAL_POLICIES.map((policy) => policy.familyKey);
    const payload = key === PRICING_AREA_FLOOR_BANDS_KEY
      ? parseBandsForm(form)
      : key === PRICING_MARGIN_CURVES_KEY
        ? parseMarginCurvesForm(form)
        : key === PRICING_TIER_LADDERS_KEY
          ? parseTierLaddersForm(form, familyKeys)
          : parseMoneyMapForm(form, familyKeys);
    const result = await saveOwnerConfigKey(db, { shop, key, payload, note, actor });
    return Response.json(result);
  }
  if (intent === "restore") {
    const result = await restoreOwnerConfigPrevious(db, { shop, key, actor });
    return Response.json(result);
  }
  if (intent === "clear") {
    if (String(form.get("confirm_clear") || "") !== "on") {
      return Response.json({ ok: false, message: "Tick the confirmation box to reset this group to code defaults." });
    }
    const result = await clearOwnerConfigKey(db, { shop, key });
    return Response.json(result);
  }
  return Response.json({ ok: false, message: "Unknown action." });
}

const card: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" };
const inputStyle: React.CSSProperties = { width: "100%", padding: 8, border: "1px solid #d1d5db", borderRadius: 8 };
const chip: React.CSSProperties = { display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 };
const buttonStyle: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, border: "1px solid #d1d5db", background: "#111827", color: "white", fontWeight: 600 };
const secondaryButton: React.CSSProperties = { padding: "8px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "white" };

const SOURCE_STYLE: Record<string, React.CSSProperties> = {
  owner_config: { ...chip, background: "#dcfce7", color: "#166534" },
  code_fallback: { ...chip, background: "#e0e7ff", color: "#3730a3" },
  invalid_config_fallback: { ...chip, background: "#fee2e2", color: "#991b1b" },
};
const SOURCE_LABEL: Record<string, string> = {
  owner_config: "Owner config (saved value in use)",
  code_fallback: "Code default (no saved value)",
  invalid_config_fallback: "INVALID saved value — code default in use",
};

function SourceBadge({ resolution }: { resolution: any }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={SOURCE_STYLE[resolution.source] || chip}>{SOURCE_LABEL[resolution.source] || resolution.source}</span>
      {resolution.invalidReason ? <div style={{ color: "#991b1b", fontSize: 13, marginTop: 4 }}>Why invalid: {resolution.invalidReason}</div> : null}
      {resolution.envelopeInfo ? (
        <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
          Last saved {new Date(resolution.envelopeInfo.updatedAt).toLocaleString()} by {resolution.envelopeInfo.updatedBy}
          {resolution.envelopeInfo.note ? <> — note: “{resolution.envelopeInfo.note}”</> : null}
          {resolution.envelopeInfo.hasPrevious ? <> · previous version stored (one-step restore available)</> : <> · no previous version yet</>}
        </div>
      ) : null}
    </div>
  );
}

function EnvelopeActions({ keyName, resolution, busy }: { keyName: string; resolution: any; busy: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
      {resolution.envelopeInfo?.hasPrevious ? (
        <Form method="post">
          <input type="hidden" name="intent" value="restore" />
          <input type="hidden" name="key" value={keyName} />
          <button type="submit" style={secondaryButton} disabled={busy}>Restore previous version</button>
        </Form>
      ) : null}
      {resolution.envelopeInfo || resolution.source === "invalid_config_fallback" ? (
        <Form method="post" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="hidden" name="intent" value="clear" />
          <input type="hidden" name="key" value={keyName} />
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" name="confirm_clear" /> confirm
          </label>
          <button type="submit" style={{ ...secondaryButton, color: "#991b1b", borderColor: "#fecaca" }} disabled={busy}>Reset to code defaults</button>
        </Form>
      ) : null}
    </div>
  );
}

function MoneyMapSection({ title, keyName, resolution, effective, defaults, families, minNoteLength, busy, helpText }: {
  title: string;
  keyName: string;
  resolution: any;
  effective: Record<string, number | null>;
  defaults: Record<string, number | null>;
  families: Array<{ key: string; label: string }>;
  minNoteLength: number;
  busy: boolean;
  helpText: string;
}) {
  return (
    <section style={card}>
      <h2 style={{ margin: "0 0 6px" }}>{title}</h2>
      <SourceBadge resolution={resolution} />
      <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>{helpText} Blank = no minimum for that family (candidate skipped). Every save requires a source note.</p>
      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="key" value={keyName} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {families.map((family) => (
            <label key={family.key} style={{ fontSize: 13 }}>
              {family.label}
              <input
                name={`money_${family.key}`}
                defaultValue={effective[family.key] == null ? "" : String(effective[family.key])}
                placeholder={defaults[family.key] == null ? "code default: none" : `code default: ${defaults[family.key]}`}
                inputMode="decimal"
                style={inputStyle}
              />
            </label>
          ))}
        </div>
        <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>
          Change note (required, min {minNoteLength} characters — why is this value changing?)
          <input name="note" style={inputStyle} placeholder="e.g. Ratified 15F.0-FINAL provisional values after review" />
        </label>
        <div style={{ marginTop: 10 }}>
          <button type="submit" style={buttonStyle} disabled={busy}>Save {title.toLowerCase()}</button>
        </div>
      </Form>
      <EnvelopeActions keyName={keyName} resolution={resolution} busy={busy} />
    </section>
  );
}

export default function PricingSettings() {
  const { resolutions, effective, defaults, families, marginFamilies, marginVariants, minNoteLength, keys, maxBandRows } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const bandsResolution = resolutions[keys.areaFloorBands];
  const effectiveBands = effective.areaFloorBands;
  const defaultBandsText = defaults.areaFloorBands
    .map((band) => `${band.maxSqft == null ? "rest" : `<${band.maxSqft}`}: $${band.ratePerSqft}`)
    .join(" · ");

  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#1e3a5f)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Pricing Settings (owner config)</h1>
        <p style={{ margin: "8px 0 0", fontSize: 14 }}>
          Phase 15F.0K.1 — these three groups now read from owner configuration with validated envelopes, actor + note
          audit, and one-step restore. <b>With nothing saved, pricing uses the code defaults and is byte-for-byte
          identical to before.</b> Invalid or corrupt saved values automatically fall back to the code defaults and are
          flagged below — a bad value can never zero out or corrupt a price.
        </p>
      </section>

      {actionData?.message ? (
        <section style={{ ...card, borderColor: actionData.ok ? "#bbf7d0" : "#fecaca", background: actionData.ok ? "#f0fdf4" : "#fef2f2" }}>
          <b style={{ color: actionData.ok ? "#166534" : "#991b1b" }}>{actionData.message}</b>
        </section>
      ) : null}

      <section style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
        <b>What is editable (15F.0K.1 + 15F.0K.2 Stage A)</b>
        <ul style={{ fontSize: 13, margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.8 }}>
          <li>Minimum gross-profit floors, minimum order totals, and the sticker area-floor bands (15F.0K.1).</li>
          <li>Per-family margin curves (quantity bands) and displayed tier quantity ladders (15F.0K.2 Stage A) — defaults reproduce today's behavior exactly; the approved research values load in a separate reviewed step.</li>
          <li><b>Not yet editable</b> (later phases, deliberately): minimum unit-price floors, market targets and crossover warnings (15F.0K.3), rounding and override rules (15F.0K.3/4).</li>
          <li>DTP pouch pricing (owner ladders, floors, margin thresholds, design fees) is completely untouched by this page — DTP keys are rejected by validation.</li>
          <li>Changing a value here changes live quote prices for new calculations. Historical quotes and snapshots are never rewritten.</li>
        </ul>
      </section>

      <MoneyMapSection
        title="Minimum gross-profit floors"
        keyName={keys.minGrossProfit}
        resolution={resolutions[keys.minGrossProfit]}
        effective={effective.minimumGrossProfit}
        defaults={defaults.minimumGrossProfit}
        families={families}
        minNoteLength={minNoteLength}
        busy={busy}
        helpText="Dollar minimum gross profit per job, by family — the price candidate is (job cost + this amount)."
      />

      <MoneyMapSection
        title="Minimum order totals"
        keyName={keys.minOrderTotals}
        resolution={resolutions[keys.minOrderTotals]}
        effective={effective.minimumOrderTotals}
        defaults={defaults.minimumOrderTotals}
        families={families}
        minNoteLength={minNoteLength}
        busy={busy}
        helpText="Flat minimum order total per job, by family — the price candidate is this amount."
      />

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Sticker area market floor bands</h2>
        <SourceBadge resolution={bandsResolution} />
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Stickers &amp; Labels only: floor = $/sqft (banded by TOTAL finished sqft) × finished sqft + full setup
          recovery. Rows must ascend by Max sqft; leave Max sqft blank on the LAST filled row only (open-ended band).
          Code defaults: {defaultBandsText}.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="key" value={keys.areaFloorBands} />
          <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                <th style={{ padding: 6, textAlign: "left" }}>Band</th>
                <th style={{ padding: 6, textAlign: "left" }}>Max total finished sqft (blank = open-ended last band)</th>
                <th style={{ padding: 6, textAlign: "left" }}>$ per sqft</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: maxBandRows }, (_v, index) => {
                const band = effectiveBands[index];
                return (
                  <tr key={index} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6 }}>{index + 1}</td>
                    <td style={{ padding: 6 }}>
                      <input name={`band_max_${index}`} defaultValue={band ? (band.maxSqft == null ? "" : String(band.maxSqft)) : ""} inputMode="decimal" style={{ ...inputStyle, width: 220 }} />
                    </td>
                    <td style={{ padding: 6 }}>
                      <input name={`band_rate_${index}`} defaultValue={band ? String(band.ratePerSqft) : ""} inputMode="decimal" style={{ ...inputStyle, width: 140 }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label style={{ display: "block", fontSize: 13, marginTop: 10, maxWidth: 640 }}>
            Change note (required, min {minNoteLength} characters)
            <input name="note" style={inputStyle} placeholder="e.g. Raised low-end anchor after market re-check" />
          </label>
          <div style={{ marginTop: 10 }}>
            <button type="submit" style={buttonStyle} disabled={busy}>Save area floor bands</button>
          </div>
        </Form>
        <EnvelopeActions keyName={keys.areaFloorBands} resolution={bandsResolution} busy={busy} />
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Per-family margin curves (quantity bands)</h2>
        <SourceBadge resolution={resolutions[keys.marginCurves]} />
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Bands format: <code>minQty:targetPct, minQty:targetPct, …</code> — the last band whose minQty ≤ the quote
          quantity applies. The first band must start at minQty 1; targets are 40–95% and never below the family
          minimum. Stage-A defaults reproduce the current five-point curves exactly (bands at 1/128/256/640/1000).
          DTP margins are code-only and deliberately not listed. The double-sided variant row is optional — leave it
          blank and double-sided 4x5 bags keep pricing on the single-sided curve (current behavior).
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="key" value={keys.marginCurves} />
          <div style={{ display: "grid", gap: 10 }}>
            {[...marginFamilies, ...marginVariants].map((family) => {
              const entry = effective.marginCurves.families[family.key];
              return (
                <div key={family.key} style={{ display: "grid", gridTemplateColumns: "260px 140px 1fr", gap: 10, alignItems: "end" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{family.label}{family.optional ? "" : ""}</div>
                  <label style={{ fontSize: 12 }}>
                    Family min %
                    <input name={`curve_min_${family.key}`} defaultValue={entry ? String(entry.familyMinPct) : ""} placeholder={family.optional ? "blank = not set" : ""} inputMode="decimal" style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 12 }}>
                    Bands (minQty:targetPct, …)
                    <input name={`curve_bands_${family.key}`} defaultValue={entry ? entry.bands.map((band) => `${band.minQty}:${band.targetPct}`).join(", ") : ""} placeholder={family.optional ? "blank = use base curve" : ""} style={inputStyle} />
                  </label>
                </div>
              );
            })}
          </div>
          <label style={{ display: "block", fontSize: 13, marginTop: 10, maxWidth: 640 }}>
            Change note (required, min {minNoteLength} characters)
            <input name="note" style={inputStyle} placeholder="e.g. Stage-B research calibration for 4x5 bags (approved)" />
          </label>
          <div style={{ marginTop: 10 }}>
            <button type="submit" style={buttonStyle} disabled={busy}>Save margin curves</button>
          </div>
        </Form>
        <EnvelopeActions keyName={keys.marginCurves} resolution={resolutions[keys.marginCurves]} busy={busy} />
      </section>

      <section style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Displayed tier quantity ladders</h2>
        <SourceBadge resolution={resolutions[keys.tierLadders]} />
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 10px" }}>
          Comma-separated quantities shown as tier rows when no manual "Tier quantities" list is entered in the
          calculator's Advanced controls (a manual list still wins). The requested quantity is always added as its own
          row. Stage-A default for every family: 64, 128, 256, 640, 1000. The DTP ladder (1000/2500/5000/7500/10000)
          is code-only.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="key" value={keys.tierLadders} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            <label style={{ fontSize: 13 }}>
              Default ladder (fallback)
              <input name="ladder_default" defaultValue={effective.tierLadders.defaultLadder.join(", ")} style={inputStyle} />
            </label>
            {families.map((family) => (
              <label key={family.key} style={{ fontSize: 13 }}>
                {family.label}
                <input name={`ladder_${family.key}`} defaultValue={(effective.tierLadders.families[family.key] || effective.tierLadders.defaultLadder).join(", ")} style={inputStyle} />
              </label>
            ))}
          </div>
          <label style={{ display: "block", fontSize: 13, marginTop: 10, maxWidth: 640 }}>
            Change note (required, min {minNoteLength} characters)
            <input name="note" style={inputStyle} placeholder="e.g. Added approved 11-point bag ladder (Stage B)" />
          </label>
          <div style={{ marginTop: 10 }}>
            <button type="submit" style={buttonStyle} disabled={busy}>Save tier ladders</button>
          </div>
        </Form>
        <EnvelopeActions keyName={keys.tierLadders} resolution={resolutions[keys.tierLadders]} busy={busy} />
      </section>

      <section style={card}>
        <b>Safety contract</b>
        <ul style={{ fontSize: 13, margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.8 }}>
          <li>Missing value → code default (source “Code default”).</li>
          <li>Invalid/corrupt value → code default (source “INVALID saved value”), with the exact reason shown above.</li>
          <li>Validation is all-or-nothing per group: a save is either fully valid or refused with the reason — partial merges never happen.</li>
          <li>Every save records the acting staff session and the required note; the prior valid version is kept for one-step restore.</li>
          <li>All reads and writes are shop-scoped. No Shopify data is touched. No migration — values live in ErpAdminSetting.</li>
        </ul>
      </section>
    </main>
  );
}
