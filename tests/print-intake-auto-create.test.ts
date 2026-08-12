// 15F.0J.5 — automatic print-intake job creation, tickets, existing-job
// linking. Pure decision tests + source pins (DB flows are advisory-locked
// transactions pinned by source; no live DB in tests).

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
    items: [{ id: "item1", itemTicket: "GSO-20260726-0001-01", ripJobName: "GSO-20260726-0001-01", suggestedFileName: null, productTitle: "Labels", selectedFinish: null, materialSummary: null, machineSummary: null }],
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
    expect(machine.machineRule).toBe("white_or_gloss");
  });

  it("hazard safety: bare '3x' in a product name and 'White Widow' NEVER trigger premium routing", () => {
    const strain = parseFilenamePrintHints("Blue Chip_Rainbow 3x OG_matte.pdf");
    expect(strain.glossLayers).toBe(0);
    expect(strain.mode).toBe("CMYK");
    expect(decideMachineFromFilename("Blue Chip_Rainbow 3x OG_matte.pdf").machine).toBe("mimaki"); // ordinary CMYK default
    const widow = parseFilenamePrintHints("Cust_White Widow_matte.pdf");
    expect(widow.whiteLayers).toBe(0); // no finish adjacency -> not white ink
    expect(parseFilenamePrintHints("Cust_holo white_labels.pdf").whiteLayers).toBe(1); // finish adjacency counts
    expect(parseFilenamePrintHints("Cust_2x white_labels.pdf").whiteLayers).toBe(2);
  });

  it("tests 10/11: conflicting printer tokens and premium+Mimaki contradictions BLOCK routing", () => {
    const conflict = decideMachineFromFilename("Cust_Product_Roland_Mimaki.pdf");
    expect(conflict.machine).toBeNull();
    expect(conflict.reasons).toContain("conflicting_printer_tokens_in_filename");
    const premiumMimaki = decideMachineFromFilename("Cust_3x spot gloss_MIMAKI.pdf");
    expect(premiumMimaki.machine).toBeNull();
    expect(premiumMimaki.reasons).toContain("premium_mode_but_mimaki_token_contradiction");
    expect(hasMimakiFilenameTag("job_MIMAKI_run.pdf")).toBe(true);
    expect(hasMimakiFilenameTag("mimakingtons.pdf")).toBe(false); // word boundary
  });

  it("test 2: ordinary untagged CMYK defaults to Mimaki deterministically", () => {
    const decision = decideMachineFromFilename("Customer_Product_CMYK.pdf");
    expect(decision.machine).toBe("mimaki");
    expect(decision.machineRule).toBe("default_cmyk");
    expect(decision.mode).toBe("CMYK");
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
    // unmatched files still return review from the PURE decider — the ROUTE
    // (server) layer upgrades deterministic ones to auto-created plans
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

  it("tests 1/7/8/9: unmatched deterministic files AUTO-CREATE and route — commercial gaps become warnings, never blockers", () => {
    expect(routeSrc).toContain("createOrReusePrintIntakeJob(db, {");
    expect(routeSrc).toContain("decideMachineFromFilename(fileName)");
    expect(routeSrc).toContain('rule: "print_intake_auto_created"');
    expect(routeSrc).toContain("Commercial linkage pending: no quote/order/customer attached");
    expect(routeSrc).toContain("reviewWarnings: linkageWarnings");
    // ambiguous candidates route to a controlled job with linkage review
    expect(routeSrc).toContain("Ambiguous existing production candidates");
  });

  it("tests 4/5/6: idempotent on shop+hash — advisory lock, in-transaction recheck, P2002 backstop, no second ticket sequence", () => {
    expect(creatorSrc).toContain('await acquireSourceLock(tx, shop, "print_intake", fileHash)');
    expect(creatorSrc).toContain("const jobTicket = await buildNextJobTicket(tx, shop)"); // SAME authoritative generator
    expect(creatorSrc).toContain('String(error?.code) === "P2002"');
    expect(creatorSrc).toContain("shop_fileHashSha256");
    expect(schemaSrc).toContain("@@unique([shop, fileHashSha256])");
  });

  it("15F.0J.5A-A: advisory lock casts VOID to a supported scalar and stays LOUD on real failures", () => {
    expect(creatorSrc).toContain("pg_advisory_xact_lock(${Math.trunc(keyA)}, ${Math.trunc(keyB)})::text AS gso_lock"); // no void deserialization
    expect(creatorSrc).not.toMatch(/pg_advisory_xact_lock\(\$\{Math\.trunc\(keyA\)\}, \$\{Math\.trunc\(keyB\)\}\)`/); // uncast form gone
    expect(creatorSrc).toContain('gsoCode = "advisory_lock_failed"');
    expect(creatorSrc).toContain("no such function|not supported on|sqlite"); // ONLY SQLite skips; everything else throws
  });

  it("test 19 + 15F.0J.5A-B: nothing fabricated AND no nonexistent ProductionJob.source field — PrintIntake owns provenance", () => {
    expect(creatorSrc).toContain("quantity: 0, // unknown — never fabricated");
    expect(creatorSrc).toContain("PRINT INTAKE — UNLINKED");
    expect(creatorSrc).not.toContain('source: "print_intake"'); // Prisma "Unknown argument `source`" fixed
    expect(creatorSrc).toContain("ProductionJob has NO `source` column");
    expect(creatorSrc).toContain("created_from_print_intake"); // event carries provenance
    expect(creatorSrc).not.toContain('status: "paid"');
    expect(creatorSrc).toContain('customerName: "Unlinked (print intake)"');
    const jobBlock = schemaSrc.split("model ProductionJob {")[1].split("\n}")[0]; // scope to THIS model only
    expect(/\n  source\s+String/.test(jobBlock)).toBe(false); // no `source` column added to ProductionJob
  });

  it("15F.0J.5A-D/E: actionable error codes; live fixture GSO PIPELINE TEST 3_1X SPOT GLOSS_Roland.pdf -> Roland GLOSS-1X", () => {
    for (const code of ["advisory_lock_failed", "schema_mismatch", "print_intake_create_failed", "unique_conflict_recovered", "production_job_create_failed"]) {
      expect(routeSrc).toContain(code);
    }
    expect(routeSrc).toContain("errorCode: code");
    expect(routeSrc).toContain("[redacted-connection]"); // no credentials in messages
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
    expect(agentSrc).toContain("gso-print-intake-agent/1.7");
    expect(agentSrc).toContain("fileHash = $FileHash; fileSize = $FileSize");
    expect(agentSrc).toContain("Get-RoutePlan $Config $File.Name $subfolder $hash $File.Length");
    expect(agentSrc).toContain("ledger_skip"); // content dedupe untouched
    expect(agentSrc).toContain("Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue");
  });

  it("tests 18/20: board visibility + RIP match-back — job carries source print_intake; routed name leads with the exact ticket", () => {
    expect(creatorSrc).toContain("ripJobName: ripName"); // PrintLogEntry ticket regexes match the routed name
    const example = buildIntakeRipName("GSO-20260726-0042", "roland", "GLOSS-3X", "Flame Society_art.pdf");
    expect(example.startsWith("GSO-20260726-0042__")).toBe(true);
    // migration exists but is deploy-applied, never dev-run against prod
    const migration = readFileSync(new URL("../prisma/migrations/20260726120000_add_print_intake/migration.sql", import.meta.url), "utf8");
    expect(migration).toContain('CREATE TABLE "PrintIntake"');
    expect(migration).toContain("PrintIntake_shop_fileHashSha256_key");
  });
});
