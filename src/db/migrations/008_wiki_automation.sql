ALTER TABLE property_documents
    ADD COLUMN IF NOT EXISTS knowledge_entry_id UUID REFERENCES knowledge_entries(id) ON DELETE SET NULL;

ALTER TABLE property_documents
    ADD COLUMN IF NOT EXISTS wiki_page_path TEXT;

ALTER TABLE property_documents
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_property_documents_knowledge_entry
    ON property_documents (knowledge_entry_id);

CREATE TABLE IF NOT EXISTS wiki_promotion_queue (
    id UUID PRIMARY KEY,
    knowledge_entry_id UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    target_page TEXT,
    title_override TEXT,
    priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_promotion_queue_entry
    ON wiki_promotion_queue (knowledge_entry_id);

CREATE INDEX IF NOT EXISTS idx_wiki_promotion_queue_status_priority
    ON wiki_promotion_queue (status, priority DESC, created_at ASC);
