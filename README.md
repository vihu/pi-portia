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

Not implemented yet:

- `portia_record`
- `portia_repair`
- export/import
- reflection/proposal workflow
- vector search

## Installation

For local development from this checkout:

```bash
cd /home/rahul/personal/pi-custom/pi-portia
npm install
pi -e .
```

Or add the package path to Pi settings:

```jsonc
{
  "packages": ["/home/rahul/personal/pi-custom/pi-portia"],
}
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

## Manual seeding for the MVP

Until `portia_record` exists, seed memories directly with SQLite if needed:

```bash
sqlite3 .pi/portia/portia.sqlite <<'SQL'
insert into memories (
  id, scope_path, kind, title, body, status, importance, confidence,
  created_at, updated_at, created_by, source_type, source_ref
) values (
  lower(hex(randomblob(8))),
  'src/auth',
  'gotcha',
  'Auth fixtures',
  'Login tests require seeded user fixtures; read tests/auth before changing auth behavior.',
  'active',
  5,
  90,
  datetime('now'),
  datetime('now'),
  'manual',
  'manual',
  'sqlite'
);
SQL
```

The FTS index is maintained by triggers.

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
PORTIA_MODE=readonly # force read-only behavior
PORTIA_MODE=off      # disable Portia tools/commands
```

The current MVP is read-only at the memory level regardless of `writePolicy`; the policy is reported by `/portia-status` for the upcoming write tools.

## Development

```bash
npm run typecheck
npm test
pi -e .
```
