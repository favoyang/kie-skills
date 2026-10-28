import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { PolicyError } from "../scripts/lib/policy.js";
import { extractResultUrls, runModel } from "../scripts/lib/run.js";

const MODEL = "gpt-image-2-text-to-image";

const catalog = {
  code: 200,
  msg: "success",
  data: {
    total: 2,
    models: [
      { model: MODEL, taskType: ["Text to Image"], pricingDesc: "6 credits for 1K, 10 credits for 2K, 16 credits for 4K" },
      { model: "kling/v2-1-master-text-to-video", taskType: ["Text to Video"], pricingDesc: "160 credits for 5s" },
    ],
  },
};

const schema = {
  code: 200,
  data: {
    openapi: {
      paths: {
        "/api/v1/jobs/createTask": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    required: ["model", "input"],
                    properties: {
                      model: { type: "string" },
                      input: {
                        type: "object",
                        required: ["prompt"],
                        properties: {
                          prompt: { type: "string" },
                          resolution: { type: "string", enum: ["1K", "2K", "4K"] },
                          image_url: { type: "string" },
                          input_urls: { type: "array" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const policy = {
  version: 1,
  allowedFamilies: ["image", "music", "speech"],
  familyTaskTypes: {
    image: ["Text to Image", "Image to Image", "Image Editing"],
    music: ["Text to Music", "Audio to Audio"],
    speech: ["Text to Speech"],
    video: ["Text to Video", "Image to Video", "Lip Sync"],
  },
  minBalance: 20,
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeApi({ balance = 100, states = [{ state: "generating" }, { state: "success", creditsConsumed: 6, response: { resultUrls: ["https://cdn.test/a.png"] } }], onRecord } = {}) {
  const calls = { create: 0, record: 0, get: [], download: 0, uploads: 0, createPayload: null };
  const queue = [...states];
  const fetchFn = async (url, init = {}) => {
    const target = String(url);
    calls.get.push(`${init.method ?? "GET"} ${target.split("?")[0]}`);
    if (target.startsWith("https://cdn.test/")) {
      calls.download += 1;
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (target.startsWith("https://kieai.redpandaai.co/")) {
      calls.uploads += 1;
      return jsonResponse({
        success: true,
        code: 200,
        msg: "File uploaded successfully",
        data: { downloadUrl: "https://tempfile.test/uploaded.png", filePath: "images/user-uploads/uploaded.png" },
      });
    }
    if (target.endsWith("/api/v1/models")) return jsonResponse(catalog);
    if (target.includes("/schema")) return jsonResponse(schema);
    if (target.endsWith("/api/v1/chat/credit")) return jsonResponse({ code: 200, msg: "success", data: balance });
    if (target.endsWith("/api/v1/jobs/createTask")) {
      calls.create += 1;
      calls.createPayload = JSON.parse(String(init.body));
      return jsonResponse({ code: 200, msg: "success", data: { taskId: "task-1" } });
    }
    if (target.includes("/api/v1/jobs/recordInfo")) {
      calls.record += 1;
      if (onRecord) await onRecord(calls.record);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return jsonResponse({ code: 200, msg: "success", data: { taskId: "task-1", ...next } });
    }
    throw new Error(`unexpected request: ${init.method ?? "GET"} ${target}`);
  };
  return { fetchFn, calls };
}

async function tempRoots() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kie-run-"));
  return {
    root,
    cacheDir: path.join(root, "cache"),
    outDir: path.join(root, "out"),
    metadataDir: path.join(root, "out", "metadata"),
  };
}

function options(roots, extra = {}) {
  return {
    model: MODEL,
    input: { prompt: "a red mug", resolution: "1K" },
    apiKey: "test-key",
    cacheDir: roots.cacheDir,
    config: policy,
    outputRoot: roots.outDir,
    metadataRoot: roots.metadataDir,
    sleep: async () => {},
    log: () => {},
    ...extra,
  };
}

test("blocked families never reach createTask", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi();
  await assert.rejects(
    () => runModel(options(roots, { model: "kling/v2-1-master-text-to-video", input: { prompt: "x" }, fetchFn })),
    (error) => error instanceof PolicyError && /family not allowed: video/.test(error.message),
  );
  assert.equal(calls.create, 0);
});

test("a successful run downloads to <out>/images/<model> and records real cost", async () => {
  const roots = await tempRoots();
  const { fetchFn } = makeApi();
  const result = await runModel(options(roots, { fetchFn }));

  assert.equal(result.state, "success");
  assert.equal(result.creditsConsumed, 6);
  assert.equal(result.downloaded.length, 1);
  assert.match(result.downloaded[0].path, /out\/images\/gpt-image-2-text-to-image\/.+\.png$/);

  const record = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.equal(record.credits_consumed, 6);
  assert.equal(record.cost_source, "recordInfo.creditsConsumed");
  assert.equal(record.api_family, "image");
  assert.equal(record.request.model, MODEL);
  assert.equal(record.final_response.data.state, "success");
  assert.ok(record.discovery.catalog_fetched_at);
  assert.ok(!JSON.stringify(record).includes("test-key"));
});

test("metadata is written before polling starts", async () => {
  const roots = await tempRoots();
  let filesAtFirstPoll = [];
  const { fetchFn } = makeApi({
    onRecord: async (index) => {
      if (index === 1) filesAtFirstPoll = await readdir(roots.metadataDir);
    },
  });
  await runModel(options(roots, { fetchFn }));
  assert.equal(filesAtFirstPoll.length, 1);
  assert.match(filesAtFirstPoll[0], /\.metadata\.json$/);
});

test("a queued record is overwritten with the terminal state", async () => {
  const roots = await tempRoots();
  const { fetchFn } = makeApi();
  const result = await runModel(options(roots, { fetchFn }));
  const records = (await readdir(roots.metadataDir)).filter((name) => name.endsWith(".metadata.json"));
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(path.join(roots.metadataDir, records[0]), "utf8"));
  assert.equal(record.state, "success");
  assert.equal(record.task_id, "task-1");
  assert.equal(record.metadataPath, undefined);
  assert.equal(result.taskId, "task-1");
});

test("an unknown model suggests near matches and never submits", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi();
  await assert.rejects(
    () => runModel(options(roots, { model: "gpt-image-2", fetchFn })),
    /is not in the catalog[\s\S]*Did you mean: gpt-image-2-text-to-image/,
  );
  assert.equal(calls.create, 0);
});

test("a balance below the configured floor blocks the run", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi({ balance: 5 });
  await assert.rejects(() => runModel(options(roots, { fetchFn })), /below the configured floor/);
  assert.equal(calls.create, 0);
});

test("--max-credits refuses an expensive advertised price", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi();
  await assert.rejects(() => runModel(options(roots, { fetchFn, maxCredits: 8 })), /above --max-credits 8/);
  assert.equal(calls.create, 0);
});

test("input is validated against the published schema", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi();
  await assert.rejects(
    () => runModel(options(roots, { fetchFn, input: { resolution: "4K" } })),
    /prompt is required/,
  );
  assert.equal(calls.create, 0);
});

test("a failed task records the failure and throws", async () => {
  const roots = await tempRoots();
  const { fetchFn } = makeApi({ states: [{ state: "fail", failMsg: "nsfw detected" }] });
  await assert.rejects(() => runModel(options(roots, { fetchFn })), /ended in state fail: nsfw detected/);

  const files = (await readdir(roots.metadataDir)).filter((name) => name.endsWith(".metadata.json"));
  const record = JSON.parse(await readFile(path.join(roots.metadataDir, files[0]), "utf8"));
  assert.equal(record.state, "fail");
});

test("dry runs resolve everything without creating a task", async () => {
  const roots = await tempRoots();
  const { fetchFn, calls } = makeApi();
  const result = await runModel(options(roots, { fetchFn, dryRun: true }));
  assert.equal(result.dryRun, true);
  assert.equal(calls.create, 0);
});

test("a local file path is uploaded and substituted before createTask", async () => {
  const roots = await tempRoots();
  const inputFile = path.join(roots.root, "mug.png");
  await writeFile(inputFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { fetchFn, calls } = makeApi();

  const result = await runModel(options(roots, {
    fetchFn,
    input: { prompt: "a mug", image_url: inputFile },
  }));

  assert.equal(calls.uploads, 1);
  assert.equal(calls.createPayload.input.image_url, "https://tempfile.test/uploaded.png");

  const record = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.equal(record.request.input.image_url, "https://tempfile.test/uploaded.png");
  assert.equal(record.uploads.length, 1);
  assert.ok(record.uploads[0].sourceRelative.endsWith("mug.png"));
  assert.equal(record.uploads[0].transport, "base64");
  assert.equal(record.uploads[0].downloadUrl, undefined);
});

test("a dry run reports the upload without performing it", async () => {
  const roots = await tempRoots();
  const inputFile = path.join(roots.root, "mug.png");
  await writeFile(inputFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { fetchFn, calls } = makeApi();

  const result = await runModel(options(roots, {
    fetchFn,
    dryRun: true,
    input: { prompt: "a mug", image_url: inputFile },
  }));

  assert.equal(calls.uploads, 0);
  assert.equal(result.plan.uploads.length, 1);
});

test("--upload maps an explicit field and rejects unknown fields", async () => {
  const roots = await tempRoots();
  const inputFile = path.join(roots.root, "mug.png");
  await writeFile(inputFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { fetchFn, calls } = makeApi();

  await runModel(options(roots, {
    fetchFn,
    input: { prompt: "a mug" },
    uploads: { image_url: inputFile },
  }));
  assert.equal(calls.createPayload.input.image_url, "https://tempfile.test/uploaded.png");

  await assert.rejects(
    () => runModel(options(roots, {
      fetchFn,
      input: { prompt: "a mug" },
      uploads: { nope: inputFile },
    })),
    /schema has no such input field/,
  );
});

test("extractResultUrls prefers the parsed response field and deduplicates", () => {
  const urls = extractResultUrls({
    response: { resultUrls: ["https://cdn.test/a.png", "https://cdn.test/a.png"] },
    resultJson: JSON.stringify({ resultUrls: ["https://cdn.test/b.png"] }),
  });
  assert.deepEqual(urls, ["https://cdn.test/a.png"]);
});
