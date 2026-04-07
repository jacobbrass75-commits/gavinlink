CREATE TABLE IF NOT EXISTS property_groups (
    id UUID PRIMARY KEY,
    region TEXT NOT NULL CHECK (btrim(region) <> ''),
    group_key TEXT NOT NULL CHECK (btrim(group_key) <> ''),
    canonical_address TEXT,
    canonical_city TEXT,
    canonical_state TEXT,
    aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    source TEXT NOT NULL DEFAULT 'system' CHECK (btrim(source) <> ''),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (region, group_key)
);

ALTER TABLE properties
    ADD COLUMN IF NOT EXISTS property_group_id UUID REFERENCES property_groups(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS property_import_records (
    id UUID PRIMARY KEY,
    property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    property_group_id UUID REFERENCES property_groups(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    source_file TEXT,
    source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number > 0),
    source_record_key TEXT,
    dedupe_key TEXT,
    apn TEXT,
    address TEXT,
    city TEXT,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS property_documents (
    id UUID PRIMARY KEY,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    property_group_id UUID REFERENCES property_groups(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL CHECK (btrim(file_name) <> ''),
    storage_path TEXT NOT NULL CHECK (btrim(storage_path) <> ''),
    mime_type TEXT NOT NULL CHECK (btrim(mime_type) <> ''),
    file_size BIGINT NOT NULL CHECK (file_size >= 0),
    sha256 TEXT NOT NULL CHECK (btrim(sha256) <> ''),
    document_type TEXT NOT NULL DEFAULT 'other' CHECK (btrim(document_type) <> ''),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (btrim(source) <> ''),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_property_group ON properties(property_group_id);
CREATE INDEX IF NOT EXISTS idx_property_groups_address_trgm ON property_groups USING GIN (canonical_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_property_import_records_property ON property_import_records(property_id);
CREATE INDEX IF NOT EXISTS idx_property_import_records_group ON property_import_records(property_group_id);
CREATE INDEX IF NOT EXISTS idx_property_import_records_source_file ON property_import_records(source, source_file);
CREATE INDEX IF NOT EXISTS idx_property_documents_property ON property_documents(property_id);
CREATE INDEX IF NOT EXISTS idx_property_documents_group ON property_documents(property_group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_import_records_source_unique
    ON property_import_records (source, COALESCE(source_file, ''), COALESCE(source_row_number, 0), COALESCE(source_record_key, ''));
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_documents_property_sha
    ON property_documents (property_id, sha256);
