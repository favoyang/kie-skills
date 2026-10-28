import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fetchBalance, loadCatalog, loadSchema } from "../scripts/lib/discovery.js";

const HOUR = 60 * 60 * 1000;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "kie-discovery-"));
}

const catalogBody = {
  code: 200,
  msg: "success",
  data: {
    total: 1,
    models: [{ model: "gpt-image-2-text-to-image", taskType: ["Text to Image"], pricingDesc: "6 credits" }],
  },
};

test("catalog is fetched once and reused inside the TTL", async () => {
  const cacheDir = await tempDir();
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(String(url));
    return jsonResponse(catalogBody);
  };

  const first = await loadCatalog({ apiKey: "k", fetchFn: fetchMock, cacheDir, log: () => {} });
  const second = await loadCatalog({ apiKey: "k", fetchFn: fetchMock, cacheDir, log: () => {} });

  assert.equal(urls.length, 1);
  assert.equal(first.source, "network");
  assert.equal(second.source, "cache");
  assert.equal(second.models.length, 1);
  assert.equal(urls[0], "https://api.kie.ai/api/v1/models");
});

test("catalog refreshes when the TTL expires or --refresh is passed", async () => {
  const cacheDir = await tempDir();
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    return jsonResponse(catalogBody);
  };

  await loadCatalog({ apiKey: "k", fetchFn: fetchMock, cacheDir, log: () => {} });
  await loadCatalog({ apiKey: "k", fetchFn: fetchMock, cacheDir, now: Date.now() + 25 * HOUR, log: () => {} });
  assert.equal(calls, 2);

  await loadCatalog({ apiKey: "k", fetchFn: fetchMock, cacheDir, refresh: true, log: () => {} });
  assert.equal(calls, 3);
});

test("a failed refresh falls back to the stale catalog", async () => {
  const cacheDir = await tempDir();
  await loadCatalog({ apiKey: "k", fetchFn: async () => jsonResponse(catalogBody), cacheDir, log: () => {} });

  const stale = await loadCatalog({
    apiKey: "k",
    fetchFn: async () => { throw new Error("offline"); },
    cacheDir,
    refresh: true,
    log: () => {},
  });

  assert.equal(stale.stale, true);
  assert.equal(stale.source, "stale-cache");
  assert.equal(stale.models.length, 1);
});

test("a failed first fetch throws instead of inventing a catalog", async () => {
  const cacheDir = await tempDir();
  await assert.rejects(
    () => loadCatalog({ apiKey: "k", fetchFn: async () => { throw new Error("offline"); }, cacheDir, log: () => {} }),
    /offline/,
  );
});

test("schema URLs keep slashes literal for two-segment model ids", async () => {
  const cacheDir = await tempDir();
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(String(url));
    return jsonResponse({ code: 200, data: { openapi: { paths: {} } } });
  };

  await loadSchema("wan/v2-2-t2v", { apiKey: "k", fetchFn: fetchMock, cacheDir, log: () => {} });
  assert.equal(urls[0], "https://api.kie.ai/api/v1/models/wan/v2-2-t2v/schema");
  assert.ok(!urls[0].includes("%2F"));
});

test("a model without a published schema fails with a clear message", async () => {
  const cacheDir = await tempDir();
  await assert.rejects(
    () => loadSchema("brand-new/model", {
      apiKey: "k",
      fetchFn: async () => jsonResponse({ code: 200, data: { openapi: null } }),
      cacheDir,
      log: () => {},
    }),
    /no published schema yet/,
  );
});

test("fetchBalance returns the numeric balance and rejects malformed payloads", async () => {
  const balance = await fetchBalance({ apiKey: "k", fetchFn: async () => jsonResponse({ code: 200, data: 1994.5 }) });
  assert.equal(balance, 1994.5);

  await assert.rejects(
    () => fetchBalance({ apiKey: "k", fetchFn: async () => jsonResponse({ code: 200, data: "lots" }) }),
    /numeric data field/,
  );
});
