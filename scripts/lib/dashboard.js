import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { assetKind, assetUrl, contentType, readFeedItems, resolveAssetPath } from "./feed.js";

const usdPerKieCredit = 0.005;
const PAGE_TITLE = "KIE Generations";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonBlock(value) {
  if (value == null || (typeof value === "object" && Object.keys(value).length === 0)) {
    return "<span class=\"muted\">none</span>";
  }
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function formatCredits(value) {
  if (value == null) return "unknown";
  const credits = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(credits)) return String(value);
  return `${credits} / $${(credits * usdPerKieCredit).toFixed(3)}`;
}

/** Media length, kept in mm:ss because it labels the player. */
function formatLength(value) {
  const seconds = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const wholeMinutes = Math.floor(seconds / 60);
  const remaining = seconds - wholeMinutes * 60;
  return wholeMinutes > 0 ? `${wholeMinutes}:${remaining.toFixed(1).padStart(4, "0")}` : `${remaining.toFixed(1)}s`;
}

/** Elapsed time is reported in seconds, never milliseconds. */
export function formatElapsed(valueMs) {
  const ms = typeof valueMs === "number" ? valueMs : Number.parseFloat(String(valueMs ?? ""));
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`;
  const wholeMinutes = Math.floor(seconds / 60);
  const remaining = seconds - wholeMinutes * 60;
  return `${wholeMinutes}m ${remaining.toFixed(1)}s`;
}

function mediaLengthSeconds(assets) {
  for (const asset of assets) {
    if (!asset.path || asset.durationSeconds == null) continue;
    const kind = assetKind(asset.path);
    if (kind === "audio" || kind === "video") return asset.durationSeconds;
  }
  return null;
}

function hasTimedMedia(assets) {
  return assets.some((asset) => asset.path && ["audio", "video"].includes(assetKind(asset.path)));
}

function renderAssetCaption(asset, label) {
  const duration = asset.durationSeconds == null ? "" : `<span class="asset-meta">Length ${escapeHtml(formatLength(asset.durationSeconds))}</span>`;
  return `<figcaption><span>${label}</span>${duration}</figcaption>`;
}

function renderAsset(asset) {
  if (!asset.path) return "";
  const kind = assetKind(asset.path);
  const url = assetUrl(asset.path);
  const label = escapeHtml(asset.path);
  if (kind === "image") {
    return `<figure><a href="${url}"><img src="${url}" alt="${label}" loading="lazy"></a>${renderAssetCaption(asset, label)}</figure>`;
  }
  if (kind === "audio") {
    return `<figure><audio src="${url}" controls preload="none"></audio>${renderAssetCaption(asset, label)}</figure>`;
  }
  if (kind === "video") {
    return `<figure><video src="${url}" controls preload="none"></video>${renderAssetCaption(asset, label)}</figure>`;
  }
  return `<p><a href="${url}">${label}</a></p>`;
}

async function renderTextAsset(asset, context) {
  if (!asset.path) return "";
  const requested = resolveAssetPath(asset.path, context);
  const label = escapeHtml(asset.path);
  if (!requested) return `<p><a href="${assetUrl(asset.path)}">${label}</a></p>`;
  try {
    const text = await readFile(requested, "utf8");
    return `<figure class="text-asset"><figcaption>${label}</figcaption><pre>${escapeHtml(text)}</pre></figure>`;
  } catch {
    return `<p><a href="${assetUrl(asset.path)}">${label}</a></p>`;
  }
}

function renderReferenceImage(image) {
  const rawUrl = image.path ? assetUrl(image.path) : image.url;
  if (!rawUrl) return "";
  const label = escapeHtml(image.path ?? image.url ?? "reference image");
  const href = escapeHtml(rawUrl);
  return `<figure class="reference-image"><a href="${href}"><img src="${href}" alt="${label}" loading="lazy"></a><figcaption>${label}</figcaption></figure>`;
}

function renderLocalTime(timestamp) {
  const value = escapeHtml(timestamp);
  return `<span class="time-stack"><time class="local-time" datetime="${value}">${value}</time><span class="time-since" data-timestamp="${value}"></span></span>`;
}

function renderSummaryTitle(item) {
  const titleSuffix = item.title ? ` | ${item.title}` : "";
  return `${escapeHtml(item.family)} <span>${escapeHtml(item.mode)}${escapeHtml(titleSuffix)}</span>`;
}

export async function renderItem(item, index = 0, context = {}) {
  const textAssets = await Promise.all(item.textAssets.map((asset) => renderTextAsset(asset, context)));
  const isExpanded = index < 3;
  const lengthSeconds = mediaLengthSeconds(item.downloaded);
  const showLength = hasTimedMedia(item.downloaded);
  const lengthTile = showLength
    ? `<div><span>Song Length</span><strong>${escapeHtml(formatLength(lengthSeconds))}</strong></div>`
    : "";
  return `
    <article class="feed-item">
      <details class="feed-toggle"${isExpanded ? " open" : ""}>
        <summary>
          <span class="summary-main">
            <span class="summary-title">${renderSummaryTitle(item)}</span>
            <span class="summary-subtitle">${renderLocalTime(item.timestamp)} · ${escapeHtml(item.provider)} · ${escapeHtml(item.model)}</span>
          </span>
          <span class="summary-meta">
            <span>${escapeHtml(formatCredits(item.creditsConsumed))}</span>
            <strong class="state state-${escapeHtml(item.state.toLowerCase())}">${escapeHtml(item.state)}</strong>
          </span>
        </summary>
        <div class="feed-body">
          <section class="prompt">
            <h3>Prompt</h3>
            <p>${escapeHtml(item.prompt || "No prompt recorded")}</p>
          </section>
          <section>
            <h3>Other Input</h3>
            ${jsonBlock(item.otherInputs)}
          </section>
          ${item.referenceImages.length > 0 ? `
          <section class="reference-images">
            <h3>Reference Images</h3>
            <div class="reference-strip">
              ${item.referenceImages.map(renderReferenceImage).join("")}
            </div>
          </section>
          ` : ""}
          <section class="meta-grid">
            <div><span>Task</span><strong>${escapeHtml(item.taskId)}</strong></div>
            <div><span>Credits</span><strong>${escapeHtml(formatCredits(item.creditsConsumed))}</strong></div>
            ${lengthTile}
            <div><span>Time</span><strong>${escapeHtml(formatElapsed(item.timeToResponseMs))}</strong></div>
            <div><span>Retry</span><strong>${escapeHtml(item.retryTime ?? "unknown")}</strong></div>
          </section>
          <section class="assets">
            <h3>Output Assets</h3>
            ${item.downloaded.length > 0 ? item.downloaded.map(renderAsset).join("") : "<p class=\"muted\">No local assets recorded.</p>"}
          </section>
          ${item.textAssets.length > 0 ? `
          <section class="text-assets">
            <h3>Text Assets</h3>
            ${textAssets.join("")}
          </section>
          ` : ""}
          <details class="metadata-toggle">
            <summary>Metadata</summary>
            <p><code>${escapeHtml(item.metadataPath)}</code></p>
          </details>
        </div>
      </details>
    </article>
  `;
}

export async function renderPage(items, context = {}) {
  const renderedItems = await Promise.all(items.map((item, index) => renderItem(item, index, context)));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(PAGE_TITLE)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #20242a; }
    * { box-sizing: border-box; }
    html, body { margin: 0; max-width: 100%; overflow-x: hidden; }
    main { width: min(1120px, 100%); margin: 0 auto; padding: 28px 18px 48px; }
    .topbar { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 20px; min-width: 0; }
    h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 0; letter-spacing: 0; }
    h2 span { font-weight: 500; color: #59616d; }
    h3 { font-size: 12px; text-transform: uppercase; color: #68717d; margin: 0 0 8px; letter-spacing: .04em; }
    p { line-height: 1.5; overflow-wrap: anywhere; }
    .muted { color: #68717d; margin: 0; }
    .feed { display: grid; gap: 16px; min-width: 0; }
    .feed-item { min-width: 0; background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 1px 2px rgb(22 29 37 / 5%); overflow: hidden; }
    .feed-toggle { margin: 0; color: inherit; }
    .feed-toggle > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 18px; cursor: pointer; min-width: 0; list-style-position: inside; }
    .feed-toggle > summary::marker { color: #68717d; }
    .summary-main { display: grid; gap: 4px; min-width: 0; }
    .summary-title { font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
    .summary-title span { font-weight: 500; color: #59616d; }
    .summary-subtitle { color: #68717d; font-size: 13px; overflow-wrap: anywhere; }
    .time-stack { display: inline-flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
    .time-since { color: #344054; font-weight: 600; }
    .summary-meta { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; color: #4b5563; font-size: 13px; }
    .feed-body { padding: 0 18px 18px; }
    .state { flex: 0 0 auto; align-self: start; border-radius: 999px; padding: 5px 10px; background: #edf1f5; color: #344054; font-size: 12px; }
    .state-success { background: #e7f6ed; color: #137333; }
    .state-fail, .state-error { background: #fde8e8; color: #b42318; }
    .prompt { border-left: 3px solid #2962ff; padding-left: 12px; }
    pre { max-width: 100%; margin: 0; padding: 12px; overflow-x: auto; background: #f4f6f8; border-radius: 6px; font-size: 13px; }
    code { background: #f4f6f8; padding: 2px 5px; border-radius: 4px; overflow-wrap: anywhere; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
    .meta-grid div { background: #f7f8fa; border: 1px solid #e6e9ee; border-radius: 6px; padding: 10px; min-width: 0; }
    .meta-grid span { display: block; color: #68717d; font-size: 12px; margin-bottom: 4px; }
    .meta-grid strong { display: block; overflow-wrap: anywhere; font-size: 13px; }
    .assets { display: grid; gap: 10px; min-width: 0; }
    .text-assets { display: grid; gap: 10px; margin-top: 16px; min-width: 0; }
    .text-asset pre { white-space: pre-wrap; max-height: 360px; overflow: auto; }
    .reference-images { margin-top: 16px; }
    .reference-strip { display: flex; flex-wrap: wrap; gap: 10px; min-width: 0; }
    .reference-image { width: 156px; }
    .reference-image img { width: 156px; height: 156px; object-fit: contain; }
    figure { margin: 0; min-width: 0; max-width: 100%; }
    img, video { display: block; width: auto; max-width: 100%; max-height: 520px; border-radius: 6px; border: 1px solid #dfe3e8; background: #f6f7f9; }
    audio { width: 100%; }
    figcaption { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: #68717d; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
    figcaption > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .asset-meta { flex: 0 0 auto; border-radius: 999px; background: #edf1f5; color: #344054; padding: 2px 7px; }
    details { margin-top: 14px; color: #4b5563; }
    .feed-toggle, .metadata-toggle { margin-top: 0; }
    .metadata-toggle { margin-top: 14px; }
    @media (max-width: 760px) {
      .topbar { display: block; }
      .feed-toggle > summary { align-items: flex-start; }
      .summary-meta { align-items: flex-end; flex-direction: column; gap: 6px; }
      .meta-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="topbar">
      <div>
        <h1>${escapeHtml(PAGE_TITLE)}</h1>
        <p class="muted">${items.length} item${items.length === 1 ? "" : "s"} · newest first</p>
      </div>
    </section>
    <section class="feed">
      ${items.length > 0 ? renderedItems.join("") : "<p class=\"muted\">No metadata files found yet. Run a generation first.</p>"}
    </section>
  </main>
  <script>
    (() => {
      const resetMedia = (element) => {
        element.pause();
        if (element.readyState > 0) {
          try { element.currentTime = 0; } catch {}
        }
      };
      const bindMedia = () => {
        document.querySelectorAll("audio, video").forEach((element) => {
          resetMedia(element);
          element.addEventListener("loadedmetadata", () => {
            try { element.currentTime = 0; } catch {}
          }, { once: true });
          element.addEventListener("play", () => {
            document.querySelectorAll("audio, video").forEach((other) => {
              if (other !== element) other.pause();
            });
          });
        });
      };
      const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      const relativeUnits = [
        ["year", 31536000],
        ["month", 2592000],
        ["week", 604800],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
        ["second", 1],
      ];
      const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
      const localFormatter = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: browserTimeZone,
      });
      const formatSince = (date) => {
        const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
        const absSeconds = Math.abs(diffSeconds);
        const [unit, secondsPerUnit] = relativeUnits.find(([, seconds]) => absSeconds >= seconds) || ["second", 1];
        return relativeTime.format(Math.round(diffSeconds / secondsPerUnit), unit);
      };
      const updateTimes = () => {
        document.querySelectorAll(".local-time").forEach((element) => {
          const date = new Date(element.dateTime);
          if (Number.isNaN(date.getTime())) return;
          element.textContent = localFormatter.format(date) + " " + browserTimeZone;
        });
        document.querySelectorAll(".time-since").forEach((element) => {
          const raw = element.getAttribute("data-timestamp");
          const date = raw ? new Date(raw) : null;
          if (!date || Number.isNaN(date.getTime())) return;
          element.textContent = formatSince(date);
        });
      };
      window.addEventListener("pageshow", bindMedia);
      window.addEventListener("pageshow", updateTimes);
      document.addEventListener("DOMContentLoaded", bindMedia);
      document.addEventListener("DOMContentLoaded", updateTimes);
      window.setInterval(updateTimes, 60000);
    })();
  </script>
</body>
</html>`;
}

async function serveAsset(rawPath, response, context) {
  const requested = resolveAssetPath(rawPath, context);
  if (!requested) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(requested);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (!fileStat.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(requested),
    "Content-Length": String(fileStat.size),
  });
  createReadStream(requested).on("error", () => {
    if (!response.headersSent) response.writeHead(404);
    response.end("Not found");
  }).pipe(response);
}

export async function checkDashboard(context) {
  const items = await readFeedItems(context);
  const html = await renderPage(items, context);
  if (!html.includes(PAGE_TITLE)) throw new Error("HTML title missing");
  if (items.length > 0 && !html.includes("Output Assets")) throw new Error("feed content missing");
  return items.length;
}

export function createDashboardServer(context) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/") {
        const items = await readFeedItems(context);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(await renderPage(items, context));
        return;
      }
      if (url.pathname === "/api/assets") {
        const items = await readFeedItems(context);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(items, null, 2));
        return;
      }
      if (url.pathname === "/asset") {
        await serveAsset(url.searchParams.get("path") ?? "", response, context);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}
