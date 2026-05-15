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
- `/portia-search <query>` with safe FTS5 search, ranking, snippets, filters, and cursor pagination
- `/portia-inspect <id>`
- `/portia-repair <id> <stale|delete|reactivate> <reason>`
- `/portia-delete <id> <reason>` soft-delete convenience command
- `portia_sense` read-only tool
- `portia_record` write/proposal tool
- `portia_list` read-only tool
- `portia_search` read-only tool
- `portia_inspect` read-only tool
- `portia_repair` write/proposal tool
- turn-local autopilot guidance and bounded context injection
- automatic pheromone trace capture for exposed/followed/validated memories
- conservative pheromone-aware retrieval ranking with visible `PHEROMONE` signals
- `/portia-trails` pheromone trail browser
- generated search-term expansion for code paths and camelCase identifiers

Not implemented yet:

- export/import
- reflection/proposal workflow
- vector search
- public `/portia-reindex` maintenance command
- cursor pagination for `portia_list`

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

| API                                  | Use for                             | Notes                                                                         |
| ------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------- |
| `portia_sense` / `/portia-sense`     | bounded path/task context           | compact output for agent context; not for exhaustive browsing                 |
| `portia_search` / `/portia-search`   | explicit keyword search             | safe FTS5 queries, snippets, filters, and cursor pagination                   |
| `portia_list` / `/portia-list`       | structured inventory/audit browsing | status/kind/scope/query filters; list cursor pagination is planned separately |
| `portia_inspect` / `/portia-inspect` | full details for one memory         | provenance, event history, and pheromone summary                              |
| `portia_record`                      | write or propose durable memories   | honors `writePolicy`/`workerWritePolicy`                                      |
| `portia_repair` / `/portia-repair`   | soft-repair memory status           | marks stale/deleted/active without physical deletion                          |

`portia_sense` returns compact memories with ids, scopes, kinds, and retrieval signals. Use it for bounded path/task context before unfamiliar work. Treat the output as pointers to re-read source files and commands, not as complete ground truth. When pheromones are enabled, reinforced memories may receive a bounded `PHEROMONE` boost, but only after they were already selected by normal proximity/dependency/FTS candidate generation.

Use `portia_search`/`/portia-search` for explicit keyword search across memories, especially in long sessions where `portia_sense` is intentionally too bounded. Search supports status, kind, scope, ordering, match mode, substring fallback, configurable page limits, and opaque cursor pagination. Use the returned `nextCursor` with the same query and filters to continue browsing additional pages; cursors validate against the original query/filter fingerprint and do not store the full query.

Search query text is plain input, not raw FTS syntax. Portia quotes search terms before sending them to SQLite FTS5, so code-like literals such as `/portia-list`, `src/config.ts`, `foo:bar`, `-6`, and words like `AND`/`OR` are treated safely instead of as operators. Default `matchMode` is `all`; use `match any` for broader recall or `match phrase` for an exact phrase. Generated `search_terms` help component searches find code/camelCase text such as `maxSenseResults` from `max sense results`.

Use `portia_list`/`/portia-list` for structured inventory browsing/auditing, `portia_inspect`/`/portia-inspect` to view one memory with provenance, event history, and a compact pheromone summary, and `portia_repair`/`/portia-repair` to soft-mark memories `stale`, `deleted`, or active again via `reactivate`. Repair keeps rows and appends memory events; it does not physically delete records. `/portia-delete <id> <reason>` is a shorter human-facing alias for soft deletion. Use `/portia-trails` to inspect reinforced, weak, recent, or per-memory pheromone traces.

The main agent can call `portia_record` after verified durable project findings, for example:

```text
Record a Portia memory: scope src/auth, kind gotcha, title Auth fixtures, body Login tests require seeded user fixtures; read tests/auth before changing auth behavior.
```

`portia_record` writes immediately only when the effective write policy is `write`. In `readonly` and current `confirm` mode, it returns a structured proposal and does not persist a memory. It blocks exact duplicate active memories by default (`duplicatePolicy: "blockExact"`), can return related-memory warnings, and accepts `supersedesId` to create a replacement memory while atomically marking the old active memory `superseded`.

Use `sourceType` and `sourceRef` for provenance. When promoting an observational-memory fact, set `sourceType` to `observation` or `reflection` and put the observation/reflection id in `sourceRef`.

The FTS index is maintained by SQLite triggers. Schema migrations rebuild the external-content FTS index when indexed columns change, including the generated `search_terms` column used for code/camelCase search expansion. There is no public `/portia-reindex` command yet; reindexing is currently internal migration/maintenance behavior.

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

Autopilot does not run a background summarizer or silently write semantic memories by itself. It makes the agent more likely to sense and record intentionally.

Search and browse settings:

- `maxSenseResults`: default maximum for `portia_sense`; capped at 50 so context retrieval stays bounded
- `searchDefaultLimit`: default page size for `portia_search`; default `30`
- `searchMaxResults`: maximum accepted `portia_search` page size; default `250`, absolute cap `500`
- `listDefaultLimit` and `listMaxResults`: parsed for list browsing configuration; `portia_list` cursor/default-limit adoption is planned in the list ergonomics phase

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

```bash
npm run typecheck
npm test
pi -e .
```

If `pi-portia` is also installed globally, avoid duplicate tool registration during local smoke tests by loading only the explicit checkout:

```bash
PI_OFFLINE=1 pi --no-extensions -e . --no-session -p "/portia-status"
```
