// Patch 1 (17D.1) — seed the four OWNER-MEASURED machine/profile calibrations.
//
// SAFETY: dry-run by default. Nothing is written unless --apply is passed.
// This tool was NOT run against production during Patch 1.
//
// Idempotent: an identical approved row for the same identity is left alone.
// A DIFFERENT approved row for the same identity is superseded append-only
// (status -> "superseded", effectiveTo set) and the new row inserted with
// supersedesId pointing at it. No row is ever deleted or overwritten.
//
// Only owner-measured values are seeded here. Historical JobHistory regression
// figures (e.g. the ~1.356 mL/sqft Roland CMYK estimate) are deliberately NOT
// active calibrations — they remain evidence recorded in notes/docs only.
//
// Emboss / Raised is deliberately ABSENT: it has no calibrated production
// recipe, so it must resolve to MISSING_CALIBRATION (DRAFT ONLY / BLOCKED)
// rather than borrowing the GlossVarnish rate.
//
// Usage:
//   node tools/seed-machine-profile-calibrations.mjs            # dry run
//   node tools/seed-machine-profile-calibrations.mjs --apply    # write

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SHOP = "942075-2.myshopify.com";
const APPLY = process.argv.includes("--apply");

const MEASURED_AT = new Date("2026-08-18T00:00:00.000Z");
const EFFECTIVE_FROM = new Date("2026-08-18T00:00:00.000Z");

const CALIBRATIONS = [
  {
    label: "Mimaki UCJV300-130 — Heavy CMYK",
    machineKey: "mimaki-ucjv300-130",
    inkMode: "cmyk_heavy",
    ripProfile: "PVC Gloss / Mimaki Vision Vinyl",
    qualityMode: "Fast Print High",
    resolution: "600x1200 VD",
    passConfig: "32-pass-bidi-op1",

    mlPerSqftPerPass: 1.89,
    inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 1.444,
    timeAreaBasis: "rip_layout",
    fixedMinutes: null,
    timeModel: "variable_only",
    coverageBasisPct: null,

    source:
      "Owner-measured production benchmark 2026-08-18. 130 copies at 3.989 x 5.000 in = 18.0059 sqft combined label area; RIP layout 51.855 x 50 in = 18.0052 sqft (tightly packed full-bleed nest, so inkableArtwork ~= ripLayout for this sample). Actual print time 26 min; actual ink 34.085 mL. 34.085 / 18.006 = 1.89 mL/sqft; 26 / 18.01 = 1.444 min/sqft (~41.6 sqft/hr).",
    notes:
      "Heavy/full CMYK is the normal GSO production assumption, so coverageBasisPct is null (this is a representative heavy production reference, not a controlled solid 100% plate). timeModel variable_only: fixedMinutes intentionally unset.",
  },
  {
    label: "Roland LG-640 — Heavy Full-Color CMYK",
    machineKey: "roland-lg-640",
    inkMode: "cmyk",
    ripProfile: "Generic Sign Production",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "hq-default",

    mlPerSqftPerPass: 1.4133,
    inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 0.91,
    timeAreaBasis: "rip_layout",
    fixedMinutes: null,
    timeModel: "variable_only",
    coverageBasisPct: null,

    source:
      "Owner-measured LG-640 test 2026-08-18 — Flame Society_raibow cherry slushie_matte_150 ML_Roland.pdf, 35 copies, VersaWorks JobHistory.db job_setting_key 3553. Metered actual C 1.5921 + M 4.2596 + Y 3.6591 + K 0.6853 = 10.1962 mL. inkableArtworkSqft 7.2144 (side 7.125x3.125 = 22.265625 + lid pi*1^2 = 3.141593 + tamper 7.125x0.6 = 4.275 = 29.682218 sq in/set x 35 / 144). 10.1962 / 7.2144 = 1.4133 mL per inkable-artwork sqft.",
    notes:
      "Occupancy authority remains 0.91 min/sqft from the larger owner production benchmarks (~66 sqft/hr). This job's own sample was 7m39s over ripLayout 8.9175 sqft = 0.8579 min/sqft (~70 sqft/hr) — it SUPPORTS 0.91 and does not replace it. VersaWorks UI ink estimate 10.25 mL vs actual 10.1962 mL = 0.9948 ratio (-0.52%), materially tighter than the ~0.85 specialty actual/estimate ratio. Historical JobHistory regression ~1.356 mL/sqft is retained as supporting evidence only and must not override this direct measurement.",
  },
  {
    label: "Roland LG-640 — White HD 1X",
    machineKey: "roland-lg-640",
    inkMode: "white",
    ripProfile: "Generic Sign Production",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "white-hd-1x",

    mlPerSqftPerPass: 6.0,
    inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 1.71,
    timeAreaBasis: "rip_layout",
    fixedMinutes: null,
    timeModel: "variable_only",
    coverageBasisPct: 100,

    source:
      "Owner controlled test 2026-08-18 — WHITE-GLOSS_TEST.pdf, VersaWorks JobHistory.db job_setting_key 3550. Solid plate 24 x 18 in = 3.00 sqft inkable specialty area at 100% white coverage; metered actual White 18.0025 mL. 18.00 / 3.00 = 6.00 mL per inkable sqft per pass. RIP print_area for the same job was 38.4171 x 18.0000 in = 4.8021 sqft, which is NOT the ink denominator.",
    notes:
      "Time rate 1.71 min/sqft/pass is the large-layout occupancy authority on RIP-layout area; the 3 sqft plate's own 11m01s would imply 3.67 min/sqft and is rejected because a small controlled plate carries disproportionate fixed overhead. PROVISIONAL EVIDENCE ONLY (must not affect true cost): inferred white fixed overhead ~5.87 min; VersaWorks specialty actual/estimate ratio ~0.85 (UI estimate 13 min vs physical actual 11 min).",
  },
  {
    label: "Roland LG-640 — GlossVarnish 1X",
    machineKey: "roland-lg-640",
    inkMode: "gloss",
    ripProfile: "Special Effects",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "gloss-1x",

    mlPerSqftPerPass: 4.18,
    inkAreaBasis: "inkable_artwork",
    minutesPerSqft: 0.91,
    timeAreaBasis: "rip_layout",
    fixedMinutes: null,
    timeModel: "variable_only",
    coverageBasisPct: 100,

    source:
      "Owner controlled test 2026-08-18 — WHITE-GLOSS_TEST.pdf, VersaWorks JobHistory.db job_setting_key 3549. Solid plate 24 x 18 in = 3.00 sqft inkable specialty area at 100% gloss coverage; metered actual Gloss 12.5410 mL. 12.54 / 3.00 = 4.18 mL per inkable sqft per pass. RIP print_area for the same job was 38.4171 x 18.0000 in = 4.8021 sqft, which is NOT the ink denominator.",
    notes:
      "Time rate 0.91 min/sqft/pass is the large-layout occupancy authority on RIP-layout area; the 3 sqft plate's own 6m53s would imply 2.00 min/sqft and is rejected for fixed-overhead contamination. Gloss default customer coverage is 50% (owner-approved, editable) — that is a consumer-side default, NOT this calibration, which was measured at a controlled 100%. PROVISIONAL EVIDENCE ONLY (must not affect true cost): inferred gloss fixed overhead ~3.27 min; VersaWorks specialty actual/estimate ratio ~0.85 (UI estimate 7 min vs physical actual 6 min). Emboss/Raised is NOT calibrated and is deliberately absent — it must never borrow this rate.",
  },
];

const IDENTITY_FIELDS = ["machineKey", "inkMode", "ripProfile", "qualityMode", "resolution", "passConfig"];
const VALUE_FIELDS = [
  "mlPerSqftPerPass",
  "inkAreaBasis",
  "minutesPerSqft",
  "timeAreaBasis",
  "fixedMinutes",
  "timeModel",
  "coverageBasisPct",
];

const identityOf = (row) => Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, row[f]]));
const valuesMatch = (existing, row) =>
  VALUE_FIELDS.every((f) => {
    const a = existing[f];
    const b = row[f];
    if (a == null && b == null) return true;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
    return a === b;
  });

async function main() {
  console.log(APPLY ? "APPLY MODE — writing calibrations" : "DRY RUN — no writes (pass --apply to write)");
  console.log(`Shop: ${SHOP}`);
  console.log("");

  const summary = [];

  for (const row of CALIBRATIONS) {
    const identity = identityOf(row);

    const existing = await db.machineProfileCalibration.findMany({
      where: { shop: SHOP, status: "approved", ...identity },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });

    let action;
    if (existing.length === 1 && valuesMatch(existing[0], row)) {
      action = "unchanged";
    } else if (existing.length === 0) {
      action = "insert";
    } else {
      action = "supersede+insert";
    }

    summary.push({
      calibration: row.label,
      inkMlPerSqft: row.mlPerSqftPerPass,
      inkBasis: row.inkAreaBasis,
      minPerSqft: row.minutesPerSqft,
      timeBasis: row.timeAreaBasis,
      coverage: row.coverageBasisPct,
      action,
    });

    if (!APPLY || action === "unchanged") continue;

    await db.$transaction(async (tx) => {
      for (const prior of existing) {
        await tx.machineProfileCalibration.update({
          where: { id: prior.id },
          data: { status: "superseded", effectiveTo: prior.effectiveTo ?? EFFECTIVE_FROM },
        });
      }
      await tx.machineProfileCalibration.create({
        data: {
          shop: SHOP,
          ...identity,
          mlPerSqftPerPass: row.mlPerSqftPerPass,
          inkAreaBasis: row.inkAreaBasis,
          minutesPerSqft: row.minutesPerSqft,
          timeAreaBasis: row.timeAreaBasis,
          fixedMinutes: row.fixedMinutes,
          timeModel: row.timeModel,
          coverageBasisPct: row.coverageBasisPct,
          measuredAt: MEASURED_AT,
          effectiveFrom: EFFECTIVE_FROM,
          effectiveTo: null,
          status: "approved",
          source: row.source,
          notes: row.notes,
          supersedesId: existing[0]?.id ?? null,
        },
      });
    });
  }

  console.table(summary);
  console.log("");
  console.log(
    APPLY
      ? "DONE. Historical rows were superseded, never deleted."
      : "DRY RUN COMPLETE — nothing written. Re-run with --apply to seed.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
