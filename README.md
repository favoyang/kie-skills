# kie-skills

An agent skill and small CLI for generating images, music, and speech through
[KIE](https://kie.ai) task models — with model discovery, schema validation, credit
accounting, and local artifact records built in.

No dependencies, no build step. Plain ESM on Node 22+.

## Why

KIE exposes 200+ generation models behind one task API, and that surface moves: models
are added, renamed, and retired, and every model has its own `input` shape. Hardcoding
a model name or field list is how these integrations rot.

This skill reads the catalog and the model's published schema at call time, so a new
model works without a code change, and an input that would have been rejected is
caught before credits are spent.

It also refuses the expensive mistakes: video families are blocked by default, a
balance floor stops runs that cannot finish, and every run records what it actually
cost.

## Requirements

- Node.js 22 or newer
- A KIE API key: <https://kie.ai/api-key>

```sh
export KIE_API_KEY=your_key
```

## Install

As an agent skill:

```sh
npx skills add favoyang/kie-skills
```

As a local CLI:

```sh
git clone git@github.com:favoyang/kie-skills.git
cd kie-skills
node scripts/cli.js models --family image
```

## Quick start

```sh
# What can I use?
node scripts/cli.js models --family image --q gpt-image

# What does it take?
node scripts/cli.js schema gpt-image-2-text-to-image

# What will it cost?
node scripts/cli.js price gpt-image-2-text-to-image
node scripts/cli.js balance

# Check everything without spending anything.
node scripts/cli.js plan gpt-image-2-text-to-image \
  --input '{"prompt":"a red ceramic mug on a light oak table","resolution":"1K","aspect_ratio":"1:1"}'

# Then run it.
node scripts/cli.js run gpt-image-2-text-to-image \
  --input '{"prompt":"a red ceramic mug on a light oak table","resolution":"1K","aspect_ratio":"1:1"}'
```

Each run downloads its result and writes a metadata record next to it:

```
kie-output/
  images/gpt-image-2-text-to-image/20261028-172545-a-red-ceramic-mug-01.png
  metadata/20261028-172545-a-red-ceramic-mug-<taskId>.metadata.json
```

## Safety defaults

| Guard | Behavior |
| --- | --- |
| Family gate | Only `image`, `music`, and `speech` families run. `video` and `chat` are blocked, as is any task type missing from the map |
| Balance floor | Refuses to start a task when the balance is below 20 credits |
| `--max-credits N` | Optional, tighten-only ceiling from the advertised price |

These are defaults, not opinions baked into code: override them per project in
`kie.config.json`.

## Cost accounting

`recordInfo` returns `creditsConsumed` for task-based models, so reported cost is the
real number, not an estimate. Some families (Suno) do not report it; those records are
marked `cost_source: "unavailable"` instead of inventing a figure.

```sh
node scripts/cli.js spend --today
```

Spend is derived from run metadata, so there is no ledger file to drift out of sync.

## Local files as input

Point at a path and it is uploaded automatically:

```sh
node scripts/cli.js run gpt-image-2-image-to-image \
  --input '{"prompt":"watercolor version","input_urls":["./photos/mug.png"]}'
```

Remote URLs pass through untouched. Uploads expire after 24h, so metadata keeps the
local source path and a re-run uploads again.

## Dashboard

```sh
node scripts/cli.js dashboard
# KIE dashboard: http://127.0.0.1:4173
```

A read-only page over the output directory: prompts, inputs, credits, elapsed time,
and playable media. Binds to localhost; pass `--host 0.0.0.0` only on a trusted
network.

## Known limits

- **Video is off by default.** Those runs cost hundreds of credits. Enabling them is a
  deliberate policy edit.
- **Chat models are out of scope.** They use vendor chat protocols, not the task API.
- **Discovery endpoints are not versioned.** `/api/v1/models`, `/models/{model}/schema`,
  and `/chat/credit` are used by KIE's own tooling but carry no stability guarantee.
  A change breaks discovery loudly rather than silently guessing.

## Development

```sh
npm test        # 88 tests, no network or credentials required
npm run check   # tests plus a dashboard render check
```

Tests use a fake fetch layer, so nothing here costs credits.

## License

MIT
