-- Migration 006: map number enhancements
-- default_grouping_id: accounts mapped here get auto-assigned to this grouping
-- flip_map_code: if an account's balance is negative, reclassify it under this map code instead

ALTER TABLE map_numbers ADD COLUMN default_grouping_id INTEGER REFERENCES groupings(id) ON DELETE SET NULL;
ALTER TABLE map_numbers ADD COLUMN flip_map_code TEXT REFERENCES map_numbers(code) ON DELETE SET NULL;
