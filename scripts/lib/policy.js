import { KieError } from "./http.js";

export class PolicyError extends KieError {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

export function familyOf(taskType, policy) {
  for (const [family, types] of Object.entries(policy.familyTaskTypes)) {
    if (types.includes(taskType)) return family;
  }
  return null;
}

/**
 * A model is allowed only when every task type it advertises maps to a family
 * and every one of those families is enabled. Mixed-family models
 * (e.g. Text to Image + Text to Video) are therefore blocked, which is the
 * conservative direction for a spend guard.
 */
export function classifyModel(entry, policy) {
  const taskTypes = Array.isArray(entry?.taskType) ? entry.taskType : [];
  const mapped = taskTypes.map((type) => familyOf(type, policy));
  const families = [...new Set(mapped.filter(Boolean))];
  const unmapped = taskTypes.filter((_type, index) => mapped[index] === null);
  const disabled = families.filter((family) => !policy.allowedFamilies.includes(family));

  let allowed = true;
  let reason = null;
  if (taskTypes.length === 0) {
    allowed = false;
    reason = "catalog entry advertises no taskType";
  } else if (unmapped.length > 0) {
    allowed = false;
    reason = `unmapped task type: ${unmapped.join(", ")} (add it to config/models.policy.json to enable)`;
  } else if (disabled.length > 0) {
    allowed = false;
    reason = `family not allowed: ${disabled.join(", ")} (allowed: ${policy.allowedFamilies.join(", ")})`;
  }

  return {
    allowed,
    reason,
    family: families[0] ?? null,
    families,
    unmapped,
    taskTypes,
  };
}

export function findModel(models, modelId) {
  const exact = models.find((entry) => entry.model === modelId);
  if (exact) return { entry: exact, suggestions: [] };
  const needle = String(modelId).toLowerCase();
  const suggestions = models
    .filter((entry) => entry.model.toLowerCase().includes(needle)
      || needle.includes(entry.model.toLowerCase().split("/").pop()))
    .slice(0, 8)
    .map((entry) => entry.model);
  return { entry: null, suggestions };
}

export function assertModelAllowed(modelId, entry, policy) {
  const verdict = classifyModel(entry, policy);
  if (!verdict.allowed) {
    throw new PolicyError(`model ${modelId} is blocked: ${verdict.reason}`);
  }
  return verdict;
}

export function assertBalance(balance, policy) {
  const floor = policy.minBalance ?? 0;
  if (balance < floor) {
    throw new PolicyError(
      `balance ${balance} credits is below the configured floor of ${floor} (config/models.policy.json minBalance)`,
    );
  }
}

export function assertWithinMaxCredits(estimate, maxCredits, modelId) {
  if (maxCredits === null || maxCredits === undefined) return;
  if (estimate === null) {
    throw new PolicyError(
      `--max-credits ${maxCredits} was set but the advertised price for ${modelId} could not be parsed; refusing to guess`,
    );
  }
  if (estimate > maxCredits) {
    throw new PolicyError(
      `advertised price for ${modelId} is up to ${estimate} credits, above --max-credits ${maxCredits}`,
    );
  }
}
