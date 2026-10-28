import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Two different roots, deliberately kept apart:
 *
 * - skillRoot   : where this skill is installed. Read-only. Ships defaults.
 * - projectDir  : the folder that invoked the skill. All writes land here.
 *
 * The skill is a read-only package; only the invoking project is written to.
 */
const libDir = path.dirname(fileURLToPath(import.meta.url));

export const skillRoot = path.resolve(libDir, "..", "..");
export const skillDefaultsPath = path.join(skillRoot, "config", "defaults.json");

export const apiBase = "https://api.kie.ai";
export const defaultOutDirName = "kie-output";

/**
 * The working directory is the project root unless explicitly redirected.
 * Nothing is inferred from the filesystem; `--project` and KIE_PROJECT_DIR are
 * the only overrides.
 */
export function resolveProject(start = process.cwd()) {
  if (process.env.KIE_PROJECT_DIR) {
    return { dir: path.resolve(process.env.KIE_PROJECT_DIR), source: "env" };
  }
  return { dir: path.resolve(start), source: "cwd" };
}

export function projectDir() {
  return resolveProject().dir;
}

export function projectConfigPath() {
  return path.join(projectDir(), "kie.config.json");
}

/**
 * Catalog and schema caches are machine-local discovery data. They are shared
 * across projects, never written into one, and safe to delete at any time.
 */
export function defaultCacheDir() {
  if (process.env.KIE_CACHE_DIR) return path.resolve(process.env.KIE_CACHE_DIR);
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "kie-skill");
  const home = process.env.HOME || os.homedir();
  if (home) {
    const base = process.platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : path.join(home, ".cache");
    return path.join(base, "kie-skill");
  }
  return path.join(os.tmpdir(), "kie-skill-cache");
}

export function resolveOutDir({ flagValue, config } = {}) {
  if (flagValue) return path.resolve(flagValue);
  if (process.env.KIE_OUT_DIR) return path.resolve(process.env.KIE_OUT_DIR);
  if (config?.outDir) return path.resolve(projectDir(), config.outDir);
  return path.join(projectDir(), defaultOutDirName);
}

export function resolveMetadataDir({ outDir, config } = {}) {
  if (config?.metadataDir) return path.resolve(projectDir(), config.metadataDir);
  return path.join(outDir ?? resolveOutDir({ config }), "metadata");
}

async function readJson(file, { optional = false } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

export function assertPolicyShape(policy, source) {
  if (!policy || typeof policy !== "object") throw new Error(`config at ${source} must be an object`);
  if (!Array.isArray(policy.allowedFamilies)) throw new Error(`config at ${source}: allowedFamilies must be an array`);
  if (!policy.familyTaskTypes || typeof policy.familyTaskTypes !== "object") {
    throw new Error(`config at ${source}: familyTaskTypes must be an object`);
  }
  for (const [family, types] of Object.entries(policy.familyTaskTypes)) {
    if (!Array.isArray(types)) throw new Error(`config at ${source}: familyTaskTypes.${family} must be an array`);
  }
  const unknown = policy.allowedFamilies.filter((family) => !(family in policy.familyTaskTypes));
  if (unknown.length > 0) {
    throw new Error(`config at ${source}: allowedFamilies references unknown families: ${unknown.join(", ")}`);
  }
  if (policy.minBalance !== undefined && (typeof policy.minBalance !== "number" || policy.minBalance < 0)) {
    throw new Error(`config at ${source}: minBalance must be a non-negative number`);
  }
  return policy;
}

/**
 * Precedence: bundled defaults, then the project's optional kie.config.json.
 * A project may narrow or widen allowedFamilies; it cannot remove the map itself.
 */
export async function loadConfig({ file = projectConfigPath() } = {}) {
  const defaults = assertPolicyShape(await readJson(skillDefaultsPath), skillDefaultsPath);
  const projectConfig = await readJson(file, { optional: true });
  if (!projectConfig) {
    return { ...defaults, outDir: undefined, metadataDir: undefined, sources: { defaults: skillDefaultsPath, project: null } };
  }

  const merged = {
    ...defaults,
    ...projectConfig,
    familyTaskTypes: { ...defaults.familyTaskTypes, ...(projectConfig.familyTaskTypes ?? {}) },
    sources: { defaults: skillDefaultsPath, project: file },
  };
  return assertPolicyShape(merged, file);
}
