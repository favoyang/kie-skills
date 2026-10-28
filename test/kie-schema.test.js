import test from "node:test";
import assert from "node:assert/strict";
import { deref, inputContract, parseCreditEstimate, resolveRef, validateInput } from "../scripts/lib/schema.js";

const document_with_odd_keys = {
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
                      resolution: { type: "string", enum: ["1K", "2K", "4K"], default: "1K" },
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
  components: {
    schemas: {
      "response not with recordId": { type: "string" },
      "trailing ": { type: "integer" },
    },
  },
};

test("resolveRef decodes percent-encoded keys and keeps trailing whitespace", () => {
  const spaced = resolveRef(document_with_odd_keys, "#/components/schemas/response%20not%20with%20recordId");
  assert.deepEqual(spaced, { type: "string" });
  const trailing = resolveRef(document_with_odd_keys, "#/components/schemas/trailing%20");
  assert.deepEqual(trailing, { type: "integer" });
});

test("resolveRef rejects non-local refs", () => {
  assert.throws(() => resolveRef({}, "https://example.test/schema.json"), /unsupported \$ref/);
});

test("deref inlines refs and survives cycles", () => {
  const doc = {
    components: {
      schemas: {
        node: { type: "object", properties: { next: { $ref: "#/components/schemas/node" } } },
      },
    },
  };
  const resolved = deref(doc, { $ref: "#/components/schemas/node" });
  assert.equal(resolved.type, "object");
  assert.equal(resolved.properties.next.$ref, "#/components/schemas/node");
});

test("inputContract exposes route, task flag, and input schema", () => {
  const contract = inputContract(document_with_odd_keys);
  assert.equal(contract.route, "/api/v1/jobs/createTask");
  assert.equal(contract.method, "post");
  assert.equal(contract.taskBased, true);
  assert.deepEqual(contract.inputRequired, ["prompt"]);
  assert.equal(contract.inputSchema.properties.resolution.enum.join(","), "1K,2K,4K");
});

test("validateInput reports missing required fields and bad enums", () => {
  const contract = inputContract(document_with_odd_keys);
  const missing = validateInput(contract, {});
  assert.equal(missing.errors[0], "prompt is required");

  const badEnum = validateInput(contract, { prompt: "x", resolution: "8K" });
  assert.match(badEnum.errors[0], /must be one of "1K", "2K", "4K"/);
});

test("validateInput warns on undeclared keys instead of failing", () => {
  const contract = inputContract(document_with_odd_keys);
  const result = validateInput(contract, { prompt: "x", aspect_ratio: "1:1" });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /aspect_ratio is not declared/);
});

test("validateInput accepts any oneOf branch that is satisfied", () => {
  const contract = inputContract({
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
                      oneOf: [
                        { required: ["task_id"], properties: { task_id: { type: "string" } } },
                        { required: ["image_url"], properties: { image_url: { type: "string" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(contract.oneOf.length, 2);
  assert.deepEqual(validateInput(contract, { image_url: "https://x.test/a.png" }).errors, []);
  const neither = validateInput(contract, { prompt: "x" });
  assert.match(neither.errors[0], /does not satisfy any accepted input shape/);
});

test("inputContract refuses schemas without a JSON body", () => {
  assert.throws(() => inputContract({ paths: { "/x": { get: {} } } }), /no application\/json request body/);
});

test("parseCreditEstimate takes the highest quoted credit value", () => {
  assert.equal(parseCreditEstimate("6 credits ($0.03) for 1 K, 10 credits for 2 K, 16 credits for 4 K"), 16);
  assert.equal(parseCreditEstimate("A 5-second video costs 160 credits, a 10-second video costs 320 credits"), 320);
  assert.equal(parseCreditEstimate("pricing on request"), null);
  assert.equal(parseCreditEstimate(null), null);
});
