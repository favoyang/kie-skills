export function utcStamp(date = new Date()) {
  const compact = date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
  return `${compact.slice(0, 8)}-${compact.slice(9)}`;
}

export function slugify(value, maxLength = 48, fallback = "kie-run") {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (slug || fallback).slice(0, maxLength).replace(/-$/g, "");
}

export function modelSlug(model) {
  return slugify(String(model ?? "").split("/").join("-"), 48, "kie-model");
}

export function formatCredits(value, creditsPerUsd = 0.005) {
  const credits = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(credits)) return "unknown";
  return `${credits} credits (~$${(credits * creditsPerUsd).toFixed(3)})`;
}
