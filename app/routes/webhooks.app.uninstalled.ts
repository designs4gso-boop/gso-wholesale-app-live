import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, session } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return new Response("Unhandled webhook topic", { status: 200 });
  }

  if (session) {
    await db.session.deleteMany({
      where: { shop },
    });
  }

  await db.shopSettings.deleteMany({
    where: { shop },
  });

  return new Response("OK");
}