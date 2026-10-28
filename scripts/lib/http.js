import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export class KieError extends Error {
  constructor(message, { code = null, url = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "KieError";
    this.code = code;
    this.url = url;
  }
}

/**
 * Strip query strings before putting a URL in a message. Query strings can carry
 * signed parameters on some KIE endpoints, and logs must stay redacted.
 */
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

function describeFailure(parsed, text) {
  if (parsed && typeof parsed === "object") {
    const msg = parsed.msg ?? parsed.message ?? parsed.errorMessage;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return text.slice(0, 300);
}

/**
 * KIE answers with HTTP 200 even when the request failed; the authoritative
 * status is the `code` field in the body. Checking only `response.ok` silently
 * treats a 401 or 402 as success.
 */
export async function kieRequest(fetchFn, { method = "GET", url, apiKey, payload, formData } = {}) {
  if (!apiKey) throw new KieError("KIE_API_KEY is not set");
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  let body;
  if (formData !== undefined) {
    body = formData;
  } else if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetchFn(url, { method, headers, body });
  } catch (error) {
    throw new KieError(`network error calling ${safeUrl(url)}: ${error.message}`, {
      url: safeUrl(url),
      cause: error,
    });
  }

  const text = await response.text();
  let parsed = null;
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new KieError(
        `non-JSON response from ${safeUrl(url)} (HTTP ${response.status})`,
        { url: safeUrl(url), cause: error },
      );
    }
  }

  if (!response.ok) {
    throw new KieError(
      `HTTP ${response.status} from ${safeUrl(url)}: ${describeFailure(parsed, text)}`,
      { url: safeUrl(url), code: parsed?.code ?? null },
    );
  }

  if (parsed && typeof parsed === "object" && typeof parsed.code === "number" && parsed.code !== 200) {
    throw new KieError(
      `KIE code ${parsed.code} from ${safeUrl(url)}: ${parsed.msg ?? "no message"}`,
      { url: safeUrl(url), code: parsed.code },
    );
  }

  return parsed;
}

const contentTypes = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/**
 * Result URLs are pre-signed: sending an Authorization header to them is
 * unnecessary and would leak the key to the storage host.
 */
export async function downloadToFile(fetchFn, url, outputBase) {
  let response;
  try {
    response = await fetchFn(url, { headers: { "User-Agent": "kie-skills/1.0" } });
  } catch (error) {
    throw new KieError(`network error downloading ${safeUrl(url)}: ${error.message}`, {
      url: safeUrl(url),
      cause: error,
    });
  }
  if (!response.ok) {
    throw new KieError(`HTTP ${response.status} downloading ${safeUrl(url)}`, { url: safeUrl(url) });
  }
  const body = Buffer.from(await response.arrayBuffer());
  const outputPath = `${outputBase}${extensionFor(response.headers.get("content-type"), url)}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body);
  return outputPath;
}

export function extensionFor(contentTypeHeader, sourceUrl) {
  let urlSuffix = "";
  try {
    urlSuffix = path.extname(new URL(sourceUrl).pathname);
  } catch {
    urlSuffix = path.extname(String(sourceUrl).split("?")[0]);
  }
  if (urlSuffix && urlSuffix.length <= 8) return urlSuffix;
  const mediaType = String(contentTypeHeader ?? "").split(";")[0].trim().toLowerCase();
  return contentTypes[mediaType] ?? ".bin";
}
