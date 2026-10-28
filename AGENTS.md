# Repository Guidelines

This repository ships one agent skill, `kie-skills`, plus the CLI it drives.

- `SKILL.md` is the agent-facing contract. Keep it discriminating and self-contained.
- `README.md` is the human-facing entry point.
- `scripts/` is the runtime. It must stay dependency-free and work from any project
  directory; never assume the repository is the invoking project.
- `test/` uses a fake fetch layer. No test may require network access or credentials.
- `config/defaults.json` holds shared policy defaults. Project overrides belong in the
  invoking project's `kie.config.json`, not here.

## Validation

```sh
npm test
npm run check
```

Run both before committing. Changes to the family map or a safety gate must update
`SKILL.md`, `README.md`, and the tests together.

## Portability

The skill is installed into other projects, sometimes with their own `package.json`.
`package.json` here and `scripts/package.json` both declare `"type": "module"` so the
runtime loads as ESM regardless of the host project. Do not remove either.

## Public surface

This is a public repository. Do not add personal filesystem paths, secret-manager
assumptions, private repository references, or operational history. Examples should
use neutral, generic paths.
