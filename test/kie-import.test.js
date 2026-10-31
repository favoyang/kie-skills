import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { importRuns } from "../scripts/lib/import.js";

async function legacyProject({ assetInside = true, withProject = true } = {}) {
  const project = await mkdtemp(path.join(os.tmpdir(), "kie-import-"));
  const outDir = path.join(project, "kie-output");
  const metadataDir = path.join(outDir, "metadata");
  const assetDir = path.join(outDir, "images", "gpt-image-2");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(assetDir, { recursive: true });

  const assetPath = path.join(assetDir, "a.png");
  await writeFile(assetPath, "png-bytes", "utf8");
  await writeFile(path.join(metadataDir, "20260101-000000-mug-task-1.metadata.json"), JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    provider: "KIE.ai",
    api_family: "image",
    mode: "gpt-image-2-text-to-image",
    ...(withProject ? { project: { dir: project, source: "cwd" } } : {}),
    request: { model: "gpt-image-2-text-to-image", input: { prompt: "mug" } },
    final_response: { data: { taskId: "task-1", state: "success" } },
    downloaded: [{ path: assetInside ? assetPath : path.join(project, "gone.png") }],
  }), "utf8");

  return { project, outDir, metadataDir, assetPath };
}

test("import copies a legacy run and its assets into the store", async () => {
  const { outDir, assetPath } = await legacyProject();
  const store = await mkdtemp(path.join(os.tmpdir(), "kie-store-"));

  const summary = await importRuns({ sources: [outDir], storeDir: store, log: () => {} });
  assert.equal(summary.imported, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.missing.length, 0);

  const record = JSON.parse(await readFile(path.join(store, "metadata", "20260101-000000-mug-task-1.metadata.json"), "utf8"));
  const importedAsset = path.join(store, "images", "gpt-image-2", "a.png");
  assert.equal(record.downloaded[0].path, importedAsset);
  assert.equal((await stat(importedAsset)).size, (await stat(assetPath)).size);
});

test("importing twice does not duplicate a run", async () => {
  const { outDir } = await legacyProject();
  const store = await mkdtemp(path.join(os.tmpdir(), "kie-store-"));

  await importRuns({ sources: [outDir], storeDir: store, log: () => {} });
  const second = await importRuns({ sources: [outDir], storeDir: store, log: () => {} });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
});

test("a missing asset is reported instead of dropping the run", async () => {
  const { outDir } = await legacyProject({ assetInside: false });
  const store = await mkdtemp(path.join(os.tmpdir(), "kie-store-"));

  const summary = await importRuns({ sources: [outDir], storeDir: store, log: () => {} });
  assert.equal(summary.imported, 1);
  assert.equal(summary.missing.length, 1);
  assert.equal(summary.missing[0].taskId, "task-1");
});

test("import infers a project for records that predate project tracking", async () => {
  const { outDir } = await legacyProject({ withProject: false });
  const store = await mkdtemp(path.join(os.tmpdir(), "kie-store-"));
  await importRuns({ sources: [outDir], storeDir: store, log: () => {} });

  const [name] = (await import("node:fs/promises").then((fs) => fs.readdir(path.join(store, "metadata"))));
  const record = JSON.parse(await readFile(path.join(store, "metadata", name), "utf8"));
  assert.equal(record.project.source, "import");
  assert.equal(record.project.dir, path.dirname(outDir));
  assert.equal(record.project.name, path.basename(path.dirname(outDir)));
  assert.ok(record.project.key);
});

test("import accepts a metadata directory directly", async () => {
  const { metadataDir } = await legacyProject();
  const store = await mkdtemp(path.join(os.tmpdir(), "kie-store-"));

  const summary = await importRuns({ sources: [metadataDir], storeDir: store, log: () => {} });
  assert.equal(summary.imported, 1);
  assert.equal(summary.sources.length, 1);
});

test("import needs a source", async () => {
  await assert.rejects(() => importRuns({ sources: [], storeDir: "/tmp/nowhere" }), /at least one source/);
});
