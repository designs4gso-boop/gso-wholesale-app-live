import db from "../db.server";
import { importPrintLogText } from "../lib/print-logs.server";

async function bodyToPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return request.json();
  }

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    const file = formData.get("file");
    let rawText = String(formData.get("rawText") || "");
    let fileName = String(formData.get("fileName") || "");

    if (file && typeof file !== "string") {
      rawText = await file.text();
      fileName = fileName || file.name;
    }

    return {
      token: String(formData.get("token") || ""),
      source: String(formData.get("source") || "auto_watch_folder"),
      fileName,
      rawText,
      notes: String(formData.get("notes") || ""),
    };
  }

  const rawText = await request.text();
  return {
    token: request.headers.get("x-gso-print-log-token") || "",
    source: request.headers.get("x-gso-print-log-source") || "auto_watch_folder",
    fileName: request.headers.get("x-gso-print-log-file-name") || "raw-upload.txt",
    rawText,
    notes: request.headers.get("x-gso-print-log-notes") || "",
  };
}

export async function action({ request }: { request: Request }) {
  if (request.method.toUpperCase() !== "POST") {
    return Response.json({ ok: false, error: "POST required." }, { status: 405 });
  }

  const payload = await bodyToPayload(request);
  const token = String(payload.token || request.headers.get("x-gso-print-log-token") || "").trim();

  if (!token) {
    return Response.json({ ok: false, error: "Missing upload token." }, { status: 401 });
  }

  const setting = await db.printLogAutoImportSetting.findFirst({
    where: { uploadToken: token, enabled: true },
  });

  if (!setting) {
    return Response.json({ ok: false, error: "Invalid or disabled upload token." }, { status: 401 });
  }

  const rawText = String(payload.rawText || "").trim();
  if (!rawText) {
    return Response.json({ ok: false, error: "No log text received." }, { status: 400 });
  }

  const result = await importPrintLogText({
    shop: setting.shop,
    source: String(payload.source || "auto_watch_folder"),
    fileName: String(payload.fileName || "auto-upload.txt"),
    rawText,
    notes: String(payload.notes || "Auto-import endpoint upload."),
    importedBy: "auto_import_endpoint",
  });

  await db.printLogAutoImportSetting.update({
    where: { shop: setting.shop },
    data: { lastAutoImportAt: new Date() },
  });

  return Response.json({ ok: true, ...result });
}

export async function loader() {
  return Response.json({
    ok: true,
    message: "GSO print log upload endpoint is online. POST logs with X-GSO-PRINT-LOG-TOKEN or token in JSON/form data.",
  });
}
