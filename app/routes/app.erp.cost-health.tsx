import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildCostHealth, type CostHealthStatus } from "../lib/cost-health-rules.server";

type Status = CostHealthStatus;

// READ-ONLY page. The loader only fetches shop-scoped rows; every rule lives
// in app/lib/cost-health-rules.server.ts (pure, unit-tested). Nothing here
// writes to the database, Shopify, or any pricing authority.
export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [materials, machines, productTypes] = await Promise.all([
    db.material.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        materialType: true,
        productFamilies: true,
        unit: true,
        baseUnit: true,
        costPerUnit: true,
        purchaseCost: true,
        purchaseUnit: true,
        calculatedUnitCost: true,
        rollWidthIn: true,
        rollLengthFt: true,
        volumeMl: true,
        yieldQuantity: true,
        yieldUnit: true,
        useInRecipes: true,
        costReviewNeeded: true,
        active: true,
        // 2026-10-08: a zero-cost material nothing references is a placeholder
        // warning, not a critical cost source (see cost-health-rules).
        _count: { select: { recipeMaterials: true, recipeMediaOptions: true, recipeLabelZones: true } },
      },
      orderBy: [{ active: "desc" }, { materialType: "asc" }, { name: "asc" }],
      take: 300,
    }),
    db.machine.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        machineType: true,
        costPerHour: true,
        sqftPerHour: true,
        setupWastePct: true,
        active: true,
        inkChannels: {
          select: {
            id: true,
            slotNumber: true,
            inkName: true,
            inkType: true,
            costPerMl: true,
            cartridgeCost: true,
            cartridgeMl: true,
            mlPerSqft1Pct: true,
            mlPerSqft100: true,
            enabled: true,
          },
          orderBy: [{ slotNumber: "asc" }],
        },
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      take: 100,
    }),
    db.productTypeProfile.findMany({
      where: { shop },
      select: {
        id: true,
        key: true,
        name: true,
        productionMode: true,
        defaultMarginPct: true,
        tierBreakpoints: true,
        active: true,
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      take: 100,
    }),
  ]);

  // 12B.1a pricing-audit inputs: all read-only counts/selects, shop-scoped.
  const [vendorProductRows, recipesWithStoredLabor, sourcedCostTierCount, productCostCount, pricingRuleCount] = await Promise.all([
    db.vendorProduct.findMany({
      where: { shop, active: true },
      select: { id: true, name: true, defaultUnitCost: true, vendorSku: true, _count: { select: { tiers: true } } },
      take: 200,
    }),
    db.productRecipe.findMany({
      where: {
        shop,
        active: true,
        OR: [
          { applicationLaborSecondsPerUnit: { gt: 0 } },
          { packingLaborSecondsPerUnit: { gt: 0 } },
          { prepressMinutes: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        name: true,
        applicationLaborSecondsPerUnit: true,
        packingLaborSecondsPerUnit: true,
        prepressMinutes: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    db.sourcedCostTier.count({ where: { shop } }),
    db.productCost.count({ where: { shop } }),
    db.pricingRule.count({ where: { shop } }),
  ]);

  return buildCostHealth({
    materials: materials.map((m) => ({
      ...m,
      recipeReferences: (m._count?.recipeMaterials || 0) + (m._count?.recipeMediaOptions || 0) + (m._count?.recipeLabelZones || 0),
    })),
    machines,
    productTypes,
    vendorProductRows,
    recipesWithStoredLabor,
    sourcedCostTierCount,
    productCostCount,
    pricingRuleCount,
  });
}

function money(value: number, digits = 4): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `$${value.toFixed(digits)}`;
}

function Badge({ status, children }: { status: Status; children: React.ReactNode }) {
  return <span className={`badge badge-${status}`}>{children}</span>;
}

export default function CostHealthRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <div className="page">
      <style>{`
        .page{max-width:1180px;margin:0 auto;padding:28px;font-family:Arial, sans-serif;color:#111827;}
        .hero{background:linear-gradient(135deg,#111827,#4b5563);color:white;border-radius:12px;padding:24px;margin-bottom:16px;}
        .hero h1{margin:0 0 6px;font-size:28px;}
        .hero p{margin:0;font-size:13px;opacity:.95;line-height:1.45;}
        .notice{border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;border-radius:10px;padding:14px;margin-bottom:18px;font-size:13px;line-height:1.45;}
        .nav{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px;}
        .nav a{font-size:13px;color:#1d4ed8;text-decoration:underline;}
        .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px;}
        .card{border:1px solid #e5e7eb;background:white;border-radius:10px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04);}
        .card .label{font-size:12px;color:#6b7280;margin-bottom:6px;}
        .card .value{font-size:26px;font-weight:800;margin-bottom:6px;}
        .card .help{font-size:12px;color:#4b5563;line-height:1.35;}
        .section{border:1px solid #e5e7eb;background:white;border-radius:12px;padding:16px;margin-bottom:18px;}
        .section h2{font-size:18px;margin:0 0 8px;}
        .section p{font-size:13px;line-height:1.45;color:#4b5563;margin:0 0 12px;}
        table{width:100%;border-collapse:collapse;font-size:12px;}
        th{background:#f3f4f6;text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;}
        td{padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;}
        .badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700;}
        .badge-ready{background:#dcfce7;color:#166534;}
        .badge-warning{background:#fef3c7;color:#92400e;}
        .badge-critical{background:#fee2e2;color:#991b1b;}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
        .empty{padding:18px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;font-size:13px;}
        @media(max-width:900px){.grid{grid-template-columns:1fr}.page{padding:16px}}
      `}</style>

      <div className="hero">
        <h1>Cost Source Health Check</h1>
        <p>v15 (2026-10-08 cleanup): audits materials, roll-media conversion, ink/ml setup, and printer-only ink channels, plus the pricing-audit checks — purchaseCost fallback traps, seeded estimate ink costs, machine-rate conflicts, vendor tier coverage, unpriced recipe labor, and legacy cost tables. Routing-aware: the Mimaki is CMYK-only for ERP routing, so its stored white channels are reported as hardware data, never as print capacity.</p>
      </div>

      <div className="notice">
        This page does not update Shopify and does not change prices or data. It tells us which backend cost sources are ready, which are estimates, and which must be fixed before the calculator can be trusted for real quotes.
        <div className="nav">
          <Link to="/app/erp/cost-verification">Open Cost Verification Workbook</Link>
          <Link to="/app/erp/materials">Open Materials</Link>
          <Link to="/app/erp/machines">Open Machine Center</Link>
          <Link to="/app/erp/product-setup">Open Product Setup</Link>
          <Link to="/app/erp/cost-calculator">Open Cost Calculator</Link>
          <Link to="/app/erp/vendor-cost-book">Open Vendor Cost Book</Link>
        </div>
      </div>

      <div className="section">
        <h2>Cost verification facts (12B pricing audit)</h2>
        <p>
          <b>DB-backed does not automatically mean invoice-verified.</b> Several database costs were seeded from code constants
          (jar/Miron costs, machine ink defaults), and jar cost data currently exists in multiple places (Cost Calculator presets,
          Vendor Product tiers, flat Material costs, and legacy SourcedCostTier rows). To verify: check each cost below against the
          real vendor invoice or price sheet, fix it in Materials / Machine Center / Vendor Cost Book, and use the material
          "cost review needed" flag to track what is still unverified. Two known engine gaps are deliberately unfixed because they
          move live quote pricing and need separate owner approval: the purchaseCost fallback, and vendor-tier-aware blank costing
          (plus pricing the stored application/packing/prepress labor).
        </p>
      </div>

      <div className="grid">
        {data.cards.map((card) => (
          <div className="card" key={card.label}>
            <div className="label">{card.label}</div>
            <div className="value">{card.value}</div>
            <Badge status={card.status}>{card.status === "ready" ? "Ready" : card.status === "warning" ? "Needs review" : "Needs fix"}</Badge>
            <div className="help">{card.help}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <h2>Cost source issues</h2>
        <p>Fix critical issues first. Warnings can still calculate, but the result should be treated as an estimate or manual fallback.</p>
        {data.issues.length === 0 ? (
          <div className="empty">No issues found. Backend cost sources look ready for calculator testing.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Status</th><th>Area</th><th>Item</th><th>Problem</th><th>Fix</th></tr>
            </thead>
            <tbody>
              {data.issues.map((issue, idx) => (
                <tr key={`${issue.area}-${issue.item}-${idx}`}>
                  <td><Badge status={issue.status}>{issue.status}</Badge></td>
                  <td>{issue.area}</td>
                  <td><strong>{issue.item}</strong></td>
                  <td>{issue.message}</td>
                  <td>{issue.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>Material cost preview</h2>
        <p>Roll media should show a cost per square inch. Ink/coating should show a cost per ml. Zero means the calculator will not be able to auto-price that variable correctly.</p>
        <table>
          <thead>
            <tr><th>Material</th><th>Type</th><th>Unit</th><th>Purchase cost</th><th>Cost/unit</th><th>Cost/sq in</th><th>Ink cost/ml</th><th>Use</th></tr>
          </thead>
          <tbody>
            {data.materialPreview.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong></td>
                <td>{m.type}</td>
                <td>{m.unit} / {m.baseUnit}</td>
                <td>{money(m.purchaseCost, 2)}</td>
                <td>{money(m.costPerUnit, 4)}</td>
                <td className="mono">{money(m.costPerSqIn, 6)}</td>
                <td className="mono">{money(m.inkCostPerMl, 6)}</td>
                <td>{m.useInRecipes ? "Recipes" : "Hidden"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Machine / print layer preview</h2>
        <p>CMYK should be your base print layer. White and gloss/clear should be add-on layers with their own ink cost and production slowdown handling. This page checks whether the machine has enough setup to support that. "Slot cost" means the channel carries its own cartridge cost; an "estimated via" material is only used when a slot has no cost of its own.</p>
        <table>
          <thead>
            <tr><th>Machine</th><th>Type</th><th>Printer?</th><th>Cost/hr</th><th>Sqft/hr</th><th>Enabled ink channels</th></tr>
          </thead>
          <tbody>
            {data.machinePreview.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong>{m.routing ? <div style={{ fontSize: 11, color: "#4b5563", marginTop: 4 }}>{m.routing}</div> : null}</td>
                <td>{m.type}</td>
                <td>{m.isPrinter ? "Yes" : "No / ignored"}</td>
                <td>{money(m.costPerHour, 2)}</td>
                <td>{m.sqftPerHour.toFixed(2)}</td>
                <td>
                  {m.channels.length === 0 ? "No enabled ink channels" : m.channels.map((c: any) => (
                    <div key={`${m.id}-${c.slotNumber}`}>
                      Slot {c.slotNumber}: <strong>{c.inkName || c.inkType}</strong> ({c.inkType}) — cost/ml <span className="mono">{money(c.costPerMl, 6)}</span>{c.costSource === "slot" ? <span> (slot cost)</span> : c.matchedMaterialName ? <span> (estimated via {c.matchedMaterialName})</span> : null}, usage 1% <span className="mono">{c.mlPerSqft1Pct.toFixed(6)}</span>, usage 100% <span className="mono">{c.mlPerSqft100.toFixed(6)}</span>{c.routedElsewhere ? <span style={{ color: "#92400e" }}> — hardware channel only: the ERP routes white/gloss jobs to the Roland, so this slot never prices a job</span> : null}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
