import { redirect } from "react-router";

// Retired in Patch 13.1: the old wholesale product calculator (which could
// also save duplicate quote drafts) is superseded by the ERP Cost Calculator.
// The route stays registered so bookmarks land on the successor instead of a
// 404; the action also redirects so a stray form POST can never write.
export async function loader() {
  return redirect("/app/erp/cost-calculator");
}

export async function action() {
  return redirect("/app/erp/cost-calculator");
}

export default function RetiredWholesaleCalculatorRoute() {
  return null;
}
