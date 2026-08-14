// Stock Bag personalization — Phase 4 cart + checkout handoff.
//
// Two halves:
//   * behavioural tests over the checkout resolver (all Shopify calls mocked)
//   * source pins over the checkout route and the minified configurator bundle,
//     which cannot be imported (route-module convention + no build step)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PERSONALIZATION_ASSETS_KEY,
  PERSONALIZATION_COUNT_KEY,
  issuePersonalizationClaim,
} from "../app/lib/personalization-claim.server";
import {
  PERSONALIZATION_SUPPORTED_FAMILIES,
  familySupportsPersonalization,
  resolvePersonalizationForLine,
} from "../app/lib/personalization-checkout.server";

const SHOP = "942075-2.myshopify.com";
const SECRET = "test-secret-not-a-real-key";
const A = "gid://shopify/MediaImage/1111111111";
const B = "gid://shopify/MediaImage/2222222222";
const PDF_ASSET = "gid://shopify/GenericFile/33";
const NOW = 1_760_000_000_000;

const CHECKOUT_ROUTE = "app/routes/apps.wholesale-lite.configurator-checkout.ts";
const CONFIGURATOR_JS = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.js", "utf8");
const PERSONALIZATION_JS = readFileSync("extensions/wholesale-theme/assets/gso-personalization.js", "utf8");

function claim(assetId: string, opts: { shop?: string; name?: string; mime?: string; bytes?: number } = {}) {
  return issuePersonalizationClaim(
    {
      shop: opts.shop ?? SHOP,
      assetId,
      originalFileName: opts.name ?? "logo.png",
      mimeType: opts.mime ?? "image/png",
      byteSize: opts.bytes ?? 2048,
      issuedAt: NOW,
    },
    SECRET,
  );
}

/** Shopify stands in for `node(id:)`; `statuses` is keyed by asset id. */
function makeDeps(statuses: Record<string, string | string[]> = {}) {
  const queried: string[] = [];
  const counts: Record<string, number> = {};
  return {
    queried,
    deps: {
      secret: SECRET,
      now: () => NOW,
      wait: async () => {},
      graphql: async (_query: string, variables: any) => {
        const id = String(variables.id);
        queried.push(id);
        const entry = statuses[id] ?? "READY";
        const list = Array.isArray(entry) ? entry : [entry];
        const index = Math.min(counts[id] ?? 0, list.length - 1);
        counts[id] = (counts[id] ?? 0) + 1;
        const status = list[index];
        if (status === "MISSING") return { data: { node: null } };
        return {
          data: {
            node: {
              id,
              fileStatus: status,
              image: { url: status === "READY" ? `https://cdn.shopify.com/${id.split("/").pop()}.png` : null },
            },
          },
        };
      },
    },
  };
}

const STOCK_BAG = { shop: SHOP, productFamily: "Stock Bags" };

describe("no personalization behaves exactly as before", () => {
  it("returns an empty set and never calls Shopify", async () => {
    const { deps, queried } = makeDeps();
    for (const posted of [undefined, null, []]) {
      const result = await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted });
      expect(result).toEqual({ ok: true, assets: [] });
    }
    expect(queried).toHaveLength(0);
  });
});

describe("claim verification gates every asset", () => {
  it("resolves one READY asset into the authoritative server object", async () => {
    const { deps } = makeDeps();
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: A, assetClaim: claim(A) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets).toEqual([
      {
        assetId: A,
        originalFileName: "logo.png",
        fileUrl: "https://cdn.shopify.com/1111111111.png",
        mimeType: "image/png",
        byteSize: 2048,
        assetRole: "personalization",
        status: "READY",
      },
    ]);
  });

  it("resolves multiple assets, including a PDF GenericFile", async () => {
    const { deps } = makeDeps({ [PDF_ASSET]: "READY" });
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [
        { assetId: A, assetClaim: claim(A) },
        { assetId: PDF_ASSET, assetClaim: claim(PDF_ASSET, { name: "spec.pdf", mime: "application/pdf" }) },
      ],
    });
    expect(result.ok && result.assets).toHaveLength(2);
    expect(result.ok && result.assets.map((a) => a.mimeType).sort()).toEqual(["application/pdf", "image/png"]);
  });

  it("refuses an arbitrary store file id posted without any claim", async () => {
    const { deps, queried } = makeDeps();
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: "gid://shopify/MediaImage/9999999999" }],
    });
    expect(result).toEqual({ ok: false, code: "PERSONALIZATION_MALFORMED", message: expect.any(String) });
    // nothing was even looked up
    expect(queried).toHaveLength(0);
  });

  it("refuses a real id paired with a claim minted for a different asset", async () => {
    const { deps, queried } = makeDeps();
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: B, assetClaim: claim(A) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PERSONALIZATION_UNVERIFIED");
    expect(queried).toHaveLength(0);
  });

  it("refuses a claim minted on another shop", async () => {
    const { deps } = makeDeps();
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: A, assetClaim: claim(A, { shop: "attacker.myshopify.com" }) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PERSONALIZATION_UNVERIFIED");
  });

  it("refuses a tampered claim", async () => {
    const { deps } = makeDeps();
    const good = claim(A);
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: A, assetClaim: good.slice(0, -2) + "zz" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PERSONALIZATION_UNVERIFIED");
  });

  it("caps at 5 assets", async () => {
    const { deps } = makeDeps();
    const six = Array.from({ length: 6 }, (_, i) => {
      const id = `gid://shopify/MediaImage/${i + 1}`;
      return { assetId: id, assetClaim: claim(id) };
    });
    const result = await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted: six });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PERSONALIZATION_TOO_MANY");
  });
});

describe("browser metadata is never authoritative", () => {
  it("ignores a forged fileUrl, mimeType, filename, byteSize and role", async () => {
    const { deps } = makeDeps();
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [
        {
          assetId: A,
          assetClaim: claim(A, { name: "logo.png", mime: "image/png", bytes: 2048 }),
          fileUrl: "https://evil.example/payload.exe",
          mimeType: "application/x-msdownload",
          fileName: "../../etc/passwd",
          originalFileName: "attacker-supplied.png",
          byteSize: 999999999,
          assetRole: "admin",
          status: "READY",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [asset] = result.assets;
    // URL is Shopify's; the rest come from the signed claim, not the post body
    expect(asset.fileUrl).toBe("https://cdn.shopify.com/1111111111.png");
    expect(asset.fileUrl).not.toContain("evil.example");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.originalFileName).toBe("logo.png");
    expect(asset.byteSize).toBe(2048);
    expect(asset.assetRole).toBe("personalization");
    expect(JSON.stringify(result)).not.toContain("etc/passwd");
    expect(JSON.stringify(result)).not.toContain("attacker-supplied");
  });

  it("re-resolves through Shopify by id, sending nothing but the id", async () => {
    const seen: any[] = [];
    const deps = {
      secret: SECRET,
      now: () => NOW,
      wait: async () => {},
      graphql: async (_q: string, v: any) => {
        seen.push(v);
        return { data: { node: { id: A, fileStatus: "READY", image: { url: "https://cdn.shopify.com/real.png" } } } };
      },
    };
    await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted: [{ assetId: A, assetClaim: claim(A) }] });
    expect(seen).toEqual([{ id: A }]);
  });
});

describe("PROCESSING and FAILED at checkout", () => {
  it("retries a bounded number of times and succeeds when Shopify catches up", async () => {
    const { deps, queried } = makeDeps({ [A]: ["PROCESSING", "READY"] });
    const result = await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted: [{ assetId: A, assetClaim: claim(A) }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assets[0].status).toBe("READY");
    expect(queried).toHaveLength(2);
  });

  it("allows the order through when an asset is still PROCESSING, without faking a URL", async () => {
    const { deps, queried } = makeDeps({ [A]: "PROCESSING" });
    const result = await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted: [{ assetId: A, assetClaim: claim(A) }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets[0].status).toBe("PROCESSING");
    // the durable id survives so Phase 5 can resolve it again...
    expect(result.assets[0].assetId).toBe(A);
    // ...and no invented URL is recorded
    expect(result.assets[0].fileUrl).toBe("");
    // polling is bounded, not unlimited
    expect(queried).toHaveLength(3);
  });

  it("blocks checkout on a FAILED asset and names the file safely", async () => {
    const { deps } = makeDeps({ [A]: "FAILED" });
    const result = await resolvePersonalizationForLine(deps as any, {
      ...STOCK_BAG,
      posted: [{ assetId: A, assetClaim: claim(A, { name: "broken.png" }) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PERSONALIZATION_FAILED");
    expect(result.failedFile).toBe("broken.png");
    expect(result.message).toMatch(/could not be processed/i);
    // customer-safe: no Shopify internals, no ids, no stack
    expect(result.message).not.toContain("gid://");
    expect(result.message.toLowerCase()).not.toContain("graphql");
  });

  it("blocks checkout when the asset no longer exists", async () => {
    const { deps } = makeDeps({ [A]: "MISSING" });
    const result = await resolvePersonalizationForLine(deps as any, { ...STOCK_BAG, posted: [{ assetId: A, assetClaim: claim(A) }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PERSONALIZATION_UNVERIFIED");
  });
});

describe("family scope", () => {
  it("only Stock Bags accept Stock Bag personalization", () => {
    expect(PERSONALIZATION_SUPPORTED_FAMILIES).toEqual(["Stock Bags"]);
    expect(familySupportsPersonalization("Stock Bags")).toBe(true);
    for (const family of ["Jars", "DTP Pouches", "Stickers", "", "stock bags", undefined]) {
      expect(familySupportsPersonalization(family)).toBe(false);
    }
  });

  it("refuses an injected asset on a jar, sticker or DTP line before any Shopify call", async () => {
    for (const productFamily of ["Jars", "Stickers", "DTP Pouches"]) {
      const { deps, queried } = makeDeps();
      const result = await resolvePersonalizationForLine(deps as any, {
        shop: SHOP,
        productFamily,
        posted: [{ assetId: A, assetClaim: claim(A) }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PERSONALIZATION_NOT_SUPPORTED");
      expect(queried).toHaveLength(0);
    }
  });

  it("does not overload the Zakeke design fields", () => {
    const source = readFileSync("app/lib/personalization-checkout.server.ts", "utf8");
    expect(/zakekeDesignId\s*[:=]|\.zakekeDesignId|\[["']zakekeDesignId/.test(source)).toBe(false);
    expect(/zakekePreviewUrl\s*[:=]|\.zakekePreviewUrl/.test(source)).toBe(false);
  });
});

describe("deterministic ordering", () => {
  it("produces the same attribute regardless of posted order", async () => {
    const posted = [
      { assetId: B, assetClaim: claim(B) },
      { assetId: A, assetClaim: claim(A) },
    ];
    const forward = await resolvePersonalizationForLine(makeDeps().deps as any, { ...STOCK_BAG, posted });
    const reverse = await resolvePersonalizationForLine(makeDeps().deps as any, { ...STOCK_BAG, posted: [...posted].reverse() });
    expect(forward.ok && forward.assets.map((a) => a.assetId)).toEqual([A, B]);
    expect(reverse.ok && reverse.assets.map((a) => a.assetId)).toEqual([A, B]);
  });
});

describe("checkout route wiring (source pins)", () => {
  const route = readFileSync(CHECKOUT_ROUTE, "utf8");

  it("resolves personalization AFTER the price is final, so pricing cannot be affected", () => {
    const priceLine = route.indexOf("const orderTotal = money(priceEach * quantity)");
    const personalizationLine = route.indexOf("resolvePersonalizationForLine(");
    expect(priceLine).toBeGreaterThan(0);
    expect(personalizationLine).toBeGreaterThan(priceLine);
    // and no pricing call receives personalization
    for (const call of ["priceStorefrontConfiguration(", "priceJarConfiguration(", "priceDtpConfiguration(", "priceStickerConfiguration("]) {
      const start = route.indexOf(call);
      expect(start).toBeGreaterThan(0);
      expect(route.slice(start, start + 400)).not.toContain("personalization");
    }
  });

  it("passes the authenticated shop and the server family, never a posted value", () => {
    const block = route.slice(route.indexOf("resolvePersonalizationForLine("), route.indexOf("resolvePersonalizationForLine(") + 300);
    expect(block).toContain("shop, productFamily, posted: rawItem.personalizationAssets");
    // `shop` is the app-proxy session shop; the body's shop field is ignored
    expect(route).toContain("const shop = session.shop");
  });

  it("attaches only server-built attributes to the draft-order line", () => {
    expect(route).toContain("...personalizationAttributes");
    expect(route).toContain("personalizationLineAttributes(personalization.assets)");
    // the posted array never reaches the line item
    expect(route).not.toContain("customAttributes.push(rawItem.personalizationAssets");
    expect(route).not.toContain("JSON.stringify(rawItem.personalizationAssets");
  });

  it("returns a bounded refusal and leaks neither claims nor CDN URLs", () => {
    const block = route.slice(route.indexOf("personalization refused"), route.indexOf("personalization refused") + 700);
    expect(block).toContain("code: personalization.code");
    expect(block).not.toContain("assetClaim");
    expect(block).not.toContain("fileUrl");
    // the response summary carries a count only
    expect(route).toContain("personalizationCount");
    expect(route).not.toContain("personalizationAssets: personalization.assets");
  });

  it("reads the signing secret lazily and never sends it anywhere", () => {
    expect(route).toContain("getPersonalizationClaimSecret()");
    expect(route).not.toContain("SHOPIFY_API_SECRET");
    expect(route).not.toContain("secret:.*console");
  });
});

describe("GSO cart contract (configurator bundle pins)", () => {
  it("keeps the single existing cart — no parallel store and no native Shopify cart", () => {
    expect(CONFIGURATOR_JS.match(/gso_configurator_cart_v1/g)).toHaveLength(1);
    expect(CONFIGURATOR_JS.includes("/cart/add.js")).toBe(false);
    expect(CONFIGURATOR_JS.includes("cart/update.js")).toBe(false);
    // the pre-existing native form lockout is untouched
    expect(CONFIGURATOR_JS).toContain('form[action*="/cart/add"] [name="add"]');
  });

  it("stores only bounded references on the cart item — never bytes", () => {
    expect(CONFIGURATOR_JS).toContain("function gsoPzList(t)");
    expect(CONFIGURATOR_JS).toContain("assetId:String(a.assetId),assetClaim:String(a.assetClaim)");
    expect(/readAsDataURL|FileReader|\bbtoa\(|createObjectURL/.test(CONFIGURATOR_JS)).toBe(false);
    // only an id + claim survive the trip to the server
    expect(CONFIGURATOR_JS).toContain("return{assetId:x.assetId,assetClaim:x.assetClaim}");
  });

  it("requires BOTH an id and a claim before an asset is cart-eligible", () => {
    expect(CONFIGURATOR_JS).toContain("return a&&a.assetId&&a.assetClaim");
    expect(PERSONALIZATION_JS).toContain("return Boolean(asset.assetId) && Boolean(asset.assetClaim);");
  });

  it("makes personalization identity part of the merge key, deterministically ordered", () => {
    expect(CONFIGURATOR_JS).toContain("function gsoPzTag(t)");
    expect(CONFIGURATOR_JS).toContain('.map(function(a){return a.assetId}).sort().join(",")');
    // both the jar and the bag key include the segment
    expect(CONFIGURATOR_JS).toContain('t.jarColor||"",t.zakekeDesignId||"",gsoPzTag(t)].join("||")');
    expect(CONFIGURATOR_JS).toContain('t.bagColor||"",t.zakekeDesignId||"",gsoPzTag(t)].join("||")');
    // filenames must not be part of identity
    expect(CONFIGURATOR_JS).not.toContain("originalFileName}).sort()");
  });

  it("omits the key entirely when there is no personalization, so the gate-off payload is unchanged", () => {
    // both helpers assign only when the list is non-empty
    expect(CONFIGURATOR_JS).toContain("if(a&&a.length)o.personalizationAssets=a;return o");
    expect(CONFIGURATOR_JS).toContain("if(a.length)o.personalizationAssets=a;return o");
  });

  it("keeps the Zakeke handoff intact alongside it", () => {
    expect(CONFIGURATOR_JS).toContain('zakekeDesignId:window.GSOZakeke&&window.GSOZakeke.designId()||""');
    expect(CONFIGURATOR_JS).toContain('zakekeDesignId:t.zakekeDesignId||""');
    expect(CONFIGURATOR_JS).toContain('zakekePreviewUrl:t.zakekePreviewUrl||""');
  });
});

describe("merge identity behaves as specified", () => {
  /** Mirrors gsoPzTag + the non-jar branch of the minified merge key. */
  function mergeKey(item: any) {
    const tag = ((item.personalizationAssets || []) as any[])
      .filter((a) => a && a.assetId && a.assetClaim)
      .map((a) => String(a.assetId))
      .sort()
      .join(",");
    return [item.shop || "", item.handle || "", item.material || "", item.finish || "", item.bagColor || "", item.zakekeDesignId || "", tag].join("||");
  }

  const base = { shop: SHOP, handle: "4x5-sticker-bag", material: "Matte", finish: "Standard", bagColor: "Kraft" };
  const withAssets = (...ids: string[]) => ({ ...base, personalizationAssets: ids.map((assetId) => ({ assetId, assetClaim: "a.b" })) });

  it("merges two identical bags with no personalization", () => {
    expect(mergeKey({ ...base })).toBe(mergeKey({ ...base }));
  });

  it("merges identical bags carrying the identical asset set", () => {
    expect(mergeKey(withAssets(A, B))).toBe(mergeKey(withAssets(A, B)));
  });

  it("treats asset order as irrelevant", () => {
    expect(mergeKey(withAssets(A, B))).toBe(mergeKey(withAssets(B, A)));
  });

  it("does NOT merge logo A with logo B", () => {
    expect(mergeKey(withAssets(A))).not.toBe(mergeKey(withAssets(B)));
  });

  it("does NOT merge one file with two files", () => {
    expect(mergeKey(withAssets(A))).not.toBe(mergeKey(withAssets(A, B)));
  });

  it("does NOT merge an uploaded bag with a plain bag", () => {
    expect(mergeKey(withAssets(A))).not.toBe(mergeKey({ ...base }));
  });

  it("keeps the physical configuration decisive too", () => {
    expect(mergeKey(withAssets(A))).not.toBe(mergeKey({ ...withAssets(A), bagColor: "White" }));
  });
});

describe("price is untouched by personalization", () => {
  it("changes no pricing module", () => {
    for (const file of [
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/storefront-canonical-pricing.server.ts",
      "app/lib/configurator-pricing.ts",
    ]) {
      expect(readFileSync(file, "utf8").toLowerCase().includes("personalization")).toBe(false);
    }
  });

  it("keeps MOQ 50 and the price fields out of the personalization path", () => {
    const lib = readFileSync("app/lib/personalization-checkout.server.ts", "utf8");
    for (const token of ["priceEach", "unitPrice", "orderTotal", "quantity", "minQuantity"]) {
      expect(lib.includes(token)).toBe(false);
    }
    expect(PERSONALIZATION_JS.includes("priceEach")).toBe(false);
    expect(PERSONALIZATION_JS.includes("quantity")).toBe(false);
  });
});

describe("checkout stays a checkout concern", () => {
  // Phase 5 now consumes these attributes; what must still hold is that the
  // CHECKOUT module itself never reaches into production or the database.
  it("creates no ProductionJob or database behaviour of its own", () => {
    const lib = readFileSync("app/lib/personalization-checkout.server.ts", "utf8");
    expect(lib.includes("ProductionJob")).toBe(false);
    expect(lib.includes("prisma")).toBe(false);
    expect(lib.includes("db.")).toBe(false);
  });

  it("keeps the attribute keys Phase 5 reads back stable", () => {
    expect(PERSONALIZATION_COUNT_KEY).toBe("_GSO Personalization Count");
    expect(PERSONALIZATION_ASSETS_KEY).toBe("_GSO Personalization Assets");
  });
});

describe("feature gate is still OFF", () => {
  it("keeps the merchant setting defaulted false and the UI Liquid-gated", () => {
    const block = readFileSync("extensions/wholesale-theme/blocks/gso-product-configurator.liquid", "utf8");
    const setting = block.slice(block.indexOf('"id": "enable_personalization"'));
    expect(setting.slice(0, setting.indexOf("}"))).toContain('"default": false');
    expect(block).toContain("block.settings.enable_personalization and product.type == 'Stock Bag'");
  });

  it("leaves the fake legacy uploader disabled", () => {
    const template = readFileSync("shopify-theme/templates/product.configurator-pilot.json", "utf8");
    const parsed = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
    expect(parsed.sections["1771828352671bead8"].blocks.ai_gen_block_15f470a_xiVLGg.disabled).toBe(true);
  });

  it("yields an empty asset list when the client never rendered", () => {
    // cartAssets() reads the module's own state, which stays empty because init()
    // returns early without the container
    expect(PERSONALIZATION_JS).toContain("if (!root) return;");
    expect(PERSONALIZATION_JS).toContain("var assets = [];");
    expect(PERSONALIZATION_JS).toContain("return assets.filter(isCartEligible).map(");
  });
});
