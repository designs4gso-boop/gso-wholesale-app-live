// Owner-standards registry (Phase 15B). ONE shared location for the
// owner-verified labor/machine standards the calculator prices with.
// Client-safe: pure data, no server imports.
//
// OWNER_LABOR in calculator-emergency.server.ts and the calculator route's
// machine rate are WIRED to these values — change them here, nowhere else.
// LEGACY_CONFLICTING_RATES documents older values that still exist in legacy
// code paths; they are quarantined and MUST NOT override calculator truth
// (tests enforce this).

import { WEEDING_STANDARD } from "./weeding-standard";

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
  /**
   * SUPERSEDED 2026-08-22 for the 4x5 bag process (Patch 2D-2).
   *
   * The canonical 4x5 bag application standard is now 10 SECONDS PER APPLIED
   * SIDE at $20/hr — $0.0555555556 per side, $0.1111111111 for front+back —
   * and it lives in `bag-cost-inputs.server.ts` as
   * BAG_APPLICATION_SECONDS_PER_SIDE. Canonical bag costing reads that, never
   * this entry.
   *
   * The numeric value here is deliberately left UNCHANGED so the legacy
   * calculator path (calculator-emergency / product-driven-costing) keeps
   * behaving identically until Patch 2D-4 replaces it. It is no longer an
   * owner-verified canonical rate — see LEGACY_CONFLICTING_RATES below.
   */
  bagApplicationPerLabel4x5: {
    value: 20 / 256, // $0.078125 — LEGACY PATH ONLY
    unit: "$ per applied label (4x5 sticker bag) — SUPERSEDED, legacy calculator only",
    basis: "$20/hour at 256 LABELS/hour — owner-confirmed 2026-08-09 (15G.2A). SUPERSEDED 2026-08-22 by 10 seconds per applied side ($0.0555555556/side). Retained unchanged ONLY so the legacy calculator path does not silently shift before Patch 2D-4; canonical bag costing does not read it.",
    status: "provisional",
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
    // 2026-10-05: read from the single weeding standard object
    // (weeding-standard.ts) — still $20/hour at 15 pages/hour = $1.3333.
    value: WEEDING_STANDARD.costPerPage,
    unit: `$ per ${WEEDING_STANDARD.pageWidthIn}x${WEEDING_STANDARD.pageLengthIn}in weeding page`,
    basis: `$${WEEDING_STANDARD.laborRatePerHour}/hour at ${WEEDING_STANDARD.pagesPerHour} pages/hour`,
    status: "owner_verified",
  } as OwnerStandard,
  packoutPerBox: {
    value: 20 / 10, // $2.00
    unit: "$ per packed box",
    basis: "$20/hour at 10 boxes/hour",
    status: "owner_verified",
  } as OwnerStandard,
  /*
   * Jars are produced with a deliberate 1% planned overage: 500 finished jars
   * are made from 505 produced. It is a QUANTITY effect, never a second
   * charge — the inputs that genuinely scale with produced quantity (blank
   * complete sets, print media, ink and the inbound freight allocated to those
   * sets) price at the production number, and the overage line itself is $0 so
   * nothing is double-counted. Packout still counts FINISHED jars, because
   * boxes ship what the customer receives.
   *
   * 2D-4D3: owner-confirmed. Until then this number lived only as a comment in
   * jar-cost-inputs.server.ts labelled "owner rule" with nothing behind it, and
   * the 2D-4D2 audit correctly refused to treat that as verification. It is
   * recorded here so the cost path depends on the decision authority rather
   * than on prose.
   */
  jarPlannedOveragePct: {
    value: 1,
    unit: "% planned production overage (jars)",
    basis: "Owner-confirmed 2026-08-25 (2D-4D3). Applies to produced-quantity inputs only — blanks, media, ink and their freight allocation. Never compounded, never charged twice, and packout stays on finished quantity.",
    status: "owner_verified",
  } as OwnerStandard,
  machineRecoveryPerHour: {
    value: 5,
    unit: "$ per machine hour",
    basis: "OWNER APPROVED 2026-10-07 — $5/hr for BOTH the Roland LG-640 and the Mimaki UCJV300-130. Basis: retail replacement value (Roland ~$24,395; Mimaki ~$21,995; owner purchase ~$10,000 each) + high utilization (minimum 8 h/day x 5 d/wk; Roland normally 16–18 h/day, Mimaki 8–12 h/day) + maintenance / electricity / contingency allowance. Covers capital replacement reserve, maintenance/service, electricity/operating allowance and equipment contingency ONLY — never labor, ink, media, setup, cutting, weeding, application or commercial profit. Supersedes the $8/hr PROVISIONAL figure (13A.7B) and the legacy $25/hour.",
    status: "owner_verified",
  } as OwnerStandard,
} as const;

// Older values still present in legacy code paths. Quarantined: nothing in
// the product-driven calculator may read these, and tests pin that the
// current standards win wherever both exist.
export const LEGACY_CONFLICTING_RATES = {
  // 2D-2: both retired on 2026-08-22. Neither may be read by canonical costing.
  bag4x5ApplicationPer256Hour: {
    value: 20 / 256, // $0.078125/label, $0.15625 front+back
    location: "OWNER_STANDARDS.bagApplicationPerLabel4x5 (legacy calculator path only)",
    supersededBy: "bag-cost-inputs.server.ts BAG_APPLICATION_SECONDS_PER_SIDE = 10 seconds per applied side at $20/hr = $0.0555555556/side, $0.1111111111 front+back (owner 2026-08-22).",
  },
  /**
   * SUPERSEDED 2026-10-08. The 2D-4C2D "$0.09 supplier base before inbound
   * freight" rule (owner-corrected 2026-08-24) competed with an earlier $0.11
   * handoff; the owner resolved the conflict on 2026-10-08: the 4x5 blank bag
   * true base cost is $0.11 each regardless of colour, with no generic
   * freight uplift. Production Material + VendorProduct updated the same day.
   */
  bag4x5Blank009SupplierBaseSuperseded: {
    value: 0.09,
    location: "superseded: bag-cost-inputs.server.ts BAG_4X5_BLANK_UNIT_COST (2D-4C2D, 2026-08-24 through 2026-10-08), production Material/VendorProduct until 2026-10-08",
    supersededBy: "bag-cost-inputs.server.ts BAG_4X5_BLANK_UNIT_COST = $0.11 owner true base cost (owner decision 2026-10-08, any colour). Inbound freight remains a SEPARATE, not-yet-modelled component; no generic uplift is added on top of $0.11.",
  },
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
