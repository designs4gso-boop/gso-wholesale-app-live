import { redirect } from "react-router";

// Retired in Patch 13.1: the legacy ProductCost editor is superseded by
// Materials / Vendor Cost Book / Product Setup. 13.1.1: registered OUTSIDE
// the /app layout so no authentication runs here; query params are forwarded
// so the successor authenticates in one hop. The /app/erp/product-costs shim
// re-exports default, loader, and action from this module — all three must
// stay exported. The ProductCost table itself is untouched.
function forward(request: Request) {
  return redirect(`/app/erp/materials${new URL(request.url).search}`);
}

export async function loader({ request }: { request: Request }) {
  return forward(request);
}

export async function action({ request }: { request: Request }) {
  return forward(request);
}

export default function RetiredProductCostsRoute() {
  return null;
}
