---
name: kie-skills
description: "Run KIE (api.kie.ai) task models for image, music, and speech generation, and report their cost and credit balance. Use when the user names a KIE model, asks which KIE image or audio models exist, asks what a model costs or what their KIE balance is, or wants generated media saved into the current project. Not for KIE chat models, which use vendor chat protocols."
---

# KIE generation

Drive KIE's task API end to end: discover a model from the live catalog, read its
published schema, validate the input against it, submit the task, poll to a terminal
state, download the result, and record what it cost.

The CLI is read-only toward this skill folder and writes only into the project that
invokes it.

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
| `dashboard [--port 4173] [--host 127.0.0.1] [--check]` | Local preview of past runs |
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

The output directory resolves as:

1. `--out DIR`
2. `KIE_OUT_DIR`
3. `outDir` in `<project>/kie.config.json`
4. `<project>/kie-output/`

```
<out>/
  images/<model-slug>/<stamp>-<slug>-01.png
  audio/<model-slug>/<stamp>-<slug>-01.mp3
  metadata/<stamp>-<slug>-<taskId>.metadata.json
```

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
  "outDir": "kie-output",
  "metadataDir": "kie-output/metadata",
  "allowedFamilies": ["image", "music", "speech"],
  "minBalance": 20,
  "familyTaskTypes": { "image": ["Text to Image", "Image to Image", "Image Editing"] }
}
```

Omitted keys fall back to `config/defaults.json`. `familyTaskTypes` merges per family,
so a project can extend the map without restating it.

## State

| State | Location | Notes |
| --- | --- | --- |
| Catalog and schemas | `~/Library/Caches/kie-skill/` on macOS, `~/.cache/kie-skill/` elsewhere | 24h TTL, auto-rebuilt, safe to delete, shared across projects |
| Runs and downloads | the project's output directory | permanent unless the project cleans it |
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

`dashboard` serves a local, read-only page over the output directory:

```sh
node scripts/cli.js dashboard
# KIE dashboard: http://127.0.0.1:4173
```

It reads `<out>/metadata/*.metadata.json` and serves media from `<out>/`. Each run
shows its prompt, inputs, credits, elapsed seconds, assets, and a link to its metadata
file. `--check` renders once and exits without binding a port, which suits CI.
`--host 0.0.0.0` exposes it on the LAN; there is no authentication, so only do that on
a trusted network.

Asset requests are confined to the output directory; anything outside it returns 403.

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
