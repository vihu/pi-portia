# Portia agent usage guide

Portia memories are durable project-local pointers. They help an agent re-perceive a codebase faster, but they do not replace reading source files, running commands, or checking provenance.

## Tool choice

| Need                                                   | Use              | Why                                                                                                 |
| ------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| Bounded context for a path/task before unfamiliar work | `portia_sense`   | Small spatial/context pack designed for agent prompts.                                              |
| Broad keyword or historical recall                     | `portia_search`  | FTS-backed search with snippets, filters, and cursor pagination.                                    |
| Inventory or audit browsing                            | `portia_list`    | Structured status/kind/scope/query filters over stored memories.                                    |
| Database health diagnostics                            | `portia_doctor`  | Read-only checks for schema, FTS, triggers, search terms, and orphaned rows.                        |
| Full provenance or event history for one memory        | `portia_inspect` | Shows source, status, event history, and pheromone summary.                                         |
| Persist a verified project fact                        | `portia_record`  | Records or proposes durable pointers, decisions, gotchas, patterns, invariants, purpose, and plans. |
| Hide, stale, or reactivate a memory                    | `portia_repair`  | Soft status repair with auditable memory events.                                                    |

## Recommended flow

1. Start non-trivial unfamiliar work with `portia_sense` on the relevant path and task query.
2. If you need broader recall by concept, old decision, error text, package name, or feature name, use `portia_search`.
3. If autopilot adds a `Portia Historical Recall Preview`, treat it as a small pointer pack, not proof; verify source/provenance before relying on it.
4. If autopilot adds a `Portia historical recall suggestion`, strongly consider calling `portia_search` with the suggested query/filter parameters before answering.
5. If you need to audit what exists before recording or repairing memory, use `portia_list`.
6. If Portia retrieval or persistence seems unhealthy, use `portia_doctor` before manual SQLite inspection.
7. Before relying on a memory for provenance-sensitive work, use `portia_inspect` or verify the referenced files/commands directly.
8. After durable findings are verified, use `portia_record` with concise body text and explicit provenance.
9. Use `portia_repair` only for verified stale, bad, test, duplicate, or revalidated memories.

## When `portia_search` is better than `portia_sense`

Use `portia_search` when the question is about memory history rather than immediate path context:

- "Did we already decide how search pagination should work?"
- "Find memories mentioning `maxSenseResults`."
- "What rollout or validation notes exist for portia-search?"
- "Search all memories for a package name, error string, or old command."
- "Find deleted/stale/superseded memories related to a topic."

`portia_sense` may internally use bounded FTS chord retrieval, but it is intentionally compact and does not replace the full `portia_search` service. Do not keep raising `portia_sense` limits to browse memory history; switch to `portia_search` or `portia_list`.

## Autopilot historical recall assist

When enabled, Portia autopilot can detect search-shaped turns and add one or both of these sections:

- `Portia Historical Recall Preview`: a tiny internal search preview for high-confidence historical/provenance/audit prompts in default `assist` mode. It is bounded, omits DB/cursor/page noise, suppresses no-hit output, and contains pointers only.
- `Portia historical recall suggestion`: concrete `portia_search` parameters for the current turn. Use the suggestion when you need broader recall than the preview or when no preview was injected.

Default `autoSearchMode` is `assist`: medium-confidence historical prompts get only the suggestion, while high-confidence prompts can get the compact preview plus the suggestion. `suggest` disables internal search previews, `context` allows previews for more detected prompts, and `off` disables this search assist entirely.

Automatic search defaults to `status: "active"`. Use `status: "any"` only when the task is explicitly about stale, deleted, superseded, repaired, reactivated, inactive, or all-status memory history.

## Search examples

```text
/portia-search portia search limits
/portia-search query max sense results
/portia-search kind decision search pagination
/portia-search status any match any order updated query rollout validation
/portia-search scope pi-portia/src limit 50 query /portia-list
```

Search queries are plain text. Portia quotes terms before using SQLite FTS5, so code-like text such as `/portia-list`, `src/config.ts`, `foo:bar`, `-6`, and `AND OR NOT` is treated as input text rather than raw FTS syntax.

For another page, repeat the same query and filters with the cursor:

```text
/portia-search scope pi-portia/src limit 50 cursor <nextCursor> query /portia-list
```

Cursors store only a fingerprint and keyset position. They do not store the original query or filters.

## List examples

```text
/portia-list
/portia-list all
/portia-list kind decision
/portia-list scope pi-portia/src
/portia-list cursor <nextCursor> query autopilot
```

Use `portia_list` for inventory/audit browsing. Its `query` filter is a simple substring filter, not FTS relevance ranking. In slash-command syntax, put `cursor <nextCursor>` before `query <text>` because `query` consumes the rest of the command.

## Doctor and reindex examples

```text
/portia-doctor
/portia-reindex dry-run
/portia-reindex
```

Doctor is read-only. Use it when diagnosing schema version, FTS index, trigger, search-term, foreign-key, or orphaned-row issues. Treat warnings/errors as maintenance signals; do not assume memories are lost without inspecting the DB or running the appropriate maintenance command.

`/portia-reindex` is command-only maintenance. It recomputes generated `search_terms` and rebuilds the FTS index when the effective write policy is `write`. Use `dry-run` first when investigating or when the policy is not writable.

## Data location and portability

Portia stores all project-local data in `.pi/portia/portia.sqlite`. There is no `portia_export`, `portia_import`, or `portia_backup` workflow for normal v1 use. If a user asks how to move Portia data between checkouts or machines, point them at that SQLite file rather than inventing a logical export/import flow. Prefer copying it while Pi is not actively writing to it, or use normal SQLite-safe copy practices.

## Recording guidance

Good memories are durable, project-specific, and useful to future agents. Prefer:

- decisions and rationale,
- gotchas and invariants,
- navigation pointers,
- package commands,
- validation/release facts,
- spatial relationships between files.

Avoid recording:

- generic programming advice,
- raw conversation summaries,
- every file read,
- unverified speculation,
- ephemeral todo chatter.

Include provenance with `sourceType` and `sourceRef`. When promoting an observational-memory fact, preserve the observation/reflection id in `sourceRef` and set `sourceType` accordingly.

## Repair guidance

Repairs are soft status changes. They preserve rows and append audit events.

Before repair:

1. Inspect or otherwise verify the memory.
2. Provide a clear reason.
3. Prefer `stale` for outdated facts and `delete` for test/bad/irrelevant memories.
4. Use `reactivate` only after confirming the memory is valid again.

## Do we need a Portia skill?

A general Portia usage skill is not required for normal operation. The extension exposes tool descriptions, prompt guidance, autopilot context, and docs that teach agents how to choose between sense/search/list/inspect/record/repair.

A separate skill may still be useful later for developing or releasing `pi-portia` itself, such as migration design, package publishing, and production reload checklists.
