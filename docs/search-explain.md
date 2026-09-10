# EH-06-03 search index proof

The PostgreSQL functional suite records the migration-managed full-text plan
against a deterministic 12,004-message fixture (12,000 generated messages and
four hand-authored cases, one archive-scoped). The fixture is intentionally
smaller than the five-million-message reference corpus; the plan check disables
only competing sequential/index scan paths inside its transaction so it proves
that the GIN structure is available without changing application defaults.

Command:

```text
pnpm test:functional
```

Representative `EXPLAIN (COSTS OFF)` output from PostgreSQL 17:

```text
Limit
  ->  Sort
        Sort Key: "sentAt", id
        ->  Bitmap Heap Scan on "Message"
              Recheck Cond: ("searchVector" @@ '''searchable'''::tsquery)
              Filter: ("archiveId" = '<synthetic archive UUID>'::uuid)
              ->  Bitmap Index Scan on "Message_searchVector_gin_idx"
                    Index Cond: ("searchVector" @@ '''searchable'''::tsquery)
```

The UUID is generated per test run and is deliberately not recorded. The
search service itself uses the same vector predicate with a parameterized
archive id and query, ranks matches with `ts_rank_cd`, and applies deterministic
cursor ordering.
