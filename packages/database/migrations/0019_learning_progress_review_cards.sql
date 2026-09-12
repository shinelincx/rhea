CREATE TABLE learning.review_card_requests (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  wrong_item_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  authorization_snapshot jsonb NOT NULL CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
  authorization_decision_id text NOT NULL,
  authorization_containment_epoch bigint NOT NULL CHECK (authorization_containment_epoch >= 0),
  capability jsonb CHECK (capability IS NULL OR jsonb_typeof(capability) = 'object'),
  capability_version_id text,
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'unavailable')),
  unavailable_reason text CHECK (unavailable_reason IS NULL OR unavailable_reason IN (
    'CAPABILITY_CONTAINED', 'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN',
    'GENERATION_CHECK_FAILED', 'MODEL_UNAVAILABLE', 'SOURCE_CHANGED'
  )),
  current_card_id uuid,
  latest_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(latest_checks) = 'array'),
  model_runs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(model_runs) = 'array'),
  processing_lease_expires_at timestamptz,
  rebuild_pending boolean NOT NULL DEFAULT false,
  state_revision integer NOT NULL CHECK (state_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, idempotency_key),
  FOREIGN KEY (wrong_item_id, family_space_id, learning_profile_id)
    REFERENCES learning.wrong_items(id, family_space_id, learning_profile_id)
);

CREATE TABLE learning.review_cards (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES learning.review_card_requests(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  wrong_item_id uuid NOT NULL,
  capability_version_id text NOT NULL CHECK (char_length(capability_version_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  status text NOT NULL CHECK (status IN ('active', 'stale')),
  created_at timestamptz NOT NULL,
  UNIQUE (request_id, version),
  FOREIGN KEY (wrong_item_id, family_space_id, learning_profile_id)
    REFERENCES learning.wrong_items(id, family_space_id, learning_profile_id)
);

ALTER TABLE learning.review_card_requests
  ADD CONSTRAINT review_card_requests_current_card_fk
  FOREIGN KEY (current_card_id) REFERENCES learning.review_cards(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE learning.short_review_sessions (
  id uuid PRIMARY KEY,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  card_ids uuid[] NOT NULL CHECK (cardinality(card_ids) <= 5),
  created_at timestamptz NOT NULL
);

CREATE TABLE learning.review_card_attempts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES learning.short_review_sessions(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES learning.review_cards(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  attempt jsonb NOT NULL CHECK (jsonb_typeof(attempt) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (card_id, idempotency_key)
);

CREATE INDEX review_card_requests_profile_status_idx
  ON learning.review_card_requests (learning_profile_id, status, updated_at, id);
CREATE INDEX review_cards_due_idx
  ON learning.review_cards (learning_profile_id, status, id);
CREATE INDEX review_card_attempts_card_time_idx
  ON learning.review_card_attempts (card_id, created_at, id);

CREATE OR REPLACE FUNCTION learning.create_review_card_request(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_created boolean;
  v_decision metrics.authorization_decisions%ROWTYPE;
  v_item learning.wrong_items%ROWTYPE;
  v_source jsonb := p_payload -> 'source';
  v_authorization jsonb := p_payload -> 'authorization';
  v_capability jsonb := p_payload -> 'capability';
  v_capability_version_id text := p_payload #>> '{capability,id}';
  v_authoritative_capability jsonb;
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR p_payload ->> 'familySpaceId' IS DISTINCT FROM current_setting('rhea.family_space_id', true) THEN
    RETURN false;
  END IF;
  IF p_payload -> 'modelRuns' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
  SELECT * INTO v_item FROM learning.wrong_items
  WHERE id = (v_source ->> 'wrongItemId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
    AND family_space_id = (p_payload ->> 'familySpaceId')::uuid
  FOR SHARE;
  IF NOT FOUND OR NOT learning.lock_current_wrong_item(v_item)
     OR v_item.state_revision <> (v_source ->> 'wrongItemStateRevision')::integer
     OR v_source ->> 'wrongItemStatus' IS DISTINCT FROM v_item.status
     OR v_source ->> 'assessmentId' IS DISTINCT FROM v_item.assessment_id::text
     OR v_item.assessment_version_id::text IS DISTINCT FROM v_source ->> 'assessmentVersionId'
     OR v_source -> 'basis' IS DISTINCT FROM v_item.assessment_snapshot -> 'basis'
     OR v_source ->> 'gradingRuleVersionId' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'correctBasis' ->> 'gradingRuleVersionId'
     OR v_source ->> 'originalExpectedAnswer' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'correctBasis' ->> 'expectedDisplay'
     OR v_source ->> 'originalQuestion' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'question' ->> 'text'
     OR v_source ->> 'originalQuestionContentHash' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'question' ->> 'contentHash'
     OR v_source ->> 'originalQuestionVersionId' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'question' ->> 'versionId'
     OR v_source ->> 'originalResponse' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'response' ->> 'text'
     OR v_source ->> 'originalResponseContentHash' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'response' ->> 'contentHash'
     OR v_source ->> 'originalResponseVersionId' IS DISTINCT FROM
       v_item.assessment_snapshot -> 'response' ->> 'versionId'
     OR (v_item.classification ->> 'revision')::integer <> (v_source ->> 'classificationRevision')::integer
     OR v_item.classification ->> 'status' <> 'classified'
     OR v_source ->> 'knowledgePointName' IS DISTINCT FROM
       v_item.classification ->> 'primaryKnowledgePointName'
     OR v_source ->> 'subject' IS DISTINCT FROM v_item.classification ->> 'subject'
     OR v_source ->> 'unitName' IS DISTINCT FROM v_item.classification ->> 'unitName'
     OR v_item.theme_id IS DISTINCT FROM v_source ->> 'themeId'
     OR NOT learning.authorize_generated_learning(
       v_item.learning_profile_id, v_item.family_space_id,
       (v_source ->> 'consentRevision')::integer, v_source ->> 'ageBand'
     ) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_decision
  FROM metrics.authorization_decisions
  WHERE id = v_authorization ->> 'decisionId';
  IF v_capability IS NOT NULL THEN
    v_authoritative_capability := metrics.read_quality_capability(v_capability_version_id) -> 'version';
  END IF;
  IF NOT FOUND
     OR v_decision.containment_epoch IS DISTINCT FROM (v_authorization ->> 'containmentEpoch')::bigint
     OR v_decision.issued_at IS DISTINCT FROM (v_authorization ->> 'issuedAt')::timestamptz
     OR v_decision.family_space_hash IS DISTINCT FROM encode(sha256(convert_to(v_item.family_space_id::text, 'UTF8')), 'hex')
     OR v_decision.capability_key IS DISTINCT FROM 'ai.review-card'
     OR v_decision.kind IS DISTINCT FROM 'ai'
     OR v_decision.subject IS DISTINCT FROM v_source ->> 'subject'
     OR v_decision.grade_band IS DISTINCT FROM v_source ->> 'ageBand'
     OR v_decision.question_type IS DISTINCT FROM 'objective'
     OR v_decision.image_quality IS DISTINCT FROM 'not_applicable'
     OR v_decision.risk_level IS DISTINCT FROM 'medium'
     OR v_decision.basis_state IS DISTINCT FROM 'current'
     OR (
       v_capability IS NULL AND (
         v_decision.status IS DISTINCT FROM 'degraded'
         OR v_decision.primary_version_id IS NOT NULL
         OR p_payload ->> 'status' IS DISTINCT FROM 'unavailable'
         OR p_payload ->> 'unavailableReason' IS DISTINCT FROM 'CAPABILITY_UNAVAILABLE'
       )
     )
     OR (
       v_capability IS NOT NULL AND (
         v_decision.status IS DISTINCT FROM 'authorized'
         OR v_decision.primary_version_id IS DISTINCT FROM v_capability_version_id
         OR v_authoritative_capability - 'registeredAt' IS DISTINCT FROM v_capability - 'registeredAt'
         OR (v_authoritative_capability ->> 'registeredAt')::timestamptz IS DISTINCT FROM (v_capability ->> 'registeredAt')::timestamptz
         OR v_authorization ->> 'degradedReason' IS NOT NULL
       )
     ) THEN
    RETURN false;
  END IF;
  INSERT INTO learning.review_card_requests (
    id, family_space_id, learning_profile_id, wrong_item_id, idempotency_key,
    actor, authorization_snapshot, authorization_decision_id,
    authorization_containment_epoch, capability, capability_version_id,
    source_snapshot, request_fingerprint,
    status, unavailable_reason, current_card_id, latest_checks, model_runs,
    processing_lease_expires_at, rebuild_pending, state_revision, created_at, updated_at
  ) VALUES (
    (p_payload ->> 'id')::uuid, v_item.family_space_id, v_item.learning_profile_id, v_item.id,
    p_payload ->> 'idempotencyKey', p_payload -> 'actor', v_authorization,
    v_decision.id, v_decision.containment_epoch, v_capability, v_capability_version_id,
    v_source, p_payload ->> 'requestFingerprint',
    p_payload ->> 'status', p_payload ->> 'unavailableReason', NULL,
    p_payload -> 'latestChecks', p_payload -> 'modelRuns', NULL,
    false, 1, (p_payload ->> 'createdAt')::timestamptz, (p_payload ->> 'updatedAt')::timestamptz
  ) ON CONFLICT DO NOTHING RETURNING true INTO v_created;
  IF COALESCE(v_created, false) IS NOT true THEN RETURN false; END IF;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
    event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid, v_item.family_space_id, v_item.learning_profile_id,
    'review_card_request', (p_payload ->> 'id')::uuid, 'review_card.generation_requested',
    jsonb_build_object('wrongItemId', v_item.id, 'status', p_payload ->> 'status'),
    (p_payload ->> 'createdAt')::timestamptz
  );
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation
  OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION learning.claim_review_card_request(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE v_request learning.review_card_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM learning.review_card_requests
  WHERE id = (p_payload ->> 'requestId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
  FOR UPDATE;
  IF NOT FOUND OR v_request.learning_profile_id::text IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR v_request.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR NOT (
       v_request.status = 'queued'
       OR (v_request.status = 'generating' AND v_request.processing_lease_expires_at <= (p_payload ->> 'updatedAt')::timestamptz)
     ) THEN RETURN false; END IF;
  UPDATE learning.review_card_requests SET
    status = 'generating', state_revision = state_revision + 1,
    processing_lease_expires_at = (p_payload ->> 'leaseExpiresAt')::timestamptz,
    updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_request.id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.complete_review_card_request(p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_card jsonb := p_payload -> 'card';
  v_item learning.wrong_items%ROWTYPE;
  v_request learning.review_card_requests%ROWTYPE;
  v_source jsonb;
  v_rejection_reason text;
BEGIN
  SELECT * INTO v_request FROM learning.review_card_requests
  WHERE id = (p_payload ->> 'requestId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_request.learning_profile_id::text IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR v_request.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR v_request.status <> 'generating'
     OR v_card ->> 'capabilityVersionId' IS DISTINCT FROM v_request.capability_version_id
     OR v_card -> 'source' IS DISTINCT FROM v_request.source_snapshot
     OR jsonb_typeof(v_card -> 'checks') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_card -> 'checks') = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_card -> 'checks') check_item
       WHERE check_item ->> 'passed' IS DISTINCT FROM 'true'
     )
     OR jsonb_typeof(p_payload -> 'modelRuns') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payload -> 'modelRuns') run
       WHERE run ->> 'succeeded' = 'true'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payload -> 'modelRuns') run
       WHERE run ->> 'authorizationDecisionId' IS DISTINCT FROM v_request.authorization_decision_id
          OR run ->> 'capabilityVersionId' IS DISTINCT FROM v_request.capability_version_id
     ) THEN RETURN 'conflict'; END IF;
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
    IF v_rejection_reason = 'CAPABILITY_CONTAINED' THEN RETURN 'capability_contained'; END IF;
    IF v_rejection_reason IN (
      'AUTHORIZATION_SCOPE_MISMATCH', 'AUTHORIZATION_STALE', 'ROUTE_NOT_AUTHORIZED',
      'SHADOW_PUBLICATION_FORBIDDEN'
    ) THEN RETURN 'capability_unavailable'; END IF;
    RAISE;
  END;
  v_source := v_request.source_snapshot;
  SELECT * INTO v_item FROM learning.wrong_items WHERE id = v_request.wrong_item_id FOR SHARE;
  IF NOT FOUND OR NOT learning.lock_current_wrong_item(v_item)
     OR v_item.state_revision <> (v_source ->> 'wrongItemStateRevision')::integer
     OR (v_item.classification ->> 'revision')::integer <> (v_source ->> 'classificationRevision')::integer
     OR v_item.theme_id IS DISTINCT FROM v_source ->> 'themeId' THEN RETURN 'source_changed'; END IF;
  IF NOT learning.authorize_generated_learning(
    v_request.learning_profile_id, v_request.family_space_id,
    (v_source ->> 'consentRevision')::integer, v_source ->> 'ageBand'
  ) THEN RETURN 'consent_withdrawn'; END IF;
  INSERT INTO learning.review_cards (
    id, request_id, family_space_id, learning_profile_id, wrong_item_id,
    capability_version_id, version, candidate, checks, source_snapshot,
    schedule, status, created_at
  ) VALUES (
    (v_card ->> 'id')::uuid, v_request.id, v_request.family_space_id,
    v_request.learning_profile_id, v_request.wrong_item_id,
    v_card ->> 'capabilityVersionId', (v_card ->> 'version')::integer,
    v_card -> 'candidate', v_card -> 'checks', v_card -> 'source',
    v_card -> 'schedule', 'active', (v_card ->> 'createdAt')::timestamptz
  );
  UPDATE learning.review_card_requests SET
    status = 'ready', current_card_id = (v_card ->> 'id')::uuid,
    latest_checks = v_card -> 'checks', model_runs = p_payload -> 'modelRuns',
    processing_lease_expires_at = NULL, state_revision = state_revision + 1,
    updated_at = (v_card ->> 'createdAt')::timestamptz
  WHERE id = v_request.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
    event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid, v_request.family_space_id, v_request.learning_profile_id,
    'review_card', (v_card ->> 'id')::uuid, 'review_card.published',
    jsonb_build_object('requestId', v_request.id, 'wrongItemId', v_request.wrong_item_id,
      'dueAt', v_card -> 'schedule' ->> 'dueAt'),
    (v_card ->> 'createdAt')::timestamptz
  );
  RETURN 'completed';
END
$$;

CREATE OR REPLACE FUNCTION learning.fail_review_card_request(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE v_request learning.review_card_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM learning.review_card_requests
  WHERE id = (p_payload ->> 'requestId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_request.learning_profile_id::text IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR v_request.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR v_request.status NOT IN ('queued', 'generating') THEN RETURN false; END IF;
  UPDATE learning.review_card_requests SET
    status = 'unavailable', unavailable_reason = p_payload ->> 'reason',
    latest_checks = p_payload -> 'latestChecks', model_runs = p_payload -> 'modelRuns',
    processing_lease_expires_at = NULL, state_revision = state_revision + 1,
    updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_request.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
    event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid, v_request.family_space_id, v_request.learning_profile_id,
    'review_card_request', v_request.id, 'review_card.generation_unavailable',
    jsonb_build_object('reason', p_payload ->> 'reason'),
    (p_payload ->> 'updatedAt')::timestamptz
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.invalidate_review_card(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE v_request learning.review_card_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM learning.review_card_requests
  WHERE id = (p_payload ->> 'requestId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_request.learning_profile_id::text IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR v_request.state_revision <> (p_payload ->> 'expectedStateRevision')::integer
     OR v_request.status <> 'ready' OR v_request.current_card_id IS NULL THEN RETURN false; END IF;
  UPDATE learning.review_cards SET status = 'stale' WHERE id = v_request.current_card_id;
  UPDATE learning.review_card_requests SET
    status = 'unavailable', unavailable_reason = p_payload ->> 'reason',
    rebuild_pending = true, state_revision = state_revision + 1,
    updated_at = (p_payload ->> 'updatedAt')::timestamptz
  WHERE id = v_request.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
    event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid, v_request.family_space_id, v_request.learning_profile_id,
    'review_card', v_request.current_card_id, 'review_card.rebuild_requested',
    jsonb_build_object('requestId', v_request.id, 'reason', p_payload ->> 'reason'),
    (p_payload ->> 'updatedAt')::timestamptz
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.create_short_review_session(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE v_created boolean;
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM current_setting('rhea.learning_profile_id', true)
     OR jsonb_array_length(p_payload -> 'cardIds') > 5
     OR jsonb_array_length(p_payload -> 'cardIds') IS DISTINCT FROM (
       SELECT count(DISTINCT value)::integer FROM jsonb_array_elements_text(p_payload -> 'cardIds')
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_payload -> 'cardIds') ids(id)
       LEFT JOIN learning.review_cards c ON c.id = ids.id::uuid
       WHERE c.id IS NULL OR c.learning_profile_id <> (p_payload ->> 'learningProfileId')::uuid OR c.status <> 'active'
     ) THEN RETURN false; END IF;
  INSERT INTO learning.short_review_sessions (id, learning_profile_id, card_ids, created_at)
  VALUES (
    (p_payload ->> 'id')::uuid, (p_payload ->> 'learningProfileId')::uuid,
    ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_payload -> 'cardIds')),
    (p_payload ->> 'createdAt')::timestamptz
  ) ON CONFLICT DO NOTHING RETURNING true INTO v_created;
  RETURN COALESCE(v_created, false);
END
$$;

CREATE OR REPLACE FUNCTION learning.record_review_card_attempt(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_attempt jsonb := p_payload -> 'attempt';
  v_card learning.review_cards%ROWTYPE;
  v_item learning.wrong_items%ROWTYPE;
  v_request learning.review_card_requests%ROWTYPE;
  v_session learning.short_review_sessions%ROWTYPE;
  v_source jsonb;
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM current_setting('rhea.learning_profile_id', true) THEN RETURN false; END IF;
  SELECT * INTO v_card FROM learning.review_cards WHERE id = (v_attempt ->> 'cardId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_card.learning_profile_id <> (p_payload ->> 'learningProfileId')::uuid OR v_card.status <> 'active' THEN RETURN false; END IF;
  SELECT * INTO v_request FROM learning.review_card_requests WHERE id = v_card.request_id;
  IF NOT FOUND OR v_request.status <> 'ready' THEN RETURN false; END IF;
  BEGIN
    PERFORM * FROM metrics.lock_current_family_capability_authorization(
      v_request.authorization_decision_id,
      v_request.capability_version_id,
      v_request.authorization_containment_epoch,
      encode(sha256(convert_to(v_request.family_space_id::text, 'UTF8')), 'hex'),
      'before_send',
      'primary'
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN false;
  END;
  v_source := v_card.source_snapshot;
  SELECT * INTO v_session FROM learning.short_review_sessions WHERE id = (v_attempt ->> 'sessionId')::uuid;
  IF NOT FOUND OR v_session.learning_profile_id <> v_card.learning_profile_id
     OR NOT (v_card.id = ANY(v_session.card_ids)) THEN RETURN false; END IF;
  SELECT * INTO v_item FROM learning.wrong_items WHERE id = v_card.wrong_item_id FOR SHARE;
  IF NOT FOUND OR NOT learning.lock_current_wrong_item(v_item)
     OR v_item.state_revision <> (v_source ->> 'wrongItemStateRevision')::integer
     OR (v_item.classification ->> 'revision')::integer <> (v_source ->> 'classificationRevision')::integer
     OR v_item.theme_id IS DISTINCT FROM v_source ->> 'themeId'
     OR NOT learning.authorize_generated_learning(
       v_card.learning_profile_id, v_card.family_space_id,
       (v_source ->> 'consentRevision')::integer, v_source ->> 'ageBand'
     ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM learning.review_card_attempts WHERE card_id = v_card.id AND idempotency_key = v_attempt ->> 'idempotencyKey') THEN RETURN true; END IF;
  IF v_card.schedule <> p_payload -> 'expectedSchedule' THEN RETURN false; END IF;
  INSERT INTO learning.review_card_attempts (
    id, session_id, card_id, learning_profile_id, idempotency_key, attempt, created_at
  ) VALUES (
    (v_attempt ->> 'id')::uuid, v_session.id, v_card.id, v_card.learning_profile_id,
    v_attempt ->> 'idempotencyKey', v_attempt, (v_attempt ->> 'createdAt')::timestamptz
  );
  UPDATE learning.review_cards SET schedule = v_attempt -> 'scheduleAfter' WHERE id = v_card.id;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
    event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid, v_card.family_space_id, v_card.learning_profile_id,
    'review_card', v_card.id, 'review_card.attempt_recorded',
    jsonb_build_object('attemptId', v_attempt ->> 'id', 'outcome', v_attempt ->> 'outcome',
      'hintLevel', v_attempt ->> 'hintLevel', 'nextDueAt', v_attempt -> 'scheduleAfter' ->> 'dueAt'),
    (v_attempt ->> 'createdAt')::timestamptz
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.create_review_card_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.claim_review_card_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.complete_review_card_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.fail_review_card_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.invalidate_review_card(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.create_short_review_session(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.record_review_card_attempt(jsonb) FROM PUBLIC;

ALTER TABLE learning.review_card_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.review_card_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.review_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.review_cards FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.short_review_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.short_review_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.review_card_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.review_card_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY review_card_requests_profile_isolation ON learning.review_card_requests
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY review_cards_profile_isolation ON learning.review_cards
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY short_review_sessions_profile_isolation ON learning.short_review_sessions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY review_card_attempts_profile_isolation ON learning.review_card_attempts
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

GRANT SELECT ON learning.review_card_requests, learning.review_cards,
  learning.short_review_sessions, learning.review_card_attempts
TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.authorize_generated_learning(uuid, uuid, integer, text)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.create_review_card_request(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.claim_review_card_request(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.complete_review_card_request(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.fail_review_card_request(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.invalidate_review_card(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.create_short_review_session(jsonb) TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.record_review_card_attempt(jsonb) TO rhea_learning_progress_app;
