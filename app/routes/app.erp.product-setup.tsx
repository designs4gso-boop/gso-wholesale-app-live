import { redirect } from "react-router";

export async function loader() {
  return redirect("/app/product-costs");
}

export default function ProductSetupAlias() {
  return (
    <main style={{ padding: 24 }}>
      <h1>Product Setup</h1>
      <p>Redirecting to the product backend page...</p>
      <a href="/app/product-costs">Open Product Costs</a>
    </main>
  );
}
