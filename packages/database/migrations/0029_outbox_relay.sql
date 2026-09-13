ALTER TABLE learning.domain_outbox
  ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  ADD COLUMN next_publish_at timestamptz NOT NULL DEFAULT '-infinity',
  ADD COLUMN lease_until timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_outbox_relay') THEN
    CREATE ROLE rhea_outbox_relay NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_runtime_rebuilder') THEN
    CREATE ROLE rhea_runtime_rebuilder NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
ALTER ROLE rhea_outbox_relay SET search_path = pg_catalog, learning;
GRANT USAGE ON SCHEMA learning TO rhea_outbox_relay;
GRANT SELECT, UPDATE ON learning.domain_outbox TO rhea_outbox_relay;
CREATE POLICY domain_outbox_relay_access ON learning.domain_outbox
  USING (current_user = 'rhea_outbox_relay')
  WITH CHECK (current_user = 'rhea_outbox_relay');

CREATE OR REPLACE FUNCTION learning.claim_domain_outbox(p_limit integer)
RETURNS SETOF learning.domain_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM learning.domain_outbox
    WHERE published_at IS NULL
      AND next_publish_at <= now()
      AND (lease_until IS NULL OR lease_until < now())
    ORDER BY occurred_at, id
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE learning.domain_outbox event
  SET lease_until = now() + interval '1 minute',
      publish_attempts = publish_attempts + 1
  FROM candidates
  WHERE event.id = candidates.id
  RETURNING event.*;
END
$$;

CREATE OR REPLACE FUNCTION learning.complete_domain_outbox(p_id uuid, p_succeeded boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  UPDATE learning.domain_outbox
  SET published_at = CASE WHEN p_succeeded THEN now() ELSE published_at END,
      lease_until = NULL,
      next_publish_at = CASE
        WHEN p_succeeded THEN next_publish_at
        ELSE now() + LEAST(interval '15 minutes', interval '5 seconds' * power(2, LEAST(publish_attempts, 8)))
      END
  WHERE id = p_id AND published_at IS NULL;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION learning.claim_domain_outbox(integer),learning.complete_domain_outbox(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.claim_domain_outbox(integer),learning.complete_domain_outbox(uuid,boolean) TO rhea_outbox_relay;

CREATE OR REPLACE FUNCTION learning.lock_and_check_domain_dispatch(
  p_learning_profile_id uuid,
  p_event_type text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_learning_profile_id::text,0));
  IF p_event_type='privacy.task.requested' THEN RETURN true; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM learning.privacy_profile_freezes
    WHERE learning_profile_id=p_learning_profile_id
  );
END
$$;
REVOKE ALL ON FUNCTION learning.lock_and_check_domain_dispatch(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.lock_and_check_domain_dispatch(uuid,text) TO rhea_outbox_relay;

CREATE OR REPLACE FUNCTION learning.read_runtime_rebuild_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_snapshot jsonb;
BEGIN
  UPDATE learning.processing_jobs
  SET status = 'queued', revision = revision + 1, updated_at = now()
  WHERE status IN ('security_check', 'quality_check', 'recognizing');

  -- A Redis loss removes the delivery that owns each in-flight lease. Reset the
  -- durable authority before taking the snapshot so the rebuilt delivery can
  -- claim immediately instead of exhausting retries behind an orphaned lease.
  UPDATE learning.generated_learning_requests
  SET status = 'queued', processing_lease_expires_at = NULL,
      state_revision = state_revision + 1, updated_at = now()
  WHERE status = 'generating';
  UPDATE learning.suggested_assessments
  SET status = 'queued', processing_lease_expires_at = NULL,
      state_revision = state_revision + 1, updated_at = now()
  WHERE status = 'generating';
  UPDATE learning.review_card_requests
  SET status = 'queued', processing_lease_expires_at = NULL,
      state_revision = state_revision + 1, updated_at = now()
  WHERE status = 'generating';

  SELECT jsonb_build_object(
    'submissions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', job.id, 'learningProfileId', job.learning_profile_id) ORDER BY job.created_at, job.id)
      FROM learning.processing_jobs job
      WHERE job.status IN ('queued', 'unavailable')
    ), '[]'::jsonb),
    'generatedLearning', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', request.id, 'learningProfileId', request.learning_profile_id) ORDER BY request.created_at, request.id)
      FROM learning.generated_learning_requests request
      WHERE request.status = 'queued'
    ), '[]'::jsonb),
    'suggestedAssessments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', suggestion.id, 'learningProfileId', suggestion.learning_profile_id) ORDER BY suggestion.created_at, suggestion.id)
      FROM learning.suggested_assessments suggestion
      WHERE suggestion.status = 'queued'
    ), '[]'::jsonb),
    'reviewCards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', request.id, 'learningProfileId', request.learning_profile_id) ORDER BY request.created_at, request.id)
      FROM learning.review_card_requests request
      WHERE request.status = 'queued'
    ), '[]'::jsonb),
    'privacyTasks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', task.id) ORDER BY task.created_at, task.id)
      FROM learning.privacy_tasks task
      WHERE task.status IN ('pending', 'processing', 'retry_scheduled') AND task.deadline_at > now()
    ), '[]'::jsonb),
    'randomMatches', COALESCE((
      SELECT jsonb_agg(entry.record ORDER BY entry.entered_at, entry.entry_id)
      FROM learning.random_match_entries entry
      WHERE entry.status = 'waiting' AND entry.expires_at > now()
    ), '[]'::jsonb)
  ) INTO v_snapshot;
  RETURN v_snapshot;
END
$$;
REVOKE ALL ON FUNCTION learning.read_runtime_rebuild_snapshot() FROM PUBLIC;
GRANT USAGE ON SCHEMA learning TO rhea_runtime_rebuilder;
GRANT EXECUTE ON FUNCTION learning.read_runtime_rebuild_snapshot() TO rhea_runtime_rebuilder;

CREATE OR REPLACE FUNCTION learning.read_recovery_profiles()
RETURNS TABLE(family_space_id uuid, learning_profile_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, learning AS $$
  SELECT profile.family_space_id, profile.id
  FROM learning.learning_profiles profile
  ORDER BY profile.family_space_id, profile.id
$$;
CREATE OR REPLACE FUNCTION learning.replay_restored_profile_erasure(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_subject_token text,
  p_metrics_family_token text,
  p_metrics_profile_token text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, learning, safety, metrics AS $$
DECLARE v_key_destroyed boolean; v_deleted boolean;
BEGIN
  PERFORM metrics.erase_profile_learning_events(p_metrics_family_token, p_metrics_profile_token);
  PERFORM safety.pseudonymize_profile_records(
    p_family_space_id, p_learning_profile_id, p_subject_token
  );
  PERFORM learning.freeze_profile_for_erasure(p_family_space_id, p_learning_profile_id);
  SELECT learning.destroy_profile_key_wrap(p_learning_profile_id) INTO v_key_destroyed;
  SELECT learning.delete_profile_active_data(p_family_space_id, p_learning_profile_id) INTO v_deleted;
  RETURN jsonb_build_object('deleted', v_deleted, 'keyWrapDestroyed', v_key_destroyed);
END $$;
REVOKE ALL ON FUNCTION learning.read_recovery_profiles(),
  learning.replay_restored_profile_erasure(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.read_recovery_profiles(),
  learning.replay_restored_profile_erasure(uuid,uuid,text,text,text) TO rhea_runtime_rebuilder;

DO $$
DECLARE
  login_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_api') THEN
    GRANT rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app,
      rhea_quality_runtime, rhea_learning_progress_app, rhea_reporting_app,
      rhea_challenge_app, rhea_safety_api, rhea_privacy_api,
      rhea_provider_gateway, rhea_profile_crypto TO rhea_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_ai') THEN
    GRANT rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app,
      rhea_quality_runtime, rhea_learning_progress_app,
      rhea_provider_gateway, rhea_profile_crypto, rhea_safety_classifier TO rhea_ai;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_domain') THEN
    GRANT rhea_learning_progress_app, rhea_metrics_app, rhea_outbox_relay TO rhea_domain;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_safety') THEN
    GRANT rhea_privacy_worker, rhea_profile_crypto_reader,
      rhea_provider_gateway, rhea_safety_worker TO rhea_safety;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_recovery') THEN
    GRANT rhea_runtime_rebuilder TO rhea_recovery;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_governance') THEN
    GRANT rhea_provider_governance_admin TO rhea_governance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_support') THEN
    GRANT rhea_support_reader TO rhea_support;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_operations') THEN
    GRANT rhea_metrics_operator, rhea_quality_governance, rhea_quality_runtime,
      rhea_safety_operator TO rhea_operations;
  END IF;
  FOREACH login_role IN ARRAY ARRAY['rhea_api','rhea_ai','rhea_domain','rhea_safety','rhea_recovery','rhea_governance','rhea_support','rhea_operations']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login_role) THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), login_role);
    END IF;
  END LOOP;
END
$$;
