-- Evaluates one preference against one profile answer inside SQL, so dealbreakers are hard filters.
-- A missing answer never satisfies a dealbreaker. Multi-value answers satisfy if any element does.
CREATE OR REPLACE FUNCTION pref_satisfied(op text, pref jsonb, ans jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  WITH a AS (
    SELECT lower(x) AS v FROM jsonb_array_elements_text(
      CASE WHEN ans IS NULL THEN '[]'::jsonb WHEN jsonb_typeof(ans) = 'array' THEN ans ELSE jsonb_build_array(ans) END
    ) AS x
  ), p AS (
    SELECT lower(x) AS v FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(pref) = 'array' THEN pref ELSE jsonb_build_array(pref) END
    ) AS x
  ), n AS (
    SELECT v::numeric AS v FROM a WHERE v ~ '^-?[0-9]+(\.[0-9]+)?$'
  )
  SELECT CASE op
    WHEN 'eq'      THEN EXISTS (SELECT 1 FROM a JOIN p USING (v))
    WHEN 'in'      THEN EXISTS (SELECT 1 FROM a JOIN p USING (v))
    WHEN 'neq'     THEN EXISTS (SELECT 1 FROM a) AND NOT EXISTS (SELECT 1 FROM a JOIN p USING (v))
    WHEN 'not_in'  THEN EXISTS (SELECT 1 FROM a) AND NOT EXISTS (SELECT 1 FROM a JOIN p USING (v))
    WHEN 'gte'     THEN EXISTS (SELECT 1 FROM n WHERE n.v >= (pref #>> '{}')::numeric)
    WHEN 'lte'     THEN EXISTS (SELECT 1 FROM n WHERE n.v <= (pref #>> '{}')::numeric)
    WHEN 'between' THEN EXISTS (SELECT 1 FROM n WHERE n.v >= (pref ->> 0)::numeric AND n.v <= (pref ->> 1)::numeric)
    ELSE false
  END
$$;
