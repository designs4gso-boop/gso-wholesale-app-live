// Stock Bag personalization — Phase 4 signed asset claim.
//
// The claim is the only thing standing between "the browser posted a Shopify
// file id" and "that file gets attached to a real order", so these tests lean
// hard on the forgery cases.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_PERSONALIZATION_ASSETS_PER_LINE,
  MAX_PERSONALIZATION_ATTRIBUTE_LENGTH,
  MAX_PERSONALIZATION_CLAIM_LENGTH,
  PERSONALIZATION_ASSETS_KEY,
  PERSONALIZATION_CLAIM_TTL_MS,
  PERSONALIZATION_COUNT_KEY,
  PERSONALIZATION_FILES_KEY,
  decodePersonalizationAssets,
  encodePersonalizationAssets,
  getPersonalizationClaimSecret,
  isPersonalizationAssetId,
  issuePersonalizationClaim,
  parsePostedPersonalizationAssets,
  personalizationLineAttributes,
  verifyPersonalizationClaim,
} from "../app/lib/personalization-claim.server";

const SHOP = "942075-2.myshopify.com";
const OTHER_SHOP = "attacker-shop.myshopify.com";
const SECRET = "test-secret-not-a-real-key";
const OTHER_SECRET = "a-different-secret";
const ASSET_A = "gid://shopify/MediaImage/1111111111";
const ASSET_B = "gid://shopify/MediaImage/2222222222";
const NOW = 1_760_000_000_000;

function claimFor(assetId = ASSET_A, shop = SHOP, secret = SECRET, issuedAt = NOW) {
  return issuePersonalizationClaim(
    { shop, assetId, originalFileName: "logo.png", mimeType: "image/png", byteSize: 2048, issuedAt },
    secret,
  );
}

describe("claim issue + verify", () => {
  it("verifies a freshly issued claim for the same shop and asset", () => {
    const verdict = verifyPersonalizationClaim(claimFor(), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.payload.a).toBe(ASSET_A);
    expect(verdict.payload.s).toBe(SHOP);
    // server-validated metadata rides along so checkout never needs the browser's copy
    expect(verdict.payload.n).toBe("logo.png");
    expect(verdict.payload.m).toBe("image/png");
    expect(verdict.payload.b).toBe(2048);
  });

  it("is deterministic for identical input and distinct per asset", () => {
    expect(claimFor(ASSET_A)).toBe(claimFor(ASSET_A));
    expect(claimFor(ASSET_A)).not.toBe(claimFor(ASSET_B));
  });

  it("refuses to sign an unrecognized asset id or a missing shop", () => {
    expect(() => claimFor("https://evil.example/x.png")).toThrow();
    expect(() => claimFor("gid://shopify/Product/1")).toThrow();
    expect(() => claimFor(ASSET_A, "")).toThrow();
  });

  it("stays comfortably inside the length bound even with a long filename", () => {
    const claim = issuePersonalizationClaim(
      { shop: SHOP, assetId: ASSET_A, originalFileName: "x".repeat(300), mimeType: "application/pdf", byteSize: 10485760, issuedAt: NOW },
      SECRET,
    );
    expect(claim.length).toBeLessThan(MAX_PERSONALIZATION_CLAIM_LENGTH);
    const verdict = verifyPersonalizationClaim(claim, { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET);
    expect(verdict.ok).toBe(true);
    // the filename is bounded at sign time, not merely at display time
    if (verdict.ok) expect(verdict.payload.n.length).toBeLessThanOrEqual(80);
  });
});

describe("forgery is refused", () => {
  it("rejects a claim whose asset id was swapped (claim for A must not validate B)", () => {
    const verdict = verifyPersonalizationClaim(claimFor(ASSET_A), { shop: SHOP, assetId: ASSET_B, now: NOW }, SECRET);
    expect(verdict).toEqual({ ok: false, reason: "WRONG_ASSET" });
  });

  it("rejects a tampered payload — flipping the asset id inside breaks the signature", () => {
    const claim = claimFor(ASSET_A);
    const [encoded, signature] = claim.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    payload.a = ASSET_B;
    const forged = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;
    expect(verifyPersonalizationClaim(forged, { shop: SHOP, assetId: ASSET_B, now: NOW }, SECRET)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("rejects a tampered signature", () => {
    const [encoded, signature] = claimFor().split(".");
    const flipped = signature.slice(0, -1) + (signature.slice(-1) === "A" ? "B" : "A");
    expect(verifyPersonalizationClaim(`${encoded}.${flipped}`, { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(false);
  });

  it("rejects a claim minted for another shop", () => {
    const foreign = claimFor(ASSET_A, OTHER_SHOP);
    expect(verifyPersonalizationClaim(foreign, { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET)).toEqual({
      ok: false,
      reason: "WRONG_SHOP",
    });
    // and it still verifies on the shop it was actually issued for
    expect(verifyPersonalizationClaim(foreign, { shop: OTHER_SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(true);
  });

  it("rejects a claim signed with a different secret", () => {
    const verdict = verifyPersonalizationClaim(claimFor(ASSET_A, SHOP, OTHER_SECRET), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET);
    expect(verdict).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects an id posted with no claim at all, and other malformed shapes", () => {
    for (const bad of ["", "notaclaim", "a.b.c", "....", "  ", null, undefined, 42, {}, "x".repeat(MAX_PERSONALIZATION_CLAIM_LENGTH + 1)]) {
      expect(verifyPersonalizationClaim(bad as any, { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(false);
    }
  });

  it("rejects a base64url payload that is not JSON but is correctly signed", () => {
    // proves the JSON parse is guarded even on the trusted side of the signature
    const encoded = Buffer.from("not json at all", "utf8").toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const key = createHmac("sha256", SECRET).update("gso/personalization-asset-claim/v1").digest();
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(verifyPersonalizationClaim(`${encoded}.${signature}`, { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET)).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
  });
});

describe("expiry keeps saved carts usable", () => {
  it("accepts a claim well inside the window", () => {
    const old = NOW - 20 * 24 * 60 * 60 * 1000; // 20 days
    expect(verifyPersonalizationClaim(claimFor(ASSET_A, SHOP, SECRET, old), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(true);
  });

  it("rejects a claim past the window", () => {
    const ancient = NOW - PERSONALIZATION_CLAIM_TTL_MS - 60_000;
    expect(verifyPersonalizationClaim(claimFor(ASSET_A, SHOP, SECRET, ancient), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
  });

  it("gives a saved cart a month, not a session", () => {
    expect(PERSONALIZATION_CLAIM_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("tolerates small clock drift but not a far-future claim", () => {
    expect(verifyPersonalizationClaim(claimFor(ASSET_A, SHOP, SECRET, NOW + 60_000), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(true);
    expect(verifyPersonalizationClaim(claimFor(ASSET_A, SHOP, SECRET, NOW + 86_400_000), { shop: SHOP, assetId: ASSET_A, now: NOW }, SECRET).ok).toBe(false);
  });
});

describe("posted payload parsing", () => {
  it("accepts nothing, null, and an empty array as 'no personalization'", () => {
    expect(parsePostedPersonalizationAssets(undefined)).toEqual({ ok: true, assets: [] });
    expect(parsePostedPersonalizationAssets(null)).toEqual({ ok: true, assets: [] });
    expect(parsePostedPersonalizationAssets([])).toEqual({ ok: true, assets: [] });
  });

  it("keeps only assetId + assetClaim and discards every other posted field", () => {
    const parsed = parsePostedPersonalizationAssets([
      {
        assetId: ASSET_A,
        assetClaim: "abc.def",
        fileUrl: "https://evil.example/steal.png",
        mimeType: "application/x-msdownload",
        fileName: "../../etc/passwd",
        originalFileName: "totally-legit.png",
        byteSize: 999999999,
        assetRole: "admin",
        status: "READY",
      },
    ]);
    expect(parsed).toEqual({ ok: true, assets: [{ assetId: ASSET_A, assetClaim: "abc.def" }] });
  });

  it("rejects non-arrays, bad ids, missing claims and oversized claims", () => {
    expect(parsePostedPersonalizationAssets("nope")).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parsePostedPersonalizationAssets({ assetId: ASSET_A })).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parsePostedPersonalizationAssets([{ assetId: "gid://shopify/Product/1", assetClaim: "a.b" }]).ok).toBe(false);
    expect(parsePostedPersonalizationAssets([{ assetId: ASSET_A }]).ok).toBe(false);
    expect(parsePostedPersonalizationAssets([{ assetId: ASSET_A, assetClaim: "x".repeat(2000) }]).ok).toBe(false);
    expect(parsePostedPersonalizationAssets([null]).ok).toBe(false);
  });

  it("enforces the 5-asset cap", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ assetId: `gid://shopify/MediaImage/${i + 1}`, assetClaim: "a.b" }));
    expect(parsePostedPersonalizationAssets(five).ok).toBe(true);
    expect(parsePostedPersonalizationAssets([...five, { assetId: ASSET_B, assetClaim: "a.b" }])).toEqual({ ok: false, reason: "TOO_MANY" });
    expect(MAX_PERSONALIZATION_ASSETS_PER_LINE).toBe(5);
  });

  it("collapses duplicate ids instead of inflating the count", () => {
    const parsed = parsePostedPersonalizationAssets([
      { assetId: ASSET_A, assetClaim: "a.b" },
      { assetId: ASSET_A, assetClaim: "c.d" },
    ]);
    expect(parsed.ok && parsed.assets).toHaveLength(1);
  });
});

describe("draft-order attribute serialization", () => {
  const assets = [
    { assetId: ASSET_A, originalFileName: "logo.png", status: "READY" as const },
    { assetId: "gid://shopify/GenericFile/33", originalFileName: "spec.pdf", status: "PROCESSING" as const },
  ];

  it("round-trips id + status losslessly for Phase 5", () => {
    const encoded = encodePersonalizationAssets(assets);
    expect(encoded).toBe("M1111111111:R,G33:P");
    expect(decodePersonalizationAssets(encoded)).toEqual([
      { assetId: ASSET_A, status: "READY" },
      { assetId: "gid://shopify/GenericFile/33", status: "PROCESSING" },
    ]);
  });

  it("ignores garbage on decode rather than inventing an asset", () => {
    expect(decodePersonalizationAssets("M1:R,,junk,X9:Z,G2:P")).toEqual([
      { assetId: "gid://shopify/MediaImage/1", status: "READY" },
      { assetId: "gid://shopify/GenericFile/2", status: "PROCESSING" },
    ]);
    expect(decodePersonalizationAssets(null)).toEqual([]);
  });

  it("emits bounded, underscore-hidden _GSO attributes and no CDN URL", () => {
    const attributes = personalizationLineAttributes(assets);
    expect(attributes.map((a) => a.key)).toEqual([PERSONALIZATION_COUNT_KEY, PERSONALIZATION_ASSETS_KEY, PERSONALIZATION_FILES_KEY]);
    expect(attributes.every((a) => a.key.startsWith("_GSO "))).toBe(true);
    expect(attributes[0].value).toBe("2");
    expect(JSON.stringify(attributes)).not.toContain("cdn.shopify.com");
    expect(JSON.stringify(attributes)).not.toContain("http");
  });

  it("stays under the conservative 255-character attribute bound at worst case", () => {
    const worst = Array.from({ length: 5 }, (_, i) => ({
      assetId: `gid://shopify/MediaImage/${"9".repeat(20).slice(0, 19)}${i}`,
      originalFileName: "z".repeat(120),
      status: "PROCESSING" as const,
    }));
    for (const attribute of personalizationLineAttributes(worst)) {
      expect(attribute.value.length).toBeLessThanOrEqual(MAX_PERSONALIZATION_ATTRIBUTE_LENGTH);
    }
    // the identity field specifically: 5 x 23 chars + 4 separators
    expect(encodePersonalizationAssets(worst).length).toBeLessThanOrEqual(119);
  });

  it("emits nothing at all when there is no personalization", () => {
    expect(personalizationLineAttributes([])).toEqual([]);
  });
});

describe("secret handling", () => {
  const source = readFileSync("app/lib/personalization-claim.server.ts", "utf8");

  it("reads the app secret in exactly one place and never logs it", () => {
    expect(source.match(/process\.env\.SHOPIFY_API_SECRET/g)).toHaveLength(1);
    expect(/console\.(log|error|warn)/.test(source)).toBe(false);
  });

  it("derives a domain-separated key rather than signing with the raw app secret", () => {
    expect(source).toContain("CLAIM_KEY_INFO");
    expect(source).toContain("gso/personalization-asset-claim/v1");
    expect(source).toContain("deriveClaimKey");
  });

  it("compares signatures in constant time", () => {
    expect(source).toContain("timingSafeEqual");
    // a plain === on the signature would defeat the point
    expect(/expected\s*===\s*provided|provided\s*===\s*expected/.test(source)).toBe(false);
  });

  it("fails closed when the secret is absent", () => {
    const before = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;
    try {
      expect(() => getPersonalizationClaimSecret()).toThrow();
      // and the thrown message does not hint at the variable's contents
      expect(() => getPersonalizationClaimSecret()).toThrow(/not configured/);
    } finally {
      if (before !== undefined) process.env.SHOPIFY_API_SECRET = before;
    }
  });

  it("validates asset id shape strictly", () => {
    expect(isPersonalizationAssetId(ASSET_A)).toBe(true);
    expect(isPersonalizationAssetId("gid://shopify/GenericFile/7")).toBe(true);
    expect(isPersonalizationAssetId("gid://shopify/Product/7")).toBe(false);
    expect(isPersonalizationAssetId("gid://shopify/MediaImage/7x")).toBe(false);
    expect(isPersonalizationAssetId("gid://shopify/MediaImage/")).toBe(false);
  });
});
