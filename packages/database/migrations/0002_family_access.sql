CREATE TABLE learning.guardians (
  id uuid PRIMARY KEY,
  identity_subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning.family_spaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning.guardian_memberships (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id),
  guardian_id uuid NOT NULL REFERENCES learning.guardians(id),
  role text NOT NULL CHECK (role IN ('managing')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_verification')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_space_id, guardian_id)
);

CREATE INDEX guardian_memberships_guardian_idx
  ON learning.guardian_memberships (guardian_id, family_space_id);

CREATE TABLE learning.learning_profiles (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  grade smallint CHECK (grade BETWEEN 1 AND 6),
  pin_hash text NOT NULL,
  failed_pin_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_pin_attempts BETWEEN 0 AND 5),
  pin_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX learning_profiles_family_idx
  ON learning.learning_profiles (family_space_id, created_at, id);

CREATE TABLE learning.registered_devices (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX registered_devices_family_idx
  ON learning.registered_devices (family_space_id, id);

CREATE TABLE learning.sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  guardian_id uuid REFERENCES learning.guardians(id),
  family_space_id uuid REFERENCES learning.family_spaces(id),
  learning_profile_id uuid REFERENCES learning.learning_profiles(id),
  device_id uuid REFERENCES learning.registered_devices(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (actor_type = 'guardian' AND guardian_id IS NOT NULL AND family_space_id IS NULL
      AND learning_profile_id IS NULL AND device_id IS NULL)
    OR
    (actor_type = 'learner' AND guardian_id IS NULL AND family_space_id IS NOT NULL
      AND learning_profile_id IS NOT NULL AND device_id IS NOT NULL)
  )
);

CREATE INDEX sessions_guardian_idx ON learning.sessions (guardian_id, expires_at);
CREATE INDEX sessions_family_profile_idx
  ON learning.sessions (family_space_id, learning_profile_id, expires_at);
CREATE INDEX sessions_device_idx ON learning.sessions (device_id, expires_at);

ALTER TABLE learning.guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.guardians FORCE ROW LEVEL SECURITY;
CREATE POLICY guardians_scope ON learning.guardians
  USING (
    identity_subject = current_setting('rhea.identity_subject', true)
    OR id::text = current_setting('rhea.guardian_id', true)
  )
  WITH CHECK (
    identity_subject = current_setting('rhea.identity_subject', true)
    OR id::text = current_setting('rhea.guardian_id', true)
  );

ALTER TABLE learning.family_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.family_spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY family_spaces_scope ON learning.family_spaces
  USING (id::text = current_setting('rhea.family_space_id', true))
  WITH CHECK (id::text = current_setting('rhea.family_space_id', true));

ALTER TABLE learning.guardian_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.guardian_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_memberships_scope ON learning.guardian_memberships
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND guardian_id::text = current_setting('rhea.guardian_id', true)
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND guardian_id::text = current_setting('rhea.guardian_id', true)
  );

ALTER TABLE learning.learning_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_profiles_scope ON learning.learning_profiles
  USING (family_space_id::text = current_setting('rhea.family_space_id', true))
  WITH CHECK (family_space_id::text = current_setting('rhea.family_space_id', true));

ALTER TABLE learning.registered_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.registered_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY registered_devices_scope ON learning.registered_devices
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR token_hash = current_setting('rhea.device_token_hash', true)
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR token_hash = current_setting('rhea.device_token_hash', true)
  );

ALTER TABLE learning.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_scope ON learning.sessions
  USING (
    token_hash = current_setting('rhea.session_token_hash', true)
    OR guardian_id::text = current_setting('rhea.guardian_id', true)
    OR family_space_id::text = current_setting('rhea.family_space_id', true)
  )
  WITH CHECK (
    token_hash = current_setting('rhea.session_token_hash', true)
    OR guardian_id::text = current_setting('rhea.guardian_id', true)
    OR family_space_id::text = current_setting('rhea.family_space_id', true)
  );
