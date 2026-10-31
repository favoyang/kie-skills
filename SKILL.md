---
name: kie-skills
description: "Run KIE (api.kie.ai) task models for image, music, and speech generation, and report their cost and credit balance. Use when the user names a KIE model, asks which KIE image or audio models exist, asks what a model costs or what their KIE balance is, or wants generated media saved into the current project. Not for KIE chat models, which use vendor chat protocols."
---

# KIE generation

Drive KIE's task API end to end: discover a model from the live catalog, read its
published schema, validate the input against it, submit the task, poll to a terminal
state, download the result, and record what it cost.

The CLI is read-only toward this skill folder. Every run lands in one per-user store
shared by all projects, so a single dashboard shows every generation no matter which
directory started it.

## Rules

1. **Never name a model from memory.** The catalog changes constantly. Run `models`
   and use the exact `model` string it prints.
2. **Never assume input fields.** Run `schema <model>` and use the fields it shows.
   Names differ per model and change without notice.
3. **Always `plan` before `run`.** `plan` is free; it resolves the model, validates
   input, checks the balance, and prints the output location.
4. **Read the body `code`, not the HTTP status.** KIE returns HTTP 200 on failure.
   The CLI enforces this; do not bypass it with raw requests unless debugging.
5. **Treat result URLs as ephemeral.** KIE deletes generated files after 14 days.
   The CLI downloads them; never hand the user a raw URL as the deliverable.
6. **Never print `KIE_API_KEY`.** Pass it by environment only.
7. **Pass local files as paths, not bytes.** Any `http(s)` value is sent as-is; a
   local path in a media field is uploaded automatically. See *Input files*.

## Prerequisites

- Node.js 22 or newer.
- `KIE_API_KEY` exported in the shell that starts the agent. Create one at
  <https://kie.ai/api-key>.

```sh
export KIE_API_KEY=your_key
```

No other dependency is required. `curl` and `jq` are not used.

## Install

As an agent skill:

```sh
npx skills add favoyang/kie-skills
```

Or copy this repository into the agent's skill directory, for example
`.claude/skills/kie-skills/` or `.agents/skills/kie-skills/`.

The CLI lives at `scripts/cli.js` inside the skill package. The examples below use
`node scripts/cli.js` from the package root.

## Commands

| Command | Purpose |
| --- | --- |
| `models [--family image\|music\|speech] [--q text] [--refresh] [--json]` | Live catalog, split into allowed and blocked |
| `schema <model> [--refresh] [--json]` | Route, required fields, enums, defaults |
| `price <model>` | Advertised pricing text, verbatim |
| `balance [--json]` | Current credits |
| `plan <model> --input '<json>' [--upload FIELD=PATH] [--out DIR] [--json]` | Dry run: all checks, nothing submitted |
| `run <model> --input '<json>' [--upload FIELD=PATH] [--out DIR] [--max-credits N] [--json]` | Submit, poll, download, record |
| `spend [--today\|--month] [--out DIR] [--json]` | Cost summary derived from run metadata |
| `dashboard [--port 4173] [--host 127.0.0.1] [--check] [--open]` | Preview of the shared store; reuses a running server |
| `import <dir> [dir...] [--store DIR] [--json]` | Merge legacy `kie-output` trees into the store |
| `service install\|uninstall\|status` | Resident dashboard via launchd or Task Scheduler |
| `info` | Resolved paths and active policy |

Typical session:

```sh
node scripts/cli.js models --family image --q gpt-image
node scripts/cli.js schema gpt-image-2-text-to-image
node scripts/cli.js plan gpt-image-2-text-to-image --input '{"prompt":"a red ceramic mug","resolution":"1K","aspect_ratio":"1:1"}'
node scripts/cli.js run  gpt-image-2-text-to-image --input '{"prompt":"a red ceramic mug","resolution":"1K","aspect_ratio":"1:1"}'
```

`--input` accepts a JSON object inline or `@path/to/input.json`.

## Input files

Image-to-image and image-to-video models need a file URL in `input`. Put a local
path in the input object and it is uploaded automatically:

```sh
node scripts/cli.js plan gpt-image-2-image-to-image \
  --input '{"prompt":"watercolor version","input_urls":["./photos/mug.png"]}'
# upload     input_urls <- photos/mug.png (154832 bytes, image)
```

- `http://` and `https://` values pass through untouched.
- A local path in a media field (`image`, `img`, `photo`, `video`, `audio`, `file`,
  `url`, `asset`, `media`, `frame`) is uploaded and replaced with the returned URL.
  Array fields are handled per element.
- A local path in a non-media field (for example `prompt`) is refused rather than
  sent as text.
- A path-shaped value that does not exist is reported before any task is created.
- Files at or under 10MB use `file-base64-upload`; larger files use
  `file-stream-upload` (multipart).
- `--upload FIELD=PATH` handles fields whose name does not look like media. It is
  repeatable and cannot target array fields; pass those paths inside `--input`.

Uploads land on `kieai.redpandaai.co` and are deleted after **24h**, so metadata
records the local source path rather than the upload URL. Re-running later re-uploads
from disk instead of reusing a dead link.

## Safety model

Two hard gates, both evaluated before any task is created:

- **Family gate.** Each catalog model advertises structured `taskType` values. Those
  map to families in `config/defaults.json`, and only enabled families may run.
  Defaults: `image`, `music`, and `speech` are allowed; `video` and `chat` are not.
  A task type missing from the map is blocked too, so a new category cannot slip
  through. Models advertising a blocked family alongside an allowed one are blocked.
- **Balance floor.** A run is refused when the balance is below `minBalance`
  (default 20 credits), so a task cannot start and then fail on `code: 402`.

One optional gate:

- **`--max-credits N`** compares `N` against the highest credit figure quoted in the
  model's pricing text. The text is prose, so if it cannot be parsed the run is
  refused. This flag only tightens; a caller cannot raise a configured limit.

Video is blocked by default because those runs cost hundreds of credits. Enabling it
means editing `config/defaults.json` (or a project `kie.config.json`) deliberately.

## Output layout

Runs go to one per-user store, not to the invoking project. That is deliberate: a
project-local output directory cannot survive git worktrees, where it is git-ignored
and disappears with the worktree.

The store resolves as:

1. `--out DIR`, for this command only
2. `KIE_STORE_DIR`
3. the platform data directory: `~/Library/Application Support/kie` on macOS,
   `%LOCALAPPDATA%\kie` on Windows, `~/.local/share/kie` on Linux

```
<store>/
  images/<model-slug>/<stamp>-<slug>-01.png
  audio/<model-slug>/<stamp>-<slug>-01.mp3
  video/<model-slug>/<stamp>-<slug>-01.mp4
  metadata/<stamp>-<slug>-<taskId>.metadata.json
```

`--out` is the only redirect, and it applies to one command. There is deliberately no
project-level output setting: a sticky path in `kie.config.json` is how a run ends up
somewhere the dashboard cannot see. A run written outside the store does not appear in
the dashboard.

Every record also carries a `project` block: the invoking directory, its git common
dir, the repository name, and the working directory. The git common dir is the
aggregation key, so all worktrees of one repository report as one project.

A metadata file is written **immediately after the task is created** with
`state: "queued"`, then rewritten at the terminal state. A crash therefore leaves a
recoverable record instead of losing the `taskId`.

Each record contains the model, exact input, create response, final response,
`credits_consumed`, `pricing_desc`, balance before and after, downloaded paths, and
the catalog/schema versions used. It never contains the API key.

## Project config

Optional, at `<project>/kie.config.json`:

```json
{
  "allowedFamilies": ["image", "music", "speech"],
  "minBalance": 20,
  "familyTaskTypes": { "image": ["Text to Image", "Image to Image", "Image Editing"] }
}
```

`outDir` and `metadataDir` are **refused**. A config that still contains either one
fails with an explanation instead of silently writing runs somewhere else.

Omitted keys fall back to `config/defaults.json`. `familyTaskTypes` merges per family,
so a project can extend the map without restating it.

## State

| State | Location | Notes |
| --- | --- | --- |
| Catalog and schemas | `~/Library/Caches/kie-skill/` on macOS, `~/.cache/kie-skill/` elsewhere | 24h TTL, auto-rebuilt, safe to delete, shared across projects |
| Runs and downloads | the shared store | permanent; the dashboard reads it directly |
| Spend totals | derived from metadata at read time | no separate ledger to drift |
| API key | environment only | never written |

Override the cache with `KIE_CACHE_DIR`, and force a rebuild with `--refresh`. If a
refresh fails while a cached copy exists, the CLI warns and uses the cached copy rather
than blocking every run on a transient outage.

## Costs

`run` reports `credits_consumed` from `recordInfo`, which is authoritative for
task-based models. Check `price <model>` before relying on any figure: advertised
prices change.

Some families do not report cost. Suno `record-info` has no `creditsConsumed` field,
so those records store `cost_source: "unavailable"` and `spend` counts them separately
instead of inventing a number.

## Dashboard

`dashboard` serves a read-only page over the shared store:

```sh
node scripts/cli.js dashboard
# KIE dashboard: http://127.0.0.1:4173
# store: ~/Library/Application Support/kie
```

It reads `<store>/metadata/*.metadata.json` and serves media from `<store>/`. Each run
shows its prompt, inputs, credits, elapsed seconds, assets, and a link to its metadata
file. A project selector filters by repository (all worktrees collapse into one entry),
a family selector narrows by image, music, or speech, and a summary line totals runs
and credits for the current filter. The page polls for new runs and updates itself
within a few seconds. A navbar toggle switches between list view and a thumbnail
gallery. `--check` renders once and exits without binding a port, which suits CI.

`dashboard` is idempotent. If a dashboard already answers on the port it prints that
URL and exits, so it is safe for an agent to call before handing the user a link.
`--open` opens the browser as well.

When the dashboard is up, `run` prints the link to the run it just finished, so the
user does not have to be told how to find it:

```
dashboard  http://127.0.0.1:4173/item?task=<taskId>
```

Asset requests are confined to the store; anything outside it returns 403. `/api/health`
reports the app name, version, store path, and run count.

### Resident service

`service install` registers the dashboard with the platform supervisor so it survives
logout and restarts after a crash:

```sh
node scripts/cli.js service install --host 0.0.0.0 --port 4173
node scripts/cli.js service status
node scripts/cli.js service uninstall
```

- macOS: `~/Library/LaunchAgents/local.kie.dashboard.plist`, `RunAtLoad` and
  `KeepAlive`, log at `~/Library/Logs/kie-dashboard.log`.
- Windows: a Task Scheduler entry named `Kie Dashboard` that runs at logon through a
  hidden `wscript` launcher, with a wrapper that restarts the process on exit. Files
  live in `%LOCALAPPDATA%\kie`.

Installing stops any dashboard already running from a shell, so the port is not held
twice. `--host 0.0.0.0` is required for LAN access; there is no authentication, so only
do that on a trusted network.

## Not covered

- **Synchronous models.** `chat/completions` style routes have no task to poll. This
  CLI refuses them by design.
- **Video.** Blocked by default. Enabling it requires a deliberate policy change
  because those runs cost hundreds of credits.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `error: KIE_API_KEY is not set` | Export the key in the shell that launched the agent |
| `KIE code 401` | Key invalid, or a proxy rewrote the `Authorization: Bearer` header |
| `KIE code 402` | Insufficient credits |
| `KIE code 429` | Rate limited. Discovery endpoints share 1 request/second; `recordInfo` allows 10/second per task |
| `model … is not in the catalog` | The suggestion list is authoritative; re-run `models --q` |
| `has no published schema yet` | The model is listed but its docs are not synced. Report it; do not guess a request shape |
| `family not allowed` | Expected for video and chat. Change `allowedFamilies` only if you intend to spend accordingly |

## API stability

The catalog (`/api/v1/models`), per-model schema (`/api/v1/models/{model}/schema`), and
credit balance (`/api/v1/chat/credit`) endpoints are used by KIE's own agent tooling
but are not part of a published versioning contract. If KIE changes them, discovery
fails loudly rather than silently guessing.

Generation history is also visible in the KIE web console at <https://kie.ai/logs>.
