-- @lat: [[Specs#Feature A]]
CREATE VIEW feature_a AS SELECT 1;

-- A regular comment, not a ref.
-- @lat: [[Specs#Feature B]]
CREATE VIEW feature_b AS SELECT 2;

-- @lat: [[Specs#Nonexistent]]
CREATE VIEW missing AS SELECT 3;
