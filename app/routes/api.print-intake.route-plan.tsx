import db from "../db.server";
import {
  basenameOf,
  decideIntakeRoute,
  eligibleJobsWhere,
  type IntakeJob,
} from "../lib/print-intake-routing.server";

// Print Intake plan endpoint (13A.6G): READ-ONLY. The local intake agent
// posts a filename (+ optional immediate subfolder name — basenames only,
// never full local paths) and receives a deterministic routing decision with
// the exact ERP RIP name and a machine KEY. Hot-folder paths never appear
// here — they live exclusively in the agent's local config. Token-authenticated
// with the existing upload token; shop-scoped; zero writes.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function action({ request }: { request: Request }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400);
  }
  const token = String(body.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing upload token." }, 401);
  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken: token } });
  if (!setting || !setting.enabled) return json({ ok: false, error: "Invalid or disabled upload token." }, 403);

  const fileName = basenameOf(String(body.fileName || "").trim());
  if (!fileName) return json({ ok: false, error: "Missing fileName." }, 400);
  const subfolder = basenameOf(String(body.subfolder || "").trim());

  const jobs = await db.productionJob.findMany({
    where: eligibleJobsWhere(setting.shop),
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: {
      id: true, jobTicket: true, customerName: true, company: true, status: true,
      artworkUrl: true, printFileUrl: true,
      items: {
        select: {
          id: true, itemTicket: true, ripJobName: true, suggestedFileName: true,
          productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true,
        },
      },
      files: { select: { fileName: true, originalFileName: true }, take: 20 },
    },
  });

  const intakeJobs: IntakeJob[] = jobs.map((job) => ({
    id: job.id,
    jobTicket: job.jobTicket,
    customerName: job.customerName,
    company: job.company,
    status: job.status,
    artworkUrl: job.artworkUrl,
    printFileUrl: job.printFileUrl,
    items: job.items,
    fileNames: job.files.flatMap((file) => [file.fileName, file.originalFileName || ""]).filter(Boolean),
  }));

  const plan = decideIntakeRoute({ fileName, subfolder, jobs: intakeJobs });
  return json({ ok: true, fileName, plan });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, subfolder?} for a deterministic print-intake routing plan. Read-only." }),
    { headers: { "Content-Type": "application/json" } },
  );
