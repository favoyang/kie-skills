import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultStoreDir, skillRoot, storeMetadataDir } from "./config.js";
import { assetKind, assetUrl, contentType, readFeedItems, resolveAssetPath } from "./feed.js";

const usdPerKieCredit = 0.005;
const PAGE_TITLE = "KIE Generations";

let dashboardVersion = "0.0.0";
try {
  dashboardVersion = JSON.parse(readFileSync(path.join(skillRoot, "package.json"), "utf8")).version ?? dashboardVersion;
} catch {
  // A missing package.json only costs the version string.
}

/** One store feeds the dashboard; every other path is derived from it. */
function pathsFor(context = {}) {
  const storeDir = context.storeDir ?? context.outDir ?? defaultStoreDir();
  return {
    storeDir,
    projectDir: context.projectDir ?? storeDir,
    outDir: context.outDir ?? storeDir,
    metadataDir: context.metadataDir ?? storeMetadataDir(storeDir),
  };
}

export function filterItems(items, { project = "", family = "" } = {}) {
  return items.filter((item) =>
    (!project || item.project?.key === project || item.project?.name === project)
    && (!family || item.family === family));
}

export function projectGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.project?.key ?? "";
    const name = item.project?.name || (key ? path.basename(key) : "unknown");
    const group = groups.get(key) ?? { key, name, runs: 0, credits: 0 };
    group.runs += 1;
    if (typeof item.creditsConsumed === "number") group.credits += item.creditsConsumed;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));
}

function renderFilters({ projects, families, active }) {
  const projectOptions = [["", `All projects (${projects.length})`], ...projects.map((group) => [group.key, `${group.name} (${group.runs})`])];
  const familyOptions = [["", "All families"], ...families.map((family) => [family, family])];
  const options = (entries, selected) => entries
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  return `
      <form class="filter-form" method="get" action="/">
        <label><span>Project</span><select name="project" onchange="this.form.submit()">${options(projectOptions, active.project ?? "")}</select></label>
        <label><span>Family</span><select name="family" onchange="this.form.submit()">${options(familyOptions, active.family ?? "")}</select></label>
        <noscript><button type="submit">Filter</button></noscript>
      </form>`;
}

function renderSummary(items, active) {
  const credits = items.reduce((sum, item) => sum + (typeof item.creditsConsumed === "number" ? item.creditsConsumed : 0), 0);
  const scope = active.project || active.family ? "filtered" : "all projects";
  return `<p class="feed-summary" id="summary"><strong>${items.length}</strong> run(s) · <strong>${credits}</strong> credits · $${(credits * usdPerKieCredit).toFixed(3)} <span class="muted">${escapeHtml(scope)}</span></p>`;
}

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

function firstVisual(assets) {
  for (const asset of assets) {
    if (!asset.path) continue;
    const kind = assetKind(asset.path);
    if (kind === "image" || kind === "video" || kind === "audio") return { asset, kind };
  }
  return null;
}

function renderTile(item) {
  const visual = firstVisual(item.downloaded);
  const details = `<a class="to-details" href="/item?task=${encodeURIComponent(item.taskId)}">Details</a>`;
  if (!visual) {
    return `<div class="tile tile-empty"><span class="tile-kind">${escapeHtml(item.family)}</span>${details}</div>`;
  }
  const url = assetUrl(visual.asset.path);
  let inner;
  if (visual.kind === "image") {
    inner = `<img src="${url}" alt="" loading="lazy">`;
  } else if (visual.kind === "video") {
    // #t=0.1 makes browsers render the first frame as the tile image.
    inner = `<video src="${url}#t=0.1" muted playsinline preload="metadata"></video>`;
  } else {
    inner = `<span class="tile-kind">${escapeHtml(visual.kind)}</span>`;
  }
  return `<div class="tile"><a class="tile-open" data-kind="${escapeHtml(visual.kind)}" href="${url}">${inner}</a>${details}</div>`;
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
  const domId = `item-${index}`;
  return `
    <article class="feed-item" id="${domId}">
      ${renderTile(item)}
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

export async function renderItems(items, context = {}) {
  return (await Promise.all(items.map((item, index) => renderItem(item, index, context)))).join("");
}

const STYLES = `
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #20242a; }
    * { box-sizing: border-box; }
    html, body { margin: 0; max-width: 100%; overflow-x: hidden; }
    main { width: min(1120px, 100%); margin: 0 auto; padding: 28px 18px 48px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; min-width: 0; flex-wrap: wrap; }
    .title-row { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
    h1 { font-size: 28px; margin: 0; letter-spacing: 0; }
    h3 { font-size: 12px; text-transform: uppercase; color: #68717d; margin: 0 0 8px; letter-spacing: .04em; }
    p { line-height: 1.5; overflow-wrap: anywhere; }
    .muted { color: #68717d; margin: 0; }
    .live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #137333; text-transform: uppercase; letter-spacing: .08em; }
    .live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .live.pulse { color: #2962ff; }
    .live.off { color: #b42318; }
    .view-toggle { display: inline-flex; border: 1px solid #dfe3e8; border-radius: 7px; overflow: hidden; background: #fff; }
    .view-toggle button { appearance: none; border: 0; background: transparent; color: #4b5563; font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; }
    .view-toggle button + button { border-left: 1px solid #dfe3e8; }
    .view-toggle button.active { background: #20242a; color: #fff; }
    .crumbs { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #68717d; margin-bottom: 16px; }
    .crumbs a { color: #344054; text-decoration: none; border-bottom: 1px solid #c9ced6; }
    .crumbs a:hover { border-color: #20242a; }
    .feed { display: grid; gap: 16px; min-width: 0; }
    .feed-item { min-width: 0; background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 1px 2px rgb(22 29 37 / 5%); overflow: hidden; }
    .tile { display: none; }
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
    .empty { padding: 40px 0; text-align: center; }
    .filter-form { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .filter-form label { display: grid; gap: 4px; font-size: 12px; color: #68717d; }
    .filter-form select { appearance: auto; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #dfe3e8; border-radius: 6px; background: #fff; color: #20242a; max-width: 320px; }
    .feed-summary { grid-column: 1 / -1; margin: 0 0 4px; font-size: 13px; color: #344054; }
    .feed-summary strong { font-weight: 700; }

    /* Gallery view */
    main[data-view="gallery"] .feed { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    main[data-view="gallery"] .feed-item { display: flex; flex-direction: column; }
    main[data-view="gallery"] .tile { display: flex; flex-direction: column; position: relative; background: #f4f6f8; }
    main[data-view="gallery"] .tile > a { display: block; color: inherit; text-decoration: none; }
    main[data-view="gallery"] .tile img, main[data-view="gallery"] .tile video { width: 100%; height: 190px; object-fit: cover; border: 0; border-radius: 0; pointer-events: none; }
    main[data-view="gallery"] .tile-kind { display: flex; align-items: center; justify-content: center; width: 100%; height: 190px; color: #68717d; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; background: repeating-linear-gradient(45deg, #f4f6f8, #f4f6f8 10px, #eef1f4 10px, #eef1f4 20px); }
    main[data-view="gallery"] .to-details { position: absolute; right: 8px; bottom: 8px; appearance: none; border: 1px solid #dfe3e8; background: rgb(255 255 255 / 92%); color: #344054; font-size: 11px; padding: 4px 8px; border-radius: 999px; text-decoration: none; }
    main[data-view="gallery"] .to-details:hover { border-color: #20242a; }
    main[data-view="gallery"] .feed-toggle > summary { display: block; padding: 9px 11px 11px; pointer-events: none; list-style: none; }
    main[data-view="gallery"] .feed-toggle > summary::marker { content: ""; }
    main[data-view="gallery"] .summary-main { gap: 1px; }
    main[data-view="gallery"] .summary-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 600; line-height: 1.35; }
    main[data-view="gallery"] .summary-title span { display: block; font-size: 11px; font-weight: 500; }
    main[data-view="gallery"] .summary-subtitle { display: none; }
    main[data-view="gallery"] .summary-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 7px; font-size: 11px; }
    main[data-view="gallery"] .state { padding: 3px 8px; font-size: 10px; }
    main[data-view="gallery"] .feed-body { display: none; }

    /* Detail page */
    main[data-view="detail"] .feed-item { border: 0; box-shadow: none; background: transparent; }
    main[data-view="detail"] .feed-toggle > summary { padding-left: 0; padding-right: 0; }

    /* Lightbox */
    dialog.lightbox { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 94vh; overflow: visible; }
    dialog.lightbox::backdrop { background: rgb(10 12 16 / 82%); }
    .lightbox-inner { position: relative; background: #0f1115; border-radius: 10px; padding: 14px; display: flex; align-items: center; justify-content: center; }
    .lightbox-inner img, .lightbox-inner video { max-width: min(90vw, 1300px); max-height: 82vh; border: 0; border-radius: 6px; background: #000; }
    .lightbox-inner audio { width: min(80vw, 720px); }
    .lightbox-close { position: absolute; top: 10px; right: 10px; z-index: 2; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: 0; background: rgb(255 255 255 / 92%); color: #20242a; font-size: 17px; line-height: 1; cursor: pointer; box-shadow: 0 1px 4px rgb(0 0 0 / 35%); }
    .lightbox-close:hover { background: #fff; }

    @media (max-width: 760px) {
      .topbar { display: block; }
      .view-toggle { margin-top: 12px; }
      .feed-toggle > summary { align-items: flex-start; }
      .summary-meta { align-items: flex-end; flex-direction: column; gap: 6px; }
      .meta-grid { grid-template-columns: 1fr; }
    }
`;

const CREATE_SCRIPT = `
    (() => {
      const main = document.querySelector("main");
      const feed = document.getElementById("feed");
      const count = document.getElementById("count");
      const live = document.getElementById("live");
      const buttons = [...document.querySelectorAll(".view-toggle button")];
      const dialog = document.getElementById("lightbox");
      const dialogBody = document.getElementById("lightbox-body");

      const applyView = (view) => {
        main.dataset.view = view;
        for (const button of buttons) button.classList.toggle("active", button.dataset.view === view);
        try { localStorage.setItem("kie-view", view); } catch {}
      };
      let view = "list";
      try { view = localStorage.getItem("kie-view") || "list"; } catch {}
      if (view !== "gallery") view = "list";
      applyView(view);
      for (const button of buttons) button.addEventListener("click", () => applyView(button.dataset.view));

      const closeLightbox = () => {
        dialogBody.innerHTML = "";
        dialog.close();
      };
      dialog.addEventListener("click", (event) => { if (event.target === dialog) closeLightbox(); });
      dialog.addEventListener("close", () => { dialogBody.innerHTML = ""; });
      document.querySelector(".lightbox-close").addEventListener("click", closeLightbox);

      const openLightbox = (kind, src) => {
        if (kind === "image") {
          dialogBody.innerHTML = '<img src="' + src + '" alt="">';
        } else if (kind === "video") {
          dialogBody.innerHTML = '<video src="' + src + '" controls autoplay playsinline></video>';
        } else if (kind === "audio") {
          dialogBody.innerHTML = '<audio src="' + src + '" controls autoplay></audio>';
        } else {
          return;
        }
        dialog.showModal();
      };

      feed.addEventListener("click", (event) => {
        const link = event.target.closest("a.tile-open");
        if (!link) return;
        event.preventDefault();
        openLightbox(link.dataset.kind, link.getAttribute("href"));
      });

      const resetMedia = (element) => {
        element.pause();
        if (element.readyState > 0) { try { element.currentTime = 0; } catch {} }
      };
      const bindMedia = () => {
        document.querySelectorAll("audio, video").forEach((element) => {
          resetMedia(element);
          element.addEventListener("loadedmetadata", () => { try { element.currentTime = 0; } catch {} }, { once: true });
          element.addEventListener("play", () => {
            document.querySelectorAll("audio, video").forEach((other) => { if (other !== element) other.pause(); });
          });
        });
      };

      const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      const relativeUnits = [["year",31536000],["month",2592000],["week",604800],["day",86400],["hour",3600],["minute",60],["second",1]];
      const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
      const localFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: browserTimeZone });
      const formatSince = (date) => {
        const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
        const absSeconds = Math.abs(diffSeconds);
        const [unit, perUnit] = relativeUnits.find(([, seconds]) => absSeconds >= seconds) || ["second", 1];
        return relativeTime.format(Math.round(diffSeconds / perUnit), unit);
      };
      const updateTimes = () => {
        document.querySelectorAll(".local-time").forEach((element) => {
          const date = new Date(element.dateTime);
          if (!Number.isNaN(date.getTime())) element.textContent = localFormatter.format(date) + " " + browserTimeZone;
        });
        document.querySelectorAll(".time-since").forEach((element) => {
          const raw = element.getAttribute("data-timestamp");
          const date = raw ? new Date(raw) : null;
          if (date && !Number.isNaN(date.getTime())) element.textContent = formatSince(date);
        });
      };

      let version = null;
      let timer = null;
      const flash = () => {
        live.classList.add("pulse");
        clearTimeout(timer);
        timer = setTimeout(() => live.classList.remove("pulse"), 1200);
      };
      const check = async () => {
        if (document.hidden || dialog.open) return;
        try {
          const response = await fetch("/api/version", { cache: "no-store" });
          if (!response.ok) throw new Error("version " + response.status);
          const next = await response.text();
          if (version === null) { version = next; return; }
          if (next === version) return;
          version = next;
          const partial = await fetch("/partial" + window.location.search, { cache: "no-store" });
          if (!partial.ok) throw new Error("partial " + partial.status);
          feed.innerHTML = await partial.text();
          if (count) count.textContent = String(feed.querySelectorAll(".feed-item").length);
          updateTimes();
          bindMedia();
          flash();
        } catch {
          live.classList.add("off");
        }
      };
      setInterval(check, 3000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });

      window.addEventListener("pageshow", bindMedia);
      window.addEventListener("pageshow", updateTimes);
      document.addEventListener("DOMContentLoaded", bindMedia);
      document.addEventListener("DOMContentLoaded", updateTimes);
      window.setInterval(updateTimes, 60000);
    })();
`;

function renderDocument({ view, body, script = "", crumbs = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(PAGE_TITLE)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <main data-view="${escapeHtml(view)}">
    ${body}
  </main>
  <dialog class="lightbox" id="lightbox">
    <div class="lightbox-inner">
      <button type="button" class="lightbox-close" aria-label="Close">×</button>
      <div id="lightbox-body"></div>
    </div>
  </dialog>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

export async function renderPage(items, context = {}) {
  const renderedItems = await renderItems(items, context);
  const projects = context.projects ?? projectGroups(items);
  const families = context.families ?? [...new Set(items.map((item) => item.family))].sort();
  const active = context.active ?? { project: "", family: "" };
  const body = `
    <section class="topbar">
      <div class="title-row">
        <h1>${escapeHtml(PAGE_TITLE)}</h1>
        <span id="live" class="live">live</span>
        <span id="count" class="sr-only">${items.length}</span>
      </div>
      <div class="view-toggle" role="group" aria-label="View mode">
        <button type="button" data-view="list" class="active">List</button>
        <button type="button" data-view="gallery">Gallery</button>
      </div>
    </section>
    ${renderFilters({ projects, families, active })}
    <section class="feed" id="feed">
      ${renderSummary(items, active)}
      ${items.length > 0 ? renderedItems : "<p class=\"muted empty\">No generations yet.</p>"}
    </section>`;
  return renderDocument({ view: "list", body, script: CREATE_SCRIPT });
}

/** The live refresh swaps the whole feed, summary included. */
export async function renderFeed(items, context = {}) {
  const renderedItems = await renderItems(items, context);
  return `${renderSummary(items, context.active ?? { project: "", family: "" })}${renderedItems}`;
}

export async function renderDetailPage(item, context = {}) {
  const article = await renderItem(item, 0, context);
  const body = `
    <section class="topbar">
      <div class="title-row">
        <h1>${escapeHtml(PAGE_TITLE)}</h1>
      </div>
    </section>
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">← Generations</a>
      <span>/</span>
      <span>${escapeHtml(item.family)} · ${escapeHtml(item.mode)}</span>
    </nav>
    <section class="feed">${article}</section>`;
  return renderDocument({ view: "detail", body, script: "" });
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

/** Cheap fingerprint of the metadata directory: file count plus newest mtime. */
export async function metadataVersion(metadataDir) {
  let names = [];
  try {
    names = await readdir(metadataDir);
  } catch {
    return "0:0";
  }
  const files = names.filter((name) => name.endsWith(".json"));
  let latest = 0;
  for (const name of files) {
    try {
      const info = await stat(path.join(metadataDir, name));
      if (info.mtimeMs > latest) latest = info.mtimeMs;
    } catch {
      // file removed mid-scan
    }
  }
  return `${files.length}:${Math.round(latest)}`;
}

export async function checkDashboard(context = {}) {
  const paths = pathsFor(context);
  const items = await readFeedItems(paths);
  const html = await renderPage(items, paths);
  if (!html.includes(PAGE_TITLE)) throw new Error("HTML title missing");
  if (items.length > 0 && !html.includes("Output Assets")) throw new Error("feed content missing");
  return items.length;
}

export function createDashboardServer(context = {}) {
  const paths = pathsFor(context);
  const startedAt = new Date().toISOString();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const active = {
        project: url.searchParams.get("project") ?? "",
        family: url.searchParams.get("family") ?? "",
      };
      if (url.pathname === "/") {
        const all = await readFeedItems(paths);
        const items = filterItems(all, active);
        const view = {
          ...paths,
          active,
          projects: projectGroups(all),
          families: [...new Set(all.map((item) => item.family))].sort(),
        };
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(await renderPage(items, view));
        return;
      }
      if (url.pathname === "/item") {
        const task = url.searchParams.get("task") ?? "";
        const items = await readFeedItems(paths);
        const item = items.find((candidate) => candidate.taskId === task);
        if (!item) {
          response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          response.end(renderNotFound());
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(await renderDetailPage(item, paths));
        return;
      }
      if (url.pathname === "/partial") {
        const items = filterItems(await readFeedItems(paths), active);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(await renderFeed(items, { ...paths, active }));
        return;
      }
      if (url.pathname === "/api/version") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end(await metadataVersion(paths.metadataDir));
        return;
      }
      if (url.pathname === "/api/health") {
        const items = await readFeedItems(paths);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({
          app: "kie-dashboard",
          version: dashboardVersion,
          storeDir: paths.storeDir,
          metadataDir: paths.metadataDir,
          runs: items.length,
          startedAt,
        }, null, 2));
        return;
      }
      if (url.pathname === "/api/assets") {
        const items = filterItems(await readFeedItems(paths), active);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(items, null, 2));
        return;
      }
      if (url.pathname === "/asset") {
        await serveAsset(url.searchParams.get("path") ?? "", response, paths);
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

function renderNotFound() {
  return renderDocument({
    view: "detail",
    body: `<nav class="crumbs"><a href="/">← Generations</a></nav><p class="muted">That generation is no longer available.</p>`,
  });
}
