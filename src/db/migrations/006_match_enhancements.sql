ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS narrative JSONB,
    ADD COLUMN IF NOT EXISTS narrative_generated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_scored_at TIMESTAMPTZ;

ALTER TABLE matches
    ALTER COLUMN status SET DEFAULT 'suggested';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'matches'::regclass
          AND conname = 'matches_status_check'
    ) THEN
        ALTER TABLE matches DROP CONSTRAINT matches_status_check;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'matches'::regclass
          AND conname = 'matches_status_check'
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_status_check
            CHECK (
                status IN (
                    'suggested',
                    'reviewed',
                    'contacted',
                    'in_negotiation',
                    'passed',
                    'closed',
                    'archived',
                    'candidate',
                    'accepted',
                    'rejected'
                )
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matches_score_suggested
    ON matches(score DESC)
    WHERE status = 'suggested';

CREATE INDEX IF NOT EXISTS idx_matches_buyer_profile
    ON matches(buyer_profile_id);

CREATE INDEX IF NOT EXISTS idx_matches_property_lookup
    ON matches(property_id);

CREATE INDEX IF NOT EXISTS idx_matches_status_lookup
    ON matches(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_buyer_property_unique
    ON matches(buyer_profile_id, property_id);
