CREATE TABLE IF NOT EXISTS property_alert_events (
    id UUID PRIMARY KEY,
    property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    property_group_id UUID REFERENCES property_groups(id) ON DELETE SET NULL,
    seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL,
    knowledge_entry_id UUID REFERENCES knowledge_entries(id) ON DELETE SET NULL,
    external_source TEXT NOT NULL CHECK (btrim(external_source) <> ''),
    source_message_id TEXT,
    source_thread_id TEXT,
    raw_email_subject TEXT,
    alert_name TEXT,
    radar_id TEXT,
    street TEXT,
    city TEXT,
    zip TEXT,
    state TEXT,
    property_type TEXT,
    sq_feet NUMERIC(14,2) CHECK (sq_feet IS NULL OR sq_feet >= 0),
    beds NUMERIC(8,2) CHECK (beds IS NULL OR beds >= 0),
    baths NUMERIC(8,2) CHECK (baths IS NULL OR baths >= 0),
    est_value NUMERIC(14,2) CHECK (est_value IS NULL OR est_value >= 0),
    change_summary TEXT NOT NULL CHECK (btrim(change_summary) <> ''),
    normalized_change_type TEXT,
    occurred_at TIMESTAMPTZ,
    recorded_via TEXT NOT NULL DEFAULT 'gmail_propertyradar' CHECK (btrim(recorded_via) <> ''),
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_alert_events_property
    ON property_alert_events (property_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_property_alert_events_group
    ON property_alert_events (property_group_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_property_alert_events_change_type
    ON property_alert_events (normalized_change_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_property_alert_events_message
    ON property_alert_events (external_source, source_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_property_alert_events_message_radar_change
    ON property_alert_events (
        external_source,
        COALESCE(source_message_id, ''),
        COALESCE(radar_id, ''),
        change_summary
    );
