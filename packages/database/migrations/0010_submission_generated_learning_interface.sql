CREATE OR REPLACE FUNCTION learning.lock_current_generated_learning_content(
  p_learning_profile_id uuid,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_excerpts jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_regions jsonb;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR jsonb_typeof(p_excerpts) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_excerpts) = 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM learning.processing_jobs job
  WHERE job.id = p_processing_job_id
    AND job.learning_profile_id = p_learning_profile_id
    AND job.status = 'completed'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT content.regions
  INTO v_regions
  FROM learning.confirmed_content_versions content
  WHERE content.id = p_confirmed_content_version_id
    AND content.job_id = p_processing_job_id
    AND content.learning_profile_id = p_learning_profile_id
  FOR KEY SHARE;

  IF NOT FOUND OR jsonb_typeof(v_regions) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_excerpts) excerpt(value)
    WHERE jsonb_typeof(excerpt.value) IS DISTINCT FROM 'object'
      OR excerpt.value ->> 'kind' NOT IN ('question', 'answer', 'shared_prompt')
      OR COALESCE(excerpt.value ->> 'regionId', '') = ''
      OR COALESCE(excerpt.value ->> 'text', '') = ''
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_regions) region(value)
        WHERE region.value ->> 'id' = excerpt.value ->> 'regionId'
          AND region.value ->> 'kind' = excerpt.value ->> 'kind'
          AND region.value ->> 'text' = excerpt.value ->> 'text'
      )
  ) THEN
    RETURN false;
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT excerpt.value ->> 'regionId')
    FROM jsonb_array_elements(p_excerpts) excerpt(value)
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_excerpts) excerpt(value)
    WHERE excerpt.value ->> 'kind' = 'answer'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_regions) answer_region(value)
        JOIN jsonb_array_elements(v_regions) question_region(value)
          ON question_region.value ->> 'id' =
             answer_region.value ->> 'questionRegionId'
         AND question_region.value ->> 'kind' = 'question'
        JOIN jsonb_array_elements(p_excerpts) question_excerpt(value)
          ON question_excerpt.value ->> 'regionId' =
             question_region.value ->> 'id'
         AND question_excerpt.value ->> 'kind' = 'question'
        WHERE answer_region.value ->> 'id' = excerpt.value ->> 'regionId'
          AND answer_region.value ->> 'kind' = 'answer'
      )
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.lock_current_generated_learning_content(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC;
