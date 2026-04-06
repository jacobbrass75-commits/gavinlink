ALTER TABLE properties
    ADD COLUMN IF NOT EXISTS beneficiary_name TEXT,
    ADD COLUMN IF NOT EXISTS lender_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS use_code TEXT,
    ADD COLUMN IF NOT EXISTS loan_amount NUMERIC(14,2) CHECK (loan_amount IS NULL OR loan_amount >= 0),
    ADD COLUMN IF NOT EXISTS ltv NUMERIC(12,4) CHECK (ltv IS NULL OR ltv >= 0),
    ADD COLUMN IF NOT EXISTS equity_amount NUMERIC(14,2) CHECK (equity_amount IS NULL OR equity_amount >= 0),
    ADD COLUMN IF NOT EXISTS equity_percent NUMERIC(12,4),
    ADD COLUMN IF NOT EXISTS default_amount NUMERIC(14,2) CHECK (default_amount IS NULL OR default_amount >= 0),
    ADD COLUMN IF NOT EXISTS default_date DATE,
    ADD COLUMN IF NOT EXISTS realestatetool_id BIGINT,
    ADD COLUMN IF NOT EXISTS ai_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_properties_lender_entity ON properties (lender_entity_id);
CREATE INDEX IF NOT EXISTS idx_properties_realestatetool_id ON properties (realestatetool_id);
