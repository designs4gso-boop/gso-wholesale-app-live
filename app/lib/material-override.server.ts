// 2026-11-11 — OWNER JOB-LEVEL MATERIAL $/SQFT OVERRIDE (owner-approved).
//
// An emergency escape for ONE quote/job whose selected canonical material has
// no defensible cost basis yet. Contract:
//   - owner-only (verified Shopify session identity; re-checked here even
//     though the calculator itself is owner-gated),
//   - explicit positive $/sqft and a written reason, both required,
//   - affects ONLY this job's costing input: nothing here writes Material
//     Center, VendorProduct or any global standard, and the value lives only
//     in the request and the saved snapshot — it never becomes a default,
//   - the SERVER recomputes the whole job with the value (never posted
//     totals) and the result is labelled OVERRIDE,
//   - the snapshot records value, reason, owner user ID and time, so a later
//     global material change never rewrites the saved quote.
//
// It overrides COST only. Geometry is never invented: the roll width must come
// from an approved roll or the shop's own Material Center record, and the job
// must use exactly one canonical material.

import { LABEL_MATERIALS, type VerifiedLabelMaterial } from "./label-cost-inputs.server";
import { MATERIAL_CANONICAL_KEY_PREFIX } from "./material-calculator-readiness.server";
import { resolveOwnerAuthorization } from "./owner-authorization.server";

export const MATERIAL_OVERRIDE_PARAM = "pmatovr";
export const MATERIAL_OVERRIDE_REASON_PARAM = "pmatovrreason";
export const MATERIAL_OVERRIDE_KEY_PREFIX = "override:";
export const MATERIAL_OVERRIDE_MIN_REASON = 8;
/** Sanity ceiling — a typo guard, not a price rule. */
export const MATERIAL_OVERRIDE_MAX_PER_SQFT = 50;

export const MATERIAL_OVERRIDE_REASONS = {
  ownerOnly: "MATERIAL_OVERRIDE_OWNER_ONLY",
  invalid: "MATERIAL_OVERRIDE_INVALID",
  singleMaterial: "MATERIAL_OVERRIDE_SINGLE_MATERIAL_ONLY",
  geometryRequired: "MATERIAL_OVERRIDE_GEOMETRY_REQUIRED",
  unsupportedFamily: "MATERIAL_OVERRIDE_FAMILY_UNSUPPORTED",
  applied: "OWNER_JOB_MATERIAL_OVERRIDE",
} as const;

export type MaterialOverrideRequest = { costPerSqft: number | null; reason: string };

export type AppliedMaterialOverride = {
  costPerSqft: number;
  reason: string;
  ownerUserId: string;
  /** The canonical material the override replaced (e.g. "matte", "material:<id>"). */
  replacedMaterialKey: string;
  replacedMaterialLabel: string;
  rollWidthIn: number;
};

type OverridableInput = {
  family: string;
  materialOverrideRequest?: MaterialOverrideRequest | null;
  materialOverride?: AppliedMaterialOverride | null;
  materialOverrideBlocker?: string | null;
  labels?: { lines: Array<{ materialKey: string }>; materials?: Record<string, VerifiedLabelMaterial> };
  bags?: { materialKey?: string | null; materialId?: string | null; materials?: Record<string, VerifiedLabelMaterial>; materialMissing?: string[] };
  jar?: { materialKey?: string | null; materialId?: string | null; materials?: Record<string, VerifiedLabelMaterial>; materialMissing?: string[] };
};

/** Read the (untrusted) request from the query string. Nothing is applied here. */
export function readMaterialOverrideRequest(params: URLSearchParams): MaterialOverrideRequest | null {
  const raw = String(params.get(MATERIAL_OVERRIDE_PARAM) ?? "").trim();
  const reason = String(params.get(MATERIAL_OVERRIDE_REASON_PARAM) ?? "").trim();
  if (!raw && !reason) return null;
  const value = Number(raw);
  return { costPerSqft: raw && Number.isFinite(value) ? value : null, reason };
}

const BAG_FAMILIES = new Set(["sticker-bags", "stock-bags", "split-bags"]);
const JAR_FAMILIES = new Set(["standard-jars", "premium-jars"]);

/**
 * Server side: validate the request against the VERIFIED owner identity and
 * rewrite this job's material to an override-only material. Runs AFTER
 * attachVerifiedLabelMaterials so it replaces whatever the server resolved.
 */
export async function applyOwnerMaterialOverride<T extends OverridableInput>(
  deps: { db: any; shop: string },
  input: T,
  auth: { session?: any; sessionToken?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  const request = input.materialOverrideRequest;
  if (!request) return input;
  const blocked = (code: string, message: string): T => ({ ...input, materialOverride: null, materialOverrideBlocker: `${code}: ${message}` });

  const owner = resolveOwnerAuthorization(auth, env);
  if (!owner.isOwner || !owner.userId) {
    return blocked(MATERIAL_OVERRIDE_REASONS.ownerOnly, "only an authorized owner can override a material cost. The job is not costed with the override.");
  }
  const value = request.costPerSqft;
  if (value == null || !Number.isFinite(value) || value <= 0 || value > MATERIAL_OVERRIDE_MAX_PER_SQFT) {
    return blocked(MATERIAL_OVERRIDE_REASONS.invalid, `the override must be an explicit $/sqft greater than 0 and at most ${MATERIAL_OVERRIDE_MAX_PER_SQFT} (received ${request.costPerSqft ?? "nothing"}).`);
  }
  if (request.reason.length < MATERIAL_OVERRIDE_MIN_REASON) {
    return blocked(MATERIAL_OVERRIDE_REASONS.invalid, `a written reason of at least ${MATERIAL_OVERRIDE_MIN_REASON} characters is required.`);
  }

  // Which ONE canonical material does this job use?
  let selectedKey = "";
  if (input.family === "stickers-labels" && input.labels) {
    const keys = Array.from(new Set(input.labels.lines.map((line) => String(line.materialKey || "")).filter(Boolean)));
    if (keys.length !== 1) {
      return blocked(MATERIAL_OVERRIDE_REASONS.singleMaterial, `the override applies to exactly one material per job; this job uses ${keys.length || "no"} material(s).`);
    }
    selectedKey = keys[0];
  } else if (BAG_FAMILIES.has(input.family) && input.bags) {
    selectedKey = input.bags.materialId ? `${MATERIAL_CANONICAL_KEY_PREFIX}${input.bags.materialId}` : String(input.bags.materialKey || "");
  } else if (JAR_FAMILIES.has(input.family) && input.jar) {
    selectedKey = input.jar.materialId ? `${MATERIAL_CANONICAL_KEY_PREFIX}${input.jar.materialId}` : String(input.jar.materialKey || "");
  } else {
    return blocked(MATERIAL_OVERRIDE_REASONS.unsupportedFamily, "material overrides apply to label, bag and jar label media only.");
  }
  if (!selectedKey) return blocked(MATERIAL_OVERRIDE_REASONS.singleMaterial, "select the material being overridden first.");

  // Geometry comes from the approved roll or the shop's own record — never invented.
  let label = "";
  let rollWidthIn = 0;
  let materialId = "";
  const approved = (LABEL_MATERIALS as Record<string, { label: string; rollWidthIn: number }>)[selectedKey];
  if (approved) {
    label = approved.label;
    rollWidthIn = approved.rollWidthIn;
  } else if (selectedKey.startsWith(MATERIAL_CANONICAL_KEY_PREFIX)) {
    materialId = selectedKey.slice(MATERIAL_CANONICAL_KEY_PREFIX.length);
    const record = await deps.db.material.findFirst({ where: { shop: deps.shop, id: materialId } });
    if (!record) return blocked(MATERIAL_OVERRIDE_REASONS.geometryRequired, "the selected material was not found in Material Center.");
    label = String(record.name || "Material");
    rollWidthIn = Number(record.rollWidthIn) || 0;
  }
  if (!(rollWidthIn > 0)) {
    return blocked(MATERIAL_OVERRIDE_REASONS.geometryRequired, "the selected material has no roll width; the override covers cost only and never invents geometry.");
  }

  const key = `${MATERIAL_OVERRIDE_KEY_PREFIX}${selectedKey}`;
  const material: VerifiedLabelMaterial = {
    key,
    label: `${label} — OWNER OVERRIDE $${value.toFixed(4)}/sqft`,
    costPerSqft: value,
    rollWidthIn,
    source: "material_center",
    materialId,
  };
  const materialOverride: AppliedMaterialOverride = {
    costPerSqft: value,
    reason: request.reason,
    ownerUserId: owner.userId,
    replacedMaterialKey: selectedKey,
    replacedMaterialLabel: label,
    rollWidthIn,
  };
  const media = { materialKey: key, materialId: null, materials: { [key]: material }, materialMissing: [] as string[] };
  if (input.family === "stickers-labels" && input.labels) {
    return {
      ...input,
      materialOverride,
      materialOverrideBlocker: null,
      labels: { ...input.labels, lines: input.labels.lines.map((line) => ({ ...line, materialKey: key })), materials: { ...(input.labels.materials || {}), [key]: material } },
    };
  }
  if (BAG_FAMILIES.has(input.family)) return { ...input, materialOverride, materialOverrideBlocker: null, bags: { ...input.bags!, ...media } };
  return { ...input, materialOverride, materialOverrideBlocker: null, jar: { ...input.jar!, ...media } };
}
