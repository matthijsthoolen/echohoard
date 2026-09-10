# Bounded filtered search contract

`ArchiveReadService.search` always requires an archive scope and asks the
persistence adapter for at most `limit + 1` rows. The returned page contains
at most `MAX_READ_LIMIT` (100) messages. A signed cursor is scoped to both the
archive and a canonical encoding of every search term and filter; changing a
filter or pagination direction invalidates the cursor.

## Terms and filters

- `query` is trimmed and searched with PostgreSQL `plainto_tsquery` using the
  `simple` configuration. It matches message bodies through the generated
  `searchVector` column.
- `fuzzyText` (or its `text` alias) applies PostgreSQL `pg_trgm` `%` matching
  to the message body. `fuzzyName` (or `name`) applies `%` matching to the
  sender's observed display name or the conversation title. A fuzzy match
  returns the existing message/person/conversation IDs; it never merges
  identities or changes stored names.
- `conversationId` selects one conversation and `personId` selects messages
  sent by that exact person ID. Both are constrained to the requested
  archive.
- `senderDirection` selects `sent`, `received`, or `unknown`. Missing or
  unsupported metadata is treated as `unknown`; it is independent from the
  cursor's `forward`/`backward` pagination direction.
- `from` is an inclusive ISO timestamp and `to` is an exclusive ISO timestamp.
  Invalid timestamps and a `from` later than `to` are rejected before SQL is
  called.
- `mediaType` matches a linked attachment MIME family: `image`, `video`, or
  `audio` match the corresponding `type/*` family; `document` matches a
  non-null MIME outside those three families; `other` matches a null MIME.
  Link and attachment archive IDs must match the message archive.

Terms and filter values are always bound parameters. SQL identifiers and sort
expressions are fixed constants, never derived from request input.

## Ordering and cursors

Rows are ordered by descending match score, then ascending sent timestamp,
then ascending message ID for forward pages. Null `sentAt` uses the fixed
high timestamp sentinel, so it sorts last. Backward pages reverse each of
those comparisons. The cursor stores `(score, sortableSentAt, messageId)` and
the signed archive/filter scope. Inserts before or after a page therefore do
not cause that page's boundary to be returned twice or skipped.
