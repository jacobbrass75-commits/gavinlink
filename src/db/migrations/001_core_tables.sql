CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN (
            'person',
            'llc',
            'trust',
            'corporation',
            'lender',
            'trustee',
            'broker',
            'partnership',
            'unknown'
        )
    ),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    normalized_name TEXT NOT NULL CHECK (btrim(normalized_name) <> ''),
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    phone TEXT,
    email TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (btrim(source) <> ''),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (normalized_name, entity_type)
);

CREATE TABLE IF NOT EXISTS entity_relationships (
    id UUID PRIMARY KEY,
    parent_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    child_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL CHECK (btrim(relationship_type) <> ''),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (btrim(source) <> ''),
    confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0000 CHECK (confidence >= 0 AND confidence <= 1),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (parent_entity_id <> child_entity_id),
    UNIQUE (parent_entity_id, child_entity_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY,
    apn TEXT NOT NULL CHECK (btrim(apn) <> ''),
    address TEXT,
    city TEXT,
    state TEXT NOT NULL CHECK (btrim(state) <> ''),
    zip TEXT,
    property_type TEXT NOT NULL CHECK (btrim(property_type) <> ''),
    sq_feet NUMERIC(14,2) CHECK (sq_feet IS NULL OR sq_feet >= 0),
    lot_size NUMERIC(14,2) CHECK (lot_size IS NULL OR lot_size >= 0),
    assessed_value NUMERIC(14,2) CHECK (assessed_value IS NULL OR assessed_value >= 0),
    units INTEGER CHECK (units IS NULL OR units >= 0),
    foreclosure BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    region TEXT NOT NULL CHECK (btrim(region) <> ''),
    owner_name TEXT,
    trustee_name TEXT,
    trustee_phone TEXT,
    owner_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    trustee_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    titlepro_recording_date DATE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (apn, region)
);

CREATE TABLE IF NOT EXISTS buyer_profiles (
    id UUID PRIMARY KEY,
    entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    preferred_property_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    target_markets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    min_price NUMERIC(14,2) CHECK (min_price IS NULL OR min_price >= 0),
    max_price NUMERIC(14,2) CHECK (max_price IS NULL OR max_price >= 0),
    min_sq_feet NUMERIC(14,2) CHECK (min_sq_feet IS NULL OR min_sq_feet >= 0),
    max_sq_feet NUMERIC(14,2) CHECK (max_sq_feet IS NULL OR max_sq_feet >= 0),
    min_lot_size NUMERIC(14,2) CHECK (min_lot_size IS NULL OR min_lot_size >= 0),
    max_lot_size NUMERIC(14,2) CHECK (max_lot_size IS NULL OR max_lot_size >= 0),
    min_units INTEGER CHECK (min_units IS NULL OR min_units >= 0),
    max_units INTEGER CHECK (max_units IS NULL OR max_units >= 0),
    requires_foreclosure BOOLEAN NOT NULL DEFAULT FALSE,
    buy_box JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (min_price IS NULL OR max_price IS NULL OR min_price <= max_price),
    CHECK (min_sq_feet IS NULL OR max_sq_feet IS NULL OR min_sq_feet <= max_sq_feet),
    CHECK (min_lot_size IS NULL OR max_lot_size IS NULL OR min_lot_size <= max_lot_size),
    CHECK (min_units IS NULL OR max_units IS NULL OR min_units <= max_units)
);

CREATE TABLE IF NOT EXISTS seller_profiles (
    id UUID PRIMARY KEY,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (
        status IN (
            'unknown',
            'monitoring',
            'open',
            'engaged',
            'under_contract',
            'closed',
            'not_interested'
        )
    ),
    motivation_level SMALLINT CHECK (motivation_level IS NULL OR motivation_level BETWEEN 0 AND 10),
    distress_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    situation_summary TEXT,
    asking_price NUMERIC(14,2) CHECK (asking_price IS NULL OR asking_price >= 0),
    target_close_date DATE,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (btrim(source) <> ''),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_id, property_id)
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
    id UUID PRIMARY KEY,
    entry_type TEXT NOT NULL CHECK (
        entry_type IN (
            'call_transcript',
            'call_note',
            'meeting_note',
            'market_insight',
            'email',
            'document',
            'other'
        )
    ),
    title TEXT,
    content TEXT NOT NULL CHECK (btrim(content) <> ''),
    summary TEXT,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    author_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    embedding_ref TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY,
    buyer_profile_id UUID NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,
    seller_profile_id UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    score NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (
        status IN ('candidate', 'reviewed', 'accepted', 'rejected', 'contacted', 'archived')
    ),
    reasoning TEXT,
    factor_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_by TEXT NOT NULL DEFAULT 'system' CHECK (btrim(generated_by) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (buyer_profile_id, seller_profile_id, property_id)
);

CREATE TABLE IF NOT EXISTS deals (
    id UUID PRIMARY KEY,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    buyer_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    seller_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
    deal_type TEXT NOT NULL DEFAULT 'sale' CHECK (
        deal_type IN ('sale', 'lease', 'assignment', 'other')
    ),
    status TEXT NOT NULL DEFAULT 'prospect' CHECK (
        status IN ('prospect', 'loi', 'under_contract', 'closed', 'dead')
    ),
    contract_price NUMERIC(14,2) CHECK (contract_price IS NULL OR contract_price >= 0),
    closed_price NUMERIC(14,2) CHECK (closed_price IS NULL OR closed_price >= 0),
    close_date DATE,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (btrim(source) <> ''),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING GIN (normalized_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_parent ON entity_relationships (parent_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_child ON entity_relationships (child_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_type ON entity_relationships (relationship_type);

CREATE INDEX IF NOT EXISTS idx_properties_region_foreclosure ON properties (region, foreclosure);
CREATE INDEX IF NOT EXISTS idx_properties_city_state ON properties (city, state);
CREATE INDEX IF NOT EXISTS idx_properties_owner_entity ON properties (owner_entity_id);
CREATE INDEX IF NOT EXISTS idx_properties_trustee_entity ON properties (trustee_entity_id);
CREATE INDEX IF NOT EXISTS idx_properties_address_trgm ON properties USING GIN (address gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_buyer_profiles_status ON buyer_profiles (status);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_status ON seller_profiles (status);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_property ON seller_profiles (property_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_property ON knowledge_entries (property_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_entity ON knowledge_entries (entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_author ON knowledge_entries (author_entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_type_occurred ON knowledge_entries (entry_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_property ON matches (property_id);
CREATE INDEX IF NOT EXISTS idx_matches_status_score ON matches (status, score DESC);

CREATE INDEX IF NOT EXISTS idx_deals_property_status ON deals (property_id, status);
CREATE INDEX IF NOT EXISTS idx_deals_buyer_entity ON deals (buyer_entity_id);
CREATE INDEX IF NOT EXISTS idx_deals_seller_entity ON deals (seller_entity_id);
