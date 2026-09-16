# Unified conversation read semantics

Search and statistics operate on **logical messages**, not observations. A
message whose source record has several observations is counted and returned
once. A source conversation filter is resolved through its current
`SourceConversation.unifiedConversationId`, so searching a unified conversation
returns every member source chat exactly once. `sourceAccountId` narrows that
same result to one owned account and is applied before pagination.

Merging changes presentation membership only: global message, media, people,
direction, and activity totals do not increase because of a merge. Conversation
totals and most-active rows use the distinct current unified conversation IDs.
Most-active titles use the owner-managed title when present, otherwise the
unified conversation title. Participant counts and people statistics are the
distinct people across the member source conversations; a person is counted
once even when present in multiple source chats. Unmerge immediately restores
the prior source-group membership without rewriting message IDs.

All result pages remain archive-scoped, bounded, cursor-paginated, and ordered
by the existing stable keys. Source provenance remains available on message
detail reads; it is not duplicated into search rows.
