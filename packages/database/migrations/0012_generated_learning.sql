ALTER TABLE learning.learning_profiles
  ADD CONSTRAINT learning_profiles_family_id_unique
  UNIQUE (family_space_id, id);

ALTER TABLE learning.learning_materials
  ADD CONSTRAINT learning_materials_family_profile_id_unique
  UNIQUE (family_space_id, learning_profile_id, id);

CREATE TABLE learning.generated_learning_requests (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL,
  material_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose = 'learning_pack'),
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  consent_revision integer NOT NULL CHECK (consent_revision > 0),
  capability jsonb NOT NULL CHECK (jsonb_typeof(capability) = 'object'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN (
    'queued', 'generating', 'ready', 'unavailable', 'canceled'
  )),
  unavailable_reason text CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN (
      'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN', 'GENERATION_CANCELED',
      'GENERATION_CHECK_FAILED', 'MODEL_UNAVAILABLE', 'SOURCE_CHANGED',
      'SOURCE_UNAVAILABLE'
    )
  ),
  current_version_id uuid,
  revealed_hint_level smallint NOT NULL DEFAULT 0
    CHECK (revealed_hint_level BETWEEN 0 AND 3),
  processing_lease_expires_at timestamptz,
  state_revision integer NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  latest_checks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(latest_checks) = 'array'),
  model_runs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(model_runs) = 'array'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, idempotency_key),
  UNIQUE (learning_profile_id, id),
  UNIQUE (family_space_id, learning_profile_id, id),
  UNIQUE (family_space_id, learning_profile_id, material_id, id),
  CONSTRAINT generated_learning_requests_profile_fk
    FOREIGN KEY (family_space_id, learning_profile_id)
    REFERENCES learning.learning_profiles(family_space_id, id) ON DELETE CASCADE,
  CONSTRAINT generated_learning_requests_material_fk
    FOREIGN KEY (family_space_id, learning_profile_id, material_id)
    REFERENCES learning.learning_materials(family_space_id, learning_profile_id, id)
    ON DELETE CASCADE,
  CHECK (
    (status = 'ready' AND current_version_id IS NOT NULL AND unavailable_reason IS NULL)
    OR (
      status IN ('queued', 'generating')
      AND current_version_id IS NULL
      AND unavailable_reason IS NULL
    )
    OR (
      status = 'unavailable'
      AND current_version_id IS NULL
      AND unavailable_reason IS NOT NULL
    )
    OR (
      status = 'canceled'
      AND current_version_id IS NULL
      AND unavailable_reason = 'GENERATION_CANCELED'
    )
  ),
  CHECK (
    (status = 'generating' AND processing_lease_expires_at IS NOT NULL)
    OR (status <> 'generating' AND processing_lease_expires_at IS NULL)
  )
);

CREATE TABLE learning.generated_learning_content_versions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  material_id uuid NOT NULL,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 1000),
  revision integer NOT NULL CHECK (revision > 0),
  predecessor_id uuid REFERENCES learning.generated_learning_content_versions(id),
  content_state text NOT NULL CHECK (
    content_state IN ('direct_learning', 'confirmation_recommended')
  ),
  capability jsonb NOT NULL CHECK (jsonb_typeof(capability) = 'object'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  pack jsonb NOT NULL CHECK (jsonb_typeof(pack) = 'object'),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  created_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, source_key, revision),
  UNIQUE (request_id, id),
  UNIQUE (family_space_id, learning_profile_id, id),
  UNIQUE (family_space_id, learning_profile_id, request_id, id),
  UNIQUE (family_space_id, learning_profile_id, material_id, request_id, id),
  UNIQUE (family_space_id, learning_profile_id, material_id, source_key, id),
  CONSTRAINT generated_learning_content_request_fk
    FOREIGN KEY (family_space_id, learning_profile_id, material_id, request_id)
    REFERENCES learning.generated_learning_requests(
      family_space_id, learning_profile_id, material_id, id
    ) ON DELETE CASCADE
);

ALTER TABLE learning.generated_learning_requests
  ADD CONSTRAINT generated_learning_requests_current_version_fk
  FOREIGN KEY (
    family_space_id, learning_profile_id, material_id, id, current_version_id
  )
  REFERENCES learning.generated_learning_content_versions(
    family_space_id, learning_profile_id, material_id, request_id, id
  );

ALTER TABLE learning.generated_learning_content_versions
  ADD CONSTRAINT generated_learning_content_predecessor_fk
  FOREIGN KEY (
    family_space_id, learning_profile_id, material_id, source_key, predecessor_id
  )
  REFERENCES learning.generated_learning_content_versions(
    family_space_id, learning_profile_id, material_id, source_key, id
  );

CREATE TABLE learning.generated_learning_source_edges (
  generated_version_id uuid NOT NULL,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  source_type text NOT NULL CHECK (source_type IN (
    'learning_basis', 'confirmed_content', 'question', 'answer', 'shared_prompt'
  )),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 200),
  usage text NOT NULL CHECK (usage IN ('current_basis', 'model_input')),
  PRIMARY KEY (generated_version_id, position),
  CONSTRAINT generated_learning_source_edges_version_fk
    FOREIGN KEY (family_space_id, learning_profile_id, generated_version_id)
    REFERENCES learning.generated_learning_content_versions(
      family_space_id, learning_profile_id, id
    ) ON DELETE CASCADE
);

CREATE TABLE learning.generated_learning_hint_usages (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  version_id uuid NOT NULL,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  occurred_at timestamptz NOT NULL,
  UNIQUE (request_id, version_id, level),
  CONSTRAINT generated_learning_hint_usages_version_fk
    FOREIGN KEY (family_space_id, learning_profile_id, request_id, version_id)
    REFERENCES learning.generated_learning_content_versions(
      family_space_id, learning_profile_id, request_id, id
    ) ON DELETE CASCADE
);

CREATE TABLE learning.generated_learning_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT generated_learning_access_audit_request_fk
    FOREIGN KEY (family_space_id, learning_profile_id, request_id)
    REFERENCES learning.generated_learning_requests(
      family_space_id, learning_profile_id, id
    ) ON DELETE CASCADE
);

CREATE INDEX generated_learning_requests_profile_time_idx
  ON learning.generated_learning_requests (learning_profile_id, created_at DESC);
CREATE INDEX generated_learning_requests_family_idx
  ON learning.generated_learning_requests (family_space_id, learning_profile_id);
CREATE INDEX generated_learning_requests_material_idx
  ON learning.generated_learning_requests
    (family_space_id, learning_profile_id, material_id);
CREATE INDEX generated_learning_requests_current_version_idx
  ON learning.generated_learning_requests
    (family_space_id, learning_profile_id, material_id, id, current_version_id)
  WHERE current_version_id IS NOT NULL;
CREATE INDEX generated_learning_requests_ready_source_idx
  ON learning.generated_learning_requests
    (learning_profile_id, source_key, created_at DESC)
  WHERE status = 'ready';
CREATE INDEX generated_learning_content_request_idx
  ON learning.generated_learning_content_versions (request_id, revision);
CREATE INDEX generated_learning_content_predecessor_idx
  ON learning.generated_learning_content_versions (predecessor_id)
  WHERE predecessor_id IS NOT NULL;
CREATE INDEX generated_learning_content_scope_idx
  ON learning.generated_learning_content_versions
    (family_space_id, learning_profile_id, material_id, request_id);
CREATE INDEX generated_learning_source_edges_profile_idx
  ON learning.generated_learning_source_edges
    (learning_profile_id, generated_version_id, position);
CREATE INDEX generated_learning_source_edges_scope_idx
  ON learning.generated_learning_source_edges
    (family_space_id, learning_profile_id, generated_version_id);
CREATE INDEX generated_learning_hint_usages_profile_time_idx
  ON learning.generated_learning_hint_usages
    (learning_profile_id, occurred_at DESC);
CREATE INDEX generated_learning_hint_usages_version_idx
  ON learning.generated_learning_hint_usages (version_id);
CREATE INDEX generated_learning_access_audit_profile_time_idx
  ON learning.generated_learning_access_audit
    (learning_profile_id, occurred_at DESC);
CREATE INDEX generated_learning_access_audit_request_idx
  ON learning.generated_learning_access_audit (request_id);

ALTER TABLE learning.generated_learning_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_content_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_source_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_source_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_hint_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_hint_usages FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.generated_learning_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY generated_learning_requests_profile_isolation
  ON learning.generated_learning_requests
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY generated_learning_content_versions_profile_isolation
  ON learning.generated_learning_content_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY generated_learning_source_edges_profile_isolation
  ON learning.generated_learning_source_edges
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY generated_learning_hint_usages_profile_isolation
  ON learning.generated_learning_hint_usages
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY generated_learning_access_audit_profile_isolation
  ON learning.generated_learning_access_audit
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

CREATE OR REPLACE FUNCTION learning.authorize_generated_learning(
  p_learning_profile_id uuid,
  p_family_space_id uuid,
  p_consent_revision integer,
  p_age_band text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM learning.resolve_generated_learning_eligibility(
      p_learning_profile_id,
      p_family_space_id
    ) eligibility
    WHERE eligibility.consent_revision = p_consent_revision
      AND eligibility.age_band = p_age_band
  )
$$;

REVOKE ALL ON FUNCTION learning.authorize_generated_learning(
  uuid, uuid, integer, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.lock_generated_learning_publication(
  p_learning_profile_id uuid,
  p_family_space_id uuid,
  p_consent_revision integer,
  p_age_band text,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_excerpts jsonb,
  p_material_id uuid,
  p_source_version_id uuid,
  p_selection_version integer,
  p_validity_epoch integer,
  p_content_hash text,
  p_kind text,
  p_version_label text,
  p_classification_revision integer,
  p_subject text,
  p_course_path_name text,
  p_unit_name text,
  p_knowledge_point_names text[]
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_eligibility text;
BEGIN
  v_eligibility := learning.lock_current_generated_learning_eligibility(
    p_learning_profile_id,
    p_family_space_id,
    p_consent_revision,
    p_age_band
  );
  IF v_eligibility IS DISTINCT FROM 'authorized' THEN
    RETURN v_eligibility;
  END IF;

  IF NOT learning.lock_current_generated_learning_content(
    p_learning_profile_id,
    p_processing_job_id,
    p_confirmed_content_version_id,
    p_excerpts
  ) THEN
    RETURN 'source_changed';
  END IF;

  IF NOT learning.lock_current_generated_learning_basis(
    p_learning_profile_id,
    p_family_space_id,
    p_material_id,
    p_confirmed_content_version_id,
    p_source_version_id,
    p_selection_version,
    p_validity_epoch,
    p_content_hash,
    p_kind,
    p_version_label,
    p_classification_revision,
    p_subject,
    p_course_path_name,
    p_unit_name,
    p_knowledge_point_names
  ) THEN
    RETURN 'source_changed';
  END IF;

  RETURN 'authorized';
END
$$;

REVOKE ALL ON FUNCTION learning.lock_generated_learning_publication(
  uuid, uuid, integer, text, uuid, uuid, jsonb, uuid, uuid, integer,
  integer, text, text, text, integer, text, text, text, text[]
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.generated_learning_checks_pass(
  p_checks jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    jsonb_typeof(p_checks) = 'array'
    AND jsonb_array_length(p_checks) = 7
    AND (
      SELECT count(DISTINCT item.value ->> 'kind') = 7
      FROM jsonb_array_elements(p_checks) item(value)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_checks) item(value)
      WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
        OR item.value ->> 'kind' NOT IN (
          'age_appropriateness', 'answer_leakage', 'consistency', 'safety',
          'schema', 'solvability', 'source_coverage'
        )
        OR item.value -> 'passed' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(item.value -> 'detail') IS DISTINCT FROM 'string'
        OR COALESCE(item.value ->> 'detail', '') = ''
    )
$$;

REVOKE ALL ON FUNCTION learning.generated_learning_checks_pass(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.generated_learning_source_key(
  p_source_snapshot jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    'learning_pack:v1:' ||
    (p_source_snapshot #>> '{basis,materialId}') || ':' ||
    (p_source_snapshot #>> '{basis,sourceVersionId}') || ':' ||
    (p_source_snapshot #>> '{basis,selectionVersion}') || ':' ||
    (p_source_snapshot #>> '{basis,validityEpoch}') || ':' ||
    (p_source_snapshot #>> '{basis,contentHash}') || ':' ||
    (p_source_snapshot ->> 'confirmedContentVersionId') || ':' ||
    (p_source_snapshot ->> 'classificationRevision') || ':' ||
    (p_source_snapshot ->> 'processingJobId')
$$;

REVOKE ALL ON FUNCTION learning.generated_learning_source_key(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.create_generated_learning_request(
  p_id uuid,
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_material_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_purpose text,
  p_actor_type text,
  p_actor_id uuid,
  p_consent_revision integer,
  p_capability jsonb,
  p_source_snapshot jsonb,
  p_source_key text,
  p_status text,
  p_unavailable_reason text,
  p_current_version_id uuid,
  p_revealed_hint_level smallint,
  p_processing_lease_expires_at timestamptz,
  p_state_revision integer,
  p_latest_checks jsonb,
  p_model_runs jsonb,
  p_created_at timestamptz,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true)
     OR jsonb_typeof(p_source_snapshot) IS DISTINCT FROM 'object'
     OR p_source_snapshot #>> '{basis,materialId}' IS DISTINCT FROM p_material_id::text
     OR p_source_key IS DISTINCT FROM
       learning.generated_learning_source_key(p_source_snapshot) THEN
    RETURN false;
  END IF;

  INSERT INTO learning.generated_learning_requests
    (id, family_space_id, learning_profile_id, material_id, idempotency_key,
     request_fingerprint, purpose, actor_type, actor_id, consent_revision,
     capability, source_snapshot, source_key, status, unavailable_reason,
     current_version_id, revealed_hint_level, processing_lease_expires_at,
     state_revision, latest_checks, model_runs, created_at, updated_at)
  VALUES
    (p_id, p_family_space_id, p_learning_profile_id, p_material_id,
     p_idempotency_key, p_request_fingerprint, p_purpose, p_actor_type,
     p_actor_id, p_consent_revision, p_capability, p_source_snapshot,
     p_source_key, p_status, p_unavailable_reason, p_current_version_id,
     p_revealed_hint_level, p_processing_lease_expires_at, p_state_revision,
     p_latest_checks, p_model_runs, p_created_at, p_updated_at)
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO learning.domain_outbox
    (id, family_space_id, learning_profile_id, aggregate_type,
     aggregate_id, event_type, payload, occurred_at)
  VALUES
    (p_id, p_family_space_id, p_learning_profile_id, 'generated_learning',
     p_id, 'generated_learning.requested',
     jsonb_build_object(
       'basisSourceVersionId', p_source_snapshot #>> '{basis,sourceVersionId}',
       'capabilityVersionId', p_capability ->> 'id',
       'status', p_status
     ), p_created_at);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.create_generated_learning_request(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, integer, jsonb,
  jsonb, text, text, text, uuid, smallint, timestamptz, integer, jsonb,
  jsonb, timestamptz, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.claim_generated_learning_request(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_lease_expires_at timestamptz,
  p_now timestamptz,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;

  UPDATE learning.generated_learning_requests
  SET status = 'generating', processing_lease_expires_at = p_lease_expires_at,
      state_revision = state_revision + 1, updated_at = p_updated_at
  WHERE id = p_request_id
    AND learning_profile_id = p_learning_profile_id
    AND state_revision = p_expected_state_revision
    AND (
      status = 'queued'
      OR (
        status = 'generating'
        AND processing_lease_expires_at IS NOT NULL
        AND processing_lease_expires_at <= p_now
      )
    );
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION learning.claim_generated_learning_request(
  uuid, uuid, integer, timestamptz, timestamptz, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.cancel_generated_learning_request(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_event_id uuid,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_request learning.generated_learning_requests%ROWTYPE;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;

  SELECT * INTO v_request
  FROM learning.generated_learning_requests request
  WHERE request.id = p_request_id
    AND request.learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_request.state_revision IS DISTINCT FROM p_expected_state_revision
     OR v_request.status NOT IN ('queued', 'generating') THEN
    RETURN false;
  END IF;

  UPDATE learning.generated_learning_requests
  SET status = 'canceled', unavailable_reason = 'GENERATION_CANCELED',
      processing_lease_expires_at = NULL,
      state_revision = state_revision + 1, updated_at = p_updated_at
  WHERE id = p_request_id;
  INSERT INTO learning.domain_outbox
    (id, family_space_id, learning_profile_id, aggregate_type,
     aggregate_id, event_type, payload, occurred_at)
  VALUES
    (p_event_id, v_request.family_space_id, v_request.learning_profile_id,
     'generated_learning', v_request.id, 'generated_learning.canceled',
     jsonb_build_object('reason', 'GENERATION_CANCELED'), p_updated_at);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.cancel_generated_learning_request(
  uuid, uuid, integer, uuid, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.fail_generated_learning_request(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_reason text,
  p_latest_checks jsonb,
  p_model_runs jsonb,
  p_event_id uuid,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_request learning.generated_learning_requests%ROWTYPE;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_reason NOT IN (
       'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN',
       'GENERATION_CHECK_FAILED', 'MODEL_UNAVAILABLE',
       'SOURCE_CHANGED', 'SOURCE_UNAVAILABLE'
     )
     OR jsonb_typeof(p_latest_checks) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_model_runs) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_request
  FROM learning.generated_learning_requests request
  WHERE request.id = p_request_id
    AND request.learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_request.status IS DISTINCT FROM 'generating'
     OR v_request.state_revision IS DISTINCT FROM p_expected_state_revision THEN
    RETURN false;
  END IF;

  UPDATE learning.generated_learning_requests
  SET status = 'unavailable', unavailable_reason = p_reason,
      processing_lease_expires_at = NULL,
      state_revision = state_revision + 1,
      latest_checks = p_latest_checks,
      model_runs = model_runs || p_model_runs,
      updated_at = p_updated_at
  WHERE id = p_request_id;
  INSERT INTO learning.domain_outbox
    (id, family_space_id, learning_profile_id, aggregate_type,
     aggregate_id, event_type, payload, occurred_at)
  VALUES
    (p_event_id, v_request.family_space_id, v_request.learning_profile_id,
     'generated_learning', v_request.id, 'generated_learning.unavailable',
     jsonb_build_object('reason', p_reason), p_updated_at);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.fail_generated_learning_request(
  uuid, uuid, integer, text, jsonb, jsonb, uuid, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.complete_generated_learning_request(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_version_id uuid,
  p_predecessor_id uuid,
  p_revision integer,
  p_content_state text,
  p_capability jsonb,
  p_source_snapshot jsonb,
  p_pack jsonb,
  p_version_checks jsonb,
  p_latest_checks jsonb,
  p_model_runs jsonb,
  p_created_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_request learning.generated_learning_requests%ROWTYPE;
  v_source jsonb;
  v_publication text;
  v_latest_id uuid;
  v_latest_revision integer;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR jsonb_typeof(p_capability) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_source_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_pack) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_model_runs) IS DISTINCT FROM 'array'
     OR p_version_checks IS DISTINCT FROM p_latest_checks
     OR NOT COALESCE(learning.generated_learning_checks_pass(p_latest_checks), false) THEN
    RETURN 'conflict';
  END IF;

  SELECT * INTO v_request
  FROM learning.generated_learning_requests request
  WHERE request.id = p_request_id
    AND request.learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_request.status IS DISTINCT FROM 'generating'
     OR v_request.state_revision IS DISTINCT FROM p_expected_state_revision
     OR v_request.current_version_id IS NOT NULL
     OR v_request.capability ->> 'availability' IS DISTINCT FROM 'approved'
     OR p_capability IS DISTINCT FROM v_request.capability
     OR p_source_snapshot IS DISTINCT FROM v_request.source_snapshot
     OR v_request.source_snapshot #>> '{basis,materialId}' IS DISTINCT FROM
       v_request.material_id::text
     OR v_request.source_key IS DISTINCT FROM
       learning.generated_learning_source_key(v_request.source_snapshot) THEN
    RETURN 'conflict';
  END IF;

  v_source := v_request.source_snapshot;
  v_publication := learning.lock_generated_learning_publication(
    v_request.learning_profile_id,
    v_request.family_space_id,
    v_request.consent_revision,
    v_source ->> 'ageBand',
    (v_source ->> 'processingJobId')::uuid,
    (v_source ->> 'confirmedContentVersionId')::uuid,
    v_source -> 'excerpts',
    v_request.material_id,
    (v_source #>> '{basis,sourceVersionId}')::uuid,
    (v_source #>> '{basis,selectionVersion}')::integer,
    (v_source #>> '{basis,validityEpoch}')::integer,
    v_source #>> '{basis,contentHash}',
    v_source #>> '{basis,kind}',
    v_source #>> '{basis,versionLabel}',
    (v_source ->> 'classificationRevision')::integer,
    v_source ->> 'subject',
    v_source ->> 'coursePathName',
    v_source ->> 'unitName',
    ARRAY(
      SELECT value
      FROM jsonb_array_elements_text(v_source -> 'knowledgePointNames') value
    )
  );
  IF v_publication IS DISTINCT FROM 'authorized' THEN
    RETURN v_publication;
  END IF;

  SELECT version.id, version.revision
  INTO v_latest_id, v_latest_revision
  FROM learning.generated_learning_content_versions version
  WHERE version.learning_profile_id = v_request.learning_profile_id
    AND version.source_key = v_request.source_key
  ORDER BY version.revision DESC
  LIMIT 1;
  IF p_predecessor_id IS DISTINCT FROM v_latest_id
     OR p_revision IS DISTINCT FROM COALESCE(v_latest_revision, 0) + 1 THEN
    RETURN 'conflict';
  END IF;

  INSERT INTO learning.generated_learning_content_versions
    (id, request_id, family_space_id, learning_profile_id, material_id,
     source_key, revision, predecessor_id, content_state, capability,
     source_snapshot, pack, checks, created_at)
  VALUES
    (p_version_id, v_request.id, v_request.family_space_id,
     v_request.learning_profile_id, v_request.material_id, v_request.source_key,
     p_revision, p_predecessor_id, p_content_state, p_capability,
     p_source_snapshot, p_pack, p_version_checks, p_created_at);

  INSERT INTO learning.generated_learning_source_edges
    (generated_version_id, family_space_id, learning_profile_id, position,
     source_type, source_id, source_version, usage)
  VALUES
    (p_version_id, v_request.family_space_id, v_request.learning_profile_id, 0,
     'learning_basis', v_source #>> '{basis,sourceVersionId}',
     'selection:' || (v_source #>> '{basis,selectionVersion}') ||
       ':epoch:' || (v_source #>> '{basis,validityEpoch}'),
     'current_basis'),
    (p_version_id, v_request.family_space_id, v_request.learning_profile_id, 1,
     'confirmed_content', v_source ->> 'confirmedContentVersionId',
     v_source ->> 'confirmedContentVersionId', 'model_input');
  INSERT INTO learning.generated_learning_source_edges
    (generated_version_id, family_space_id, learning_profile_id, position,
     source_type, source_id, source_version, usage)
  SELECT
    p_version_id, v_request.family_space_id, v_request.learning_profile_id,
    1 + excerpt.ordinality::integer,
    excerpt.value ->> 'kind', excerpt.value ->> 'regionId',
    v_source ->> 'confirmedContentVersionId', 'model_input'
  FROM jsonb_array_elements(v_source -> 'excerpts') WITH ORDINALITY
    excerpt(value, ordinality);

  UPDATE learning.generated_learning_requests
  SET current_version_id = p_version_id, status = 'ready',
      unavailable_reason = NULL, processing_lease_expires_at = NULL,
      state_revision = state_revision + 1,
      latest_checks = p_latest_checks,
      model_runs = model_runs || p_model_runs,
      updated_at = p_created_at
  WHERE id = v_request.id;
  INSERT INTO learning.domain_outbox
    (id, family_space_id, learning_profile_id, aggregate_type,
     aggregate_id, event_type, payload, occurred_at)
  VALUES
    (p_version_id, v_request.family_space_id, v_request.learning_profile_id,
     'generated_learning', v_request.id, 'generated_learning.published',
     jsonb_build_object(
       'basisSourceVersionId', v_source #>> '{basis,sourceVersionId}',
       'capabilityVersionId', p_capability ->> 'id',
       'contentState', p_content_state,
       'generatedContentVersionId', p_version_id
     ), p_created_at);
  RETURN 'completed';
END
$$;

REVOKE ALL ON FUNCTION learning.complete_generated_learning_request(
  uuid, uuid, integer, uuid, uuid, integer, text, jsonb, jsonb, jsonb,
  jsonb, jsonb, jsonb, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.reveal_generated_learning_hint(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_version_id uuid,
  p_expected_level smallint,
  p_next_level smallint,
  p_usage_id uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_occurred_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_request learning.generated_learning_requests%ROWTYPE;
  v_source jsonb;
  v_publication text;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true) THEN
    RETURN 'conflict';
  END IF;

  SELECT * INTO v_request
  FROM learning.generated_learning_requests request
  WHERE request.id = p_request_id
    AND request.learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_request.status IS DISTINCT FROM 'ready'
     OR v_request.current_version_id IS DISTINCT FROM p_version_id
     OR v_request.revealed_hint_level IS DISTINCT FROM p_expected_level
     OR p_next_level IS DISTINCT FROM p_expected_level + 1
     OR p_next_level NOT BETWEEN 1 AND 3 THEN
    RETURN 'conflict';
  END IF;

  v_source := v_request.source_snapshot;
  v_publication := learning.lock_generated_learning_publication(
    v_request.learning_profile_id,
    v_request.family_space_id,
    v_request.consent_revision,
    v_source ->> 'ageBand',
    (v_source ->> 'processingJobId')::uuid,
    (v_source ->> 'confirmedContentVersionId')::uuid,
    v_source -> 'excerpts',
    v_request.material_id,
    (v_source #>> '{basis,sourceVersionId}')::uuid,
    (v_source #>> '{basis,selectionVersion}')::integer,
    (v_source #>> '{basis,validityEpoch}')::integer,
    v_source #>> '{basis,contentHash}',
    v_source #>> '{basis,kind}',
    v_source #>> '{basis,versionLabel}',
    (v_source ->> 'classificationRevision')::integer,
    v_source ->> 'subject',
    v_source ->> 'coursePathName',
    v_source ->> 'unitName',
    ARRAY(
      SELECT value
      FROM jsonb_array_elements_text(v_source -> 'knowledgePointNames') value
    )
  );
  IF v_publication IS DISTINCT FROM 'authorized' THEN
    RETURN v_publication;
  END IF;

  INSERT INTO learning.generated_learning_hint_usages
    (id, request_id, version_id, family_space_id, learning_profile_id,
     actor_type, actor_id, level, occurred_at)
  VALUES
    (p_usage_id, v_request.id, p_version_id, v_request.family_space_id,
     v_request.learning_profile_id, p_actor_type, p_actor_id,
     p_next_level, p_occurred_at);
  INSERT INTO learning.generated_learning_access_audit
    (family_space_id, learning_profile_id, actor_type, actor_id,
     action, request_id, occurred_at)
  VALUES
    (v_request.family_space_id, v_request.learning_profile_id,
     p_actor_type, p_actor_id, 'generated_learning.hint_revealed',
     v_request.id, p_occurred_at);
  UPDATE learning.generated_learning_requests
  SET revealed_hint_level = p_next_level,
      state_revision = state_revision + 1,
      updated_at = p_occurred_at
  WHERE id = v_request.id;
  INSERT INTO learning.domain_outbox
    (id, family_space_id, learning_profile_id, aggregate_type,
     aggregate_id, event_type, payload, occurred_at)
  VALUES
    (p_usage_id, v_request.family_space_id, v_request.learning_profile_id,
     'generated_learning', v_request.id, 'generated_learning.hint_revealed',
     jsonb_build_object('level', p_next_level, 'versionId', p_version_id),
     p_occurred_at);
  RETURN 'completed';
END
$$;

REVOKE ALL ON FUNCTION learning.reveal_generated_learning_hint(
  uuid, uuid, uuid, smallint, smallint, uuid, text, uuid, timestamptz
) FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_generated_learning_app') THEN
    CREATE ROLE rhea_generated_learning_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_generated_learning_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_generated_learning_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_generated_learning_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_generated_learning_app;
GRANT USAGE ON SCHEMA learning TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.authorize_generated_learning(
  uuid, uuid, integer, text
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.create_generated_learning_request(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, integer, jsonb,
  jsonb, text, text, text, uuid, smallint, timestamptz, integer, jsonb,
  jsonb, timestamptz, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.claim_generated_learning_request(
  uuid, uuid, integer, timestamptz, timestamptz, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.cancel_generated_learning_request(
  uuid, uuid, integer, uuid, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.fail_generated_learning_request(
  uuid, uuid, integer, text, jsonb, jsonb, uuid, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.complete_generated_learning_request(
  uuid, uuid, integer, uuid, uuid, integer, text, jsonb, jsonb, jsonb,
  jsonb, jsonb, jsonb, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.reveal_generated_learning_hint(
  uuid, uuid, uuid, smallint, smallint, uuid, text, uuid, timestamptz
) TO rhea_generated_learning_app;
GRANT SELECT ON
  learning.generated_learning_requests,
  learning.generated_learning_content_versions
TO rhea_generated_learning_app;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_generated_learning_app TO %I', current_user);
END
$$;
