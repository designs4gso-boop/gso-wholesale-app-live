// 15F.0J.5 — print-intake filename hints, tickets, existing-job linking.
// Patch C (2026-11-18): automatic print-intake job creation was REMOVED. The
// source pins below now prove the creator is gone; the behavioural proof is in
// tests/print-intake-no-auto-create-2026-11-18.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildIntakeRipName,
  decideIntakeRoute,
  decideMachineFromFilename,
  hasMimakiFilenameTag,
  parseFilenamePrintHints,
  type IntakeJob,
} from "../app/lib/print-intake-routing.server";

const LIVE_FIXTURE = "GSO PIPELINE TEST_3X SPOT GLOSS_Roland.pdf";

function jobWith(over: Partial<IntakeJob> = {}): IntakeJob {
  return {
    id: "job1", jobTicket: "GSO-20260726-0001", customerName: "Cust", company: null, status: "new",
    artworkUrl: null, printFileUrl: null,
    items: [{ id: "item1", itemTicket: "GSO-20260726-0001-01", ripJobName: "GSO-20260726-0001-01", suggestedFileName: null, productTitle: "Labels", selectedFinish: null, materialSummary: null, machineSummary: "Mimaki UCJV300-130" }],
    fileNames: [],
    ...over,
  };
}

describe("filename print hints (15F.0J.5-D safety)", () => {
  it("live fixture: 3X SPOT GLOSS + Roland token -> Roland GLOSS-3X, deterministic", () => {
    const hints = parseFilenamePrintHints(LIVE_FIXTURE);
    expect(hints.glossLayers).toBe(3);
    expect(hints.printerToken).toBe("roland");
    expect(hints.mode).toBe("GLOSS-3X");
    expect(hints.deterministic).toBe(true);
    const machine = decideMachineFromFilename(LIVE_FIXTURE);
    expect(machine.machine).toBe("roland");
    expect(machine.mode).toBe("GLOSS-3X");
    expect(machine.machineRule).toBe("explicit_roland_tag"); // updated 2026-11-18: Mimaki gloss restored — the Roland token decides the press, gloss no longer does
    expect(machine.reasons).toEqual(["standalone_roland_tag_in_filename"]);
  });

  it("hazard safety: bare '3x' in a product name and 'White Widow' NEVER trigger premium routing", () => {
    const strain = parseFilenamePrintHints("Blue Chip_Rainbow 3x OG_matte.pdf");
    expect(strain.glossLayers).toBe(0);
    expect(strain.mode).toBe("CMYK");
    // ordinary CMYK: no premium routing — updated 2026-11-18: Mimaki gloss restored, plain CMYK takes the Mimaki default
    expect(decideMachineFromFilename("Blue Chip_Rainbow 3x OG_matte.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", mode: "CMYK", reasons: ["cmyk_only_default_mimaki"] });
    const widow = parseFilenamePrintHints("Cust_White Widow_matte.pdf");
    expect(widow.whiteLayers).toBe(0); // no finish adjacency -> not white ink
    expect(parseFilenamePrintHints("Cust_holo white_labels.pdf").whiteLayers).toBe(1); // finish adjacency counts
    expect(parseFilenamePrintHints("Cust_2x white_labels.pdf").whiteLayers).toBe(2);
  });

  // PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
  it("tests 10/11 (updated 2026-11-18: Mimaki gloss restored; 2026-11-20: Mimaki white not approved): conflicting printer tokens BLOCK routing; gloss+MIMAKI routes to the Mimaki; white+MIMAKI is HELD", () => {
    const conflict = decideMachineFromFilename("Cust_Product_Roland_Mimaki.pdf");
    expect(conflict.machine).toBeNull();
    expect(conflict.reasons).toContain("conflicting_printer_tokens_in_filename");
    const premiumMimaki = decideMachineFromFilename("Cust_3x spot gloss_MIMAKI.pdf");
    // 2026-11-18: gloss + an explicit MIMAKI tag is no longer a contradiction.
    expect(premiumMimaki).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag", mode: "GLOSS-3X", reasons: ["standalone_mimaki_tag_in_filename"] });
    expect(parseFilenamePrintHints("Cust_3x spot gloss_MIMAKI.pdf")).toMatchObject({ deterministic: true, printerToken: "mimaki", glossLayers: 3, reasons: [] });
    expect(decideMachineFromFilename("Cust_2x white_MIMAKI.pdf")).toMatchObject({ machine: null, machineRule: null, mode: "WHITE-2X", reasons: ["white_job_but_mimaki_selected_contradiction"] }); // 2026-11-20: was mimaki / explicit_mimaki_tag
    expect(decideMachineFromFilename("Cust_2x white_ROLAND.pdf")).toMatchObject({ machine: "roland", machineRule: "explicit_roland_tag", mode: "WHITE-2X" }); // Roland white unchanged
    expect(hasMimakiFilenameTag("job_MIMAKI_run.pdf")).toBe(true);
    expect(hasMimakiFilenameTag("mimakingtons.pdf")).toBe(false); // word boundary
  });

  it("test 2 (updated 2026-11-18: Mimaki gloss restored; 2026-11-20: Mimaki white not approved): untagged CMYK and untagged gloss default to the Mimaki; untagged WHITE goes to the Roland whatever the load says", () => {
    const decision = decideMachineFromFilename("Customer_Product_CMYK.pdf");
    expect(decision.machine).toBe("mimaki");
    expect(decision.machineRule).toBe("default_cmyk");
    expect(decision.reasons).toEqual(["cmyk_only_default_mimaki"]);
    expect(decision.mode).toBe("CMYK");
    const load = { source: "t", capturedAt: "t", unattributedOpenItems: 0, byPrinter: { mimaki: { openItems: 4, estimatedMinutes: 120 }, roland: { openItems: 9, estimatedMinutes: 60 } } };
    expect(decideMachineFromFilename("Customer_Product_CMYK.pdf", load)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] }); // load is not consulted for CMYK any more
    expect(decideMachineFromFilename("Cust_3x spot gloss_labels.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", mode: "GLOSS-3X", reasons: ["cmyk_gloss_default_mimaki"] });
    // PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf")).toMatchObject({ machine: "roland", machineRule: "white_requires_roland", mode: "WHITE-2X", reasons: ["white_requires_roland"] }); // was review: auto_machine_load_unavailable_select_printer
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf", load)).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" }); // was auto_load_balanced
    const mimakiIdle = { ...load, byPrinter: { mimaki: { openItems: 0, estimatedMinutes: 0 }, roland: { openItems: 9, estimatedMinutes: 600 } } };
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf", mimakiIdle)).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" }); // an idle Mimaki never takes white
  });

  it("test 13: routed filename is structured, ticket-parseable, safe, capped, attempt-marked", () => {
    const name = buildIntakeRipName("GSO-20260726-0007", "roland", "GLOSS-3X", LIVE_FIXTURE);
    expect(name).toBe("GSO-20260726-0007__ROLAND__GLOSS-3X__GSO-PIPELINE-TEST-3X-SPOT-GLOSS-ROLAND__A1");
    expect(name.match(/^GSO-\d{8}-\d{4}/)![0]).toBe("GSO-20260726-0007"); // watcher-parseable
    const long = buildIntakeRipName("GSO-20260726-0008", "mimaki", "CMYK", "x".repeat(300) + ".pdf");
    expect(long.length).toBeLessThanOrEqual(120);
    expect(buildIntakeRipName("GSO-20260726-0009", "mimaki", "CMYK", "art.pdf", 2).endsWith("__A2")).toBe(true);
  });

  it("test 3/21: exact existing-job matching is UNCHANGED — ticket in filename reuses the job and its ticket", () => {
    const decision = decideIntakeRoute({ fileName: "GSO-20260726-0001-01 labels.pdf", jobs: [jobWith()] });
    expect(decision.decision).toBe("route");
    expect(decision.rule).toBe("item_ticket");
    expect(decision.jobTicket).toBe("GSO-20260726-0001");
    // unmatched files return review from the PURE decider, and (Patch C) the
    // server layer keeps them in review — it never creates a job for them
    const unmatched = decideIntakeRoute({ fileName: "Totally New File_matte.pdf", jobs: [jobWith()] });
    expect(unmatched.decision).toBe("review");
    expect(unmatched.reasons).toContain("no_deterministic_match");
  });
});

describe("route-plan + creator source pins (15F.0J.5)", () => {
  const routeSrc = readFileSync(new URL("../app/routes/api.print-intake.route-plan.tsx", import.meta.url), "utf8");
  const creatorSrc = readFileSync(new URL("../app/lib/production-job-source.server.ts", import.meta.url), "utf8");
  const agentSrc = readFileSync(new URL("../tools/gso-print-intake-agent.ps1", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  it("tests 1/7/8/9 (Patch C): unmatched files go to REVIEW — the route-plan endpoint has no job-creation path at all", () => {
    expect(routeSrc).not.toContain("createOrReusePrintIntakeJob");
    expect(routeSrc).not.toContain("print_intake_auto_created");
    expect(routeSrc).not.toContain("productionJob.create");
    expect(routeSrc).not.toContain("productionJob.upsert");
    expect(routeSrc).not.toContain("productionJobItem.create");
    expect(routeSrc).not.toContain("decideMachineFromFilename"); // an unmatched file gets no printer
    expect(routeSrc).toContain('await recordReviewRow(reviewReasons, "needs_link_to_job", { skipIfUnchanged: true });');
    expect(routeSrc).toContain("needsLinkToJob: true");
    // ambiguous candidates also review (no controlled job is created for them)
    expect(routeSrc).toContain("if (isUnmatched || isAmbiguousCandidates) {");
  });

  it("tests 4/5/6 (Patch C): the creator and its markers are gone from the job source module; PrintIntake stays unique on shop+hash", () => {
    expect(creatorSrc).not.toContain("createOrReusePrintIntakeJob(");
    expect(creatorSrc).not.toContain('"print_intake", fileHash');
    expect(creatorSrc).toContain("Print Intake never creates a ProductionJob (Patch C, 2026-11-18)");
    expect(creatorSrc).toContain("const jobTicket = await buildNextJobTicket(tx, shop)"); // legitimate creators still use the ONE generator
    expect(creatorSrc).toContain('if (String(error?.code) !== "P2002") return false;'); // ticket-constraint retry for the legitimate creators
    expect(schemaSrc).toContain("@@unique([shop, fileHashSha256])");
  });

  it("15F.0J.5A-A: advisory lock casts VOID to a supported scalar and stays LOUD on real failures", () => {
    expect(creatorSrc).toContain("pg_advisory_xact_lock(${Math.trunc(keyA)}, ${Math.trunc(keyB)})::text AS gso_lock"); // no void deserialization
    expect(creatorSrc).not.toMatch(/pg_advisory_xact_lock\(\$\{Math\.trunc\(keyA\)\}, \$\{Math\.trunc\(keyB\)\}\)`/); // uncast form gone
    expect(creatorSrc).toContain('gsoCode = "advisory_lock_failed"');
    expect(creatorSrc).toContain("no such function|not supported on|sqlite"); // ONLY SQLite skips; everything else throws
  });

  it("test 19 (Patch C): no fabricated print-intake job, customer or item remains in the creator module; schema untouched", () => {
    expect(creatorSrc).not.toContain("PRINT INTAKE — UNLINKED");
    expect(creatorSrc).not.toContain('customerName: "Unlinked (print intake)"');
    expect(creatorSrc).not.toContain("created_from_print_intake");
    expect(creatorSrc).not.toContain("print_intake_auto_created");
    expect(creatorSrc).not.toContain('source: "print_intake"');
    const jobBlock = schemaSrc.split("model ProductionJob {")[1].split("\n}")[0]; // scope to THIS model only
    expect(/\n  source\s+String/.test(jobBlock)).toBe(false); // no `source` column added to ProductionJob
  });

  it("15F.0J.5A-D/E: filename hints still parse the live fixture (used for matched/assigned routing); no create-error codes remain in the endpoint", () => {
    for (const code of ["advisory_lock_failed", "schema_mismatch", "print_intake_create_failed", "production_job_create_failed"]) {
      expect(routeSrc).not.toContain(code);
    }
    const fixture = "GSO PIPELINE TEST 3_1X SPOT GLOSS_Roland.pdf";
    const hints = parseFilenamePrintHints(fixture);
    expect(hints.glossLayers).toBe(1); // the bare "3" in "TEST 3" never counts
    expect(hints.mode).toBe("GLOSS-1X");
    const machine = decideMachineFromFilename(fixture);
    expect(machine.machine).toBe("roland");
    expect(buildIntakeRipName("GSO-20260726-0050", "roland", "GLOSS-1X", fixture)).toBe("GSO-20260726-0050__ROLAND__GLOSS-1X__GSO-PIPELINE-TEST-3-1X-SPOT-GLOSS-ROLAND__A1");
  });

  it("tests 12/14/15: agent preserves the original and archives ONLY after a verified routed copy; failure leaves it in place", () => {
    const routedIndex = agentSrc.indexOf('"routed_to_hot_folder"');
    const archiveIndex = agentSrc.indexOf("original_archived");
    const verifyIndex = agentSrc.indexOf("copy_verify_failed");
    expect(routedIndex).toBeGreaterThan(0);
    expect(verifyIndex).toBeGreaterThan(0);
    expect(verifyIndex).toBeLessThan(routedIndex); // length verification precedes success
    expect(archiveIndex).toBeGreaterThan(routedIndex); // archive strictly after routing
    expect(agentSrc).toContain("Move-Item -LiteralPath $File.FullName -Destination $archiveDest"); // move, never delete
  });

  it("agent v1.7 sends the full hash+size on the PLAN call; ledger dedupe unchanged; test 22 root-only scan intact", () => {
    // 15H.3: version pin updated deliberately (1.5 -> 1.6 review reconciliation).
    expect(agentSrc).toContain("gso-print-intake-agent/1.11");
    expect(agentSrc).toContain("fileHash = $FileHash; fileSize = $FileSize");
    expect(agentSrc).toContain("Get-RoutePlan $Config $File.Name $subfolder $hash $File.Length");
    expect(agentSrc).toContain("ledger_skip"); // content dedupe untouched
    expect(agentSrc).toContain("Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue");
  });

  it("tests 18/20: RIP match-back — a routed name leads with the exact ticket; PrintIntake migration present", () => {
    const example = buildIntakeRipName("GSO-20260726-0042", "roland", "GLOSS-3X", "Flame Society_art.pdf");
    expect(example.startsWith("GSO-20260726-0042__")).toBe(true);
    // migration exists but is deploy-applied, never dev-run against prod
    const migration = readFileSync(new URL("../prisma/migrations/20260726120000_add_print_intake/migration.sql", import.meta.url), "utf8");
    expect(migration).toContain('CREATE TABLE "PrintIntake"');
    expect(migration).toContain("PrintIntake_shop_fileHashSha256_key");
  });
});
