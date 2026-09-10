# Synthetic reference corpus

`pnpm generate:corpus` writes the bounded-memory CI corpus to JSONL. Use
`pnpm generate:corpus -- --full --output fixtures/reference-corpus.jsonl` for
the five-million-message, one-million-attachment local corpus. Both archives,
conversation/date distributions, and media types are deterministic for seed
`20260910`; records contain only synthetic identifiers and content.

When recording a performance run, capture the seed, record counts, generator
commit, Node/Prisma/PostgreSQL versions, CPU model and core count, RAM, storage
type, OS/container limits, elapsed time, peak RSS, and the exact command.
