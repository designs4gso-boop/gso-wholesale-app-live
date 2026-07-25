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

export const OWNER_STANDARDS = {
  bagApplicationPerLabel4x5: {
    value: 20 / 256, // $0.078125
    unit: "$ per applied label (4x5 sticker bag)",
    basis: "$20/hour at 256 labels/hour — owner-authoritative 2026-07-24 (Phase 15B confirmation)",
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
    basis: "owner standard",
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
    supersededBy: "OWNER_STANDARDS.bagApplicationPerLabel4x5 ($0.078125)",
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
