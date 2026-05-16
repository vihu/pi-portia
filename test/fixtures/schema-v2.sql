create table portia_meta (key text primary key, value text not null);
insert into portia_meta(key, value) values ('schema_version', '2');

create table memories (
  id text primary key,
  scope_path text not null,
  kind text not null,
  title text,
  body text not null,
  status text not null default 'active',
  importance integer not null default 0,
  confidence integer not null default 100,
  created_at text not null,
  updated_at text not null,
  created_by text,
  supersedes_id text references memories(id),
  source_type text,
  source_ref text
);

create virtual table memory_fts using fts5(
  title,
  body,
  scope_path,
  kind,
  content='memories',
  content_rowid='rowid'
);

insert into memories (
  id, scope_path, kind, title, body, status, importance, confidence,
  created_at, updated_at, created_by, supersedes_id, source_type, source_ref
) values (
  'legacy-search', 'src/config.ts', 'gotcha', 'Legacy search metadata',
  'Changing maxSenseResults must be searchable by component words.',
  'active', 5, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  'test', null, 'manual', 'docs/LegacyNote.md'
);
