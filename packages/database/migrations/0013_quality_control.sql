-- T09 quality-control authority. Immutable governance evidence is separated
-- from the small mutable release projections. All application writes are made
-- through the SECURITY DEFINER commands declared below.

CREATE TABLE metrics.quality_gate_policies (
  version text PRIMARY KEY CHECK (length(btrim(version)) BETWEEN 1 AND 200),
  minimum_sample_size integer NOT NULL CHECK (minimum_sample_size > 0),
  required_signoff_roles text[] NOT NULL,
  registered_at timestamptz NOT NULL,
  CHECK (
    required_signoff_roles @> ARRAY['quality_owner', 'domain_reviewer']::text[]
    AND (
      required_signoff_roles @> ARRAY['child_safety']::text[]
      OR required_signoff_roles @> ARRAY['compliance']::text[]
    )
    AND required_signoff_roles <@ ARRAY[
      'quality_owner', 'domain_reviewer', 'child_safety', 'compliance'
    ]::text[]
  )
);

CREATE TABLE metrics.gate_required_slices (
  policy_version text NOT NULL REFERENCES metrics.quality_gate_policies(version),
  slice_key text NOT NULL,
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  grade_band text NOT NULL CHECK (
    grade_band IN ('lower_primary', 'middle_primary', 'upper_primary')
  ),
  question_type text NOT NULL CHECK (
    question_type IN ('objective', 'open_response', 'process', 'oral', 'science_observation')
  ),
  image_quality text NOT NULL CHECK (image_quality IN ('clear', 'degraded', 'unusable')),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  basis_state text NOT NULL CHECK (basis_state IN ('current', 'conflicted', 'insufficient')),
  PRIMARY KEY (policy_version, slice_key),
  UNIQUE (
    policy_version, subject, grade_band, question_type,
    image_quality, risk_level, basis_state
  ),
  CHECK (
    slice_key = subject || ':' || grade_band || ':' || question_type || ':'
      || image_quality || ':' || risk_level || ':' || basis_state
  )
);

CREATE TABLE metrics.capability_versions (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  capability_key text NOT NULL CHECK (length(btrim(capability_key)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('ocr', 'ai')),
  implemented_by text NOT NULL CHECK (length(btrim(implemented_by)) BETWEEN 1 AND 200),
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) BETWEEN 1 AND 200),
  provider_version text NOT NULL CHECK (length(btrim(provider_version)) BETWEEN 1 AND 200),
  model_or_engine_id text NOT NULL CHECK (
    length(btrim(model_or_engine_id)) BETWEEN 1 AND 200
  ),
  model_or_engine_version text NOT NULL CHECK (
    length(btrim(model_or_engine_version)) BETWEEN 1 AND 200
  ),
  adapter_id text NOT NULL CHECK (length(btrim(adapter_id)) BETWEEN 1 AND 200),
  adapter_version text NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 200),
  prompt_or_config_kind text NOT NULL CHECK (prompt_or_config_kind IN ('prompt', 'config')),
  prompt_or_config_version text NOT NULL CHECK (
    length(btrim(prompt_or_config_version)) BETWEEN 1 AND 200
  ),
  template_version text NOT NULL CHECK (length(btrim(template_version)) BETWEEN 1 AND 200),
  policy_version text NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 200),
  required_slice_policy_version text NOT NULL
    REFERENCES metrics.quality_gate_policies(version),
  region text NOT NULL CHECK (length(btrim(region)) BETWEEN 1 AND 200),
  registered_at timestamptz NOT NULL,
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (id, capability_key),
  UNIQUE (id, capability_key, kind),
  UNIQUE (id, required_slice_policy_version),
  CHECK (
    (kind = 'ai' AND prompt_or_config_kind = 'prompt')
    OR (kind = 'ocr' AND prompt_or_config_kind = 'config')
  )
);

CREATE INDEX capability_versions_lookup_idx
  ON metrics.capability_versions (capability_key, kind, registered_at DESC, id);
CREATE INDEX capability_versions_provider_idx
  ON metrics.capability_versions (provider_id, provider_version, capability_key);
CREATE INDEX capability_versions_policy_idx
  ON metrics.capability_versions (required_slice_policy_version);

CREATE TABLE metrics.capability_aggregate_heads (
  capability_version_id text PRIMARY KEY REFERENCES metrics.capability_versions(id),
  revision integer NOT NULL CHECK (revision >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE metrics.evaluation_runs (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  capability_version_id text NOT NULL,
  policy_version text NOT NULL,
  subject text NOT NULL,
  grade_band text NOT NULL,
  question_type text NOT NULL,
  image_quality text NOT NULL,
  risk_level text NOT NULL,
  basis_state text NOT NULL,
  slice_key text NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL,
  UNIQUE (id, capability_version_id),
  UNIQUE (
    id, capability_version_id, policy_version, slice_key, evidence_hash
  ),
  FOREIGN KEY (capability_version_id, policy_version)
    REFERENCES metrics.capability_versions(id, required_slice_policy_version),
  FOREIGN KEY (policy_version, slice_key)
    REFERENCES metrics.gate_required_slices(policy_version, slice_key),
  CHECK (
    slice_key = subject || ':' || grade_band || ':' || question_type || ':'
      || image_quality || ':' || risk_level || ':' || basis_state
  )
);

CREATE INDEX evaluation_runs_latest_slice_idx
  ON metrics.evaluation_runs (
    capability_version_id, policy_version, slice_key, completed_at DESC, id DESC
  );

CREATE TABLE metrics.evaluation_slice_results (
  evaluation_run_id text PRIMARY KEY REFERENCES metrics.evaluation_runs(id),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object')
);

CREATE TABLE metrics.quality_card_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_version_id text NOT NULL REFERENCES metrics.capability_versions(id),
  policy_version text NOT NULL REFERENCES metrics.quality_gate_policies(version),
  revision integer NOT NULL CHECK (revision > 0),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('failed', 'incomplete', 'passed')),
  created_at timestamptz NOT NULL,
  UNIQUE (capability_version_id, revision),
  UNIQUE (id, capability_version_id, policy_version),
  UNIQUE (capability_version_id, policy_version, evidence_hash)
);

CREATE INDEX quality_card_revisions_latest_idx
  ON metrics.quality_card_revisions (capability_version_id, revision DESC);

CREATE TABLE metrics.quality_card_slice_results (
  quality_card_id uuid NOT NULL,
  capability_version_id text NOT NULL,
  policy_version text NOT NULL,
  slice_key text NOT NULL,
  evaluation_run_id text,
  evaluation_evidence_hash text CHECK (
    evaluation_evidence_hash IS NULL OR evaluation_evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  status text NOT NULL CHECK (
    status IN ('missing', 'insufficient_evidence', 'failed', 'passed')
  ),
  PRIMARY KEY (quality_card_id, slice_key),
  FOREIGN KEY (quality_card_id, capability_version_id, policy_version)
    REFERENCES metrics.quality_card_revisions(id, capability_version_id, policy_version),
  FOREIGN KEY (policy_version, slice_key)
    REFERENCES metrics.gate_required_slices(policy_version, slice_key),
  FOREIGN KEY (
    evaluation_run_id, capability_version_id, policy_version,
    slice_key, evaluation_evidence_hash
  ) REFERENCES metrics.evaluation_runs(
    id, capability_version_id, policy_version, slice_key, evidence_hash
  ),
  CHECK (
    (status = 'missing') = (evaluation_run_id IS NULL)
    AND (evaluation_run_id IS NULL) = (evaluation_evidence_hash IS NULL)
  )
);

CREATE INDEX quality_card_slice_results_run_idx
  ON metrics.quality_card_slice_results (evaluation_run_id)
  WHERE evaluation_run_id IS NOT NULL;

CREATE TABLE metrics.quality_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_version_id text NOT NULL REFERENCES metrics.capability_versions(id),
  quality_card_id uuid NOT NULL,
  policy_version text NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  signer_id text NOT NULL CHECK (length(btrim(signer_id)) BETWEEN 1 AND 200),
  signer_role text NOT NULL CHECK (
    signer_role IN ('quality_owner', 'domain_reviewer', 'child_safety', 'compliance')
  ),
  signed_at timestamptz NOT NULL,
  UNIQUE (quality_card_id, signer_role),
  UNIQUE (quality_card_id, signer_id),
  FOREIGN KEY (quality_card_id, capability_version_id, policy_version)
    REFERENCES metrics.quality_card_revisions(id, capability_version_id, policy_version)
);

CREATE INDEX quality_signoffs_capability_idx
  ON metrics.quality_signoffs (capability_version_id, quality_card_id);

CREATE TABLE metrics.quality_control_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  containment_epoch bigint NOT NULL CHECK (containment_epoch >= 0),
  updated_at timestamptz NOT NULL
);

INSERT INTO metrics.quality_control_epoch (singleton, containment_epoch, updated_at)
VALUES (true, 0, '-infinity'::timestamptz);

CREATE TABLE metrics.capability_release_revisions (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  capability_key text NOT NULL CHECK (length(btrim(capability_key)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('ocr', 'ai')),
  revision bigint NOT NULL CHECK (revision > 0),
  stage text NOT NULL CHECK (stage IN ('disabled', 'shadow', 'small', 'expanded', 'general')),
  capability_version_id text,
  fallback_version_id text,
  rollout_basis_points integer NOT NULL CHECK (
    rollout_basis_points BETWEEN 0 AND 10000
  ),
  allowed_use_slices jsonb NOT NULL CHECK (jsonb_typeof(allowed_use_slices) = 'array'),
  predecessor_id text,
  action text NOT NULL CHECK (
    action IN ('registered', 'advance', 'rollback', 'containment_fallback', 'containment_unavailable')
  ),
  reason_code text NOT NULL CHECK (length(btrim(reason_code)) BETWEEN 1 AND 200),
  changed_by text NOT NULL CHECK (length(btrim(changed_by)) BETWEEN 1 AND 200),
  changed_at timestamptz NOT NULL,
  UNIQUE (capability_key, kind, revision),
  UNIQUE (id, capability_key, kind),
  FOREIGN KEY (capability_version_id, capability_key, kind)
    REFERENCES metrics.capability_versions(id, capability_key, kind),
  FOREIGN KEY (fallback_version_id, capability_key, kind)
    REFERENCES metrics.capability_versions(id, capability_key, kind),
  FOREIGN KEY (predecessor_id, capability_key, kind)
    REFERENCES metrics.capability_release_revisions(id, capability_key, kind),
  CHECK (
    capability_version_id IS NULL OR fallback_version_id IS NULL
    OR capability_version_id IS DISTINCT FROM fallback_version_id
  ),
  CHECK (
    (stage = 'disabled' AND fallback_version_id IS NULL AND rollout_basis_points = 0)
    OR (stage = 'shadow' AND capability_version_id IS NOT NULL
      AND rollout_basis_points = 0)
    OR (stage = 'small' AND capability_version_id IS NOT NULL
      AND rollout_basis_points BETWEEN 1 AND 2499)
    OR (stage = 'expanded' AND capability_version_id IS NOT NULL
      AND rollout_basis_points BETWEEN 2500 AND 9999)
    OR (stage = 'general' AND capability_version_id IS NOT NULL
      AND rollout_basis_points = 10000)
  )
);

CREATE INDEX capability_release_history_idx
  ON metrics.capability_release_revisions (capability_key, kind, revision DESC);
CREATE INDEX capability_release_version_idx
  ON metrics.capability_release_revisions (capability_version_id, revision DESC);
CREATE INDEX capability_release_predecessor_idx
  ON metrics.capability_release_revisions (predecessor_id, capability_key, kind)
  WHERE predecessor_id IS NOT NULL;

CREATE TABLE metrics.capability_current_releases (
  capability_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ocr', 'ai')),
  primary_release_id text,
  shadow_release_id text,
  containment_epoch bigint NOT NULL CHECK (containment_epoch >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (capability_key, kind),
  FOREIGN KEY (primary_release_id, capability_key, kind)
    REFERENCES metrics.capability_release_revisions(id, capability_key, kind),
  FOREIGN KEY (shadow_release_id, capability_key, kind)
    REFERENCES metrics.capability_release_revisions(id, capability_key, kind),
  CHECK (primary_release_id IS DISTINCT FROM shadow_release_id)
);

CREATE TABLE metrics.capability_containments (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  epoch bigint NOT NULL UNIQUE CHECK (epoch > 0),
  target_kind text NOT NULL CHECK (target_kind IN ('capability_version', 'provider')),
  target_id text NOT NULL CHECK (length(btrim(target_id)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  contained_at timestamptz NOT NULL,
  UNIQUE (target_kind, target_id)
);

CREATE INDEX capability_containments_version_idx
  ON metrics.capability_containments (target_id)
  WHERE target_kind = 'capability_version';
CREATE INDEX capability_containments_provider_idx
  ON metrics.capability_containments (target_id)
  WHERE target_kind = 'provider';

CREATE TABLE metrics.authorization_decisions (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  capability_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ocr', 'ai')),
  family_space_hash text NOT NULL CHECK (family_space_hash ~ '^[0-9a-f]{64}$'),
  subject text NOT NULL CHECK (
    subject IN ('chinese', 'mathematics', 'english', 'science', 'unclassified')
  ),
  grade_band text NOT NULL CHECK (
    grade_band IN ('lower_primary', 'middle_primary', 'upper_primary', 'unclassified')
  ),
  question_type text NOT NULL CHECK (
    question_type IN (
      'objective', 'open_response', 'process', 'oral', 'science_observation', 'unclassified'
    )
  ),
  image_quality text NOT NULL CHECK (
    image_quality IN ('clear', 'degraded', 'unusable', 'not_applicable', 'unclassified')
  ),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'unclassified')),
  basis_state text NOT NULL CHECK (
    basis_state IN ('current', 'conflicted', 'insufficient', 'not_applicable', 'unclassified')
  ),
  rollout_bucket integer NOT NULL CHECK (rollout_bucket BETWEEN 0 AND 9999),
  containment_epoch bigint NOT NULL CHECK (containment_epoch >= 0),
  primary_release_id text,
  primary_version_id text,
  shadow_release_id text,
  shadow_version_id text,
  status text NOT NULL CHECK (status IN ('authorized', 'degraded')),
  degraded_reason text CHECK (
    degraded_reason IN (
      'CAPABILITY_CONTAINED', 'NO_APPLICABLE_CAPABILITY',
      'NO_SIGNED_CAPABILITY', 'OUTSIDE_ROLLOUT'
    )
  ),
  issued_at timestamptz NOT NULL,
  UNIQUE (id, containment_epoch),
  UNIQUE (id, primary_version_id, containment_epoch),
  UNIQUE (id, shadow_version_id, containment_epoch),
  UNIQUE (id, primary_version_id, containment_epoch, family_space_hash),
  UNIQUE (id, shadow_version_id, containment_epoch, family_space_hash),
  FOREIGN KEY (primary_release_id, capability_key, kind)
    REFERENCES metrics.capability_release_revisions(id, capability_key, kind),
  FOREIGN KEY (shadow_release_id, capability_key, kind)
    REFERENCES metrics.capability_release_revisions(id, capability_key, kind),
  FOREIGN KEY (primary_version_id, capability_key, kind)
    REFERENCES metrics.capability_versions(id, capability_key, kind),
  FOREIGN KEY (shadow_version_id, capability_key, kind)
    REFERENCES metrics.capability_versions(id, capability_key, kind),
  CHECK ((status = 'authorized') = (primary_version_id IS NOT NULL)),
  CHECK ((status = 'authorized') = (degraded_reason IS NULL)),
  CHECK (
    primary_version_id IS NULL OR shadow_version_id IS NULL
    OR primary_version_id IS DISTINCT FROM shadow_version_id
  )
);

CREATE INDEX authorization_decisions_lookup_idx
  ON metrics.authorization_decisions (capability_key, kind, containment_epoch, issued_at DESC);

CREATE TABLE metrics.authorization_revalidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id text NOT NULL REFERENCES metrics.authorization_decisions(id),
  containment_epoch bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('after_receive', 'before_publish', 'before_send')),
  route text NOT NULL CHECK (route IN ('primary', 'shadow')),
  status text NOT NULL CHECK (status IN ('authorized', 'rejected')),
  reason text CHECK (
    reason IN (
      'AUTHORIZATION_STALE', 'CAPABILITY_CONTAINED',
      'ROUTE_NOT_AUTHORIZED', 'SHADOW_PUBLICATION_FORBIDDEN'
    )
  ),
  capability_version_id text,
  checked_at timestamptz NOT NULL,
  CHECK ((status = 'authorized') = (capability_version_id IS NOT NULL)),
  CHECK ((status = 'authorized') = (reason IS NULL))
);

CREATE INDEX authorization_revalidations_decision_idx
  ON metrics.authorization_revalidations (authorization_id, checked_at DESC);

CREATE TABLE metrics.shadow_observations (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  authorization_id text NOT NULL,
  capability_version_id text NOT NULL,
  containment_epoch bigint NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_hash text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (authorization_id, capability_version_id, containment_epoch)
    REFERENCES metrics.authorization_decisions(id, shadow_version_id, containment_epoch)
);

CREATE INDEX shadow_observations_version_idx
  ON metrics.shadow_observations (capability_version_id, observed_at DESC);

CREATE TABLE metrics.quality_command_receipts (
  command_id text PRIMARY KEY CHECK (length(btrim(command_id)) BETWEEN 1 AND 200),
  command_type text NOT NULL,
  aggregate_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE metrics.quality_control_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]+\.v[1-9][0-9]*$'),
  aggregate_type text NOT NULL CHECK (length(btrim(aggregate_type)) > 0),
  aggregate_id text NOT NULL CHECK (length(btrim(aggregate_id)) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  published_at timestamptz
);

CREATE INDEX quality_control_outbox_pending_idx
  ON metrics.quality_control_outbox (occurred_at, id)
  WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION metrics.quality_numeric_metrics_only(p_metrics jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_typeof(p_metrics) = 'object'
    AND p_metrics <> '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_metrics) AS metric
      WHERE jsonb_typeof(metric.value) <> 'number'
         OR (metric.value #>> '{}')::numeric IN ('Infinity'::numeric, '-Infinity'::numeric)
    );
$$;

CREATE OR REPLACE FUNCTION metrics.quality_use_slices_valid(p_slices jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_typeof(p_slices) = 'array'
    AND jsonb_array_length(p_slices) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_slices) AS entry(value)
       WHERE jsonb_typeof(entry.value) <> 'object'
         OR NOT (entry.value ?& ARRAY[
           'subject', 'gradeBand', 'questionType', 'imageQuality', 'riskLevel', 'basisState'
         ]::text[])
         OR entry.value - ARRAY[
           'subject', 'gradeBand', 'questionType', 'imageQuality', 'riskLevel', 'basisState'
         ]::text[] <> '{}'::jsonb
         OR entry.value ->> 'subject' NOT IN (
           'chinese', 'mathematics', 'english', 'science', 'unclassified'
         )
         OR entry.value ->> 'gradeBand' NOT IN (
           'lower_primary', 'middle_primary', 'upper_primary', 'unclassified'
         )
         OR entry.value ->> 'questionType' NOT IN (
           'objective', 'open_response', 'process', 'oral', 'science_observation', 'unclassified'
         )
         OR entry.value ->> 'imageQuality' NOT IN (
           'clear', 'degraded', 'unusable', 'not_applicable', 'unclassified'
         )
         OR entry.value ->> 'riskLevel' NOT IN ('low', 'medium', 'high', 'unclassified')
         OR entry.value ->> 'basisState' NOT IN (
           'current', 'conflicted', 'insufficient', 'not_applicable', 'unclassified'
         )
    );
$$;

ALTER TABLE metrics.evaluation_slice_results
  ADD CONSTRAINT evaluation_slice_results_numeric_metrics
  CHECK (metrics.quality_numeric_metrics_only(metrics));
ALTER TABLE metrics.shadow_observations
  ADD CONSTRAINT shadow_observations_numeric_metrics
  CHECK (metrics.quality_numeric_metrics_only(metrics));
ALTER TABLE metrics.capability_release_revisions
  ADD CONSTRAINT capability_release_use_slices_valid
  CHECK (
    stage = 'disabled'
    OR metrics.quality_use_slices_valid(allowed_use_slices)
  );

CREATE OR REPLACE FUNCTION metrics.quality_reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, metrics
AS $$
BEGIN
  RAISE EXCEPTION 'quality-control evidence is append-only';
END;
$$;

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'quality_gate_policies', 'gate_required_slices', 'capability_versions',
    'evaluation_runs', 'evaluation_slice_results', 'quality_card_revisions',
    'quality_card_slice_results', 'quality_signoffs', 'capability_release_revisions',
    'capability_containments', 'authorization_decisions',
    'authorization_revalidations', 'shadow_observations', 'quality_command_receipts',
    'quality_control_outbox'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON metrics.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION metrics.quality_reject_evidence_mutation()',
      target_table,
      target_table
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION metrics.quality_lock_command(
  p_command_id text,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  receipt metrics.quality_command_receipts%ROWTYPE;
BEGIN
  IF length(btrim(p_command_id)) NOT BETWEEN 1 AND 200
     OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid quality command identity';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id, 0));
  SELECT * INTO receipt
  FROM metrics.quality_command_receipts
  WHERE command_id = p_command_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF receipt.fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'quality command id reused with different intent';
  END IF;
  RETURN receipt.result;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.quality_finish_command(
  p_command_id text,
  p_command_type text,
  p_aggregate_id text,
  p_fingerprint text,
  p_result jsonb,
  p_event_type text,
  p_recorded_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, metrics
AS $$
BEGIN
  INSERT INTO metrics.quality_command_receipts (
    command_id, command_type, aggregate_id, fingerprint, result, recorded_at
  ) VALUES (
    p_command_id, p_command_type, p_aggregate_id, p_fingerprint, p_result, p_recorded_at
  );
  INSERT INTO metrics.quality_control_outbox (
    event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    p_event_type, p_command_type, p_aggregate_id, p_result, p_recorded_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION metrics.quality_slice_key(p_slice jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, metrics
AS $$
  SELECT (p_slice ->> 'subject') || ':' || (p_slice ->> 'gradeBand') || ':'
    || (p_slice ->> 'questionType') || ':' || (p_slice ->> 'imageQuality') || ':'
    || (p_slice ->> 'riskLevel') || ':' || (p_slice ->> 'basisState');
$$;

CREATE OR REPLACE FUNCTION metrics.create_quality_slice_policy(
  p_policy jsonb,
  p_command_id text,
  p_fingerprint text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  policy_version text := p_policy ->> 'version';
  minimum_samples integer;
  registered_at timestamptz;
  required_roles text[];
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  IF EXISTS (
    SELECT 1 FROM metrics.quality_gate_policies WHERE version = policy_version
  ) THEN
    RETURN 'conflict';
  END IF;
  IF jsonb_typeof(p_policy -> 'requiredSlices') <> 'array'
     OR jsonb_array_length(p_policy -> 'requiredSlices') = 0
     OR jsonb_typeof(p_policy -> 'requiredSignoffRoles') <> 'array' THEN
    RAISE EXCEPTION 'required slice policy is malformed';
  END IF;
  minimum_samples := (p_policy ->> 'minimumSampleSize')::integer;
  registered_at := (p_policy ->> 'registeredAt')::timestamptz;
  SELECT array_agg(role ORDER BY role) INTO required_roles
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(p_policy -> 'requiredSignoffRoles') AS role
  ) AS roles;
  IF cardinality(required_roles) <> jsonb_array_length(p_policy -> 'requiredSignoffRoles') THEN
    RAISE EXCEPTION 'required signoff roles must be unique';
  END IF;
  IF EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['chinese', 'mathematics', 'english', 'science']) AS required_value
    EXCEPT SELECT slice ->> 'subject'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) OR EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['lower_primary', 'middle_primary', 'upper_primary']) AS required_value
    EXCEPT SELECT slice ->> 'gradeBand'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) OR EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['objective', 'open_response', 'process', 'oral', 'science_observation'])
      AS required_value
    EXCEPT SELECT slice ->> 'questionType'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) OR EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['clear', 'degraded', 'unusable']) AS required_value
    EXCEPT SELECT slice ->> 'imageQuality'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) OR EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['low', 'medium', 'high']) AS required_value
    EXCEPT SELECT slice ->> 'riskLevel'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) OR EXISTS (
    SELECT required_value
    FROM unnest(ARRAY['current', 'conflicted', 'insufficient']) AS required_value
    EXCEPT SELECT slice ->> 'basisState'
      FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) THEN
    RAISE EXCEPTION 'required slice policy does not cover every protected dimension';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT metrics.quality_slice_key(slice))
    FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice
  ) THEN
    RAISE EXCEPTION 'required evaluation slices must be unique';
  END IF;

  INSERT INTO metrics.quality_gate_policies (
    version, minimum_sample_size, required_signoff_roles, registered_at
  ) VALUES (policy_version, minimum_samples, required_roles, registered_at);
  INSERT INTO metrics.gate_required_slices (
    policy_version, slice_key, subject, grade_band, question_type,
    image_quality, risk_level, basis_state
  )
  SELECT
    policy_version,
    metrics.quality_slice_key(slice),
    slice ->> 'subject',
    slice ->> 'gradeBand',
    slice ->> 'questionType',
    slice ->> 'imageQuality',
    slice ->> 'riskLevel',
    slice ->> 'basisState'
  FROM jsonb_array_elements(p_policy -> 'requiredSlices') AS slice;

  result := jsonb_build_object('status', 'created', 'aggregateId', policy_version);
  PERFORM metrics.quality_finish_command(
    p_command_id, 'slice_policy', policy_version, p_fingerprint, result,
    'quality.slice-policy-registered.v1', registered_at
  );
  RETURN 'created';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.create_quality_capability(
  p_record jsonb,
  p_command_id text,
  p_fingerprint text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  version jsonb := p_record -> 'version';
  version_id text := version ->> 'id';
  registered_at timestamptz;
  release_revision bigint;
  release_id text := gen_random_uuid()::text;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    (version ->> 'capabilityKey') || ':' || (version ->> 'kind'), 0
  ));
  IF EXISTS (SELECT 1 FROM metrics.capability_versions WHERE id = version_id) THEN
    RETURN 'conflict';
  END IF;
  IF (p_record ->> 'revision')::integer <> 0
     OR p_record -> 'evaluationRuns' <> '[]'::jsonb
     OR p_record -> 'signoffs' <> '[]'::jsonb
     OR p_record #>> '{rollout,stage}' <> 'disabled'
     OR (p_record #>> '{rollout,percentage}')::integer <> 0
     OR p_record #> '{rollout,allowedUseSlices}' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'new capability aggregate must start empty at revision zero';
  END IF;
  registered_at := (version ->> 'registeredAt')::timestamptz;

  INSERT INTO metrics.capability_versions (
    id, capability_key, kind, implemented_by, provider_id, provider_version,
    model_or_engine_id, model_or_engine_version, adapter_id, adapter_version,
    prompt_or_config_kind, prompt_or_config_version, template_version,
    policy_version, required_slice_policy_version, region, registered_at, artifact_hash
  ) VALUES (
    version_id,
    version ->> 'capabilityKey',
    version ->> 'kind',
    version ->> 'implementedBy',
    version #>> '{provider,id}',
    version #>> '{provider,version}',
    version #>> '{modelOrEngine,id}',
    version #>> '{modelOrEngine,version}',
    version #>> '{adapter,id}',
    version #>> '{adapter,version}',
    version #>> '{promptOrConfig,kind}',
    version #>> '{promptOrConfig,version}',
    version ->> 'templateVersion',
    version ->> 'policyVersion',
    version ->> 'requiredSlicePolicyVersion',
    version ->> 'region',
    registered_at,
    version ->> 'artifactHash'
  );
  INSERT INTO metrics.capability_aggregate_heads (
    capability_version_id, revision, updated_at
  ) VALUES (version_id, 0, registered_at);
  SELECT COALESCE(max(revision), 0) + 1 INTO release_revision
  FROM metrics.capability_release_revisions
  WHERE capability_key = version ->> 'capabilityKey'
    AND kind = version ->> 'kind';
  INSERT INTO metrics.capability_release_revisions (
    id, capability_key, kind, revision, stage, capability_version_id,
    fallback_version_id, rollout_basis_points, allowed_use_slices,
    predecessor_id, action, reason_code, changed_by, changed_at
  ) VALUES (
    release_id, version ->> 'capabilityKey', version ->> 'kind', release_revision,
    'disabled', version_id, NULL, 0, '[]'::jsonb, NULL, 'registered',
    'capability_registered', version ->> 'implementedBy', registered_at
  );

  result := jsonb_build_object('status', 'created', 'aggregateId', version_id);
  PERFORM metrics.quality_finish_command(
    p_command_id, 'capability_version', version_id, p_fingerprint, result,
    'quality.capability-version-registered.v1', registered_at
  );
  RETURN 'created';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.read_quality_slice_policy(p_version text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'version', policy.version,
    'minimumSampleSize', policy.minimum_sample_size,
    'requiredSignoffRoles', to_jsonb(policy.required_signoff_roles),
    'registeredAt', to_jsonb(policy.registered_at),
    'requiredSlices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'subject', slice.subject,
        'gradeBand', slice.grade_band,
        'questionType', slice.question_type,
        'imageQuality', slice.image_quality,
        'riskLevel', slice.risk_level,
        'basisState', slice.basis_state
      ) ORDER BY slice.slice_key)
      FROM metrics.gate_required_slices AS slice
      WHERE slice.policy_version = policy.version
    ), '[]'::jsonb)
  )
  FROM metrics.quality_gate_policies AS policy
  WHERE policy.version = p_version;
$$;

CREATE OR REPLACE FUNCTION metrics.read_quality_capability(p_capability_version_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'version', jsonb_build_object(
      'id', version.id,
      'capabilityKey', version.capability_key,
      'kind', version.kind,
      'implementedBy', version.implemented_by,
      'provider', jsonb_build_object('id', version.provider_id, 'version', version.provider_version),
      'modelOrEngine', jsonb_build_object(
        'id', version.model_or_engine_id, 'version', version.model_or_engine_version
      ),
      'adapter', jsonb_build_object('id', version.adapter_id, 'version', version.adapter_version),
      'promptOrConfig', jsonb_build_object(
        'kind', version.prompt_or_config_kind, 'version', version.prompt_or_config_version
      ),
      'templateVersion', version.template_version,
      'policyVersion', version.policy_version,
      'requiredSlicePolicyVersion', version.required_slice_policy_version,
      'region', version.region,
      'registeredAt', to_jsonb(version.registered_at),
      'artifactHash', version.artifact_hash
    ),
    'revision', head.revision,
    'rollout', (
      SELECT jsonb_build_object(
        'stage', release.stage,
        'percentage', release.rollout_basis_points / 100,
        'allowedUseSlices', release.allowed_use_slices,
        'updatedAt', to_jsonb(release.changed_at)
      )
      FROM metrics.capability_release_revisions AS release
      WHERE release.capability_version_id = version.id
      ORDER BY release.revision DESC
      LIMIT 1
    ),
    'evaluationRuns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', run.id,
        'capabilityVersionId', run.capability_version_id,
        'policyVersion', run.policy_version,
        'slice', jsonb_build_object(
          'subject', run.subject,
          'gradeBand', run.grade_band,
          'questionType', run.question_type,
          'imageQuality', run.image_quality,
          'riskLevel', run.risk_level,
          'basisState', run.basis_state
        ),
        'sampleSize', slice_result.sample_size,
        'outcome', slice_result.outcome,
        'metrics', slice_result.metrics,
        'evidenceHash', run.evidence_hash,
        'completedAt', to_jsonb(run.completed_at)
      ) ORDER BY run.completed_at, run.id)
      FROM metrics.evaluation_runs AS run
      JOIN metrics.evaluation_slice_results AS slice_result
        ON slice_result.evaluation_run_id = run.id
      WHERE run.capability_version_id = version.id
    ), '[]'::jsonb),
    'signoffs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'evidenceHash', signoff.evidence_hash,
        'policyVersion', signoff.policy_version,
        'signedAt', to_jsonb(signoff.signed_at),
        'signer', jsonb_build_object('id', signoff.signer_id, 'role', signoff.signer_role)
      ) ORDER BY signoff.signed_at, signoff.id)
      FROM metrics.quality_signoffs AS signoff
      WHERE signoff.capability_version_id = version.id
    ), '[]'::jsonb)
  )
  FROM metrics.capability_versions AS version
  JOIN metrics.capability_aggregate_heads AS head
    ON head.capability_version_id = version.id
  WHERE version.id = p_capability_version_id;
$$;

CREATE OR REPLACE FUNCTION metrics.read_quality_command(p_command_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'aggregateId', receipt.aggregate_id,
    'commandId', receipt.command_id,
    'fingerprint', receipt.fingerprint
  )
  FROM metrics.quality_command_receipts AS receipt
  WHERE receipt.command_id = p_command_id;
$$;

CREATE OR REPLACE FUNCTION metrics.append_quality_evaluation(
  p_run jsonb,
  p_quality_card jsonb,
  p_expected_revision integer,
  p_command_id text,
  p_fingerprint text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  capability_id text := p_run ->> 'capabilityVersionId';
  run_id text := p_run ->> 'id';
  selected_policy_version text := p_run ->> 'policyVersion';
  run_slice jsonb := p_run -> 'slice';
  run_slice_key text;
  head_revision integer;
  card_status text;
  card_revision integer;
  card_id uuid;
  run_completed_at timestamptz;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  SELECT revision INTO head_revision
  FROM metrics.capability_aggregate_heads
  WHERE capability_version_id = capability_id
  FOR UPDATE;
  IF NOT FOUND OR head_revision <> p_expected_revision THEN
    RETURN 'conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM metrics.evaluation_runs WHERE id = run_id) THEN
    RETURN 'conflict';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM metrics.capability_versions
    WHERE id = capability_id AND required_slice_policy_version = selected_policy_version
  ) THEN
    RAISE EXCEPTION 'evaluation policy does not match capability version';
  END IF;
  run_slice_key := metrics.quality_slice_key(run_slice);
  IF NOT EXISTS (
    SELECT 1 FROM metrics.gate_required_slices
    WHERE gate_required_slices.policy_version = selected_policy_version
      AND slice_key = run_slice_key
      AND subject = run_slice ->> 'subject'
      AND grade_band = run_slice ->> 'gradeBand'
      AND question_type = run_slice ->> 'questionType'
      AND image_quality = run_slice ->> 'imageQuality'
      AND risk_level = run_slice ->> 'riskLevel'
      AND basis_state = run_slice ->> 'basisState'
  ) THEN
    RAISE EXCEPTION 'evaluation slice is not required by policy';
  END IF;
  IF (p_run ->> 'evidenceHash') !~ '^[0-9a-f]{64}$'
     OR NOT metrics.quality_numeric_metrics_only(p_run -> 'metrics') THEN
    RAISE EXCEPTION 'evaluation evidence is invalid';
  END IF;
  run_completed_at := (p_run ->> 'completedAt')::timestamptz;
  IF EXISTS (
    SELECT 1
    FROM metrics.evaluation_runs AS existing_run
    WHERE existing_run.capability_version_id = capability_id
      AND existing_run.policy_version = selected_policy_version
      AND existing_run.slice_key = run_slice_key
      AND existing_run.completed_at >= run_completed_at
  ) THEN
    RAISE EXCEPTION 'evaluation slice timestamps must increase strictly';
  END IF;

  INSERT INTO metrics.evaluation_runs (
    id, capability_version_id, policy_version, subject, grade_band,
    question_type, image_quality, risk_level, basis_state, slice_key,
    evidence_hash, completed_at
  ) VALUES (
    run_id, capability_id, selected_policy_version,
    run_slice ->> 'subject', run_slice ->> 'gradeBand',
    run_slice ->> 'questionType', run_slice ->> 'imageQuality',
    run_slice ->> 'riskLevel', run_slice ->> 'basisState', run_slice_key,
    p_run ->> 'evidenceHash', run_completed_at
  );
  INSERT INTO metrics.evaluation_slice_results (
    evaluation_run_id, sample_size, outcome, metrics
  ) VALUES (
    run_id, (p_run ->> 'sampleSize')::integer, p_run ->> 'outcome', p_run -> 'metrics'
  );

  IF p_quality_card ->> 'capabilityVersionId' <> capability_id
     OR p_quality_card ->> 'policyVersion' <> selected_policy_version
     OR (p_quality_card ->> 'evidenceHash') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_quality_card -> 'slices') <> 'array' THEN
    RAISE EXCEPTION 'quality card identity is invalid';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_quality_card -> 'slices')
  ) <> (
    SELECT count(*) FROM metrics.gate_required_slices
    WHERE gate_required_slices.policy_version = selected_policy_version
  ) OR (
    SELECT count(DISTINCT metrics.quality_slice_key(card_slice -> 'slice'))
    FROM jsonb_array_elements(p_quality_card -> 'slices') AS card_slice
  ) <> (
    SELECT count(*) FROM metrics.gate_required_slices
    WHERE gate_required_slices.policy_version = selected_policy_version
  ) THEN
    RAISE EXCEPTION 'quality card must contain each required slice exactly once';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        required_slice.slice_key,
        latest.run_id,
        latest.evidence_hash,
        CASE
          WHEN latest.run_id IS NULL THEN 'missing'
          WHEN latest.sample_size < policy.minimum_sample_size THEN 'insufficient_evidence'
          WHEN latest.outcome = 'failed' THEN 'failed'
          ELSE 'passed'
        END AS status
      FROM metrics.gate_required_slices AS required_slice
      JOIN metrics.quality_gate_policies AS policy
        ON policy.version = required_slice.policy_version
      LEFT JOIN LATERAL (
        SELECT run.id AS run_id, run.evidence_hash, slice_result.sample_size, slice_result.outcome
        FROM metrics.evaluation_runs AS run
        JOIN metrics.evaluation_slice_results AS slice_result
          ON slice_result.evaluation_run_id = run.id
        WHERE run.capability_version_id = capability_id
          AND run.policy_version = selected_policy_version
          AND run.slice_key = required_slice.slice_key
        ORDER BY run.completed_at DESC, run.id DESC
        LIMIT 1
      ) AS latest ON true
      WHERE required_slice.policy_version = selected_policy_version
    )
    SELECT 1
    FROM expected
    LEFT JOIN LATERAL (
      SELECT
        card_slice ->> 'evaluationRunId' AS evaluation_run_id,
        card_slice ->> 'evaluationEvidenceHash' AS evaluation_evidence_hash,
        card_slice ->> 'status' AS status
      FROM jsonb_array_elements(p_quality_card -> 'slices') AS card_slice
      WHERE metrics.quality_slice_key(card_slice -> 'slice') = expected.slice_key
    ) AS supplied ON true
    WHERE supplied.status IS DISTINCT FROM expected.status
       OR supplied.evaluation_run_id IS DISTINCT FROM expected.run_id
       OR supplied.evaluation_evidence_hash IS DISTINCT FROM expected.evidence_hash
  ) THEN
    RAISE EXCEPTION 'quality card is not the current fail-closed slice projection';
  END IF;

  SELECT CASE
    WHEN bool_or(expected.status = 'failed') THEN 'failed'
    WHEN bool_and(expected.status = 'passed') THEN 'passed'
    ELSE 'incomplete'
  END INTO card_status
  FROM (
    SELECT CASE
      WHEN latest.run_id IS NULL THEN 'missing'
      WHEN latest.sample_size < policy.minimum_sample_size THEN 'insufficient_evidence'
      WHEN latest.outcome = 'failed' THEN 'failed'
      ELSE 'passed'
    END AS status
    FROM metrics.gate_required_slices AS required_slice
    JOIN metrics.quality_gate_policies AS policy
      ON policy.version = required_slice.policy_version
    LEFT JOIN LATERAL (
      SELECT run.id AS run_id, slice_result.sample_size, slice_result.outcome
      FROM metrics.evaluation_runs AS run
      JOIN metrics.evaluation_slice_results AS slice_result
        ON slice_result.evaluation_run_id = run.id
      WHERE run.capability_version_id = capability_id
        AND run.policy_version = selected_policy_version
        AND run.slice_key = required_slice.slice_key
      ORDER BY run.completed_at DESC, run.id DESC
      LIMIT 1
    ) AS latest ON true
    WHERE required_slice.policy_version = selected_policy_version
  ) AS expected;
  IF p_quality_card ->> 'status' <> card_status THEN
    RAISE EXCEPTION 'quality card status does not match current evaluation evidence';
  END IF;

  SELECT COALESCE(max(revision), 0) + 1 INTO card_revision
  FROM metrics.quality_card_revisions
  WHERE capability_version_id = capability_id;
  INSERT INTO metrics.quality_card_revisions (
    capability_version_id, policy_version, revision, evidence_hash, status, created_at
  ) VALUES (
    capability_id, selected_policy_version, card_revision,
    p_quality_card ->> 'evidenceHash', card_status, run_completed_at
  ) RETURNING id INTO card_id;
  INSERT INTO metrics.quality_card_slice_results (
    quality_card_id, capability_version_id, policy_version, slice_key,
    evaluation_run_id, evaluation_evidence_hash, status
  )
  SELECT
    card_id, capability_id, selected_policy_version,
    metrics.quality_slice_key(card_slice -> 'slice'),
    NULLIF(card_slice ->> 'evaluationRunId', ''),
    NULLIF(card_slice ->> 'evaluationEvidenceHash', ''),
    card_slice ->> 'status'
  FROM jsonb_array_elements(p_quality_card -> 'slices') AS card_slice;

  UPDATE metrics.capability_aggregate_heads
  SET revision = p_expected_revision + 1, updated_at = run_completed_at
  WHERE capability_version_id = capability_id;
  result := jsonb_build_object(
    'status', 'saved', 'aggregateId', capability_id,
    'revision', p_expected_revision + 1, 'qualityCardId', card_id,
    'qualityCardEvidenceHash', p_quality_card ->> 'evidenceHash'
  );
  PERFORM metrics.quality_finish_command(
    p_command_id, 'evaluation', capability_id, p_fingerprint, result,
    'quality.evaluation-recorded.v1', run_completed_at
  );
  RETURN 'saved';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.append_quality_signoff(
  p_capability_version_id text,
  p_signoff jsonb,
  p_expected_revision integer,
  p_command_id text,
  p_fingerprint text,
  p_actor_id text,
  p_actor_role text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  head_revision integer;
  latest_card metrics.quality_card_revisions%ROWTYPE;
  implemented_by text;
  signed_at timestamptz;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  SELECT head.revision, version.implemented_by
  INTO head_revision, implemented_by
  FROM metrics.capability_aggregate_heads AS head
  JOIN metrics.capability_versions AS version
    ON version.id = head.capability_version_id
  WHERE head.capability_version_id = p_capability_version_id
  FOR UPDATE OF head;
  IF NOT FOUND OR head_revision <> p_expected_revision THEN
    RETURN 'conflict';
  END IF;
  IF p_actor_id IS DISTINCT FROM p_signoff #>> '{signer,id}'
     OR p_actor_role IS DISTINCT FROM p_signoff #>> '{signer,role}' THEN
    RAISE EXCEPTION 'signoff actor identity and responsibility do not match';
  END IF;
  IF p_actor_id = implemented_by THEN
    RAISE EXCEPTION 'capability implementer cannot sign their own version';
  END IF;
  SELECT * INTO latest_card
  FROM metrics.quality_card_revisions
  WHERE capability_version_id = p_capability_version_id
  ORDER BY revision DESC
  LIMIT 1;
  IF NOT FOUND OR latest_card.status <> 'passed'
     OR latest_card.evidence_hash <> p_signoff ->> 'evidenceHash'
     OR latest_card.policy_version <> p_signoff ->> 'policyVersion' THEN
    RAISE EXCEPTION 'signoff evidence is not the current passed quality card';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM metrics.quality_gate_policies AS policy
    WHERE policy.version = latest_card.policy_version
      AND p_actor_role = ANY(policy.required_signoff_roles)
  ) THEN
    RAISE EXCEPTION 'signoff responsibility is not required by policy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM metrics.quality_signoffs AS signoff
    WHERE signoff.quality_card_id = latest_card.id
      AND (signoff.signer_id = p_actor_id OR signoff.signer_role = p_actor_role)
  ) THEN
    RAISE EXCEPTION 'signoff duties and signer identities must be distinct';
  END IF;
  signed_at := (p_signoff ->> 'signedAt')::timestamptz;
  INSERT INTO metrics.quality_signoffs (
    capability_version_id, quality_card_id, policy_version, evidence_hash,
    signer_id, signer_role, signed_at
  ) VALUES (
    p_capability_version_id, latest_card.id, latest_card.policy_version,
    latest_card.evidence_hash, p_actor_id, p_actor_role, signed_at
  );
  UPDATE metrics.capability_aggregate_heads
  SET revision = p_expected_revision + 1, updated_at = signed_at
  WHERE capability_version_id = p_capability_version_id;

  result := jsonb_build_object(
    'status', 'saved', 'aggregateId', p_capability_version_id,
    'revision', p_expected_revision + 1,
    'qualityCardEvidenceHash', latest_card.evidence_hash,
    'signerId', p_actor_id, 'signerRole', p_actor_role
  );
  PERFORM metrics.quality_finish_command(
    p_command_id, 'signoff', p_capability_version_id, p_fingerprint, result,
    'quality.capability-signed.v1', signed_at
  );
  RETURN 'saved';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.quality_version_is_signed(
  p_capability_version_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, metrics
AS $$
  WITH latest_card AS (
    SELECT card.*
    FROM metrics.quality_card_revisions AS card
    WHERE card.capability_version_id = p_capability_version_id
    ORDER BY card.revision DESC
    LIMIT 1
  )
  SELECT EXISTS (
    SELECT 1
    FROM latest_card AS card
    JOIN metrics.quality_gate_policies AS policy
      ON policy.version = card.policy_version
    WHERE card.status = 'passed'
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(policy.required_signoff_roles) AS required_role(role)
        WHERE NOT EXISTS (
          SELECT 1
          FROM metrics.quality_signoffs AS signoff
          WHERE signoff.quality_card_id = card.id
            AND signoff.signer_role = required_role.role
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION metrics.quality_use_slice_allowed(
  p_allowed_use_slices jsonb,
  p_subject text,
  p_grade_band text,
  p_question_type text,
  p_image_quality text,
  p_risk_level text,
  p_basis_state text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, metrics
AS $$
  SELECT p_allowed_use_slices @> jsonb_build_array(jsonb_build_object(
    'subject', p_subject,
    'gradeBand', p_grade_band,
    'questionType', p_question_type,
    'imageQuality', p_image_quality,
    'riskLevel', p_risk_level,
    'basisState', p_basis_state
  ));
$$;

CREATE OR REPLACE FUNCTION metrics.advance_quality_rollout(
  p_capability_version_id text,
  p_rollout jsonb,
  p_expected_revision integer,
  p_command_id text,
  p_fingerprint text,
  p_changed_by text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  head_revision integer;
  version metrics.capability_versions%ROWTYPE;
  previous metrics.capability_release_revisions%ROWTYPE;
  current_projection metrics.capability_current_releases%ROWTYPE;
  next_revision bigint;
  next_release_id text := gen_random_uuid()::text;
  next_stage text := p_rollout ->> 'stage';
  next_percentage integer := (p_rollout ->> 'percentage')::integer;
  next_slices jsonb := p_rollout -> 'allowedUseSlices';
  current_epoch bigint;
  selected_capability_key text;
  selected_capability_kind text;
  fallback_version text;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  SELECT capability_key, kind INTO selected_capability_key, selected_capability_kind
  FROM metrics.capability_versions
  WHERE id = p_capability_version_id;
  IF NOT FOUND THEN
    RETURN 'conflict';
  END IF;
  SELECT containment_epoch INTO current_epoch
  FROM metrics.quality_control_epoch WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_capability_key || ':' || selected_capability_kind, 0
  ));
  SELECT head.revision INTO head_revision
  FROM metrics.capability_aggregate_heads AS head
  JOIN metrics.capability_versions AS capability
    ON capability.id = head.capability_version_id
  WHERE head.capability_version_id = p_capability_version_id
  FOR UPDATE OF head;
  IF NOT FOUND OR head_revision <> p_expected_revision THEN
    RETURN 'conflict';
  END IF;
  SELECT * INTO version
  FROM metrics.capability_versions
  WHERE id = p_capability_version_id;
  IF NOT metrics.quality_version_is_signed(p_capability_version_id) THEN
    RAISE EXCEPTION 'only a currently signed capability may advance rollout';
  END IF;
  IF NOT metrics.quality_use_slices_valid(next_slices)
     OR (
       SELECT count(*) <> count(DISTINCT entry)
       FROM jsonb_array_elements(next_slices) AS entry
     ) THEN
    RAISE EXCEPTION 'rollout use slices must be valid and unique';
  END IF;

  SELECT * INTO previous
  FROM metrics.capability_release_revisions
  WHERE capability_version_id = p_capability_version_id
  ORDER BY revision DESC
  LIMIT 1;
  IF NOT FOUND
     OR NOT (
       (previous.stage = 'disabled' AND next_stage = 'shadow' AND next_percentage = 0)
       OR (previous.stage = 'shadow' AND next_stage = 'small'
         AND next_percentage BETWEEN 1 AND 10)
       OR (previous.stage = 'small' AND next_stage = 'expanded'
         AND next_percentage BETWEEN 11 AND 99 AND next_percentage > previous.rollout_basis_points / 100)
       OR (previous.stage = 'expanded' AND next_stage = 'general' AND next_percentage = 100)
     ) THEN
    RAISE EXCEPTION 'rollout transition or percentage is invalid';
  END IF;
  IF previous.stage <> 'disabled'
     AND NOT (
       SELECT count(*) = 0
       FROM (
         (SELECT value FROM jsonb_array_elements(previous.allowed_use_slices)
          EXCEPT SELECT value FROM jsonb_array_elements(next_slices))
         UNION ALL
         (SELECT value FROM jsonb_array_elements(next_slices)
          EXCEPT SELECT value FROM jsonb_array_elements(previous.allowed_use_slices))
       ) AS difference
     ) THEN
    RAISE EXCEPTION 'rollout scope cannot change after shadow begins';
  END IF;

  SELECT * INTO current_projection
  FROM metrics.capability_current_releases
  WHERE capability_key = version.capability_key AND kind = version.kind
  FOR UPDATE;

  IF next_stage = 'shadow' THEN
    IF current_projection.shadow_release_id IS NOT NULL THEN
      RAISE EXCEPTION 'another shadow release is already active';
    END IF;
    fallback_version := NULL;
  ELSE
    IF previous.stage = 'shadow'
       AND current_projection.shadow_release_id IS DISTINCT FROM previous.id THEN
      RAISE EXCEPTION 'capability is no longer the current shadow route';
    END IF;
    IF previous.stage = 'shadow' AND current_projection.primary_release_id IS NOT NULL THEN
      SELECT release.capability_version_id INTO fallback_version
      FROM metrics.capability_release_revisions AS release
      WHERE release.id = current_projection.primary_release_id;
    ELSE
      fallback_version := previous.fallback_version_id;
    END IF;
  END IF;

  SELECT COALESCE(max(revision), 0) + 1 INTO next_revision
  FROM metrics.capability_release_revisions
  WHERE capability_key = version.capability_key AND kind = version.kind;
  INSERT INTO metrics.capability_release_revisions (
    id, capability_key, kind, revision, stage, capability_version_id,
    fallback_version_id, rollout_basis_points, allowed_use_slices,
    predecessor_id, action, reason_code, changed_by, changed_at
  ) VALUES (
    next_release_id, version.capability_key, version.kind, next_revision,
    next_stage, p_capability_version_id, fallback_version, next_percentage * 100,
    next_slices, previous.id, 'advance', 'staged_rollout_advanced',
    p_changed_by, (p_rollout ->> 'updatedAt')::timestamptz
  );

  IF next_stage = 'shadow' THEN
    INSERT INTO metrics.capability_current_releases (
      capability_key, kind, primary_release_id, shadow_release_id,
      containment_epoch, updated_at
    ) VALUES (
      version.capability_key, version.kind, NULL, next_release_id,
      current_epoch, (p_rollout ->> 'updatedAt')::timestamptz
    ) ON CONFLICT (capability_key, kind) DO UPDATE SET
      shadow_release_id = EXCLUDED.shadow_release_id,
      containment_epoch = EXCLUDED.containment_epoch,
      updated_at = EXCLUDED.updated_at;
  ELSE
    UPDATE metrics.capability_current_releases SET
      primary_release_id = next_release_id,
      shadow_release_id = NULL,
      containment_epoch = current_epoch,
      updated_at = (p_rollout ->> 'updatedAt')::timestamptz
    WHERE capability_key = version.capability_key AND kind = version.kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollout projection is missing';
    END IF;
  END IF;

  UPDATE metrics.capability_aggregate_heads
  SET revision = p_expected_revision + 1,
      updated_at = (p_rollout ->> 'updatedAt')::timestamptz
  WHERE capability_version_id = p_capability_version_id;
  result := jsonb_build_object(
    'status', 'saved', 'aggregateId', p_capability_version_id,
    'revision', p_expected_revision + 1, 'releaseRevisionId', next_release_id,
    'stage', next_stage, 'containmentEpoch', current_epoch
  );
  PERFORM metrics.quality_finish_command(
    p_command_id, 'rollout', p_capability_version_id, p_fingerprint, result,
    'quality.rollout-advanced.v1', (p_rollout ->> 'updatedAt')::timestamptz
  );
  RETURN 'saved';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.list_quality_capabilities(
  p_capability_key text,
  p_kind text
)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT metrics.read_quality_capability(version.id)
  FROM metrics.capability_versions AS version
  WHERE version.capability_key = p_capability_key AND version.kind = p_kind
  ORDER BY version.registered_at DESC, version.id DESC;
$$;

CREATE OR REPLACE FUNCTION metrics.quality_version_is_contained(
  p_capability_version_id text,
  p_subject text,
  p_grade_band text,
  p_question_type text,
  p_image_quality text,
  p_risk_level text,
  p_basis_state text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, metrics
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM metrics.capability_versions AS version
    JOIN metrics.capability_containments AS containment
      ON (containment.target_kind = 'capability_version' AND containment.target_id = version.id)
      OR (containment.target_kind = 'provider' AND containment.target_id = version.provider_id)
    WHERE version.id = p_capability_version_id
  );
$$;

CREATE OR REPLACE FUNCTION metrics.quality_release_is_applicable(
  p_release_id text,
  p_subject text,
  p_grade_band text,
  p_question_type text,
  p_image_quality text,
  p_risk_level text,
  p_basis_state text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, metrics
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM metrics.capability_release_revisions AS release
    WHERE release.id = p_release_id
      AND release.stage <> 'disabled'
      AND metrics.quality_version_is_signed(release.capability_version_id)
      AND metrics.quality_use_slice_allowed(
        release.allowed_use_slices, p_subject, p_grade_band, p_question_type,
        p_image_quality, p_risk_level, p_basis_state
      )
      AND NOT metrics.quality_version_is_contained(
        release.capability_version_id, p_subject, p_grade_band, p_question_type,
        p_image_quality, p_risk_level, p_basis_state
      )
  );
$$;

CREATE OR REPLACE FUNCTION metrics.authorize_capability(
  p_decision_id text,
  p_family_space_hash text,
  p_capability_key text,
  p_kind text,
  p_subject text,
  p_grade_band text,
  p_question_type text,
  p_image_quality text,
  p_risk_level text,
  p_basis_state text,
  p_rollout_bucket integer,
  p_issued_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  current_epoch bigint;
  selected_primary metrics.capability_release_revisions%ROWTYPE;
  selected_shadow metrics.capability_release_revisions%ROWTYPE;
  decision_status text;
  reason text;
  result jsonb;
BEGIN
  IF p_family_space_hash !~ '^[0-9a-f]{64}$'
     OR p_rollout_bucket NOT BETWEEN 0 AND 99 THEN
    RAISE EXCEPTION 'authorization input is invalid';
  END IF;
  SELECT containment_epoch INTO current_epoch
  FROM metrics.quality_control_epoch WHERE singleton FOR SHARE;
  SELECT release.* INTO selected_primary
  FROM metrics.capability_versions AS version
  JOIN LATERAL (
    SELECT history.*
    FROM metrics.capability_release_revisions AS history
    WHERE history.capability_version_id = version.id
    ORDER BY history.revision DESC
    LIMIT 1
  ) AS release ON true
  WHERE version.capability_key = p_capability_key
    AND version.kind = p_kind
    AND metrics.quality_release_is_applicable(
      release.id, p_subject, p_grade_band, p_question_type,
      p_image_quality, p_risk_level, p_basis_state
    )
    AND (
      release.stage = 'general'
      OR (release.stage IN ('small', 'expanded')
          AND p_rollout_bucket < release.rollout_basis_points / 100)
    )
  ORDER BY version.registered_at DESC, version.id DESC
  LIMIT 1;

  SELECT release.* INTO selected_shadow
  FROM metrics.capability_versions AS version
  JOIN LATERAL (
    SELECT history.*
    FROM metrics.capability_release_revisions AS history
    WHERE history.capability_version_id = version.id
    ORDER BY history.revision DESC
    LIMIT 1
  ) AS release ON true
  WHERE version.capability_key = p_capability_key
    AND version.kind = p_kind
    AND release.stage = 'shadow'
    AND metrics.quality_release_is_applicable(
      release.id, p_subject, p_grade_band, p_question_type,
      p_image_quality, p_risk_level, p_basis_state
    )
  ORDER BY version.registered_at DESC, version.id DESC
  LIMIT 1;

  IF selected_primary.id IS NOT NULL THEN
    decision_status := 'authorized';
    reason := NULL;
  ELSE
    decision_status := 'degraded';
    IF EXISTS (
      SELECT 1
      FROM metrics.capability_versions AS version
      WHERE version.capability_key = p_capability_key AND version.kind = p_kind
        AND metrics.quality_version_is_contained(
          version.id, p_subject, p_grade_band, p_question_type,
          p_image_quality, p_risk_level, p_basis_state
        )
    ) THEN
      reason := 'CAPABILITY_CONTAINED';
    ELSIF NOT EXISTS (
      SELECT 1 FROM metrics.capability_versions
      WHERE capability_key = p_capability_key AND kind = p_kind
    ) THEN
      reason := 'NO_APPLICABLE_CAPABILITY';
    ELSIF NOT EXISTS (
      SELECT 1 FROM metrics.capability_versions AS version
      WHERE version.capability_key = p_capability_key AND version.kind = p_kind
        AND metrics.quality_version_is_signed(version.id)
    ) THEN
      reason := 'NO_SIGNED_CAPABILITY';
    ELSIF EXISTS (
      SELECT 1
      FROM metrics.capability_release_revisions AS release
      WHERE release.capability_key = p_capability_key AND release.kind = p_kind
        AND release.stage IN ('shadow', 'small', 'expanded')
        AND metrics.quality_use_slice_allowed(
          release.allowed_use_slices, p_subject, p_grade_band, p_question_type,
          p_image_quality, p_risk_level, p_basis_state
        )
    ) THEN
      reason := 'OUTSIDE_ROLLOUT';
    ELSE
      reason := 'NO_APPLICABLE_CAPABILITY';
    END IF;
  END IF;

  INSERT INTO metrics.authorization_decisions (
    id, capability_key, kind, family_space_hash, subject, grade_band,
    question_type, image_quality, risk_level, basis_state, rollout_bucket,
    containment_epoch, primary_release_id, primary_version_id,
    shadow_release_id, shadow_version_id, status, degraded_reason, issued_at
  ) VALUES (
    p_decision_id, p_capability_key, p_kind, p_family_space_hash,
    p_subject, p_grade_band, p_question_type, p_image_quality,
    p_risk_level, p_basis_state, p_rollout_bucket, current_epoch,
    selected_primary.id, selected_primary.capability_version_id,
    selected_shadow.id, selected_shadow.capability_version_id,
    decision_status, reason, p_issued_at
  );

  result := jsonb_build_object(
    'decisionId', p_decision_id,
    'containmentEpoch', current_epoch,
    'rolloutBucket', p_rollout_bucket,
    'status', decision_status,
    'degradedReason', reason,
    'primaryReleaseId', selected_primary.id,
    'primaryVersionId', selected_primary.capability_version_id,
    'primaryRolloutStage', selected_primary.stage,
    'shadowReleaseId', selected_shadow.id,
    'shadowVersionId', selected_shadow.capability_version_id,
    'issuedAt', p_issued_at
  );
  INSERT INTO metrics.quality_control_outbox (
    event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    'quality.authorization-decided.v1', 'authorization', p_decision_id,
    result, p_issued_at
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.lock_current_capability_authorization(
  p_authorization_id text,
  p_capability_version_id text,
  p_expected_containment_epoch bigint,
  p_phase text,
  p_route text
)
RETURNS TABLE (
  authorization_id text,
  capability_version_id text,
  containment_epoch bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  decision metrics.authorization_decisions%ROWTYPE;
  current_route metrics.capability_release_revisions%ROWTYPE;
  selected_release_id text;
  selected_version_id text;
  current_epoch bigint;
  route_current boolean := false;
BEGIN
  SELECT epoch.containment_epoch INTO current_epoch
  FROM metrics.quality_control_epoch AS epoch
  WHERE epoch.singleton
  FOR SHARE;
  SELECT * INTO decision
  FROM metrics.authorization_decisions
  WHERE id = p_authorization_id
  FOR SHARE;
  IF NOT FOUND OR decision.containment_epoch <> p_expected_containment_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTHORIZATION_STALE';
  END IF;
  IF p_route = 'shadow' AND p_phase = 'before_publish' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SHADOW_PUBLICATION_FORBIDDEN';
  END IF;
  IF p_route = 'primary' THEN
    selected_release_id := decision.primary_release_id;
    selected_version_id := decision.primary_version_id;
  ELSIF p_route = 'shadow' THEN
    selected_release_id := decision.shadow_release_id;
    selected_version_id := decision.shadow_version_id;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUTE_NOT_AUTHORIZED';
  END IF;
  IF selected_release_id IS NULL
     OR selected_version_id IS DISTINCT FROM p_capability_version_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUTE_NOT_AUTHORIZED';
  END IF;
  IF metrics.quality_version_is_contained(
    selected_version_id, decision.subject, decision.grade_band,
    decision.question_type, decision.image_quality,
    decision.risk_level, decision.basis_state
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CAPABILITY_CONTAINED';
  END IF;
  IF current_epoch <> p_expected_containment_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTHORIZATION_STALE';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    decision.capability_key || ':' || decision.kind, 0
  ));

  PERFORM head.capability_version_id
  FROM metrics.capability_aggregate_heads AS head
  JOIN metrics.capability_versions AS version
    ON version.id = head.capability_version_id
  WHERE version.capability_key = decision.capability_key AND version.kind = decision.kind
  ORDER BY head.capability_version_id
  FOR SHARE OF head;
  IF p_route = 'primary' THEN
    SELECT release.* INTO current_route
    FROM metrics.capability_versions AS version
    JOIN LATERAL (
      SELECT history.*
      FROM metrics.capability_release_revisions AS history
      WHERE history.capability_version_id = version.id
      ORDER BY history.revision DESC
      LIMIT 1
    ) AS release ON true
    WHERE version.capability_key = decision.capability_key
      AND version.kind = decision.kind
      AND metrics.quality_release_is_applicable(
        release.id, decision.subject, decision.grade_band,
        decision.question_type, decision.image_quality,
        decision.risk_level, decision.basis_state
      )
      AND (
        release.stage = 'general'
        OR (release.stage IN ('small', 'expanded')
          AND decision.rollout_bucket < release.rollout_basis_points / 100)
      )
    ORDER BY version.registered_at DESC, version.id DESC
    LIMIT 1;
  ELSE
    SELECT release.* INTO current_route
    FROM metrics.capability_versions AS version
    JOIN LATERAL (
      SELECT history.*
      FROM metrics.capability_release_revisions AS history
      WHERE history.capability_version_id = version.id
      ORDER BY history.revision DESC
      LIMIT 1
    ) AS release ON true
    WHERE version.capability_key = decision.capability_key
      AND version.kind = decision.kind
      AND release.stage = 'shadow'
      AND metrics.quality_release_is_applicable(
        release.id, decision.subject, decision.grade_band,
        decision.question_type, decision.image_quality,
        decision.risk_level, decision.basis_state
      )
    ORDER BY version.registered_at DESC, version.id DESC
    LIMIT 1;
  END IF;
  route_current := current_route.id = selected_release_id
    AND current_route.capability_version_id = selected_version_id;
  IF NOT route_current THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUTE_NOT_AUTHORIZED';
  END IF;

  authorization_id := p_authorization_id;
  capability_version_id := p_capability_version_id;
  containment_epoch := current_epoch;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.lock_current_family_capability_authorization(
  p_authorization_id text,
  p_capability_version_id text,
  p_expected_containment_epoch bigint,
  p_family_space_hash text,
  p_phase text,
  p_route text
)
RETURNS TABLE (
  authorization_id text,
  capability_version_id text,
  containment_epoch bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  locked_authorization_id text;
  locked_capability_version_id text;
  locked_containment_epoch bigint;
  bound_family_space_hash text;
BEGIN
  IF p_family_space_hash IS NULL
     OR p_family_space_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'AUTHORIZATION_SCOPE_MISMATCH';
  END IF;

  SELECT locked.authorization_id, locked.capability_version_id, locked.containment_epoch
  INTO locked_authorization_id, locked_capability_version_id, locked_containment_epoch
  FROM metrics.lock_current_capability_authorization(
    p_authorization_id,
    p_capability_version_id,
    p_expected_containment_epoch,
    p_phase,
    p_route
  ) AS locked;

  SELECT decision.family_space_hash INTO bound_family_space_hash
  FROM metrics.authorization_decisions AS decision
  WHERE decision.id = locked_authorization_id;
  IF bound_family_space_hash IS DISTINCT FROM p_family_space_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'AUTHORIZATION_SCOPE_MISMATCH';
  END IF;

  authorization_id := locked_authorization_id;
  capability_version_id := locked_capability_version_id;
  containment_epoch := locked_containment_epoch;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.revalidate_capability_authorization(
  p_authorization_id text,
  p_expected_containment_epoch bigint,
  p_phase text,
  p_route text,
  p_checked_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  decision metrics.authorization_decisions%ROWTYPE;
  selected_version_id text;
  current_epoch bigint;
  rejection_reason text;
  result jsonb;
BEGIN
  SELECT * INTO decision
  FROM metrics.authorization_decisions
  WHERE id = p_authorization_id;
  selected_version_id := CASE p_route
    WHEN 'primary' THEN decision.primary_version_id
    WHEN 'shadow' THEN decision.shadow_version_id
    ELSE NULL
  END;
  BEGIN
    PERFORM * FROM metrics.lock_current_capability_authorization(
      p_authorization_id, selected_version_id, p_expected_containment_epoch,
      p_phase, p_route
    );
    current_epoch := p_expected_containment_epoch;
    result := jsonb_build_object(
      'decisionId', p_authorization_id,
      'containmentEpoch', current_epoch,
      'status', 'authorized',
      'capabilityVersion', metrics.read_quality_capability(selected_version_id) -> 'version'
    );
    INSERT INTO metrics.authorization_revalidations (
      authorization_id, containment_epoch, phase, route, status,
      reason, capability_version_id, checked_at
    ) VALUES (
      p_authorization_id, current_epoch, p_phase, p_route, 'authorized',
      NULL, selected_version_id, p_checked_at
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS rejection_reason = MESSAGE_TEXT;
    SELECT epoch.containment_epoch INTO current_epoch
    FROM metrics.quality_control_epoch AS epoch WHERE epoch.singleton;
    IF rejection_reason NOT IN (
      'AUTHORIZATION_STALE', 'CAPABILITY_CONTAINED',
      'ROUTE_NOT_AUTHORIZED', 'SHADOW_PUBLICATION_FORBIDDEN'
    ) THEN
      RAISE;
    END IF;
    result := jsonb_build_object(
      'decisionId', p_authorization_id,
      'containmentEpoch', current_epoch,
      'status', 'rejected',
      'reason', rejection_reason
    );
    IF decision.id IS NOT NULL THEN
      INSERT INTO metrics.authorization_revalidations (
        authorization_id, containment_epoch, phase, route, status,
        reason, capability_version_id, checked_at
      ) VALUES (
        p_authorization_id, current_epoch, p_phase, p_route, 'rejected',
        rejection_reason, NULL, p_checked_at
      );
    END IF;
  END;

  INSERT INTO metrics.quality_control_outbox (
    event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    'quality.authorization-revalidated.v1', 'authorization',
    p_authorization_id, result, p_checked_at
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.read_capability_authorization(p_authorization_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'decisionId', decision.id,
    'containmentEpoch', decision.containment_epoch,
    'issuedAt', to_jsonb(decision.issued_at),
    'rolloutBucket', decision.rollout_bucket,
    'scope', jsonb_build_object(
      'capabilityKey', decision.capability_key,
      'kind', decision.kind,
      'slice', jsonb_build_object(
        'subject', decision.subject,
        'gradeBand', decision.grade_band,
        'questionType', decision.question_type,
        'imageQuality', decision.image_quality,
        'riskLevel', decision.risk_level,
        'basisState', decision.basis_state
      )
    ),
    'status', decision.status,
    'degradedReason', decision.degraded_reason,
    'primary', CASE WHEN decision.primary_version_id IS NULL THEN NULL ELSE jsonb_build_object(
      'capabilityVersion', metrics.read_quality_capability(decision.primary_version_id) -> 'version',
      'rolloutStage', primary_release.stage
    ) END,
    'shadow', CASE WHEN decision.shadow_version_id IS NULL THEN NULL ELSE jsonb_build_object(
      'capabilityVersion', metrics.read_quality_capability(decision.shadow_version_id) -> 'version',
      'rolloutStage', 'shadow'
    ) END
  )
  FROM metrics.authorization_decisions AS decision
  LEFT JOIN metrics.capability_release_revisions AS primary_release
    ON primary_release.id = decision.primary_release_id
  WHERE decision.id = p_authorization_id;
$$;

CREATE OR REPLACE FUNCTION metrics.record_shadow_observation(
  p_observation_id text,
  p_authorization_id text,
  p_capability_version_id text,
  p_expected_containment_epoch bigint,
  p_input_hash text,
  p_output_hash text,
  p_metrics jsonb,
  p_observed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM * FROM metrics.lock_current_capability_authorization(
    p_authorization_id, p_capability_version_id,
    p_expected_containment_epoch, 'after_receive', 'shadow'
  );
  IF p_input_hash !~ '^[0-9a-f]{64}$'
     OR p_output_hash !~ '^[0-9a-f]{64}$'
     OR NOT metrics.quality_numeric_metrics_only(p_metrics) THEN
    RAISE EXCEPTION 'shadow observation may contain only hashes and numeric metrics';
  END IF;
  INSERT INTO metrics.shadow_observations (
    id, authorization_id, capability_version_id, containment_epoch,
    input_hash, output_hash, metrics, observed_at
  ) VALUES (
    p_observation_id, p_authorization_id, p_capability_version_id,
    p_expected_containment_epoch, p_input_hash, p_output_hash, p_metrics, p_observed_at
  );
  result := jsonb_build_object(
    'observationId', p_observation_id,
    'authorizationId', p_authorization_id,
    'capabilityVersionId', p_capability_version_id,
    'containmentEpoch', p_expected_containment_epoch,
    'inputHash', p_input_hash,
    'outputHash', p_output_hash,
    'metrics', p_metrics,
    'observedAt', p_observed_at
  );
  INSERT INTO metrics.quality_control_outbox (
    event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    'quality.shadow-observation-recorded.v1', 'shadow_observation',
    p_observation_id, result, p_observed_at
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION metrics.read_quality_containment_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'epoch', epoch.containment_epoch,
    'orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', containment.id,
        'epoch', containment.epoch,
        'target', jsonb_build_object(
          'kind', containment.target_kind,
          'id', containment.target_id
        ),
        'reason', containment.reason,
        'containedAt', to_jsonb(containment.contained_at)
      ) ORDER BY containment.epoch)
      FROM metrics.capability_containments AS containment
    ), '[]'::jsonb)
  )
  FROM metrics.quality_control_epoch AS epoch
  WHERE epoch.singleton;
$$;

CREATE OR REPLACE FUNCTION metrics.contain_capability(
  p_order jsonb,
  p_guard jsonb,
  p_command_id text,
  p_fingerprint text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  current_epoch bigint;
  order_id text := p_order ->> 'id';
  order_epoch bigint := (p_order ->> 'epoch')::bigint;
  target_kind text := p_order #>> '{target,kind}';
  target_id text := p_order #>> '{target,id}';
  expected_epoch bigint := (p_guard ->> 'containmentEpoch')::bigint;
  contained_at timestamptz := (p_order ->> 'containedAt')::timestamptz;
  projection metrics.capability_current_releases%ROWTYPE;
  primary_release metrics.capability_release_revisions%ROWTYPE;
  shadow_release metrics.capability_release_revisions%ROWTYPE;
  fallback_release metrics.capability_release_revisions%ROWTYPE;
  replacement_id text;
  replacement_revision bigint;
  target_hits_primary boolean;
  target_hits_shadow boolean;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  SELECT containment_epoch INTO current_epoch
  FROM metrics.quality_control_epoch WHERE singleton FOR UPDATE;
  IF current_epoch <> expected_epoch OR order_epoch <> expected_epoch + 1 THEN
    RETURN 'conflict';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM metrics.capability_containments AS existing
    WHERE existing.target_kind = p_order #>> '{target,kind}'
      AND existing.target_id = p_order #>> '{target,id}'
  ) THEN
    RETURN 'conflict';
  END IF;
  PERFORM head.capability_version_id
  FROM metrics.capability_aggregate_heads AS head
  ORDER BY head.capability_version_id
  FOR SHARE OF head;
  IF p_guard ? 'rollback' THEN
    IF target_kind <> 'capability_version'
       OR target_id IS DISTINCT FROM p_guard #>> '{rollback,primaryVersionId}' THEN
      RETURN 'conflict';
    END IF;
    BEGIN
      PERFORM * FROM metrics.lock_current_capability_authorization(
        p_guard #>> '{rollback,decisionId}',
        p_guard #>> '{rollback,primaryVersionId}',
        expected_epoch,
        'before_send',
        'primary'
      );
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RETURN 'conflict';
    END;
  END IF;
  IF target_kind = 'capability_version' THEN
    IF NOT EXISTS (SELECT 1 FROM metrics.capability_versions WHERE id = target_id) THEN
      RAISE EXCEPTION 'containment target capability version does not exist';
    END IF;
  ELSIF target_kind = 'provider' THEN
    IF NOT EXISTS (SELECT 1 FROM metrics.capability_versions WHERE provider_id = target_id) THEN
      RAISE EXCEPTION 'containment target provider does not exist';
    END IF;
  ELSE
    RAISE EXCEPTION 'containment target kind is invalid';
  END IF;

  INSERT INTO metrics.capability_containments (
    id, epoch, target_kind, target_id, reason, contained_at
  ) VALUES (
    order_id, order_epoch, target_kind, target_id,
    p_order ->> 'reason', contained_at
  );

  FOR projection IN
    SELECT * FROM metrics.capability_current_releases
    ORDER BY capability_key, kind
    FOR UPDATE
  LOOP
    target_hits_primary := false;
    target_hits_shadow := false;
    IF projection.primary_release_id IS NOT NULL THEN
      SELECT * INTO primary_release
      FROM metrics.capability_release_revisions
      WHERE id = projection.primary_release_id;
      SELECT (target_kind = 'capability_version' AND version.id = target_id)
          OR (target_kind = 'provider' AND version.provider_id = target_id)
      INTO target_hits_primary
      FROM metrics.capability_versions AS version
      WHERE version.id = primary_release.capability_version_id;
    END IF;
    IF projection.shadow_release_id IS NOT NULL THEN
      SELECT * INTO shadow_release
      FROM metrics.capability_release_revisions
      WHERE id = projection.shadow_release_id;
      SELECT (target_kind = 'capability_version' AND version.id = target_id)
          OR (target_kind = 'provider' AND version.provider_id = target_id)
      INTO target_hits_shadow
      FROM metrics.capability_versions AS version
      WHERE version.id = shadow_release.capability_version_id;
    END IF;

    IF COALESCE(target_hits_primary, false) THEN
      SELECT historical.* INTO fallback_release
      FROM metrics.capability_release_revisions AS historical
      WHERE historical.capability_key = projection.capability_key
        AND historical.kind = projection.kind
        AND historical.stage = 'general'
        AND historical.capability_version_id IS DISTINCT FROM primary_release.capability_version_id
        AND metrics.quality_version_is_signed(historical.capability_version_id)
        AND NOT EXISTS (
          SELECT current_scope.value
          FROM jsonb_array_elements(primary_release.allowed_use_slices) AS current_scope(value)
          EXCEPT
          SELECT fallback_scope.value
          FROM jsonb_array_elements(historical.allowed_use_slices) AS fallback_scope(value)
        )
        AND NOT metrics.quality_version_is_contained(
          historical.capability_version_id, 'unclassified', 'unclassified',
          'unclassified', 'unclassified', 'unclassified', 'unclassified'
        )
      ORDER BY historical.revision DESC
      LIMIT 1;

      replacement_id := gen_random_uuid()::text;
      SELECT COALESCE(max(revision), 0) + 1 INTO replacement_revision
      FROM metrics.capability_release_revisions
      WHERE capability_key = projection.capability_key AND kind = projection.kind;
      INSERT INTO metrics.capability_release_revisions (
        id, capability_key, kind, revision, stage, capability_version_id,
        fallback_version_id, rollout_basis_points, allowed_use_slices,
        predecessor_id, action, reason_code, changed_by, changed_at
      ) VALUES (
        replacement_id, projection.capability_key, projection.kind,
        replacement_revision,
        CASE WHEN fallback_release.id IS NULL THEN 'disabled' ELSE 'general' END,
        fallback_release.capability_version_id, NULL,
        CASE WHEN fallback_release.id IS NULL THEN 0 ELSE 10000 END,
        COALESCE(fallback_release.allowed_use_slices, '[]'::jsonb),
        projection.primary_release_id,
        CASE WHEN fallback_release.id IS NULL
          THEN 'containment_unavailable' ELSE 'containment_fallback' END,
        'quality_containment', 'containment:' || order_id, contained_at
      );
      projection.primary_release_id := replacement_id;
    END IF;
    IF COALESCE(target_hits_shadow, false) THEN
      projection.shadow_release_id := NULL;
    END IF;
    UPDATE metrics.capability_current_releases SET
      primary_release_id = projection.primary_release_id,
      shadow_release_id = projection.shadow_release_id,
      containment_epoch = order_epoch,
      updated_at = contained_at
    WHERE capability_key = projection.capability_key AND kind = projection.kind;
  END LOOP;

  UPDATE metrics.quality_control_epoch
  SET containment_epoch = order_epoch, updated_at = contained_at
  WHERE singleton;
  result := jsonb_build_object(
    'status', 'saved', 'aggregateId', order_id,
    'containmentEpoch', order_epoch,
    'targetKind', target_kind,
    'targetId', target_id
  );
  PERFORM metrics.quality_finish_command(
    p_command_id, 'containment', order_id, p_fingerprint, result,
    'capability.contained.v1', contained_at
  );
  RETURN 'saved';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.create_quality_shadow_observation(
  p_observation jsonb,
  p_command_id text,
  p_fingerprint text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  replay jsonb;
  decision metrics.authorization_decisions%ROWTYPE;
  result jsonb;
BEGIN
  replay := metrics.quality_lock_command(p_command_id, p_fingerprint);
  IF replay IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  IF EXISTS (
    SELECT 1 FROM metrics.shadow_observations WHERE id = p_observation ->> 'id'
  ) THEN
    RETURN 'conflict';
  END IF;
  SELECT * INTO decision
  FROM metrics.authorization_decisions
  WHERE id = p_observation ->> 'decisionId';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shadow authorization does not exist';
  END IF;
  result := metrics.record_shadow_observation(
    p_observation ->> 'id', p_observation ->> 'decisionId',
    p_observation ->> 'capabilityVersionId', decision.containment_epoch,
    p_observation ->> 'inputHash', p_observation ->> 'outputHash',
    p_observation -> 'metrics', (p_observation ->> 'observedAt')::timestamptz
  );
  INSERT INTO metrics.quality_command_receipts (
    command_id, command_type, aggregate_id, fingerprint, result, recorded_at
  ) VALUES (
    p_command_id, 'shadow_observation', p_observation ->> 'id',
    p_fingerprint, result, (p_observation ->> 'observedAt')::timestamptz
  );
  RETURN 'created';
END;
$$;

CREATE OR REPLACE FUNCTION metrics.read_quality_shadow_observation(p_observation_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
  SELECT jsonb_build_object(
    'id', observation.id,
    'decisionId', observation.authorization_id,
    'capabilityVersionId', observation.capability_version_id,
    'inputHash', observation.input_hash,
    'outputHash', observation.output_hash,
    'metrics', observation.metrics,
    'observedAt', to_jsonb(observation.observed_at)
  )
  FROM metrics.shadow_observations AS observation
  WHERE observation.id = p_observation_id;
$$;

CREATE OR REPLACE FUNCTION metrics.save_quality_authorization_decision(
  p_decision jsonb,
  p_guard jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  current_epoch bigint;
  persisted jsonb;
  persisted_family_space_hash text;
  computed jsonb;
  selected_capability_key text := p_decision #>> '{scope,capabilityKey}';
  selected_capability_kind text := p_decision #>> '{scope,kind}';
BEGIN
  IF jsonb_typeof(p_guard) IS DISTINCT FROM 'object'
     OR p_guard ->> 'familySpaceHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'authorization family scope hash is invalid';
  END IF;
  SELECT decision.family_space_hash INTO persisted_family_space_hash
  FROM metrics.authorization_decisions AS decision
  WHERE decision.id = p_decision ->> 'decisionId';
  IF FOUND THEN
    persisted := metrics.read_capability_authorization(p_decision ->> 'decisionId');
    IF persisted = p_decision
       AND persisted_family_space_hash = p_guard ->> 'familySpaceHash' THEN
      RETURN jsonb_build_object('status', 'saved', 'decision', persisted);
    END IF;
    RAISE EXCEPTION 'authorization decision id reused with different intent';
  END IF;

  SELECT containment_epoch INTO current_epoch
  FROM metrics.quality_control_epoch WHERE singleton FOR SHARE;
  IF current_epoch <> (p_guard ->> 'containmentEpoch')::bigint
     OR current_epoch <> (p_decision ->> 'containmentEpoch')::bigint THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_capability_key || ':' || selected_capability_kind, 0
  ));
  PERFORM head.capability_version_id
  FROM metrics.capability_aggregate_heads AS head
  JOIN metrics.capability_versions AS version
    ON version.id = head.capability_version_id
  WHERE version.capability_key = selected_capability_key
    AND version.kind = selected_capability_kind
  ORDER BY head.capability_version_id
  FOR SHARE OF head;
  IF EXISTS (
    SELECT version.id, head.revision
    FROM metrics.capability_versions AS version
    JOIN metrics.capability_aggregate_heads AS head
      ON head.capability_version_id = version.id
    WHERE version.capability_key = selected_capability_key
      AND version.kind = selected_capability_kind
    EXCEPT
    SELECT entry ->> 'id', (entry ->> 'revision')::integer
    FROM jsonb_array_elements(p_guard -> 'capabilityRevisions') AS entry
  ) OR EXISTS (
    SELECT entry ->> 'id', (entry ->> 'revision')::integer
    FROM jsonb_array_elements(p_guard -> 'capabilityRevisions') AS entry
    EXCEPT
    SELECT version.id, head.revision
    FROM metrics.capability_versions AS version
    JOIN metrics.capability_aggregate_heads AS head
      ON head.capability_version_id = version.id
    WHERE version.capability_key = selected_capability_key
      AND version.kind = selected_capability_kind
  ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  computed := metrics.authorize_capability(
    p_decision ->> 'decisionId', p_guard ->> 'familySpaceHash',
    selected_capability_key, selected_capability_kind,
    p_decision #>> '{scope,slice,subject}',
    p_decision #>> '{scope,slice,gradeBand}',
    p_decision #>> '{scope,slice,questionType}',
    p_decision #>> '{scope,slice,imageQuality}',
    p_decision #>> '{scope,slice,riskLevel}',
    p_decision #>> '{scope,slice,basisState}',
    (p_decision ->> 'rolloutBucket')::integer,
    (p_decision ->> 'issuedAt')::timestamptz
  );
  IF computed ->> 'status' <> p_decision ->> 'status'
     OR computed ->> 'degradedReason' IS DISTINCT FROM p_decision ->> 'degradedReason'
     OR computed ->> 'primaryVersionId'
        IS DISTINCT FROM p_decision #>> '{primary,capabilityVersion,id}'
     OR computed ->> 'primaryRolloutStage'
        IS DISTINCT FROM p_decision #>> '{primary,rolloutStage}'
     OR computed ->> 'shadowVersionId'
        IS DISTINCT FROM p_decision #>> '{shadow,capabilityVersion,id}' THEN
    RAISE EXCEPTION 'authorization decision does not match locked quality authority';
  END IF;
  persisted := metrics.read_capability_authorization(p_decision ->> 'decisionId');
  RETURN jsonb_build_object('status', 'saved', 'decision', persisted);
END;
$$;

CREATE OR REPLACE FUNCTION metrics.lock_authorization_revalidation_snapshot(
  p_authorization_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, metrics
AS $$
DECLARE
  decision metrics.authorization_decisions%ROWTYPE;
  records jsonb := '[]'::jsonb;
  policies jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM metrics.quality_control_epoch WHERE singleton FOR SHARE;
  SELECT * INTO decision
  FROM metrics.authorization_decisions
  WHERE id = p_authorization_id
  FOR SHARE;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      decision.capability_key || ':' || decision.kind, 0
    ));
    PERFORM head.capability_version_id
    FROM metrics.capability_aggregate_heads AS head
    JOIN metrics.capability_versions AS version
      ON version.id = head.capability_version_id
    WHERE version.capability_key = decision.capability_key AND version.kind = decision.kind
    ORDER BY head.capability_version_id
    FOR SHARE OF head;
    SELECT COALESCE(jsonb_agg(metrics.read_quality_capability(version.id)
      ORDER BY version.registered_at DESC, version.id DESC), '[]'::jsonb)
    INTO records
    FROM metrics.capability_versions AS version
    WHERE version.capability_key = decision.capability_key AND version.kind = decision.kind;
    SELECT COALESCE(jsonb_agg(metrics.read_quality_slice_policy(policy_version)
      ORDER BY policy_version), '[]'::jsonb)
    INTO policies
    FROM (
      SELECT DISTINCT version.required_slice_policy_version AS policy_version
      FROM metrics.capability_versions AS version
      WHERE version.capability_key = decision.capability_key AND version.kind = decision.kind
    ) AS required_policy;
  END IF;
  RETURN jsonb_build_object(
    'containment', metrics.read_quality_containment_state(),
    'decision', metrics.read_capability_authorization(p_authorization_id),
    'records', records,
    'slicePolicies', policies
  );
END;
$$;

ALTER TABLE metrics.quality_gate_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_gate_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.gate_required_slices ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.gate_required_slices FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_aggregate_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_aggregate_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.evaluation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.evaluation_slice_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.evaluation_slice_results FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_card_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_card_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_card_slice_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_card_slice_results FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_signoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_control_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_control_epoch FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_release_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_release_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_current_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_current_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_containments ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.capability_containments FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.authorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.authorization_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.authorization_revalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.authorization_revalidations FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.shadow_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.shadow_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_control_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.quality_control_outbox FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_quality_runtime') THEN
    CREATE ROLE rhea_quality_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_quality_governance') THEN
    CREATE ROLE rhea_quality_governance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_quality_runtime SET search_path = pg_catalog, metrics;
ALTER ROLE rhea_quality_governance SET search_path = pg_catalog, metrics;
REVOKE ALL ON SCHEMA metrics FROM rhea_quality_runtime, rhea_quality_governance;
REVOKE ALL ON ALL TABLES IN SCHEMA metrics FROM rhea_quality_runtime, rhea_quality_governance;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA metrics FROM rhea_quality_runtime, rhea_quality_governance;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA metrics FROM PUBLIC;
GRANT USAGE ON SCHEMA metrics TO rhea_quality_runtime, rhea_quality_governance;

GRANT EXECUTE ON FUNCTION metrics.create_quality_slice_policy(jsonb, text, text)
  TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.create_quality_capability(jsonb, text, text)
  TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.append_quality_evaluation(jsonb, jsonb, integer, text, text)
  TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.append_quality_signoff(
  text, jsonb, integer, text, text, text, text
) TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.advance_quality_rollout(
  text, jsonb, integer, text, text, text
) TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.contain_capability(jsonb, jsonb, text, text)
  TO rhea_quality_governance;
GRANT EXECUTE ON FUNCTION metrics.read_quality_capability(text)
  TO rhea_quality_governance, rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.read_quality_slice_policy(text)
  TO rhea_quality_governance, rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.list_quality_capabilities(text, text)
  TO rhea_quality_governance, rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.read_quality_command(text)
  TO rhea_quality_governance, rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.read_quality_containment_state()
  TO rhea_quality_governance, rhea_quality_runtime;

GRANT EXECUTE ON FUNCTION metrics.save_quality_authorization_decision(jsonb, jsonb)
  TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.read_capability_authorization(text)
  TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.lock_authorization_revalidation_snapshot(text)
  TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.revalidate_capability_authorization(
  text, bigint, text, text, timestamptz
) TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.lock_current_capability_authorization(
  text, text, bigint, text, text
) TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.lock_current_family_capability_authorization(
  text, text, bigint, text, text, text
) TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.create_quality_shadow_observation(jsonb, text, text)
  TO rhea_quality_runtime;
GRANT EXECUTE ON FUNCTION metrics.read_quality_shadow_observation(text)
  TO rhea_quality_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_learning_app') THEN
    GRANT USAGE ON SCHEMA metrics TO rhea_learning_app;
    REVOKE EXECUTE ON FUNCTION metrics.lock_current_capability_authorization(
      text, text, bigint, text, text
    ) FROM rhea_learning_app;
    GRANT EXECUTE ON FUNCTION metrics.lock_current_family_capability_authorization(
      text, text, bigint, text, text, text
    ) TO rhea_learning_app;
  END IF;
  EXECUTE format('GRANT rhea_quality_runtime TO %I', current_user);
  EXECUTE format('GRANT rhea_quality_governance TO %I', current_user);
END
$$;
