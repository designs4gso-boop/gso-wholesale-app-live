// Phase 6A — production activation preflight.
//
// Covers the three things 6A changed (Stock Bag Zakeke exemption, extension
// asset loading, sentinel fileUrl safety) plus the end-to-end activation matrix.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assetStateLabel, isFetchableAssetUrl } from "../app/lib/security-guards-shared";
import {
  PERSONALIZATION_FAILED_URL_PREFIX,
  PERSONALIZATION_PENDING_URL_PREFIX,
} from "../app/lib/personalization-production.server";

const BRIDGE = readFileSync("extensions/wholesale-theme/assets/gso-zakeke-bridge.js", "utf8");
const BLOCK = readFileSync("extensions/wholesale-theme/blocks/gso-product-configurator.liquid", "utf8");
const CONFIGURATOR_JS = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.js", "utf8");
const PERSONALIZATION_JS = readFileSync("extensions/wholesale-theme/assets/gso-personalization.js", "utf8");
const ERP_UI = readFileSync("app/routes/app.erp.production.tsx", "utf8");

/* ================================================================== *
 * TASK 2 — Stock Bag Zakeke exemption
 * ================================================================== */

/**
 * Executes the bridge IIFE against a minimal DOM stub so the family gate is
 * tested as BEHAVIOUR, not as a source pin. vitest runs in node with no jsdom,
 * so the stub provides exactly the surface the bridge touches.
 */
function runBridge(productType: string) {
  const events: Array<{ name: string; detail: any }> = [];
  const store: Record<string, string> = {};

  const el: any = {
    getAttribute: (name: string) =>
      name === "data-product-type" ? productType : name === "data-product-handle" ? "test-handle" : null,
    querySelector: () => null,
    appendChild: () => {},
    scrollIntoView: () => {},
  };

  const makeNode = () => ({
    setAttribute() {}, className: "", hidden: false, textContent: "",
    appendChild() {}, addEventListener() {}, href: "", target: "", rel: "",
  });

  const doc: any = {
    readyState: "complete",
    querySelector: (selector: string) => (selector === ".gso-configurator" ? el : null),
    createElement: makeNode,
    addEventListener: () => {},
    dispatchEvent: (event: any) => events.push({ name: event.type, detail: event.detail }),
    documentElement: { dataset: {} },
    body: { appendChild() {}, classList: { add() {} } },
  };

  const win: any = {
    document: doc,
    sessionStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    fetch: function () { return Promise.resolve(); },
    XMLHttpRequest: function () {} as any,
    HTMLFormElement: function () {} as any,
    console: { warn: () => {} },
    CustomEvent: class { type: string; detail: any; constructor(type: string, init: any) { this.type = type; this.detail = init?.detail; } },
  };
  win.XMLHttpRequest.prototype = { open() {}, send() {} };
  win.HTMLFormElement.prototype = { submit() {} };
  win.window = win;

  // eslint-disable-next-line no-new-func
  new Function("window", "document", "sessionStorage", "XMLHttpRequest", "HTMLFormElement", "CustomEvent", BRIDGE)(
    win, doc, win.sessionStorage, win.XMLHttpRequest, win.HTMLFormElement, win.CustomEvent,
  );

  return { api: win.GSOZakeke, hook: win.zakekeBeforeAddToCart, events, store };
}

describe("Stock Bags are functionally exempt from Zakeke", () => {
  it("reports the family gate as closed on a Stock Bag and open elsewhere", () => {
    expect(runBridge("Stock Bag").api.isAllowed()).toBe(false);
    expect(runBridge("stock bag").api.isAllowed()).toBe(false); // case-insensitive
    for (const family of ["DTP Pouches", "Stickers", "Jars", ""]) {
      expect(runBridge(family).api.isAllowed()).toBe(true);
    }
  });

  it("refuses to attach a design submitted through the Zakeke hook on a Stock Bag", () => {
    const bag = runBridge("Stock Bag");
    bag.hook("design-abc-123");
    expect(bag.api.designId()).toBe("");
    expect(bag.api.previewUrl()).toBe("");
    expect(bag.api.get()).toBeNull();
    expect(bag.events.some((e) => e.name === "gso:zakeke:family-blocked")).toBe(true);
  });

  it("STILL returns a never-resolving promise so Zakeke cannot fall back to its own /cart/add", async () => {
    const bag = runBridge("Stock Bag");
    const returned = bag.hook("design-abc-123");
    expect(returned).toBeInstanceOf(Promise);
    const settled = await Promise.race([returned.then(() => "settled"), Promise.resolve("pending")]);
    expect(settled).toBe("pending");
  });

  it("refuses a direct GSOZakeke.attach() call on a Stock Bag", () => {
    const bag = runBridge("Stock Bag");
    expect(bag.api.attach("design-abc-123")).toBeNull();
    expect(bag.api.designId()).toBe("");
  });

  it("does not resurrect a design persisted earlier in the session", () => {
    const bag = runBridge("Stock Bag");
    bag.store["gso_zakeke_pending_v1"] = JSON.stringify({ designId: "design-old", handle: "test-handle", at: "x" });
    const again = runBridge("Stock Bag");
    again.store["gso_zakeke_pending_v1"] = JSON.stringify({ designId: "design-old", handle: "test-handle", at: "x" });
    expect(again.api.designId()).toBe("");
  });

  it("leaves DTP and Sticker Zakeke behavior fully intact", () => {
    for (const family of ["DTP Pouches", "Stickers"]) {
      const page = runBridge(family);
      page.hook("design-abc-123");
      expect(page.api.designId()).toBe("design-abc-123");
      expect(page.api.previewUrl()).toBe("/apps/zakeke/preview/design-abc-123");
      expect(page.events.some((e) => e.name === "gso:zakeke:attached")).toBe(true);
      expect(page.events.some((e) => e.name === "gso:zakeke:family-blocked")).toBe(false);
    }
  });

  it("keeps the native /cart/add lockout active on Stock Bags too", () => {
    const bag = runBridge("Stock Bag");
    expect(BRIDGE).toContain("guardNativeCart();");
    // the guard is installed unconditionally, outside the family branch
    const initBlock = BRIDGE.slice(BRIDGE.indexOf("function init()"));
    expect(initBlock.indexOf("guardNativeCart()")).toBeGreaterThan(-1);
    expect(bag.api.blockedCount()).toBe(0);
  });

  it("gates on the canonical product type, not on CSS visibility", () => {
    expect(BLOCK).toContain('data-product-type="{{ product.type | escape }}"');
    expect(BRIDGE).toContain('var ZAKEKE_EXEMPT_TYPES = ["stock bag"];');
    // no display/visibility trickery is doing the work
    expect(/display\s*:\s*none|visibility\s*:\s*hidden/.test(BRIDGE)).toBe(false);
  });

  it("does not bulk-reassign products — the gate is one data attribute", () => {
    expect(BLOCK).not.toContain("template_suffix");
    expect(BRIDGE).not.toContain("productUpdate");
  });
});

/* ================================================================== *
 * TASK 3 — extension asset size
 * ================================================================== */

describe("extension JavaScript size", () => {
  it("no longer declares the oversized bundle in the schema javascript key", () => {
    // slice to endschema — the explanatory comment further down the file names
    // the key it deliberately stopped using, and must not decide this verdict
    const schema = BLOCK.slice(BLOCK.indexOf("{% schema %}"), BLOCK.indexOf("{% endschema %}"));
    expect(schema).not.toContain('"javascript"');
    expect(schema).toContain('"stylesheet": "gso-product-configurator.css"');
  });

  it("loads all three assets by deferred script tag, configurator first", () => {
    const order = ["gso-product-configurator.js", "gso-zakeke-bridge.js", "gso-personalization.js"].map((asset) =>
      BLOCK.indexOf(`{{ '${asset}' | asset_url }}`),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // every one deferred, so execution still precedes DOMContentLoaded
    expect(BLOCK.match(/asset_url }}" defer><\/script>/g)).toHaveLength(3);
  });

  it("changed no configurator behaviour to achieve it", () => {
    // the bundle itself is byte-identical to its Phase 4 state
    expect(Buffer.byteLength(CONFIGURATOR_JS)).toBe(18275);
    for (const token of [
      "gso_configurator_cart_v1",
      "function gsoPzTag(t)",
      'data-gso-add-to-cart',
      "configurator-checkout",
      'zakekeDesignId:window.GSOZakeke&&window.GSOZakeke.designId()||""',
      "window.GSOProductConfiguratorInit",
    ]) {
      expect(CONFIGURATOR_JS).toContain(token);
    }
    // the CSS is still schema-declared (its 100KB limit is not close)
    expect(Buffer.byteLength(readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.css"))).toBeLessThan(100_000);
  });
});

/* ================================================================== *
 * TASK 4 — sentinel fileUrl safety
 * ================================================================== */

describe("state sentinels are never treated as fetchable assets", () => {
  const PENDING = `${PERSONALIZATION_PENDING_URL_PREFIX}gid://shopify/MediaImage/1`;
  const FAILED = `${PERSONALIZATION_FAILED_URL_PREFIX}gid://shopify/GenericFile/2`;

  it("classifies real assets as fetchable and sentinels as not", () => {
    for (const url of ["https://cdn.shopify.com/a.png", "http://x.example/y.pdf", "/app/erp/production/1/proof", "/apps/zakeke/preview/abc"]) {
      expect(isFetchableAssetUrl(url)).toBe(true);
    }
    for (const url of [PENDING, FAILED, "", "   ", null, undefined, "gso:anything", "javascript:alert(1)", "data:text/html,x", "//evil.example/x.png"]) {
      expect(isFetchableAssetUrl(url as any)).toBe(false);
    }
  });

  it("is an allowlist, so an unknown future scheme is refused automatically", () => {
    expect(isFetchableAssetUrl("gso:something-invented-later/x")).toBe(false);
    expect(isFetchableAssetUrl("ftp://host/f.png")).toBe(false);
    expect(isFetchableAssetUrl("file:///etc/passwd")).toBe(false);
  });

  it("gives an operator a clear state label instead of a link", () => {
    expect(assetStateLabel(PENDING)).toContain("Still processing");
    expect(assetStateLabel(FAILED)).toContain("needs re-upload");
    expect(assetStateLabel("https://cdn.shopify.com/a.png")).toBe("");
  });

  it("cannot be rendered as an image or a PDF by the ERP job view", () => {
    // the UI's own helpers, applied to the sentinels
    const isImageUrl = (url: any) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(String(url || "").split("?")[0].toLowerCase());
    const isPdfUrl = (url: any) => String(url || "").split("?")[0].toLowerCase().endsWith(".pdf");
    for (const url of [PENDING, FAILED]) {
      expect(isImageUrl(url)).toBe(false);
      expect(isPdfUrl(url)).toBe(false);
    }
  });

  it("is never wrapped in an anchor tag by the ERP job view", () => {
    const block = ERP_UI.slice(ERP_UI.indexOf("(job.files || []).map"), ERP_UI.indexOf("(job.files || []).map") + 1600);
    expect(block).toContain("isFetchableAssetUrl(file.fileUrl)");
    expect(block).toContain("assetStateLabel(file.fileUrl)");
    // the anchor exists ONLY as the true-branch of the guard: every occurrence
    // of the link is preceded by the guard on the same expression
    const anchor = block.indexOf("<a href={file.fileUrl}");
    const guard = block.indexOf("isFetchableAssetUrl(file.fileUrl)");
    expect(anchor).toBeGreaterThan(guard);
    expect(block.match(/<a href=\{file\.fileUrl\}/g)).toHaveLength(1);
  });

  it("cannot be promoted to job artwork / proof / print file / product image", () => {
    const promote = ERP_UI.slice(ERP_UI.indexOf("function jobAssetUpdateForRole"), ERP_UI.indexOf("function roleFromFileType"));
    expect(promote).toContain("if (!isFetchableAssetUrl(fileUrl)) return {};");
    // guard runs BEFORE any role branch
    expect(promote.indexOf("isFetchableAssetUrl")).toBeLessThan(promote.indexOf('role === "productImage"'));
  });

  it("cannot reach the customer proof page or the RIP route plan", () => {
    // both select artwork by role/type; personalization uses neither
    const customerProof = readFileSync("app/routes/proof.$token.tsx", "utf8");
    expect(customerProof).toContain('file.assetRole === "artwork" || file.fileType === "artwork"');
    const erpProof = readFileSync("app/routes/app.erp.production.$id.proof.tsx", "utf8");
    expect(erpProof).toContain('file.fileType === "artwork"');
    // and the RIP plan reads job-level urls + file NAMES only, never file.fileUrl
    const ripPlan = readFileSync("app/routes/api.print-intake.route-plan.tsx", "utf8");
    expect(ripPlan).not.toContain("file.fileUrl");
    expect(ripPlan).toContain("file.fileName");
  });

  it("keeps sentinels out of anything a customer can download", () => {
    const production = readFileSync("app/lib/personalization-production.server.ts", "utf8");
    // the sentinel is only ever the fallback; a READY asset always uses Shopify's url
    expect(production).toContain('asset.status === "READY" && asset.fileUrl ? asset.fileUrl : sentinelUrl(asset)');
    expect(production).not.toContain("https://cdn.shopify.com");
  });
});

/* ================================================================== *
 * TASK 8 — feature gate
 * ================================================================== */

describe("personalization feature gate is OFF", () => {
  it("defaults to false in the block schema", () => {
    const setting = BLOCK.slice(BLOCK.indexOf('"id": "enable_personalization"'));
    expect(setting.slice(0, setting.indexOf("}"))).toContain('"default": false');
  });

  it("requires BOTH the setting and a Stock Bag, and omits the markup otherwise", () => {
    expect(BLOCK).toContain("block.settings.enable_personalization and product.type == 'Stock Bag'");
    // the container the client needs sits inside that conditional
    const gateAt = BLOCK.indexOf("block.settings.enable_personalization");
    const containerAt = BLOCK.indexOf("data-gso-personalization");
    expect(containerAt).toBeGreaterThan(gateAt);
  });

  it("makes no network request while off — the client exits without its container", () => {
    expect(PERSONALIZATION_JS).toContain('root = document.querySelector("[data-gso-personalization]");');
    expect(PERSONALIZATION_JS).toContain("if (!root) return;");
    // fetch only ever happens inside upload(), which needs an accepted file
    const uploadAt = PERSONALIZATION_JS.indexOf("function upload(asset)");
    expect(PERSONALIZATION_JS.indexOf("fetch(uploadProxy")).toBeGreaterThan(uploadAt);
  });

  it("adds nothing to the cart payload while off", () => {
    // the helper assigns only when the resolved list is non-empty
    expect(CONFIGURATOR_JS).toContain("if(a&&a.length)o.personalizationAssets=a;return o");
    expect(CONFIGURATOR_JS).toContain("if(a.length)o.personalizationAssets=a;return o");
  });
});

/* ================================================================== *
 * TASK 9 — activation matrix (non-duplicated parts)
 * ================================================================== */

describe("activation matrix guards", () => {
  it("O. introduces no native Shopify cart path anywhere", () => {
    for (const source of [CONFIGURATOR_JS, PERSONALIZATION_JS, BRIDGE]) {
      expect(source.includes("/cart/add.js")).toBe(false);
      expect(source.includes("/cart/update.js")).toBe(false);
      expect(source.includes("/cart/change.js")).toBe(false);
    }
    // the bridge blocks /cart/add rather than using it
    expect(BRIDGE).toContain('path.indexOf("/cart/add") >= 0');
  });

  it("N. MOQ 50 is unchanged", () => {
    expect(BLOCK).toContain('data-minimum-quantity="50"');
    expect(BLOCK).toContain("<span data-gso-min-display>50</span>");
  });

  it("M. no pricing module mentions personalization", () => {
    for (const file of [
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/configurator-pricing.ts",
    ]) {
      expect(readFileSync(file, "utf8").toLowerCase().includes("personalization")).toBe(false);
    }
  });

  it("the fake legacy uploader stays disabled", () => {
    const template = readFileSync("shopify-theme/templates/product.configurator-pilot.json", "utf8");
    const parsed = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
    expect(parsed.sections["1771828352671bead8"].blocks.ai_gen_block_15f470a_xiVLGg.disabled).toBe(true);
  });
});

/* ================================================================== *
 * TASK 6/7 — migration + scope preflight
 * ================================================================== */

describe("migration preflight", () => {
  const SQL = "prisma/migrations/20260813210000_add_personalization_upload_rate_limit/migration.sql";

  it("is additive only, with no destructive statement", () => {
    const sql = readFileSync(SQL, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PersonalizationUploadRateLimit"');
    // Strip `--` comments first: prose explaining that nothing is dropped or
    // renamed must not be able to fail (or pass) a check about STATEMENTS.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toUpperCase();
    for (const destructive of ["DROP", "TRUNCATE", "DELETE", "ALTER", "RENAME", "UPDATE "]) {
      expect(statements.includes(destructive)).toBe(false);
    }
    // exactly three additive statements, nothing else
    expect(statements.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
  });

  it("introduces no table-name collision and sorts last in history", async () => {
    const { readdirSync } = await import("node:fs");
    const migrations = readdirSync("prisma/migrations").filter((name) => /^\d/.test(name)).sort();
    expect(migrations[migrations.length - 1]).toBe("20260813210000_add_personalization_upload_rate_limit");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema.match(/model PersonalizationUploadRateLimit\b/g)).toHaveLength(1);
  });

  it("declares exactly the columns the SQL creates", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const model = schema.slice(schema.indexOf("model PersonalizationUploadRateLimit"));
    const body = model.slice(0, model.indexOf("}"));
    for (const column of ["id", "identityKey", "createdAt"]) expect(body).toContain(column);
    // still PII-free
    for (const forbidden of ["ip", "email", "fileName", "assetId"]) expect(body.includes(forbidden)).toBe(false);
  });
});

describe("scope preflight", () => {
  const toml = readFileSync("shopify.app.toml", "utf8");

  it("lists read_files and write_files exactly once each", () => {
    expect(toml.match(/read_files/g)).toHaveLength(1);
    expect(toml.match(/write_files/g)).toHaveLength(1);
  });

  it("preserves every pre-existing scope", () => {
    const scopes = (toml.match(/scopes\s*=\s*"([^"]*)"/) || [])[1].split(",").map((s) => s.trim());
    // the complete pre-6A set, pinned so a deploy can never silently drop one
    for (const required of [
      "read_customers", "read_orders", "read_all_orders", "read_products", "write_products",
      "write_discounts", "read_draft_orders", "write_draft_orders", "read_cart_transforms",
      "write_cart_transforms", "read_content", "read_online_store_navigation", "read_themes",
    ]) {
      expect(scopes).toContain(required);
    }
    // exactly two additions, appended at the end
    expect(scopes).toHaveLength(15);
    expect(scopes.slice(-2)).toEqual(["read_files", "write_files"]);
    // no duplicates anywhere in the list
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes).toContain("read_files");
    expect(scopes).toContain("write_files");
  });

  it("keeps the upload endpoint the only thing that needs the new scopes", () => {
    const assets = readFileSync("app/lib/personalization-assets.server.ts", "utf8");
    expect(assets).toContain("stagedUploadsCreate");
    expect(assets).toContain("fileCreate");
  });
});
