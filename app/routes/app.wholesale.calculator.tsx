import { redirect } from "react-router";

// Retired in Patch 13.1: the old wholesale product calculator (which could
// also save duplicate quote drafts) is superseded by the ERP Cost Calculator.
// 13.1.1: registered OUTSIDE the /app layout so no authentication runs here —
// this route's only job is forwarding old bookmarks. Query params (shop/host/
// embedded context) are forwarded so the successor authenticates in one hop.
// The action also redirects so a stray form POST can never write.
function forward(request: Request) {
  return redirect(`/app/erp/cost-calculator${new URL(request.url).search}`);
}

export async function loader({ request }: { request: Request }) {
  return forward(request);
}

export async function action({ request }: { request: Request }) {
  return forward(request);
}

export default function RetiredWholesaleCalculatorRoute() {
  return null;
}
