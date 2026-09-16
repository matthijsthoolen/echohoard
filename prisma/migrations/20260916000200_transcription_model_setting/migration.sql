-- EHV2-06-02: archive-scoped, non-secret LiteLLM model selection.
ALTER TABLE "Archive" ADD COLUMN "transcriptionModel" TEXT;
