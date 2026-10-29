import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint, parseArgs, uploadMap } from "../scripts/cli.js";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.js");

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

test("parseArgs collects repeated flags instead of overwriting them", () => {
  const { positionals, flags } = parseArgs([
    "run", "some/model", "--input", "{}",
    "--upload", "image_url=./a.png",
    "--upload", "video_url=./b.mp4",
  ]);
  assert.deepEqual(positionals, ["run", "some/model"]);
  assert.equal(flags.input, "{}");
  assert.deepEqual(flags.upload, ["image_url=./a.png", "video_url=./b.mp4"]);
});

test("uploadMap turns repeated flags into a field mapping", () => {
  assert.equal(uploadMap(undefined), null);
  assert.deepEqual(uploadMap("image_url=./a.png"), { image_url: "./a.png" });
  assert.deepEqual(uploadMap(["image_url=./a.png", "video_url=./b.mp4"]), {
    image_url: "./a.png",
    video_url: "./b.mp4",
  });
  assert.throws(() => uploadMap("image_url"), /expects field=path/);
});

test("the CLI entry point loads and prints usage without a key", () => {
  const stdout = runCli([]);
  assert.match(stdout, /usage: kie <command>/);
});

test("an unknown command exits non-zero", () => {
  try {
    runCli(["not-a-command"]);
    assert.fail("expected a non-zero exit");
  } catch (error) {
    assert.equal(error.status, 2);
  }
});

test("the info command runs standalone and reports resolved paths", () => {
  const info = JSON.parse(runCli(["info"]));
  assert.ok(info.projectDir);
  assert.ok(["cwd", "marker", "env"].includes(info.projectSource));
  assert.equal(info.outDir, path.join(info.projectDir, "kie-output"));
});

test("plan and run fail on a missing key before touching uploads", () => {
  const env = { ...process.env };
  delete env.KIE_API_KEY;
  try {
    runCli(["run", "gpt-image-2-text-to-image", "--input", "{}", "--upload", "image_url=./a.png"], { env });
    assert.fail("expected a non-zero exit");
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /KIE_API_KEY is not set/);
  }
});

test("the entry-point guard is path-aware instead of string-concatenated", () => {
  const here = fileURLToPath(import.meta.url);
  assert.equal(isEntryPoint(pathToFileURL(here).href, here), true);
  assert.equal(isEntryPoint(import.meta.url, here), true);
  assert.equal(isEntryPoint(import.meta.url, path.join(path.dirname(here), "other.js")), false);
  assert.equal(isEntryPoint(import.meta.url, undefined), false);
});
