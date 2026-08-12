// Phase 15H.4C — merge/link production convergence.
// Pins: source-shell eligibility (fail-closed), target validation reuse,
// target-ticket authority, PrintIntake repointing, tombstone, idempotency,
// audit trail, file/RIP history preservation, and untouched neighbors.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessLinkSource,
  jobSourceType,
  linkIntakeJobToTarget,
} from "../app/lib/production-job-source.server";
import { dispositionOf } from "../app/lib/print-intake-review.server";

type Job = Record<string, any>;

function world() {
  const jobs: Job[] = [];
  const intakes: Job[] = [];
  const files: Job[] = [];
  const events: Job[] = [];
  const printLogs: Job[] = [];
  const tx = {
    $queryRawUnsafe: async () => [],
    productionJob: {
      findFirst: async ({ where }: any) => {
        const job = jobs.find((row) => row.id === where.id && row.shop === where.shop) || null;
        return job ? JSON.parse(JSON.stringify(job)) : null;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.find((row) => row.id === where.id);
        if (job) Object.assign(job, data);
        return job;
      },
    },
    printIntake: {
      findMany: async ({ where }: any) =>
        intakes.filter((row) => row.shop === where.shop && (row.generatedProductionJobId === where.OR[0].generatedProductionJobId || row.matchedProductionJobId === where.OR[1].matchedProductionJobId)).map((row) => ({ ...row })),
      update: async ({ where, data }: any) => {
        const row = intakes.find((entry) => entry.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    productionJobFile: {
      findMany: async ({ where }: any) => files.filter((row) => row.shop === where.shop && row.jobId === where.jobId).map((row) => ({ ...row })),
      create: async ({ data }: any) => { files.push({ id: `file_${files.length}`, ...data }); return data; },
    },
    productionJobEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    printLogEntry: { count: async ({ where }: any) => printLogs.filter((row) => row.productionJobId === where.productionJobId).length },
  };
  const db = { $transaction: async (fn: any) => fn(tx) };
  return { db, jobs, intakes, files, events, printLogs };
}

const shell = (over: Job = {}): Job => ({
  id: "shell1", shop: "shop.test", active: true, status: "new", actualCostFinalized: false,
  orderGid: null, quoteId: null, jobTicket: "GSO-20260811-0002", proofApprovalToken: null, proofStatus: "draft",
  internalNotes: "PRINT INTAKE — UNLINKED.", items: [{ id: "sitem", itemTicket: "GSO-20260811-0002-01" }],
  ...over,
});

const target = (over: Job = {}): Job => ({
  id: "target1", shop: "shop.test", active: true, status: "new", actualCostFinalized: false,
  orderGid: "gid://shopify/Order/999", quoteId: "shopify_order_gid://shopify/Order/999",
  jobTicket: "GSO-20260812-0005", proofApprovalToken: null, proofStatus: "draft", internalNotes: null,
  items: [{ id: "titem", itemTicket: "GSO-20260812-0005-01" }],
  ...over,
});

const intakeRow = (over: Job = {}): Job => ({
  id: "pi1", shop: "shop.test", generatedProductionJobId: "shell1", matchedProductionJobId: null,
  authoritativeTicket: "GSO-20260811-0002", status: "routed", originalFilename: "free-name.pdf",
  fileHashSha256: "a".repeat(64), rawParsedHints: JSON.stringify({ hints: { mode: "CMYK" } }),
  ...over,
});

describe("15H.4C link convergence", () => {
  it("source classification: shopify/quote/manual/intake", () => {
    expect(jobSourceType({ orderGid: "gid://shopify/Order/1", quoteId: null })).toBe("shopify");
    expect(jobSourceType({ orderGid: null, quoteId: "shopify_order_gid://shopify/Order/1" })).toBe("shopify");
    expect(jobSourceType({ orderGid: null, quoteId: "manual_abc12345" })).toBe("manual");
    expect(jobSourceType({ orderGid: null, quoteId: "cmev9xyz123" })).toBe("quote");
    expect(jobSourceType({ orderGid: null, quoteId: null })).toBe("intake");
  });

  it("B+4-7. source eligibility fails closed: shopify/quote/manual/finalized/completed/proof/inactive all reject", () => {
    expect(assessLinkSource(shell() as any, true).ok).toBe(true);
    expect((assessLinkSource(shell({ quoteId: "shopify_order_x" }) as any, true) as any).reason).toContain("never source shells");
    expect((assessLinkSource(shell({ quoteId: "some-quote-id" }) as any, true) as any).reason).toContain("never source shells");
    expect((assessLinkSource(shell({ quoteId: "manual_12345678" }) as any, true) as any).reason).toContain("never source shells");
    expect((assessLinkSource(shell() as any, false) as any).reason).toContain("no print-intake provenance");
    expect((assessLinkSource(shell({ actualCostFinalized: true }) as any, true) as any).reason).toContain("FINALIZED");
    expect((assessLinkSource(shell({ status: "completed" }) as any, true) as any).reason).toContain("completed");
    expect((assessLinkSource(shell({ active: false }) as any, true) as any).reason).toContain("inactive");
    expect((assessLinkSource(shell({ proofStatus: "sent" }) as any, true) as any).reason).toContain("proof");
    expect((assessLinkSource(shell({ proofApprovalToken: "gso_x" }) as any, true) as any).reason).toContain("proof");
  });

  it("1+12+13+14+16+17+18+19+20. full link: repoint, tombstone, audit, tickets/files/history preserved", async () => {
    const w = world();
    w.jobs.push(shell(), target());
    w.intakes.push(intakeRow());
    w.files.push({ id: "f1", shop: "shop.test", jobId: "shell1", fileName: "free-name.pdf", fileType: "artwork", fileUrl: "u", assetRole: "artwork", assetSource: "nas", sourceRef: null, originalFileName: "free-name.pdf" });
    w.printLogs.push({ productionJobId: "shell1" });

    const result = await linkIntakeJobToTarget(w.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "owner", reason: "customer order artwork" });
    expect(result).toMatchObject({ ok: true, linked: true, targetTicket: "GSO-20260812-0005-01" });

    const shellJob = w.jobs.find((job) => job.id === "shell1")!;
    expect(shellJob.active).toBe(false); // tombstoned, never deleted
    expect(shellJob.jobTicket).toBe("GSO-20260811-0002"); // shell ticket historical, unchanged
    expect(shellJob.internalNotes).toContain("Linked to GSO-20260812-0005-01");
    const targetJob = w.jobs.find((job) => job.id === "target1")!;
    expect(targetJob.jobTicket).toBe("GSO-20260812-0005"); // target ticket authoritative, unchanged

    const intake = w.intakes[0];
    expect(intake.matchedProductionJobId).toBe("target1");
    expect(intake.generatedProductionJobId).toBeNull(); // no longer authoritative
    expect(intake.authoritativeTicket).toBe("GSO-20260812-0005-01");
    expect(intake.status).toBe("routed"); // already-routed artwork stays routed
    const meta = JSON.parse(intake.rawParsedHints);
    expect(meta.linkedFrom).toMatchObject({ shellJobId: "shell1", shellTicket: "GSO-20260811-0002" });
    expect(meta.hints.mode).toBe("CMYK"); // pre-existing hints preserved
    // future agent/status reconciliation returns the TARGET identity
    expect(dispositionOf(intake as any)).toMatchObject({ disposition: "already_routed" });

    // file copied to target; shell original untouched; nothing deleted
    expect(w.files.filter((file) => file.jobId === "shell1")).toHaveLength(1);
    const targetFile = w.files.find((file) => file.jobId === "target1")!;
    expect(targetFile.matchedBy).toBe("linked_from_intake");
    expect(targetFile.sourceRef).toBe("GSO-20260811-0002");
    // both audit events, RIP history noted
    const away = w.events.find((event) => event.eventType === "production_job_linked_away")!;
    expect(away.jobId).toBe("shell1");
    expect(away.message).toContain("1 print-log row(s) remain historically");
    const from = w.events.find((event) => event.eventType === "production_job_linked_from_intake")!;
    expect(from.jobId).toBe("target1");
    expect(from.message).toContain("GSO-20260811-0002");
  });

  it("2+3. quote and manual targets work when owner explicitly chooses them", async () => {
    for (const targetOver of [{ orderGid: null, quoteId: "quote123" }, { orderGid: null, quoteId: "manual_abcdefgh" }]) {
      const w = world();
      w.jobs.push(shell(), target(targetOver));
      w.intakes.push(intakeRow());
      const result = await linkIntakeJobToTarget(w.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "owner" });
      expect(result.ok).toBe(true);
    }
  });

  it("8+9+C. cross-shop target rejected; multi-item target requires the explicit item", async () => {
    const w1 = world();
    w1.jobs.push(shell(), target({ shop: "other.shop" }));
    w1.intakes.push(intakeRow());
    expect((await linkIntakeJobToTarget(w1.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", actor: "o" })).message).toContain("not found");

    const w2 = world();
    w2.jobs.push(shell(), target({ items: [{ id: "t1", itemTicket: "T-01" }, { id: "t2", itemTicket: "T-02" }] }));
    w2.intakes.push(intakeRow());
    expect((await linkIntakeJobToTarget(w2.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", actor: "o" })).message).toContain("multiple items");
    expect((await linkIntakeJobToTarget(w2.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "t2", actor: "o" })).ok).toBe(true);
  });

  it("10+11+K. idempotent same-target relink; different target rejected after link", async () => {
    const w = world();
    w.jobs.push(shell(), target(), target({ id: "target2", jobTicket: "GSO-20260812-0009", quoteId: "shopify_order_z", items: [{ id: "t2i", itemTicket: "GSO-20260812-0009-01" }] }));
    w.intakes.push(intakeRow());
    const first = await linkIntakeJobToTarget(w.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "o" });
    expect(first.linked).toBe(true);
    const again = await linkIntakeJobToTarget(w.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "o" });
    expect(again).toMatchObject({ ok: true, linked: false });
    expect(again.message).toContain("Already linked");
    const other = await linkIntakeJobToTarget(w.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target2", targetItemId: "t2i", actor: "o" });
    expect(other.ok).toBe(false);
    expect(other.message).toContain("different job");
  });

  it("6+21+22+L+M. finalized-cost and proof-active sources are blocked", async () => {
    const w1 = world();
    w1.jobs.push(shell({ actualCostFinalized: true }), target());
    w1.intakes.push(intakeRow());
    expect((await linkIntakeJobToTarget(w1.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "o" })).message).toContain("FINALIZED");

    const w2 = world();
    w2.jobs.push(shell({ proofStatus: "sent", proofApprovalToken: "gso_tok" }), target());
    w2.intakes.push(intakeRow());
    expect((await linkIntakeJobToTarget(w2.db, { shop: "shop.test", sourceJobId: "shell1", targetJobId: "target1", targetItemId: "titem", actor: "o" })).message).toContain("proof");
  });

  it("16B: recommendation quick-add is suppressed under the configurator lockout (both rule families)", () => {
    const css = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.css", "utf8");
    expect(css).toContain("body.gso-native-purchase-lockout .quick-add,");
    expect(css).toContain('body:has([data-gso-lockout="1"]) .quick-add,');
    expect(css).toContain("body.gso-native-purchase-lockout quick-add-modal");
    expect(css).toContain('body:has([data-gso-lockout="1"]) quick-add-modal');
  });

  it("23+24+D+N+O. UI pins: link action, target ordering, assign ordering, filename guidance", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain('value="linkJobToTarget"');
    expect(board).toContain("Link to Existing Job");
    expect(board).toContain("orders first, then quotes, then manual");
    expect(board).toContain('{ shopify: 0, quote: 1, manual: 2, other: 3, intake: 4 }');
    expect(board).toContain("Use this filename before placing artwork into Prints For Today so it attaches automatically.");
    expect(board).toContain('name="confirmLink"');
    const intake = readFileSync("app/routes/app.erp.print-intake.tsx", "utf8");
    expect(intake).toContain("jobSourceType");
    expect(intake).toContain("{ shopify: 0, quote: 1, manual: 2, other: 3, intake: 4 }");
  });

  it("25-30. tickets, RIP matcher, routing, pricing, order convergence, manual creation untouched", () => {
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(source).toContain('String(sequence).padStart(4, "0")'); // allocator intact
    expect(source).toContain("parseCanonicalOrderLine"); // order convergence intact
    expect(source).toContain("sourceKey = `manual_${requestId}`"); // manual creation intact
    expect(readFileSync("app/lib/rip-identity-match.server.ts", "utf8")).toContain("exact_item_ticket");
    expect(readFileSync("app/lib/print-intake-routing.server.ts", "utf8")).toContain('reasons: ["default_cmyk_to_mimaki"]');
    expect(readFileSync("app/lib/commercial-pricing-policy.server.ts", "utf8")).toContain("BAGS_4X5_FRONT_LADDER");
  });
});
