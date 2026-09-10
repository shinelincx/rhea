CREATE TABLE learning.objective_grading_rule_versions (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  confirmed_content_version_id uuid NOT NULL REFERENCES learning.confirmed_content_versions(id),
  question_region_id text NOT NULL CHECK (char_length(question_region_id) BETWEEN 1 AND 200),
  basis_source_version_id uuid NOT NULL REFERENCES learning.learning_source_versions(id),
  basis_selection_version integer NOT NULL CHECK (basis_selection_version > 0),
  basis_validity_epoch integer NOT NULL CHECK (basis_validity_epoch > 0),
  revision integer NOT NULL CHECK (revision > 0),
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  grading_rule jsonb NOT NULL CHECK (
    jsonb_typeof(grading_rule) = 'object'
    AND grading_rule ->> 'kind' IN ('numeric', 'accepted_text', 'single_choice')
    AND (
      (grading_rule ->> 'kind' = 'numeric' AND jsonb_typeof(grading_rule -> 'expected') = 'string')
      OR (
        grading_rule ->> 'kind' = 'accepted_text'
        AND jsonb_typeof(grading_rule -> 'acceptedAnswers') = 'array'
        AND jsonb_typeof(grading_rule -> 'caseSensitive') = 'boolean'
        AND jsonb_typeof(grading_rule -> 'collapseWhitespace') = 'boolean'
      )
      OR (
        grading_rule ->> 'kind' = 'single_choice'
        AND jsonb_typeof(grading_rule -> 'correctOption') = 'string'
      )
    )
  ),
  requires_professional_review boolean NOT NULL DEFAULT false,
  authority text NOT NULL CHECK (authority IN ('guardian_confirmed', 'trusted_import')),
  created_by_id uuid,
  created_at timestamptz NOT NULL,
  predecessor_id uuid REFERENCES learning.objective_grading_rule_versions(id),
  UNIQUE (
    material_id,
    confirmed_content_version_id,
    question_region_id,
    basis_source_version_id,
    basis_selection_version,
    basis_validity_epoch,
    revision
  )
);

CREATE TABLE learning.objective_assessments (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  deduplication_key text NOT NULL CHECK (deduplication_key ~ '^[0-9a-f]{64}$'),
  current_version_id uuid,
  open_dispute_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, id),
  UNIQUE (learning_profile_id, deduplication_key)
);

CREATE TABLE learning.objective_assessment_versions (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  question jsonb NOT NULL,
  response jsonb NOT NULL,
  input_reference jsonb NOT NULL,
  input_authority jsonb NOT NULL,
  grading_rule jsonb,
  grading_rule_version_id text,
  decision jsonb NOT NULL,
  requires_professional_review boolean NOT NULL,
  basis_source_version_id uuid NOT NULL REFERENCES learning.learning_source_versions(id),
  basis_selection_version integer NOT NULL CHECK (basis_selection_version > 0),
  basis_validity_epoch integer NOT NULL CHECK (basis_validity_epoch > 0),
  basis_content_hash text NOT NULL CHECK (basis_content_hash ~ '^[0-9a-f]{64}$'),
  basis_kind text NOT NULL CHECK (basis_kind IN ('learning_material', 'question', 'answer', 'grading_basis')),
  basis_version_label text NOT NULL,
  predecessor_id uuid REFERENCES learning.objective_assessment_versions(id),
  created_by_type text NOT NULL CHECK (created_by_type IN ('guardian', 'learner', 'professional')),
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (assessment_id, revision)
);

CREATE TABLE learning.assessment_disputes (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('assessment', 'question', 'response')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  correction_text text NOT NULL CHECK (char_length(correction_text) BETWEEN 1 AND 4000),
  review_route text NOT NULL CHECK (review_route IN ('guardian', 'professional')),
  raised_by_type text NOT NULL CHECK (raised_by_type IN ('guardian', 'learner')),
  raised_by_id uuid NOT NULL,
  raised_at timestamptz NOT NULL,
  UNIQUE (assessment_id, id)
);

CREATE TABLE learning.assessment_dispute_resolutions (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  dispute_id uuid NOT NULL UNIQUE REFERENCES learning.assessment_disputes(id),
  prior_assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  resulting_assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  resolved_by_type text NOT NULL CHECK (resolved_by_type IN ('guardian', 'professional')),
  resolved_by_id uuid NOT NULL,
  resolved_at timestamptz NOT NULL
);

ALTER TABLE learning.objective_assessments
  ADD CONSTRAINT objective_assessments_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES learning.objective_assessment_versions(id),
  ADD CONSTRAINT objective_assessments_open_dispute_fk
    FOREIGN KEY (open_dispute_id) REFERENCES learning.assessment_disputes(id);

CREATE TABLE learning.assessment_access_audit (
  id bigserial PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX objective_assessments_profile_time_idx
  ON learning.objective_assessments (learning_profile_id, created_at DESC);
CREATE INDEX objective_assessment_versions_history_idx
  ON learning.objective_assessment_versions (assessment_id, revision DESC);
CREATE INDEX assessment_disputes_history_idx
  ON learning.assessment_disputes (assessment_id, raised_at DESC);
CREATE INDEX assessment_access_audit_profile_time_idx
  ON learning.assessment_access_audit (learning_profile_id, occurred_at DESC);
CREATE INDEX objective_grading_rules_lookup_idx
  ON learning.objective_grading_rule_versions (
    learning_profile_id,
    material_id,
    confirmed_content_version_id,
    question_region_id
  );

CREATE OR REPLACE FUNCTION learning.resolve_objective_assessment_input(
  p_learning_profile_id uuid,
  p_material_id uuid,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_question_region_id text,
  p_response_region_id text,
  p_basis_source_version_id uuid,
  p_basis_selection_version integer,
  p_basis_validity_epoch integer
) RETURNS TABLE (
  question_text text,
  response_text text,
  subject text,
  grading_rule_version_id text,
  grading_rule jsonb,
  requires_professional_review boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    confirmed.question_text,
    confirmed.response_text,
    basis.subject,
    rule.id::text,
    rule.grading_rule,
    COALESCE(rule.requires_professional_review, false)
      OR basis.requires_professional_review
  FROM learning.resolve_objective_assessment_basis(
    p_learning_profile_id,
    p_material_id,
    p_confirmed_content_version_id,
    p_basis_source_version_id,
    p_basis_selection_version,
    p_basis_validity_epoch
  ) basis
  CROSS JOIN learning.resolve_confirmed_objective_regions(
    p_learning_profile_id,
    p_processing_job_id,
    p_confirmed_content_version_id,
    p_question_region_id,
    p_response_region_id
  ) confirmed
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.grading_rule, candidate.requires_professional_review
    FROM learning.objective_grading_rule_versions candidate
    WHERE candidate.learning_profile_id = p_learning_profile_id
      AND candidate.material_id = p_material_id
      AND candidate.confirmed_content_version_id = p_confirmed_content_version_id
      AND candidate.question_region_id = p_question_region_id
      AND candidate.basis_source_version_id = p_basis_source_version_id
      AND candidate.basis_selection_version = p_basis_selection_version
      AND candidate.basis_validity_epoch = p_basis_validity_epoch
      AND candidate.subject = basis.subject
    ORDER BY candidate.revision DESC
    LIMIT 1
  ) rule ON true
$$;

REVOKE ALL ON FUNCTION learning.resolve_objective_assessment_input(
  uuid, uuid, uuid, uuid, text, text, uuid, integer, integer
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.confirm_objective_grading_rule(
  p_learning_profile_id uuid,
  p_family_space_id uuid,
  p_material_id uuid,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_question_region_id text,
  p_response_region_id text,
  p_basis_source_version_id uuid,
  p_basis_selection_version integer,
  p_basis_validity_epoch integer,
  p_basis_content_hash text,
  p_basis_kind text,
  p_basis_version_label text,
  p_rule_id uuid,
  p_grading_rule jsonb,
  p_confirmed_by_id uuid,
  p_confirmed_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_predecessor_id uuid;
  v_revision integer;
  v_subject text;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
     current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;

  IF NOT learning.lock_current_assessment_basis(
    p_learning_profile_id,
    p_material_id,
    p_basis_source_version_id,
    p_basis_selection_version,
    p_basis_validity_epoch,
    p_basis_content_hash,
    p_basis_kind,
    p_basis_version_label
  ) THEN
    RETURN false;
  END IF;

  SELECT basis.subject, latest.id, COALESCE(latest.revision, 0) + 1
  INTO v_subject, v_predecessor_id, v_revision
  FROM learning.resolve_objective_assessment_basis(
    p_learning_profile_id,
    p_material_id,
    p_confirmed_content_version_id,
    p_basis_source_version_id,
    p_basis_selection_version,
    p_basis_validity_epoch
  ) basis
  CROSS JOIN learning.resolve_confirmed_objective_regions(
    p_learning_profile_id,
    p_processing_job_id,
    p_confirmed_content_version_id,
    p_question_region_id,
    p_response_region_id
  ) confirmed
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.revision
    FROM learning.objective_grading_rule_versions candidate
    WHERE candidate.learning_profile_id = p_learning_profile_id
      AND candidate.material_id = p_material_id
      AND candidate.confirmed_content_version_id = p_confirmed_content_version_id
      AND candidate.question_region_id = p_question_region_id
      AND candidate.basis_source_version_id = p_basis_source_version_id
      AND candidate.basis_selection_version = p_basis_selection_version
      AND candidate.basis_validity_epoch = p_basis_validity_epoch
      AND candidate.subject = basis.subject
    ORDER BY candidate.revision DESC
    LIMIT 1
  ) latest ON true
  WHERE basis.family_space_id = p_family_space_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO learning.objective_grading_rule_versions
    (id, family_space_id, learning_profile_id, material_id,
     confirmed_content_version_id, question_region_id, basis_source_version_id,
     basis_selection_version, basis_validity_epoch, revision, subject, grading_rule,
     requires_professional_review, authority, created_by_id, created_at, predecessor_id)
  VALUES
    (p_rule_id, p_family_space_id, p_learning_profile_id, p_material_id,
     p_confirmed_content_version_id, p_question_region_id, p_basis_source_version_id,
     p_basis_selection_version, p_basis_validity_epoch, v_revision, v_subject, p_grading_rule,
     false, 'guardian_confirmed', p_confirmed_by_id, p_confirmed_at, v_predecessor_id);

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.confirm_objective_grading_rule(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, integer, integer,
  text, text, text, uuid, jsonb, uuid, timestamptz
) FROM PUBLIC;

ALTER TABLE learning.objective_grading_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_grading_rule_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessment_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_dispute_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_dispute_resolutions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY objective_grading_rule_versions_profile_isolation
  ON learning.objective_grading_rule_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY objective_assessments_profile_isolation ON learning.objective_assessments
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY objective_assessment_versions_profile_isolation ON learning.objective_assessment_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_disputes_profile_isolation ON learning.assessment_disputes
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_dispute_resolutions_profile_isolation ON learning.assessment_dispute_resolutions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_access_audit_profile_isolation ON learning.assessment_access_audit
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_assessment_app') THEN
    CREATE ROLE rhea_assessment_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_assessment_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_assessment_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_assessment_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_assessment_app;
GRANT USAGE ON SCHEMA learning TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.lock_current_assessment_basis(
  uuid, uuid, uuid, integer, integer, text, text, text
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.resolve_objective_assessment_input(
  uuid, uuid, uuid, uuid, text, text, uuid, integer, integer
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.confirm_objective_grading_rule(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, integer, integer,
  text, text, text, uuid, jsonb, uuid, timestamptz
) TO rhea_assessment_app;
GRANT SELECT, INSERT, UPDATE ON learning.objective_assessments TO rhea_assessment_app;
GRANT SELECT, INSERT ON
  learning.objective_assessment_versions,
  learning.assessment_disputes,
  learning.assessment_dispute_resolutions
TO rhea_assessment_app;
GRANT INSERT ON
  learning.domain_outbox,
  learning.assessment_access_audit
TO rhea_assessment_app;
GRANT USAGE, SELECT ON SEQUENCE learning.assessment_access_audit_id_seq TO rhea_assessment_app;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_assessment_app TO %I', current_user);
END
$$;
