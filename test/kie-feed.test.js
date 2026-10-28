import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  assetKind,
  assetUrl,
  contentType,
  deriveState,
  deriveTimeToResponse,
  feedItemFromRecord,
  readFeedItems,
  resolveAssetPath,
} from "../scripts/lib/feed.js";

const context = { projectDir: "/repo", outDir: "/repo/kie-output" };

test("feed mapping exposes prompt, model, state, and credits", () => {
  const item = feedItemFromRecord("/repo/kie-output/metadata/a.json", {
    timestamp: "2026-06-26T00:00:00.000Z",
    provider: "KIE.ai",
    api_family: "image",
    mode: "gpt-image-2-text-to-image",
    request: {
      model: "gpt-image-2-text-to-image",
      input: { prompt: "red mug", title: "Red Mug Test", input_urls: ["https://example.test/remote.png"] },
    },
    final_response: {
      data: {
        taskId: "task-1",
        state: "success",
        creditsConsumed: 12,
        createTime: 1000,
        completeTime: 2500,
        param: JSON.stringify({ input: JSON.stringify({ prompt: "red mug" }) }),
      },
    },
    downloaded: [{ path: "kie-output/images/a.png", url: "https://example.test/a.png" }],
  }, context);

  assert.equal(item.metadataPath, "kie-output/metadata/a.json");
  assert.equal(item.prompt, "red mug");
  assert.equal(item.title, "Red Mug Test");
  assert.equal(item.state, "success");
  assert.equal(item.creditsConsumed, 12);
  assert.equal(item.timeToResponseMs, 1500);
  assert.deepEqual(item.referenceImages, [{ url: "https://example.test/remote.png" }]);
  assert.equal(typeof item.otherInputs.api_param, "object");
});

test("credits fall back to estimates so migrated Suno runs are not blank", () => {
  const estimated = feedItemFromRecord("/repo/kie-output/metadata/b.json", {
    request: { model: "V5", input: { prompt: "x" } },
    credits_estimate: 22.5,
    final_response: { data: { status: "SUCCESS" } },
  }, context);
  assert.equal(estimated.creditsConsumed, 22.5);
  assert.equal(estimated.state, "success");

  const legacy = feedItemFromRecord("/repo/kie-output/metadata/c.json", {
    request: { model: "V5", input: { prompt: "x" } },
    credits_estimated: "22.5 estimated",
    final_response: { data: { status: "SUCCESS" } },
  }, context);
  assert.equal(legacy.creditsConsumed, "22.5 estimated");
});

test("elapsed time prefers epoch timestamps and converts costTime seconds", () => {
  assert.equal(deriveTimeToResponse({ createTime: 1000, completeTime: 34068, costTime: 33 }), 33068);
  assert.equal(deriveTimeToResponse({ costTime: 50 }), 50000);
  assert.equal(deriveTimeToResponse({ costTime: 30000 }), 30000);
  assert.equal(deriveTimeToResponse({}), null);
});

test("state derivation handles successFlag and Suno status values", () => {
  assert.equal(deriveState({ successFlag: 1 }), "success");
  assert.equal(deriveState({ successFlag: 0 }), "failed");
  assert.equal(deriveState({ status: "SUCCESS" }), "success");
  assert.equal(deriveState({ state: "GENERATING" }), "generating");
  assert.equal(deriveState({}), "unknown");
});

test("asset helpers classify by extension and build a safe url", () => {
  assert.equal(assetKind("a.png"), "image");
  assert.equal(assetKind("a.mp3"), "audio");
  assert.equal(assetKind("a.mp4"), "video");
  assert.equal(assetKind("a.json"), "other");
  assert.equal(contentType("a.mp4"), "video/mp4");
  assert.equal(contentType("a.unknown"), "application/octet-stream");
  assert.equal(assetUrl("kie-output/x.png"), "/asset?path=kie-output%2Fx.png");
});

test("resolveAssetPath accepts project-relative and absolute paths inside the output dir", () => {
  assert.equal(resolveAssetPath("kie-output/images/a.png", context), "/repo/kie-output/images/a.png");
  assert.equal(resolveAssetPath("/repo/kie-output/images/a.png", context), "/repo/kie-output/images/a.png");
});

test("resolveAssetPath refuses anything outside the output dir", () => {
  assert.equal(resolveAssetPath("/etc/passwd", context), null);
  assert.equal(resolveAssetPath("../../etc/passwd", context), null);
  assert.equal(resolveAssetPath("kie-output/../../etc/passwd", context), null);
  assert.equal(resolveAssetPath("", context), null);
});

test("readFeedItems sorts newest first and reports broken files instead of hiding them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-feed-"));
  await writeFile(path.join(dir, "old.metadata.json"), JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", request: { model: "m", input: {} }, final_response: { data: { state: "success" } } }), "utf8");
  await writeFile(path.join(dir, "new.metadata.json"), JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", request: { model: "m", input: {} }, final_response: { data: { state: "success" } } }), "utf8");
  await writeFile(path.join(dir, "broken.metadata.json"), "{ nope", "utf8");

  const items = await readFeedItems({ metadataDir: dir, projectDir: dir });
  assert.equal(items.length, 3);
  assert.equal(items[0].timestamp, "2026-06-01T00:00:00.000Z");
  assert.equal(items[1].timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(items[2].provider, "metadata parse error");
  assert.equal(items[2].state, "error");
});

test("a missing metadata directory yields an empty feed", async () => {
  assert.deepEqual(await readFeedItems({ metadataDir: "/tmp/definitely-not-kie", projectDir: "/tmp" }), []);
});
