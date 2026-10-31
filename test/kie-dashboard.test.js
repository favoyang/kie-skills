import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  createDashboardServer,
  formatElapsed,
  metadataVersion,
  renderItems,
  renderPage,
} from "../scripts/lib/dashboard.js";
import path from "node:path";

function feedItem(index) {
  return {
    metadataPath: `kie-output/metadata/${index}.json`,
    timestamp: `2026-06-26T00:00:0${index}.000Z`,
    provider: "KIE.ai",
    family: "music",
    mode: "V5",
    title: "",
    model: "V5",
    taskId: `task-${index}`,
    state: "success",
    prompt: `Prompt ${index}`,
    otherInputs: {},
    creditsConsumed: 22.5,
    timeToResponseMs: null,
    retryTime: null,
    referenceImages: [],
    downloaded: [],
    textAssets: [],
  };
}

test("renderPage renders a feed with prompt and output assets", async () => {
  const html = await renderPage([
    {
      metadataPath: "kie-output/metadata/a.json",
      timestamp: "2026-06-26T00:00:00.000Z",
      provider: "KIE.ai",
      family: "image",
      mode: "gpt-image-2-text-to-image",
      title: "Red Mug Test",
      model: "gpt-image-2-text-to-image",
      taskId: "task-1",
      state: "success",
      prompt: "A red mug",
      otherInputs: { aspect_ratio: "auto" },
      creditsConsumed: 10,
      timeToResponseMs: 1234,
      retryTime: null,
      referenceImages: [{ path: "kie-output/images/reference.png" }],
      downloaded: [
        { path: "kie-output/images/a.png" },
        { path: "kie-output/audio/a.mp3", durationSeconds: 75.4 },
      ],
      textAssets: [{ path: "kie-output/text/lyrics.txt" }],
    },
  ]);

  assert.match(html, /KIE Generations/);
  assert.match(html, /image <span>gpt-image-2-text-to-image \| Red Mug Test<\/span>/);
  assert.match(html, /A red mug/);
  assert.match(html, /Output Assets/);
  assert.match(html, /kie-output%2Fimages%2Fa.png/);
  assert.match(html, /kie-output%2Faudio%2Fa.mp3/);
  assert.match(html, /Reference Images/);
  assert.match(html, /class="reference-image"/);
  assert.match(html, /Text Assets/);
  assert.match(html, /10 \/ \$0\.050/);
  assert.match(html, /Length 1:15\.4/);
  assert.match(html, /Song Length/);
  assert.match(html, /1\.2 seconds/);
  assert.doesNotMatch(html, /1234 ms/);
  assert.match(html, /class="local-time"/);
  assert.match(html, /class="time-since"/);
  assert.match(html, /preload="none"/);
});

test("renderPage expands only the newest three feed items by default", async () => {
  const html = await renderPage([feedItem(1), feedItem(2), feedItem(3), feedItem(4)]);
  assert.equal((html.match(/<details class="feed-toggle" open>/g) ?? []).length, 3);
  assert.equal((html.match(/<details class="feed-toggle">/g) ?? []).length, 1);
});

test("image-only runs do not show a song length tile", async () => {
  const html = await renderPage([
    {
      ...feedItem(1),
      family: "image",
      downloaded: [{ path: "kie-output/images/a.png" }],
    },
  ]);
  assert.doesNotMatch(html, /Song Length/);
  assert.match(html, /<span>Time<\/span>/);
});

test("elapsed time is shown in seconds, never milliseconds", () => {
  assert.equal(formatElapsed(33068), "33.1 seconds");
  assert.equal(formatElapsed(1234), "1.2 seconds");
  assert.equal(formatElapsed(90000), "1m 30.0s");
  assert.equal(formatElapsed(null), "unknown");
  assert.equal(formatElapsed(undefined), "unknown");
});

test("an empty feed explains what to do instead of showing a blank page", async () => {
  const html = await renderPage([]);
  assert.match(html, /id="count"[^>]*>0</);
  assert.match(html, /No generations yet/);
});

test("the page offers a list/gallery toggle and starts in list view", async () => {
  const html = await renderPage([feedItem(1)]);
  assert.match(html, /<main data-view="list">/);
  assert.match(html, /data-view="list"/);
  assert.match(html, /data-view="gallery"/);
  assert.doesNotMatch(html, /newest first/);
  assert.match(html, /<h1>KIE Generations<\/h1>\s*<span id="live"/);
  assert.match(html, /id="feed"/);
  assert.match(html, /id="live"/);
});

test("gallery tiles use the first visual asset", async () => {
  const html = await renderPage([{
    ...feedItem(1),
    family: "image",
    downloaded: [{ path: "kie-output/images/a.png" }, { path: "kie-output/images/b.png" }],
  }]);
  assert.match(html, /class="tile"><a class="tile-open" data-kind="image" href="\/asset\?path=kie-output%2Fimages%2Fa\.png"/);
  assert.match(html, /class="to-details" href="\/item\?task=task-1"/);
});

test("video tiles render a first frame instead of a label", async () => {
  const html = await renderPage([{
    ...feedItem(1),
    family: "music",
    downloaded: [{ path: "kie-output/video/a.mp4" }],
  }]);
  assert.match(html, /<video src="\/asset\?path=kie-output%2Fvideo%2Fa\.mp4#t=0\.1" muted playsinline preload="metadata">/);
  assert.match(html, /data-kind="video"/);
});

test("runs without a visual asset still get a tile placeholder", async () => {
  const html = await renderPage([{ ...feedItem(1), downloaded: [], textAssets: [{ path: "kie-output/text/a.txt" }] }]);
  assert.match(html, /class="tile tile-empty"/);
  assert.match(html, /class="tile-kind">music</);
});

test("renderItems returns bare articles for partial refreshes", async () => {
  const html = await renderItems([feedItem(1), feedItem(2)]);
  assert.equal((html.match(/<article/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<html/);
});

test("the version fingerprint changes when a run is added", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-version-"));
  assert.equal(await metadataVersion(dir), "0:0");

  const record = { timestamp: "2026-06-26T00:00:00.000Z", request: { model: "m", input: {} }, final_response: { data: { state: "success" } } };
  await writeFile(path.join(dir, "a.metadata.json"), JSON.stringify(record), "utf8");
  const first = await metadataVersion(dir);
  assert.match(first, /^1:\d+$/);

  await writeFile(path.join(dir, "b.metadata.json"), JSON.stringify(record), "utf8");
  assert.match(await metadataVersion(dir), /^2:\d+$/);
});

test("the server serves the page, a version fingerprint, and a partial feed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-serve-"));
  const metadataDir = path.join(dir, "metadata");
  await writeFile(path.join(dir, "placeholder"), "", "utf8").catch(() => {});
  await import("node:fs/promises").then((fs) => fs.mkdir(metadataDir, { recursive: true }));
  await writeFile(
    path.join(metadataDir, "a.metadata.json"),
    JSON.stringify({ timestamp: "2026-06-26T00:00:00.000Z", request: { model: "m", input: {} }, final_response: { data: { state: "success" } } }),
    "utf8",
  );

  const server = createDashboardServer({ projectDir: dir, outDir: dir, metadataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /KIE Generations/);

    const version = await (await fetch(`${base}/api/version`)).text();
    assert.match(version, /^1:\d+$/);
    assert.equal(await (await fetch(`${base}/api/version`)).text(), version);

    const partial = await (await fetch(`${base}/partial`)).text();
    assert.match(partial, /<article/);
    assert.doesNotMatch(partial, /<html/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the detail route renders a breadcrumb and the full block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-detail-"));
  const metadataDir = path.join(dir, "metadata");
  await (await import("node:fs/promises")).mkdir(metadataDir, { recursive: true });
  await writeFile(
    path.join(metadataDir, "a.metadata.json"),
    JSON.stringify({
      timestamp: "2026-06-26T00:00:00.000Z",
      api_family: "image",
      mode: "gpt-image-2-text-to-image",
      request: { model: "gpt-image-2-text-to-image", input: { prompt: "a mug" } },
      final_response: { data: { taskId: "task-1", state: "success" } },
    }),
    "utf8",
  );

  const server = createDashboardServer({ projectDir: dir, outDir: dir, metadataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const detail = await (await fetch(`${base}/item?task=task-1`)).text();
    assert.match(detail, /class="crumbs"/);
    assert.match(detail, /← Generations/);
    assert.match(detail, /a mug/);
    assert.match(detail, /<main data-view="detail">/);
    assert.match(detail, /<h1>KIE Generations<\/h1>/);
    assert.match(detail, /← Generations/);

    const missing = await fetch(`${base}/item?task=nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("project groups collapse worktrees into one repository", async () => {
  const { projectGroups, filterItems } = await import("../scripts/lib/dashboard.js");
  const items = [
    { ...feedItem(1), project: { key: "/repo/.git", name: "repo" } },
    { ...feedItem(2), project: { key: "/repo/.git", name: "repo" } },
    { ...feedItem(3), project: { key: "/other/.git", name: "other" } },
    { ...feedItem(4), project: { key: "", name: "" } },
  ];
  const groups = projectGroups(items);
  assert.deepEqual(groups.map((group) => [group.name, group.runs]), [["repo", 2], ["other", 1], ["unknown", 1]]);
  assert.equal(filterItems(items, { project: "/repo/.git" }).length, 2);
  assert.equal(filterItems(items, { project: "repo", family: "music" }).length, 2);
  assert.equal(filterItems(items, {}).length, 4);
});

test("the page lists projects and shows a filtered summary", async () => {
  const items = [
    { ...feedItem(1), project: { key: "/repo/.git", name: "repo" } },
    { ...feedItem(2), project: { key: "/other/.git", name: "other" } },
  ];
  const html = await renderPage([items[0]], {
    active: { project: "/repo/.git", family: "" },
    projects: [{ key: "/repo/.git", name: "repo", runs: 1, credits: 22.5 }, { key: "/other/.git", name: "other", runs: 1, credits: 22.5 }],
    families: ["music"],
  });
  assert.match(html, /name="project"/);
  assert.match(html, /<option value="\/repo\/\.git" selected>repo \(1\)<\/option>/);
  assert.match(html, /id="summary"/);
  assert.match(html, /<strong>1<\/strong> run\(s\)/);
  assert.match(html, /filtered/);
});

test("the health endpoint identifies the dashboard and its store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-health-"));
  const server = createDashboardServer({ storeDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.app, "kie-dashboard");
    assert.equal(health.storeDir, dir);
    assert.equal(health.metadataDir, path.join(dir, "metadata"));
    assert.equal(typeof health.version, "string");
    assert.equal(health.runs, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the server filters by project and keeps the filter on partial refresh", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-filter-"));
  const metadataDir = path.join(dir, "metadata");
  await (await import("node:fs/promises")).mkdir(metadataDir, { recursive: true });
  const record = (taskId, project) => JSON.stringify({
    timestamp: "2026-06-26T00:00:00.000Z",
    project,
    request: { model: "m", input: { prompt: taskId } },
    final_response: { data: { taskId, state: "success" } },
  });
  await writeFile(path.join(metadataDir, "a.metadata.json"), record("a", { key: "/repo/.git", name: "repo" }), "utf8");
  await writeFile(path.join(metadataDir, "b.metadata.json"), record("b", { key: "/other/.git", name: "other" }), "utf8");

  const server = createDashboardServer({ storeDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/?project=${encodeURIComponent("/repo/.git")}`)).text();
    assert.equal((page.match(/class="feed-item"/g) ?? []).length, 1);
    assert.match(page, /All projects \(2\)/);

    const partial = await (await fetch(`${base}/partial?project=${encodeURIComponent("/repo/.git")}`)).text();
    assert.equal((partial.match(/class="feed-item"/g) ?? []).length, 1);
    assert.match(partial, /id="summary"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
