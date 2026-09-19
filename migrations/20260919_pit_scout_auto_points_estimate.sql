-- Pit Scouting: "How many points do you usually score in auto?" - a short
-- free-text estimate (e.g. "10" or "5-15"), matching the reference pit
-- scouting form's field list. Nullable/optional like every other pit scout
-- column; pitScoutingSchema.js degrades gracefully if this hasn't been
-- applied yet on some environment.
ALTER TABLE public.pit_scout_entries ADD COLUMN IF NOT EXISTS auto_points_estimate text;
