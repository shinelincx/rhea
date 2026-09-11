CREATE TABLE learning.wrong_items (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  material_id uuid NOT NULL,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id),
  assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  deduplication_key text NOT NULL CHECK (deduplication_key ~ '^[0-9a-f]{64}$'),
  assessment_snapshot jsonb NOT NULL CHECK (jsonb_typeof(assessment_snapshot) = 'object'),
  classification jsonb NOT NULL CHECK (jsonb_typeof(classification) = 'object'),
  theme_id text NOT NULL CHECK (char_length(theme_id) BETWEEN 1 AND 200),
  reason_candidate jsonb NOT NULL CHECK (jsonb_typeof(reason_candidate) = 'object'),
  status text NOT NULL CHECK (status IN ('pending_correction', 'pending_consolidation')),
  first_incorrect_at timestamptz NOT NULL,
  state_revision integer NOT NULL CHECK (state_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, deduplication_key),
  UNIQUE (learning_profile_id, assessment_version_id),
  FOREIGN KEY (material_id, family_space_id, learning_profile_id)
    REFERENCES learning.learning_materials(id, family_space_id, learning_profile_id)
);

ALTER TABLE learning.wrong_items
  ADD CONSTRAINT wrong_items_scope_identity
  UNIQUE (id, family_space_id, learning_profile_id);

CREATE TABLE learning.wrong_item_reason_revisions (
  id uuid PRIMARY KEY,
  wrong_item_id uuid NOT NULL REFERENCES learning.wrong_items(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('confirm', 'mark_uncertain', 'skip', 'correct')),
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  category text CHECK (category IN (
    'knowledge', 'step', 'comprehension', 'reading', 'expression', 'other'
  )),
  explanation text CHECK (explanation IS NULL OR char_length(explanation) BETWEEN 1 AND 800),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 800),
  changed_at timestamptz NOT NULL,
  UNIQUE (wrong_item_id, revision),
  FOREIGN KEY (wrong_item_id, family_space_id, learning_profile_id)
    REFERENCES learning.wrong_items(id, family_space_id, learning_profile_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE learning.immediate_correction_attempts (
  id uuid PRIMARY KEY,
  wrong_item_id uuid NOT NULL,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  assessment_version_id uuid NOT NULL,
  basis jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  response_text text NOT NULL CHECK (char_length(response_text) BETWEEN 1 AND 4000),
  normalized_response text,
  outcome text NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  created_at timestamptz NOT NULL,
  UNIQUE (wrong_item_id, idempotency_key),
  FOREIGN KEY (wrong_item_id, family_space_id, learning_profile_id)
    REFERENCES learning.wrong_items(id, family_space_id, learning_profile_id)
    ON DELETE CASCADE
);

CREATE TABLE learning.wrong_item_access_audit (
  id bigserial PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  wrong_item_id uuid NOT NULL REFERENCES learning.wrong_items(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wrong_items_profile_status_idx
  ON learning.wrong_items (learning_profile_id, status, first_incorrect_at, id);
CREATE INDEX wrong_items_theme_idx
  ON learning.wrong_items (learning_profile_id, theme_id, first_incorrect_at, id);
CREATE INDEX correction_attempts_wrong_item_time_idx
  ON learning.immediate_correction_attempts (wrong_item_id, created_at, id);
CREATE INDEX wrong_item_access_audit_profile_time_idx
  ON learning.wrong_item_access_audit (learning_profile_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION learning.create_wrong_item(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_assessment learning.objective_assessments%ROWTYPE;
  v_basis jsonb := p_payload -> 'assessment' -> 'basis';
  v_created boolean;
  v_family_space_id uuid := (p_payload ->> 'familySpaceId')::uuid;
  v_learning_profile_id uuid := (p_payload ->> 'learningProfileId')::uuid;
  v_material_id uuid := (p_payload -> 'assessment' ->> 'materialId')::uuid;
  v_version learning.objective_assessment_versions%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR v_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR v_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true)
     OR p_payload -> 'assessment' ->> 'outcome' <> 'incorrect' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_assessment
  FROM learning.objective_assessments
  WHERE id = (p_payload -> 'assessment' ->> 'assessmentId')::uuid
    AND family_space_id = v_family_space_id
    AND learning_profile_id = v_learning_profile_id
    AND material_id = v_material_id
  FOR SHARE;
  IF NOT FOUND
     OR v_assessment.open_dispute_id IS NOT NULL
     OR v_assessment.current_version_id::text IS DISTINCT FROM
       p_payload -> 'assessment' ->> 'assessmentVersionId' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_version
  FROM learning.objective_assessment_versions
  WHERE id = v_assessment.current_version_id
    AND assessment_id = v_assessment.id;
  IF NOT FOUND
     OR v_version.decision ->> 'outcome' <> 'incorrect'
     OR v_version.question ->> 'contentHash' IS DISTINCT FROM
       p_payload -> 'assessment' -> 'question' ->> 'contentHash'
     OR v_version.response ->> 'contentHash' IS DISTINCT FROM
       p_payload -> 'assessment' -> 'response' ->> 'contentHash'
     OR v_version.grading_rule_version_id::text IS DISTINCT FROM
       p_payload -> 'assessment' -> 'correctBasis' ->> 'gradingRuleVersionId'
     OR v_version.decision ->> 'expectedDisplay' IS DISTINCT FROM
       p_payload -> 'assessment' -> 'correctBasis' ->> 'expectedDisplay'
     OR NOT learning.lock_current_assessment_basis(
       v_learning_profile_id,
       v_material_id,
       (v_basis ->> 'sourceVersionId')::uuid,
       (v_basis ->> 'selectionVersion')::integer,
       (v_basis ->> 'validityEpoch')::integer,
       v_basis ->> 'contentHash',
       v_basis ->> 'kind',
       v_basis ->> 'versionLabel'
     ) THEN
    RETURN false;
  END IF;

  INSERT INTO learning.wrong_items (
    id, family_space_id, learning_profile_id, material_id,
    assessment_id, assessment_version_id, deduplication_key,
    assessment_snapshot, classification, theme_id, reason_candidate,
    status, first_incorrect_at, state_revision, created_at, updated_at
  ) VALUES (
    (p_payload ->> 'id')::uuid,
    v_family_space_id,
    v_learning_profile_id,
    v_material_id,
    v_assessment.id,
    v_version.id,
    p_payload ->> 'deduplicationKey',
    p_payload -> 'assessment',
    p_payload -> 'classification',
    p_payload ->> 'themeId',
    p_payload -> 'reasonCandidate',
    p_payload ->> 'status',
    (p_payload ->> 'firstIncorrectAt')::timestamptz,
    1,
    (p_payload ->> 'createdAt')::timestamptz,
    (p_payload ->> 'updatedAt')::timestamptz
  )
  ON CONFLICT DO NOTHING
  RETURNING true INTO v_created;
  IF COALESCE(v_created, false) IS NOT true THEN
    RETURN false;
  END IF;

  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid,
    v_family_space_id,
    v_learning_profile_id,
    'wrong_item',
    (p_payload ->> 'id')::uuid,
    'wrong_item.captured',
    jsonb_build_object(
      'assessmentId', v_assessment.id,
      'assessmentVersionId', v_version.id,
      'classificationStatus', p_payload -> 'classification' ->> 'status',
      'themeId', p_payload ->> 'themeId'
    ),
    (p_payload ->> 'createdAt')::timestamptz
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.lock_current_wrong_item(
  p_item learning.wrong_items
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_assessment learning.objective_assessments%ROWTYPE;
  v_basis jsonb := p_item.assessment_snapshot -> 'basis';
BEGIN
  IF p_item.learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_item.family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_assessment
  FROM learning.objective_assessments
  WHERE id = p_item.assessment_id
    AND family_space_id = p_item.family_space_id
    AND learning_profile_id = p_item.learning_profile_id
    AND current_version_id = p_item.assessment_version_id
    AND open_dispute_id IS NULL
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN learning.lock_current_assessment_basis(
    p_item.learning_profile_id,
    p_item.material_id,
    (v_basis ->> 'sourceVersionId')::uuid,
    (v_basis ->> 'selectionVersion')::integer,
    (v_basis ->> 'validityEpoch')::integer,
    v_basis ->> 'contentHash',
    v_basis ->> 'kind',
    v_basis ->> 'versionLabel'
  );
END
$$;

CREATE OR REPLACE FUNCTION learning.revise_wrong_item_reason(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_item learning.wrong_items%ROWTYPE;
  v_revision jsonb := p_payload -> 'revision';
BEGIN
  IF (p_payload ->> 'learningProfileId') IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_item
  FROM learning.wrong_items
  WHERE id = (p_payload ->> 'wrongItemId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_item.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR NOT learning.lock_current_wrong_item(v_item) THEN
    RETURN false;
  END IF;
  INSERT INTO learning.wrong_item_reason_revisions (
    id, wrong_item_id, family_space_id, learning_profile_id, revision,
    action, actor_type, actor_id, category, explanation, reason, changed_at
  ) VALUES (
    (v_revision ->> 'id')::uuid,
    v_item.id,
    v_item.family_space_id,
    v_item.learning_profile_id,
    (v_revision ->> 'revision')::integer,
    v_revision ->> 'action',
    v_revision -> 'actor' ->> 'type',
    (v_revision -> 'actor' ->> 'id')::uuid,
    v_revision ->> 'category',
    v_revision ->> 'explanation',
    v_revision ->> 'reason',
    (v_revision ->> 'changedAt')::timestamptz
  );
  UPDATE learning.wrong_items
  SET state_revision = state_revision + 1,
      updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_item.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (v_revision ->> 'id')::uuid,
    v_item.family_space_id,
    v_item.learning_profile_id,
    'wrong_item',
    v_item.id,
    'wrong_item.reason_revised',
    jsonb_build_object('action', v_revision ->> 'action'),
    (v_revision ->> 'changedAt')::timestamptz
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.revise_wrong_item_classification(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_item learning.wrong_items%ROWTYPE;
BEGIN
  IF (p_payload ->> 'learningProfileId') IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_item
  FROM learning.wrong_items
  WHERE id = (p_payload ->> 'wrongItemId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_item.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR NOT learning.lock_current_wrong_item(v_item) THEN
    RETURN false;
  END IF;
  UPDATE learning.wrong_items
  SET classification = p_payload -> 'classification',
      theme_id = p_payload ->> 'themeId',
      state_revision = state_revision + 1,
      updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_item.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid,
    v_item.family_space_id,
    v_item.learning_profile_id,
    'wrong_item',
    v_item.id,
    'wrong_item.classification_revised',
    jsonb_build_object(
      'classification', p_payload -> 'classification',
      'themeId', p_payload ->> 'themeId'
    ),
    (p_payload ->> 'updatedAt')::timestamptz
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.record_immediate_correction(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_attempt jsonb := p_payload -> 'attempt';
  v_item learning.wrong_items%ROWTYPE;
BEGIN
  IF (p_payload ->> 'learningProfileId') IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_item
  FROM learning.wrong_items
  WHERE id = (p_payload ->> 'wrongItemId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT learning.lock_current_wrong_item(v_item) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM learning.immediate_correction_attempts
    WHERE wrong_item_id = v_item.id
      AND idempotency_key = v_attempt ->> 'idempotencyKey'
  ) THEN
    RETURN true;
  END IF;
  IF v_item.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR v_item.assessment_version_id::text IS DISTINCT FROM
       v_attempt ->> 'assessmentVersionId' THEN
    RETURN false;
  END IF;
  INSERT INTO learning.immediate_correction_attempts (
    id, wrong_item_id, family_space_id, learning_profile_id,
    idempotency_key, assessment_version_id, basis, response_text,
    normalized_response, outcome, created_at
  ) VALUES (
    (v_attempt ->> 'id')::uuid,
    v_item.id,
    v_item.family_space_id,
    v_item.learning_profile_id,
    v_attempt ->> 'idempotencyKey',
    (v_attempt ->> 'assessmentVersionId')::uuid,
    v_attempt -> 'basis',
    v_attempt ->> 'responseText',
    v_attempt ->> 'normalizedResponse',
    v_attempt ->> 'outcome',
    (v_attempt ->> 'createdAt')::timestamptz
  );
  UPDATE learning.wrong_items
  SET status = p_payload ->> 'status',
      state_revision = state_revision + 1,
      updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_item.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (v_attempt ->> 'id')::uuid,
    v_item.family_space_id,
    v_item.learning_profile_id,
    'wrong_item',
    v_item.id,
    'wrong_item.immediate_correction_recorded',
    jsonb_build_object(
      'attemptId', v_attempt ->> 'id',
      'outcome', v_attempt ->> 'outcome',
      'status', p_payload ->> 'status'
    ),
    (v_attempt ->> 'createdAt')::timestamptz
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.lock_current_wrong_item(learning.wrong_items) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.create_wrong_item(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.revise_wrong_item_reason(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.revise_wrong_item_classification(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.record_immediate_correction(jsonb) FROM PUBLIC;

ALTER TABLE learning.wrong_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_items FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_item_reason_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_item_reason_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.immediate_correction_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.immediate_correction_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_item_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_item_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY wrong_items_profile_isolation ON learning.wrong_items
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY wrong_item_reason_revisions_profile_isolation
  ON learning.wrong_item_reason_revisions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY immediate_correction_attempts_profile_isolation
  ON learning.immediate_correction_attempts
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY wrong_item_access_audit_profile_isolation ON learning.wrong_item_access_audit
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_learning_progress_app') THEN
    CREATE ROLE rhea_learning_progress_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_learning_progress_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_learning_progress_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_learning_progress_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_learning_progress_app;
GRANT USAGE ON SCHEMA learning TO rhea_learning_progress_app;
GRANT SELECT ON
  learning.wrong_items,
  learning.wrong_item_reason_revisions,
  learning.immediate_correction_attempts
TO rhea_learning_progress_app;
GRANT INSERT ON learning.wrong_item_access_audit TO rhea_learning_progress_app;
GRANT USAGE, SELECT ON SEQUENCE learning.wrong_item_access_audit_id_seq
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.create_wrong_item(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.revise_wrong_item_reason(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.revise_wrong_item_classification(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.record_immediate_correction(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.sync_source_revision(
  uuid, uuid, text, text, text, text, timestamptz
) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.publish_derived_artifact(
  uuid, uuid, text, text, text, boolean, text, jsonb, timestamptz, text, text
) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.read_lineage_artifact(uuid, uuid, text, text, text)
  TO rhea_learning_progress_app;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_learning_progress_app TO %I', current_user);
END
$$;
