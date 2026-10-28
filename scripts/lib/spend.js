import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

/**
 * Spend is derived from run metadata rather than a separate ledger file: one
 * write path means there is nothing to reconcile when a run crashes.
 */
const FAILURE_STATES = new Set(["fail", "failed", "error"]);

export function spendFromRecord(record, metadataPath = "") {
  const consumedRaw = record?.credits_consumed ?? record?.final_response?.data?.creditsConsumed ?? null;
  const estimatedRaw = record?.credits_estimated ?? record?.credits_estimate ?? null;
  const consumed = typeof consumedRaw === "number" ? consumedRaw : null;
  const estimated = typeof estimatedRaw === "number" ? estimatedRaw : null;
  const stateRaw = record?.state ?? record?.final_response?.data?.state ?? record?.final_response?.data?.status ?? null;
  return {
    metadataPath,
    timestamp: record?.timestamp ?? null,
    model: record?.request?.model ?? record?.final_response?.data?.model ?? "unknown",
    family: record?.api_family ?? "unknown",
    state: typeof stateRaw === "string" ? stateRaw.toLowerCase() : "unknown",
    consumed,
    estimated,
  };
}

export function summarizeSpend(rows) {
  const summary = { runs: rows.length, consumed: 0, estimated: 0, unreported: 0, failed: 0, byModel: {} };
  for (const row of rows) {
    if (row.consumed !== null) {
      summary.consumed += row.consumed;
    } else if (row.estimated !== null) {
      summary.estimated += row.estimated;
      summary.unreported += 1;
    } else {
      summary.unreported += 1;
    }
    if (FAILURE_STATES.has(row.state)) summary.failed += 1;
    const key = row.model;
    summary.byModel[key] ??= { runs: 0, consumed: 0, estimated: 0 };
    summary.byModel[key].runs += 1;
    if (row.consumed !== null) summary.byModel[key].consumed += row.consumed;
    else if (row.estimated !== null) summary.byModel[key].estimated += row.estimated;
  }
  return summary;
}

export async function readSpend({ directories = [], since = null } = {}) {
  const rows = [];
  for (const directory of directories) {
    let names = [];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".metadata.json"))) {
      const fullPath = path.join(directory, name);
      try {
        const record = JSON.parse(await readFile(fullPath, "utf8"));
        if (since && record.timestamp && Date.parse(record.timestamp) < since) continue;
        rows.push(spendFromRecord(record, fullPath));
      } catch {
        // ignore unreadable metadata; a broken file should not hide the rest
      }
    }
  }
  return rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}
