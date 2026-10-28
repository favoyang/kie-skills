import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { KieError, kieRequest } from "./http.js";

/**
 * Input files are uploaded to a different host than generation, using the same
 * bearer token. Uploaded files are deleted after 24h, so metadata records the
 * local source path rather than relying on the returned URL.
 */
export const uploadBase = "https://kieai.redpandaai.co";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".tiff"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv"]);

const MEDIA_FIELD = /(image|img|photo|picture|video|audio|file|url|asset|media|frame)/i;

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

export const defaultMaxBase64Bytes = 10 * 1024 * 1024;

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

export function mediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

export function uploadPathFor(kind) {
  if (kind === "image") return "images/user-uploads";
  if (kind === "audio") return "audio/user-uploads";
  if (kind === "video") return "video/user-uploads";
  return "files/user-uploads";
}

function looksLikePath(value) {
  return /^[.~/]/.test(value) || value.includes("/") || value.includes("\\") || mediaKind(value) !== null;
}

function stripFileScheme(value) {
  return value.startsWith("file:") ? value.slice("file:".length) : value;
}

async function classify({ field, value, index, cwd }) {
  if (isHttpUrl(value)) return null;
  if (!looksLikePath(value)) return null;

  const candidate = stripFileScheme(value);
  const resolved = path.resolve(cwd, candidate);
  let info = null;
  try {
    info = await stat(resolved);
  } catch {
    return { error: `${field}${index === undefined ? "" : `[${index}]`} looks like a local path but the file does not exist: ${value}` };
  }
  if (!info.isFile()) {
    return { error: `${field}${index === undefined ? "" : `[${index}]`} is a directory, not a file: ${value}` };
  }
  if (!MEDIA_FIELD.test(field)) {
    return {
      error: `${field}${index === undefined ? "" : `[${index}]`} is a local file but the field does not look like a media reference; `
        + `pass the remote URL instead, or rename the field mapping explicitly with --upload`,
    };
  }
  const kind = mediaKind(resolved);
  if (!kind) {
    return { error: `${field}${index === undefined ? "" : `[${index}]`} has an unsupported file type: ${value}` };
  }
  return {
    upload: {
      field,
      index,
      sourcePath: resolved,
      sourceRelative: path.relative(cwd, resolved),
      fileName: path.basename(resolved),
      bytes: info.size,
      kind,
      uploadPath: uploadPathFor(kind),
    },
  };
}

/**
 * Find local file paths in `input` and turn them into upload records.
 * HTTP(S) values are always passed through untouched.
 */
export async function detectUploads(input, { cwd = process.cwd(), fields = null } = {}) {
  const uploads = [];
  const errors = [];
  for (const [field, value] of Object.entries(input)) {
    if (fields && !fields.includes(field)) continue;
    if (typeof value === "string") {
      const result = await classify({ field, value, cwd });
      if (result?.error) errors.push(result.error);
      else if (result?.upload) uploads.push(result.upload);
    } else if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        if (typeof entry !== "string") continue;
        const result = await classify({ field, value: entry, index, cwd });
        if (result?.error) errors.push(result.error);
        else if (result?.upload) uploads.push(result.upload);
      }
    }
  }
  return { uploads, errors };
}

/** Build upload records for an explicit `--upload field=path` mapping. */
export async function explicitUploads(mapping, { cwd = process.cwd() } = {}) {
  const uploads = [];
  const errors = [];
  for (const [field, rawPath] of Object.entries(mapping)) {
    const resolved = path.resolve(cwd, stripFileScheme(String(rawPath)));
    let info;
    try {
      info = await stat(resolved);
    } catch {
      errors.push(`--upload ${field}: file not found: ${rawPath}`);
      continue;
    }
    const kind = mediaKind(resolved);
    if (!kind) {
      errors.push(`--upload ${field}: unsupported file type: ${rawPath}`);
      continue;
    }
    uploads.push({
      field,
      index: undefined,
      sourcePath: resolved,
      sourceRelative: path.relative(cwd, resolved),
      fileName: path.basename(resolved),
      bytes: info.size,
      kind,
      uploadPath: uploadPathFor(kind),
    });
  }
  return { uploads, errors };
}

async function uploadOne(upload, { apiKey, fetchFn, maxBase64Bytes }) {
  const data = await readFile(upload.sourcePath);
  const mimeType = MIME[path.extname(upload.sourcePath).toLowerCase()] ?? "application/octet-stream";

  let response;
  if (data.byteLength <= maxBase64Bytes) {
    response = await kieRequest(fetchFn, {
      method: "POST",
      url: `${uploadBase}/api/file-base64-upload`,
      apiKey,
      payload: {
        base64Data: data.toString("base64"),
        uploadPath: upload.uploadPath,
        fileName: upload.fileName,
      },
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([data], { type: mimeType }), upload.fileName);
    form.append("uploadPath", upload.uploadPath);
    form.append("fileName", upload.fileName);
    response = await kieRequest(fetchFn, {
      method: "POST",
      url: `${uploadBase}/api/file-stream-upload`,
      apiKey,
      formData: form,
    });
  }

  const downloadUrl = response?.data?.downloadUrl;
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) {
    throw new KieError(`upload of ${upload.fileName} did not return data.downloadUrl`);
  }
  return {
    field: upload.field,
    index: upload.index,
    sourceRelative: upload.sourceRelative,
    fileName: upload.fileName,
    filePath: response?.data?.filePath ?? null,
    bytes: data.byteLength,
    kind: upload.kind,
    transport: data.byteLength <= maxBase64Bytes ? "base64" : "stream",
    downloadUrl,
  };
}

export async function performUploads(uploads, { apiKey, fetchFn = fetch, maxBase64Bytes = defaultMaxBase64Bytes, log = () => {} } = {}) {
  const results = [];
  for (const upload of uploads) {
    log(`uploading  ${upload.sourceRelative} -> ${upload.uploadPath}`);
    results.push(await uploadOne(upload, { apiKey, fetchFn, maxBase64Bytes }));
  }
  return results;
}

export function applyUploads(input, results) {
  const next = structuredClone(input);
  for (const result of results) {
    if (result.index === undefined) next[result.field] = result.downloadUrl;
    else if (Array.isArray(next[result.field])) next[result.field][result.index] = result.downloadUrl;
  }
  return next;
}

/** Metadata-safe view: no upload URL, just enough to reproduce the upload. */
export function uploadRecords(results) {
  return results.map(({ downloadUrl: _downloadUrl, ...rest }) => ({ ...rest, expiresAfterHours: 24 }));
}
