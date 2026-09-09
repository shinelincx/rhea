ALTER TABLE learning.sessions
  ADD COLUMN reverified_at timestamptz,
  ADD CONSTRAINT sessions_reverified_before_expiry
    CHECK (reverified_at IS NULL OR reverified_at < expires_at);

CREATE TABLE learning.family_consents (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'photo_processing', 'ai_processing', 'peer_challenge', 'notifications'
  )),
  status text NOT NULL CHECK (status IN ('granted', 'denied', 'withdrawn')),
  statement_version text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_by_guardian_id uuid NOT NULL REFERENCES learning.guardians(id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (family_space_id, kind)
);

CREATE TABLE learning.consent_events (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'photo_processing', 'ai_processing', 'peer_challenge', 'notifications'
  )),
  previous_status text CHECK (previous_status IS NULL OR previous_status IN (
    'granted', 'denied', 'withdrawn'
  )),
  status text NOT NULL CHECK (status IN ('granted', 'denied', 'withdrawn')),
  statement_version text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  changed_by_guardian_id uuid NOT NULL REFERENCES learning.guardians(id),
  occurred_at timestamptz NOT NULL,
  UNIQUE (family_space_id, kind, revision)
);

CREATE INDEX family_consents_guardian_idx
  ON learning.family_consents (updated_by_guardian_id);
CREATE INDEX consent_events_family_kind_time_idx
  ON learning.consent_events (family_space_id, kind, occurred_at);
CREATE INDEX consent_events_guardian_idx
  ON learning.consent_events (changed_by_guardian_id);

ALTER TABLE learning.family_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.family_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.consent_events FORCE ROW LEVEL SECURITY;

CREATE POLICY family_consents_family_isolation ON learning.family_consents
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR EXISTS (
      SELECT 1 FROM learning.guardian_memberships membership
      WHERE membership.family_space_id = family_consents.family_space_id
        AND membership.guardian_id::text = current_setting('rhea.guardian_id', true)
        AND membership.status = 'active'
    )
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR EXISTS (
      SELECT 1 FROM learning.guardian_memberships membership
      WHERE membership.family_space_id = family_consents.family_space_id
        AND membership.guardian_id::text = current_setting('rhea.guardian_id', true)
        AND membership.status = 'active'
    )
  );

CREATE POLICY consent_events_family_isolation ON learning.consent_events
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR EXISTS (
      SELECT 1 FROM learning.guardian_memberships membership
      WHERE membership.family_space_id = consent_events.family_space_id
        AND membership.guardian_id::text = current_setting('rhea.guardian_id', true)
        AND membership.status = 'active'
    )
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    OR EXISTS (
      SELECT 1 FROM learning.guardian_memberships membership
      WHERE membership.family_space_id = consent_events.family_space_id
        AND membership.guardian_id::text = current_setting('rhea.guardian_id', true)
        AND membership.status = 'active'
    )
  );
