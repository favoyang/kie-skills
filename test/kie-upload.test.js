import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  applyUploads,
  detectUploads,
  explicitUploads,
  isHttpUrl,
  mediaKind,
  performUploads,
  uploadPathFor,
  uploadRecords,
} from "../scripts/lib/upload.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function fixture(name = "input.png", bytes = 8) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kie-upload-"));
  const file = path.join(dir, name);
  await writeFile(file, Buffer.alloc(bytes, 1));
  return { dir, file };
}

test("media kind and upload path come from the file extension", () => {
  assert.equal(mediaKind("a.png"), "image");
  assert.equal(mediaKind("a.MP4"), "video");
  assert.equal(mediaKind("a.mp3"), "audio");
  assert.equal(mediaKind("a.txt"), null);
  assert.equal(uploadPathFor("image"), "images/user-uploads");
  assert.equal(uploadPathFor("video"), "video/user-uploads");
  assert.equal(uploadPathFor(null), "files/user-uploads");
  assert.equal(isHttpUrl("https://x/y.png"), true);
});

test("remote URLs are passed through untouched", async () => {
  const { uploads, errors } = await detectUploads({ image_url: "https://cdn.test/a.png" });
  assert.deepEqual(uploads, []);
  assert.deepEqual(errors, []);
});

test("plain prompt text is not mistaken for a path", async () => {
  const { uploads, errors } = await detectUploads({ prompt: "a red ceramic mug on a light oak table" });
  assert.deepEqual(uploads, []);
  assert.deepEqual(errors, []);
});

test("a scalar local file in a media field becomes an upload", async () => {
  const { dir, file } = await fixture();
  const { uploads, errors } = await detectUploads({ image_url: file }, { cwd: dir });
  assert.deepEqual(errors, []);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].field, "image_url");
  assert.equal(uploads[0].kind, "image");
  assert.equal(uploads[0].uploadPath, "images/user-uploads");
  assert.equal(uploads[0].sourceRelative, "input.png");
});

test("array fields produce one upload per local entry with indexes", async () => {
  const { dir } = await fixture("one.png");
  await writeFile(path.join(dir, "two.png"), Buffer.alloc(4, 2));
  const { uploads } = await detectUploads(
    { input_urls: ["one.png", "https://cdn.test/keep.png", "two.png"] },
    { cwd: dir },
  );
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map((upload) => upload.index), [0, 2]);
});

test("a local file in a non-media field is refused, not sent as text", async () => {
  const { dir, file } = await fixture();
  const { uploads, errors } = await detectUploads({ prompt: file }, { cwd: dir });
  assert.equal(uploads.length, 0);
  assert.match(errors[0], /does not look like a media reference/);
});

test("a path-shaped value that does not exist is reported", async () => {
  const { uploads, errors } = await detectUploads({ image_url: "./missing.png" }, { cwd: os.tmpdir() });
  assert.equal(uploads.length, 0);
  assert.match(errors[0], /file does not exist/);
});

test("base64 transport posts the documented body and returns the download url", async () => {
  const { dir, file } = await fixture("in.png", 8);
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ success: true, code: 200, data: { downloadUrl: "https://tempfile.test/in.png", filePath: "images/user-uploads/in.png" } });
  };
  const { uploads } = await detectUploads({ image_url: file }, { cwd: dir });
  const [result] = await performUploads(uploads, { apiKey: "k", fetchFn: fetchMock });

  assert.equal(calls[0].url, "https://kieai.redpandaai.co/api/file-base64-upload");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.uploadPath, "images/user-uploads");
  assert.equal(body.fileName, "in.png");
  assert.equal(body.base64Data, Buffer.alloc(8, 1).toString("base64"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.equal(result.transport, "base64");
  assert.equal(result.downloadUrl, "https://tempfile.test/in.png");
});

test("files above the base64 threshold use multipart streaming", async () => {
  const { dir, file } = await fixture("big.png", 64);
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ success: true, code: 200, data: { downloadUrl: "https://tempfile.test/big.png" } });
  };
  const { uploads } = await detectUploads({ image_url: file }, { cwd: dir });
  const [result] = await performUploads(uploads, { apiKey: "k", fetchFn: fetchMock, maxBase64Bytes: 16 });

  assert.equal(calls[0].url, "https://kieai.redpandaai.co/api/file-stream-upload");
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  assert.equal(result.transport, "stream");
});

test("an upload rejected in the body is treated as a failure", async () => {
  const { dir, file } = await fixture();
  const { uploads } = await detectUploads({ image_url: file }, { cwd: dir });
  await assert.rejects(
    () => performUploads(uploads, {
      apiKey: "k",
      fetchFn: async () => jsonResponse({ success: false, code: 401, msg: "Unauthorized" }),
    }),
    /KIE code 401/,
  );
});

test("applyUploads replaces scalars and array entries without mutating the input", async () => {
  const input = { prompt: "x", image_url: "./a.png", input_urls: ["./b.png", "https://keep.test/c.png"] };
  const results = [
    { field: "image_url", index: undefined, downloadUrl: "https://temp.test/a.png" },
    { field: "input_urls", index: 0, downloadUrl: "https://temp.test/b.png" },
  ];
  const next = applyUploads(input, results);
  assert.equal(next.image_url, "https://temp.test/a.png");
  assert.deepEqual(next.input_urls, ["https://temp.test/b.png", "https://keep.test/c.png"]);
  assert.equal(input.image_url, "./a.png");
});

test("metadata records keep the source but drop the ephemeral upload url", async () => {
  const records = uploadRecords([
    { field: "image_url", index: undefined, sourceRelative: "a.png", downloadUrl: "https://temp.test/a.png", bytes: 8 },
  ]);
  assert.equal(records[0].downloadUrl, undefined);
  assert.equal(records[0].sourceRelative, "a.png");
  assert.equal(records[0].expiresAfterHours, 24);
});

test("explicit uploads report missing files instead of throwing mid-run", async () => {
  const { uploads, errors } = await explicitUploads({ image_url: "./nope.png" }, { cwd: os.tmpdir() });
  assert.equal(uploads.length, 0);
  assert.match(errors[0], /file not found/);
});
