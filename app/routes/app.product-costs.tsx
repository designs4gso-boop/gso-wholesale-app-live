import { redirect } from "react-router";

// Retired in Patch 13.1: the legacy ProductCost editor is superseded by
// Materials / Vendor Cost Book / Product Setup. Both this route and the
// /app/erp/product-costs shim (which re-exports default, loader, and action
// from this module — all three must stay exported) now land on Materials.
// The ProductCost table itself is untouched; schema cleanup is a later patch.
export async function loader() {
  return redirect("/app/erp/materials");
}

export async function action() {
  return redirect("/app/erp/materials");
}

export default function RetiredProductCostsRoute() {
  return null;
}
