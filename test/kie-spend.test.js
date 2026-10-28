import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readSpend, spendFromRecord, summarizeSpend } from "../scripts/lib/spend.js";

test("spend prefers reported consumption over an estimate", () => {
  const row = spendFromRecord({
    timestamp: "2026-10-28T00:00:00.000Z",
    request: { model: "gpt-image-2-text-to-image" },
    api_family: "image",
    state: "success",
    credits_consumed: 6,
    credits_estimated: 22.5,
  });
  assert.equal(row.consumed, 6);
  assert.equal(row.estimated, 22.5);
});

test("spend falls back to the legacy final_response field and then to estimates", () => {
  const modern = spendFromRecord({ final_response: { data: { creditsConsumed: 10, model: "m", state: "success" } } });
  assert.equal(modern.consumed, 10);
  assert.equal(modern.model, "m");

  const legacy = spendFromRecord({ request: { model: "suno" }, credits_estimated: 22.5 });
  assert.equal(legacy.consumed, null);
  assert.equal(legacy.estimated, 22.5);
});

test("unreported runs are counted rather than silently costed at zero", () => {
  const summary = summarizeSpend([
    spendFromRecord({ credits_consumed: 6, state: "success", request: { model: "a" } }),
    spendFromRecord({ credits_estimated: 12, state: "success", request: { model: "b" } }),
    spendFromRecord({ state: "success", request: { model: "c" } }),
  ]);
  assert.equal(summary.runs, 3);
  assert.equal(summary.consumed, 6);
  assert.equal(summary.estimated, 12);
  assert.equal(summary.unreported, 2);
});

test("skill-written metadata uses credits_estimate, legacy uses credits_estimated", () => {
  assert.equal(spendFromRecord({ credits_estimate: 22.5 }).estimated, 22.5);
  assert.equal(spendFromRecord({ credits_estimated: 22.5 }).estimated, 22.5);
  assert.equal(spendFromRecord({ credits_estimate: 2, credits_estimated: 99 }).estimated, 99);
});

test("reported cost wins over the estimate in per-model totals", () => {
  const summary = summarizeSpend([
    spendFromRecord({ credits_consumed: 6, credits_estimate: 16, state: "success", request: { model: "m" } }),
  ]);
  assert.equal(summary.consumed, 6);
  assert.equal(summary.estimated, 0);
  assert.equal(summary.byModel.m.consumed, 6);
  assert.equal(summary.byModel.m.estimated, 0);
  assert.equal(summary.byModel.m.consumed + summary.byModel.m.estimated, 6);
});

test("failed runs are tracked separately from spend", () => {
  const summary = summarizeSpend([spendFromRecord({ state: "fail", credits_consumed: 2 })]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.consumed, 2);
});

test("uppercase Suno statuses and unknown states are not counted as failures", () => {
  const suno = spendFromRecord({ final_response: { data: { status: "SUCCESS" } }, request: { model: "V5" } });
  assert.equal(suno.state, "success");
  assert.equal(suno.consumed, null);

  const unknown = spendFromRecord({ request: { model: "m" } });
  assert.equal(unknown.state, "unknown");
  assert.equal(summarizeSpend([suno, unknown]).failed, 0);
});

test("readSpend ignores broken files, filters by date, and aggregates metadata dirs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-spend-"));
  await writeFile(path.join(dir, "a.metadata.json"), JSON.stringify({
    timestamp: "2026-10-01T00:00:00.000Z",
    request: { model: "old" },
    credits_consumed: 4,
  }), "utf8");
  await writeFile(path.join(dir, "b.metadata.json"), JSON.stringify({
    timestamp: "2026-10-28T00:00:00.000Z",
    request: { model: "new" },
    credits_consumed: 6,
  }), "utf8");
  await writeFile(path.join(dir, "c.metadata.json"), "{ not json", "utf8");
  await writeFile(path.join(dir, "notes.txt"), "ignored", "utf8");

  const all = await readSpend({ directories: [dir] });
  assert.equal(all.length, 2);

  const recent = await readSpend({ directories: [dir], since: Date.parse("2026-10-15T00:00:00Z") });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].model, "new");

  assert.equal(summarizeSpend(all).consumed, 10);
});

test("a missing metadata directory is not an error", async () => {
  const rows = await readSpend({ directories: ["/tmp/definitely-not-a-kie-dir"] });
  assert.deepEqual(rows, []);
});
