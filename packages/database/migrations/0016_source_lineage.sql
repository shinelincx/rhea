-- Immutable source lineage and fail-closed invalidation for every derived learning fact.
-- Callers mutate this model only through the commands below; history tables stay append-only.

CREATE TABLE learning.source_heads (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN (
    'capability', 'classification', 'confirmed_content', 'current_learning_basis',
    'derived_artifact', 'grading_basis', 'learning_source', 'question', 'response'
  )),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 500),
  current_version text NOT NULL CHECK (char_length(current_version) BETWEEN 1 AND 500),
  current_epoch bigint NOT NULL CHECK (current_epoch > 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (family_space_id, learning_profile_id, source_kind, source_id)
);

CREATE TABLE learning.source_revisions (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN (
    'capability', 'classification', 'confirmed_content', 'current_learning_basis',
    'derived_artifact', 'grading_basis', 'learning_source', 'question', 'response'
  )),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 500),
  epoch bigint NOT NULL CHECK (epoch > 0),
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 500),
  predecessor_version text,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (family_space_id, learning_profile_id, source_kind, source_id, epoch),
  UNIQUE (family_space_id, learning_profile_id, source_kind, source_id, version)
);

CREATE TABLE learning.derived_artifacts (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL CHECK (artifact_kind IN (
    'assessment', 'error_item', 'explanation', 'generated_learning',
    'learning_evidence', 'mastery_evidence', 'review_card'
  )),
  artifact_id text NOT NULL CHECK (char_length(artifact_id) BETWEEN 1 AND 500),
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 500),
  rebuildable boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'rebuild_failed', 'stale', 'superseded')),
  invalidation_epoch bigint NOT NULL DEFAULT 0 CHECK (invalidation_epoch >= 0),
  invalidated_at timestamptz,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (family_space_id, learning_profile_id, artifact_kind, artifact_id, version)
);

CREATE TABLE learning.derived_artifact_heads (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  artifact_id text NOT NULL,
  current_version text NOT NULL,
  PRIMARY KEY (family_space_id, learning_profile_id, artifact_kind, artifact_id),
  FOREIGN KEY (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, current_version
  ) REFERENCES learning.derived_artifacts (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, version
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE learning.derivation_edges (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  artifact_id text NOT NULL,
  artifact_version text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_epoch bigint NOT NULL CHECK (source_epoch > 0),
  source_version text NOT NULL,
  usage text NOT NULL CHECK (char_length(usage) BETWEEN 1 AND 120),
  PRIMARY KEY (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, artifact_version,
    source_kind, source_id
  ),
  FOREIGN KEY (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, artifact_version
  ) REFERENCES learning.derived_artifacts (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, version
  ) ON DELETE CASCADE,
  FOREIGN KEY (
    family_space_id, learning_profile_id, source_kind, source_id, source_epoch
  ) REFERENCES learning.source_revisions (
    family_space_id, learning_profile_id, source_kind, source_id, epoch
  )
);

CREATE TABLE learning.rebuild_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  artifact_id text NOT NULL,
  artifact_version text NOT NULL,
  invalidation_epoch bigint NOT NULL CHECK (invalidation_epoch > 0),
  status text NOT NULL CHECK (status IN (
    'completed', 'queued', 'retry_wait', 'running', 'superseded'
  )),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  worker_id text,
  lease_until timestamptz,
  retry_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (
    family_space_id, learning_profile_id, artifact_kind, artifact_id,
    artifact_version, invalidation_epoch
  ),
  FOREIGN KEY (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, artifact_version
  ) REFERENCES learning.derived_artifacts (
    family_space_id, learning_profile_id, artifact_kind, artifact_id, version
  ) ON DELETE CASCADE
);

CREATE TABLE learning.lineage_command_receipts (
  command_id text PRIMARY KEY CHECK (char_length(command_id) BETWEEN 1 AND 500),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result_kind text NOT NULL CHECK (result_kind IN ('artifact', 'rebuild', 'source')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning.lineage_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'derived_content.invalidated.v1', 'derived_content.published.v1',
    'source.version_changed.v1'
  )),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz
);

CREATE INDEX source_revisions_history_idx ON learning.source_revisions (
  family_space_id, learning_profile_id, source_kind, source_id, epoch DESC
);
CREATE INDEX derivation_edges_source_idx ON learning.derivation_edges (
  family_space_id, learning_profile_id, source_kind, source_id
);
CREATE INDEX rebuild_jobs_claim_idx ON learning.rebuild_jobs (
  status, retry_at, lease_until, created_at, id
);
CREATE INDEX lineage_outbox_pending_idx ON learning.lineage_outbox (occurred_at, id)
  WHERE published_at IS NULL;

CREATE FUNCTION learning.lineage_scope_allowed(
  p_family_space_id uuid,
  p_learning_profile_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, learning
AS $$
  SELECT p_family_space_id::text = current_setting('rhea.family_space_id', true)
    AND p_learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
    AND EXISTS (
      SELECT 1 FROM learning.learning_profiles profile
      WHERE profile.id = p_learning_profile_id
        AND profile.family_space_id = p_family_space_id
    )
$$;

REVOKE ALL ON FUNCTION learning.lineage_scope_allowed(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION learning.lineage_job_json(p_job learning.rebuild_jobs)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, learning
AS $$
  SELECT jsonb_build_object(
    'artifact', jsonb_build_object(
      'familySpaceId', p_job.family_space_id,
      'learningProfileId', p_job.learning_profile_id,
      'kind', p_job.artifact_kind,
      'id', p_job.artifact_id,
      'version', p_job.artifact_version
    ),
    'attempt', p_job.attempt,
    'createdAt', p_job.created_at,
    'errorCode', p_job.error_code,
    'id', p_job.id,
    'invalidationEpoch', p_job.invalidation_epoch,
    'leaseUntil', p_job.lease_until,
    'retryAt', p_job.retry_at,
    'status', p_job.status,
    'updatedAt', p_job.updated_at,
    'workerId', p_job.worker_id
  )
$$;

REVOKE ALL ON FUNCTION learning.lineage_job_json(learning.rebuild_jobs) FROM PUBLIC;

CREATE FUNCTION learning.invalidate_lineage_dependents(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_source_kind text,
  p_source_id text,
  p_source_epoch bigint,
  p_source_version text,
  p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_artifact learning.derived_artifacts%ROWTYPE;
BEGIN
  FOR v_artifact IN
    UPDATE learning.derived_artifacts artifact
    SET status = 'stale',
        invalidation_epoch = artifact.invalidation_epoch + 1,
        invalidated_at = p_occurred_at
    WHERE artifact.family_space_id = p_family_space_id
      AND artifact.learning_profile_id = p_learning_profile_id
      AND artifact.status <> 'superseded'
      AND EXISTS (
        SELECT 1
        FROM learning.derivation_edges edge
        WHERE edge.family_space_id = artifact.family_space_id
          AND edge.learning_profile_id = artifact.learning_profile_id
          AND edge.artifact_kind = artifact.artifact_kind
          AND edge.artifact_id = artifact.artifact_id
          AND edge.artifact_version = artifact.version
          AND edge.source_kind = p_source_kind
          AND edge.source_id = p_source_id
          AND (edge.source_epoch <> p_source_epoch OR edge.source_version <> p_source_version)
      )
    RETURNING artifact.*
  LOOP
    UPDATE learning.rebuild_jobs
    SET status = 'superseded', updated_at = p_occurred_at
    WHERE family_space_id = v_artifact.family_space_id
      AND learning_profile_id = v_artifact.learning_profile_id
      AND artifact_kind = v_artifact.artifact_kind
      AND artifact_id = v_artifact.artifact_id
      AND artifact_version = v_artifact.version
      AND status NOT IN ('completed', 'superseded');

    IF v_artifact.rebuildable THEN
      INSERT INTO learning.rebuild_jobs
        (family_space_id, learning_profile_id, artifact_kind, artifact_id,
         artifact_version, invalidation_epoch, status, created_at, updated_at)
      VALUES
        (v_artifact.family_space_id, v_artifact.learning_profile_id,
         v_artifact.artifact_kind, v_artifact.artifact_id, v_artifact.version,
         v_artifact.invalidation_epoch, 'queued', p_occurred_at, p_occurred_at)
      ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO learning.lineage_outbox
      (family_space_id, learning_profile_id, aggregate_type, aggregate_id,
       event_type, payload, occurred_at)
    VALUES
      (v_artifact.family_space_id, v_artifact.learning_profile_id,
       v_artifact.artifact_kind, v_artifact.artifact_id,
       'derived_content.invalidated.v1',
       jsonb_build_object(
         'artifactVersion', v_artifact.version,
         'invalidationEpoch', v_artifact.invalidation_epoch,
         'sourceId', p_source_id,
         'sourceKind', p_source_kind,
         'sourceVersion', p_source_version
       ),
       p_occurred_at);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION learning.invalidate_lineage_dependents(
  uuid, uuid, text, text, bigint, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION learning.advance_lineage_source(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_source_kind text,
  p_source_id text,
  p_version text,
  p_reason text,
  p_occurred_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_head learning.source_heads%ROWTYPE;
  v_epoch bigint;
  v_predecessor text;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_family_space_id::text || ':' || p_learning_profile_id::text || ':' ||
    p_source_kind || ':' || p_source_id,
    0
  ));

  SELECT * INTO v_head
  FROM learning.source_heads
  WHERE family_space_id = p_family_space_id
    AND learning_profile_id = p_learning_profile_id
    AND source_kind = p_source_kind
    AND source_id = p_source_id
  FOR UPDATE;

  IF FOUND AND v_head.current_version = p_version THEN
    SELECT jsonb_build_object(
      'familySpaceId', revision.family_space_id,
      'learningProfileId', revision.learning_profile_id,
      'kind', revision.source_kind,
      'id', revision.source_id,
      'epoch', revision.epoch,
      'version', revision.version,
      'predecessorVersion', revision.predecessor_version,
      'reason', revision.reason,
      'occurredAt', revision.occurred_at
    ) INTO v_result
    FROM learning.source_revisions revision
    WHERE revision.family_space_id = p_family_space_id
      AND revision.learning_profile_id = p_learning_profile_id
      AND revision.source_kind = p_source_kind
      AND revision.source_id = p_source_id
      AND revision.epoch = v_head.current_epoch;
    RETURN v_result;
  END IF;

  v_epoch := COALESCE(v_head.current_epoch, 0) + 1;
  v_predecessor := v_head.current_version;

  INSERT INTO learning.source_revisions
    (family_space_id, learning_profile_id, source_kind, source_id, epoch,
     version, predecessor_version, reason, occurred_at)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id, v_epoch,
     p_version, v_predecessor, p_reason, p_occurred_at);

  INSERT INTO learning.source_heads
    (family_space_id, learning_profile_id, source_kind, source_id,
     current_version, current_epoch, occurred_at)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id,
     p_version, v_epoch, p_occurred_at)
  ON CONFLICT (family_space_id, learning_profile_id, source_kind, source_id)
  DO UPDATE SET current_version = EXCLUDED.current_version,
                current_epoch = EXCLUDED.current_epoch,
                occurred_at = EXCLUDED.occurred_at;

  PERFORM learning.invalidate_lineage_dependents(
    p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id,
    v_epoch, p_version, p_occurred_at
  );

  INSERT INTO learning.lineage_outbox
    (family_space_id, learning_profile_id, aggregate_type, aggregate_id,
     event_type, payload, occurred_at)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id,
     'source.version_changed.v1',
     jsonb_build_object(
       'epoch', v_epoch,
       'predecessorVersion', v_predecessor,
       'version', p_version
     ),
     p_occurred_at);

  RETURN jsonb_build_object(
    'familySpaceId', p_family_space_id,
    'learningProfileId', p_learning_profile_id,
    'kind', p_source_kind,
    'id', p_source_id,
    'epoch', v_epoch,
    'version', p_version,
    'predecessorVersion', v_predecessor,
    'reason', p_reason,
    'occurredAt', p_occurred_at
  );
END
$$;

REVOKE ALL ON FUNCTION learning.advance_lineage_source(
  uuid, uuid, text, text, text, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION learning.record_source_revision(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_source_kind text,
  p_source_id text,
  p_version text,
  p_expected_epoch bigint,
  p_expected_version text,
  p_reason text,
  p_occurred_at timestamptz,
  p_command_id text,
  p_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_head learning.source_heads%ROWTYPE;
  v_receipt learning.lineage_command_receipts%ROWTYPE;
  v_value jsonb;
BEGIN
  IF NOT learning.lineage_scope_allowed(p_family_space_id, p_learning_profile_id) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('lineage-command:' || p_command_id, 0));
  SELECT * INTO v_receipt FROM learning.lineage_command_receipts
  WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_receipt.fingerprint = p_fingerprint THEN
      RETURN jsonb_build_object('status', 'duplicate', 'value', v_receipt.result);
    END IF;
    RETURN jsonb_build_object('status', 'idempotency_conflict');
  END IF;

  IF p_source_kind NOT IN (
    'capability', 'classification', 'confirmed_content', 'current_learning_basis',
    'derived_artifact', 'grading_basis', 'learning_source', 'question', 'response'
  ) OR char_length(p_source_id) NOT BETWEEN 1 AND 500
    OR char_length(p_version) NOT BETWEEN 1 AND 500
    OR char_length(p_reason) NOT BETWEEN 1 AND 500
    OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_family_space_id::text || ':' || p_learning_profile_id::text || ':' ||
    p_source_kind || ':' || p_source_id,
    0
  ));
  SELECT * INTO v_head FROM learning.source_heads
  WHERE family_space_id = p_family_space_id
    AND learning_profile_id = p_learning_profile_id
    AND source_kind = p_source_kind
    AND source_id = p_source_id
  FOR UPDATE;

  IF (p_expected_epoch IS NULL AND FOUND)
    OR (p_expected_epoch IS NOT NULL AND (
      NOT FOUND OR v_head.current_epoch <> p_expected_epoch
      OR v_head.current_version IS DISTINCT FROM p_expected_version
    ))
    OR EXISTS (
      SELECT 1 FROM learning.source_revisions revision
      WHERE revision.family_space_id = p_family_space_id
        AND revision.learning_profile_id = p_learning_profile_id
        AND revision.source_kind = p_source_kind
        AND revision.source_id = p_source_id
        AND revision.version = p_version
    ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  v_value := learning.advance_lineage_source(
    p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id,
    p_version, p_reason, p_occurred_at
  );
  INSERT INTO learning.lineage_command_receipts
    (command_id, fingerprint, result_kind, result, created_at)
  VALUES (p_command_id, p_fingerprint, 'source', v_value, p_occurred_at);
  RETURN jsonb_build_object('status', 'saved', 'value', v_value);
END
$$;

REVOKE ALL ON FUNCTION learning.record_source_revision(
  uuid, uuid, text, text, text, bigint, text, text, timestamptz, text, text
) FROM PUBLIC;

-- Trusted domain adapters already hold their own aggregate locks. This narrow idempotent
-- command lets those adapters advance the shared lineage in the same transaction.
CREATE FUNCTION learning.sync_source_revision(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_source_kind text,
  p_source_id text,
  p_version text,
  p_reason text,
  p_occurred_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF NOT learning.lineage_scope_allowed(p_family_space_id, p_learning_profile_id)
    OR p_source_kind NOT IN (
      'capability', 'classification', 'confirmed_content', 'current_learning_basis',
      'derived_artifact', 'grading_basis', 'learning_source', 'question', 'response'
    ) OR char_length(p_source_id) NOT BETWEEN 1 AND 500
      OR char_length(p_version) NOT BETWEEN 1 AND 500
      OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RETURN NULL;
  END IF;
  RETURN learning.advance_lineage_source(
    p_family_space_id, p_learning_profile_id, p_source_kind, p_source_id,
    p_version, p_reason, p_occurred_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION learning.sync_source_revision(
  uuid, uuid, text, text, text, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION learning.read_lineage_artifact(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_artifact_kind text,
  p_artifact_id text,
  p_version text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_artifact learning.derived_artifacts%ROWTYPE;
  v_dependencies jsonb;
  v_fresh boolean;
  v_job jsonb;
BEGIN
  IF NOT learning.lineage_scope_allowed(p_family_space_id, p_learning_profile_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_artifact FROM learning.derived_artifacts
  WHERE family_space_id = p_family_space_id
    AND learning_profile_id = p_learning_profile_id
    AND artifact_kind = p_artifact_kind
    AND artifact_id = p_artifact_id
    AND version = p_version;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source', jsonb_build_object(
      'familySpaceId', edge.family_space_id,
      'learningProfileId', edge.learning_profile_id,
      'kind', edge.source_kind,
      'id', edge.source_id,
      'epoch', edge.source_epoch,
      'version', edge.source_version,
      'predecessorVersion', revision.predecessor_version,
      'reason', revision.reason,
      'occurredAt', revision.occurred_at
    ),
    'usage', edge.usage
  ) ORDER BY edge.source_kind, edge.source_id), '[]'::jsonb)
  INTO v_dependencies
  FROM learning.derivation_edges edge
  JOIN learning.source_revisions revision
    ON revision.family_space_id = edge.family_space_id
   AND revision.learning_profile_id = edge.learning_profile_id
   AND revision.source_kind = edge.source_kind
   AND revision.source_id = edge.source_id
   AND revision.epoch = edge.source_epoch
  WHERE edge.family_space_id = p_family_space_id
    AND edge.learning_profile_id = p_learning_profile_id
    AND edge.artifact_kind = p_artifact_kind
    AND edge.artifact_id = p_artifact_id
    AND edge.artifact_version = p_version;

  SELECT v_artifact.status = 'current'
    AND head.current_version = p_version
    AND NOT EXISTS (
      SELECT 1
      FROM learning.derivation_edges edge
      LEFT JOIN learning.source_heads source
        ON source.family_space_id = edge.family_space_id
       AND source.learning_profile_id = edge.learning_profile_id
       AND source.source_kind = edge.source_kind
       AND source.source_id = edge.source_id
      WHERE edge.family_space_id = p_family_space_id
        AND edge.learning_profile_id = p_learning_profile_id
        AND edge.artifact_kind = p_artifact_kind
        AND edge.artifact_id = p_artifact_id
        AND edge.artifact_version = p_version
        AND (source.current_epoch IS DISTINCT FROM edge.source_epoch
          OR source.current_version IS DISTINCT FROM edge.source_version)
    )
  INTO v_fresh
  FROM learning.derived_artifact_heads head
  WHERE head.family_space_id = p_family_space_id
    AND head.learning_profile_id = p_learning_profile_id
    AND head.artifact_kind = p_artifact_kind
    AND head.artifact_id = p_artifact_id;
  v_fresh := COALESCE(v_fresh, false);

  SELECT learning.lineage_job_json(job) INTO v_job
  FROM learning.rebuild_jobs job
  WHERE job.family_space_id = p_family_space_id
    AND job.learning_profile_id = p_learning_profile_id
    AND job.artifact_kind = p_artifact_kind
    AND job.artifact_id = p_artifact_id
    AND job.artifact_version = p_version
  ORDER BY job.invalidation_epoch DESC, job.updated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'artifact', jsonb_build_object(
      'familySpaceId', v_artifact.family_space_id,
      'learningProfileId', v_artifact.learning_profile_id,
      'kind', v_artifact.artifact_kind,
      'id', v_artifact.artifact_id,
      'version', v_artifact.version,
      'rebuildable', v_artifact.rebuildable,
      'status', v_artifact.status,
      'invalidationEpoch', v_artifact.invalidation_epoch,
      'invalidatedAt', v_artifact.invalidated_at,
      'publishedAt', v_artifact.published_at
    ),
    'dependencies', v_dependencies,
    'freshness', CASE WHEN v_fresh THEN 'current' ELSE 'stale' END,
    'rebuild', v_job
  );
END
$$;

REVOKE ALL ON FUNCTION learning.read_lineage_artifact(uuid, uuid, text, text, text)
  FROM PUBLIC;

CREATE FUNCTION learning.publish_derived_artifact(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_artifact_kind text,
  p_artifact_id text,
  p_version text,
  p_rebuildable boolean,
  p_expected_previous_version text,
  p_dependencies jsonb,
  p_occurred_at timestamptz,
  p_command_id text,
  p_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_dependency jsonb;
  v_head learning.derived_artifact_heads%ROWTYPE;
  v_receipt learning.lineage_command_receipts%ROWTYPE;
  v_value jsonb;
BEGIN
  IF NOT learning.lineage_scope_allowed(p_family_space_id, p_learning_profile_id) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lineage-command:' || p_command_id, 0));
  SELECT * INTO v_receipt FROM learning.lineage_command_receipts
  WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_receipt.fingerprint = p_fingerprint THEN
      RETURN jsonb_build_object('status', 'duplicate', 'value', v_receipt.result);
    END IF;
    RETURN jsonb_build_object('status', 'idempotency_conflict');
  END IF;
  IF p_artifact_kind NOT IN (
    'assessment', 'error_item', 'explanation', 'generated_learning',
    'learning_evidence', 'mastery_evidence', 'review_card'
  ) OR char_length(p_artifact_id) NOT BETWEEN 1 AND 500
    OR char_length(p_version) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(p_dependencies) <> 'array'
    OR jsonb_array_length(p_dependencies) NOT BETWEEN 1 AND 64
    OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_family_space_id::text || ':' || p_learning_profile_id::text || ':' ||
    p_artifact_kind || ':' || p_artifact_id,
    0
  ));
  SELECT * INTO v_head FROM learning.derived_artifact_heads
  WHERE family_space_id = p_family_space_id
    AND learning_profile_id = p_learning_profile_id
    AND artifact_kind = p_artifact_kind
    AND artifact_id = p_artifact_id
  FOR UPDATE;
  IF COALESCE(v_head.current_version, '') IS DISTINCT FROM
       COALESCE(p_expected_previous_version, '')
    OR EXISTS (
      SELECT 1 FROM learning.derived_artifacts artifact
      WHERE artifact.family_space_id = p_family_space_id
        AND artifact.learning_profile_id = p_learning_profile_id
        AND artifact.artifact_kind = p_artifact_kind
        AND artifact.artifact_id = p_artifact_id
        AND artifact.version = p_version
    ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  FOR v_dependency IN SELECT value FROM jsonb_array_elements(p_dependencies)
  LOOP
    IF v_dependency #>> '{source,familySpaceId}' <> p_family_space_id::text
      OR v_dependency #>> '{source,learningProfileId}' <> p_learning_profile_id::text
      OR char_length(v_dependency ->> 'usage') NOT BETWEEN 1 AND 120
      OR NOT EXISTS (
        SELECT 1 FROM learning.source_heads source
        WHERE source.family_space_id = p_family_space_id
          AND source.learning_profile_id = p_learning_profile_id
          AND source.source_kind = v_dependency #>> '{source,kind}'
          AND source.source_id = v_dependency #>> '{source,id}'
          AND source.current_epoch = (v_dependency #>> '{source,epoch}')::bigint
          AND source.current_version = v_dependency #>> '{source,version}'
      ) THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
  END LOOP;

  IF v_head.current_version IS NOT NULL THEN
    UPDATE learning.derived_artifacts SET status = 'superseded'
    WHERE family_space_id = p_family_space_id
      AND learning_profile_id = p_learning_profile_id
      AND artifact_kind = p_artifact_kind
      AND artifact_id = p_artifact_id
      AND version = v_head.current_version;
  END IF;

  INSERT INTO learning.derived_artifacts
    (family_space_id, learning_profile_id, artifact_kind, artifact_id, version,
     rebuildable, status, published_at)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_artifact_kind, p_artifact_id,
     p_version, p_rebuildable, 'current', p_occurred_at);
  INSERT INTO learning.derived_artifact_heads
    (family_space_id, learning_profile_id, artifact_kind, artifact_id, current_version)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_artifact_kind, p_artifact_id, p_version)
  ON CONFLICT (family_space_id, learning_profile_id, artifact_kind, artifact_id)
  DO UPDATE SET current_version = EXCLUDED.current_version;

  INSERT INTO learning.derivation_edges
    (family_space_id, learning_profile_id, artifact_kind, artifact_id,
     artifact_version, source_kind, source_id, source_epoch, source_version, usage)
  SELECT
    p_family_space_id, p_learning_profile_id, p_artifact_kind, p_artifact_id,
    p_version, dependency #>> '{source,kind}', dependency #>> '{source,id}',
    (dependency #>> '{source,epoch}')::bigint,
    dependency #>> '{source,version}', dependency ->> 'usage'
  FROM jsonb_array_elements(p_dependencies) dependency;

  PERFORM learning.advance_lineage_source(
    p_family_space_id, p_learning_profile_id, 'derived_artifact',
    p_artifact_kind || ':' || p_artifact_id, p_version,
    'derived artifact published', p_occurred_at
  );
  INSERT INTO learning.lineage_outbox
    (family_space_id, learning_profile_id, aggregate_type, aggregate_id,
     event_type, payload, occurred_at)
  VALUES
    (p_family_space_id, p_learning_profile_id, p_artifact_kind, p_artifact_id,
     'derived_content.published.v1',
     jsonb_build_object('artifactVersion', p_version), p_occurred_at);

  v_value := learning.read_lineage_artifact(
    p_family_space_id, p_learning_profile_id, p_artifact_kind, p_artifact_id, p_version
  );
  INSERT INTO learning.lineage_command_receipts
    (command_id, fingerprint, result_kind, result, created_at)
  VALUES (p_command_id, p_fingerprint, 'artifact', v_value, p_occurred_at);
  RETURN jsonb_build_object('status', 'saved', 'value', v_value);
END
$$;

REVOKE ALL ON FUNCTION learning.publish_derived_artifact(
  uuid, uuid, text, text, text, boolean, text, jsonb, timestamptz, text, text
) FROM PUBLIC;

CREATE FUNCTION learning.list_source_history(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_source_kind text,
  p_source_id text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT CASE WHEN learning.lineage_scope_allowed(p_family_space_id, p_learning_profile_id)
    THEN COALESCE(jsonb_agg(jsonb_build_object(
      'familySpaceId', revision.family_space_id,
      'learningProfileId', revision.learning_profile_id,
      'kind', revision.source_kind,
      'id', revision.source_id,
      'epoch', revision.epoch,
      'version', revision.version,
      'predecessorVersion', revision.predecessor_version,
      'reason', revision.reason,
      'occurredAt', revision.occurred_at
    ) ORDER BY revision.epoch), '[]'::jsonb)
    ELSE '[]'::jsonb END
  FROM learning.source_revisions revision
  WHERE revision.family_space_id = p_family_space_id
    AND revision.learning_profile_id = p_learning_profile_id
    AND revision.source_kind = p_source_kind
    AND revision.source_id = p_source_id
$$;

REVOKE ALL ON FUNCTION learning.list_source_history(uuid, uuid, text, text) FROM PUBLIC;

CREATE FUNCTION learning.claim_lineage_rebuild(
  p_worker_id text,
  p_now timestamptz,
  p_lease_until timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_job learning.rebuild_jobs%ROWTYPE;
BEGIN
  IF char_length(p_worker_id) NOT BETWEEN 1 AND 500 OR p_lease_until <= p_now THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_job FROM learning.rebuild_jobs job
  WHERE job.status = 'queued'
    OR (job.status = 'retry_wait' AND job.retry_at <= p_now)
    OR (job.status = 'running' AND job.lease_until <= p_now)
  ORDER BY job.created_at, job.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE learning.rebuild_jobs
  SET attempt = attempt + 1,
      error_code = NULL,
      lease_until = p_lease_until,
      retry_at = NULL,
      status = 'running',
      updated_at = p_now,
      worker_id = p_worker_id
  WHERE id = v_job.id
  RETURNING * INTO v_job;
  UPDATE learning.derived_artifacts SET status = 'stale'
  WHERE family_space_id = v_job.family_space_id
    AND learning_profile_id = v_job.learning_profile_id
    AND artifact_kind = v_job.artifact_kind
    AND artifact_id = v_job.artifact_id
    AND version = v_job.artifact_version
    AND status <> 'superseded';
  RETURN learning.lineage_job_json(v_job);
END
$$;

REVOKE ALL ON FUNCTION learning.claim_lineage_rebuild(text, timestamptz, timestamptz)
  FROM PUBLIC;

CREATE FUNCTION learning.settle_lineage_rebuild(
  p_job_id uuid,
  p_worker_id text,
  p_outcome text,
  p_now timestamptz,
  p_retry_at timestamptz,
  p_error_code text,
  p_replacement_kind text,
  p_replacement_id text,
  p_replacement_version text,
  p_command_id text,
  p_fingerprint text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_job learning.rebuild_jobs%ROWTYPE;
  v_receipt learning.lineage_command_receipts%ROWTYPE;
  v_result text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lineage-command:' || p_command_id, 0));
  SELECT * INTO v_receipt FROM learning.lineage_command_receipts
  WHERE command_id = p_command_id;
  IF FOUND THEN
    RETURN CASE WHEN v_receipt.fingerprint = p_fingerprint
      THEN 'duplicate' ELSE 'idempotency_conflict' END;
  END IF;
  SELECT * INTO v_job FROM learning.rebuild_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'running' OR v_job.worker_id <> p_worker_id THEN
    RETURN 'conflict';
  END IF;
  IF p_outcome = 'failed' THEN
    IF p_retry_at IS NULL OR p_retry_at <= p_now OR char_length(p_error_code) NOT BETWEEN 1 AND 500 THEN
      RETURN 'conflict';
    END IF;
    UPDATE learning.rebuild_jobs
    SET status = 'retry_wait', error_code = p_error_code, retry_at = p_retry_at,
        lease_until = NULL, updated_at = p_now
    WHERE id = p_job_id;
    UPDATE learning.derived_artifacts SET status = 'rebuild_failed'
    WHERE family_space_id = v_job.family_space_id
      AND learning_profile_id = v_job.learning_profile_id
      AND artifact_kind = v_job.artifact_kind
      AND artifact_id = v_job.artifact_id
      AND version = v_job.artifact_version
      AND status <> 'superseded';
    v_result := 'retry_scheduled';
  ELSIF p_outcome = 'completed' THEN
    IF p_replacement_kind IS DISTINCT FROM v_job.artifact_kind
      OR p_replacement_id IS DISTINCT FROM v_job.artifact_id
      OR p_replacement_version IS NULL
      OR p_replacement_version = v_job.artifact_version
      OR NOT EXISTS (
        SELECT 1
        FROM learning.derived_artifacts replacement
        JOIN learning.derived_artifact_heads head
          ON head.family_space_id = replacement.family_space_id
         AND head.learning_profile_id = replacement.learning_profile_id
         AND head.artifact_kind = replacement.artifact_kind
         AND head.artifact_id = replacement.artifact_id
         AND head.current_version = replacement.version
        WHERE replacement.family_space_id = v_job.family_space_id
          AND replacement.learning_profile_id = v_job.learning_profile_id
          AND replacement.artifact_kind = p_replacement_kind
          AND replacement.artifact_id = p_replacement_id
          AND replacement.version = p_replacement_version
          AND replacement.status = 'current'
          AND NOT EXISTS (
            SELECT 1
            FROM learning.derivation_edges edge
            LEFT JOIN learning.source_heads source
              ON source.family_space_id = edge.family_space_id
             AND source.learning_profile_id = edge.learning_profile_id
             AND source.source_kind = edge.source_kind
             AND source.source_id = edge.source_id
            WHERE edge.family_space_id = replacement.family_space_id
              AND edge.learning_profile_id = replacement.learning_profile_id
              AND edge.artifact_kind = replacement.artifact_kind
              AND edge.artifact_id = replacement.artifact_id
              AND edge.artifact_version = replacement.version
              AND (source.current_epoch IS DISTINCT FROM edge.source_epoch
                OR source.current_version IS DISTINCT FROM edge.source_version)
          )
      ) THEN
      RETURN 'conflict';
    END IF;
    UPDATE learning.rebuild_jobs
    SET status = 'completed', error_code = NULL, retry_at = NULL,
        lease_until = NULL, updated_at = p_now
    WHERE id = p_job_id;
    UPDATE learning.derived_artifacts SET status = 'superseded'
    WHERE family_space_id = v_job.family_space_id
      AND learning_profile_id = v_job.learning_profile_id
      AND artifact_kind = v_job.artifact_kind
      AND artifact_id = v_job.artifact_id
      AND version = v_job.artifact_version;
    v_result := 'completed';
  ELSE
    RETURN 'conflict';
  END IF;
  INSERT INTO learning.lineage_command_receipts
    (command_id, fingerprint, result_kind, result, created_at)
  VALUES (p_command_id, p_fingerprint, 'rebuild', to_jsonb(v_result), p_now);
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION learning.settle_lineage_rebuild(
  uuid, text, text, timestamptz, timestamptz, text, text, text, text, text, text
) FROM PUBLIC;

-- Existing learning materials become authoritative lineage heads at the upgrade boundary.
DO $$
DECLARE
  v_material record;
BEGIN
  FOR v_material IN
    SELECT material.id, material.family_space_id, material.learning_profile_id,
           material.confirmed_content_version_id, material.validity_epoch,
           material.created_at,
           classification.id AS classification_id,
           classification.revision AS classification_revision,
           selection.id AS selection_id,
           selection.version AS selection_version,
           selection.source_version_id
    FROM learning.learning_materials material
    JOIN LATERAL (
      SELECT candidate.id, candidate.revision
      FROM learning.classification_versions candidate
      WHERE candidate.material_id = material.id
      ORDER BY candidate.revision DESC LIMIT 1
    ) classification ON true
    JOIN LATERAL (
      SELECT candidate.id, candidate.version, candidate.source_version_id
      FROM learning.basis_selection_versions candidate
      WHERE candidate.material_id = material.id
      ORDER BY candidate.version DESC LIMIT 1
    ) selection ON true
  LOOP
    PERFORM learning.advance_lineage_source(
      v_material.family_space_id, v_material.learning_profile_id,
      'confirmed_content', v_material.id::text,
      v_material.confirmed_content_version_id::text, 'migration backfill', v_material.created_at
    );
    PERFORM learning.advance_lineage_source(
      v_material.family_space_id, v_material.learning_profile_id,
      'classification', v_material.id::text,
      'revision:' || v_material.classification_revision::text,
      'migration backfill', v_material.created_at
    );
    PERFORM learning.advance_lineage_source(
      v_material.family_space_id, v_material.learning_profile_id,
      'current_learning_basis', v_material.id::text,
      v_material.source_version_id::text || ':' || v_material.selection_version::text || ':' ||
        v_material.validity_epoch::text,
      'migration backfill', v_material.created_at
    );
  END LOOP;
END
$$;

ALTER TABLE learning.source_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.source_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.source_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.source_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.derived_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.derived_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.derived_artifact_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.derived_artifact_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.derivation_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.derivation_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.rebuild_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.rebuild_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.lineage_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.lineage_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY source_heads_profile_isolation ON learning.source_heads
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY source_revisions_profile_isolation ON learning.source_revisions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY derived_artifacts_profile_isolation ON learning.derived_artifacts
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY derived_artifact_heads_profile_isolation ON learning.derived_artifact_heads
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY derivation_edges_profile_isolation ON learning.derivation_edges
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY rebuild_jobs_profile_isolation ON learning.rebuild_jobs
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY lineage_outbox_profile_isolation ON learning.lineage_outbox
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_lineage_runtime') THEN
    CREATE ROLE rhea_lineage_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_lineage_runtime SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_lineage_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_lineage_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_lineage_runtime;
GRANT USAGE ON SCHEMA learning TO rhea_lineage_runtime;
GRANT EXECUTE ON FUNCTION learning.record_source_revision(
  uuid, uuid, text, text, text, bigint, text, text, timestamptz, text, text
) TO rhea_lineage_runtime, rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.sync_source_revision(
  uuid, uuid, text, text, text, text, timestamptz
) TO rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.publish_derived_artifact(
  uuid, uuid, text, text, text, boolean, text, jsonb, timestamptz, text, text
) TO rhea_lineage_runtime, rhea_assessment_app, rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.read_lineage_artifact(uuid, uuid, text, text, text)
  TO rhea_lineage_runtime, rhea_assessment_app, rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.list_source_history(uuid, uuid, text, text)
  TO rhea_lineage_runtime, rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app;
GRANT EXECUTE ON FUNCTION learning.claim_lineage_rebuild(text, timestamptz, timestamptz)
  TO rhea_lineage_runtime;
GRANT EXECUTE ON FUNCTION learning.settle_lineage_rebuild(
  uuid, text, text, timestamptz, timestamptz, text, text, text, text, text, text
) TO rhea_lineage_runtime;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_lineage_runtime TO %I', current_user);
END
$$;
