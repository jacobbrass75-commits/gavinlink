ALTER TABLE knowledge_entries
    ADD COLUMN IF NOT EXISTS chroma_id TEXT,
    ADD COLUMN IF NOT EXISTS source_file TEXT,
    ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER CHECK (
        duration_seconds IS NULL OR duration_seconds >= 0
    ),
    ADD COLUMN IF NOT EXISTS ai_summary TEXT,
    ADD COLUMN IF NOT EXISTS ai_action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS ai_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS ai_classifications TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS knowledge_entities (
    knowledge_entry_id UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (knowledge_entry_id, entity_id)
);

CREATE TABLE IF NOT EXISTS knowledge_properties (
    knowledge_entry_id UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    PRIMARY KEY (knowledge_entry_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chroma ON knowledge_entries(chroma_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_recorded_at ON knowledge_entries(recorded_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_classifications ON knowledge_entries USING gin(ai_classifications);
CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge_entries USING gin(ai_tags);
CREATE INDEX IF NOT EXISTS idx_knowledge_entities_entity ON knowledge_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_properties_property ON knowledge_properties(property_id);
