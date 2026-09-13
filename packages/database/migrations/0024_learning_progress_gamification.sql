CREATE TABLE learning.gamification_events (
  id bigserial PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN (
    'learning_evidence_assisted',
    'learning_evidence_independent',
    'review_completed',
    'safe_challenge_completed'
  )),
  authority_state text NOT NULL CHECK (authority_state IN (
    'accepted_current', 'disputed', 'expired', 'invalidated', 'pending', 'shadow'
  )),
  learning_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  source_reference_id text NOT NULL CHECK (char_length(source_reference_id) BETWEEN 1 AND 200),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (learning_profile_id, event_key),
  FOREIGN KEY (family_space_id, learning_profile_id)
    REFERENCES learning.learning_profiles(family_space_id, id) ON DELETE CASCADE
);

CREATE INDEX gamification_events_profile_time_idx
  ON learning.gamification_events (learning_profile_id, occurred_at, event_key);

CREATE OR REPLACE FUNCTION learning.emit_challenge_result_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  INSERT INTO learning.domain_outbox (
    id,family_space_id,learning_profile_id,aggregate_type,aggregate_id,
    event_type,payload,occurred_at
  ) VALUES (
    gen_random_uuid(),NEW.owner_family_space_id,NEW.owner_learning_profile_id,
    'challenge_result',NEW.challenge_id,'challenge.result_recorded',
    jsonb_build_object('endedReason',NEW.ended_reason),NEW.ended_at
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER deidentified_challenge_result_event
  AFTER INSERT ON learning.deidentified_challenge_results
  FOR EACH ROW EXECUTE FUNCTION learning.emit_challenge_result_event();

ALTER TABLE learning.gamification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.gamification_events FORCE ROW LEVEL SECURITY;

CREATE POLICY gamification_events_profile_isolation ON learning.gamification_events
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
  );

CREATE OR REPLACE FUNCTION learning.record_gamification_event(p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_existing learning.gamification_events%ROWTYPE;
  v_family_space_id uuid := (p_payload ->> 'familySpaceId')::uuid;
  v_learning_profile_id uuid := (p_payload ->> 'learningProfileId')::uuid;
BEGIN
  IF v_family_space_id::text IS DISTINCT FROM current_setting('rhea.family_space_id', true)
     OR v_learning_profile_id::text IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR p_payload ->> 'kind' NOT IN (
       'learning_evidence_assisted', 'learning_evidence_independent',
       'review_completed', 'safe_challenge_completed'
     )
     OR p_payload ->> 'authorityState' NOT IN (
       'accepted_current', 'disputed', 'expired', 'invalidated', 'pending', 'shadow'
     ) THEN
    RETURN 'conflict';
  END IF;

  SELECT * INTO v_existing
  FROM learning.gamification_events
  WHERE learning_profile_id = v_learning_profile_id
    AND event_key = p_payload ->> 'eventKey'
  FOR UPDATE;
  IF FOUND THEN
    IF jsonb_build_object(
      'familySpaceId', v_existing.family_space_id,
      'learningProfileId', v_existing.learning_profile_id,
      'eventKey', v_existing.event_key,
      'kind', v_existing.kind,
      'authorityState', CASE
        WHEN v_existing.authority_state IN ('disputed','expired','invalidated')
          AND p_payload ->> 'authorityState' = 'accepted_current'
        THEN 'accepted_current' ELSE v_existing.authority_state END,
      'learningDate', to_char(v_existing.learning_date, 'YYYY-MM-DD'),
      'occurredAt', to_char(v_existing.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt', CASE WHEN v_existing.expires_at IS NULL THEN NULL ELSE to_char(v_existing.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'sourceReferenceId', v_existing.source_reference_id,
      'sourceVersion', CASE
        WHEN v_existing.authority_state IN ('disputed','expired','invalidated')
          AND p_payload ->> 'authorityState' = 'accepted_current'
        THEN p_payload ->> 'sourceVersion' ELSE v_existing.source_version END
    ) = p_payload THEN
      RETURN 'replayed';
    END IF;
    RETURN 'conflict';
  END IF;

  INSERT INTO learning.gamification_events (
    family_space_id, learning_profile_id, event_key, kind, authority_state,
    learning_date, occurred_at, expires_at, source_reference_id, source_version
  ) VALUES (
    v_family_space_id, v_learning_profile_id, p_payload ->> 'eventKey',
    p_payload ->> 'kind', p_payload ->> 'authorityState',
    (p_payload ->> 'learningDate')::date, (p_payload ->> 'occurredAt')::timestamptz,
    (p_payload ->> 'expiresAt')::timestamptz,
    p_payload ->> 'sourceReferenceId', p_payload ->> 'sourceVersion'
  );

  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    gen_random_uuid(), v_family_space_id, v_learning_profile_id,
    'gamification_profile', v_learning_profile_id, 'gamification.event_recorded',
    jsonb_build_object(
      'eventKey', p_payload ->> 'eventKey',
      'kind', p_payload ->> 'kind',
      'authorityState', p_payload ->> 'authorityState'
    ),
    (p_payload ->> 'occurredAt')::timestamptz
  );
  RETURN 'recorded';
END
$$;

CREATE OR REPLACE FUNCTION learning.update_gamification_event_authority(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF (p_payload ->> 'familySpaceId') IS DISTINCT FROM current_setting('rhea.family_space_id', true)
     OR (p_payload ->> 'learningProfileId') IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR p_payload ->> 'authorityState' NOT IN ('disputed', 'expired', 'invalidated') THEN
    RETURN false;
  END IF;
  UPDATE learning.gamification_events
  SET authority_state = p_payload ->> 'authorityState',
      source_version = p_payload ->> 'sourceVersion',
      updated_at = now()
  WHERE family_space_id = (p_payload ->> 'familySpaceId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
    AND event_key = p_payload ->> 'eventKey'
    AND (
      authority_state NOT IN ('disputed','expired','invalidated')
      OR authority_state = p_payload ->> 'authorityState'
    );
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION learning.record_gamification_event(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.update_gamification_event_authority(jsonb) FROM PUBLIC;
GRANT SELECT ON learning.gamification_events TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.record_gamification_event(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.update_gamification_event_authority(jsonb) TO rhea_learning_progress_app;
