import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { apiBase, defaultCacheDir } from "./config.js";
import { KieError, kieRequest } from "./http.js";

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic write so two concurrent runs cannot leave a truncated cache file. */
async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

function cacheAgeMs(record, now) {
  const fetchedAt = record?.fetchedAt ? Date.parse(record.fetchedAt) : Number.NaN;
  return Number.isFinite(fetchedAt) ? now - fetchedAt : Number.POSITIVE_INFINITY;
}

/**
 * The catalog is the only source of model names. Cached for 24h; a failed
 * refresh falls back to the stale copy because a stale catalog is still gated
 * by the same family rules, and blocking every run on a transient outage is worse.
 */
export async function loadCatalog({
  apiKey,
  fetchFn = fetch,
  cacheDir = defaultCacheDir(),
  ttlMs = CATALOG_TTL_MS,
  refresh = false,
  now = Date.now(),
  log = (message) => console.error(message),
} = {}) {
  const file = path.join(cacheDir, "catalog.json");
  const cached = await readJsonFile(file);
  const age = cacheAgeMs(cached, now);

  if (cached && Array.isArray(cached.models) && !refresh && age < ttlMs) {
    return { models: cached.models, total: cached.total ?? cached.models.length, fetchedAt: cached.fetchedAt, stale: false, source: "cache" };
  }

  const url = `${apiBase}/api/v1/models`;
  try {
    const body = await kieRequest(fetchFn, { url, apiKey });
    const models = body?.data?.models;
    if (!Array.isArray(models)) {
      throw new KieError("catalog response did not include data.models", { url });
    }
    const record = {
      fetchedAt: new Date(now).toISOString(),
      total: body.data.total ?? models.length,
      models,
    };
    await writeJsonAtomic(file, record);
    return { models, total: record.total, fetchedAt: record.fetchedAt, stale: false, source: "network" };
  } catch (error) {
    if (cached && Array.isArray(cached.models)) {
      log(`warning: catalog refresh failed (${error.message}); using cached catalog from ${cached.fetchedAt}`);
      return { models: cached.models, total: cached.total ?? cached.models.length, fetchedAt: cached.fetchedAt, stale: true, source: "stale-cache" };
    }
    throw error;
  }
}

function schemaCacheFile(cacheDir, model) {
  return path.join(cacheDir, "schemas", `${String(model).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

/**
 * Model ids are two-segment paths (`wan/v2-2-t2v`). Slashes must stay literal:
 * encoding them returns 404.
 */
export async function loadSchema(model, {
  apiKey,
  fetchFn = fetch,
  cacheDir = defaultCacheDir(),
  ttlMs = CATALOG_TTL_MS,
  refresh = false,
  now = Date.now(),
  log = (message) => console.error(message),
} = {}) {
  if (!model) throw new KieError("loadSchema requires a model id");
  const file = schemaCacheFile(cacheDir, model);
  const cached = await readJsonFile(file);
  const age = cacheAgeMs(cached, now);

  if (cached?.openapi && !refresh && age < ttlMs) {
    return { model, openapi: cached.openapi, fetchedAt: cached.fetchedAt, stale: false, source: "cache" };
  }

  const url = `${apiBase}/api/v1/models/${model}/schema`;
  try {
    const body = await kieRequest(fetchFn, { url, apiKey });
    const openapi = body?.data?.openapi;
    if (!openapi || typeof openapi !== "object") {
      throw new KieError(
        `model ${model} is in the catalog but has no published schema yet (data.openapi is ${openapi === null ? "null" : "missing"})`,
        { url },
      );
    }
    const record = { fetchedAt: new Date(now).toISOString(), model, openapi };
    await writeJsonAtomic(file, record);
    return { model, openapi, fetchedAt: record.fetchedAt, stale: false, source: "network" };
  } catch (error) {
    if (cached?.openapi) {
      log(`warning: schema refresh failed (${error.message}); using cached schema from ${cached.fetchedAt}`);
      return { model, openapi: cached.openapi, fetchedAt: cached.fetchedAt, stale: true, source: "stale-cache" };
    }
    throw error;
  }
}

export async function fetchBalance({ apiKey, fetchFn = fetch } = {}) {
  const body = await kieRequest(fetchFn, { url: `${apiBase}/api/v1/chat/credit`, apiKey });
  const value = body?.data;
  if (typeof value !== "number") throw new KieError("balance response did not include a numeric data field");
  return value;
}
