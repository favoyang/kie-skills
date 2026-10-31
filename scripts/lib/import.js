import path from "node:path";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { projectIdentityAt, storeMetadataDir } from "./config.js";

/**
 * One-time merge of scattered `kie-output` trees into the store. Runs are
 * identified by task id, so re-running an import never duplicates a run.
 */

async function statOrNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function metadataDirs(sources) {
  const dirs = new Set();
  for (const source of sources) {
    const absolute = path.resolve(source);
    const info = await statOrNull(absolute);
    if (!info) continue;
    if (info.isFile() && absolute.endsWith(".json")) {
      dirs.add(path.dirname(absolute));
      continue;
    }
    if (!info.isDirectory()) continue;
    const nested = path.join(absolute, "metadata");
    dirs.add((await statOrNull(nested))?.isDirectory() ? nested : absolute);
  }
  return [...dirs];
}

function taskIdOf(record, fileName) {
  return record?.final_response?.data?.taskId
    ?? record?.create_response?.data?.taskId
    ?? record?.task_id
    ?? path.basename(fileName).replace(/\.metadata\.json$/, "");
}

async function knownTaskIds(metadataDir) {
  const ids = new Set();
  let names = [];
  try {
    names = await readdir(metadataDir);
  } catch {
    return ids;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(path.join(metadataDir, name), "utf8"));
      ids.add(taskIdOf(record, name));
    } catch {
      // A broken record cannot claim a task id.
    }
  }
  return ids;
}

function assetRefs(record) {
  const refs = [];
  const collect = (entry) => {
    if (entry && typeof entry === "object" && typeof entry.path === "string" && entry.path.length > 0) {
      refs.push({ get: () => entry.path, set: (value) => { entry.path = value; } });
    }
  };
  for (const list of [record.downloaded, record.text_assets]) {
    if (Array.isArray(list)) list.forEach(collect);
  }
  if (typeof record.reference_fixture === "string" && record.reference_fixture.length > 0) {
    refs.push({ get: () => record.reference_fixture, set: (value) => { record.reference_fixture = value; } });
  }
  return refs;
}

async function findAsset(refPath, { sourceRoot, projectDir }) {
  const candidates = [];
  if (path.isAbsolute(refPath)) candidates.push(refPath);
  candidates.push(path.resolve(sourceRoot, refPath));
  candidates.push(path.resolve(sourceRoot, "..", refPath));
  if (projectDir) candidates.push(path.resolve(projectDir, refPath));
  for (const candidate of candidates) {
    const info = await statOrNull(candidate);
    if (info?.isFile()) return candidate;
  }
  return null;
}

function storeRelativePath(assetPath, sourceRoot) {
  return isInside(sourceRoot, assetPath)
    ? path.relative(sourceRoot, assetPath)
    : path.join("imported", path.basename(assetPath));
}

export async function importRuns({ sources, storeDir, log = console.log } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("import needs at least one source directory");
  }
  const destination = storeMetadataDir(storeDir);
  await mkdir(destination, { recursive: true });

  const seen = await knownTaskIds(destination);
  const summary = { imported: 0, skipped: 0, broken: 0, missing: [], sources: [], storeDir };

  for (const metadataDir of await metadataDirs(sources)) {
    summary.sources.push(metadataDir);
    const sourceRoot = path.basename(metadataDir) === "metadata" ? path.dirname(metadataDir) : metadataDir;
    const sourceProjectRoot = path.basename(sourceRoot) === "kie-output" ? path.dirname(sourceRoot) : sourceRoot;
    const names = (await readdir(metadataDir).catch(() => [])).filter((entry) => entry.endsWith(".json"));

    for (const name of names) {
      const sourcePath = path.join(metadataDir, name);
      let record;
      try {
        record = JSON.parse(await readFile(sourcePath, "utf8"));
      } catch {
        summary.broken += 1;
        log(`broken     ${sourcePath}`);
        continue;
      }

      const taskId = taskIdOf(record, name);
      if (seen.has(taskId)) {
        summary.skipped += 1;
        continue;
      }

      // Older records predate project tracking. The source tree is the only
      // honest evidence of where the run came from, so record that.
      if (!record.project) {
        record.project = projectIdentityAt(sourceProjectRoot, { source: "import" });
      }

      for (const ref of assetRefs(record)) {
        const found = await findAsset(ref.get(), { sourceRoot, projectDir: record?.project?.dir });
        if (!found) {
          summary.missing.push({ taskId, path: ref.get() });
          continue;
        }
        const target = path.join(storeDir, storeRelativePath(found, sourceRoot));
        if (path.resolve(target) !== path.resolve(found)) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(found, target);
        }
        ref.set(target);
      }

      const targetName = path.join(destination, name);
      await writeFile(targetName, JSON.stringify(record, null, 2), "utf8");
      seen.add(taskId);
      summary.imported += 1;
      log(`imported   ${taskId} <- ${sourcePath}`);
    }
  }

  return summary;
}
