DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_reporting_app') THEN
    CREATE ROLE rhea_reporting_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_reporting_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_reporting_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_reporting_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_reporting_app;
GRANT USAGE ON SCHEMA learning TO rhea_reporting_app;

GRANT SELECT ON
  learning.guardian_memberships,
  learning.family_consents,
  learning.processing_jobs,
  learning.suggested_assessments,
  learning.objective_assessments,
  learning.objective_assessment_versions,
  learning.assessment_disputes,
  learning.wrong_items,
  learning.review_card_requests,
  learning.review_cards,
  learning.learning_evidence,
  learning.wrong_item_theme_mastery,
  learning.theme_mastery_transitions
TO rhea_reporting_app;

GRANT EXECUTE ON FUNCTION learning.lock_current_wrong_item(learning.wrong_items)
  TO rhea_reporting_app;
