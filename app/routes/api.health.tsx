// 2026-11-19 — liveness + build marker. Public, read-only, no database, no
// business data: it answers "is the app up, and which build is serving?" so a
// deploy can be verified without signing in. The commit id is the one Render
// built (RENDER_GIT_COMMIT); nothing else from the environment is exposed.

const body = () => ({ ok: true, commit: String(process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null });

export async function loader() {
  return Response.json(body(), { headers: { "Cache-Control": "no-store" } });
}
