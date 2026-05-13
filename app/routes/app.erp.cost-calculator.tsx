export default function ErpCostCalculatorRoute() {
  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <p><a href="/app/erp/product-setup">← Product Setup / Recipes</a></p>
      <h1>Cost Calculator</h1>
      <p>
        The full cost calculator is being folded into Product Setup / Recipes so quotes use saved materials,
        machines, finishes, labor assumptions, and margin rules instead of one-off manual calculations.
      </p>
      <p>
        For now, use <a href="/app/erp/product-setup">Product Setup / Recipes</a> as the backend cost setup page.
      </p>
    </main>
  );
}
