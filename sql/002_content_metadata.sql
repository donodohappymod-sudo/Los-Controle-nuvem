ALTER TABLE contents ADD COLUMN IF NOT EXISTS series_name TEXT;
ALTER TABLE contents ADD COLUMN IF NOT EXISTS season_number INTEGER;
ALTER TABLE contents ADD COLUMN IF NOT EXISTS episode_number INTEGER;
ALTER TABLE contents ADD COLUMN IF NOT EXISTS source_page_url TEXT;
CREATE INDEX IF NOT EXISTS contents_series_idx ON contents(user_id, series_name, season_number, episode_number);
