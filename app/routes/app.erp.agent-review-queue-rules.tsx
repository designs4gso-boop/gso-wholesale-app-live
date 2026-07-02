import { allAgentReviewQueueRules } from "../lib/agent-review-queue-rules";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const rules = allAgentReviewQueueRules();
  const url = new URL(request.url);
  const pretty = url.searchParams.get("pretty") === "1";

  const payload = {
    ok: true,
    version: rules.version,
    mode: rules.mode,
    shop: session.shop,
    purpose: "Official GSO staff review queue rules for agent-prepared quote-prep drafts.",
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
