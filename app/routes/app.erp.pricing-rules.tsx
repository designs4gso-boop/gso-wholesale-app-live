import { Link } from "@remix-run/react";

export default function ErpPricingRulesRoute() {
  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/app">? Dashboard</Link>
      </div>

      <h1>Pricing Rules</h1>
      <p>
        This ERP pricing rules page is ready for the next backend build step.
        Pricing tiers, margin templates, MOQ rules, and product-family pricing
        defaults will be connected here.
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 20 }}>
        <a href="/app/product-costs">Open current Product Costs backend</a>
        <a href="/app/erp/product-setup">Open Product Setup</a>
        <a href="/app/erp/cost-calculator">Open Cost Calculator</a>
      </div>
    </main>
  );
}
