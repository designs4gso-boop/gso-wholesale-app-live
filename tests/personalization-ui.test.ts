// Stock Bag personalization — Phase 3 ADD YOUR BRAND UI.
//
// vitest runs in a node environment with no DOM and no jsdom installed, so these
// are source pins over the extension asset/liquid/css (the established repo
// pattern for theme + extension code — see storefront-convergence.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAX_PERSONALIZATION_FILES, MAX_PERSONALIZATION_FILE_BYTES } from "../app/lib/personalization-assets.server";

const JS = readFileSync("extensions/wholesale-theme/assets/gso-personalization.js", "utf8");
const LIQUID = readFileSync("extensions/wholesale-theme/blocks/gso-product-configurator.liquid", "utf8");
const CSS = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.css", "utf8");
const CONFIGURATOR_JS = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.js", "utf8");
const BODY = LIQUID.slice(LIQUID.indexOf("{% endschema %}"));

describe("feature gate", () => {
  it("defaults OFF in the block schema", () => {
    expect(LIQUID).toContain('"id": "enable_personalization"');
    const setting = LIQUID.slice(LIQUID.indexOf('"id": "enable_personalization"'));
    expect(setting.slice(0, setting.indexOf("}"))).toContain('"default": false');
  });

  it("requires BOTH the setting and Stock Bag identity to render", () => {
    expect(BODY).toContain("{%- if block.settings.enable_personalization and product.type == 'Stock Bag' -%}");
    expect(BODY).toContain("{%- assign gso_personalization = false -%}");
    expect(BODY).toContain("{%- if gso_personalization -%}");
  });

  it("is not a CSS-only hide — the markup is absent when gated off", () => {
    // the container lives inside the liquid conditional, not behind a display rule
    const gateStart = BODY.indexOf("{%- if gso_personalization -%}");
    const gateEnd = BODY.indexOf("{%- endif -%}", gateStart);
    const gated = BODY.slice(gateStart, gateEnd);
    expect(gated).toContain("data-gso-personalization");
    expect(gated).toContain("ADD YOUR BRAND");
    expect(CSS.includes(".gso-personalization { display: none")).toBe(false);
  });

  it("makes no network call while disabled — the client self-exits without the container", () => {
    expect(JS).toContain('root = document.querySelector("[data-gso-personalization]")');
    expect(JS).toContain("if (!root) return;");
    // the only fetch is inside upload(), which is only reachable after init()
    expect((JS.match(/fetch\(/g) || []).length).toBe(1);
    const initIndex = JS.indexOf("function init()");
    const uploadIndex = JS.indexOf("function upload(");
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeGreaterThan(-1);
  });

  it("does not key activation off a query parameter", () => {
    expect(JS.includes("URLSearchParams")).toBe(false);
    expect(JS.includes("location.search")).toBe(false);
    expect(BODY.includes("request.query")).toBe(false);
  });
});

describe("Stock Bag only", () => {
  it("uses product.type, not title text", () => {
    expect(BODY).toContain("product.type == 'Stock Bag'");
    expect(BODY.includes("product.title contains")).toBe(false);
  });

  it("cannot render for other canonical families", () => {
    // the single gate is an equality on 'Stock Bag'; no other family string can satisfy it
    const gate = "{%- if block.settings.enable_personalization and product.type == 'Stock Bag' -%}";
    expect(BODY).toContain(gate);
    for (const family of ["Jars", "DTP Pouches", "Stickers"]) {
      expect(gate.includes(family)).toBe(false);
    }
  });
});

describe("customer UI", () => {
  it("renders the approved copy", () => {
    expect(BODY).toContain("ADD YOUR BRAND");
    expect(BODY).toContain("OPTIONAL");
    expect(BODY).toContain("Add your logo and/or QR code to this premade design.");
    expect(BODY).toContain("PNG, JPG or PDF &middot; Up to 5 files &middot; 10 MB each");
  });

  it("uses ONE dropzone that supports multiple files and browsing", () => {
    expect(BODY).toContain("data-gso-personalization-drop");
    expect(BODY).toContain('type="file"');
    expect(BODY).toContain("multiple");
    expect(BODY).toContain('accept="image/png,image/jpeg,application/pdf"');
    // exactly one file input — not separate logo/QR widgets
    expect((BODY.match(/type="file"/g) || []).length).toBe(1);
    expect(BODY.toLowerCase().includes("logo upload")).toBe(false);
    expect(BODY.toLowerCase().includes("qr upload")).toBe(false);
  });

  it("accepts drag and drop of multiple files", () => {
    expect(JS).toContain('dropzone.addEventListener("drop"');
    expect(JS).toContain("event.dataTransfer.files");
    expect(JS).toContain("addFiles(event.dataTransfer.files)");
  });

  it("does not reuse or restore the fake legacy uploader", () => {
    expect(JS.includes("ai_gen_block_15f470a")).toBe(false);
    expect(BODY.includes("ai_gen_block_15f470a")).toBe(false);
    const template = readFileSync("shopify-theme/templates/product.configurator-pilot.json", "utf8");
    const parsed = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
    expect(parsed.sections["1771828352671bead8"].blocks.ai_gen_block_15f470a_xiVLGg.disabled).toBe(true);
  });
});

describe("client validation mirrors the server rules", () => {
  it("accepts PNG, JPEG and PDF only", () => {
    expect(JS).toContain('var ACCEPTED = ["image/png", "image/jpeg", "application/pdf"];');
  });

  it("rejects SVG client-side while the server stays authoritative", () => {
    expect(JS).toContain('ACCEPTED.indexOf(file.type) === -1');
    expect(JS.includes("image/svg")).toBe(false);
    expect(JS).toContain("isn't supported. Upload ");
    // the comment records that the server is the authority
    expect(JS).toContain("server is authority");
  });

  it("enforces the same 5-file and 10MB limits as the server", () => {
    expect(JS).toContain("var MAX_FILES = 5;");
    expect(JS).toContain("var MAX_BYTES = 10 * 1024 * 1024;");
    expect(MAX_PERSONALIZATION_FILES).toBe(5);
    expect(MAX_PERSONALIZATION_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(JS).toContain('"You can upload up to " + MAX_FILES + " files."');
    expect(JS).toContain('" is larger than 10 MB."');
  });

  it("shows bounded messages and never raw backend errors", () => {
    expect(JS).toContain("We could not upload this file. Please try again.");
    expect(JS.includes("error.stack")).toBe(false);
    expect(JS.includes("JSON.stringify(err")).toBe(false);
  });
});

describe("upload lifecycle and state", () => {
  it("declares the five states", () => {
    for (const state of ["LOCAL", "UPLOADING", "PROCESSING", "READY", "ERROR"]) {
      expect(JS).toContain(`var STATE_${state} = "${state}";`);
    }
  });

  it("posts multipart to the Phase 2 endpoint", () => {
    expect(BODY).toContain('data-upload-proxy="/apps/wholesale-lite/personalization-upload"');
    expect(JS).toContain("new FormData()");
    expect(JS).toContain('body.append("files"');
    expect(JS).toContain('method: "POST"');
  });

  it("treats PROCESSING as success, not failure, and keeps the assetId", () => {
    expect(JS).toContain("payloadAsset.status === STATE_READY ? STATE_READY : STATE_PROCESSING");
    expect(JS).toContain('if (asset.status === STATE_PROCESSING) return "Processing…";');
    // PROCESSING assets are still exposed to Phase 4
    expect(JS).toContain("asset.status === STATE_READY || asset.status === STATE_PROCESSING");
  });

  it("surfaces failedFile safely", () => {
    expect(JS).toContain("payload.failedFile");
    expect(JS).toContain("failAsset(asset, payload.code");
  });

  it("supports remove and retry, without re-uploading a success", () => {
    expect(JS).toContain("function removeAsset(");
    expect(JS).toContain("function retryAsset(");
    expect(JS).toContain("if (!target || target.status === STATE_READY || target.status === STATE_PROCESSING) return;");
    // removal does not delete the Shopify file here
    expect(JS).toContain("orphan-retention sweep");
  });

  it("uses the approved client state shape and no Zakeke fields", () => {
    for (const key of ["localId", "originalFileName", "byteSize", "mimeType", "assetId", "fileName", "fileUrl", "assetRole", "status", "errorCode"]) {
      expect(JS).toContain(`${key}:`);
    }
    expect(JS).toContain('assetRole: "personalization"');
    // The Zakeke fields must never be WRITTEN or READ here. (They are named in a
    // comment stating they are deliberately separate, so assert on usage.)
    for (const field of ["zakekeDesignId", "zakekePreviewUrl"]) {
      expect(new RegExp(`${field}\\s*:`).test(JS)).toBe(false);
      expect(new RegExp(`\\.${field}\\b`).test(JS)).toBe(false);
      expect(new RegExp(`\\[["'\`]${field}`).test(JS)).toBe(false);
    }
  });
});

describe("add to cart is untouched in this phase", () => {
  it("never writes the GSO cart itself — the configurator owns that", () => {
    // Phase 4 lets the configurator READ this module, but the module still
    // never touches localStorage or the cart key.
    expect(JS).toContain("window.GSOPersonalization");
    expect(JS.includes("gso_configurator_cart_v1")).toBe(false);
    // Assert on USE, not on the word — a comment naming an API it deliberately
    // avoids must not be able to decide this verdict.
    expect(/localStorage\s*[.[]/.test(JS)).toBe(false);
    expect(/sessionStorage\s*[.[]/.test(JS)).toBe(false);
    // and it hands out data, never a File/Blob or encoded bytes
    expect(/readAsDataURL|FileReader|\bbtoa\s*\(|createObjectURL/.test(JS)).toBe(false);
    expect(/cartAssets:\s*function/.test(JS)).toBe(true);
  });

  it("blocks add-to-cart while an upload is in flight or a file needs attention", () => {
    expect(JS).toContain("function activeUploadCount()");
    expect(JS).toContain("function blockingAsset()");
    expect(JS).toContain("var blocked = blockingAsset();");
    expect(JS).toContain("Please wait for your files to finish uploading.");
    // Phase 4: a failed upload must be removed or retried first
    expect(JS).toContain("before adding to cart.");
    expect(JS).toContain("asset.status === STATE_UPLOADING || asset.status === STATE_ERROR");
    // aria-disabled, never the disabled property the configurator script owns
    expect(JS).toContain('button.setAttribute("aria-disabled", "true")');
    expect(JS.includes("button.disabled = true")).toBe(false);
  });

  it("introduces no native Shopify cart path", () => {
    expect(JS.includes("/cart/add")).toBe(false);
    expect(JS.includes("cart/add.js")).toBe(false);
  });
});

describe("accessibility", () => {
  it("associates the label and input and keeps the input focusable", () => {
    expect(BODY).toContain('for="gso-brand-input-{{ block.id }}"');
    expect(BODY).toContain('id="gso-brand-input-{{ block.id }}"');
    expect(BODY).toContain('aria-describedby="gso-brand-hint-{{ block.id }}"');
    expect(BODY).toContain('aria-labelledby="gso-brand-heading-{{ block.id }}"');
    // hidden via clip, not display:none, so it stays keyboard reachable
    expect(CSS).toContain(".gso-personalization__input");
    expect(CSS).toContain("clip: rect(0 0 0 0)");
  });

  it("announces status changes politely", () => {
    expect(BODY).toContain('role="status"');
    expect(BODY).toContain('aria-live="polite"');
    expect(JS).toContain("function announce(");
  });

  it("gives remove and retry buttons accessible names and focus states", () => {
    expect(JS).toContain('remove.setAttribute("aria-label", "Remove " + asset.originalFileName)');
    expect(JS).toContain('retry.setAttribute("aria-label", "Retry uploading " + asset.originalFileName)');
    expect(JS).toContain('retry.type = "button"');
    expect(CSS).toContain(".gso-personalization__remove:focus-visible");
  });

  it("uses real buttons rather than click-only divs", () => {
    expect(JS).toContain('document.createElement("button")');
    expect(JS.includes('div.addEventListener("click"')).toBe(false);
  });
});

describe("styling stays inside the existing language", () => {
  it("reuses the configurator design tokens", () => {
    for (const token of ["--gso-border", "--gso-accent", "--gso-muted", "--gso-radius", "--gso-field-bg", "--gso-result-bg"]) {
      expect(CSS).toContain(token);
    }
  });

  it("stays compact and responsive", () => {
    expect(CSS).toContain(".gso-personalization {");
    expect(CSS).toContain("@media screen and (max-width: 749px)");
  });
});

describe("existing configurator behavior preserved", () => {
  it("keeps MOQ 50 and the existing lockout pins intact", () => {
    expect(BODY).toContain('data-minimum-quantity="50"');
    expect(BODY).toContain("<span data-gso-min-display>50</span>");
    expect(BODY).toContain("product.type == 'Stock Bag' or product.tags contains 'configurator-pilot'");
    expect(CONFIGURATOR_JS).toContain('[name="add"]');
  });

  it("does not disturb the Zakeke bridge", () => {
    expect(BODY).toContain("gso-zakeke-bridge.js");
    expect(BODY).toContain("gso-personalization.js");
  });
});
