-- get_annotations always filters by scope, but the UNIQUE(account_number, scope)
-- index is account_number-first and can't serve a scope-only lookup. Add a
-- dedicated scope index matching the actual access pattern. (E4)
CREATE INDEX IF NOT EXISTS idx_annotations_scope
    ON leadsheet_annotations(scope);
