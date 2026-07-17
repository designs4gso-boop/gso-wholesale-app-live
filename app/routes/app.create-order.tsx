import { redirect } from "react-router";

// Retired in Patch 13.1 (deletion pre-authorized by the Patch 4 milestone
// note). Order creation lives exclusively in Quotes / CRM with its full set
// of server gates. 13.1.1: registered OUTSIDE the /app layout so no
// authentication runs here; query params are forwarded so the successor
// authenticates in one hop. Loader AND action redirect so a stray bookmark
// POST can never create an order or draft order from this path again.
function forward(request: Request) {
  return redirect(`/app/quotes${new URL(request.url).search}`);
}

export async function loader({ request }: { request: Request }) {
  return forward(request);
}

export async function action({ request }: { request: Request }) {
  return forward(request);
}

export default function RetiredCreateOrderRoute() {
  return null;
}
