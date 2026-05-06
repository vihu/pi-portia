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
- `/portia-list`
- `/portia-inspect <id>`
- `/portia-repair <id> <stale|delete|reactivate> <reason>`
- `/portia-delete <id> <reason>` soft-delete convenience command
- `portia_sense` read-only tool
- `portia_record` write/proposal tool
- `portia_list` read-only tool
- `portia_inspect` read-only tool
- `portia_repair` write/proposal tool
- turn-local autopilot guidance and bounded context injection

Not implemented yet:

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

Portia includes a small autopilot layer. On each agent turn it can add turn-local guidance and a bounded `Portia Project Context` pack selected from existing memories by prompt/path. This should make Portia useful during normal work without adding persistent boilerplate messages to the session.

You can still run explicit commands:

```text
/portia-status
/portia-sense src/auth token expiry
/portia-list
/portia-list all
/portia-list kind decision
/portia-list scope src/auth
/portia-list query autopilot
/portia-inspect <memory-id>
/portia-repair <memory-id> delete Temporary test memory; safe to hide from active retrieval.
/portia-delete <memory-id> Temporary test memory; safe to hide from active retrieval.
```

`portia_sense` returns compact memories with ids, scopes, kinds, and retrieval signals. Treat the output as pointers to re-read source files and commands, not as complete ground truth.

Use `portia_list`/`/portia-list` to browse memories, `portia_inspect`/`/portia-inspect` to view one memory with provenance and event history, and `portia_repair`/`/portia-repair` to soft-mark memories `stale`, `deleted`, or active again via `reactivate`. Repair keeps rows and appends memory events; it does not physically delete records. `/portia-delete <id> <reason>` is a shorter human-facing alias for soft deletion.

The main agent can call `portia_record` after verified durable project findings, for example:

```text
Record a Portia memory: scope src/auth, kind gotcha, title Auth fixtures, body Login tests require seeded user fixtures; read tests/auth before changing auth behavior.
```

`portia_record` writes immediately only when the effective write policy is `write`. In `readonly` and current `confirm` mode, it returns a structured proposal and does not persist a memory. It blocks exact duplicate active memories by default (`duplicatePolicy: "blockExact"`), can return related-memory warnings, and accepts `supersedesId` to create a replacement memory while atomically marking the old active memory `superseded`.

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
    "autoRecordGuidance": true,
    "autoSense": true,
    "autoSenseMaxResults": 5,
    "autoSenseMaxChars": 2500,
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
    "writePolicy": "write",
  },
  "pi-fork": {
    "environment": { "PORTIA_MODE": "readonly" },
  },
  "pi-minimal-subagent": {
    "environment": { "PORTIA_MODE": "readonly" },
  },
}
```

That gives the main session automatic Portia writes while fork/subagent child Pi processes remain proposal-only.

Autopilot settings:

- `autoPromptGuidance`: add turn-local Portia guidance to the system prompt
- `autoRecordGuidance`: include `portia_record` guidance in that prompt section
- `autoSense`: internally retrieve a bounded context pack for each turn
- `autoSenseMaxResults`: max memories in that pack, capped at 12
- `autoSenseMaxChars`: max rendered pack size, capped at 12000

Autopilot does not run a background summarizer or silently write memories by itself. It makes the agent more likely to sense and record intentionally.

## Development

```bash
npm run typecheck
npm test
pi -e .
```

If `pi-portia` is also installed globally, avoid duplicate tool registration during local smoke tests by loading only the explicit checkout:

```bash
PI_OFFLINE=1 pi --no-extensions -e . --no-session -p "/portia-status"
```
