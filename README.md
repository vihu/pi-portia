# Pi Portia

Pi-native spatial project memory for agents.

Portia is a project-local, inspectable memory layer backed by SQLite. It stores pointers, gotchas, decisions, invariants, purpose, patterns, and plans that help future agents re-perceive code faster. It does not replace reading source files.

## Status

Beta.

Portia is usable for day-to-day local project memory. The core workflows are implemented and validated, but the public tool/command surface and maintenance workflows may still change before `v1.0.0`.

Implemented now:

- SQLite database creation and migrations using `better-sqlite3`
- project-local DB at `.pi/portia/portia.sqlite`
- `/portia-status`
- `/portia-doctor`
- `/portia-reindex [dry-run]`
- `/portia-sense <path> [query]`
- `/portia-list` with structured filters, configurable page limits, and cursor pagination
- `/portia-search <query>` with safe FTS5 search, ranking, snippets, filters, and cursor pagination
- `/portia-inspect <id>`
- `/portia-repair <id> <stale|delete|reactivate> <reason>`
- `/portia-delete <id> <reason>` soft-delete convenience command
- `/portia-trails` pheromone trail browser
- `portia_sense` read-only tool
- `portia_record` write/proposal tool
- `portia_list` read-only tool
- `portia_search` read-only tool
- `portia_doctor` read-only tool
- `portia_inspect` read-only tool
- `portia_repair` write/proposal tool
- turn-local autopilot guidance and bounded context injection
- automatic pheromone trace capture for exposed/followed/validated memories
- conservative pheromone-aware retrieval ranking with visible `PHEROMONE` signals
- generated search-term expansion for code paths and camelCase identifiers
- documented SQLite data-location and portability model (no built-in backup/import/export workflow planned for v1)
- parser, renderer, tool-schema, and migration fixture test coverage
- changelog plus release, semver, migration, and package checklist documentation

V1 hardening roadmap:

- additional search/list polish for long-session ergonomics
- v1 release-candidate audit and smoke testing

Deferred until measured need:

- vector search
- trigram accelerator for substring fallback
- cloud/remote sync
- automatic broad search on every agent turn
- rich TUI dashboards

## Installation

Install from npm with Pi:

```bash
pi install npm:pi-portia
```

Alternatively, install directly from GitHub:

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

The database is the complete Portia data store for the checkout. It is intended to be shared by all agents working in the same checkout and may still be excluded from Git by a global ignore rule. Portia does not add a separate backup/export/import layer for v1; if you need to move a project memory store, move or copy this SQLite file, preferably while Pi is not writing to it or using normal SQLite-safe copy practices.

## Usage

Portia includes a small autopilot layer. On each agent turn it can add turn-local guidance, a bounded `Portia Project Context` pack selected from existing memories by prompt/path, and an intent-gated historical recall assist for prompts that clearly ask about prior decisions, evidence, or memory history. This should make Portia useful during normal work without adding persistent boilerplate messages to the session.

You can still run explicit commands:

```text
/portia-status
/portia-doctor
/portia-reindex dry-run
/portia-reindex
/portia-sense src/auth token expiry
/portia-list
/portia-list all
/portia-list kind decision
/portia-list scope src/auth
/portia-list query autopilot
/portia-list limit 50
/portia-list scope src/auth cursor <nextCursor>
/portia-list cursor <nextCursor> query autopilot
/portia-search portia search limits
/portia-search query max sense results
/portia-search kind decision search limits
/portia-search scope src limit 50 fts
/portia-search match any order updated query /portia-list
/portia-search scope src limit 50 cursor <nextCursor> query fts
/portia-inspect <memory-id>
/portia-trails
/portia-trails recent
/portia-trails memory <memory-id>
/portia-repair <memory-id> delete Temporary test memory; safe to hide from active retrieval.
/portia-delete <memory-id> Temporary test memory; safe to hide from active retrieval.
```

Tool/command quick reference:

| API                                  | Use for                             | Notes                                                                             |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------- |
| `portia_sense` / `/portia-sense`     | bounded path/task context           | compact output for agent context; not for exhaustive browsing                     |
| `portia_search` / `/portia-search`   | explicit keyword search             | safe FTS5 queries, snippets, filters, and cursor pagination                       |
| `portia_list` / `/portia-list`       | structured inventory/audit browsing | status/kind/scope/query filters, configurable limits, and cursor pagination       |
| `portia_doctor` / `/portia-doctor`   | database health diagnostics         | read-only checks for schema, FTS, triggers, search terms, and orphaned rows       |
| `/portia-reindex`                    | search index maintenance            | command-only; recomputes `search_terms` and rebuilds FTS when write policy allows |
| `portia_inspect` / `/portia-inspect` | full details for one memory         | provenance, event history, and pheromone summary                                  |
| `portia_record`                      | write or propose durable memories   | honors `writePolicy`/`workerWritePolicy`                                          |
| `portia_repair` / `/portia-repair`   | soft-repair memory status           | marks stale/deleted/active without physical deletion                              |

For more detailed agent guidance, see [`docs/agent-usage.md`](docs/agent-usage.md).

`portia_sense` returns compact memories with ids, scopes, kinds, and retrieval signals. Use it for bounded path/task context before unfamiliar work. Treat the output as pointers to re-read source files and commands, not as complete ground truth. When pheromones are enabled, reinforced memories may receive a bounded `PHEROMONE` boost, but only after they were already selected by normal proximity/dependency/FTS candidate generation.

Use `portia_search`/`/portia-search` for explicit keyword search across memories, especially in long sessions where `portia_sense` is intentionally too bounded. Search is the right tool for prior decisions, old validation notes, package names, error strings, and broad concept recall. Search supports status, kind, scope, ordering, match mode, substring fallback, configurable page limits, and opaque cursor pagination. Use the returned `nextCursor` with the same query and filters to continue browsing additional pages; cursors validate against the original query/filter fingerprint and do not store the full query.

Autopilot can also assist search-shaped turns. In default `autoSearchMode: "assist"`, medium-confidence historical prompts receive a concrete `portia_search` suggestion, while high-confidence prompts can receive a tiny `Portia Historical Recall Preview` generated from internal search. The preview is bounded and pointer-only; it omits DB paths, cursor metadata, no-hit sections, and full provenance. Routine path/edit/test prompts should continue to rely on `portia_sense` and should not receive search preview noise.

Search query text is plain input, not raw FTS syntax. Portia quotes search terms before sending them to SQLite FTS5, so code-like literals such as `/portia-list`, `src/config.ts`, `foo:bar`, `-6`, and words like `AND`/`OR` are treated safely instead of as operators. Default `matchMode` is `all`; use `match any` for broader recall or `match phrase` for an exact phrase. Generated `search_terms` help component searches find code/camelCase text such as `maxSenseResults` from `max sense results`.

Use `portia_list`/`/portia-list` for structured inventory browsing/auditing. List keeps `query` as a simple case-insensitive substring inventory filter over memory title, body, scope, kind, and provenance; use `portia_search` for FTS relevance ranking and snippets. List output includes page metadata and `nextCursor` when more rows are available. Repeat the same status/scope/kind/query filters with the cursor to continue browsing. In slash-command syntax, put `cursor <nextCursor>` before `query <text>` because `query` consumes the rest of the command.

Use `portia_inspect`/`/portia-inspect` to view one memory with provenance, event history, and a compact pheromone summary, and `portia_repair`/`/portia-repair` to soft-mark memories `stale`, `deleted`, or active again via `reactivate`. Repair keeps rows and appends memory events; it does not physically delete records. `/portia-delete <id> <reason>` is a shorter human-facing alias for soft deletion. Use `/portia-trails` to inspect reinforced, weak, recent, or per-memory pheromone traces.

The main agent can call `portia_record` after verified durable project findings, for example:

```text
Record a Portia memory: scope src/auth, kind gotcha, title Auth fixtures, body Login tests require seeded user fixtures; read tests/auth before changing auth behavior.
```

`portia_record` writes immediately only when the effective write policy is `write`. In `readonly` and current `confirm` mode, it returns a structured proposal and does not persist a memory. It blocks exact duplicate active memories by default (`duplicatePolicy: "blockExact"`), can return related-memory warnings, and accepts `supersedesId` to create a replacement memory while atomically marking the old active memory `superseded`.

Use `sourceType` and `sourceRef` for provenance. When promoting an observational-memory fact, set `sourceType` to `observation` or `reflection` and put the observation/reflection id in `sourceRef`.

Use `portia_doctor`/`/portia-doctor` for read-only health diagnostics. Doctor checks the schema version, expected tables/columns, FTS availability and row consistency, FTS maintenance triggers, null `search_terms`, orphaned event/pheromone/trace/edge rows, foreign-key integrity, and DB path. It reports warnings/errors only; it does not mutate the database.

The FTS index is maintained by SQLite triggers. Schema migrations rebuild the external-content FTS index when indexed columns change, including the generated `search_terms` column used for code/camelCase search expansion. Use `/portia-reindex dry-run` to preview search maintenance and `/portia-reindex` to recompute all generated `search_terms` and rebuild `memory_fts`. Reindex honors the effective write policy; if policy is not `write`, it reports what would happen without applying changes.

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
    "searchDefaultLimit": 30,
    "searchMaxResults": 250,
    "listDefaultLimit": 30,
    "listMaxResults": 250,
    "enableDependencyScan": true,
    "enableFts": true,
    "enableVectors": false,
    "autoPromptGuidance": true,
    "autoRecordGuidance": true,
    "autoSense": true,
    "autoSenseMaxResults": 5,
    "autoSenseMaxChars": 2500,
    "autoSearchMode": "assist",
    "autoSearchMaxResults": 5,
    "autoSearchMaxChars": 900,
    "enablePheromones": true,
    "pheromoneRanking": true,
    "pheromoneHalfLifeDays": 30,
    "pheromoneMaxBoost": 25,
    "pheromoneFollowWeight": 1,
    "pheromoneSuccessWeight": 2,
    "pheromoneFailureWeight": -0.4,
    "pheromoneIgnoredWeight": 0,
    "pheromoneWorkerPolicy": "off",
    "traceRetentionDays": 180,
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
- `autoSearchMode`: historical recall assist mode, one of `off`, `suggest`, `assist`, or `context`; default `assist`
- `autoSearchMaxResults`: max search hits in automatic preview/suggestion limits, default `5`, capped at 12
- `autoSearchMaxChars`: max rendered automatic search preview size, default `900`, capped at 8000

Mode behavior:

| Mode      | Behavior                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | No search-intent suggestion and no internal historical search preview.                                                                                                             |
| `suggest` | Detected historical/broad-memory prompts append a concrete `portia_search` suggestion only; no internal search is performed.                                                       |
| `assist`  | Default middle ground: medium-confidence prompts get the suggestion only; high-confidence prior-decision/provenance/audit prompts get a tiny internal preview plus the suggestion. |
| `context` | Stronger opt-in: detected medium/high confidence prompts can receive compact internal search preview plus the suggestion.                                                          |

Autopilot does not run a background summarizer or silently write semantic memories by itself. It makes the agent more likely to sense, search, and record intentionally.

Search and browse settings:

- `maxSenseResults`: default maximum for `portia_sense`; capped at 50 so context retrieval stays bounded
- `searchDefaultLimit`: default page size for `portia_search`; default `30`
- `searchMaxResults`: maximum accepted `portia_search` page size; default `250`, absolute cap `500`
- `listDefaultLimit`: default page size for `portia_list`; default `30`
- `listMaxResults`: maximum accepted `portia_list` page size; default `250`, absolute cap `500`

Pheromone settings:

- `enablePheromones`: record behavioral traces and summary pheromone strength
- `pheromoneRanking`: allow bounded pheromone boosts in `portia_sense` ranking; set false for debug/dark-mode operation
- `pheromoneHalfLifeDays`: lazy decay half-life for stored strength
- `pheromoneMaxBoost`: maximum rank points a positive pheromone can contribute
- `pheromoneFollowWeight`: weight when an exposed memory's scope/source is read or edited
- `pheromoneSuccessWeight`: additional weight when validation passes after following a memory
- `pheromoneFailureWeight`: weak negative weight when validation fails after following a memory
- `pheromoneIgnoredWeight`: weight for exposed-but-unfollowed memories; default `0`
- `pheromoneWorkerPolicy`: `off`, `low`, or `write` behavior when the effective write policy is readonly
- `traceRetentionDays`: retention horizon for raw trace events

Pheromones adjust salience of existing active memories. They do not create new semantic memories automatically.

## Development

`pi-portia` supports Node.js 22 or newer; CI validates Node 22 and 24.

See [`CHANGELOG.md`](./CHANGELOG.md) for release notes and [`docs/release.md`](./docs/release.md) for the release checklist, semver policy, and migration/data-location policy.

```bash
npm run typecheck
npm test
pi -e .
```

If `pi-portia` is also installed globally, avoid duplicate tool registration during local smoke tests by loading only the explicit checkout:

```bash
PI_OFFLINE=1 pi --no-extensions -e . --no-session -p "/portia-status"
```
