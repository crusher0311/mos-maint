-- Apply before deploying the location-switching code. No data backfill.
ALTER TABLE extension_sessions ADD COLUMN IF NOT EXISTS authentication_method text;
ALTER TABLE extension_sessions ADD COLUMN IF NOT EXISTS parent_token_hash text;
