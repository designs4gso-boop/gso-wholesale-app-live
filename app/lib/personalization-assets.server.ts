// Stock Bag personalization assets — Phase 1 (storage foundation).
//
// Customers may optionally attach a logo and/or QR code to a premade Stock Bag
// design. This module owns validation and durable storage only; nothing here is
// wired to the storefront, cart, checkout, or production job yet.
//
// Two rules shape the whole file:
//   1. Nothing the client sends is trusted — not the filename, not the extension,
//      not the declared MIME type, not a URL, not an id. Bytes are the authority.
//   2. Durable storage is Shopify Files. The app runs on Render with an ephemeral
//      filesystem, so customer artwork is NEVER written to local disk.

export const MAX_PERSONALIZATION_FILES = 5;
export const MAX_PERSONALIZATION_FILE_BYTES = 10 * 1024 * 1024;
export const PERSONALIZATION_ASSET_ROLE = "personalization";
export const PERSONALIZATION_ASSET_SOURCE = "customer_upload";

const SHOPIFY_API_VERSION = "2025-10";

// V1 deliberately excludes SVG: it is script-capable XML and would need
// sanitising before it could ever be served. PNG/JPEG/PDF cover logos and QR codes.
export const ALLOWED_PERSONALIZATION_MIME_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type PersonalizationMimeType = (typeof ALLOWED_PERSONALIZATION_MIME_TYPES)[number];

const MAX_FILENAME_LENGTH = 80;
const SAFE_EXTENSION: Record<PersonalizationMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export type PersonalizationAsset = {
  assetId: string;
  fileName: string;
  originalFileName: string;
  fileUrl: string;
  mimeType: PersonalizationMimeType;
  byteSize: number;
  assetRole: typeof PERSONALIZATION_ASSET_ROLE;
};

export type PersonalizationUploadInput = {
  fileName: unknown;
  mimeType: unknown;
  bytes: Uint8Array;
};

export type ValidationResult = { ok: true; mimeType: PersonalizationMimeType } | { ok: false; reason: string };

/* ------------------------------------------------------------------ *
 * Filename handling
 * ------------------------------------------------------------------ */

/**
 * The customer's filename is display metadata only. It is bounded and stripped of
 * anything path-like or non-printable before it is ever stored or echoed back.
 */
export function sanitizeOriginalFileName(value: unknown): string {
  const raw = String(value ?? "");
  // Take the basename only — defeats "../../etc/passwd" and "C:\evil\x.png".
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "upload";
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * The name actually stored. Server-generated so it can never collide, traverse,
 * or carry a misleading extension; the customer's name is preserved separately.
 */
export function buildStoredFileName(mimeType: PersonalizationMimeType, token: string): string {
  const safeToken = String(token ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 32) || "asset";
  return `gso-personalization-${safeToken}.${SAFE_EXTENSION[mimeType]}`;
}

/* ------------------------------------------------------------------ *
 * Content validation
 * ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Detect type from magic bytes. The declared MIME type is never sufficient on its own. */
export function detectMimeFromBytes(bytes: Uint8Array): PersonalizationMimeType | null {
  if (!bytes || bytes.length === 0) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG SOI: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PDF: %PDF
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  return null;
}

export function isAllowedPersonalizationMime(value: unknown): value is PersonalizationMimeType {
  return ALLOWED_PERSONALIZATION_MIME_TYPES.includes(String(value ?? "").toLowerCase() as PersonalizationMimeType);
}

/**
 * Validate one candidate file. The declared MIME must be allowed AND must agree
 * with what the bytes actually are, so a renamed executable or an SVG announced
 * as a PNG is rejected on content, not on trust.
 */
export function validatePersonalizationFile(file: PersonalizationUploadInput): ValidationResult {
  const declared = String(file?.mimeType ?? "").toLowerCase();
  const bytes = file?.bytes;

  if (!bytes || bytes.length === 0) return { ok: false, reason: "File is empty." };
  if (bytes.length > MAX_PERSONALIZATION_FILE_BYTES) {
    return { ok: false, reason: `File exceeds the ${Math.floor(MAX_PERSONALIZATION_FILE_BYTES / (1024 * 1024))}MB limit.` };
  }
  if (!isAllowedPersonalizationMime(declared)) {
    return { ok: false, reason: "Unsupported file type. Upload a PNG, JPG, or PDF." };
  }

  const detected = detectMimeFromBytes(bytes);
  if (!detected) return { ok: false, reason: "File contents are not a valid PNG, JPG, or PDF." };
  if (detected !== declared) return { ok: false, reason: "File contents do not match the file type." };

  return { ok: true, mimeType: detected };
}

/** Enforce the per-line-item file count before any upload work begins. */
export function validatePersonalizationBatch(files: PersonalizationUploadInput[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(files)) return { ok: false, reason: "No files provided." };
  if (files.length > MAX_PERSONALIZATION_FILES) {
    return { ok: false, reason: `Attach at most ${MAX_PERSONALIZATION_FILES} files.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Shopify Files
 * ------------------------------------------------------------------ */

type GraphqlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;
type UploadBytesFn = (target: { url: string; parameters: Array<{ name: string; value: string }> }, file: { fileName: string; mimeType: string; bytes: Uint8Array }) => Promise<void>;

export type PersonalizationDeps = {
  graphql: GraphqlFn;
  uploadBytes: UploadBytesFn;
  /** Injected so tests never sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Injected so stored filenames are deterministic in tests. */
  token?: () => string;
};

const STAGED_UPLOADS_CREATE = `
  mutation gsoStagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `
  mutation gsoFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus alt }
      userErrors { field message }
    }
  }
`;

const FILE_STATUS = `
  query gsoFileStatus($id: ID!) {
    node(id: $id) {
      id
      ... on MediaImage { fileStatus image { url } }
      ... on GenericFile { fileStatus url }
    }
  }
`;

function firstUserError(payload: any, key: string): string | null {
  const errors = payload?.data?.[key]?.userErrors;
  if (Array.isArray(errors) && errors.length) {
    // Surface the message only — never the raw payload, which can echo input.
    return String(errors[0]?.message || "Upload rejected by Shopify.");
  }
  if (payload?.errors) return "Upload failed.";
  return null;
}

/** PNG/JPEG become MediaImage; PDF becomes GenericFile. */
function resourceFor(mimeType: PersonalizationMimeType) {
  return mimeType === "application/pdf"
    ? { staged: "FILE", content: "FILE" }
    : { staged: "IMAGE", content: "IMAGE" };
}

function urlFromNode(node: any): string {
  return String(node?.image?.url || node?.url || "");
}

/**
 * Shopify processes uploads asynchronously, so a freshly created file is usually
 * UPLOADED/PROCESSING rather than READY and has no URL yet. Poll a bounded number
 * of times; a file still processing is returned without a URL rather than treated
 * as a failure, and FAILED is surfaced as an error.
 */
export async function resolveFileWhenReady(
  deps: PersonalizationDeps,
  fileId: string,
  attempts = 5,
): Promise<{ ok: true; fileUrl: string; status: string } | { ok: false; reason: string; status: string }> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let status = "UNKNOWN";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const payload = await deps.graphql(FILE_STATUS, { id: fileId });
    const node = payload?.data?.node;
    status = String(node?.fileStatus || "UNKNOWN");

    if (status === "READY") {
      const fileUrl = urlFromNode(node);
      if (fileUrl) return { ok: true, fileUrl, status };
    }
    if (status === "FAILED") return { ok: false, reason: "Shopify could not process the file.", status };

    if (attempt < attempts - 1) await wait(300 * (attempt + 1));
  }

  return { ok: false, reason: "File is still processing.", status };
}

/**
 * Validate → staged upload → transfer bytes → fileCreate → resolve.
 * Returns one normalized asset per accepted file and a reason per rejected file.
 * Never throws for a rejected file; only genuine transport faults propagate.
 */
export async function uploadPersonalizationAssets(
  deps: PersonalizationDeps,
  files: PersonalizationUploadInput[],
): Promise<{ assets: PersonalizationAsset[]; rejected: Array<{ originalFileName: string; reason: string }> }> {
  const batch = validatePersonalizationBatch(files);
  if (!batch.ok) {
    return { assets: [], rejected: [{ originalFileName: "", reason: batch.reason }] };
  }

  const assets: PersonalizationAsset[] = [];
  const rejected: Array<{ originalFileName: string; reason: string }> = [];
  const nextToken = deps.token ?? (() => Math.random().toString(36).slice(2, 10));

  for (const file of files) {
    const originalFileName = sanitizeOriginalFileName(file?.fileName);
    const verdict = validatePersonalizationFile(file);
    if (!verdict.ok) {
      rejected.push({ originalFileName, reason: verdict.reason });
      continue;
    }

    const mimeType = verdict.mimeType;
    const fileName = buildStoredFileName(mimeType, nextToken());
    const resource = resourceFor(mimeType);

    const staged = await deps.graphql(STAGED_UPLOADS_CREATE, {
      input: [{ filename: fileName, mimeType, resource: resource.staged, httpMethod: "POST", fileSize: String(file.bytes.length) }],
    });
    const stagedError = firstUserError(staged, "stagedUploadsCreate");
    if (stagedError) {
      rejected.push({ originalFileName, reason: stagedError });
      continue;
    }

    const target = staged?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl) {
      rejected.push({ originalFileName, reason: "Upload target unavailable." });
      continue;
    }

    await deps.uploadBytes(
      { url: String(target.url), parameters: Array.isArray(target.parameters) ? target.parameters : [] },
      { fileName, mimeType, bytes: file.bytes },
    );

    const created = await deps.graphql(FILE_CREATE, {
      files: [{ originalSource: String(target.resourceUrl), contentType: resource.content, filename: fileName }],
    });
    const createError = firstUserError(created, "fileCreate");
    if (createError) {
      rejected.push({ originalFileName, reason: createError });
      continue;
    }

    const createdFile = created?.data?.fileCreate?.files?.[0];
    const assetId = String(createdFile?.id || "");
    if (!assetId) {
      rejected.push({ originalFileName, reason: "Shopify did not return a file id." });
      continue;
    }

    const resolved = await resolveFileWhenReady(deps, assetId);

    assets.push({
      assetId,
      fileName,
      originalFileName,
      // Still-processing files keep an empty URL; the id is the durable identity
      // and later phases can resolve the URL again before production needs it.
      fileUrl: resolved.ok ? resolved.fileUrl : "",
      mimeType,
      byteSize: file.bytes.length,
      assetRole: PERSONALIZATION_ASSET_ROLE,
    });
  }

  return { assets, rejected };
}

/* ------------------------------------------------------------------ *
 * Admin transport
 * ------------------------------------------------------------------ */

/**
 * Matches the existing app-proxy pattern: the admin token comes only from an
 * authenticated session and never leaves server code.
 */
export function createAdminGraphql(shop: string, accessToken: string): GraphqlFn {
  return async (query, variables) => {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  };
}

/** Transfers bytes to the staged target. Nothing is written to local disk. */
export const uploadBytesToStagedTarget: UploadBytesFn = async (target, file) => {
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append("file", new Blob([file.bytes as unknown as BlobPart], { type: file.mimeType }), file.fileName);
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Staged upload failed with status ${res.status}`);
};
