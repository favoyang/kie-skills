#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultCacheDir,
  defaultStoreDir,
  loadConfig,
  projectConfigPath,
  projectDir,
  projectIdentity,
  resolveMetadataDir,
  resolveOutDir,
  resolveProject,
  skillRoot,
  storeMetadataDir,
} from "./lib/config.js";
import { fetchBalance, loadCatalog, loadSchema } from "./lib/discovery.js";
import { inputContract } from "./lib/schema.js";
import { findModel } from "./lib/policy.js";
import { planRun, runModel, summarizeCatalog } from "./lib/run.js";
import { readSpend, summarizeSpend } from "./lib/spend.js";
import { checkDashboard, createDashboardServer } from "./lib/dashboard.js";
import { formatCredits } from "./lib/format.js";
import { KieError } from "./lib/http.js";
import { importRuns } from "./lib/import.js";
import { installService, serviceStatus, uninstallService } from "./lib/service.js";

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const equals = raw.indexOf("=");
    if (equals !== -1) {
      setFlag(flags, raw.slice(0, equals), raw.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      setFlag(flags, raw, true);
      continue;
    }
    setFlag(flags, raw, next);
    index += 1;
  }
  return { positionals, flags };
}

function setFlag(flags, key, value) {
  if (!(key in flags)) {
    flags[key] = value;
    return;
  }
  flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
}

async function readInput(flagValue) {
  if (!flagValue) throw new KieError('an --input JSON object is required, e.g. --input \'{"prompt":"a red mug"}\'');
  const raw = String(flagValue).startsWith("@")
    ? await readFile(String(flagValue).slice(1), "utf8")
    : String(flagValue);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new KieError(`--input is not valid JSON: ${error.message}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KieError("--input must be a JSON object");
  }
  return parsed;
}

function apiKeyFromEnv() {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new KieError("KIE_API_KEY is not set");
  }
  return key;
}

/** Repeatable: --upload image_url=./a.png --upload video_url=./b.mp4 */
export function uploadMap(value) {
  if (value === undefined || value === true) return null;
  const entries = Array.isArray(value) ? value : [value];
  const mapping = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index === -1) throw new KieError(`--upload expects field=path, got: ${entry}`);
    mapping[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return mapping;
}

function printModels(rows, { json }) {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const allowed = rows.filter((row) => row.allowed);
  const blocked = rows.filter((row) => !row.allowed);
  console.log(`allowed: ${allowed.length}   blocked: ${blocked.length}`);
  if (allowed.length > 0) {
    console.log("\nALLOWED");
    for (const row of allowed) {
      console.log(`  ${row.model}  [${row.family}]${row.pricingDesc ? `  ${row.pricingDesc.split("\n")[0]}` : ""}`);
    }
  }
  if (blocked.length > 0) {
    console.log("\nBLOCKED");
    for (const row of blocked) {
      console.log(`  ${row.model}  [${row.family ?? "unmapped"}]  ${row.reason}`);
    }
  }
}

function sharedFlags(flags) {
  return {
    cacheDir: flags["cache-dir"] ? path.resolve(String(flags["cache-dir"])) : defaultCacheDir(),
    refresh: flags.refresh === true,
    maxCredits: flags["max-credits"] !== undefined ? Number(flags["max-credits"]) : null,
  };
}

async function probeDashboard(healthUrl) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.app === "kie-dashboard" ? body : null;
  } catch {
    return null;
  }
}

async function waitForDashboard(base, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await probeDashboard(`${base}/api/health`);
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function openUrl(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  await new Promise((resolve) => {
    execFile(command, args, () => resolve());
  });
}

function dashboardUrl(host, port) {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  return `http://${shown}:${port}`;
}

async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  const target = positionals[1];
  const json = flags.json === true;
  const { cacheDir, refresh, maxCredits } = sharedFlags(flags);
  if (flags.project) process.env.KIE_PROJECT_DIR = path.resolve(String(flags.project));
  const config = await loadConfig({ file: flags.config ? path.resolve(String(flags.config)) : projectConfigPath() });

  switch (command) {
    case "models": {
      const apiKey = apiKeyFromEnv();
      const catalog = await loadCatalog({ apiKey, cacheDir, refresh });
      const rows = summarizeCatalog(catalog.models, config, {
        family: flags.family ? String(flags.family) : null,
        query: flags.q ? String(flags.q) : null,
      });
      printModels(rows, { json });
      console.error(`\ncatalog: ${catalog.total} models, fetched ${catalog.fetchedAt}, source=${catalog.source}${catalog.stale ? " (stale)" : ""}`);
      console.error(`families: allowed=${config.allowedFamilies.join(",")}  blocked=${Object.keys(config.familyTaskTypes).filter((f) => !config.allowedFamilies.includes(f)).join(",")}`);
      return 0;
    }

    case "schema": {
      if (!target) throw new KieError("usage: kie schema <model>");
      const apiKey = apiKeyFromEnv();
      const schema = await loadSchema(target, { apiKey, cacheDir, refresh });
      const contract = inputContract(schema.openapi);
      if (json) {
        console.log(JSON.stringify({
          model: target,
          route: contract.route,
          method: contract.method,
          taskBased: contract.taskBased,
          inputSchema: contract.inputSchema,
          oneOf: contract.oneOf,
        }, null, 2));
        return 0;
      }
      console.log(`model      ${target}`);
      console.log(`route      ${contract.method.toUpperCase()} ${contract.route}${contract.taskBased ? "" : "  (synchronous: no polling)"}`);
      console.log(`body       ${contract.bodyProperties.join(", ")} (required: ${contract.bodyRequired.join(", ") || "none"})`);
      if (contract.oneOf) {
        contract.oneOf.forEach((branch, index) => {
          console.log(`shape ${index + 1}   required: ${branch.required.join(", ") || "none"}`);
          console.log(`           props: ${branch.properties.join(", ")}`);
        });
      } else {
        console.log(`input      required: ${contract.inputRequired.join(", ") || "none"}`);
        for (const [key, property] of Object.entries(contract.inputSchema.properties ?? {})) {
          const extras = [];
          if (property.type) extras.push(property.type);
          if (Array.isArray(property.enum)) extras.push(`enum: ${property.enum.map((value) => JSON.stringify(value)).join("|")}`);
          if (property.default !== undefined) extras.push(`default: ${JSON.stringify(property.default)}`);
          const suffix = extras.length > 0 ? `  (${extras.join(", ")})` : "";
          const description = String(property.description ?? "").split("\n")[0].slice(0, 80);
          console.log(`  ${key}${suffix}${description ? `  ${description}` : ""}`);
        }
      }
      return 0;
    }

    case "price": {
      if (!target) throw new KieError("usage: kie price <model>");
      const apiKey = apiKeyFromEnv();
      const catalog = await loadCatalog({ apiKey, cacheDir, refresh });
      const { entry, suggestions } = findModel(catalog.models, target);
      if (!entry) {
        throw new KieError(`model ${target} is not in the catalog${suggestions.length ? `; did you mean: ${suggestions.join(", ")}` : ""}`);
      }
      console.log(`${entry.model}  [${(entry.taskType ?? []).join(", ")}]`);
      console.log(entry.pricingDesc ?? "no pricing description advertised");
      return 0;
    }

    case "balance": {
      const apiKey = apiKeyFromEnv();
      const balance = await fetchBalance({ apiKey });
      if (json) {
        console.log(JSON.stringify({ balance, floor: config.minBalance ?? 0 }, null, 2));
        return 0;
      }
      console.log(formatCredits(balance));
      console.log(`floor      ${config.minBalance ?? 0} credits`);
      return 0;
    }

    case "plan": {
      if (!target) throw new KieError("usage: kie plan <model> --input '<json>'");
      const apiKey = apiKeyFromEnv();
      const input = await readInput(flags.input);
      const plan = await planRun({ model: target, input, apiKey, cacheDir, config, refresh, maxCredits, uploads: uploadMap(flags.upload) });
      if (json) {
        console.log(JSON.stringify({
          model: plan.model,
          family: plan.verdict.family,
          allowed: plan.verdict.allowed,
          route: plan.contract.route,
          balance: plan.balance,
          estimate: plan.estimate,
          warnings: plan.warnings,
          input: plan.input,
        }, null, 2));
        return 0;
      }
      console.log(`ok         ${plan.model} [${plan.verdict.family}]`);
      console.log(`project    ${projectDir()} (${resolveProject().source})`);
      console.log(`route      ${plan.contract.route}`);
      console.log(`price      ${plan.entry.pricingDesc?.split("\n")[0] ?? "not advertised"}${plan.estimate === null ? "" : `  [max parsed: ${formatCredits(plan.estimate)}]`}`);
      console.log(`balance    ${formatCredits(plan.balance)}`);
      console.log(`output     ${resolveOutDir({ flagValue: flags.out ? String(flags.out) : null })}`);
      for (const upload of plan.uploads) {
        console.log(`upload     ${upload.field} <- ${upload.sourceRelative} (${upload.bytes} bytes, ${upload.kind})`);
      }
      for (const warning of plan.warnings) console.log(`warning: ${warning}`);
      console.log("dry run: nothing submitted");
      return 0;
    }

    case "run": {
      if (!target) throw new KieError("usage: kie run <model> --input '<json>'");
      const apiKey = apiKeyFromEnv();
      const input = await readInput(flags.input);
      const result = await runModel({
        model: target,
        input,
        apiKey,
        cacheDir,
        config,
        refresh,
        maxCredits,
        timeoutSeconds: flags.timeout ? Number(flags.timeout) : 900,
        intervalSeconds: flags.interval ? Number(flags.interval) : 3,
        outputRoot: flags.out ? String(flags.out) : null,
        uploads: uploadMap(flags.upload),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      const port = Number(process.env.PORT ?? 4173);
      if (await probeDashboard(`http://127.0.0.1:${port}/api/health`)) {
        console.log(`dashboard  http://127.0.0.1:${port}/item?task=${result.taskId}`);
      }
      return 0;
    }

    case "spend": {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const since = flags.today
        ? dayStart.getTime()
        : flags.month
          ? Date.parse(`${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`)
          : null;
      const outDir = resolveOutDir({ flagValue: flags.out ? String(flags.out) : null });
      const directories = flags["metadata-dir"]
        ? [path.resolve(String(flags["metadata-dir"]))]
        : [resolveMetadataDir({ outDir })];
      const rows = await readSpend({ directories, since });
      const summary = summarizeSpend(rows);
      if (json) {
        console.log(JSON.stringify({ summary, rows }, null, 2));
        return 0;
      }
      console.log(`runs       ${summary.runs}`);
      console.log(`consumed   ${formatCredits(summary.consumed)}`);
      if (summary.estimated > 0) {
        console.log(`estimated  ${formatCredits(summary.estimated)} (${summary.unreported} runs without reported cost)`);
      }
      if (summary.failed > 0) console.log(`failed     ${summary.failed}`);
      const models = Object.entries(summary.byModel)
        .sort((a, b) => (b[1].consumed + b[1].estimated) - (a[1].consumed + a[1].estimated));
      if (models.length > 0) {
        console.log("");
        for (const [model, stats] of models) {
          console.log(`  ${model}  ${stats.runs} run(s)  ${formatCredits(stats.consumed + stats.estimated)}`);
        }
      }
      return 0;
    }

    case "dashboard": {
      // A global view: the store, not whatever project happens to be the cwd.
      const storeDir = flags.out ? path.resolve(String(flags.out)) : defaultStoreDir();
      const context = {
        storeDir,
        projectDir: storeDir,
        outDir: storeDir,
        metadataDir: storeMetadataDir(storeDir),
      };
      if (flags.check) {
        const count = await checkDashboard(context);
        console.log(`dashboard check ok: ${count} item(s) from ${context.metadataDir}`);
        return 0;
      }
      const port = flags.port ? Number(flags.port) : Number(process.env.PORT ?? 4173);
      const host = flags.host ? String(flags.host) : "127.0.0.1";
      const url = dashboardUrl(host, port);

      const already = await probeDashboard(`http://127.0.0.1:${port}/api/health`);
      if (already) {
        console.log(`KIE dashboard already running: ${url}`);
        console.log(`store: ${already.storeDir} (${already.runs} run(s))`);
        if (flags.open) await openUrl(url);
        return 0;
      }

      const server = createDashboardServer(context);
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
        });
      } catch (error) {
        if (error?.code === "EADDRINUSE") {
          throw new KieError(`port ${port} is already in use by something that is not a KIE dashboard`);
        }
        throw error;
      }
      console.log(`KIE dashboard: ${url}`);
      console.log(`store: ${context.storeDir}`);
      if (host === "0.0.0.0") console.log("note: bound to all interfaces; the dashboard has no authentication");
      if (flags.open) await openUrl(url);
      process.on("SIGINT", () => server.close(() => process.exit(0)));
      await new Promise(() => {});
      return 0;
    }

    case "import": {
      const sources = positionals.slice(1);
      if (sources.length === 0) throw new KieError("usage: kie import <dir> [dir...]");
      const storeDir = flags.store ? path.resolve(String(flags.store)) : defaultStoreDir();
      const summary = await importRuns({ sources, storeDir, log: json ? () => {} : console.log });
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      console.log("");
      console.log(`imported   ${summary.imported}`);
      if (summary.skipped > 0) console.log(`skipped    ${summary.skipped} (already in the store)`);
      if (summary.broken > 0) console.log(`broken     ${summary.broken}`);
      if (summary.missing.length > 0) console.log(`missing    ${summary.missing.length} asset(s)`);
      console.log(`store      ${storeDir}`);
      return 0;
    }

    case "service": {
      const action = positionals[1] ?? "status";
      const cliPath = fileURLToPath(import.meta.url);
      const host = flags.host ? String(flags.host) : "0.0.0.0";
      const port = flags.port ? Number(flags.port) : 4173;
      if (action === "install") {
        await installService({ cliPath, host, port });
        const health = await waitForDashboard(dashboardUrl(host, port));
        if (health) {
          console.log(`running    ${dashboardUrl(host, port)} (${health.runs} run(s), v${health.version})`);
        } else {
          console.log("warning: the service was installed but did not answer yet; check the service log");
        }
        return 0;
      }
      if (action === "uninstall") {
        await uninstallService({ cliPath });
        return 0;
      }
      if (action === "status") {
        const status = await serviceStatus();
        const health = await probeDashboard(`http://127.0.0.1:${port}/api/health`);
        if (json) {
          console.log(JSON.stringify({ ...status, running: Boolean(health), health }, null, 2));
          return 0;
        }
        console.log(`platform   ${status.platform}`);
        console.log(`installed  ${status.installed ? "yes" : "no"}`);
        console.log(`supervisor ${status.detail}`);
        console.log(`running    ${health ? "yes" : "no"}`);
        if (health) console.log(`url        ${dashboardUrl(host, port)} (${health.runs} run(s), v${health.version})`);
        return 0;
      }
      throw new KieError("usage: kie service install|uninstall|status");
    }

    case "info": {
      const outDir = resolveOutDir();
      const identity = projectIdentity();
      const payload = {
        projectDir: projectDir(),
        projectSource: resolveProject().source,
        projectName: identity.name,
        gitCommonDir: identity.git_common_dir,
        storeDir: defaultStoreDir(),
        skillRoot,
        cacheDir,
        outDir,
        metadataDir: resolveMetadataDir({ outDir }),
        allowedFamilies: config.allowedFamilies,
        minBalance: config.minBalance ?? null,
        configSources: config.sources,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    default:
      console.log(`usage: kie <command> [options]

  models   [--family image|music|speech] [--q text] [--refresh] [--json]
  schema   <model> [--refresh] [--json]
  price    <model>
  balance  [--json]
  plan     <model> --input '<json>' [--upload FIELD=PATH] [--max-credits N] [--out DIR] [--json]
  run      <model> --input '<json>' [--upload FIELD=PATH] [--max-credits N] [--timeout s] [--interval s] [--out DIR] [--json]
  spend    [--today|--month] [--metadata-dir DIR] [--out DIR] [--json]
  dashboard [--port 4173] [--host 127.0.0.1] [--out DIR] [--check] [--open]
  import   <dir> [dir...] [--store DIR] [--json]
  service  install|uninstall|status [--host 0.0.0.0] [--port 4173]
  info     show resolved paths and policy

global options:
  --project DIR    run as if DIR were the working directory
  --out DIR        write this run under DIR instead of the shared store (one-off)

environment:
  KIE_API_KEY      required for every command that calls the API
  KIE_STORE_DIR    override the per-user artifact store
  KIE_CACHE_DIR    override the catalog/schema cache location
  KIE_PROJECT_DIR  same as --project

project config (optional, at <project>/kie.config.json):
  { "outDir": "kie-output", "allowedFamilies": ["image","music","speech"], "minBalance": 20 }`);
      return command ? 2 : 0;
  }
}

/**
 * Path-aware entry-point check. String-concatenating `file://${argv[1]}` fails on
 * Windows, where argv[1] is `C:\...` but import.meta.url is `file:///C:/...`.
 */
export function isEntryPoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof KieError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(error.stack ?? String(error));
      process.exitCode = 1;
    }
  }
}
