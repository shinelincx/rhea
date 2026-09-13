-- T21 metrics and readiness governance. Provider-quality readiness is derived
-- from the T09 quality-control authority; this migration does not create a
-- second quality policy, evaluation, signoff, or release model.

CREATE TABLE metrics.metric_registry (
  key text NOT NULL,
  version text NOT NULL,
  numerator text NOT NULL,
  denominator text NOT NULL,
  exclusions text[] NOT NULL CHECK (cardinality(exclusions) > 0),
  owner text NOT NULL,
  window_days integer NOT NULL CHECK (window_days > 0),
  retention_days integer NOT NULL CHECK (retention_days >= window_days),
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
);

INSERT INTO metrics.metric_registry (
  key, version, numerator, denominator, exclusions, owner,
  window_days, retention_days, registered_at
) VALUES
  (
    'learning_evidence.recorded', 'v1',
    'current accepted independent or assisted learning evidence',
    'all current accepted learning-evidence events',
    ARRAY['pending','disputed','expired','invalidated','shadow'],
    'learning-owner', 30, 365, '2026-09-13T00:00:00.000Z'
  ),
  (
    'review_card.attempt_recorded', 'v1',
    'current accepted completed review attempts',
    'all current accepted review attempts',
    ARRAY['pending','disputed','expired','invalidated','shadow'],
    'learning-owner', 30, 365, '2026-09-13T00:00:00.000Z'
  ),
  (
    'challenge.result_recorded', 'v1',
    'safely completed current challenge results',
    'all current accepted challenge results',
    ARRAY['pending','disputed','expired','invalidated','shadow'],
    'child-safety', 30, 180, '2026-09-13T00:00:00.000Z'
  );

CREATE TABLE metrics.learning_events (
  event_key text PRIMARY KEY CHECK (event_key ~ '^[0-9a-f]{64}$'),
  event_type text NOT NULL,
  authority_state text NOT NULL CHECK (
    authority_state IN (
      'accepted_current','disputed','expired','invalidated','pending','shadow'
    )
  ),
  family_token text NOT NULL CHECK (family_token ~ '^[0-9a-f]{64}$'),
  profile_token text NOT NULL CHECK (profile_token ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source jsonb NOT NULL CHECK (
    jsonb_typeof(source) = 'object'
    AND source ?& ARRAY['aggregateId','aggregateType','version']
    AND source->>'aggregateId' ~ '^[0-9a-f]{64}$'
  ),
  version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metrics.erased_profile_subjects (
  family_token text NOT NULL CHECK (family_token ~ '^[0-9a-f]{64}$'),
  profile_token text NOT NULL CHECK (profile_token ~ '^[0-9a-f]{64}$'),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_token, profile_token)
);

CREATE TABLE metrics.readiness_evidence (
  key text PRIMARY KEY CHECK (
    key IN (
      'child_safety_response','core_learning_flow','disaster_recovery',
      'guardian_support_flow','learning_outcome_threshold','mobile_usability',
      'performance_capacity','privacy_erasure','provider_quality',
      'shanghai_compliance_package'
    )
  ),
  passed boolean NOT NULL,
  reference text NOT NULL,
  signed_by text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE metrics.provider_quality_readiness_evaluations (
  id uuid PRIMARY KEY,
  passed boolean NOT NULL,
  reasons text[] NOT NULL,
  release_snapshot jsonb NOT NULL CHECK (jsonb_typeof(release_snapshot) = 'array'),
  evaluated_at timestamptz NOT NULL
);

CREATE TABLE metrics.governance_operations_audit (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 500),
  action text NOT NULL CHECK (
    action IN (
      'metric.register','provider_quality.evaluate','provider_quality.invalidate',
      'readiness.record'
    )
  ),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE metrics.quality_operations_audit (
  command_id text PRIMARY KEY
    REFERENCES metrics.quality_command_receipts(command_id),
  command_type text NOT NULL,
  aggregate_id text NOT NULL,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION metrics.register_metric_definition(p jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  current_row metrics.metric_registry%ROWTYPE;
BEGIN
  SELECT * INTO current_row
  FROM metrics.metric_registry
  WHERE key = p->>'key' AND version = p->>'version';
  IF FOUND THEN
    IF to_jsonb(current_row) - 'registered_at' = jsonb_build_object(
      'key', p->>'key',
      'version', p->>'version',
      'numerator', p->>'numerator',
      'denominator', p->>'denominator',
      'exclusions', p->'exclusions',
      'owner', p->>'owner',
      'window_days', (p->>'windowDays')::integer,
      'retention_days', (p->>'retentionDays')::integer
    ) THEN
      RETURN 'replayed';
    END IF;
    RETURN 'conflict';
  END IF;
  INSERT INTO metrics.metric_registry (
    key, version, numerator, denominator, exclusions, owner,
    window_days, retention_days
  ) VALUES (
    p->>'key', p->>'version', p->>'numerator', p->>'denominator',
    ARRAY(SELECT jsonb_array_elements_text(p->'exclusions')),
    p->>'owner', (p->>'windowDays')::integer, (p->>'retentionDays')::integer
  );
  RETURN 'recorded';
END
$function$;

CREATE OR REPLACE FUNCTION metrics.record_learning_metric_event(p jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  current_row metrics.learning_events%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'metrics-profile:' || (p->>'familySpaceId') || ':' || (p->>'learningProfileId'),
    0
  ));
  IF EXISTS (
    SELECT 1
    FROM metrics.erased_profile_subjects
    WHERE family_token = p->>'familySpaceId'
      AND profile_token = p->>'learningProfileId'
  ) THEN
    RETURN 'erased_subject';
  END IF;
  SELECT * INTO current_row
  FROM metrics.learning_events
  WHERE event_key = p->>'eventKey';
  IF FOUND THEN
    IF jsonb_build_object(
      'authorityState',
        CASE
          WHEN current_row.authority_state IN ('disputed','expired','invalidated')
            AND p->>'authorityState' = 'accepted_current'
          THEN 'accepted_current'
          ELSE current_row.authority_state
        END,
      'eventKey', current_row.event_key,
      'eventType', current_row.event_type,
      'familySpaceId', current_row.family_token,
      'learningProfileId', current_row.profile_token,
      'occurredAt',
        to_char(
          current_row.occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
      'payload', current_row.payload,
      'source', current_row.source,
      'version', current_row.version
    ) = p THEN
      RETURN 'replayed';
    END IF;
    RETURN 'conflict';
  END IF;
  INSERT INTO metrics.learning_events (
    event_key, event_type, authority_state, family_token, profile_token,
    occurred_at, payload, source, version
  ) VALUES (
    p->>'eventKey', p->>'eventType', p->>'authorityState',
    p->>'familySpaceId', p->>'learningProfileId',
    (p->>'occurredAt')::timestamptz, p->'payload', p->'source', p->>'version'
  );
  RETURN 'recorded';
END
$function$;

CREATE OR REPLACE FUNCTION metrics.transition_learning_metric_event_authority(p jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF p->>'authorityState' NOT IN ('disputed','expired','invalidated')
     OR jsonb_typeof(p->'eventKeys') <> 'array' THEN
    RETURN 0;
  END IF;
  UPDATE metrics.learning_events AS event
  SET authority_state = p->>'authorityState'
  WHERE event.event_key IN (SELECT jsonb_array_elements_text(p->'eventKeys'))
    AND (
      event.authority_state NOT IN ('disputed','expired','invalidated')
      OR event.authority_state = p->>'authorityState'
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.erase_profile_learning_events(
  p_family_token text,
  p_profile_token text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF p_family_token !~ '^[0-9a-f]{64}$'
     OR p_profile_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid metrics erasure token';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'metrics-profile:' || p_family_token || ':' || p_profile_token,
    0
  ));
  INSERT INTO metrics.erased_profile_subjects (family_token, profile_token)
  VALUES (p_family_token, p_profile_token)
  ON CONFLICT (family_token, profile_token) DO NOTHING;
  DELETE FROM metrics.learning_events
  WHERE family_token = p_family_token AND profile_token = p_profile_token;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.purge_expired_metric_data()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM metrics.learning_events AS event
  WHERE event.occurred_at < now() - make_interval(days => COALESCE((
    SELECT registry.retention_days
    FROM metrics.metric_registry AS registry
    WHERE registry.key = event.event_type
    ORDER BY registry.registered_at DESC
    LIMIT 1
  ), 30));
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.operate_register_metric(
  p_definition jsonb,
  p_operator_id text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  outcome text;
BEGIN
  IF btrim(p_operator_id) = '' OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid metrics operation';
  END IF;
  outcome := metrics.register_metric_definition(p_definition);
  INSERT INTO metrics.governance_operations_audit (
    operator_id, action, target, reason, occurred_at
  ) VALUES (
    p_operator_id, 'metric.register',
    (p_definition->>'key') || ':' || (p_definition->>'version'),
    p_reason, p_occurred_at
  );
  RETURN outcome;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.operate_evaluate_provider_quality(
  p_evaluation_id uuid,
  p_operator_id text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  release_snapshot jsonb;
  reasons text[] := '{}';
  passed boolean;
  active_ocr_count integer;
  active_ai_count integer;
  release_row record;
BEGIN
  IF btrim(p_operator_id) = '' OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid provider quality operation';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('metrics.provider-quality-readiness', 0)
  );
  IF EXISTS (
    SELECT 1
    FROM metrics.provider_quality_readiness_evaluations
    WHERE id = p_evaluation_id
  ) THEN
    RAISE EXCEPTION 'provider quality evaluation id already exists';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'capabilityKey', snapshot.capability_key,
        'kind', snapshot.kind,
        'releaseId', snapshot.release_id,
        'stage', snapshot.stage,
        'capabilityVersionId', snapshot.capability_version_id,
        'qualityCardId', snapshot.quality_card_id,
        'qualityEvidenceHash', snapshot.quality_evidence_hash,
        'qualityStatus', snapshot.quality_status,
        'signed', snapshot.signed
      )
      ORDER BY snapshot.kind, snapshot.capability_key
    ),
    '[]'::jsonb
  )
  INTO release_snapshot
  FROM (
    SELECT
      current_release.capability_key,
      current_release.kind,
      release.id AS release_id,
      COALESCE(release.stage, 'disabled') AS stage,
      release.capability_version_id,
      card.id::text AS quality_card_id,
      card.evidence_hash AS quality_evidence_hash,
      card.status AS quality_status,
      COALESCE(
        metrics.quality_version_is_signed(release.capability_version_id),
        false
      ) AS signed
    FROM metrics.capability_current_releases AS current_release
    LEFT JOIN metrics.capability_release_revisions AS release
      ON release.id = current_release.primary_release_id
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.evidence_hash, latest.status
      FROM metrics.quality_card_revisions AS latest
      WHERE latest.capability_version_id = release.capability_version_id
      ORDER BY latest.revision DESC
      LIMIT 1
    ) AS card ON true
  ) AS snapshot;

  SELECT
    count(*) FILTER (
      WHERE value->>'kind' = 'ocr'
        AND value->>'stage' IN ('small','expanded','general')
    ),
    count(*) FILTER (
      WHERE value->>'kind' = 'ai'
        AND value->>'stage' IN ('small','expanded','general')
    )
  INTO active_ocr_count, active_ai_count
  FROM jsonb_array_elements(release_snapshot) AS value;

  IF active_ocr_count = 0 THEN
    reasons := array_append(reasons, '缺少当前启用的 OCR 发布');
  END IF;
  IF active_ai_count = 0 THEN
    reasons := array_append(reasons, '缺少当前启用的 AI 发布');
  END IF;
  FOR release_row IN
    SELECT value
    FROM jsonb_array_elements(release_snapshot) AS value
    WHERE value->>'stage' IN ('small','expanded','general')
      AND (
        value->>'capabilityVersionId' IS NULL
        OR value->>'qualityStatus' IS DISTINCT FROM 'passed'
        OR COALESCE((value->>'signed')::boolean, false) = false
      )
  LOOP
    reasons := array_append(
      reasons,
      '当前发布未完成质量签署:'
        || (release_row.value->>'kind')
        || ':'
        || (release_row.value->>'capabilityKey')
    );
  END LOOP;
  passed := cardinality(reasons) = 0;

  INSERT INTO metrics.provider_quality_readiness_evaluations (
    id, passed, reasons, release_snapshot, evaluated_at
  ) VALUES (
    p_evaluation_id, passed, reasons, release_snapshot, p_occurred_at
  );
  INSERT INTO metrics.readiness_evidence (
    key, passed, reference, signed_by, updated_at
  ) VALUES (
    'provider_quality', passed, 'quality-readiness:' || p_evaluation_id::text,
    CASE WHEN passed THEN 'authoritative-quality-control' ELSE NULL END,
    p_occurred_at
  )
  ON CONFLICT (key) DO UPDATE SET
    passed = EXCLUDED.passed,
    reference = EXCLUDED.reference,
    signed_by = EXCLUDED.signed_by,
    updated_at = EXCLUDED.updated_at;
  INSERT INTO metrics.governance_operations_audit (
    operator_id, action, target, reason, occurred_at
  ) VALUES (
    p_operator_id, 'provider_quality.evaluate',
    p_evaluation_id::text, p_reason, p_occurred_at
  );

  RETURN jsonb_build_object(
    'id', p_evaluation_id,
    'evaluatedAt', to_char(
      p_occurred_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'passed', passed,
    'reasons', to_jsonb(reasons),
    'releases', release_snapshot
  );
END
$function$;

CREATE OR REPLACE FUNCTION metrics.operate_record_readiness_evidence(
  p_evidence jsonb,
  p_operator_id text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
BEGIN
  IF btrim(p_operator_id) = ''
     OR btrim(p_reason) = ''
     OR p_evidence->>'key' = 'provider_quality'
     OR (
       (p_evidence->>'passed')::boolean
       AND (
         btrim(p_evidence->>'reference') = ''
         OR p_evidence->>'signedBy' <> p_operator_id
       )
     ) THEN
    RAISE EXCEPTION 'invalid readiness operation';
  END IF;
  INSERT INTO metrics.readiness_evidence (
    key, passed, reference, signed_by, updated_at
  ) VALUES (
    p_evidence->>'key', (p_evidence->>'passed')::boolean,
    p_evidence->>'reference', p_evidence->>'signedBy', p_occurred_at
  )
  ON CONFLICT (key) DO UPDATE SET
    passed = EXCLUDED.passed,
    reference = EXCLUDED.reference,
    signed_by = EXCLUDED.signed_by,
    updated_at = EXCLUDED.updated_at;
  INSERT INTO metrics.governance_operations_audit (
    operator_id, action, target, reason, occurred_at
  ) VALUES (
    p_operator_id, 'readiness.record', p_evidence->>'key',
    p_reason, p_occurred_at
  );
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.record_quality_operation_audit(
  p_command_id text,
  p_operator_id text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  receipt metrics.quality_command_receipts%ROWTYPE;
  existing metrics.quality_operations_audit%ROWTYPE;
BEGIN
  IF btrim(p_operator_id) = '' OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid quality operation audit';
  END IF;
  SELECT * INTO receipt
  FROM metrics.quality_command_receipts
  WHERE command_id = p_command_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality command receipt not found';
  END IF;
  INSERT INTO metrics.quality_operations_audit (
    command_id, command_type, aggregate_id, operator_id, reason, occurred_at
  ) VALUES (
    receipt.command_id, receipt.command_type, receipt.aggregate_id,
    p_operator_id, p_reason, receipt.recorded_at
  )
  ON CONFLICT (command_id) DO NOTHING;
  SELECT * INTO existing
  FROM metrics.quality_operations_audit
  WHERE command_id = p_command_id;
  IF existing.operator_id <> p_operator_id OR existing.reason <> p_reason THEN
    RAISE EXCEPTION 'quality command audit identity conflict';
  END IF;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION metrics.invalidate_provider_quality_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $function$
DECLARE
  invalidated_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('metrics.provider-quality-readiness', 0)
  );
  UPDATE metrics.readiness_evidence
  SET passed = false, signed_by = NULL, updated_at = now()
  WHERE key = 'provider_quality' AND passed = true;
  GET DIAGNOSTICS invalidated_count = ROW_COUNT;
  IF invalidated_count > 0 THEN
    INSERT INTO metrics.governance_operations_audit (
      operator_id, action, target, reason, occurred_at
    ) VALUES (
      'system:quality-control-trigger', 'provider_quality.invalidate',
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      'authoritative T09 quality or release state changed', now()
    );
  END IF;
  RETURN NULL;
END
$function$;

CREATE TRIGGER invalidate_provider_quality_on_quality_card
AFTER INSERT OR UPDATE OR DELETE ON metrics.quality_card_revisions
FOR EACH STATEMENT EXECUTE FUNCTION metrics.invalidate_provider_quality_readiness();
CREATE TRIGGER invalidate_provider_quality_on_signoff
AFTER INSERT OR UPDATE OR DELETE ON metrics.quality_signoffs
FOR EACH STATEMENT EXECUTE FUNCTION metrics.invalidate_provider_quality_readiness();
CREATE TRIGGER invalidate_provider_quality_on_release_revision
AFTER INSERT OR UPDATE OR DELETE ON metrics.capability_release_revisions
FOR EACH STATEMENT EXECUTE FUNCTION metrics.invalidate_provider_quality_readiness();
CREATE TRIGGER invalidate_provider_quality_on_current_release
AFTER INSERT OR UPDATE OR DELETE ON metrics.capability_current_releases
FOR EACH STATEMENT EXECUTE FUNCTION metrics.invalidate_provider_quality_readiness();
CREATE TRIGGER invalidate_provider_quality_on_containment
AFTER INSERT OR UPDATE OR DELETE ON metrics.capability_containments
FOR EACH STATEMENT EXECUTE FUNCTION metrics.invalidate_provider_quality_readiness();

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_metrics_app') THEN
    CREATE ROLE rhea_metrics_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_metrics_operator') THEN
    CREATE ROLE rhea_metrics_operator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$do$;

ALTER ROLE rhea_metrics_app SET search_path = pg_catalog, metrics;
ALTER ROLE rhea_metrics_operator SET search_path = pg_catalog, metrics;
GRANT USAGE ON SCHEMA metrics TO rhea_metrics_app, rhea_metrics_operator;

ALTER TABLE metrics.metric_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.metric_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.learning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.learning_events FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.erased_profile_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.erased_profile_subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.readiness_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.readiness_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.provider_quality_readiness_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.provider_quality_readiness_evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.governance_operations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.governance_operations_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_operations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_operations_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY metric_registry_metrics_app
  ON metrics.metric_registry USING (current_user = 'rhea_metrics_app');
CREATE POLICY learning_events_metrics_app
  ON metrics.learning_events USING (current_user = 'rhea_metrics_app');
CREATE POLICY metric_registry_operator
  ON metrics.metric_registry USING (current_user = 'rhea_metrics_operator');
CREATE POLICY readiness_evidence_operator
  ON metrics.readiness_evidence USING (current_user = 'rhea_metrics_operator');
CREATE POLICY provider_quality_evaluations_operator
  ON metrics.provider_quality_readiness_evaluations
  USING (current_user = 'rhea_metrics_operator');
CREATE POLICY governance_audit_operator
  ON metrics.governance_operations_audit USING (current_user = 'rhea_metrics_operator');
CREATE POLICY quality_operations_audit_governance
  ON metrics.quality_operations_audit USING (current_user = 'rhea_quality_governance');

GRANT SELECT ON metrics.metric_registry, metrics.learning_events TO rhea_metrics_app;
GRANT SELECT ON
  metrics.metric_registry,
  metrics.readiness_evidence,
  metrics.provider_quality_readiness_evaluations,
  metrics.governance_operations_audit
TO rhea_metrics_operator;
GRANT SELECT ON metrics.quality_operations_audit TO rhea_quality_governance;

REVOKE ALL ON FUNCTION
  metrics.register_metric_definition(jsonb),
  metrics.record_learning_metric_event(jsonb),
  metrics.transition_learning_metric_event_authority(jsonb),
  metrics.erase_profile_learning_events(text,text),
  metrics.purge_expired_metric_data(),
  metrics.operate_register_metric(jsonb,text,text,timestamptz),
  metrics.operate_evaluate_provider_quality(uuid,text,text,timestamptz),
  metrics.operate_record_readiness_evidence(jsonb,text,text,timestamptz),
  metrics.record_quality_operation_audit(text,text,text),
  metrics.invalidate_provider_quality_readiness()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  metrics.record_learning_metric_event(jsonb),
  metrics.transition_learning_metric_event_authority(jsonb),
  metrics.purge_expired_metric_data()
TO rhea_metrics_app;
GRANT EXECUTE ON FUNCTION
  metrics.operate_register_metric(jsonb,text,text,timestamptz),
  metrics.operate_evaluate_provider_quality(uuid,text,text,timestamptz),
  metrics.operate_record_readiness_evidence(jsonb,text,text,timestamptz)
TO rhea_metrics_operator;
GRANT EXECUTE ON FUNCTION metrics.record_quality_operation_audit(text,text,text)
  TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.erase_profile_learning_events(text,text)
  TO rhea_privacy_worker;
GRANT USAGE ON SCHEMA metrics TO rhea_privacy_worker;

REVOKE ALL ON SCHEMA learning, safety FROM rhea_metrics_app;
