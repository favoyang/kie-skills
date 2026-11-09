import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);

// Model schemas name image inputs inconsistently, and some config fields share
// those words. Reference fields keep an image token; config fields carry a
// config token such as image_size or image_aspect_ratio.
const IMAGE_TOKENS = new Set(["image", "images", "img", "imgs", "photo", "photos", "picture", "pictures", "pic", "pics", "mask", "masks"]);
const CONFIG_TOKENS = new Set([
  "size", "width", "height", "ratio", "aspect", "format", "quality", "count", "number",
  "seed", "steps", "strength", "weight", "scale", "style", "orientation", "prompt",
  "model", "type", "mode", "resolution", "text", "negative",
]);

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".lrc": "text/plain; charset=utf-8",
};

export function assetKind(assetPath) {
  const ext = path.extname(assetPath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

export function contentType(assetPath) {
  return CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ?? "application/octet-stream";
}

export function assetUrl(assetPath) {
  return `/asset?path=${encodeURIComponent(assetPath)}`;
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Metadata may hold project-relative or absolute paths. Accept both, but
 * never serve anything outside the output directory.
 */
export function resolveAssetPath(rawPath, { projectDir = process.cwd(), outDir } = {}) {
  if (!rawPath || !outDir) return null;
  const candidates = path.isAbsolute(rawPath)
    ? [rawPath]
    : [path.resolve(projectDir, rawPath), path.resolve(outDir, rawPath)];
  for (const candidate of candidates) {
    if (isInside(outDir, candidate)) return candidate;
  }
  return null;
}

function parseJsonish(value) {
  if (typeof value !== "string" || value.trim() === "") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asString(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function nestedRecord(value, key) {
  return objectRecord(value[key]) ?? {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}

export function deriveTimeToResponse(data) {
  const createTime = toNumber(data?.createTime);
  const completeTime = toNumber(data?.completeTime);
  if (createTime != null && completeTime != null && completeTime >= createTime) {
    return completeTime - createTime;
  }
  const costTime = toNumber(data?.costTime ?? data?.durationMs ?? data?.responseTimeMs);
  if (costTime == null) return null;
  // KIE reports costTime in seconds; large values are already milliseconds.
  return costTime < 1000 ? costTime * 1000 : costTime;
}

export function deriveState(data) {
  const raw = data?.state ?? data?.status ?? data?.successFlag;
  if (raw === 1 || raw === "1" || raw === "SUCCESS") return "success";
  if (raw === 0 || raw === "0") return "failed";
  return asString(raw, "unknown").toLowerCase();
}

function sunoData(record) {
  const finalData = record.final_response?.data ?? {};
  const entries = nestedRecord(finalData, "response").sunoData;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const parsed = objectRecord(entry);
    return parsed ? [parsed] : [];
  });
}

function firstAudioDuration(record) {
  for (const entry of sunoData(record)) {
    const duration = toNumber(entry.duration);
    if (duration != null) return duration;
  }
  return null;
}

function assetMatchesSunoAudio(asset, entry) {
  if (!asset.url) return false;
  return [entry.audioUrl, entry.sourceAudioUrl, entry.streamAudioUrl, entry.sourceStreamAudioUrl]
    .some((url) => typeof url === "string" && url === asset.url);
}

function durationForDownloadedAsset(asset, record) {
  for (const entry of sunoData(record)) {
    if (assetMatchesSunoAudio(asset, entry)) return toNumber(entry.duration);
  }
  if (asset.path && assetKind(asset.path) === "audio") return firstAudioDuration(record);
  return null;
}

function downloadedAssetsFromRecord(record) {
  return (record.downloaded ?? []).map((asset) => {
    const durationSeconds = asset.durationSeconds ?? durationForDownloadedAsset(asset, record);
    return durationSeconds == null ? { ...asset } : { ...asset, durationSeconds };
  });
}

function withoutQuery(value) {
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}

function fieldTokens(field) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function looksLikeReference(value) {
  if (/^file:/i.test(value)) return false;
  if (/^(https?:\/\/|data:image\/)/i.test(value)) return true;
  return assetKind(value) === "image";
}

/**
 * Input images are declared under names that differ per model: image_urls,
 * image_url, input_urls, maskUrl, and so on. Field names also carry config
 * values such as image_size, so an image token alone is not enough.
 */
function isImageReference(field, value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const tokens = fieldTokens(field);
  const compact = field.toLowerCase();
  const lastImage = tokens.findLastIndex((token) => IMAGE_TOKENS.has(token));
  // A config token only disqualifies a reference when it follows the image
  // token: image_size is config, style_image is a reference.
  const configAfterImage = lastImage >= 0
    && tokens.slice(lastImage + 1).some((token) => CONFIG_TOKENS.has(token));
  const compactReference = /^((images?|imgs?|photos?|pictures?|pics?|masks?)(urls?|paths?|files?)?)$/.test(compact);
  const genericMedia = /^input_?urls?$/.test(compact)
    || (tokens.length === 2 && tokens[0] === "input" && (tokens[1] === "url" || tokens[1] === "urls"));
  const imageField = (lastImage >= 0 && !configAfterImage) || compactReference;
  if (!imageField && !genericMedia) return false;
  const candidate = withoutQuery(value);
  if (!looksLikeReference(candidate)) return false;
  const kind = assetKind(candidate);
  if (kind === "audio" || kind === "video") return false;
  // Generic media fields may hold other file types, so require an image
  // extension there; extensionless URLs are usually signed image links.
  return imageField || kind === "image" || path.extname(candidate) === "";
}

function withoutReferenceFields(value) {
  if (!value || typeof value !== "object") return value;
  const rest = {};
  for (const [field, entry] of Object.entries(value)) {
    const entries = typeof entry === "string" ? [entry] : stringArray(entry);
    if (entries.length > 0 && entries.every((item) => isImageReference(field, item))) continue;
    rest[field] = entry;
  }
  return rest;
}

function referenceImagesFromInput(input, referenceFixture) {
  if (referenceFixture) return [{ path: referenceFixture }];
  const images = [];
  const seen = new Set();
  for (const [field, value] of Object.entries(input ?? {})) {
    const entries = typeof value === "string" ? [value] : stringArray(value);
    for (const entry of entries) {
      if (!isImageReference(field, entry) || seen.has(entry)) continue;
      seen.add(entry);
      images.push(/^(https?:\/\/|data:image\/)/i.test(entry) ? { url: entry } : { path: entry });
    }
  }
  return images;
}

function previewApiParam(value, referenceFixture) {
  if (!referenceFixture || !value || typeof value !== "object") return value;
  const param = { ...value };
  if ("input" in param) param.input = withoutReferenceFields(parseJsonish(param.input));
  return param;
}

export function feedItemFromRecord(metadataPath, record, { projectDir = process.cwd() } = {}) {
  const finalData = record?.final_response?.data ?? {};
  const input = record?.request?.input ?? {};
  const prompt = asString(input.prompt);
  const { prompt: _prompt, ...otherInputs } = withoutReferenceFields(input);
  const parsedParam = parseJsonish(finalData.param);
  const apiParam = previewApiParam(parsedParam, record?.reference_fixture);
  const fallbackTaskId = record?.create_response?.data?.taskId;

  const projectKey = asString(
    record?.project?.key ?? record?.project?.git_common_dir ?? record?.project?.dir,
    "",
  );
  return {
    metadataPath: path.isAbsolute(metadataPath) ? path.relative(projectDir, metadataPath) : metadataPath,
    timestamp: asString(record?.timestamp, path.basename(metadataPath).slice(0, 15)),
    provider: asString(record?.provider, "unknown provider"),
    project: {
      key: projectKey,
      name: asString(record?.project?.name, projectKey ? path.basename(projectKey) : ""),
    },
    family: asString(record?.api_family, "unknown API"),
    mode: asString(record?.mode, "unknown mode"),
    title: asString(input.title),
    model: asString(record?.request?.model ?? finalData.model, "unknown model"),
    taskId: asString(finalData.taskId ?? fallbackTaskId, "unknown task"),
    state: deriveState(finalData),
    prompt,
    otherInputs: {
      ...otherInputs,
      ...(apiParam && typeof apiParam === "object" ? { api_param: apiParam } : {}),
    },
    creditsConsumed: record?.credits_consumed
      ?? record?.credits_estimated
      ?? record?.credits_estimate
      ?? finalData.creditsConsumed
      ?? finalData.credits
      ?? null,
    timeToResponseMs: deriveTimeToResponse(finalData),
    retryTime: finalData.retryTime ?? finalData.retryCount ?? finalData.retryTimes ?? null,
    referenceImages: referenceImagesFromInput(input, record?.reference_fixture),
    downloaded: downloadedAssetsFromRecord(record ?? {}),
    textAssets: record?.text_assets ?? [],
  };
}

export async function readFeedItems({ metadataDir, projectDir = process.cwd() } = {}) {
  let names = [];
  try {
    names = await readdir(metadataDir);
  } catch {
    return [];
  }

  const items = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const metadataPath = path.join(metadataDir, name);
    try {
      const record = JSON.parse(await readFile(metadataPath, "utf8"));
      items.push(feedItemFromRecord(metadataPath, record, { projectDir }));
    } catch (error) {
      items.push({
        metadataPath: path.relative(projectDir, metadataPath),
        timestamp: name.slice(0, 15),
        provider: "metadata parse error",
        family: "unknown API",
        mode: "error",
        title: "",
        model: "unknown model",
        taskId: "unknown task",
        state: "error",
        prompt: error instanceof Error ? error.message : String(error),
        otherInputs: {},
        creditsConsumed: null,
        timeToResponseMs: null,
        retryTime: null,
        referenceImages: [],
        downloaded: [],
        textAssets: [],
      });
    }
  }

  return items.sort((a, b) => {
    const left = Date.parse(a.timestamp);
    const right = Date.parse(b.timestamp);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}
