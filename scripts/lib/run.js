import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { apiBase, defaultCacheDir, loadConfig, resolveMetadataDir, resolveOutDir } from "./config.js";
import { KieError, downloadToFile, kieRequest } from "./http.js";
import { loadCatalog, loadSchema, fetchBalance } from "./discovery.js";
import { inputContract, parseCreditEstimate, validateInput } from "./schema.js";
import { PolicyError, assertBalance, assertModelAllowed, assertWithinMaxCredits, classifyModel, findModel } from "./policy.js";
import { applyUploads, detectUploads, explicitUploads, performUploads, uploadRecords } from "./upload.js";
import { formatCredits, modelSlug, slugify, utcStamp } from "./format.js";

export const TERMINAL_SUCCESS = new Set(["success"]);
export const TERMINAL_FAILURE = new Set(["fail", "failed", "error"]);

const familyAssetDir = {
  image: "images",
  music: "audio",
  speech: "audio",
  video: "video",
};

export function isTerminal(state) {
  return TERMINAL_SUCCESS.has(state) || TERMINAL_FAILURE.has(state);
}

export function extractResultUrls(data) {
  const urls = [];

  function walk(node) {
    if (typeof node === "string") {
      if (node.startsWith("http://") || node.startsWith("https://")) {
        urls.push(node);
        return;
      }
      if (node.trim().startsWith("{") || node.trim().startsWith("[")) {
        try {
          walk(JSON.parse(node));
        } catch {
          // not JSON, ignore
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(data?.response ?? data?.resultJson ?? data);
  return [...new Set(urls)];
}

export async function pollTask({
  taskId,
  apiKey,
  fetchFn = fetch,
  timeoutSeconds = 900,
  intervalSeconds = 3,
  maxIntervalSeconds = 15,
  sleep,
  log = console.log,
}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutSeconds * 1000;
  let intervalMs = intervalSeconds * 1000;
  let last = null;

  while (Date.now() < deadline) {
    const body = await kieRequest(fetchFn, {
      url: `${apiBase}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      apiKey,
    });
    last = body?.data ?? {};
    const state = String(last.state ?? "").toLowerCase();
    log(`task=${taskId} state=${state || "unknown"}`);
    if (isTerminal(state)) return last;
    await wait(intervalMs);
    intervalMs = Math.min(intervalMs * 1.5, maxIntervalSeconds * 1000);
  }

  throw new KieError(`timed out after ${timeoutSeconds}s waiting for task ${taskId} (last state: ${last?.state ?? "unknown"})`);
}

/**
 * Resolve everything a run needs without spending credits: catalog entry,
 * schema contract, balance, and the family verdict.
 */
export async function planRun({
  model,
  input,
  apiKey,
  fetchFn = fetch,
  cacheDir = defaultCacheDir(),
  config,
  refresh = false,
  maxCredits = null,
  uploads = null,
  cwd = process.cwd(),
} = {}) {
  if (!model) throw new KieError("a model id is required");
  if (!apiKey) throw new KieError("KIE_API_KEY is not set");

  const activeConfig = config ?? await loadConfig();
  const catalog = await loadCatalog({ apiKey, fetchFn, cacheDir, refresh });

  const { entry, suggestions } = findModel(catalog.models, model);
  if (!entry) {
    const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(", ")}` : "";
    throw new KieError(`model ${model} is not in the catalog (${catalog.total} models as of ${catalog.fetchedAt})${hint}`);
  }

  const verdict = assertModelAllowed(model, entry, activeConfig);
  const schema = await loadSchema(model, { apiKey, fetchFn, cacheDir, refresh });
  const contract = inputContract(schema.openapi);
  if (!contract.taskBased) {
    throw new PolicyError(
      `model ${model} is a synchronous (${contract.route}) model, not a task-based generation model; this runner only drives /api/v1/jobs/createTask`,
    );
  }

  const { errors, warnings } = validateInput(contract, input);
  if (errors.length > 0) {
    throw new KieError(`input rejected by the ${model} schema:\n  ${errors.join("\n  ")}`);
  }

  const uploadPlan = uploads
    ? await explicitUploads(uploads, { cwd })
    : await detectUploads(input, { cwd });
  if (uploadPlan.errors.length > 0) {
    throw new KieError(`cannot prepare input files:\n  ${uploadPlan.errors.join("\n  ")}`);
  }
  for (const upload of uploadPlan.uploads) {
    if (!contract.inputProperties.includes(upload.field)) {
      throw new KieError(`--upload ${upload.field}: the ${model} schema has no such input field (has: ${contract.inputProperties.join(", ")})`);
    }
    // Auto-detected uploads carry an index for array slots; only the explicit
    // field=path form is ambiguous about which element of an array to replace.
    const property = contract.inputSchema.properties?.[upload.field];
    if (uploads && property?.type === "array") {
      throw new KieError(`--upload ${upload.field}: this field is an array; pass local paths inside --input instead`);
    }
  }

  const balance = await fetchBalance({ apiKey, fetchFn });
  assertBalance(balance, activeConfig);

  const estimate = parseCreditEstimate(entry.pricingDesc);
  assertWithinMaxCredits(estimate, maxCredits, model);

  return {
    model,
    input,
    entry,
    verdict,
    contract,
    warnings,
    uploads: uploadPlan.uploads,
    balance,
    estimate,
    catalog: { total: catalog.total, fetchedAt: catalog.fetchedAt, source: catalog.source, stale: catalog.stale },
    schema: { fetchedAt: schema.fetchedAt, source: schema.source, stale: schema.stale },
    config: activeConfig,
  };
}

function metadataFor({ plan, taskId, createResponse, finalData, downloaded, balanceAfter, state, input = plan.input, uploads = [] }) {
  const consumed = typeof finalData?.creditsConsumed === "number" ? finalData.creditsConsumed : null;
  return {
    timestamp: new Date().toISOString(),
    provider: "KIE.ai",
    api_family: plan.verdict.family,
    mode: plan.model,
    state,
    task_id: taskId,
    request: { model: plan.model, input },
    create_response: createResponse,
    final_response: { data: finalData ?? {} },
    credits_consumed: consumed,
    credits_estimate: plan.estimate,
    cost_source: consumed === null ? "unavailable" : "recordInfo.creditsConsumed",
    pricing_desc: plan.entry.pricingDesc ?? null,
    balance_before: plan.balance,
    balance_after: balanceAfter,
    uploads,
    downloaded,
    warnings: plan.warnings,
    policy: {
      allowed_families: plan.config.allowedFamilies,
      family: plan.verdict.family,
      min_balance: plan.config.minBalance ?? null,
    },
    discovery: {
      catalog_total: plan.catalog.total,
      catalog_fetched_at: plan.catalog.fetchedAt,
      catalog_source: plan.catalog.source,
      schema_fetched_at: plan.schema.fetchedAt,
    },
    secret_handling: "KIE_API_KEY read from the environment; this record contains no Authorization header.",
  };
}

export async function runModel({
  model,
  input,
  apiKey,
  fetchFn = fetch,
  cacheDir = defaultCacheDir(),
  config,
  refresh = false,
  maxCredits = null,
  dryRun = false,
  timeoutSeconds = 900,
  intervalSeconds = 3,
  outputRoot = null,
  metadataRoot = null,
  uploads = null,
  cwd = process.cwd(),
  maxBase64Bytes,
  sleep,
  log = console.log,
} = {}) {
  const plan = await planRun({ model, input, apiKey, fetchFn, cacheDir, config, refresh, maxCredits, uploads, cwd });
  const outDir = outputRoot ? path.resolve(outputRoot) : resolveOutDir({ config: plan.config });
  const metadataDir = metadataRoot ? path.resolve(metadataRoot) : resolveMetadataDir({ outDir, config: plan.config });

  log(`model      ${plan.model}`);
  log(`family     ${plan.verdict.family} (${plan.verdict.taskTypes.join(", ")})`);
  log(`route      ${plan.contract.route}`);
  log(`input      ${Object.keys(plan.input).join(", ") || "(empty)"}`);
  log(`price      ${plan.entry.pricingDesc ?? "not advertised"}${plan.estimate === null ? "" : `  [max parsed: ${formatCredits(plan.estimate)}]`}`);
  log(`balance    ${formatCredits(plan.balance)}`);
  for (const warning of plan.warnings) log(`warning: ${warning}`);
  for (const upload of plan.uploads) {
    log(`upload     ${upload.field} <- ${upload.sourceRelative} (${upload.bytes} bytes, ${upload.kind})`);
  }

  if (dryRun) {
    log("dry run: no task created");
    return { dryRun: true, plan, outDir, metadataDir };
  }

  let effectiveInput = plan.input;
  let uploadResults = [];
  if (plan.uploads.length > 0) {
    uploadResults = await performUploads(plan.uploads, { apiKey, fetchFn, maxBase64Bytes, log });
    effectiveInput = applyUploads(plan.input, uploadResults);
  }

  const createResponse = await kieRequest(fetchFn, {
    method: "POST",
    url: `${apiBase}/api/v1/jobs/createTask`,
    apiKey,
    payload: { model: plan.model, input: effectiveInput },
  });
  const taskId = createResponse?.data?.taskId;
  if (!taskId) {
    throw new KieError(`createTask did not return data.taskId: ${JSON.stringify(createResponse).slice(0, 300)}`);
  }
  log(`created    task=${taskId}`);

  const stamp = utcStamp();
  const slug = slugify(effectiveInput.prompt ?? plan.model, 48, modelSlug(plan.model));
  const metadataPath = path.join(metadataDir, `${stamp}-${slug}-${taskId}.metadata.json`);
  await mkdir(metadataDir, { recursive: true });

  // Written before polling so a crash or Ctrl-C mid-run still leaves a recoverable record.
  const queued = metadataFor({
    plan,
    taskId,
    createResponse,
    finalData: null,
    downloaded: [],
    balanceAfter: null,
    state: "queued",
    input: effectiveInput,
    uploads: uploadRecords(uploadResults),
  });
  await writeFile(metadataPath, JSON.stringify(queued, null, 2), "utf8");

  const finalData = await pollTask({ taskId, apiKey, fetchFn, timeoutSeconds, intervalSeconds, sleep, log });
  const state = String(finalData.state ?? "").toLowerCase();
  const urls = extractResultUrls(finalData);

  const assetDir = path.join(outDir, familyAssetDir[plan.verdict.family] ?? "other", modelSlug(plan.model));
  const downloaded = [];
  for (const [index, url] of urls.entries()) {
    const localPath = await downloadToFile(
      fetchFn,
      url,
      path.join(assetDir, `${stamp}-${slug}-${String(index + 1).padStart(2, "0")}`),
    );
    downloaded.push({ url, path: localPath });
    log(`downloaded ${localPath}`);
  }

  const consumed = typeof finalData.creditsConsumed === "number" ? finalData.creditsConsumed : null;
  const balanceAfter = consumed === null ? await fetchBalance({ apiKey, fetchFn }).catch(() => null) : null;

  const record = metadataFor({
    plan,
    taskId,
    createResponse,
    finalData,
    downloaded,
    balanceAfter,
    state,
    input: effectiveInput,
    uploads: uploadRecords(uploadResults),
  });
  await writeFile(metadataPath, JSON.stringify(record, null, 2), "utf8");
  log(`metadata   ${metadataPath}`);
  log(`cost       ${record.credits_consumed === null ? "unreported by KIE" : formatCredits(record.credits_consumed)}`);

  if (!TERMINAL_SUCCESS.has(state)) {
    const reason = finalData.failMsg ?? finalData.errorMessage ?? "no failure message";
    throw new KieError(`task ${taskId} ended in state ${state || "unknown"}: ${reason}`);
  }
  if (downloaded.length === 0) {
    throw new KieError(`task ${taskId} succeeded but no downloadable URL was found in the response`);
  }

  return {
    dryRun: false,
    taskId,
    state,
    creditsConsumed: record.credits_consumed,
    downloaded,
    metadataPath,
    outDir,
    balanceBefore: plan.balance,
    balanceAfter,
  };
}

export function summarizeCatalog(models, config, filter = {}) {
  const rows = [];
  for (const entry of models) {
    const verdict = classifyModel(entry, config);
    if (filter.family && verdict.family !== filter.family) continue;
    if (filter.query) {
      const haystack = `${entry.model} ${entry.title ?? ""} ${entry.provider ?? ""} ${(entry.taskType ?? []).join(" ")}`.toLowerCase();
      if (!haystack.includes(filter.query.toLowerCase())) continue;
    }
    rows.push({
      model: entry.model,
      family: verdict.family,
      allowed: verdict.allowed,
      reason: verdict.reason,
      taskType: entry.taskType ?? [],
      pricingDesc: entry.pricingDesc ?? null,
    });
  }
  return rows;
}
