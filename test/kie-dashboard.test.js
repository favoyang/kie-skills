import test from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, renderPage } from "../scripts/lib/dashboard.js";

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
  assert.match(html, /0 items/);
  assert.match(html, /Run a generation first/);
});
