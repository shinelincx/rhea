CREATE TABLE learning.wrong_item_theme_mastery (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  theme_id text NOT NULL CHECK (char_length(theme_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('active', 'mastered')),
  cycle integer NOT NULL CHECK (cycle > 0),
  policy_version text NOT NULL CHECK (policy_version = 'wrong-item-theme-mastery-v1'),
  opened_at timestamptz NOT NULL,
  mastered_at timestamptz,
  state_revision integer NOT NULL CHECK (state_revision > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (learning_profile_id, theme_id),
  UNIQUE (learning_profile_id, theme_id, family_space_id),
  CHECK (
    (status = 'active' AND mastered_at IS NULL)
    OR (status = 'mastered' AND mastered_at IS NOT NULL)
  )
);

CREATE TABLE learning.learning_evidence (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  theme_id text NOT NULL CHECK (char_length(theme_id) BETWEEN 1 AND 200),
  wrong_item_id uuid NOT NULL,
  cycle integer NOT NULL CHECK (cycle > 0),
  source_kind text NOT NULL CHECK (source_kind IN (
    'wrong_item_capture', 'immediate_correction', 'review_card_attempt'
  )),
  source_reference_id text NOT NULL CHECK (char_length(source_reference_id) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  hint_usage text NOT NULL CHECK (hint_usage IN (
    'none', 'orientation', 'method', 'full_answer'
  )),
  answer_exposure text NOT NULL CHECK (answer_exposure IN (
    'not_exposed', 'complete_answer_exposed_before_attempt'
  )),
  qualification text NOT NULL CHECK (qualification IN (
    'incorrect', 'assisted_success', 'independent_success'
  )),
  variation jsonb NOT NULL CHECK (jsonb_typeof(variation) = 'object'),
  learning_date date NOT NULL,
  source_versions jsonb NOT NULL CHECK (jsonb_typeof(source_versions) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, source_kind, source_reference_id),
  FOREIGN KEY (wrong_item_id, family_space_id, learning_profile_id)
    REFERENCES learning.wrong_items(id, family_space_id, learning_profile_id) ON DELETE CASCADE,
  FOREIGN KEY (learning_profile_id, theme_id, family_space_id)
    REFERENCES learning.wrong_item_theme_mastery(
      learning_profile_id, theme_id, family_space_id
    )
);

CREATE TABLE learning.theme_mastery_transitions (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  theme_id text NOT NULL CHECK (char_length(theme_id) BETWEEN 1 AND 200),
  cycle integer NOT NULL CHECK (cycle > 0),
  kind text NOT NULL CHECK (kind IN ('cycle_started', 'mastered', 'reopened')),
  reason text NOT NULL CHECK (reason IN (
    'first_error', 'new_error', 'classification_changed',
    'rule_satisfied', 'source_invalidated'
  )),
  from_status text CHECK (from_status IN ('active', 'mastered')),
  to_status text NOT NULL CHECK (to_status IN ('active', 'mastered')),
  trigger_key text NOT NULL CHECK (char_length(trigger_key) BETWEEN 1 AND 300),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, theme_id, trigger_key),
  FOREIGN KEY (learning_profile_id, theme_id, family_space_id)
    REFERENCES learning.wrong_item_theme_mastery(
      learning_profile_id, theme_id, family_space_id
    )
);

CREATE INDEX learning_evidence_theme_cycle_idx
  ON learning.learning_evidence (
    learning_profile_id, theme_id, cycle, learning_date, occurred_at, id
  );
CREATE INDEX theme_mastery_status_idx
  ON learning.wrong_item_theme_mastery (
    learning_profile_id, status, updated_at DESC, theme_id
  );
CREATE INDEX theme_mastery_history_idx
  ON learning.theme_mastery_transitions (
    learning_profile_id, theme_id, occurred_at, id
  );

CREATE OR REPLACE FUNCTION learning.register_wrong_item_theme(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_item learning.wrong_items%ROWTYPE;
  v_mastery learning.wrong_item_theme_mastery%ROWTYPE;
  v_occurred_at timestamptz := (p_payload ->> 'occurredAt')::timestamptz;
  v_reason text := p_payload ->> 'reason';
  v_transition_id uuid;
  v_trigger_key text := p_payload ->> 'triggerKey';
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR v_reason IS NULL OR v_reason NOT IN ('new_error', 'classification_changed')
     OR v_occurred_at IS NULL
     OR v_trigger_key IS NULL OR char_length(v_trigger_key) NOT BETWEEN 1 AND 300 THEN
    RETURN false;
  END IF;
  SELECT * INTO v_item
  FROM learning.wrong_items
  WHERE id = (p_payload ->> 'wrongItemId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
    AND theme_id = p_payload ->> 'themeId'
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_mastery
  FROM learning.wrong_item_theme_mastery
  WHERE learning_profile_id = v_item.learning_profile_id
    AND theme_id = v_item.theme_id
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO learning.wrong_item_theme_mastery (
      family_space_id, learning_profile_id, theme_id, status, cycle,
      policy_version, opened_at, mastered_at, state_revision, updated_at
    ) VALUES (
      v_item.family_space_id, v_item.learning_profile_id, v_item.theme_id,
      'active', 1, 'wrong-item-theme-mastery-v1', v_occurred_at, NULL, 1, v_occurred_at
    )
    ON CONFLICT (learning_profile_id, theme_id) DO NOTHING
    RETURNING * INTO v_mastery;
    IF FOUND THEN
      v_transition_id := gen_random_uuid();
      INSERT INTO learning.theme_mastery_transitions (
        id, family_space_id, learning_profile_id, theme_id, cycle, kind,
        reason, from_status, to_status, trigger_key, evidence_ids, occurred_at
      ) VALUES (
        v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
        v_item.theme_id, 1, 'cycle_started',
        CASE WHEN v_reason = 'classification_changed' THEN v_reason ELSE 'first_error' END,
        NULL, 'active', v_trigger_key, '{}', v_occurred_at
      );
    ELSE
      SELECT * INTO v_mastery
      FROM learning.wrong_item_theme_mastery
      WHERE learning_profile_id = v_item.learning_profile_id
        AND theme_id = v_item.theme_id
      FOR UPDATE;
    END IF;
  END IF;

  IF v_transition_id IS NULL AND EXISTS (
    SELECT 1 FROM learning.theme_mastery_transitions
    WHERE learning_profile_id = v_item.learning_profile_id
      AND theme_id = v_item.theme_id AND trigger_key = v_trigger_key
  ) THEN
    RETURN true;
  ELSIF v_transition_id IS NULL
      AND v_mastery.status = 'mastered'
      AND v_occurred_at > v_mastery.mastered_at THEN
    UPDATE learning.wrong_item_theme_mastery
    SET status = 'active', cycle = cycle + 1, opened_at = v_occurred_at,
        mastered_at = NULL, state_revision = state_revision + 1,
        updated_at = GREATEST(updated_at, v_occurred_at)
    WHERE learning_profile_id = v_item.learning_profile_id
      AND theme_id = v_item.theme_id
    RETURNING * INTO v_mastery;
    v_transition_id := gen_random_uuid();
    INSERT INTO learning.theme_mastery_transitions (
      id, family_space_id, learning_profile_id, theme_id, cycle, kind,
      reason, from_status, to_status, trigger_key, evidence_ids, occurred_at
    ) VALUES (
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      v_item.theme_id, v_mastery.cycle, 'reopened', v_reason,
      'mastered', 'active', v_trigger_key, '{}', v_occurred_at
    );
  END IF;

  IF v_transition_id IS NOT NULL THEN
    INSERT INTO learning.domain_outbox (
      id, family_space_id, learning_profile_id, aggregate_type,
      aggregate_id, event_type, payload, occurred_at
    )
    SELECT
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      'wrong_item_theme', v_transition_id,
      CASE recorded_transition.kind WHEN 'reopened' THEN 'wrong_item_theme.reopened'
           ELSE 'wrong_item_theme.cycle_started' END,
      jsonb_build_object('themeId', v_item.theme_id, 'reason', recorded_transition.reason),
      v_occurred_at
    FROM learning.theme_mastery_transitions recorded_transition
    WHERE recorded_transition.id = v_transition_id;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation
  OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION learning.record_learning_evidence(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_attempt jsonb;
  v_card learning.review_cards%ROWTYPE;
  v_expected_hint_usage text;
  v_expected_qualification text;
  v_expected_sources jsonb;
  v_existing learning.learning_evidence%ROWTYPE;
  v_item learning.wrong_items%ROWTYPE;
  v_mastered_at timestamptz;
  v_mastery learning.wrong_item_theme_mastery%ROWTYPE;
  v_occurred_at timestamptz := (p_payload ->> 'occurredAt')::timestamptz;
  v_source_kind text := p_payload ->> 'sourceKind';
  v_source_reference_id text := p_payload ->> 'sourceReferenceId';
  v_transition_id uuid;
  v_variation jsonb := p_payload -> 'variation';
  v_qualifying_ids uuid[];
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_payload ->> 'id' IS NULL
     OR v_occurred_at IS NULL
     OR v_source_reference_id IS NULL
     OR char_length(v_source_reference_id) NOT BETWEEN 1 AND 200
     OR COALESCE(v_source_kind IN (
       'wrong_item_capture', 'immediate_correction', 'review_card_attempt'
     ), false) = false
     OR COALESCE((p_payload ->> 'outcome') IN ('correct', 'incorrect'), false) = false
     OR COALESCE(
       (p_payload ->> 'hintUsage') IN ('none', 'orientation', 'method', 'full_answer'),
       false
     ) = false
     OR COALESCE((p_payload ->> 'answerExposure') IN (
       'not_exposed', 'complete_answer_exposed_before_attempt'
     ), false) = false
     OR jsonb_typeof(v_variation) IS DISTINCT FROM 'object'
     OR COALESCE((v_variation ->> 'kind') IN ('original', 'ai_checked_rewrite'), false) = false
     OR jsonb_typeof(v_variation -> 'differsFromOriginal') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_variation -> 'generationCheckPassed') IS DISTINCT FROM 'boolean'
     OR COALESCE(v_variation ->> 'questionContentHash' ~ '^[0-9a-f]{64}$', false) = false
     OR COALESCE(v_variation ->> 'sourceQuestionContentHash' ~ '^[0-9a-f]{64}$', false) = false
     OR jsonb_typeof(p_payload -> 'sourceVersions') IS DISTINCT FROM 'object'
     OR (p_payload ->> 'learningDate')::date IS DISTINCT FROM
       (v_occurred_at AT TIME ZONE 'Asia/Shanghai')::date
     OR p_payload ->> 'recordedAt' IS NULL
     OR (p_payload ->> 'recordedAt')::timestamptz < v_occurred_at THEN
    RETURN false;
  END IF;

  SELECT * INTO v_item
  FROM learning.wrong_items
  WHERE id = (p_payload ->> 'wrongItemId')::uuid
    AND family_space_id = (p_payload ->> 'familySpaceId')::uuid
    AND learning_profile_id = (p_payload ->> 'learningProfileId')::uuid;
  IF NOT FOUND THEN RETURN false; END IF;

  v_expected_qualification := CASE
    WHEN p_payload ->> 'outcome' = 'incorrect' THEN 'incorrect'
    WHEN v_source_kind = 'review_card_attempt'
      AND p_payload ->> 'hintUsage' = 'none'
      AND p_payload ->> 'answerExposure' = 'not_exposed'
      AND v_variation ->> 'kind' = 'ai_checked_rewrite'
      AND (v_variation ->> 'differsFromOriginal')::boolean
      AND (v_variation ->> 'generationCheckPassed')::boolean
      THEN 'independent_success'
    ELSE 'assisted_success'
  END;
  IF p_payload ->> 'qualification' IS DISTINCT FROM v_expected_qualification THEN
    RETURN false;
  END IF;

  IF v_source_kind = 'review_card_attempt' THEN
    SELECT c.* INTO v_card
    FROM learning.review_card_attempts a
    JOIN learning.review_cards c ON c.id = a.card_id
    WHERE a.id = v_source_reference_id::uuid
      AND a.learning_profile_id = v_item.learning_profile_id
      AND c.wrong_item_id = v_item.id;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT a.attempt INTO v_attempt
    FROM learning.review_card_attempts a
    WHERE a.id = v_source_reference_id::uuid
      AND a.learning_profile_id = v_item.learning_profile_id
      AND a.card_id = v_card.id;
    IF NOT FOUND THEN RETURN false; END IF;
    v_expected_hint_usage := CASE (v_attempt ->> 'hintLevel')::integer
      WHEN 0 THEN 'none'
      WHEN 1 THEN 'orientation'
      WHEN 2 THEN 'method'
      ELSE NULL
    END;
    IF v_attempt ->> 'outcome' IS DISTINCT FROM p_payload ->> 'outcome'
       OR (v_attempt ->> 'createdAt')::timestamptz IS DISTINCT FROM v_occurred_at
       OR p_payload ->> 'hintUsage' IS DISTINCT FROM v_expected_hint_usage
       OR v_card.source_snapshot ->> 'themeId' IS DISTINCT FROM p_payload ->> 'themeId'
       OR v_variation ->> 'kind' <> 'ai_checked_rewrite'
       OR NOT (v_variation ->> 'differsFromOriginal')::boolean
       OR NOT (v_variation ->> 'generationCheckPassed')::boolean
       OR v_card.candidate ->> 'question' IS NOT DISTINCT FROM
         v_card.source_snapshot ->> 'originalQuestion'
       OR v_variation ->> 'sourceQuestionContentHash' IS DISTINCT FROM
         v_card.source_snapshot ->> 'originalQuestionContentHash'
       OR v_variation ->> 'questionContentHash' IS DISTINCT FROM encode(
         sha256(convert_to(to_jsonb(v_card.candidate ->> 'question')::text, 'UTF8')),
         'hex'
       )
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_card.checks) check_item
         WHERE check_item ->> 'kind' = 'rewrite'
           AND check_item ->> 'passed' = 'true'
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_card.checks) check_item
         WHERE check_item ->> 'passed' IS DISTINCT FROM 'true'
       ) THEN
      RETURN false;
    END IF;
    v_expected_sources := jsonb_build_object(
      'assessmentVersionId', v_card.source_snapshot ->> 'assessmentVersionId',
      'basis', jsonb_build_object(
        'contentHash', v_card.source_snapshot -> 'basis' ->> 'contentHash',
        'selectionVersion', (v_card.source_snapshot -> 'basis' ->> 'selectionVersion')::integer,
        'sourceVersionId', v_card.source_snapshot -> 'basis' ->> 'sourceVersionId',
        'validityEpoch', (v_card.source_snapshot -> 'basis' ->> 'validityEpoch')::integer
      ),
      'capabilityVersionId', v_card.capability_version_id,
      'classificationRevision', (v_card.source_snapshot ->> 'classificationRevision')::integer,
      'gradingRuleVersionId', v_card.source_snapshot ->> 'gradingRuleVersionId',
      'questionContentHash', v_card.source_snapshot ->> 'originalQuestionContentHash',
      'questionVersionId', v_card.source_snapshot ->> 'originalQuestionVersionId',
      'responseContentHash', v_card.source_snapshot ->> 'originalResponseContentHash',
      'responseVersionId', v_card.source_snapshot ->> 'originalResponseVersionId',
      'reviewCardId', v_card.id::text,
      'reviewCardVersion', v_card.version,
      'wrongItemStateRevision', (v_card.source_snapshot ->> 'wrongItemStateRevision')::integer
    );
  ELSE
    IF v_item.theme_id IS DISTINCT FROM p_payload ->> 'themeId' THEN RETURN false; END IF;
    IF v_source_kind = 'wrong_item_capture' THEN
      IF v_source_reference_id IS DISTINCT FROM v_item.id::text
         OR p_payload ->> 'outcome' <> 'incorrect'
         OR p_payload ->> 'hintUsage' <> 'none'
         OR v_variation ->> 'kind' <> 'original'
         OR (v_variation ->> 'differsFromOriginal')::boolean
         OR (v_variation ->> 'generationCheckPassed')::boolean
         OR v_occurred_at IS DISTINCT FROM v_item.first_incorrect_at THEN
        RETURN false;
      END IF;
    ELSE
      SELECT jsonb_build_object(
        'createdAt', created_at,
        'outcome', outcome
      ) INTO v_attempt
      FROM learning.immediate_correction_attempts
      WHERE id = v_source_reference_id::uuid
        AND wrong_item_id = v_item.id
        AND learning_profile_id = v_item.learning_profile_id;
      IF NOT FOUND
         OR v_attempt ->> 'outcome' IS DISTINCT FROM p_payload ->> 'outcome'
         OR (v_attempt ->> 'createdAt')::timestamptz IS DISTINCT FROM v_occurred_at
         OR p_payload ->> 'hintUsage' <> 'full_answer'
         OR p_payload ->> 'answerExposure' <> 'complete_answer_exposed_before_attempt'
         OR v_variation ->> 'kind' <> 'original'
         OR (v_variation ->> 'differsFromOriginal')::boolean
         OR (v_variation ->> 'generationCheckPassed')::boolean THEN
        RETURN false;
      END IF;
    END IF;
    IF v_variation ->> 'questionContentHash' IS DISTINCT FROM
         v_item.assessment_snapshot -> 'question' ->> 'contentHash'
       OR v_variation ->> 'sourceQuestionContentHash' IS DISTINCT FROM
         v_item.assessment_snapshot -> 'question' ->> 'contentHash' THEN
      RETURN false;
    END IF;
    v_expected_sources := jsonb_build_object(
      'assessmentVersionId', v_item.assessment_snapshot ->> 'assessmentVersionId',
      'basis', jsonb_build_object(
        'contentHash', v_item.assessment_snapshot -> 'basis' ->> 'contentHash',
        'selectionVersion', (v_item.assessment_snapshot -> 'basis' ->> 'selectionVersion')::integer,
        'sourceVersionId', v_item.assessment_snapshot -> 'basis' ->> 'sourceVersionId',
        'validityEpoch', (v_item.assessment_snapshot -> 'basis' ->> 'validityEpoch')::integer
      ),
      'capabilityVersionId', NULL,
      'classificationRevision', (v_item.classification ->> 'revision')::integer,
      'gradingRuleVersionId', v_item.assessment_snapshot -> 'correctBasis' ->> 'gradingRuleVersionId',
      'questionContentHash', v_item.assessment_snapshot -> 'question' ->> 'contentHash',
      'questionVersionId', v_item.assessment_snapshot -> 'question' ->> 'versionId',
      'responseContentHash', v_item.assessment_snapshot -> 'response' ->> 'contentHash',
      'responseVersionId', v_item.assessment_snapshot -> 'response' ->> 'versionId',
      'reviewCardId', NULL,
      'reviewCardVersion', NULL,
      'wrongItemStateRevision', CASE WHEN v_source_kind = 'immediate_correction'
        THEN v_item.state_revision - 1 ELSE v_item.state_revision END
    );
  END IF;
  IF p_payload -> 'sourceVersions' IS DISTINCT FROM v_expected_sources THEN RETURN false; END IF;

  SELECT * INTO v_existing
  FROM learning.learning_evidence
  WHERE learning_profile_id = v_item.learning_profile_id
    AND source_kind = v_source_kind
    AND source_reference_id = v_source_reference_id;
  IF FOUND THEN RETURN v_existing.id = (p_payload ->> 'id')::uuid; END IF;

  SELECT * INTO v_mastery
  FROM learning.wrong_item_theme_mastery
  WHERE learning_profile_id = v_item.learning_profile_id
    AND theme_id = p_payload ->> 'themeId'
  FOR UPDATE;
  IF NOT FOUND OR v_mastery.family_space_id <> v_item.family_space_id THEN RETURN false; END IF;

  SELECT * INTO v_existing
  FROM learning.learning_evidence
  WHERE learning_profile_id = v_item.learning_profile_id
    AND source_kind = v_source_kind
    AND source_reference_id = v_source_reference_id;
  IF FOUND THEN RETURN v_existing.id = (p_payload ->> 'id')::uuid; END IF;

  IF v_mastery.status = 'mastered'
     AND p_payload ->> 'outcome' = 'incorrect'
     AND v_occurred_at > v_mastery.mastered_at THEN
    UPDATE learning.wrong_item_theme_mastery
    SET status = 'active', cycle = cycle + 1, opened_at = v_occurred_at,
        mastered_at = NULL, state_revision = state_revision + 1,
        updated_at = GREATEST(updated_at, v_occurred_at)
    WHERE learning_profile_id = v_item.learning_profile_id
      AND theme_id = v_mastery.theme_id
    RETURNING * INTO v_mastery;
    v_transition_id := gen_random_uuid();
    INSERT INTO learning.theme_mastery_transitions (
      id, family_space_id, learning_profile_id, theme_id, cycle, kind,
      reason, from_status, to_status, trigger_key, evidence_ids, occurred_at
    ) VALUES (
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      v_mastery.theme_id, v_mastery.cycle, 'reopened', 'new_error',
      'mastered', 'active', 'evidence:' || (p_payload ->> 'id') || ':incorrect',
      '{}', v_occurred_at
    );
    INSERT INTO learning.domain_outbox (
      id, family_space_id, learning_profile_id, aggregate_type,
      aggregate_id, event_type, payload, occurred_at
    ) VALUES (
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      'wrong_item_theme', v_transition_id, 'wrong_item_theme.reopened',
      jsonb_build_object('themeId', v_mastery.theme_id, 'cycle', v_mastery.cycle,
        'reason', 'new_error'), v_occurred_at
    );
  END IF;

  INSERT INTO learning.learning_evidence (
    id, family_space_id, learning_profile_id, theme_id, wrong_item_id, cycle,
    source_kind, source_reference_id, outcome, hint_usage, answer_exposure,
    qualification, variation, learning_date, source_versions, occurred_at, recorded_at
  ) VALUES (
    (p_payload ->> 'id')::uuid, v_item.family_space_id, v_item.learning_profile_id,
    p_payload ->> 'themeId', v_item.id, v_mastery.cycle,
    v_source_kind, v_source_reference_id, p_payload ->> 'outcome',
    p_payload ->> 'hintUsage', p_payload ->> 'answerExposure', v_expected_qualification,
    v_variation, (p_payload ->> 'learningDate')::date, p_payload -> 'sourceVersions',
    v_occurred_at, (p_payload ->> 'recordedAt')::timestamptz
  );
  UPDATE learning.wrong_item_theme_mastery
  SET state_revision = state_revision + 1,
      updated_at = GREATEST(updated_at, v_occurred_at)
  WHERE learning_profile_id = v_item.learning_profile_id
    AND theme_id = p_payload ->> 'themeId'
  RETURNING * INTO v_mastery;
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'id')::uuid, v_item.family_space_id, v_item.learning_profile_id,
    'learning_evidence', (p_payload ->> 'id')::uuid, 'learning_evidence.recorded',
    jsonb_build_object('themeId', p_payload ->> 'themeId', 'cycle', v_mastery.cycle,
      'sourceKind', v_source_kind, 'qualification', v_expected_qualification),
    v_occurred_at
  );

  IF v_mastery.status = 'active'
     AND (
       SELECT count(DISTINCT learning_date) >= 2
       FROM learning.learning_evidence
       WHERE learning_profile_id = v_item.learning_profile_id
         AND theme_id = v_mastery.theme_id
         AND cycle = v_mastery.cycle
         AND qualification = 'independent_success'
     )
     AND EXISTS (
       SELECT 1 FROM learning.learning_evidence
       WHERE learning_profile_id = v_item.learning_profile_id
         AND theme_id = v_mastery.theme_id
         AND cycle = v_mastery.cycle
         AND qualification = 'independent_success'
         AND variation ->> 'kind' = 'ai_checked_rewrite'
         AND (variation ->> 'differsFromOriginal')::boolean
         AND (variation ->> 'generationCheckPassed')::boolean
     ) THEN
    SELECT array_agg(id ORDER BY occurred_at, id), max(occurred_at)
    INTO v_qualifying_ids, v_mastered_at
    FROM learning.learning_evidence
    WHERE learning_profile_id = v_item.learning_profile_id
      AND theme_id = v_mastery.theme_id
      AND cycle = v_mastery.cycle
      AND qualification = 'independent_success';
    UPDATE learning.wrong_item_theme_mastery
    SET status = 'mastered', mastered_at = v_mastered_at,
        state_revision = state_revision + 1,
        updated_at = GREATEST(updated_at, v_mastered_at)
    WHERE learning_profile_id = v_item.learning_profile_id
      AND theme_id = v_mastery.theme_id;
    v_transition_id := gen_random_uuid();
    INSERT INTO learning.theme_mastery_transitions (
      id, family_space_id, learning_profile_id, theme_id, cycle, kind,
      reason, from_status, to_status, trigger_key, evidence_ids, occurred_at
    ) VALUES (
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      v_mastery.theme_id, v_mastery.cycle, 'mastered', 'rule_satisfied',
      'active', 'mastered', 'mastered:' || v_mastery.cycle::text,
      v_qualifying_ids, v_mastered_at
    );
    INSERT INTO learning.domain_outbox (
      id, family_space_id, learning_profile_id, aggregate_type,
      aggregate_id, event_type, payload, occurred_at
    ) VALUES (
      v_transition_id, v_item.family_space_id, v_item.learning_profile_id,
      'wrong_item_theme', v_transition_id, 'wrong_item_theme.mastered',
      jsonb_build_object('themeId', v_mastery.theme_id, 'cycle', v_mastery.cycle,
        'evidenceIds', to_jsonb(v_qualifying_ids)), v_mastered_at
    );
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation
  OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION learning.reopen_wrong_item_theme_source(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_mastery learning.wrong_item_theme_mastery%ROWTYPE;
  v_occurred_at timestamptz := (p_payload ->> 'occurredAt')::timestamptz;
  v_previous_status text;
  v_transition_id uuid;
  v_trigger_key text := p_payload ->> 'triggerKey';
BEGIN
  IF p_payload ->> 'learningProfileId' IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR v_occurred_at IS NULL
     OR v_trigger_key IS NULL OR char_length(v_trigger_key) NOT BETWEEN 1 AND 300 THEN
    RETURN false;
  END IF;
  SELECT * INTO v_mastery
  FROM learning.wrong_item_theme_mastery
  WHERE learning_profile_id = (p_payload ->> 'learningProfileId')::uuid
    AND theme_id = p_payload ->> 'themeId'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM learning.theme_mastery_transitions
    WHERE learning_profile_id = v_mastery.learning_profile_id
      AND theme_id = v_mastery.theme_id AND trigger_key = v_trigger_key
  ) THEN RETURN true; END IF;
  v_previous_status := v_mastery.status;
  UPDATE learning.wrong_item_theme_mastery
  SET status = 'active', cycle = cycle + 1, opened_at = v_occurred_at,
      mastered_at = NULL, state_revision = state_revision + 1,
      updated_at = GREATEST(updated_at, v_occurred_at)
  WHERE learning_profile_id = v_mastery.learning_profile_id
    AND theme_id = v_mastery.theme_id
  RETURNING * INTO v_mastery;
  v_transition_id := gen_random_uuid();
  INSERT INTO learning.theme_mastery_transitions (
    id, family_space_id, learning_profile_id, theme_id, cycle, kind,
    reason, from_status, to_status, trigger_key, evidence_ids, occurred_at
  ) VALUES (
    v_transition_id, v_mastery.family_space_id, v_mastery.learning_profile_id,
    v_mastery.theme_id, v_mastery.cycle, 'reopened', 'source_invalidated',
    v_previous_status, 'active', v_trigger_key, '{}', v_occurred_at
  );
  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    v_transition_id, v_mastery.family_space_id, v_mastery.learning_profile_id,
    'wrong_item_theme', v_transition_id, 'wrong_item_theme.reopened',
    jsonb_build_object('themeId', v_mastery.theme_id, 'cycle', v_mastery.cycle,
      'reason', 'source_invalidated'), v_occurred_at
  );
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation
  OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION learning.register_wrong_item_theme(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.record_learning_evidence(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.reopen_wrong_item_theme_source(jsonb) FROM PUBLIC;

ALTER TABLE learning.wrong_item_theme_mastery ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.wrong_item_theme_mastery FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.theme_mastery_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.theme_mastery_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY wrong_item_theme_mastery_profile_isolation
  ON learning.wrong_item_theme_mastery
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_evidence_profile_isolation ON learning.learning_evidence
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY theme_mastery_transitions_profile_isolation
  ON learning.theme_mastery_transitions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

GRANT SELECT ON learning.wrong_item_theme_mastery,
  learning.learning_evidence, learning.theme_mastery_transitions
TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.register_wrong_item_theme(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.record_learning_evidence(jsonb)
  TO rhea_learning_progress_app;
GRANT EXECUTE ON FUNCTION learning.reopen_wrong_item_theme_source(jsonb)
  TO rhea_learning_progress_app;
