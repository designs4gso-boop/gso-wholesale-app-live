// Owner-standards registry (Phase 15B). ONE shared location for the
// owner-verified labor/machine standards the calculator prices with.
// Client-safe: pure data, no server imports.
//
// OWNER_LABOR in calculator-emergency.server.ts and the calculator route's
// machine rate are WIRED to these values — change them here, nowhere else.
// LEGACY_CONFLICTING_RATES documents older values that still exist in legacy
// code paths; they are quarantined and MUST NOT override calculator truth
// (tests enforce this).

export type OwnerStandard = {
  value: number;
  unit: string;
  basis: string;
  status: "owner_verified" | "provisional";
};

// 15G.2A owner-confirmed 4x5 bag application throughput (LABELS per hour —
// never bags per hour; a front+back bag is 2 applied labels). Only `normal`
// controls canonical quoting; `conservative` is a planning reference.
export const BAG_APPLICATION_THROUGHPUT = {
  laborRatePerHour: 20,
  unit: "labels/hour (labels, not bags)",
  normalLabelsPerHour: 256,
  conservativeLabelsPerHour: 180,
} as const;

export const OWNER_STANDARDS = {
  bagApplicationPerLabel4x5: {
    value: 20 / 256, // $0.078125
    unit: "$ per applied label (4x5 sticker bag)",
    basis: "$20/hour at 256 LABELS/hour (labels, not bags — front+back = 2 labels/bag) — owner-confirmed 2026-08-09 (15G.2A) reaffirming the 2026-07-24 standard. NORMAL trained-operator throughput; this is the ONLY rate canonical quoting uses.",
    status: "owner_verified",
  } as OwnerStandard,
  // 15G.2A: conservative / new-operator PLANNING REFERENCE only. Canonical
  // quoting NEVER uses this rate — it exists for capacity planning and
  // conservative what-if displays. Same $20/hr basis, slower throughput.
  bagApplicationPerLabel4x5Conservative: {
    value: 20 / 180, // $0.1111 per applied label
    unit: "$ per applied label (4x5 sticker bag) — conservative reference, never canonical",
    basis: "$20/hour at 180 LABELS/hour (labels, not bags) — owner-confirmed conservative/new-operator reference 2026-08-09 (15G.2A). NOT used in canonical quoting.",
    status: "owner_verified",
  } as OwnerStandard,
  bagApplicationPerLabel14x16: {
    value: 1.0,
    unit: "$ per applied label (14x16 bag)",
    basis: "$20/hour at 20 labels/hour (13A.3 owner standard)",
    status: "owner_verified",
  } as OwnerStandard,
  jarApplicationPerLabel: {
    value: 20 / 100, // $0.20
    unit: "$ per applied jar label",
    basis: "$20/hour at 100 labels/hour",
    status: "owner_verified",
  } as OwnerStandard,
  artSetupPerDesign: {
    value: 25 / 3, // $8.3333 — cut setup included
    unit: "$ per design",
    basis: "owner standard (cut setup included)",
    status: "owner_verified",
  } as OwnerStandard,
  printSetupPerDesign: {
    value: 25 / 25, // $1.00
    unit: "$ per design",
    basis: "owner standard — $25/hour at 25 jobs/hour (standard print setup)",
    status: "owner_verified",
  } as OwnerStandard,
  // 15F.0K.4B (owner-verified 2026-07-26): Illustrator gloss-mask preparation
  // for layered/spot-gloss work. Charged ONCE per design that needs a gloss
  // mask — NEVER multiplied by the number of gloss stages (1X..7X = one
  // setup). Separate from standard print setup; white-only work does NOT
  // receive this charge (no verified white-mask setup rule exists).
  glossLayerSetupPerDesign: {
    value: 25 / 4, // $6.25
    unit: "$ per gloss design (once per design, never per stage)",
    basis: "$25/hour at 4 jobs/hour — Illustrator gloss-mask preparation (owner-verified 2026-07-26)",
    status: "owner_verified",
  } as OwnerStandard,
  weedingPerPage54x54: {
    value: 20 / 15, // $1.3333
    unit: "$ per 54x54in weeding page",
    basis: "$20/hour at 15 pages/hour",
    status: "owner_verified",
  } as OwnerStandard,
  packoutPerBox: {
    value: 20 / 10, // $2.00
    unit: "$ per packed box",
    basis: "$20/hour at 10 boxes/hour",
    status: "owner_verified",
  } as OwnerStandard,
  machineRecoveryPerHour: {
    value: 8,
    unit: "$ per machine hour",
    basis: "PROVISIONAL owner standard (13A.7B decision) — supersedes the legacy $25/hour figure",
    status: "provisional",
  } as OwnerStandard,
} as const;

// Older values still present in legacy code paths. Quarantined: nothing in
// the product-driven calculator may read these, and tests pin that the
// current standards win wherever both exist.
export const LEGACY_CONFLICTING_RATES = {
  bag4x5PerSideLegacy: {
    value: 20 / 180, // $0.1111 — WIRED_LABOR.bag4x5PerSide (13A.3 era)
    location: "app/lib/cost-calculator.server.ts WIRED_LABOR.bag4x5PerSide (legacy calculator only)",
    supersededBy:
      "OWNER_STANDARDS.bagApplicationPerLabel4x5 ($0.078125 normal). 15G.2A: the number coincides with the owner's CONSERVATIVE reference (180 labels/hr, bagApplicationPerLabel4x5Conservative) but the legacy path treated it per SIDE-era semantics; canonical quoting uses the normal 256 labels/hr rate only.",
  },
  marginReviewLaborPerHour: {
    value: 25,
    location: "app/routes/app.erp.margin-review.tsx DEFAULT_SHOP_LABOR_RATE_PER_HOUR (report defaults only)",
    supersededBy: "OWNER_STANDARDS.machineRecoveryPerHour for machine recovery; owner labor standards for labor lines",
  },
  marginReviewApplicationPerSide: {
    value: 0.15,
    location: "app/routes/app.erp.margin-review.tsx DEFAULT_APPLICATION_LABOR_COST_PER_SIDE (report defaults only)",
    supersededBy: "OWNER_STANDARDS.bagApplicationPerLabel4x5 / jarApplicationPerLabel",
  },
} as const;
