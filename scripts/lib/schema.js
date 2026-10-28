import { KieError } from "./http.js";

/**
 * `$ref` targets live in the same document but their component keys are literal:
 * spaces are percent-encoded and some keys carry trailing whitespace. Decode each
 * segment, never trim.
 */
export function resolveRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new KieError(`unsupported $ref target: ${ref}`);
  }
  const segments = ref.slice(2).split("/").map((segment) => decodeURIComponent(segment));
  let cursor = document;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function deref(document, node, inProgress = new Set()) {
  if (Array.isArray(node)) return node.map((item) => deref(document, item, inProgress));
  if (node === null || typeof node !== "object") return node;

  if (typeof node.$ref === "string") {
    if (inProgress.has(node.$ref)) return { $ref: node.$ref };
    const target = resolveRef(document, node.$ref);
    if (target === undefined) throw new KieError(`unresolvable $ref: ${node.$ref}`);
    const { $ref: _ref, ...siblings } = node;
    const resolved = deref(document, target, new Set([...inProgress, node.$ref]));
    if (Object.keys(siblings).length === 0) return resolved;
    return { ...resolved, ...deref(document, siblings, inProgress) };
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = deref(document, value, inProgress);
  return out;
}

const taskPath = "/api/v1/jobs/createTask";

function pickOperation(paths) {
  const entries = Object.entries(paths ?? {});
  if (entries.length === 0) throw new KieError("schema has no paths");
  const chosen = paths[taskPath] ? [taskPath, paths[taskPath]] : entries[0];
  const [route, item] = chosen;
  const method = ["post", "get", "put"].find((verb) => item?.[verb]) ?? Object.keys(item ?? {})[0];
  const operation = item?.[method];
  if (!operation) throw new KieError(`schema path ${route} has no operation`);
  return { route, method, operation };
}

/**
 * Reduce a model's OpenAPI document to the facts a caller needs: which route,
 * whether results are polled or returned synchronously, and the exact input contract.
 */
export function inputContract(openapi) {
  if (!openapi || typeof openapi !== "object") throw new KieError("schema is not an object");
  const { route, method, operation } = pickOperation(openapi.paths);
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  if (!bodySchema) throw new KieError(`schema for ${route} has no application/json request body`);

  const resolvedBody = deref(openapi, bodySchema);
  const inputSchema = resolvedBody.properties?.input;
  if (!inputSchema) throw new KieError(`schema for ${route} has no input property`);

  const branches = inputSchema.oneOf ?? inputSchema.anyOf ?? null;
  return {
    route,
    method,
    taskBased: route === taskPath,
    bodyRequired: resolvedBody.required ?? [],
    bodyProperties: Object.keys(resolvedBody.properties ?? {}),
    inputSchema,
    inputRequired: inputSchema.required ?? [],
    inputProperties: Object.keys(inputSchema.properties ?? {}),
    oneOf: Array.isArray(branches)
      ? branches.map((branch) => ({
        required: branch.required ?? [],
        properties: Object.keys(branch.properties ?? {}),
      }))
      : null,
  };
}

const typeChecks = {
  string: (value) => typeof value === "string",
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
};

function checkShape(schema, value, errors) {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    return;
  }
  const check = typeChecks[schema.type];
  if (check && !check(value)) errors.push(`must be a ${schema.type}`);
}

function validateBranch(schema, input) {
  const errors = [];
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in input)) errors.push(`${key} is required`);
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const propertySchema = properties[key];
    if (!propertySchema) continue;
    checkShape(propertySchema, value, errors);
  }
  return errors;
}

/**
 * Validate against the published schema. Unknown keys are warnings, not errors:
 * several KIE models accept vendor-specific extras that the schema omits.
 */
export function validateInput(contract, input) {
  const errors = [];
  const warnings = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["input must be a JSON object"], warnings };
  }

  const anyBranch = contract.inputSchema.oneOf ?? contract.inputSchema.anyOf;
  if (Array.isArray(anyBranch)) {
    const branchResults = anyBranch.map((branch) => validateBranch(branch, input));
    if (!branchResults.some((result) => result.length === 0)) {
      errors.push("input does not satisfy any accepted input shape:");
      branchResults.forEach((result, index) => {
        const required = anyBranch[index].required ?? [];
        errors.push(`  shape ${index + 1} (${required.join(", ") || "no required fields"}): ${result.join("; ")}`);
      });
      return { errors, warnings };
    }
  } else {
    errors.push(...validateBranch(contract.inputSchema, input));
  }

  const known = new Set(Object.keys(contract.inputSchema.properties ?? {}));
  if (Array.isArray(anyBranch)) {
    for (const branch of anyBranch) for (const key of Object.keys(branch.properties ?? {})) known.add(key);
  }
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`${key} is not declared in the schema; sending it anyway`);
  }

  return { errors, warnings };
}

/** Best-effort only: pricing is prose, so this never gates a run on its own. */
export function parseCreditEstimate(pricingDesc) {
  if (typeof pricingDesc !== "string") return null;
  const values = [...pricingDesc.matchAll(/(\d+(?:\.\d+)?)\s*credits?/gi)].map((match) => Number(match[1]));
  return values.length > 0 ? Math.max(...values) : null;
}
