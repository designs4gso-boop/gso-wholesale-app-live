// 2026-11-12 — LAUNCH READINESS aligned with canonical routing.
//
// Quote readiness for an ACTIVE jar = confirmed geometry + verified blank cost
// + at least one compatible press under the canonical routing rules. A blank
// Product Setup preferred machine (or width / height) only affects AUTOMATIC
// agent conversion and is reported under Agent Platform. The inactive 5oz
// placeholder is informational. The scenario below is the live readiness list.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "942075-2.myshopify.com" }, admin: {} }) },
}));

const LIVE_RECIPES = [
  "5oz Clear Jar with Applied Label",
  "4oz Black/White Jar with Applied Label",
  "4oz Clear Jar with Applied Label",
  "100ml Tall Miron Jar with Applied Label",
  "50ml Miron Jar with Applied Label",
  "3oz Black/White Jar with Applied Label",
  "3oz Clear Jar with Applied Label",
  "250ml Miron Jar with Applied Label",
  "150ml Miron Jar with Applied Label",
  "100ml Wide Miron Jar with Applied Label",
];
const state: { recipes: Array<{ id: string; name: string; productType: string; minQuantity: number }> } = { recipes: [] };
const setRecipes = (names: string[]) => {
  state.recipes = names.map((name, i) => ({ id: `r_${i}`, name, productType: `jar_${i}`, minQuantity: 1 }));
};

vi.mock("../app/db.server", () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (method === "count") {
        if (name === "quote") return args?.where?.status ? 2 : 6;
        if (name === "agentApiCredential") return 0;
        return 3;
      }
      if (method === "findFirst") return null;
      if (method === "findMany") return name === "productRecipe" ? state.recipes : [];
      throw new Error(`unexpected db.${name}.${method} — readiness is read-only`);
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => model(key) });
  return { default: db, db };
});

// The live engine answer: jar recipes have no preferred machine; the 5oz
// placeholder also has no dimensions.
vi.mock("../app/lib/recipe-pricing.server", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  priceRecipeAtQuantity: () => ({}),
  blockingConversionIssues: (recipe: any) =>
    /5oz/.test(recipe.name) ? ["recipe is missing width or height"] : ["recipe has no preferred machine"],
}));

import { MACHINE_CAPABILITIES, compatiblePrinters, resolveCanonicalMachineRouting } from "../app/lib/machine-routing.server";
import { NO_COMPATIBLE_PRINTER, canonicalRoutingAvailable, classifyRecipeReadiness } from "../app/lib/jar-quote-readiness.server";
import { PRIMER_NOT_CONFIGURED } from "../app/lib/print-intake-routing.server";

const NO_MACHINE = ["recipe has no preferred machine"];
const loadReadiness = async () => {
  const route: any = await import("../app/routes/app.erp.setup-wizard");
  return (await route.loader({ request: new Request("https://app.test/app/erp/setup-wizard") })).json();
};

describe("1-7. active jars with confirmed geometry are quote-ready without a preferred machine", () => {
  const cases: Array<[number, string]> = [
    [2, "4oz Clear Jar with Applied Label"],
    [2, "4oz Black/White Jar with Applied Label"],
    [3, "3oz Clear Jar with Applied Label"],
    [3, "3oz Black/White Jar with Applied Label"],
    [4, "100ml Tall Miron Jar with Applied Label"],
    [5, "100ml Wide Miron Jar with Applied Label"],
    [6, "150ml Miron Jar with Applied Label"],
    [7, "250ml Miron Jar with Applied Label"],
    [1, "Chiron 150ml jar"],
  ];
  for (const [n, name] of cases) {
    it(`${n}. ${name}`, () => {
      const r = classifyRecipeReadiness({ name }, NO_MACHINE);
      expect(r.scope).toBe("jar_active");
      expect(r.quoteIssues).toEqual([]); // QUOTE READY
      expect(r.agentConversionIssues).toEqual(NO_MACHINE); // reported for agent auto-conversion only
    });
  }
});

describe("8-9. inactive placeholder and pending geometry", () => {
  it("8. the inactive 5oz placeholder is informational, never a quote issue", () => {
    const r = classifyRecipeReadiness({ name: "5oz Clear Jar with Applied Label", productType: "jar_5oz_clear" }, ["recipe is missing width or height"]);
    expect(r.scope).toBe("jar_inactive");
    expect(r.quoteIssues).toEqual([]);
    expect(r.informational).toEqual(["5oz Clear Jar with Applied Label — not an active jar product; no confirmed label geometry (inactive — not launch-blocking)"]);
  });

  it("9. 50ml (active, geometry pending) still reports exactly that", () => {
    const r = classifyRecipeReadiness({ name: "50ml Miron Jar with Applied Label" }, NO_MACHINE);
    expect(r.scope).toBe("jar_active");
    expect(r.quoteIssues).toEqual(["Miron 50ml — label geometry pending owner sample"]);
  });
});

describe("11-14. canonical routing authority is unchanged", () => {
  it("11. a configuration with genuinely no compatible press still blocks", () => {
    const noGloss = { mimaki: { cmyk: true, white: true, gloss: false }, roland: { cmyk: true, white: true, gloss: false } };
    const routing = canonicalRoutingAvailable({ glossLayers: 1 }, noGloss);
    expect(routing).toMatchObject({ ok: false, reason: NO_COMPATIBLE_PRINTER });
    const r = classifyRecipeReadiness({ name: "4oz Clear Jar with Applied Label" }, [], { layers: { glossLayers: 1 }, capabilities: noGloss });
    expect(r.quoteIssues[0]).toMatch(/NO_COMPATIBLE_PRINTER/);
  });

  it("12. gloss stays routable on the Roland (and only the Roland)", () => {
    expect(canonicalRoutingAvailable({ glossLayers: 1 })).toEqual({ ok: true, printers: ["roland"] });
    expect(canonicalRoutingAvailable({})).toEqual({ ok: true, printers: ["mimaki", "roland"] });
    expect(canonicalRoutingAvailable({ whiteLayers: 1 })).toEqual({ ok: true, printers: ["mimaki", "roland"] });
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", glossLayers: 1, glossCoveragePct: 50 }).effectivePrinter).toBe("roland");
  });

  it("13. Primer remains blocked", () => {
    expect(canonicalRoutingAvailable({ primer: true })).toMatchObject({ ok: false, reason: PRIMER_NOT_CONFIGURED });
    expect(classifyRecipeReadiness({ name: "4oz Clear Jar with Applied Label" }, [], { layers: { primer: true } }).quoteIssues[0]).toMatch(/PRIMER_NOT_CONFIGURED/);
  });

  it("14. the readiness check agrees with — and does not alter — the canonical routing tables", () => {
    expect(MACHINE_CAPABILITIES).toEqual({ mimaki: { cmyk: true, white: true, gloss: false }, roland: { cmyk: true, white: true, gloss: true } });
    for (const layers of [{}, { whiteLayers: 1 }, { glossLayers: 1 }, { whiteLayers: 2, glossLayers: 1 }]) {
      const r = canonicalRoutingAvailable(layers);
      expect(r.ok && r.printers).toEqual(compatiblePrinters(layers));
    }
    expect(resolveCanonicalMachineRouting({ printerSelection: "mimaki", glossLayers: 1, glossCoveragePct: 50 }).reasons).toContain("MIMAKI_GLOSS_UNSUPPORTED");
    // the agent-queue conversion gate is not weakened
    expect(readFileSync("app/lib/recipe-pricing.server.ts", "utf8")).toContain('issues.push("recipe has no preferred machine");');
  });
});

describe("live readiness list through the real loader", () => {
  beforeEach(() => setRecipes(LIVE_RECIPES));

  it("10/15. preferred machine gaps move to Agent Platform; Quote Pipeline lists only the real blocker (50ml)", async () => {
    const data: any = await loadReadiness();
    const pipeline = data.steps.find((s: any) => s.name === "Quote Pipeline");
    expect(pipeline.details).toEqual([
      "50ml Miron Jar with Applied Label: Miron 50ml — label geometry pending owner sample",
      "5oz Clear Jar with Applied Label — not an active jar product; no confirmed label geometry (inactive — not launch-blocking)",
    ]);
    expect(pipeline.summary).toBe("Not quote-ready yet: Miron 50ml — label geometry pending owner sample.");
    expect(JSON.stringify([pipeline.details, pipeline.summary])).not.toContain("preferred machine");
    expect(pipeline.counts).toContain("Deep check: 8/9 active sampled recipe(s) quote-ready (canonical calculator)");
    expect(pipeline.severity).toBe("blocker"); // 50ml is an ACTIVE quote product with pending geometry
    expect(data.blockerSteps.map((s: any) => s.name ?? s)).toEqual(["Quote Pipeline"]);

    const agent = data.steps.find((s: any) => s.name === "Agent Platform");
    expect(agent.severity).toBe("warning"); // never a launch blocker
    expect(agent.details).toHaveLength(9);
    expect(agent.details).toContain("4oz Clear Jar with Applied Label: recipe has no preferred machine (agent auto-conversion only)");
    expect(agent.counts.join(" ")).toContain("Automatic agent conversion needs Product Setup");
  }, 120_000);

  it("without 50ml the Quote Pipeline is no longer a blocker; the inactive 5oz alone never blocks", async () => {
    setRecipes(LIVE_RECIPES.filter((name) => !/50ml/.test(name)));
    const data: any = await loadReadiness();
    const pipeline = data.steps.find((s: any) => s.name === "Quote Pipeline");
    expect(pipeline.severity).not.toBe("blocker");
    expect(data.blockerSteps).toEqual([]);
    expect(pipeline.details).toEqual(["5oz Clear Jar with Applied Label — not an active jar product; no confirmed label geometry (inactive — not launch-blocking)"]);
  }, 120_000);
});
