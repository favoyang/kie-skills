import test from "node:test";
import assert from "node:assert/strict";
import { KieError, extensionFor, kieRequest, safeUrl } from "../scripts/lib/http.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("kieRequest rejects a body-level failure even when HTTP is 200", async () => {
  const fetchMock = async () => jsonResponse({ code: 401, msg: "Unauthorized", data: null });
  await assert.rejects(
    () => kieRequest(fetchMock, { url: "https://api.kie.ai/x", apiKey: "k" }),
    (error) => error instanceof KieError && error.code === 401 && /KIE code 401/.test(error.message),
  );
});

test("kieRequest rejects insufficient credits instead of returning data", async () => {
  const fetchMock = async () => jsonResponse({ code: 402, msg: "Insufficient Credits" });
  await assert.rejects(() => kieRequest(fetchMock, { url: "https://api.kie.ai/x", apiKey: "k" }), /KIE code 402/);
});

test("kieRequest surfaces HTTP failures and network errors", async () => {
  await assert.rejects(
    () => kieRequest(async () => new Response("nope", { status: 500 }), { url: "https://api.kie.ai/x", apiKey: "k" }),
    /HTTP 500/,
  );
  await assert.rejects(
    () => kieRequest(async () => { throw new Error("ECONNRESET"); }, { url: "https://api.kie.ai/x", apiKey: "k" }),
    /network error calling https:\/\/api\.kie\.ai\/x/,
  );
});

test("kieRequest never puts the api key in messages", async () => {
  const fetchMock = async () => {
    throw new Error("boom");
  };
  await assert.rejects(
    () => kieRequest(fetchMock, { url: "https://api.kie.ai/x?token=secret", apiKey: "super-secret" }),
    (error) => !error.message.includes("super-secret") && !error.message.includes("secret"),
  );
});

test("kieRequest requires a key before calling the network", async () => {
  let called = false;
  await assert.rejects(
    () => kieRequest(async () => { called = true; }, { url: "https://api.kie.ai/x", apiKey: "" }),
    /KIE_API_KEY is not set/,
  );
  assert.equal(called, false);
});

test("safeUrl keeps origin and path, drops the query string", () => {
  assert.equal(safeUrl("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=abc"), "https://api.kie.ai/api/v1/jobs/recordInfo");
});

test("extensionFor prefers the URL suffix and falls back to content type", () => {
  assert.equal(extensionFor("image/png", "https://cdn.test/a.png"), ".png");
  assert.equal(extensionFor("image/webp", "https://cdn.test/download"), ".webp");
  assert.equal(extensionFor(null, "https://cdn.test/download"), ".bin");
});
