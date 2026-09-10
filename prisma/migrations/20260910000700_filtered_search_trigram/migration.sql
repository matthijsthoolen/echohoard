-- Fuzzy matching is deliberately limited to display names, conversation
-- titles, and message bodies. The generated full-text vector has its own GIN
-- index; these indexes support the pg_trgm % predicates used by filtered
-- search without changing the database-wide similarity threshold.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Person_displayName_trgm_idx"
ON "Person" USING GIN ("displayName" gin_trgm_ops);

CREATE INDEX "Conversation_title_trgm_idx"
ON "Conversation" USING GIN ("title" gin_trgm_ops);

CREATE INDEX "Message_body_trgm_idx"
ON "Message" USING GIN ("body" gin_trgm_ops);

-- Media filtering starts from the archive-scoped message link and then
-- applies this narrow MIME lookup on the attachment side.
CREATE INDEX "Attachment_archiveId_mimeType_idx"
ON "Attachment" ("archiveId", "mimeType");
