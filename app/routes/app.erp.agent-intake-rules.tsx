import { allAgentIntakeRules } from "../lib/agent-intake-rules";
import { authenticate } from "../shopify.server";
import { requireRouteAccess } from "../lib/route-access.server";

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.admin(request);
  requireRouteAccess(auth, "erp/agent-intake-rules"); // 2026-11-19: owner, manager, sales
  const { session } = auth;
  const rules = allAgentIntakeRules();
  const url = new URL(request.url);
  const pretty = url.searchParams.get("pretty") === "1";

  const payload = {
    ok: true,
    version: rules.version,
    mode: rules.mode,
    shop: session.shop,
    purpose:
      "Official GSO agent intake guardrails, customer-safe response rules, escalation triggers, and product-family intake questions for staff-approved agent workflows.",
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
