# Changelog

All notable changes to `pi-portia` are documented here.

This project follows Semantic Versioning after `v1.0.0`. Before v1, minor releases may still include breaking changes, but those changes should be called out in this file and in release notes.

## [Unreleased]

### Added

- Beta status documentation and a roadmap from beta to v1.
- Agent usage guide covering `portia_sense`, `portia_search`, `portia_list`, `portia_inspect`, `portia_record`, and `portia_repair`.
- Safe `portia_search` workflow with FTS5 query sanitization, snippets, filters, configurable limits, and cursor pagination.
- Cursor pagination and configurable limits for `portia_list`.
- Generated `search_terms` expansion for paths, code-like identifiers, and camelCase terms.
- Read-only `/portia-doctor` command and `portia_doctor` tool for schema, FTS, trigger, search-term, and orphan-row diagnostics.
- Command-only `/portia-reindex [dry-run]` maintenance workflow for recomputing search terms and rebuilding FTS.
- SQLite data-location and portability documentation for `.pi/portia/portia.sqlite`.
- Command parser, renderer, tool registration/schema, migration fixture, doctor, and reindex test coverage.
- CI matrix for Node.js 22 and 24 plus `npm pack --dry-run` packaging validation.
- Release and semver policy documentation in `docs/release.md`.

### Changed

- Search result snippets now avoid exposing generated `search_terms` text when a visible column snippet is available.
- Autopilot and tool guidance now steer broad keyword/history recall toward `portia_search` instead of raising `portia_sense` limits.
- Package metadata now declares Node.js `>=22` support.

### Removed

- Built-in logical export/import and backup commands are intentionally out of v1 scope; Portia data portability is SQLite-file based.

## [0.1.0] - 2026-05-13

### Added

- Initial npm release of `pi-portia`.
- SQLite-backed project-local memory store.
- Core sense, record, list, inspect, repair, status, trails, autopilot, and pheromone workflows.
