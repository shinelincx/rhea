CREATE OR REPLACE FUNCTION learning.resolve_confirmed_objective_regions(
  p_learning_profile_id uuid,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_question_region_id text,
  p_response_region_id text
) RETURNS TABLE (
  question_text text,
  response_text text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    question_region.value ->> 'text',
    response_region.value ->> 'text'
  FROM learning.confirmed_content_versions content
  JOIN learning.processing_jobs job
    ON job.id = content.job_id
   AND job.id = p_processing_job_id
   AND job.learning_profile_id = content.learning_profile_id
   AND job.status = 'completed'
  JOIN LATERAL jsonb_array_elements(content.regions) question_region(value)
    ON question_region.value ->> 'id' = p_question_region_id
   AND question_region.value ->> 'kind' = 'question'
  JOIN LATERAL jsonb_array_elements(content.regions) response_region(value)
    ON response_region.value ->> 'id' = p_response_region_id
   AND response_region.value ->> 'kind' = 'answer'
   AND response_region.value ->> 'questionRegionId' = p_question_region_id
  WHERE content.id = p_confirmed_content_version_id
    AND content.learning_profile_id = p_learning_profile_id
    AND p_learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
$$;

REVOKE ALL ON FUNCTION learning.resolve_confirmed_objective_regions(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;
