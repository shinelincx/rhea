DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_challenge_app') THEN
    CREATE ROLE rhea_challenge_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_challenge_app SET search_path = pg_catalog, learning;

CREATE TABLE learning.partner_invites (
  id uuid PRIMARY KEY,
  creator_family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  creator_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (char_length(code_hash) BETWEEN 40 AND 100),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  relation_id uuid,
  CHECK (expires_at > created_at)
);

CREATE TABLE learning.partner_relations (
  id uuid PRIMARY KEY,
  participant_a_family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  participant_a_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  participant_b_family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  participant_b_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'dissolved')),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL,
  dissolved_at timestamptz,
  CHECK (participant_a_learning_profile_id <> participant_b_learning_profile_id),
  FOREIGN KEY (participant_a_learning_profile_id, participant_a_family_space_id)
    REFERENCES learning.learning_profiles(id, family_space_id),
  FOREIGN KEY (participant_b_learning_profile_id, participant_b_family_space_id)
    REFERENCES learning.learning_profiles(id, family_space_id)
);

ALTER TABLE learning.partner_invites
  ADD CONSTRAINT partner_invites_relation_fk
  FOREIGN KEY (relation_id) REFERENCES learning.partner_relations(id);

CREATE TABLE learning.challenge_matches (
  id uuid PRIMARY KEY,
  relation_id uuid NOT NULL REFERENCES learning.partner_relations(id),
  participant_a_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  participant_b_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
  version integer NOT NULL CHECK (version > 0),
  capability_version_id text NOT NULL CHECK (char_length(capability_version_id) BETWEEN 1 AND 200),
  authorization_decision_id text NOT NULL CHECK (char_length(authorization_decision_id) BETWEEN 1 AND 200),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL,
  cancelled_at timestamptz
);

CREATE TABLE learning.challenge_items (
  challenge_id uuid NOT NULL REFERENCES learning.challenge_matches(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 200),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  PRIMARY KEY (challenge_id, learning_profile_id, item_id),
  UNIQUE (challenge_id, learning_profile_id, position)
);

CREATE TABLE learning.challenge_attempts (
  challenge_id uuid NOT NULL REFERENCES learning.challenge_matches(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  command_id text NOT NULL CHECK (char_length(command_id) BETWEEN 1 AND 200),
  answer text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 500),
  correct boolean NOT NULL,
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (challenge_id, learning_profile_id, item_id),
  UNIQUE (challenge_id, learning_profile_id, command_id),
  FOREIGN KEY (challenge_id, learning_profile_id, item_id)
    REFERENCES learning.challenge_items(challenge_id, learning_profile_id, item_id)
    ON DELETE CASCADE
);

CREATE INDEX partner_relations_a_idx
  ON learning.partner_relations (participant_a_learning_profile_id, created_at, id);
CREATE INDEX partner_relations_b_idx
  ON learning.partner_relations (participant_b_learning_profile_id, created_at, id);
CREATE INDEX challenge_matches_a_idx
  ON learning.challenge_matches (participant_a_learning_profile_id, created_at DESC, id);
CREATE INDEX challenge_matches_b_idx
  ON learning.challenge_matches (participant_b_learning_profile_id, created_at DESC, id);

ALTER TABLE learning.partner_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.partner_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.partner_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.partner_relations FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_matches FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_items FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.challenge_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_invites_creator_scope ON learning.partner_invites
  USING (creator_learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (creator_learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

CREATE POLICY partner_relations_participant_scope ON learning.partner_relations
  USING (current_setting('rhea.learning_profile_id', true) IN (
    participant_a_learning_profile_id::text,
    participant_b_learning_profile_id::text
  ))
  WITH CHECK (current_setting('rhea.learning_profile_id', true) IN (
    participant_a_learning_profile_id::text,
    participant_b_learning_profile_id::text
  ));

CREATE POLICY challenge_matches_participant_scope ON learning.challenge_matches
  USING (current_setting('rhea.learning_profile_id', true) IN (
    participant_a_learning_profile_id::text,
    participant_b_learning_profile_id::text
  ))
  WITH CHECK (current_setting('rhea.learning_profile_id', true) IN (
    participant_a_learning_profile_id::text,
    participant_b_learning_profile_id::text
  ));

CREATE POLICY challenge_items_owner_scope ON learning.challenge_items
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (EXISTS (
    SELECT 1 FROM learning.challenge_matches challenge_match
    WHERE challenge_match.id = challenge_items.challenge_id
      AND current_setting('rhea.learning_profile_id', true) IN (
        challenge_match.participant_a_learning_profile_id::text,
        challenge_match.participant_b_learning_profile_id::text
      )
  ));

CREATE POLICY challenge_attempts_owner_scope ON learning.challenge_attempts
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (EXISTS (
    SELECT 1 FROM learning.challenge_matches challenge_match
    WHERE challenge_match.id = challenge_attempts.challenge_id
      AND current_setting('rhea.learning_profile_id', true) IN (
        challenge_match.participant_a_learning_profile_id::text,
        challenge_match.participant_b_learning_profile_id::text
      )
  ));

CREATE OR REPLACE FUNCTION learning.read_partner_invite_by_hash(p_code_hash text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT record
  FROM learning.partner_invites
  WHERE code_hash = p_code_hash
$$;

REVOKE ALL ON FUNCTION learning.read_partner_invite_by_hash(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.challenge_authorizations_current(p_snapshots jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_snapshot jsonb;
  v_valid_count integer := 0;
BEGIN
  IF jsonb_typeof(p_snapshots) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_snapshots) <> 2 THEN
    RETURN false;
  END IF;
  FOR v_snapshot IN SELECT value FROM jsonb_array_elements(p_snapshots)
  LOOP
    PERFORM 1
    FROM learning.learning_profiles profile
    JOIN learning.family_consents consent
      ON consent.family_space_id = profile.family_space_id
     AND consent.kind = 'peer_challenge'
    WHERE profile.id = (v_snapshot ->> 'learningProfileId')::uuid
      AND profile.family_space_id = (v_snapshot ->> 'familySpaceId')::uuid
      AND profile.grade = (v_snapshot ->> 'grade')::smallint
      AND consent.status = 'granted'
      AND consent.revision = (v_snapshot ->> 'consentRevision')::integer
    FOR SHARE OF profile, consent;
    IF NOT FOUND THEN RETURN false; END IF;
    v_valid_count := v_valid_count + 1;
  END LOOP;
  RETURN v_valid_count = 2;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION learning.challenge_authorizations_current(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.consume_partner_invite(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_invite learning.partner_invites%ROWTYPE;
  v_relation jsonb := p_payload -> 'relation';
  v_consumed_at timestamptz := (p_payload ->> 'consumedAt')::timestamptz;
BEGIN
  SELECT * INTO v_invite
  FROM learning.partner_invites
  WHERE id = (p_payload ->> 'inviteId')::uuid
    AND code_hash = p_payload ->> 'codeHash'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'not_found'); END IF;
  IF v_invite.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'already_used');
  END IF;
  IF v_invite.expires_at <= v_consumed_at THEN
    RETURN jsonb_build_object('kind', 'expired');
  END IF;
  IF v_relation #>> '{participants,1,learningProfileId}' IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR v_relation #>> '{participants,1,familySpaceId}' IS DISTINCT FROM
       current_setting('rhea.family_space_id', true)
     OR v_relation #>> '{participants,0,learningProfileId}' IS DISTINCT FROM
       v_invite.creator_learning_profile_id::text
     OR v_relation #>> '{participants,0,familySpaceId}' IS DISTINCT FROM
       v_invite.creator_family_space_id::text
     OR NOT learning.challenge_authorizations_current(
       p_payload -> 'authorizationSnapshots'
     ) THEN
    RETURN jsonb_build_object('kind', 'not_found');
  END IF;

  INSERT INTO learning.partner_relations (
    id,
    participant_a_family_space_id,
    participant_a_learning_profile_id,
    participant_b_family_space_id,
    participant_b_learning_profile_id,
    status,
    record,
    created_at,
    dissolved_at
  ) VALUES (
    (v_relation ->> 'id')::uuid,
    (v_relation #>> '{participants,0,familySpaceId}')::uuid,
    (v_relation #>> '{participants,0,learningProfileId}')::uuid,
    (v_relation #>> '{participants,1,familySpaceId}')::uuid,
    (v_relation #>> '{participants,1,learningProfileId}')::uuid,
    v_relation ->> 'status',
    v_relation,
    (v_relation ->> 'createdAt')::timestamptz,
    NULL
  );

  UPDATE learning.partner_invites
  SET consumed_at = v_consumed_at,
      relation_id = (v_relation ->> 'id')::uuid,
      record = jsonb_set(
        jsonb_set(record, '{consumedAt}', to_jsonb(p_payload ->> 'consumedAt')),
        '{relationId}',
        to_jsonb(v_relation ->> 'id')
      )
  WHERE id = v_invite.id;

  RETURN jsonb_build_object('kind', 'consumed', 'relation', v_relation);
END
$$;

REVOKE ALL ON FUNCTION learning.consume_partner_invite(jsonb) FROM PUBLIC;

REVOKE ALL ON SCHEMA learning FROM rhea_challenge_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_challenge_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_challenge_app;
GRANT USAGE ON SCHEMA learning TO rhea_challenge_app;
GRANT SELECT, INSERT, UPDATE ON
  learning.partner_invites,
  learning.partner_relations,
  learning.challenge_matches,
  learning.challenge_items,
  learning.challenge_attempts
TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.read_partner_invite_by_hash(text) TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.consume_partner_invite(jsonb) TO rhea_challenge_app;
GRANT EXECUTE ON FUNCTION learning.challenge_authorizations_current(jsonb) TO rhea_challenge_app;
