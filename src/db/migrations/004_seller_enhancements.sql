ALTER TABLE seller_profiles
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS motivation TEXT CHECK (
        motivation IS NULL OR motivation IN (
            'foreclosure',
            'estate',
            'retirement',
            'partnership_dissolution',
            'relocation',
            'financial_distress',
            'portfolio_rebalance',
            '1031_exchange',
            'market_timing',
            'unknown'
        )
    ),
    ADD COLUMN IF NOT EXISTS distress_level SMALLINT CHECK (
        distress_level IS NULL OR distress_level BETWEEN 1 AND 5
    ),
    ADD COLUMN IF NOT EXISTS timeline TEXT CHECK (
        timeline IS NULL OR timeline IN (
            'urgent',
            '30_days',
            '60_days',
            '90_days',
            'flexible'
        )
    ),
    ADD COLUMN IF NOT EXISTS foreclosure_stage TEXT CHECK (
        foreclosure_stage IS NULL OR foreclosure_stage IN (
            'none',
            'pre_foreclosure',
            'notice_of_default',
            'notice_of_sale',
            'auction_pending',
            'reo',
            'unknown'
        )
    ),
    ADD COLUMN IF NOT EXISTS outstanding_debt NUMERIC(14,2) CHECK (
        outstanding_debt IS NULL OR outstanding_debt >= 0
    ),
    ADD COLUMN IF NOT EXISTS estimated_equity NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS minimum_acceptable NUMERIC(14,2) CHECK (
        minimum_acceptable IS NULL OR minimum_acceptable >= 0
    ),
    ADD COLUMN IF NOT EXISTS lender_status TEXT CHECK (
        lender_status IS NULL OR lender_status IN (
            'cooperating',
            'non_responsive',
            'pursuing_foreclosure',
            'open_to_short_sale',
            'unknown'
        )
    ),
    ADD COLUMN IF NOT EXISTS legal_issues TEXT,
    ADD COLUMN IF NOT EXISTS sensibilities TEXT,
    ADD COLUMN IF NOT EXISTS approach_suggestions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS ai_reasoning TEXT,
    ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS inferred_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_profiles_property_unique
    ON seller_profiles(property_id);

CREATE INDEX IF NOT EXISTS idx_seller_profiles_entity_id
    ON seller_profiles(entity_id);

CREATE INDEX IF NOT EXISTS idx_seller_profiles_active
    ON seller_profiles(active)
    WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_seller_profiles_distress
    ON seller_profiles(distress_level)
    WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_seller_profiles_stage
    ON seller_profiles(foreclosure_stage);

CREATE INDEX IF NOT EXISTS idx_properties_foreclosure_active
    ON properties(foreclosure)
    WHERE foreclosure = TRUE;

CREATE INDEX IF NOT EXISTS idx_properties_owner_entity_active
    ON properties(owner_entity_id)
    WHERE owner_entity_id IS NOT NULL;
