import test from "node:test";
import assert from "node:assert/strict";
import { findModel, classifyModel, familyOf, assertModelAllowed, assertBalance, assertWithinMaxCredits, PolicyError } from "../scripts/lib/policy.js";

const policy = {
  version: 1,
  allowedFamilies: ["image", "music", "speech"],
  familyTaskTypes: {
    image: ["Text to Image", "Image to Image", "Image Editing"],
    music: ["Text to Music", "Audio to Audio"],
    speech: ["Text to Speech"],
    video: ["Text to Video", "Image to Video", "Lip Sync"],
    chat: ["Chat"],
  },
  minBalance: 20,
};

test("familyOf maps catalog task types onto configured families", () => {
  assert.equal(familyOf("Text to Image", policy), "image");
  assert.equal(familyOf("Lip Sync", policy), "video");
  assert.equal(familyOf("Hologram to Smell", policy), null);
});

test("classifyModel allows image and blocks video", () => {
  assert.equal(classifyModel({ taskType: ["Text to Image"] }, policy).allowed, true);
  const video = classifyModel({ taskType: ["Text to Video"] }, policy);
  assert.equal(video.allowed, false);
  assert.match(video.reason, /family not allowed: video/);
});

test("classifyModel blocks an unmapped task type by default", () => {
  const verdict = classifyModel({ taskType: ["Image to Music"] }, policy);
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.unmapped, ["Image to Music"]);
  assert.match(verdict.reason, /unmapped task type/);
});

test("classifyModel blocks mixed-family models", () => {
  const verdict = classifyModel({ taskType: ["Text to Image", "Text to Video"] }, policy);
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.families, ["image", "video"]);
});

test("classifyModel blocks entries with no taskType", () => {
  const verdict = classifyModel({}, policy);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /no taskType/);
});

test("assertModelAllowed throws PolicyError for blocked models", () => {
  assert.throws(
    () => assertModelAllowed("kling/v2-1-master-text-to-video", { taskType: ["Text to Video"] }, policy),
    (error) => error instanceof PolicyError && /blocked/.test(error.message),
  );
});

test("findModel suggests near matches instead of guessing", () => {
  const models = [
    { model: "gpt-image-2-text-to-image" },
    { model: "gpt-image-2-image-to-image" },
    { model: "veo-3-1" },
  ];
  assert.equal(findModel(models, "veo-3-1").entry.model, "veo-3-1");
  const missing = findModel(models, "gpt-image-2");
  assert.equal(missing.entry, null);
  assert.ok(missing.suggestions.includes("gpt-image-2-text-to-image"));
});

test("assertBalance enforces the configured floor", () => {
  assert.doesNotThrow(() => assertBalance(20, policy));
  assert.throws(() => assertBalance(19.9, policy), /below the configured floor/);
});

test("assertWithinMaxCredits is off by default and refuses unknown prices when set", () => {
  assert.doesNotThrow(() => assertWithinMaxCredits(999, null, "m"));
  assert.doesNotThrow(() => assertWithinMaxCredits(16, 20, "m"));
  assert.throws(() => assertWithinMaxCredits(320, 20, "m"), /above --max-credits 20/);
  assert.throws(() => assertWithinMaxCredits(null, 20, "m"), /could not be parsed/);
});
