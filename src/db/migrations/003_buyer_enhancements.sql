ALTER TABLE buyer_profiles
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS target_cities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS target_zip_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS min_cap_rate NUMERIC(8,4) CHECK (min_cap_rate IS NULL OR min_cap_rate >= 0),
    ADD COLUMN IF NOT EXISTS investment_strategy TEXT CHECK (
        investment_strategy IS NULL OR investment_strategy IN (
            'value_add',
            'stabilized',
            'development',
            'owner_user',
            'flip',
            '1031_exchange'
        )
    ),
    ADD COLUMN IF NOT EXISTS financing_preference TEXT CHECK (
        financing_preference IS NULL OR financing_preference IN (
            'cash',
            'conventional',
            'sba',
            'bridge',
            'seller_financing'
        )
    ),
    ADD COLUMN IF NOT EXISTS typical_close_timeline TEXT CHECK (
        typical_close_timeline IS NULL OR typical_close_timeline IN (
            '30_days',
            '60_days',
            '90_days'
        )
    ),
    ADD COLUMN IF NOT EXISTS urgency TEXT CHECK (
        urgency IS NULL OR urgency IN (
            'actively_looking',
            'opportunistic',
            'long_term'
        )
    ),
    ADD COLUMN IF NOT EXISTS sensibilities TEXT;

CREATE TABLE IF NOT EXISTS buyer_purchases (
    id UUID PRIMARY KEY,
    buyer_profile_id UUID NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,
    property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    purchase_price NUMERIC(14,2) NOT NULL CHECK (purchase_price >= 0),
    purchase_date DATE NOT NULL,
    deal_type TEXT NOT NULL DEFAULT 'purchase' CHECK (
        deal_type IN ('purchase', 'lease', 'exchange')
    ),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyer_profiles_entity_id ON buyer_profiles(entity_id);
CREATE INDEX IF NOT EXISTS idx_buyer_profiles_active ON buyer_profiles(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_buyer_purchases_profile ON buyer_purchases(buyer_profile_id);
CREATE INDEX IF NOT EXISTS idx_buyer_purchases_property ON buyer_purchases(property_id);
CREATE INDEX IF NOT EXISTS idx_properties_trustee_active ON properties(trustee_entity_id) WHERE trustee_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_lender_active ON properties(lender_entity_id) WHERE lender_entity_id IS NOT NULL;
