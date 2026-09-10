CREATE OR REPLACE FUNCTION learning.resolve_generated_learning_eligibility(
  p_learning_profile_id uuid,
  p_family_space_id uuid
) RETURNS TABLE (
  age_band text,
  consent_revision integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    CASE
      WHEN profile.grade BETWEEN 5 AND 6 THEN 'upper_primary'
      WHEN profile.grade BETWEEN 3 AND 4 THEN 'middle_primary'
      ELSE 'lower_primary'
    END,
    consent.revision
  FROM learning.learning_profiles profile
  JOIN learning.family_consents consent
    ON consent.family_space_id = profile.family_space_id
   AND consent.kind = 'ai_processing'
   AND consent.status = 'granted'
  WHERE profile.id = p_learning_profile_id
    AND profile.family_space_id = p_family_space_id
    AND p_learning_profile_id::text =
      current_setting('rhea.learning_profile_id', true)
    AND p_family_space_id::text =
      current_setting('rhea.family_space_id', true)
$$;

REVOKE ALL ON FUNCTION learning.resolve_generated_learning_eligibility(
  uuid, uuid
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.lock_current_generated_learning_eligibility(
  p_learning_profile_id uuid,
  p_family_space_id uuid,
  p_consent_revision integer,
  p_age_band text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_age_band text;
  v_consent_revision integer;
  v_consent_status text;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true) THEN
    RETURN 'source_changed';
  END IF;

  SELECT CASE
    WHEN profile.grade BETWEEN 5 AND 6 THEN 'upper_primary'
    WHEN profile.grade BETWEEN 3 AND 4 THEN 'middle_primary'
    ELSE 'lower_primary'
  END
  INTO v_age_band
  FROM learning.learning_profiles profile
  WHERE profile.id = p_learning_profile_id
    AND profile.family_space_id = p_family_space_id
  FOR UPDATE;

  IF NOT FOUND OR v_age_band IS DISTINCT FROM p_age_band THEN
    RETURN 'source_changed';
  END IF;

  SELECT consent.revision, consent.status
  INTO v_consent_revision, v_consent_status
  FROM learning.family_consents consent
  WHERE consent.family_space_id = p_family_space_id
    AND consent.kind = 'ai_processing'
  FOR UPDATE;

  IF NOT FOUND
     OR v_consent_status IS DISTINCT FROM 'granted'
     OR v_consent_revision IS DISTINCT FROM p_consent_revision THEN
    RETURN 'consent_withdrawn';
  END IF;

  RETURN 'authorized';
END
$$;

REVOKE ALL ON FUNCTION learning.lock_current_generated_learning_eligibility(
  uuid, uuid, integer, text
) FROM PUBLIC;
