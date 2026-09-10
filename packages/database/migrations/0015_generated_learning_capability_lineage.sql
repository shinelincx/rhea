-- T09 generated-learning capability lineage. New AI requests and published
-- content bind to an immutable quality authorization decision. Legacy rows are
-- retained as unverified history, while every new write must carry the binding.

ALTER TABLE learning.generated_learning_requests
  ADD COLUMN authorization_snapshot jsonb,
  ADD COLUMN authorization_decision_id text,
  ADD COLUMN authorization_containment_epoch bigint,
  ADD COLUMN capability_version_id text,
  ALTER COLUMN capability DROP NOT NULL;

ALTER TABLE learning.generated_learning_content_versions
  ADD COLUMN authorization_snapshot jsonb,
  ADD COLUMN authorization_decision_id text,
  ADD COLUMN authorization_containment_epoch bigint,
  ADD COLUMN capability_version_id text;

ALTER TABLE learning.generated_learning_requests
  DROP CONSTRAINT IF EXISTS generated_learning_requests_unavailable_reason_check,
  ADD CONSTRAINT generated_learning_requests_unavailable_reason_check CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN (
      'CAPABILITY_CONTAINED', 'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN',
      'GENERATION_CANCELED', 'GENERATION_CHECK_FAILED', 'MODEL_UNAVAILABLE',
      'SOURCE_CHANGED', 'SOURCE_UNAVAILABLE'
    )
  ),
  ADD CONSTRAINT generated_learning_request_authorization_shape CHECK (
    authorization_snapshot IS NULL OR (
      jsonb_typeof(authorization_snapshot) = 'object'
      AND authorization_snapshot ->> 'decisionId' = authorization_decision_id
      AND (authorization_snapshot ->> 'containmentEpoch')::bigint =
        authorization_containment_epoch
      AND length(btrim(authorization_snapshot ->> 'issuedAt')) > 0
      AND (
        (capability IS NULL AND capability_version_id IS NULL)
        OR (
          jsonb_typeof(capability) = 'object'
          AND capability ->> 'id' = capability_version_id
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT generated_learning_request_authorization_fk
    FOREIGN KEY (authorization_decision_id, authorization_containment_epoch)
    REFERENCES metrics.authorization_decisions(id, containment_epoch) NOT VALID,
  ADD CONSTRAINT generated_learning_request_primary_capability_fk
    FOREIGN KEY (
      authorization_decision_id, capability_version_id,
      authorization_containment_epoch
    ) REFERENCES metrics.authorization_decisions(
      id, primary_version_id, containment_epoch
    ) NOT VALID;

ALTER TABLE learning.generated_learning_content_versions
  ADD CONSTRAINT generated_learning_content_authorization_shape CHECK (
    authorization_snapshot IS NULL OR (
      jsonb_typeof(authorization_snapshot) = 'object'
      AND authorization_snapshot ->> 'decisionId' = authorization_decision_id
      AND (authorization_snapshot ->> 'containmentEpoch')::bigint =
        authorization_containment_epoch
      AND length(btrim(authorization_snapshot ->> 'issuedAt')) > 0
      AND jsonb_typeof(capability) = 'object'
      AND capability ->> 'id' = capability_version_id
    )
  ) NOT VALID,
  ADD CONSTRAINT generated_learning_content_authorization_fk
    FOREIGN KEY (authorization_decision_id, authorization_containment_epoch)
    REFERENCES metrics.authorization_decisions(id, containment_epoch) NOT VALID,
  ADD CONSTRAINT generated_learning_content_primary_capability_fk
    FOREIGN KEY (
      authorization_decision_id, capability_version_id,
      authorization_containment_epoch
    ) REFERENCES metrics.authorization_decisions(
      id, primary_version_id, containment_epoch
    ) NOT VALID;

CREATE INDEX generated_learning_request_authorization_idx
  ON learning.generated_learning_requests
    (authorization_decision_id, authorization_containment_epoch)
  WHERE authorization_decision_id IS NOT NULL;
CREATE INDEX generated_learning_content_authorization_idx
  ON learning.generated_learning_content_versions
    (authorization_decision_id, authorization_containment_epoch)
  WHERE authorization_decision_id IS NOT NULL;

CREATE FUNCTION learning.generated_learning_model_runs_match(
  p_model_runs jsonb,
  p_authorization_decision_id text,
  p_capability_version_id text,
  p_capability jsonb,
  p_require_success boolean
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_run jsonb;
  v_has_success boolean := false;
BEGIN
  IF jsonb_typeof(p_model_runs) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_capability) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  FOR v_run IN SELECT value FROM jsonb_array_elements(p_model_runs) AS item(value)
  LOOP
    IF jsonb_typeof(v_run) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_run)) IS DISTINCT FROM 13::bigint
       OR NOT v_run ?& ARRAY[
         'attempt', 'authorizationDecisionId', 'capabilityVersionId',
         'externalTraceId', 'finishedAt', 'inputTokens',
         'modelOrEngineVersion', 'observedProvider', 'outputTokens', 'promptOrConfigVersion',
         'provider', 'providerVersion', 'succeeded'
       ]
       OR jsonb_typeof(v_run -> 'attempt') IS DISTINCT FROM 'number'
       OR (v_run ->> 'attempt')::numeric IS DISTINCT FROM
         trunc((v_run ->> 'attempt')::numeric)
       OR (v_run ->> 'attempt')::integer < 1
       OR jsonb_typeof(v_run -> 'authorizationDecisionId') IS DISTINCT FROM 'string'
       OR v_run ->> 'authorizationDecisionId' IS DISTINCT FROM p_authorization_decision_id
       OR jsonb_typeof(v_run -> 'capabilityVersionId') IS DISTINCT FROM 'string'
       OR v_run ->> 'capabilityVersionId' IS DISTINCT FROM p_capability_version_id
       OR jsonb_typeof(v_run -> 'provider') IS DISTINCT FROM 'string'
       OR v_run ->> 'provider' IS DISTINCT FROM p_capability #>> '{provider,id}'
       OR jsonb_typeof(v_run -> 'providerVersion') IS DISTINCT FROM 'string'
       OR v_run ->> 'providerVersion' IS DISTINCT FROM p_capability #>> '{provider,version}'
       OR jsonb_typeof(v_run -> 'modelOrEngineVersion') IS DISTINCT FROM 'string'
       OR v_run ->> 'modelOrEngineVersion' IS DISTINCT FROM
         p_capability #>> '{modelOrEngine,version}'
       OR jsonb_typeof(v_run -> 'observedProvider') NOT IN ('null', 'string')
       OR (
         jsonb_typeof(v_run -> 'observedProvider') = 'string'
         AND length(btrim(v_run ->> 'observedProvider')) = 0
       )
       OR jsonb_typeof(v_run -> 'promptOrConfigVersion') IS DISTINCT FROM 'string'
       OR v_run ->> 'promptOrConfigVersion' IS DISTINCT FROM
         p_capability #>> '{promptOrConfig,version}'
       OR jsonb_typeof(v_run -> 'finishedAt') IS DISTINCT FROM 'string'
       OR v_run ->> 'finishedAt' !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       OR NOT isfinite((v_run ->> 'finishedAt')::timestamptz)
       OR jsonb_typeof(v_run -> 'succeeded') IS DISTINCT FROM 'boolean'
       OR (
         (v_run ->> 'succeeded')::boolean
         AND v_run ->> 'observedProvider' IS DISTINCT FROM p_capability #>> '{provider,id}'
       )
       OR (
         jsonb_typeof(v_run -> 'externalTraceId') NOT IN ('null', 'string')
       )
       OR (
         jsonb_typeof(v_run -> 'externalTraceId') = 'string'
         AND length(btrim(v_run ->> 'externalTraceId')) = 0
       )
       OR (
         jsonb_typeof(v_run -> 'inputTokens') IS DISTINCT FROM 'null'
         AND (
           jsonb_typeof(v_run -> 'inputTokens') IS DISTINCT FROM 'number'
           OR (v_run ->> 'inputTokens')::numeric IS DISTINCT FROM
             trunc((v_run ->> 'inputTokens')::numeric)
           OR (v_run ->> 'inputTokens')::numeric < 0
         )
       )
       OR (
         jsonb_typeof(v_run -> 'outputTokens') IS DISTINCT FROM 'null'
         AND (
           jsonb_typeof(v_run -> 'outputTokens') IS DISTINCT FROM 'number'
           OR (v_run ->> 'outputTokens')::numeric IS DISTINCT FROM
             trunc((v_run ->> 'outputTokens')::numeric)
           OR (v_run ->> 'outputTokens')::numeric < 0
         )
       ) THEN
      RETURN false;
    END IF;
    v_has_success := v_has_success OR (v_run ->> 'succeeded')::boolean;
  END LOOP;

  RETURN NOT p_require_success OR v_has_success;
EXCEPTION
  WHEN invalid_datetime_format OR invalid_text_representation
    OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN false;
END
$$;

REVOKE ALL ON FUNCTION learning.generated_learning_model_runs_match(
  jsonb, text, text, jsonb, boolean
) FROM PUBLIC;

DROP FUNCTION learning.create_generated_learning_request(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, integer, jsonb,
  jsonb, text, text, text, uuid, smallint, timestamptz, integer, jsonb,
  jsonb, timestamptz, timestamptz
);

CREATE FUNCTION learning.create_generated_learning_request(
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
  p_authorization jsonb,
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
DECLARE
  v_decision metrics.authorization_decisions%ROWTYPE;
  v_capability_version_id text := p_capability ->> 'id';
  v_authoritative_capability jsonb;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true)
     OR jsonb_typeof(p_authorization) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_source_snapshot) IS DISTINCT FROM 'object'
     OR (p_capability IS NOT NULL AND jsonb_typeof(p_capability) IS DISTINCT FROM 'object')
     OR p_model_runs IS DISTINCT FROM '[]'::jsonb
     OR p_source_snapshot #>> '{basis,materialId}' IS DISTINCT FROM p_material_id::text
     OR p_source_key IS DISTINCT FROM
       learning.generated_learning_source_key(p_source_snapshot) THEN
    RETURN false;
  END IF;

  SELECT * INTO v_decision
  FROM metrics.authorization_decisions
  WHERE id = p_authorization ->> 'decisionId';
  IF p_capability IS NOT NULL THEN
    v_authoritative_capability :=
      metrics.read_quality_capability(v_capability_version_id) -> 'version';
  END IF;
  IF NOT FOUND
     OR v_decision.containment_epoch IS DISTINCT FROM
       (p_authorization ->> 'containmentEpoch')::bigint
     OR v_decision.issued_at IS DISTINCT FROM
       (p_authorization ->> 'issuedAt')::timestamptz
     OR v_decision.family_space_hash IS DISTINCT FROM
       encode(sha256(convert_to(p_family_space_id::text, 'UTF8')), 'hex')
     OR v_decision.degraded_reason IS DISTINCT FROM
       (p_authorization ->> 'degradedReason')
     OR v_decision.capability_key IS DISTINCT FROM 'ai.generated-learning'
     OR v_decision.kind IS DISTINCT FROM 'ai'
     OR v_decision.subject IS DISTINCT FROM (p_source_snapshot ->> 'subject')
     OR v_decision.grade_band IS DISTINCT FROM (p_source_snapshot ->> 'ageBand')
     OR v_decision.question_type IS DISTINCT FROM 'process'
     OR v_decision.image_quality IS DISTINCT FROM 'not_applicable'
     OR v_decision.risk_level IS DISTINCT FROM 'medium'
     OR v_decision.basis_state IS DISTINCT FROM (CASE
       WHEN p_source_snapshot ->> 'basisHasConflict' = 'true' THEN 'conflicted'
       WHEN p_source_snapshot ->> 'basisHasConflict' = 'false' THEN 'current'
       ELSE NULL
     END)
     OR (
       p_capability IS NULL
       AND (
         v_decision.status IS DISTINCT FROM 'degraded'
         OR v_decision.primary_version_id IS NOT NULL
         OR p_status IS DISTINCT FROM 'unavailable'
         OR p_unavailable_reason IS DISTINCT FROM 'CAPABILITY_UNAVAILABLE'
       )
     )
     OR (
       p_capability IS NOT NULL
       AND (
         v_decision.status IS DISTINCT FROM 'authorized'
         OR v_decision.primary_version_id IS DISTINCT FROM v_capability_version_id
         OR v_authoritative_capability - 'registeredAt' IS DISTINCT FROM
           p_capability - 'registeredAt'
         OR (v_authoritative_capability ->> 'registeredAt')::timestamptz IS DISTINCT FROM
           (p_capability ->> 'registeredAt')::timestamptz
         OR (p_authorization ->> 'degradedReason') IS NOT NULL
       )
     ) THEN
    RETURN false;
  END IF;

  INSERT INTO learning.generated_learning_requests
    (id, family_space_id, learning_profile_id, material_id, idempotency_key,
     request_fingerprint, purpose, actor_type, actor_id, consent_revision,
     authorization_snapshot, authorization_decision_id, authorization_containment_epoch,
     capability, capability_version_id, source_snapshot, source_key, status,
     unavailable_reason, current_version_id, revealed_hint_level,
     processing_lease_expires_at, state_revision, latest_checks, model_runs,
     created_at, updated_at)
  VALUES
    (p_id, p_family_space_id, p_learning_profile_id, p_material_id,
     p_idempotency_key, p_request_fingerprint, p_purpose, p_actor_type,
     p_actor_id, p_consent_revision, p_authorization,
     p_authorization ->> 'decisionId',
     (p_authorization ->> 'containmentEpoch')::bigint,
     p_capability, v_capability_version_id, p_source_snapshot, p_source_key,
     p_status, p_unavailable_reason, p_current_version_id,
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
       'authorizationDecisionId', p_authorization ->> 'decisionId',
       'basisSourceVersionId', p_source_snapshot #>> '{basis,sourceVersionId}',
       'capabilityVersionId', v_capability_version_id,
       'status', p_status
     ), p_created_at);
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation
  OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION learning.create_generated_learning_request(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, integer, jsonb,
  jsonb, jsonb, text, text, text, uuid, smallint, timestamptz, integer,
  jsonb, jsonb, timestamptz, timestamptz
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
       'CAPABILITY_CONTAINED', 'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN',
       'GENERATION_CHECK_FAILED', 'MODEL_UNAVAILABLE', 'SOURCE_CHANGED',
       'SOURCE_UNAVAILABLE'
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
     OR v_request.state_revision IS DISTINCT FROM p_expected_state_revision
     OR (
       jsonb_array_length(p_model_runs) > 0
       AND NOT COALESCE(learning.generated_learning_model_runs_match(
         p_model_runs,
         v_request.authorization_decision_id,
         v_request.capability_version_id,
         v_request.capability,
         false
       ), false)
     ) THEN
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

DROP FUNCTION learning.complete_generated_learning_request(
  uuid, uuid, integer, uuid, uuid, integer, text, jsonb, jsonb, jsonb,
  jsonb, jsonb, jsonb, timestamptz
);

CREATE FUNCTION learning.complete_generated_learning_request(
  p_request_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_version_id uuid,
  p_predecessor_id uuid,
  p_revision integer,
  p_content_state text,
  p_authorization jsonb,
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
  v_rejection_reason text;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR jsonb_typeof(p_authorization) IS DISTINCT FROM 'object'
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
     OR v_request.authorization_snapshot IS NULL
     OR p_authorization IS DISTINCT FROM v_request.authorization_snapshot
     OR p_capability IS DISTINCT FROM v_request.capability
     OR p_capability ->> 'id' IS DISTINCT FROM v_request.capability_version_id
     OR NOT COALESCE(learning.generated_learning_model_runs_match(
       p_model_runs,
       v_request.authorization_decision_id,
       v_request.capability_version_id,
       v_request.capability,
       true
     ), false)
     OR p_source_snapshot IS DISTINCT FROM v_request.source_snapshot
     OR v_request.source_snapshot #>> '{basis,materialId}' IS DISTINCT FROM
       v_request.material_id::text
     OR v_request.source_key IS DISTINCT FROM
       learning.generated_learning_source_key(v_request.source_snapshot) THEN
    RETURN 'conflict';
  END IF;

  BEGIN
    PERFORM * FROM metrics.lock_current_family_capability_authorization(
      v_request.authorization_decision_id,
      v_request.capability_version_id,
      v_request.authorization_containment_epoch,
      encode(sha256(convert_to(v_request.family_space_id::text, 'UTF8')), 'hex'),
      'before_publish',
      'primary'
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_rejection_reason = MESSAGE_TEXT;
    IF v_rejection_reason = 'CAPABILITY_CONTAINED' THEN
      RETURN 'capability_contained';
    END IF;
    IF v_rejection_reason IN (
      'AUTHORIZATION_SCOPE_MISMATCH', 'AUTHORIZATION_STALE', 'ROUTE_NOT_AUTHORIZED',
      'SHADOW_PUBLICATION_FORBIDDEN'
    ) THEN
      RETURN 'capability_unavailable';
    END IF;
    RAISE;
  END;

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
     source_key, revision, predecessor_id, content_state,
     authorization_snapshot, authorization_decision_id,
     authorization_containment_epoch, capability, capability_version_id,
     source_snapshot, pack, checks, created_at)
  VALUES
    (p_version_id, v_request.id, v_request.family_space_id,
     v_request.learning_profile_id, v_request.material_id, v_request.source_key,
     p_revision, p_predecessor_id, p_content_state,
     p_authorization, v_request.authorization_decision_id,
     v_request.authorization_containment_epoch, p_capability,
     v_request.capability_version_id, p_source_snapshot, p_pack,
     p_version_checks, p_created_at);

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
       'authorizationDecisionId', v_request.authorization_decision_id,
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
  jsonb, jsonb, jsonb, jsonb, timestamptz
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
  v_rejection_reason text;
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
     OR p_next_level NOT BETWEEN 1 AND 3
     OR v_request.authorization_snapshot IS NULL
     OR v_request.capability_version_id IS NULL THEN
    RETURN 'conflict';
  END IF;

  BEGIN
    PERFORM * FROM metrics.lock_current_family_capability_authorization(
      v_request.authorization_decision_id,
      v_request.capability_version_id,
      v_request.authorization_containment_epoch,
      encode(sha256(convert_to(v_request.family_space_id::text, 'UTF8')), 'hex'),
      'before_publish',
      'primary'
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_rejection_reason = MESSAGE_TEXT;
    IF v_rejection_reason = 'CAPABILITY_CONTAINED' THEN
      RETURN 'capability_contained';
    END IF;
    IF v_rejection_reason IN (
      'AUTHORIZATION_SCOPE_MISMATCH', 'AUTHORIZATION_STALE', 'ROUTE_NOT_AUTHORIZED',
      'SHADOW_PUBLICATION_FORBIDDEN'
    ) THEN
      RETURN 'capability_unavailable';
    END IF;
    RAISE;
  END;

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
     jsonb_build_object(
       'authorizationDecisionId', v_request.authorization_decision_id,
       'level', p_next_level,
       'versionId', p_version_id
     ), p_occurred_at);
  RETURN 'completed';
END
$$;

REVOKE ALL ON FUNCTION learning.fail_generated_learning_request(
  uuid, uuid, integer, text, jsonb, jsonb, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.reveal_generated_learning_hint(
  uuid, uuid, uuid, smallint, smallint, uuid, text, uuid, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION learning.create_generated_learning_request(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, integer, jsonb,
  jsonb, jsonb, text, text, text, uuid, smallint, timestamptz, integer,
  jsonb, jsonb, timestamptz, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.fail_generated_learning_request(
  uuid, uuid, integer, text, jsonb, jsonb, uuid, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.complete_generated_learning_request(
  uuid, uuid, integer, uuid, uuid, integer, text, jsonb, jsonb, jsonb,
  jsonb, jsonb, jsonb, jsonb, timestamptz
) TO rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.reveal_generated_learning_hint(
  uuid, uuid, uuid, smallint, smallint, uuid, text, uuid, timestamptz
) TO rhea_generated_learning_app;
