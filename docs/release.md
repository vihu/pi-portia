# pi-portia release and compatibility policy

This document is the release operator checklist for `pi-portia`. It is intentionally conservative: releases should be boring, repeatable, and safe for existing SQLite memory stores.

## Version policy

### Pre-v1 releases

- `0.x` releases are beta releases.
- Prefer `0.2.0`, `0.3.0`, etc. for beta feature/hardening releases.
- Patch releases such as `0.2.1` should be bug fixes or documentation fixes.
- Breaking changes may still happen before `1.0.0`, but they must be documented in `CHANGELOG.md` and called out in release notes.
- If a prerelease is useful before v1, use versions such as `1.0.0-beta.1` or `1.0.0-rc.1` only when the public API is nearly frozen.

### v1 and later

After `1.0.0`, Semantic Versioning applies to the public surface.

Semver-major is required for incompatible changes to:

- tool names or tool availability,
- tool parameter schemas,
- slash command names or required syntax,
- documented settings names or meanings,
- durable memory status/kind semantics,
- migration behavior that requires manual intervention,
- documented data-location guarantees.

Semver-minor may add backwards-compatible tools, commands, optional parameters, settings, render details, or diagnostics.

Semver-patch should be limited to bug fixes, documentation corrections, dependency compatibility updates, and small behavior fixes that preserve documented contracts.

Human-readable renderer wording, ranking weights, and diagnostic wording may evolve in minor or patch releases when the documented tool schemas and core semantics stay compatible.

## Migration and data policy

- The SQLite database at `.pi/portia/portia.sqlite` is the complete project-local Portia data store.
- Portia does not include a built-in logical export/import or backup command for v1.
- Before a significant upgrade, users who care about rollback should copy `.pi/portia/portia.sqlite` while Pi is not actively writing to it, or use normal SQLite-safe copy practices.
- Schema migrations must be forward-only and idempotent.
- The current schema version must be covered by tests and representative migration fixtures when schema changes are introduced.
- Public diagnostics must use the read-only doctor path so `/portia-doctor` and `portia_doctor` do not mutate the database or hide the state they are diagnosing.
- Search schema/index changes should include `/portia-reindex dry-run` guidance and tests proving reindex can restore consistency.
- Downgrades are not guaranteed. If downgrade support is needed, restore a copy of the SQLite file taken before the upgrade.

## Manual release checklist

Agents should prepare docs and validation, but a human maintainer should perform version bumps, npm publishing, and deployment/reload unless explicitly instructed otherwise.

### 1. Preflight

```bash
git -C pi-portia status --short --branch
npm -C pi-portia install
```

Confirm the branch is the intended release branch and review all uncommitted changes.

### 2. Update release notes

1. Move relevant entries from `CHANGELOG.md` `Unreleased` into the target version section.
2. Add the release date.
3. Call out any breaking changes or migration notes explicitly.
4. Confirm README status and install instructions match the intended release.

### 3. Validate locally

```bash
npm -C pi-portia run typecheck
npm -C pi-portia test
cd pi-portia && actionlint .github/workflows/ci.yml
cd pi-portia && npm pack --dry-run
git -C pi-portia diff --check
```

For migration or maintenance-heavy releases, also smoke-test in a disposable project or fixture checkout:

```text
/portia-status
/portia-doctor
/portia-reindex dry-run
/portia-sense . release smoke
/portia-search release smoke
/portia-list limit 2
```

### 4. Audit package metadata and tarball

```bash
npm -C pi-portia pkg get name version description engines files peerDependencies
cd pi-portia && npm pack --dry-run
```

Confirm the tarball includes at least:

- `README.md`
- `CHANGELOG.md`
- `package.json`
- `docs/`
- `src/`

Confirm the package uses current Pi package names:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

### 5. Bump version

For a beta hardening release, prefer:

```bash
npm -C pi-portia version 0.2.0 --no-git-tag-version
```

For v1 prereleases or release candidates, use a prerelease version such as:

```bash
npm -C pi-portia version 1.0.0-rc.1 --no-git-tag-version
```

Re-run validation after the version bump because `package.json` and `package-lock.json` change.

### 6. Commit and tag manually

Use conventional commits. Example messages:

```text
docs(portia): document release and semver policy
chore(portia): release 0.2.0
```

Create tags only after validation is green and the release commit is final.

### 7. Publish

From the package directory:

```bash
cd pi-portia
npm publish --access public
npm view pi-portia name version keywords
```

Do not publish from the parent workspace.

### 8. Post-publish smoke

In a Pi environment:

```bash
pi install npm:pi-portia
```

Then restart Pi or run `/reload` if supported.

Run a short smoke test in a disposable or known-safe project:

```text
/portia-status
/portia-doctor
/portia-sense . release smoke
/portia-search portia
/portia-list limit 2
/portia-reindex dry-run
```

If a real project database is involved, copy `.pi/portia/portia.sqlite` first if rollback matters.

### 9. If something goes wrong

- Prefer publishing a patch release with a fix over unpublishing.
- If a migration issue is involved, preserve the broken database copy for diagnosis.
- Run `/portia-doctor` before attempting manual SQLite edits.
- Use `/portia-reindex dry-run` before `/portia-reindex` for search/index issues.
- Document the issue and fix in `CHANGELOG.md`.
