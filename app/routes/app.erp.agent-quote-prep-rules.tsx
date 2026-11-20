import { allAgentQuotePrepRules } from "../lib/agent-quote-prep-rules";
import { authenticate } from "../shopify.server";
import { requireRouteAccess } from "../lib/route-access.server";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireRouteAccess(auth, "erp/agent-quote-prep-rules"); // 2026-11-19: owner, manager, sales
  const { session } = auth;
  const rules = allAgentQuotePrepRules();
  const url = new URL(request.url);
  const pretty = url.searchParams.get("pretty") === "1";

  const payload = {
    ok: true,
    version: rules.version,
    mode: rules.mode,
    shop: session.shop,
    purpose:
      "Official GSO agent quote-prep draft guardrails, required fields, review triggers, and customer-safe draft reply rules for staff-approved workflows.",
    ...rules,
  };

  if (pretty) {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
