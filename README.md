# Pi Portia

Pi-native spatial project memory for agents.

Portia is a project-local, inspectable memory layer backed by SQLite. It stores pointers, gotchas, decisions, invariants, purpose, patterns, and plans that help future agents re-perceive code faster. It does not replace reading source files.

## Status

Early MVP.

Implemented now:

- SQLite database creation and migrations using `better-sqlite3`
- project-local DB at `.pi/portia/portia.sqlite`
- `/portia-status`
- `/portia-sense <path> [query]`
- `portia_sense` read-only tool
- `portia_record` write/proposal tool

Not implemented yet:

- `portia_repair`
- export/import
- reflection/proposal workflow
- vector search

## Installation

Install from GitHub with Pi:

```bash
pi install git:github.com/vihu/pi-portia
```

Then restart Pi, or run `/reload` in an existing session if your Pi version supports extension reloads.

For local development from a checkout:

```bash
git clone https://github.com/vihu/pi-portia.git
cd pi-portia
npm install
pi -e .
```

To use a local checkout globally without publishing/installing from GitHub, add its absolute path to Pi settings or run:

```bash
pi install /absolute/path/to/pi-portia
```

## Storage

Portia uses a project-local SQLite database:

```text
.pi/portia/portia.sqlite
```

The database is intended to be shared by all agents working in the same checkout. It may still be excluded from Git by a global ignore rule; future export/import commands will support sharing and review across clones.

## Usage

Ask the agent to call `portia_sense` before non-trivial work in unfamiliar project areas, or run:

```text
/portia-status
/portia-sense src/auth token expiry
```

`portia_sense` returns compact memories with ids, scopes, kinds, and retrieval signals. Treat the output as pointers to re-read source files and commands, not as complete ground truth.

Ask the main agent to call `portia_record` after verified durable project findings, for example:

```text
Record a Portia memory: scope src/auth, kind gotcha, title Auth fixtures, body Login tests require seeded user fixtures; read tests/auth before changing auth behavior.
```

`portia_record` writes immediately only when the effective write policy is `write`. In `readonly` and current `confirm` mode, it returns a structured proposal and does not persist a memory.

Use `sourceType` and `sourceRef` for provenance. When promoting an observational-memory fact, set `sourceType` to `observation` or `reflection` and put the observation/reflection id in `sourceRef`.

The FTS index is maintained by SQLite triggers.

## Settings

Global settings live in Pi's agent settings file. Project settings live in `.pi/settings.json` and override global settings.

```jsonc
{
  "portia": {
    "enabled": true,
    "dbPath": ".pi/portia/portia.sqlite",
    "writePolicy": "confirm",
    "workerWritePolicy": "readonly",
    "maxSenseResults": 12,
    "enableDependencyScan": true,
    "enableFts": true,
    "enableVectors": false,
    "autoPromptGuidance": true,
  },
}
```

Environment override:

```bash
PORTIA_MODE=readonly # force read-only/proposal-only behavior
PORTIA_MODE=off      # disable Portia tools/commands
```

Default public behavior is conservative: `writePolicy` defaults to `confirm`, which currently returns a proposal. If you want the main agent to record durable memories without asking every time, set:

```jsonc
{
  "portia": {
    "writePolicy": "write"
  },
  "pi-fork": {
    "environment": { "PORTIA_MODE": "readonly" }
  },
  "pi-minimal-subagent": {
    "environment": { "PORTIA_MODE": "readonly" }
  }
}
```

That gives the main session automatic Portia writes while fork/subagent child Pi processes remain proposal-only.

## Development

```bash
npm run typecheck
npm test
pi -e .
```
