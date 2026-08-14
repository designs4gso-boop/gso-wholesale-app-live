// Stock Bag personalization — Phase 2.5 durable rate limiting.
// Uses a hand-rolled in-memory fake Prisma client (repo convention: no real DB).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_RETENTION_MS,
  RATE_LIMIT_WINDOW_MS,
  createPrismaRateLimiter,
  deriveClientIdentity,
  handlePersonalizationUpload,
} from "../app/lib/personalization-upload.server";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const png = () => ({ fileName: "logo.png", mimeType: "image/png", bytes: PNG });

/**
 * Fake Prisma. `rows` is deliberately shared-able so a test can build two
 * limiters over the same store — that is what "a new handler instance" means
 * for a durable limiter.
 */
function makeDb(rows: Array<{ identityKey: string; createdAt: Date }> = [], opts: { fail?: boolean } = {}) {
  let seq = 0;
  const model = {
    async create({ data }: any) {
      if (opts.fail) throw new Error("connection refused: db.internal:5432");
      const row = { id: `r${(seq += 1)}`, identityKey: data.identityKey, createdAt: data.createdAt ?? new Date(clock.value) };
      rows.push(row);
      return row;
    },
    async count({ where }: any) {
      if (opts.fail) throw new Error("connection refused");
      return rows.filter((r) => r.identityKey === where.identityKey && r.createdAt > where.createdAt.gt).length;
    },
    async deleteMany({ where }: any) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].createdAt < where.createdAt.lt) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
  };
  const clock = { value: 1_000_000 };
  const db = {
    personalizationUploadRateLimit: model,
    async $transaction(fn: any) {
      if (opts.fail) throw new Error("connection refused: db.internal:5432");
      return fn({ personalizationUploadRateLimit: model });
    },
  };
  return { db, rows, clock };
}

describe("durable rate limiter", () => {
  it("allows the first request", async () => {
    const { db, clock, rows } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    expect(await limiter.check("shop:guest")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(rows).toHaveLength(1);
  });

  it("allows requests 1-20 and rate-limits the 21st", async () => {
    const { db, clock } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      expect((await limiter.check("shop:guest")).allowed).toBe(true);
    }
    const denied = await limiter.check("shop:guest");
    expect(denied.allowed).toBe(false);
    expect(denied.unavailable).toBeUndefined();
    expect(denied.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / 1000);
  });

  it("isolates different identities", async () => {
    const { db, clock } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) await limiter.check("shop:guest");
    expect((await limiter.check("shop:guest")).allowed).toBe(false);
    expect((await limiter.check("shop:customer:42")).allowed).toBe(true);
    expect((await limiter.check("other-shop:guest")).allowed).toBe(true);
  });

  it("allows again once the window expires", async () => {
    const { db, clock } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) await limiter.check("shop:guest");
    expect((await limiter.check("shop:guest")).allowed).toBe(false);
    clock.value += RATE_LIMIT_WINDOW_MS + 1000;
    expect((await limiter.check("shop:guest")).allowed).toBe(true);
  });

  it("survives a new handler instance because state lives in the database", async () => {
    const shared: Array<{ identityKey: string; createdAt: Date }> = [];
    const first = makeDb(shared);
    const limiterA = createPrismaRateLimiter(first.db, { now: () => first.clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) await limiterA.check("shop:guest");

    // simulate a restart / second Render instance over the same rows
    const second = makeDb(shared);
    second.clock.value = first.clock.value;
    const limiterB = createPrismaRateLimiter(second.db, { now: () => second.clock.value, random: () => 1 });
    const denied = await limiterB.check("shop:guest");
    expect(denied.allowed).toBe(false);
  });

  it("records denied attempts so hammering cannot refresh the budget", async () => {
    const { db, clock, rows } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS + 3; i += 1) await limiter.check("shop:guest");
    expect(rows).toHaveLength(RATE_LIMIT_MAX_REQUESTS + 3);
  });
});

describe("failure behavior", () => {
  it("fails CLOSED when the database is unavailable", async () => {
    const logs: any[] = [];
    const { db } = makeDb([], { fail: true });
    const limiter = createPrismaRateLimiter(db, { logError: (m, d) => logs.push({ m, d }) });
    const verdict = await limiter.check("shop:guest");
    expect(verdict.allowed).toBe(false);
    expect(verdict.unavailable).toBe(true);
    // detail is logged server-side, not returned
    expect(JSON.stringify(logs)).toContain("connection refused");
  });

  it("returns a bounded UPLOAD_FAILED (not RATE_LIMITED) when the limiter is broken", async () => {
    const { db } = makeDb([], { fail: true });
    const limiter = createPrismaRateLimiter(db);
    const res: any = await handlePersonalizationUpload(
      { rateLimiter: limiter, graphql: async () => ({}), uploadBytes: async () => {} } as any,
      { identity: "shop:guest", files: [png()] },
    );
    expect(res.ok).toBe(false);
    expect(res.body.code).toBe("UPLOAD_FAILED");
    expect(JSON.stringify(res.body)).not.toContain("db.internal");
    expect(JSON.stringify(res.body)).not.toContain("connection refused");
  });

  it("never invokes Shopify after a rate-limit denial", async () => {
    const calls: string[] = [];
    const { db, clock } = makeDb();
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) await limiter.check("shop:guest");

    const res: any = await handlePersonalizationUpload(
      {
        rateLimiter: limiter,
        graphql: async () => { calls.push("graphql"); return {}; },
        uploadBytes: async () => { calls.push("bytes"); },
      } as any,
      { identity: "shop:guest", files: [png()] },
    );
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe("retention cleanup", () => {
  it("removes stale rows but never rows inside the active window", async () => {
    const { db, clock, rows } = makeDb();
    const old = new Date(clock.value - RATE_LIMIT_RETENTION_MS - 60_000);
    rows.push({ identityKey: "shop:guest", createdAt: old });
    rows.push({ identityKey: "shop:guest", createdAt: new Date(clock.value - 1000) });

    // random() below the probability forces the sweep to run
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 0 });
    await limiter.check("shop:guest");

    expect(rows.some((r) => r.createdAt.getTime() === old.getTime())).toBe(false);
    // the in-window row and the one just written both survive
    expect(rows).toHaveLength(2);
  });

  it("does not sweep on most requests", async () => {
    const { db, clock, rows } = makeDb();
    rows.push({ identityKey: "x", createdAt: new Date(clock.value - RATE_LIMIT_RETENTION_MS - 60_000) });
    const limiter = createPrismaRateLimiter(db, { now: () => clock.value, random: () => 0.9 });
    await limiter.check("shop:guest");
    // stale row still present because the sweep did not run this time
    expect(rows.some((r) => r.identityKey === "x")).toBe(true);
  });
});

describe("identity derivation is unchanged and untrusted headers are ignored", () => {
  it("keeps logged-in and guest identities stable", () => {
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: "123" })).toBe("s.myshopify.com:customer:123");
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: "123" })).toBe("s.myshopify.com:customer:123");
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: null })).toBe("s.myshopify.com:guest");
  });

  it("ignores forwarded IPs entirely — identity has no IP input", () => {
    // The header must never be READ. (It is named in a comment explaining that
    // it is deliberately untrusted, so assert on header access, not on the word.)
    const source = readFileSync("app/lib/personalization-upload.server.ts", "utf8");
    const route = readFileSync("app/routes/apps.wholesale-lite.personalization-upload.ts", "utf8");
    for (const file of [source, route]) {
      expect(/headers\s*\.\s*get\(\s*["'`]x-forwarded-for/i.test(file)).toBe(false);
      expect(/headers\s*\[\s*["'`]x-forwarded-for/i.test(file)).toBe(false);
      expect(/getClientIp|remoteAddress|socket\.remote/i.test(file)).toBe(false);
    }
    // deriveClientIdentity takes no IP-shaped input at all
    expect(source).toContain("deriveClientIdentity(input: { shop: string; loggedInCustomerId?: string | null })");
    // identity is built only from the verified shop + Shopify-signed customer id
    expect(route).toContain("logged_in_customer_id");
  });
});

describe("route + schema wiring", () => {
  it("uses the durable limiter by default, not the in-memory one", () => {
    const route = readFileSync("app/routes/apps.wholesale-lite.personalization-upload.ts", "utf8");
    expect(route).toContain("createPrismaRateLimiter(db");
    expect(route.includes("createInMemoryRateLimiter")).toBe(false);
  });

  it("keeps the RateLimiter interface injectable for tests", () => {
    const source = readFileSync("app/lib/personalization-upload.server.ts", "utf8");
    expect(source).toContain("export type RateLimiter");
    expect(source).toContain("rateLimiter: RateLimiter");
  });

  it("declares a minimal PII-free model and a staged migration", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toContain("model PersonalizationUploadRateLimit");
    expect(schema).toContain("@@index([identityKey, createdAt])");
    // no PII / no payload data in the limiter table
    const model = schema.slice(schema.indexOf("model PersonalizationUploadRateLimit"));
    const body = model.slice(0, model.indexOf("}"));
    expect(body.includes("ip")).toBe(false);
    expect(body.includes("fileName")).toBe(false);
    expect(body.includes("email")).toBe(false);

    const sql = readFileSync("prisma/migrations/20260813210000_add_personalization_upload_rate_limit/migration.sql", "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PersonalizationUploadRateLimit"');
    // additive only — nothing destructive
    expect(sql.includes("DROP ")).toBe(false);
    expect(sql.includes("ALTER TABLE") && sql.includes("DROP COLUMN")).toBe(false);
  });
});
