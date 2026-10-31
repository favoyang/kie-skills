import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import {
  assertPolicyShape,
  defaultStoreDir,
  loadConfig,
  projectDir,
  projectIdentity,
  resolveMetadataDir,
  resolveOutDir,
  resolveProject,
} from "../scripts/lib/config.js";

async function withProject(configFile, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-config-"));
  if (configFile) await writeFile(path.join(dir, "kie.config.json"), JSON.stringify(configFile), "utf8");
  const previous = {
    project: process.env.KIE_PROJECT_DIR,
    out: process.env.KIE_OUT_DIR,
    store: process.env.KIE_STORE_DIR,
  };
  const store = path.join(dir, "store");
  process.env.KIE_PROJECT_DIR = dir;
  process.env.KIE_STORE_DIR = store;
  delete process.env.KIE_OUT_DIR;
  try {
    return await run(dir, store);
  } finally {
    for (const [key, value] of [["KIE_PROJECT_DIR", previous.project], ["KIE_OUT_DIR", previous.out], ["KIE_STORE_DIR", previous.store]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the project directory defaults to cwd and can be redirected", () => {
  assert.equal(typeof projectDir(), "string");
  process.env.KIE_PROJECT_DIR = "/tmp/some-project";
  assert.equal(projectDir(), "/tmp/some-project");
  delete process.env.KIE_PROJECT_DIR;
});

test("without a project config, outputs default to the shared store", async () => {
  await withProject(null, async (dir, store) => {
    const config = await loadConfig();
    assert.equal(resolveOutDir({ config }), store);
    assert.equal(resolveMetadataDir({ outDir: store, config }), path.join(store, "metadata"));
    assert.deepEqual(config.allowedFamilies, ["image", "music", "speech"]);
    assert.notEqual(resolveOutDir({ config }), path.join(dir, "kie-output"));
  });
});

test("the store lives under the platform data directory, not the project", () => {
  const previous = process.env.KIE_STORE_DIR;
  delete process.env.KIE_STORE_DIR;
  try {
    const store = defaultStoreDir();
    assert.ok(path.isAbsolute(store));
    assert.ok(store.endsWith("kie"));
  } finally {
    if (previous !== undefined) process.env.KIE_STORE_DIR = previous;
  }
});

test("KIE_STORE_DIR wins over the platform default", () => {
  const previous = process.env.KIE_STORE_DIR;
  process.env.KIE_STORE_DIR = "/tmp/kie-store-override";
  try {
    assert.equal(defaultStoreDir(), "/tmp/kie-store-override");
  } finally {
    if (previous === undefined) delete process.env.KIE_STORE_DIR;
    else process.env.KIE_STORE_DIR = previous;
  }
});

test("a linked worktree reports the repository, not the worktree path", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "kie-repo-"));
  const commonDir = path.join(repo, ".git");
  const worktreeGitDir = path.join(commonDir, "worktrees", "feature");
  const worktree = path.join(repo, ".worktrees", "feature");
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

  const identity = projectIdentity(worktree);
  assert.equal(identity.dir, worktree);
  assert.equal(identity.root, worktree);
  assert.equal(identity.git_common_dir, commonDir);
  assert.equal(identity.name, path.basename(repo));
  assert.equal(identity.key, commonDir);
});

test("the main checkout and its worktree share one project key", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "kie-repo-main-"));
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const worktree = path.join(repo, ".worktrees", "topic");
  const worktreeGitDir = path.join(repo, ".git", "worktrees", "topic");
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

  assert.equal(projectIdentity(repo).key, projectIdentity(worktree).key);
});

test("outside a repository the project key is the working directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-plain-"));
  const identity = projectIdentity(dir);
  assert.equal(identity.git_common_dir, null);
  assert.equal(identity.key, dir);
  assert.equal(identity.name, path.basename(dir));
});

test("a project config narrows families without losing the task map", async () => {
  await withProject({ allowedFamilies: ["image"] }, async (dir, store) => {
    const config = await loadConfig();
    assert.equal(resolveOutDir(), store);
    assert.deepEqual(config.allowedFamilies, ["image"]);
    assert.ok(config.familyTaskTypes.video.includes("Text to Video"));
    assert.ok(config.sources.project.endsWith("kie.config.json"));
  });
});

test("a project outDir is refused instead of silently redirecting runs", async () => {
  await withProject({ outDir: "outputs" }, async () => {
    await assert.rejects(() => loadConfig(), /outDir is no longer supported/);
  });
});

test("a project metadataDir is refused for the same reason", async () => {
  await withProject({ metadataDir: "records" }, async () => {
    await assert.rejects(() => loadConfig(), /metadataDir is no longer supported/);
  });
});

test("--out is the only redirect, and it wins over the store", async () => {
  await withProject(null, async (dir, store) => {
    assert.equal(resolveOutDir(), store);
    assert.equal(resolveOutDir({ flagValue: path.join(dir, "one-off") }), path.join(dir, "one-off"));
    assert.equal(resolveMetadataDir({ outDir: path.join(dir, "one-off") }), path.join(dir, "one-off", "metadata"));
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
