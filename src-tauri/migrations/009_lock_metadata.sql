-- Add locked_by and locked_at columns to engagement for audit trail
ALTER TABLE engagement ADD COLUMN locked_by  TEXT;
ALTER TABLE engagement ADD COLUMN locked_at  TEXT;
