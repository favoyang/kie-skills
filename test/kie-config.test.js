import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { assertPolicyShape, loadConfig, projectDir, resolveMetadataDir, resolveOutDir, resolveProject } from "../scripts/lib/config.js";

async function withProject(configFile, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-config-"));
  if (configFile) await writeFile(path.join(dir, "kie.config.json"), JSON.stringify(configFile), "utf8");
  const previous = { project: process.env.KIE_PROJECT_DIR, out: process.env.KIE_OUT_DIR };
  process.env.KIE_PROJECT_DIR = dir;
  delete process.env.KIE_OUT_DIR;
  try {
    return await run(dir);
  } finally {
    if (previous.project === undefined) delete process.env.KIE_PROJECT_DIR;
    else process.env.KIE_PROJECT_DIR = previous.project;
    if (previous.out === undefined) delete process.env.KIE_OUT_DIR;
    else process.env.KIE_OUT_DIR = previous.out;
  }
}

test("the project directory defaults to cwd and can be redirected", () => {
  assert.equal(typeof projectDir(), "string");
  process.env.KIE_PROJECT_DIR = "/tmp/some-project";
  assert.equal(projectDir(), "/tmp/some-project");
  delete process.env.KIE_PROJECT_DIR;
});

test("without a project config, outputs default to <project>/kie-output", async () => {
  await withProject(null, async (dir) => {
    const config = await loadConfig();
    assert.equal(resolveOutDir({ config }), path.join(dir, "kie-output"));
    assert.equal(resolveMetadataDir({ outDir: path.join(dir, "kie-output"), config }), path.join(dir, "kie-output", "metadata"));
    assert.deepEqual(config.allowedFamilies, ["image", "music", "speech"]);
  });
});

test("a project config overrides outDir and narrows families without losing the task map", async () => {
  await withProject({ outDir: "outputs", allowedFamilies: ["image"] }, async (dir) => {
    const config = await loadConfig();
    assert.equal(resolveOutDir({ config }), path.join(dir, "outputs"));
    assert.deepEqual(config.allowedFamilies, ["image"]);
    assert.ok(config.familyTaskTypes.video.includes("Text to Video"));
    assert.ok(config.sources.project.endsWith("kie.config.json"));
  });
});

test("explicit flags beat environment, which beats project config", async () => {
  await withProject({ outDir: "from-config" }, async (dir) => {
    const config = await loadConfig();
    assert.equal(resolveOutDir({ config }), path.join(dir, "from-config"));

    process.env.KIE_OUT_DIR = path.join(dir, "from-env");
    assert.equal(resolveOutDir({ config }), path.join(dir, "from-env"));

    assert.equal(resolveOutDir({ flagValue: path.join(dir, "from-flag"), config }), path.join(dir, "from-flag"));
  });
});

test("metadataDir can be pinned independently of outDir", async () => {
  await withProject({ outDir: "outputs", metadataDir: "records" }, async (dir) => {
    const config = await loadConfig();
    assert.equal(resolveMetadataDir({ outDir: path.join(dir, "outputs"), config }), path.join(dir, "records"));
  });
});

test("policy shape validation rejects families missing from the task map", () => {
  assert.throws(
    () => assertPolicyShape({ allowedFamilies: ["image", "smell"], familyTaskTypes: { image: [] } }, "test"),
    /unknown families: smell/,
  );
  assert.throws(
    () => assertPolicyShape({ allowedFamilies: ["image"], familyTaskTypes: { image: "Text to Image" } }, "test"),
    /must be an array/,
  );
  assert.throws(
    () => assertPolicyShape({ allowedFamilies: ["image"], familyTaskTypes: { image: [] }, minBalance: -1 }, "test"),
    /non-negative/,
  );
});

test("the working directory is the project root by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kie-root-"));
  const nested = path.join(root, "notes", "deep");
  await mkdir(nested, { recursive: true });

  assert.deepEqual(resolveProject(nested), { dir: nested, source: "cwd" });
});

test("markers do not change the project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kie-root-"));
  await mkdir(path.join(root, ".git"));
  const nested = path.join(root, "notes");
  await mkdir(nested, { recursive: true });

  assert.deepEqual(resolveProject(nested), { dir: nested, source: "cwd" });
});

test("KIE_PROJECT_DIR redirects the project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kie-env-"));
  const previous = process.env.KIE_PROJECT_DIR;
  process.env.KIE_PROJECT_DIR = root;
  try {
    assert.deepEqual(resolveProject("/"), { dir: root, source: "env" });
  } finally {
    if (previous === undefined) delete process.env.KIE_PROJECT_DIR;
    else process.env.KIE_PROJECT_DIR = previous;
  }
});
