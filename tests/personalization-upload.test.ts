// Stock Bag personalization — Phase 2 upload endpoint.
// Handler + rate limiter + asset resolution unit tests, plus route source pins
// (repo convention: no route module imports, all Shopify calls mocked).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAX_PERSONALIZATION_FILES, MAX_PERSONALIZATION_FILE_BYTES } from "../app/lib/personalization-assets.server";
import {
  MAX_PERSONALIZATION_REQUEST_BYTES,
  RATE_LIMIT_MAX_REQUESTS,
  createInMemoryRateLimiter,
  deriveClientIdentity,
  handlePersonalizationUpload,
  isPlausibleAssetId,
  resolvePersonalizationAssetById,
} from "../app/lib/personalization-upload.server";
import { issuePersonalizationClaim, verifyPersonalizationClaim } from "../app/lib/personalization-claim.server";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

const png = (fileName = "logo.png") => ({ fileName, mimeType: "image/png", bytes: PNG });
const ROUTE = "app/routes/apps.wholesale-lite.personalization-upload.ts";

// Phase 4: a real signer over a test secret — process.env is never touched.
const SHOP = "test-shop.myshopify.com";
const SECRET = "test-secret-not-a-real-key";

function makeDeps(opts: Partial<{ statuses: string[]; stagedError: string; throwOnStaged: boolean; allowed: boolean }> = {}) {
  const uploads: string[] = [];
  const logs: Array<{ message: string; detail: any }> = [];
  let statusIndex = 0;
  const statuses = opts.statuses ?? ["READY"];

  return {
    uploads,
    logs,
    deps: {
      wait: async () => {},
      token: () => "tok123",
      rateLimiter: { async check() { return { allowed: opts.allowed !== false, retryAfterSeconds: opts.allowed === false ? 42 : 0 }; } },
      logError: (message: string, detail: any) => logs.push({ message, detail }),
      signClaim: (asset: any) => issuePersonalizationClaim(asset, SECRET),
      graphql: async (query: string) => {
        if (query.includes("stagedUploadsCreate")) {
          if (opts.throwOnStaged) throw new Error("ECONNRESET staged.example internal detail");
          if (opts.stagedError) {
            return { data: { stagedUploadsCreate: { stagedTargets: [], userErrors: [{ message: opts.stagedError }] } } };
          }
          uploads.push("staged");
          return { data: { stagedUploadsCreate: { stagedTargets: [{ url: "https://staged.example/u", resourceUrl: "https://staged.example/r", parameters: [] }], userErrors: [] } } };
        }
        if (query.includes("fileCreate")) {
          uploads.push("create");
          return { data: { fileCreate: { files: [{ id: "gid://shopify/MediaImage/1", fileStatus: "UPLOADED" }], userErrors: [] } } };
        }
        const status = statuses[Math.min(statusIndex, statuses.length - 1)];
        statusIndex += 1;
        return { data: { node: { id: "gid://shopify/MediaImage/1", fileStatus: status, image: { url: status === "READY" ? "https://cdn.shopify.com/a.png" : null } } } };
      },
      uploadBytes: async () => { uploads.push("bytes"); },
    },
  };
}

describe("upload handler — happy paths", () => {
  it("accepts one valid PNG and returns READY", async () => {
    const { deps } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "shop:guest", files: [png()] });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0]).toEqual({
      assetId: "gid://shopify/MediaImage/1",
      fileName: "gso-personalization-tok123.png",
      originalFileName: "logo.png",
      fileUrl: "https://cdn.shopify.com/a.png",
      mimeType: "image/png",
      byteSize: PNG.length,
      assetRole: "personalization",
      status: "READY",
      assetClaim: expect.any(String),
    });
    // Phase 4: the claim really verifies for this shop + this asset.
    expect(
      verifyPersonalizationClaim(res.body.assets[0].assetClaim, { shop: SHOP, assetId: "gid://shopify/MediaImage/1" }, SECRET).ok,
    ).toBe(true);
  });

  it("accepts multiple valid files of mixed allowed types", async () => {
    const { deps } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, {
      shop: SHOP,
      identity: "i",
      files: [png("logo.png"), { fileName: "qr.jpg", mimeType: "image/jpeg", bytes: JPEG }, { fileName: "b.pdf", mimeType: "application/pdf", bytes: PDF }],
    });
    expect(res.ok).toBe(true);
    expect(res.body.assets.map((a: any) => a.mimeType)).toEqual(["image/png", "image/jpeg", "application/pdf"]);
  });

  it("accepts exactly 5 files", async () => {
    const { deps } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: Array.from({ length: MAX_PERSONALIZATION_FILES }, () => png()) });
    expect(res.ok).toBe(true);
    expect(res.body.assets).toHaveLength(5);
  });

  it("reports PROCESSING rather than failure while Shopify is still working", async () => {
    const { deps } = makeDeps({ statuses: ["PROCESSING"] });
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [png()] });
    expect(res.ok).toBe(true);
    expect(res.body.assets[0].status).toBe("PROCESSING");
    expect(res.body.assets[0].fileUrl).toBeNull();
    // the durable identity still comes back so Phase 3 can poll
    expect(res.body.assets[0].assetId).toBe("gid://shopify/MediaImage/1");
  });
});

describe("upload handler — rejections happen before any Shopify write", () => {
  it("rejects zero files", async () => {
    const { deps, uploads } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [] });
    expect(res.body).toEqual({ ok: false, code: "NO_FILES", message: "Choose at least one file to upload." });
    expect(uploads).toHaveLength(0);
  });

  it("rejects 6 files before uploading anything", async () => {
    const { deps, uploads } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: Array.from({ length: 6 }, () => png()) });
    expect(res.body.code).toBe("TOO_MANY_FILES");
    expect(res.body.message).toBe("You can upload up to 5 files.");
    expect(uploads).toHaveLength(0);
  });

  it("rejects an oversized file", async () => {
    const { deps, uploads } = makeDeps();
    const big = new Uint8Array(MAX_PERSONALIZATION_FILE_BYTES + 1);
    big.set(PNG, 0);
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [{ fileName: "big.png", mimeType: "image/png", bytes: big }] });
    expect(res.body.code).toBe("FILE_TOO_LARGE");
    expect(uploads).toHaveLength(0);
  });

  it("rejects unsupported types including SVG", async () => {
    const { deps, uploads } = makeDeps();
    const svg: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [{ fileName: "l.svg", mimeType: "image/svg+xml", bytes: SVG }] });
    expect(svg.body.code).toBe("UNSUPPORTED_FILE_TYPE");
    const exe: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [{ fileName: "a.exe", mimeType: "application/x-msdownload", bytes: EXE }] });
    expect(exe.body.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(uploads).toHaveLength(0);
  });

  it("rejects a MIME/signature mismatch", async () => {
    const { deps, uploads } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [{ fileName: "fake.png", mimeType: "image/png", bytes: PDF }] });
    expect(res.body.code).toBe("FILE_CONTENT_MISMATCH");
    expect(uploads).toHaveLength(0);
  });

  it("performs ZERO Shopify uploads when a batch mixes valid and invalid files", async () => {
    const { deps, uploads } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, {
      shop: SHOP,
      identity: "i",
      files: [png("good.png"), { fileName: "bad.svg", mimeType: "image/svg+xml", bytes: SVG }, png("good2.png")],
    });
    expect(res.ok).toBe(false);
    expect(res.body.failedFile).toBe("bad.svg");
    // atomic validation: nothing partially stored
    expect(uploads).toHaveLength(0);
  });
});

describe("upload handler — storage failures stay safe", () => {
  it("handles a Shopify userError without leaking internals", async () => {
    const { deps, logs } = makeDeps({ stagedError: "Internal quota exceeded for shop 12345" });
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [png("brand.png")] });
    expect(res.body.code).toBe("UPLOAD_FAILED");
    expect(res.body.message).toBe("We could not save your file. Please try again.");
    expect(JSON.stringify(res.body)).not.toContain("quota");
    expect(JSON.stringify(res.body)).not.toContain("12345");
    // ...but the detail IS logged server-side
    expect(logs.some((l) => JSON.stringify(l.detail).includes("quota"))).toBe(true);
  });

  it("handles a staged-upload transport failure without leaking a stack", async () => {
    const { deps, logs } = makeDeps({ throwOnStaged: true });
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [png()] });
    expect(res.body.code).toBe("UPLOAD_FAILED");
    expect(JSON.stringify(res.body)).not.toContain("ECONNRESET");
    expect(JSON.stringify(res.body)).not.toContain("staged.example");
    expect(logs).toHaveLength(1);
  });

  it("returns only bounded public fields", async () => {
    const { deps } = makeDeps();
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [png()] });
    expect(Object.keys(res.body)).toEqual(["ok", "assets"]);
    expect(Object.keys(res.body.assets[0]).sort()).toEqual(
      ["assetClaim", "assetId", "assetRole", "byteSize", "fileName", "fileUrl", "mimeType", "originalFileName", "status"].sort(),
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("staged.example");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("X-Shopify-Access-Token");
    // Phase 4: no signing internals travel with the claim.
    expect(serialized).not.toContain(SECRET);
    expect(serialized.toLowerCase()).not.toContain("hmac");
    expect(serialized).not.toContain("SHOPIFY_API_SECRET");
  });
});

describe("rate limiting", () => {
  it("enforces the threshold and then blocks", async () => {
    let clock = 1_000_000;
    const limiter = createInMemoryRateLimiter(RATE_LIMIT_MAX_REQUESTS, 10 * 60 * 1000, () => clock);
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      expect((await limiter.check("shop:guest")).allowed).toBe(true);
    }
    const blocked = await limiter.check("shop:guest");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // a different identity is unaffected
    expect((await limiter.check("shop:customer:99")).allowed).toBe(true);
    // window rolls over
    clock += 10 * 60 * 1000 + 1;
    expect((await limiter.check("shop:guest")).allowed).toBe(true);
  });

  it("returns RATE_LIMITED without touching storage", async () => {
    const { deps, uploads } = makeDeps({ allowed: false });
    const res: any = await handlePersonalizationUpload(deps as any, { shop: SHOP, identity: "i", files: [png()] });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(uploads).toHaveLength(0);
  });

  it("derives identity from the Shopify-signed customer id, not a client header", () => {
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: "123" })).toBe("s.myshopify.com:customer:123");
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: null })).toBe("s.myshopify.com:guest");
    // injection attempts are stripped to digits
    expect(deriveClientIdentity({ shop: "s.myshopify.com", loggedInCustomerId: "1;drop" })).toBe("s.myshopify.com:customer:1");
  });
});

describe("server-side asset resolution (Phase 4 authority)", () => {
  it("resolves a READY asset from its id", async () => {
    const { deps } = makeDeps();
    const res: any = await resolvePersonalizationAssetById(deps as any, "gid://shopify/MediaImage/1");
    expect(res).toEqual({ ok: true, assetId: "gid://shopify/MediaImage/1", fileUrl: "https://cdn.shopify.com/a.png", status: "READY" });
  });

  it("never trusts a forged client fileUrl — only the id is read", async () => {
    const seen: any[] = [];
    const deps = {
      graphql: async (_q: string, v: any) => {
        seen.push(v);
        return { data: { node: { id: "gid://shopify/MediaImage/1", fileStatus: "READY", image: { url: "https://cdn.shopify.com/real.png" } } } };
      },
    };
    const res: any = await resolvePersonalizationAssetById(deps as any, "gid://shopify/MediaImage/1");
    // the resolved URL comes from Shopify, never from the caller
    expect(res.fileUrl).toBe("https://cdn.shopify.com/real.png");
    expect(seen[0]).toEqual({ id: "gid://shopify/MediaImage/1" });
    // a raw URL or bogus id is refused outright
    expect(await resolvePersonalizationAssetById(deps as any, "https://evil.example/x.png")).toEqual({ ok: false, reason: "Unknown asset.", code: "UNKNOWN" });
    expect(isPlausibleAssetId("https://evil.example/x.png")).toBe(false);
    expect(isPlausibleAssetId("gid://shopify/Product/1")).toBe(false);
    expect(isPlausibleAssetId("gid://shopify/GenericFile/9")).toBe(true);
  });

  it("surfaces FAILED distinctly from PROCESSING", async () => {
    const failed: any = await resolvePersonalizationAssetById(makeDeps({ statuses: ["FAILED"] }).deps as any, "gid://shopify/MediaImage/1");
    expect(failed.ok).toBe(false);
    const processing: any = await resolvePersonalizationAssetById(makeDeps({ statuses: ["PROCESSING"] }).deps as any, "gid://shopify/MediaImage/1");
    expect(processing.ok).toBe(true);
    expect(processing.status).toBe("PROCESSING");
  });
});

describe("route contract (source pins)", () => {
  const route = readFileSync(ROUTE, "utf8");

  it("uses the existing app-proxy authentication, not a second system", () => {
    expect(route).toContain("authenticate.public.appProxy");
    expect(route.includes("authenticate.admin")).toBe(false);
    // token only ever from the verified session
    expect(route).toContain("session?.accessToken");
    expect(route.includes("db.session.findFirst")).toBe(false);
  });

  it("only POST uploads and non-POST is refused cleanly", () => {
    expect(route).toContain('request.method !== "POST"');
    expect(route).toContain('uploadError("INVALID_REQUEST", 405)');
    expect(route).toContain("export const loader");
    // the loader must not call the upload handler
    const loaderBlock = route.slice(route.indexOf("export const loader"), route.indexOf("export const action"));
    expect(loaderBlock.includes("handlePersonalizationUpload")).toBe(false);
  });

  it("caps the request and does not trust Content-Length alone", () => {
    expect(route).toContain("MAX_PERSONALIZATION_REQUEST_BYTES");
    expect(route).toContain("content-length");
    // per-file and running-total checks on the parsed bytes
    expect(route).toContain("entry.size > MAX_PERSONALIZATION_FILE_BYTES");
    expect(route).toContain("total > MAX_PERSONALIZATION_REQUEST_BYTES");
    expect(MAX_PERSONALIZATION_REQUEST_BYTES).toBe(MAX_PERSONALIZATION_FILES * MAX_PERSONALIZATION_FILE_BYTES + 1024 * 1024);
  });

  it("delegates validation instead of duplicating it", () => {
    expect(route).toContain("handlePersonalizationUpload");
    expect(route.includes("detectMimeFromBytes")).toBe(false);
    expect(route.includes("0x89")).toBe(false);
  });

  it("keeps the app-proxy no-5xx convention while still logging faults", () => {
    expect(route).toContain('uploadError("UPLOAD_FAILED", 200)');
    expect(route).toContain("console.error");
    expect(route.includes("status: 500")).toBe(false);
  });

  it("writes nothing to disk", () => {
    expect(route.includes("writeFile")).toBe(false);
    expect(route.includes("node:fs")).toBe(false);
  });
});

describe("phase 2 changes nothing downstream", () => {
  // Phases 4 and 5 deliberately wired cart, checkout and production, so those
  // "downstream is untouched" pins moved to the phase suites that own them.
  // What must STILL hold is that the UPLOAD module stayed a pure upload
  // concern: it knows nothing about carts, orders or production jobs.
  it("keeps the upload endpoint free of cart, order and production concerns", () => {
    const upload = readFileSync("app/lib/personalization-upload.server.ts", "utf8");
    const route = readFileSync(ROUTE, "utf8");
    for (const source of [upload, route]) {
      expect(/ProductionJob|draftOrder|priceEach|cartAssets/.test(source)).toBe(false);
    }
  });

  it("leaves the fake storefront uploader disabled", () => {
    const template = readFileSync("shopify-theme/templates/product.configurator-pilot.json", "utf8");
    const parsed = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
    expect(parsed.sections["1771828352671bead8"].blocks.ai_gen_block_15f470a_xiVLGg.disabled).toBe(true);
  });
});
