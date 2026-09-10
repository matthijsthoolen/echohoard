-- Search is maintained by PostgreSQL whenever Message.body changes. Keeping
-- the vector in the database makes the hot query parameterized and lets the
-- GIN index be used without duplicating text-normalization in application code.
ALTER TABLE "Message"
ADD COLUMN "searchVector" tsvector
GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, COALESCE("body", ''::text))
) STORED;

CREATE INDEX "Message_searchVector_gin_idx"
ON "Message" USING GIN ("searchVector");
