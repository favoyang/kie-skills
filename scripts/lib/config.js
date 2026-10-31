import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Three different roots, deliberately kept apart:
 *
 * - skillRoot   : where this skill is installed. Read-only. Ships defaults.
 * - storeDir    : one per-user artifact store shared by every project.
 * - projectDir  : the folder that invoked the skill. Nothing is written here
 *                 unless a project config or flag asks for it.
 *
 * Runs used to land in `<project>/kie-output`, which breaks under git
 * worktrees: the directory is git-ignored, so it cannot be merged back and it
 * disappears with the worktree. The store fixes that by owning the artifacts.
 */
const libDir = path.dirname(fileURLToPath(import.meta.url));

export const skillRoot = path.resolve(libDir, "..", "..");
export const skillDefaultsPath = path.join(skillRoot, "config", "defaults.json");

export const apiBase = "https://api.kie.ai";
export const defaultOutDirName = "kie-output";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * One store per user, never a shared system directory: the dashboard is a
 * user-level service and every run must be writable by the invoking user.
 */
export function defaultStoreDir() {
  if (process.env.KIE_STORE_DIR) return path.resolve(process.env.KIE_STORE_DIR);
  const home = homeDir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "kie");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(local, "kie");
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "kie");
  return path.join(home, ".local", "share", "kie");
}

export function storeMetadataDir(storeDir = defaultStoreDir()) {
  return path.join(storeDir, "metadata");
}

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

function gitMarker(start) {
  let current = path.resolve(start);
  for (;;) {
    const marker = path.join(current, ".git");
    if (existsSync(marker)) return { root: current, marker };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The git common dir is what identifies a repository, not the checkout path.
 * In a linked worktree `.git` is a file pointing at
 * `<repo>/.git/worktrees/<name>`, and `commondir` points back at `<repo>/.git`.
 * Using the worktree path instead would split one repository into one project
 * per worktree.
 */
export function gitIdentity(start = process.cwd()) {
  const found = gitMarker(start);
  if (!found) return null;

  let commonDir = found.marker;
  if (!statSync(found.marker).isDirectory()) {
    const text = readFileSync(found.marker, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match) return null;
    const gitDir = path.resolve(found.root, match[1].trim());
    const commonFile = path.join(gitDir, "commondir");
    commonDir = existsSync(commonFile)
      ? path.resolve(gitDir, readFileSync(commonFile, "utf8").trim())
      : gitDir;
  }

  const repoRoot = path.dirname(commonDir);
  const name = path.basename(repoRoot) || path.basename(commonDir).replace(/\.git$/, "");
  return { root: found.root, commonDir, name };
}

/**
 * What a run records about where it came from. `key` is the aggregation key:
 * one repository is one project, no matter how many worktrees it has.
 */
export function projectIdentityAt(dir, { source = "cwd", cwd = dir } = {}) {
  const absolute = path.resolve(dir);
  const git = gitIdentity(absolute);
  return {
    dir: absolute,
    source,
    cwd: path.resolve(cwd),
    root: git?.root ?? null,
    git_common_dir: git?.commonDir ?? null,
    name: git?.name ?? path.basename(absolute),
    key: git?.commonDir ?? absolute,
  };
}

export function projectIdentity(start = process.cwd()) {
  const project = resolveProject(start);
  return projectIdentityAt(project.dir, { source: project.source, cwd: start });
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

/**
 * Every run goes to the store. `--out` is the only redirect, and it is per
 * command: a sticky setting in a project file is exactly how a run ends up
 * somewhere the dashboard cannot see.
 */
export function resolveOutDir({ flagValue } = {}) {
  if (flagValue) return path.resolve(flagValue);
  return defaultStoreDir();
}

export function resolveMetadataDir({ outDir } = {}) {
  return path.join(outDir ?? resolveOutDir(), "metadata");
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
const RETIRED_KEYS = {
  outDir: "runs always go to the shared store; pass --out for a one-off run",
  metadataDir: "metadata always lives beside the store; pass --out for a one-off run",
};

export async function loadConfig({ file = projectConfigPath() } = {}) {
  const defaults = assertPolicyShape(await readJson(skillDefaultsPath), skillDefaultsPath);
  const projectConfig = await readJson(file, { optional: true });
  if (!projectConfig) {
    return { ...defaults, sources: { defaults: skillDefaultsPath, project: null } };
  }

  // Silently ignoring a stale key would write runs somewhere the config does
  // not say. Refuse instead, so the fix is obvious.
  for (const [key, reason] of Object.entries(RETIRED_KEYS)) {
    if (key in projectConfig) {
      throw new Error(`config at ${file}: ${key} is no longer supported; ${reason}`);
    }
  }

  const merged = {
    ...defaults,
    ...projectConfig,
    familyTaskTypes: { ...defaults.familyTaskTypes, ...(projectConfig.familyTaskTypes ?? {}) },
    sources: { defaults: skillDefaultsPath, project: file },
  };
  return assertPolicyShape(merged, file);
}
