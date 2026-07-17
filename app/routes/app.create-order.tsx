import { redirect } from "react-router";

// Retired in Patch 13.1 (deletion pre-authorized by the Patch 4 milestone
// note). Order creation lives exclusively in Quotes / CRM with its full set
// of server gates. Loader AND action redirect so a stray bookmark POST can
// never create an order or draft order from this path again.
export async function loader() {
  return redirect("/app/quotes");
}

export async function action() {
  return redirect("/app/quotes");
}

export default function RetiredCreateOrderRoute() {
  return null;
}
