// Stock Bag personalization — Phase 1 storage foundation.
// Pure validation + a fully mocked Shopify Files flow. No network, no real uploads.
import { describe, expect, it } from "vitest";

import {
  ALLOWED_PERSONALIZATION_MIME_TYPES,
  MAX_PERSONALIZATION_FILES,
  MAX_PERSONALIZATION_FILE_BYTES,
  PERSONALIZATION_ASSET_ROLE,
  buildStoredFileName,
  detectMimeFromBytes,
  resolveFileWhenReady,
  sanitizeOriginalFileName,
  uploadPersonalizationAssets,
  validatePersonalizationBatch,
  validatePersonalizationFile,
} from "../app/lib/personalization-assets.server";

/* ---------- fixtures: real magic bytes, tiny payloads ---------- */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ (Windows PE)
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF

const png = (fileName = "logo.png") => ({ fileName, mimeType: "image/png", bytes: PNG });

/* ---------- mocked Shopify ---------- */
function makeDeps(overrides: Partial<{ statuses: string[]; stagedError: string; createError: string; noId: boolean }> = {}) {
  const calls: Array<{ op: string; variables: any }> = [];
  let statusIndex = 0;
  const statuses = overrides.statuses ?? ["READY"];

  const deps = {
    wait: async () => {},
    token: () => "tok123",
    graphql: async (query: string, variables: any) => {
      if (query.includes("stagedUploadsCreate")) {
        calls.push({ op: "stagedUploadsCreate", variables });
        if (overrides.stagedError) {
          return { data: { stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ["filename"], message: overrides.stagedError }] } } };
        }
        return {
          data: {
            stagedUploadsCreate: {
              stagedTargets: [{ url: "https://staged.example/upload", resourceUrl: "https://staged.example/resource/1", parameters: [{ name: "key", value: "k" }] }],
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("fileCreate")) {
        calls.push({ op: "fileCreate", variables });
        if (overrides.createError) {
          return { data: { fileCreate: { files: [], userErrors: [{ field: ["files"], message: overrides.createError }] } } };
        }
        return { data: { fileCreate: { files: [{ id: overrides.noId ? "" : "gid://shopify/MediaImage/1", fileStatus: "UPLOADED" }], userErrors: [] } } };
      }
      calls.push({ op: "fileStatus", variables });
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return { data: { node: { id: "gid://shopify/MediaImage/1", fileStatus: status, image: { url: status === "READY" ? "https://cdn.shopify.com/x.png" : null } } } };
    },
    uploadBytes: async () => {
      calls.push({ op: "uploadBytes", variables: null });
    },
  };
  return { deps, calls };
}

describe("personalization file validation", () => {
  it("accepts a valid PNG", () => {
    expect(validatePersonalizationFile(png())).toEqual({ ok: true, mimeType: "image/png" });
  });

  it("accepts a valid JPEG", () => {
    expect(validatePersonalizationFile({ fileName: "qr.jpg", mimeType: "image/jpeg", bytes: JPEG })).toEqual({ ok: true, mimeType: "image/jpeg" });
  });

  it("accepts a valid PDF", () => {
    expect(validatePersonalizationFile({ fileName: "brand.pdf", mimeType: "application/pdf", bytes: PDF })).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("rejects SVG even when declared as an allowed type", () => {
    expect(ALLOWED_PERSONALIZATION_MIME_TYPES).not.toContain("image/svg+xml" as never);
    expect(validatePersonalizationFile({ fileName: "logo.svg", mimeType: "image/svg+xml", bytes: SVG }).ok).toBe(false);
    // renamed to slip past the declared type — content check still catches it
    const disguised = validatePersonalizationFile({ fileName: "logo.png", mimeType: "image/png", bytes: SVG });
    expect(disguised.ok).toBe(false);
  });

  it("rejects executables", () => {
    expect(validatePersonalizationFile({ fileName: "a.exe", mimeType: "application/x-msdownload", bytes: EXE }).ok).toBe(false);
    // executable renamed as a PNG is caught by magic bytes
    expect(validatePersonalizationFile({ fileName: "a.png", mimeType: "image/png", bytes: EXE }).ok).toBe(false);
    expect(validatePersonalizationFile({ fileName: "b.png", mimeType: "image/png", bytes: ELF }).ok).toBe(false);
  });

  it("rejects unknown MIME types", () => {
    const verdict = validatePersonalizationFile({ fileName: "x.bin", mimeType: "application/octet-stream", bytes: PNG });
    expect(verdict).toEqual({ ok: false, reason: "Unsupported file type. Upload a PNG, JPG, or PDF." });
  });

  it("rejects a declared/actual type mismatch", () => {
    const verdict = validatePersonalizationFile({ fileName: "logo.png", mimeType: "image/png", bytes: PDF });
    expect(verdict).toEqual({ ok: false, reason: "File contents do not match the file type." });
  });

  it("rejects an empty file", () => {
    expect(validatePersonalizationFile({ fileName: "e.png", mimeType: "image/png", bytes: new Uint8Array() })).toEqual({
      ok: false,
      reason: "File is empty.",
    });
  });

  it("rejects a file over 10MB", () => {
    const oversized = new Uint8Array(MAX_PERSONALIZATION_FILE_BYTES + 1);
    oversized.set(PNG, 0);
    expect(validatePersonalizationFile({ fileName: "big.png", mimeType: "image/png", bytes: oversized }).ok).toBe(false);
    expect(MAX_PERSONALIZATION_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("rejects more than 5 files", () => {
    expect(MAX_PERSONALIZATION_FILES).toBe(5);
    expect(validatePersonalizationBatch(Array.from({ length: 5 }, () => png())).ok).toBe(true);
    expect(validatePersonalizationBatch(Array.from({ length: 6 }, () => png()))).toEqual({
      ok: false,
      reason: "Attach at most 5 files.",
    });
  });

  it("detects type from bytes only", () => {
    expect(detectMimeFromBytes(PNG)).toBe("image/png");
    expect(detectMimeFromBytes(JPEG)).toBe("image/jpeg");
    expect(detectMimeFromBytes(PDF)).toBe("application/pdf");
    expect(detectMimeFromBytes(SVG)).toBeNull();
    expect(detectMimeFromBytes(new Uint8Array())).toBeNull();
  });
});

describe("filename handling", () => {
  it("sanitizes path traversal and control characters", () => {
    expect(sanitizeOriginalFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalFileName("C:\\evil\\payload.png")).toBe("payload.png");
    expect(sanitizeOriginalFileName("bad\u0000name.png")).toBe("badname.png");
    expect(sanitizeOriginalFileName('a<b>c:"d|e?f*.png')).toBe("abcdef.png");
    expect(sanitizeOriginalFileName("")).toBe("upload");
    expect(sanitizeOriginalFileName("..")).toBe("upload");
  });

  it("bounds a very long filename", () => {
    const long = `${"x".repeat(500)}.png`;
    expect(sanitizeOriginalFileName(long).length).toBeLessThanOrEqual(80);
  });

  it("generates a safe stored filename with a correct extension", () => {
    expect(buildStoredFileName("image/png", "tok123")).toBe("gso-personalization-tok123.png");
    expect(buildStoredFileName("image/jpeg", "tok123")).toBe("gso-personalization-tok123.jpg");
    expect(buildStoredFileName("application/pdf", "tok123")).toBe("gso-personalization-tok123.pdf");
    // hostile token cannot escape the name
    expect(buildStoredFileName("image/png", "../../x")).toBe("gso-personalization-x.png");
  });
});

describe("Shopify Files upload flow (mocked)", () => {
  it("returns a normalized asset object", async () => {
    const { deps } = makeDeps();
    const { assets, rejected } = await uploadPersonalizationAssets(deps as any, [png("My Logo.png")]);
    expect(rejected).toEqual([]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual({
      assetId: "gid://shopify/MediaImage/1",
      fileName: "gso-personalization-tok123.png",
      originalFileName: "My Logo.png",
      fileUrl: "https://cdn.shopify.com/x.png",
      mimeType: "image/png",
      byteSize: PNG.length,
      assetRole: PERSONALIZATION_ASSET_ROLE,
    });
  });

  it("uploads several accepted files and reports rejected ones without losing the rest", async () => {
    const { deps } = makeDeps();
    const { assets, rejected } = await uploadPersonalizationAssets(deps as any, [
      png("logo.png"),
      { fileName: "qr.pdf", mimeType: "application/pdf", bytes: PDF },
      { fileName: "bad.svg", mimeType: "image/svg+xml", bytes: SVG },
    ]);
    expect(assets.map((a) => a.mimeType)).toEqual(["image/png", "application/pdf"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].originalFileName).toBe("bad.svg");
  });

  it("routes PDFs as FILE and images as IMAGE", async () => {
    const { deps, calls } = makeDeps();
    await uploadPersonalizationAssets(deps as any, [{ fileName: "b.pdf", mimeType: "application/pdf", bytes: PDF }]);
    const staged = calls.find((c) => c.op === "stagedUploadsCreate");
    expect(staged?.variables.input[0].resource).toBe("FILE");
    const created = calls.find((c) => c.op === "fileCreate");
    expect(created?.variables.files[0].contentType).toBe("FILE");
  });

  it("surfaces Shopify userErrors safely without leaking the payload", async () => {
    const staged = await uploadPersonalizationAssets(makeDeps({ stagedError: "Filename is invalid" }).deps as any, [png()]);
    expect(staged.assets).toEqual([]);
    expect(staged.rejected[0].reason).toBe("Filename is invalid");

    const created = await uploadPersonalizationAssets(makeDeps({ createError: "File type not allowed" }).deps as any, [png()]);
    expect(created.assets).toEqual([]);
    expect(created.rejected[0].reason).toBe("File type not allowed");

    const noId = await uploadPersonalizationAssets(makeDeps({ noId: true }).deps as any, [png()]);
    expect(noId.rejected[0].reason).toBe("Shopify did not return a file id.");
  });

  it("handles asynchronous file status instead of assuming READY", async () => {
    // processes on the third poll
    const ready = await resolveFileWhenReady(makeDeps({ statuses: ["UPLOADED", "PROCESSING", "READY"] }).deps as any, "gid://shopify/MediaImage/1");
    expect(ready).toEqual({ ok: true, fileUrl: "https://cdn.shopify.com/x.png", status: "READY" });

    // never becomes ready — reported, not thrown
    const pending = await resolveFileWhenReady(makeDeps({ statuses: ["PROCESSING"] }).deps as any, "gid://shopify/MediaImage/1", 2);
    expect(pending).toEqual({ ok: false, reason: "File is still processing.", status: "PROCESSING" });

    const failed = await resolveFileWhenReady(makeDeps({ statuses: ["FAILED"] }).deps as any, "gid://shopify/MediaImage/1");
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe("FAILED");
  });

  it("keeps the durable id when the file is still processing", async () => {
    const { assets } = await uploadPersonalizationAssets(makeDeps({ statuses: ["PROCESSING"] }).deps as any, [png()]);
    expect(assets[0].assetId).toBe("gid://shopify/MediaImage/1");
    expect(assets[0].fileUrl).toBe("");
  });

  it("refuses a batch larger than the limit before any upload happens", async () => {
    const { deps, calls } = makeDeps();
    const result = await uploadPersonalizationAssets(deps as any, Array.from({ length: 6 }, () => png()));
    expect(result.assets).toEqual([]);
    expect(result.rejected[0].reason).toBe("Attach at most 5 files.");
    expect(calls).toHaveLength(0);
  });
});

describe("phase 1 stays a foundation", () => {
  it("never writes customer artwork to local disk", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/lib/personalization-assets.server.ts", "utf8");
    expect(source.includes("writeFile")).toBe(false);
    expect(source.includes("createWriteStream")).toBe(false);
    expect(source.includes("node:fs")).toBe(false);
  });

  // Phase 4 wired checkout, so "checkout mentions nothing" is no longer the
  // invariant. What still holds is that this module stayed a pure storage
  // foundation: it knows about files, not about carts, prices or orders.
  it("stays a storage foundation and takes on no cart or pricing concern", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/lib/personalization-assets.server.ts", "utf8");
    // Assert on what the module DOES, not on words that appear in its comments:
    // it imports nothing from the rest of the app and calls no cart, pricing,
    // draft-order or database API.
    expect(/^import\s/m.test(source)).toBe(false);
    expect(/draftOrderCreate|\bdb\.|prisma|priceEach|ProductionJob/.test(source)).toBe(false);
  });
});
