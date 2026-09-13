ALTER TABLE learning.challenge_matches
  ALTER COLUMN relation_id DROP NOT NULL,
  ADD COLUMN mode text NOT NULL DEFAULT 'partner'
    CHECK (mode IN ('partner', 'random')),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN pair_avoidance_token text,
  ADD CONSTRAINT challenge_match_mode_relation_check CHECK (
    (mode = 'partner' AND relation_id IS NOT NULL AND expires_at IS NULL AND pair_avoidance_token IS NULL)
    OR
    (mode = 'random' AND relation_id IS NULL AND expires_at IS NOT NULL AND pair_avoidance_token IS NOT NULL)
  );

CREATE TABLE learning.random_match_entries (
  entry_id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL UNIQUE REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  grade smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  status text NOT NULL CHECK (status IN ('waiting', 'matched', 'ended')),
  challenge_id uuid,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  entered_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > entered_at),
  FOREIGN KEY (learning_profile_id, family_space_id)
    REFERENCES learning.learning_profiles(id, family_space_id)
);

CREATE INDEX random_match_entries_grade_waiting_idx
  ON learning.random_match_entries (grade, entered_at, entry_id)
  WHERE status = 'waiting';

CREATE TABLE learning.random_match_identity_mappings (
  challenge_id uuid NOT NULL REFERENCES learning.challenge_matches(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 40),
  avatar_key text NOT NULL CHECK (char_length(avatar_key) BETWEEN 1 AND 80),
  PRIMARY KEY (challenge_id, learning_profile_id)
);

CREATE TABLE learning.pair_avoidance_tokens (
  token text PRIMARY KEY CHECK (char_length(token) BETWEEN 40 AND 100),
  reason text NOT NULL CHECK (reason = 'reported'),
  created_at timestamptz NOT NULL
);

CREATE TABLE learning.deidentified_challenge_results (
  challenge_id uuid NOT NULL,
  owner_family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  owner_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  ended_at timestamptz NOT NULL,
  ended_reason text NOT NULL CHECK (
    ended_reason IN ('authorization_withdrawn', 'completed', 'expired', 'left', 'reported')
  ),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (challenge_id, owner_learning_profile_id),
  FOREIGN KEY (owner_learning_profile_id, owner_family_space_id)
    REFERENCES learning.learning_profiles(id, family_space_id)
);

CREATE INDEX deidentified_challenge_results_owner_idx
  ON learning.deidentified_challenge_results
    (owner_learning_profile_id, ended_at DESC, challenge_id);

CREATE TABLE safety.challenge_reports (
  id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL,
  reporter_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  participant_a_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  participant_b_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (
    reason IN ('other_preset', 'suspected_cheating', 'uncomfortable', 'unsafe_content')
  ),
  created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'closed'))
);

ALTER TABLE learning.random_match_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.random_match_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.random_match_identity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.random_match_identity_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.pair_avoidance_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.pair_avoidance_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.deidentified_challenge_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.deidentified_challenge_results FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY random_match_entries_owner_scope ON learning.random_match_entries
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (
    learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
    AND family_space_id::text = current_setting('rhea.family_space_id', true)
  );

CREATE POLICY random_match_identity_participant_scope
  ON learning.random_match_identity_mappings
  USING (EXISTS (
    SELECT 1 FROM learning.challenge_matches challenge_match
    WHERE challenge_match.id = random_match_identity_mappings.challenge_id
      AND current_setting('rhea.learning_profile_id', true) IN (
        challenge_match.participant_a_learning_profile_id::text,
        challenge_match.participant_b_learning_profile_id::text
      )
  ));

CREATE POLICY deidentified_challenge_results_owner_scope
  ON learning.deidentified_challenge_results
  USING (owner_learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (owner_learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

CREATE OR REPLACE FUNCTION learning.create_random_challenge(
  p_record jsonb,
  p_entries jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_challenge_id uuid := (p_record ->> 'id')::uuid;
  v_entry_a uuid := (p_entries #>> '{0,entryId}')::uuid;
  v_entry_b uuid := (p_entries #>> '{1,entryId}')::uuid;
  v_profile_a uuid := (p_record #>> '{packs,0,learningProfileId}')::uuid;
  v_profile_b uuid := (p_record #>> '{packs,1,learningProfileId}')::uuid;
  v_pair_token text := p_record ->> 'pairAvoidanceToken';
  v_item jsonb;
  v_identity jsonb;
  v_identity_profile_count integer;
  v_pack jsonb;
  v_position integer;
  v_expected_target text;
BEGIN
  v_expected_target := CASE p_record ->> 'subject'
    WHEN 'chinese' THEN '同年级语文基础挑战'
    WHEN 'english' THEN '同年级英语基础挑战'
    WHEN 'mathematics' THEN '同年级数学基础挑战'
    WHEN 'science' THEN '同年级科学基础挑战'
    ELSE ''
  END;
  SELECT count(DISTINCT (identity_row.value ->> 'learningProfileId')::uuid)
  INTO v_identity_profile_count
  FROM jsonb_array_elements(p_record -> 'identities') AS identity_row(value);

  IF p_record ->> 'mode' <> 'random'
     OR p_record -> 'relationId' <> 'null'::jsonb
     OR jsonb_array_length(p_entries) <> 2
     OR jsonb_array_length(p_record -> 'packs') <> 2
     OR jsonb_array_length(p_record -> 'identities') <> 2
     OR v_identity_profile_count <> 2
     OR p_record ->> 'target' <> v_expected_target
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_record -> 'identities') AS identity_row(value)
       WHERE (identity_row.value ->> 'learningProfileId')::uuid NOT IN (v_profile_a, v_profile_b)
          OR EXISTS (
            SELECT 1
            FROM jsonb_object_keys(identity_row.value) AS identity_key(key)
            WHERE identity_key.key NOT IN ('avatarKey', 'learningProfileId', 'nickname')
          )
     )
     OR NOT learning.challenge_authorizations_current(p_record -> 'authorizationSnapshots') THEN
    RETURN 'conflict';
  END IF;

  PERFORM 1
  FROM learning.random_match_entries entry_a
  JOIN learning.random_match_entries entry_b ON entry_b.entry_id = v_entry_b
  WHERE entry_a.entry_id = v_entry_a
    AND entry_a.status = 'waiting'
    AND entry_b.status = 'waiting'
    AND entry_a.learning_profile_id = v_profile_a
    AND entry_b.learning_profile_id = v_profile_b
    AND entry_a.learning_profile_id <> entry_b.learning_profile_id
    AND entry_a.family_space_id <> entry_b.family_space_id
    AND entry_a.grade = entry_b.grade
    AND entry_a.grade = (p_record #>> '{authorizationSnapshots,0,grade}')::smallint
    AND entry_b.grade = (p_record #>> '{authorizationSnapshots,1,grade}')::smallint
    AND entry_a.expires_at > (p_record ->> 'createdAt')::timestamptz
    AND entry_b.expires_at > (p_record ->> 'createdAt')::timestamptz
  FOR UPDATE OF entry_a, entry_b;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;

  IF EXISTS (SELECT 1 FROM learning.pair_avoidance_tokens WHERE token = v_pair_token) THEN
    RETURN 'avoided';
  END IF;

  INSERT INTO learning.challenge_matches (
    id, relation_id, participant_a_learning_profile_id,
    participant_b_learning_profile_id, status, version,
    capability_version_id, authorization_decision_id, record,
    created_at, cancelled_at, mode, expires_at, pair_avoidance_token
  ) VALUES (
    v_challenge_id, NULL, v_profile_a, v_profile_b,
    p_record ->> 'status', (p_record ->> 'version')::integer,
    p_record ->> 'capabilityVersionId', p_record ->> 'authorizationDecisionId',
    p_record, (p_record ->> 'createdAt')::timestamptz, NULL,
    'random', (p_record ->> 'expiresAt')::timestamptz, v_pair_token
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;

  FOR v_pack IN SELECT value FROM jsonb_array_elements(p_record -> 'packs')
  LOOP
    v_position := 0;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_pack -> 'items')
    LOOP
      INSERT INTO learning.challenge_items (
        challenge_id, learning_profile_id, item_id, position, item
      ) VALUES (
        v_challenge_id,
        (v_pack ->> 'learningProfileId')::uuid,
        v_item ->> 'id',
        v_position,
        v_item
      );
      v_position := v_position + 1;
    END LOOP;
  END LOOP;

  FOR v_identity IN SELECT value FROM jsonb_array_elements(p_record -> 'identities')
  LOOP
    INSERT INTO learning.random_match_identity_mappings (
      challenge_id, learning_profile_id, nickname, avatar_key
    ) VALUES (
      v_challenge_id,
      (v_identity ->> 'learningProfileId')::uuid,
      v_identity ->> 'nickname',
      v_identity ->> 'avatarKey'
    );
  END LOOP;

  UPDATE learning.random_match_entries
  SET status = 'matched', challenge_id = v_challenge_id
  WHERE entry_id IN (v_entry_a, v_entry_b);
  RETURN 'created';
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
  RETURN 'conflict';
END
$$;

CREATE OR REPLACE FUNCTION learning.finalize_random_challenge(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning, safety
AS $$
DECLARE
  v_match learning.challenge_matches%ROWTYPE;
  v_result jsonb;
  v_reporter uuid;
BEGIN
  SELECT * INTO v_match
  FROM learning.challenge_matches
  WHERE id = (p_payload #>> '{challenge,id}')::uuid
    AND mode = 'random'
  FOR UPDATE;
  IF NOT FOUND
     OR v_match.version <> (p_payload ->> 'expectedVersion')::integer
     OR current_setting('rhea.learning_profile_id', true) NOT IN (
       v_match.participant_a_learning_profile_id::text,
       v_match.participant_b_learning_profile_id::text
     ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_payload -> 'results') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload -> 'results') <> 2
     OR (
       SELECT count(DISTINCT (result_row.value #>> '{owner,learningProfileId}')::uuid)
       FROM jsonb_array_elements(p_payload -> 'results') AS result_row(value)
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_payload -> 'results') AS result_row(value)
       WHERE (result_row.value #>> '{owner,learningProfileId}')::uuid NOT IN (
         v_match.participant_a_learning_profile_id,
         v_match.participant_b_learning_profile_id
       )
          OR (result_row.value ->> 'challengeId')::uuid <> v_match.id
          OR (result_row.value #>> '{view,id}')::uuid <> v_match.id
          OR result_row.value #> '{view,opponentIdentity}' <> 'null'::jsonb
          OR result_row.value #> '{view,relationId}' <> 'null'::jsonb
          OR (result_row.value -> 'view') ?| ARRAY[
            'messages', 'school', 'className', 'contact', 'location'
          ]
          OR (
            (result_row.value #>> '{owner,learningProfileId}')::uuid =
              v_match.participant_a_learning_profile_id
            AND position(
              v_match.participant_b_learning_profile_id::text IN result_row.value::text
            ) > 0
          )
          OR (
            (result_row.value #>> '{owner,learningProfileId}')::uuid =
              v_match.participant_b_learning_profile_id
            AND position(
              v_match.participant_a_learning_profile_id::text IN result_row.value::text
            ) > 0
          )
     ) THEN
    RETURN false;
  END IF;

  IF p_payload -> 'reportedByProfileId' <> 'null'::jsonb THEN
    v_reporter := (p_payload ->> 'reportedByProfileId')::uuid;
    IF v_reporter::text <> current_setting('rhea.learning_profile_id', true)
       OR p_payload ->> 'reportReason' NOT IN (
         'other_preset', 'suspected_cheating', 'uncomfortable', 'unsafe_content'
       ) THEN
      RETURN false;
    END IF;
    INSERT INTO learning.pair_avoidance_tokens (token, reason, created_at)
    VALUES (v_match.pair_avoidance_token, 'reported', now())
    ON CONFLICT DO NOTHING;
    INSERT INTO safety.challenge_reports (
      id, challenge_id, reporter_learning_profile_id,
      participant_a_learning_profile_id, participant_b_learning_profile_id,
      reason, created_at
    ) VALUES (
      gen_random_uuid(), v_match.id, v_reporter,
      v_match.participant_a_learning_profile_id,
      v_match.participant_b_learning_profile_id,
      p_payload ->> 'reportReason', now()
    );
  END IF;

  FOR v_result IN SELECT value FROM jsonb_array_elements(p_payload -> 'results')
  LOOP
    INSERT INTO learning.deidentified_challenge_results (
      challenge_id, owner_family_space_id, owner_learning_profile_id,
      ended_at, ended_reason, record
    ) VALUES (
      v_match.id,
      (v_result #>> '{owner,familySpaceId}')::uuid,
      (v_result #>> '{owner,learningProfileId}')::uuid,
      (v_result ->> 'endedAt')::timestamptz,
      v_result #>> '{view,endedReason}',
      v_result
    );
  END LOOP;

  IF (SELECT count(*) FROM learning.deidentified_challenge_results WHERE challenge_id = v_match.id) <> 2 THEN
    RAISE EXCEPTION 'random challenge requires exactly two owner results';
  END IF;
  UPDATE learning.random_match_entries SET status = 'ended'
  WHERE challenge_id = v_match.id;
  DELETE FROM learning.challenge_matches WHERE id = v_match.id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.read_due_random_challenges(
  p_due_at timestamptz,
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT record
  FROM learning.challenge_matches
  WHERE mode = 'random' AND status = 'active' AND expires_at <= p_due_at
  ORDER BY expires_at, id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION learning.create_random_challenge(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.finalize_random_challenge(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.read_due_random_challenges(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA safety FROM rhea_challenge_app;
REVOKE ALL ON SCHEMA safety FROM rhea_challenge_app;

GRANT SELECT, INSERT, UPDATE ON learning.random_match_entries TO rhea_challenge_app;
GRANT SELECT ON learning.deidentified_challenge_results TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.create_random_challenge(jsonb, jsonb) TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.finalize_random_challenge(jsonb) TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.read_due_random_challenges(timestamptz, integer) TO rhea_challenge_app;
