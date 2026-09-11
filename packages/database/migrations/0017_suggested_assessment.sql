ALTER TABLE learning.learning_access_audit
  DROP CONSTRAINT learning_access_audit_actor_type_check;
ALTER TABLE learning.learning_access_audit
  ADD CONSTRAINT learning_access_audit_actor_type_check
  CHECK (actor_type IN ('guardian', 'learner', 'professional'));

CREATE TABLE learning.open_assessment_rubric_versions (
  id text NOT NULL CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  version text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 100),
  learning_profile_id uuid,
  material_id uuid,
  confirmed_content_version_id uuid,
  question_region_id text,
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  task_type text NOT NULL CHECK (task_type IN (
    'chinese_expression', 'mathematics_process', 'english_expression', 'science_inquiry'
  )),
  age_band text NOT NULL CHECK (age_band IN (
    'lower_primary', 'middle_primary', 'upper_primary'
  )),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  source_authority text NOT NULL CHECK (source_authority IN (
    'teacher', 'formal_exam', 'rhea_professionally_reviewed'
  )),
  source_label text NOT NULL CHECK (length(btrim(source_label)) BETWEEN 1 AND 300),
  dimensions jsonb NOT NULL CHECK (
    jsonb_typeof(dimensions) = 'array' AND jsonb_array_length(dimensions) BETWEEN 1 AND 12
  ),
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CHECK ((learning_profile_id IS NULL) = (material_id IS NULL)),
  CHECK (confirmed_content_version_id IS NULL OR material_id IS NOT NULL),
  CHECK (question_region_id IS NULL OR confirmed_content_version_id IS NOT NULL)
);

CREATE INDEX open_assessment_rubric_lookup_idx
  ON learning.open_assessment_rubric_versions (
    subject, task_type, age_band, active, source_authority, reviewed_at DESC
  );

WITH templates(subject, task_type, name, dimensions) AS (
  VALUES
    (
      'chinese',
      'chinese_expression',
      '语文表达评分量规',
      '[
        {"key":"task_completion","label":"任务理解与完成","description":"回应题目要求，不遗漏必要任务。","required":true},
        {"key":"content_evidence","label":"内容证据","description":"写出具体内容；阅读任务引用材料中可核对的信息。","required":true},
        {"key":"reasoning_organization","label":"推理与组织","description":"阅读任务给出推理或概括；写作任务让内容有顺序和联系。","required":true},
        {"key":"expression_clarity","label":"表达清楚","description":"使用与年龄层级相符的清楚、完整语句表达。","required":true}
      ]'::jsonb
    ),
    (
      'mathematics',
      'mathematics_process',
      '数学过程评分量规',
      '[
        {"key":"strategy","label":"策略","description":"选择与题意相符且允许多种正确路径的策略。","required":true},
        {"key":"key_steps","label":"关键步骤","description":"写出足以核对解题过程的关键步骤。","required":true},
        {"key":"consistency","label":"一致性","description":"中间结果与最终结果前后一致。","required":true},
        {"key":"explanation","label":"解释","description":"说明关键步骤为什么成立。","required":true},
        {"key":"unit_representation","label":"单位与表示","description":"按题意正确使用单位、符号、图或其他表示。","required":true}
      ]'::jsonb
    ),
    (
      'english',
      'english_expression',
      '英语表达评分量规',
      '[
        {"key":"task_meaning","label":"任务与意思","description":"完成题目任务并表达可理解的主要意思。","required":true},
        {"key":"vocabulary_grammar","label":"词汇与语法","description":"使用与年龄层级相符且能传达意思的词汇和语法。","required":true},
        {"key":"organization","label":"组织","description":"按可理解的顺序组织句子和信息。","required":true}
      ]'::jsonb
    ),
    (
      'science',
      'science_inquiry',
      '科学探究评分量规',
      '[
        {"key":"observation","label":"观察记录","description":"记录可观察、可核对的现象或变化。","required":true},
        {"key":"evidence","label":"证据","description":"区分观察到的证据和自己的解释。","required":true},
        {"key":"variables_conditions","label":"变量与条件","description":"说明相关变量、条件或比较方式。","required":true},
        {"key":"reasoning","label":"推理","description":"用观察证据支持推理过程。","required":true},
        {"key":"conclusion","label":"结论","description":"结论回应问题，且不超出已有证据。","required":true},
        {"key":"safety","label":"安全意识","description":"仅在题目或量规明确要求时描述安全注意事项，不从照片断言规范操作。","required":false}
      ]'::jsonb
    )
), age_bands(age_band, suffix) AS (
  VALUES
    ('lower_primary', 'lower-primary'),
    ('middle_primary', 'middle-primary'),
    ('upper_primary', 'upper-primary')
)
INSERT INTO learning.open_assessment_rubric_versions (
  id, version, subject, task_type, age_band, name, source_authority,
  source_label, dimensions, reviewed_by, reviewed_at
)
SELECT
  'rhea-' || templates.task_type || '-' || age_bands.suffix,
  '2.0.0',
  templates.subject,
  templates.task_type,
  age_bands.age_band,
  templates.name,
  'rhea_professionally_reviewed',
  'Rhea 学科组审核模板',
  templates.dimensions,
  'rhea-curriculum-review-board',
  '2026-09-01T00:00:00.000Z'::timestamptz
FROM templates CROSS JOIN age_bands;

CREATE TABLE learning.suggested_assessments (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  family_space_hash text NOT NULL CHECK (family_space_hash ~ '^[0-9a-f]{64}$'),
  learning_profile_id uuid NOT NULL,
  material_id uuid NOT NULL,
  deduplication_key text NOT NULL CHECK (deduplication_key ~ '^[0-9a-f]{64}$'),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  age_band text NOT NULL CHECK (age_band IN (
    'lower_primary', 'middle_primary', 'upper_primary'
  )),
  consent_revision integer NOT NULL CHECK (consent_revision > 0),
  task_type text NOT NULL CHECK (task_type IN (
    'chinese_expression', 'mathematics_process', 'english_expression', 'science_inquiry'
  )),
  input_reference jsonb NOT NULL CHECK (jsonb_typeof(input_reference) = 'object'),
  basis jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  question jsonb NOT NULL CHECK (jsonb_typeof(question) = 'object'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  rubric jsonb,
  requires_professional_review boolean NOT NULL,
  authorization_snapshot jsonb,
  authorization_decision_id text,
  authorization_containment_epoch bigint,
  capability_version_id text,
  capability_snapshot jsonb,
  model_run jsonb,
  suggestion jsonb,
  processing_lease_expires_at timestamptz,
  status text NOT NULL CHECK (status IN (
    'queued', 'generating', 'pending_review', 'accepted', 'rejected', 'unavailable'
  )),
  unavailable_reason text CHECK (unavailable_reason IN (
    'CAPABILITY_UNAVAILABLE', 'CONSENT_WITHDRAWN', 'LOW_CONFIDENCE', 'MODEL_UNAVAILABLE',
    'RUBRIC_REQUIRED', 'SOURCE_CHANGED'
  )),
  state_revision integer NOT NULL CHECK (state_revision >= 1),
  review jsonb,
  accepted_result jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, deduplication_key),
  FOREIGN KEY (material_id, family_space_id, learning_profile_id)
    REFERENCES learning.learning_materials(id, family_space_id, learning_profile_id),
  FOREIGN KEY (
    authorization_decision_id, capability_version_id,
    authorization_containment_epoch, family_space_hash
  ) REFERENCES metrics.authorization_decisions(
    id, primary_version_id, containment_epoch, family_space_hash
  ),
  CHECK (
    (capability_version_id IS NULL AND capability_snapshot IS NULL)
    OR (capability_version_id IS NOT NULL AND capability_snapshot IS NOT NULL)
  ),
  CHECK (
    (status = 'queued' AND suggestion IS NULL AND model_run IS NULL
      AND processing_lease_expires_at IS NULL AND review IS NULL
      AND accepted_result IS NULL AND unavailable_reason IS NULL)
    OR (status = 'generating' AND suggestion IS NULL
      AND processing_lease_expires_at IS NOT NULL AND review IS NULL
      AND accepted_result IS NULL AND unavailable_reason IS NULL)
    OR (status = 'pending_review' AND suggestion IS NOT NULL AND model_run IS NOT NULL
      AND processing_lease_expires_at IS NULL AND review IS NULL
      AND accepted_result IS NULL AND unavailable_reason IS NULL)
    OR (status = 'accepted' AND suggestion IS NOT NULL AND review IS NOT NULL
      AND accepted_result IS NOT NULL AND unavailable_reason IS NULL)
    OR (status = 'rejected' AND suggestion IS NOT NULL AND review IS NOT NULL
      AND accepted_result IS NULL AND unavailable_reason IS NULL)
    OR (status = 'unavailable' AND suggestion IS NULL AND review IS NULL
      AND accepted_result IS NULL AND unavailable_reason IS NOT NULL)
  )
);

CREATE INDEX suggested_assessments_profile_status_idx
  ON learning.suggested_assessments (learning_profile_id, status, updated_at DESC, id);
CREATE INDEX suggested_assessments_material_idx
  ON learning.suggested_assessments (material_id, updated_at DESC, id);

CREATE OR REPLACE FUNCTION learning.resolve_open_assessment_input(
  p_learning_profile_id uuid,
  p_material_id uuid,
  p_processing_job_id uuid,
  p_confirmed_content_version_id uuid,
  p_question_region_id text,
  p_response_region_id text,
  p_basis_source_version_id uuid,
  p_basis_selection_version integer,
  p_basis_validity_epoch integer,
  p_age_band text,
  p_task_type text
) RETURNS TABLE (
  question_text text,
  response_text text,
  subject text,
  rubric jsonb,
  requires_professional_review boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    confirmed.question_text,
    confirmed.response_text,
    basis.subject,
    CASE WHEN selected.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', selected.id,
      'version', selected.version,
      'subject', selected.subject,
      'taskType', selected.task_type,
      'ageBand', selected.age_band,
      'name', selected.name,
      'source', jsonb_build_object(
        'authority', selected.source_authority,
        'label', selected.source_label
      ),
      'dimensions', selected.dimensions
    ) END,
    basis.requires_professional_review
      OR COALESCE(selected.source_authority = 'formal_exam', false)
      OR EXISTS (
        SELECT 1
        FROM learning.objective_assessment_versions prior_version
        JOIN learning.objective_assessments prior
          ON prior.id = prior_version.assessment_id
        JOIN learning.assessment_disputes dispute
          ON dispute.assessment_id = prior.id
        WHERE prior.learning_profile_id = p_learning_profile_id
          AND prior_version.input_reference ->> 'confirmedContentVersionId' =
            p_confirmed_content_version_id::text
          AND prior_version.input_reference ->> 'questionRegionId' = p_question_region_id
        GROUP BY prior.id
        HAVING count(dispute.id) >= 2
      )
  FROM learning.resolve_objective_assessment_basis(
    p_learning_profile_id,
    p_material_id,
    p_confirmed_content_version_id,
    p_basis_source_version_id,
    p_basis_selection_version,
    p_basis_validity_epoch
  ) basis
  CROSS JOIN learning.resolve_confirmed_objective_regions(
    p_learning_profile_id,
    p_processing_job_id,
    p_confirmed_content_version_id,
    p_question_region_id,
    p_response_region_id
  ) confirmed
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM learning.open_assessment_rubric_versions candidate
    WHERE candidate.active
      AND candidate.subject = basis.subject
      AND candidate.task_type = p_task_type
      AND candidate.age_band = p_age_band
      AND (candidate.learning_profile_id IS NULL
        OR candidate.learning_profile_id = p_learning_profile_id)
      AND (candidate.material_id IS NULL OR candidate.material_id = p_material_id)
      AND (candidate.confirmed_content_version_id IS NULL
        OR candidate.confirmed_content_version_id = p_confirmed_content_version_id)
      AND (candidate.question_region_id IS NULL
        OR candidate.question_region_id = p_question_region_id)
    ORDER BY
      CASE candidate.source_authority
        WHEN 'teacher' THEN 1
        WHEN 'formal_exam' THEN 2
        ELSE 3
      END,
      (candidate.learning_profile_id IS NOT NULL) DESC,
      candidate.reviewed_at DESC,
      candidate.id
    LIMIT 1
  ) selected ON true
$$;

REVOKE ALL ON FUNCTION learning.resolve_open_assessment_input(
  uuid, uuid, uuid, uuid, text, text, uuid, integer, integer, text, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.create_suggested_assessment(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_basis jsonb := p_payload -> 'basis';
  v_created boolean;
  v_family_space_id uuid := (p_payload ->> 'familySpaceId')::uuid;
  v_learning_profile_id uuid := (p_payload ->> 'learningProfileId')::uuid;
  v_material_id uuid := (p_payload ->> 'materialId')::uuid;
  v_status text := p_payload ->> 'status';
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR v_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR v_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true)
     OR v_status NOT IN ('queued', 'unavailable') THEN
    RETURN false;
  END IF;
  IF learning.lock_current_generated_learning_eligibility(
    v_learning_profile_id,
    v_family_space_id,
    (p_payload ->> 'consentRevision')::integer,
    p_payload ->> 'ageBand'
  ) <> 'authorized' THEN
    RETURN false;
  END IF;
  IF NOT learning.lock_current_assessment_basis(
    v_learning_profile_id,
    v_material_id,
    (v_basis ->> 'sourceVersionId')::uuid,
    (v_basis ->> 'selectionVersion')::integer,
    (v_basis ->> 'validityEpoch')::integer,
    v_basis ->> 'contentHash',
    v_basis ->> 'kind',
    v_basis ->> 'versionLabel'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO learning.suggested_assessments (
    id, family_space_id, family_space_hash, learning_profile_id, material_id,
    deduplication_key, actor, age_band, consent_revision, task_type,
    input_reference, basis, question, response, rubric,
    requires_professional_review, authorization_snapshot,
    authorization_decision_id, authorization_containment_epoch,
    capability_version_id, capability_snapshot, model_run, suggestion,
    processing_lease_expires_at,
    status, unavailable_reason, state_revision, review, accepted_result,
    created_at, updated_at
  ) VALUES (
    (p_payload ->> 'id')::uuid,
    v_family_space_id,
    p_payload ->> 'familySpaceHash',
    v_learning_profile_id,
    v_material_id,
    p_payload ->> 'deduplicationKey',
    p_payload -> 'actor',
    p_payload ->> 'ageBand',
    (p_payload ->> 'consentRevision')::integer,
    p_payload ->> 'taskType',
    p_payload -> 'inputReference',
    v_basis,
    p_payload -> 'question',
    p_payload -> 'response',
    NULLIF(p_payload -> 'rubric', 'null'::jsonb),
    (p_payload ->> 'requiresProfessionalReview')::boolean,
    NULLIF(p_payload -> 'authorization', 'null'::jsonb),
    p_payload ->> 'authorizationDecisionId',
    (p_payload ->> 'authorizationContainmentEpoch')::bigint,
    p_payload ->> 'capabilityVersionId',
    NULLIF(p_payload -> 'capability', 'null'::jsonb),
    NULLIF(p_payload -> 'modelRun', 'null'::jsonb),
    NULLIF(p_payload -> 'suggestion', 'null'::jsonb),
    NULL,
    v_status,
    p_payload ->> 'unavailableReason',
    1,
    NULL,
    NULL,
    (p_payload ->> 'createdAt')::timestamptz,
    (p_payload ->> 'updatedAt')::timestamptz
  )
  ON CONFLICT (learning_profile_id, deduplication_key) DO NOTHING
  RETURNING true INTO v_created;
  IF COALESCE(v_created, false) IS NOT true THEN
    RETURN false;
  END IF;

  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (p_payload ->> 'eventId')::uuid,
    v_family_space_id,
    v_learning_profile_id,
    'suggested_assessment',
    (p_payload ->> 'id')::uuid,
    'suggested_assessment.created',
    jsonb_build_object(
      'status', v_status,
      'unavailableReason', p_payload ->> 'unavailableReason'
    ),
    (p_payload ->> 'createdAt')::timestamptz
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.create_suggested_assessment(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.mark_suggested_assessment_generating(
  p_suggestion_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_lease_expires_at timestamptz,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  current_row learning.suggested_assessments%ROWTYPE;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
     current_setting('rhea.learning_profile_id', true)
     OR p_lease_expires_at <= p_updated_at THEN
    RETURN false;
  END IF;
  SELECT * INTO current_row
  FROM learning.suggested_assessments
  WHERE id = p_suggestion_id AND learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND OR current_row.state_revision <> p_expected_state_revision
     OR (current_row.status <> 'queued' AND NOT (
       current_row.status = 'generating'
       AND current_row.processing_lease_expires_at <= p_updated_at
     )) THEN
    RETURN false;
  END IF;
  UPDATE learning.suggested_assessments
  SET status = 'generating',
      processing_lease_expires_at = p_lease_expires_at,
      state_revision = state_revision + 1,
      updated_at = p_updated_at
  WHERE id = current_row.id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.mark_suggested_assessment_generating(
  uuid, uuid, integer, timestamptz, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.complete_suggested_assessment_generation(
  p_suggestion_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_status text,
  p_model_run jsonb,
  p_suggestion jsonb,
  p_unavailable_reason text,
  p_requires_professional_review boolean,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  current_row learning.suggested_assessments%ROWTYPE;
  current_input record;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
     current_setting('rhea.learning_profile_id', true)
     OR p_status NOT IN ('pending_review', 'unavailable')
     OR (p_status = 'pending_review') IS DISTINCT FROM (p_suggestion IS NOT NULL)
     OR (p_status = 'pending_review' AND (
       jsonb_typeof(p_model_run) IS DISTINCT FROM 'object'
       OR (p_model_run ->> 'succeeded')::boolean IS DISTINCT FROM true
     ))
     OR (p_status = 'unavailable') IS DISTINCT FROM (p_unavailable_reason IS NOT NULL) THEN
    RETURN false;
  END IF;
  SELECT * INTO current_row
  FROM learning.suggested_assessments
  WHERE id = p_suggestion_id AND learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND OR current_row.status <> 'generating'
     OR current_row.state_revision <> p_expected_state_revision THEN
    RETURN false;
  END IF;
  IF p_status = 'pending_review' THEN
    IF learning.lock_current_generated_learning_eligibility(
         current_row.learning_profile_id,
         current_row.family_space_id,
         current_row.consent_revision,
         current_row.age_band
       ) <> 'authorized'
       OR NOT learning.lock_current_assessment_basis(
         current_row.learning_profile_id,
         current_row.material_id,
         (current_row.basis ->> 'sourceVersionId')::uuid,
         (current_row.basis ->> 'selectionVersion')::integer,
         (current_row.basis ->> 'validityEpoch')::integer,
         current_row.basis ->> 'contentHash',
         current_row.basis ->> 'kind',
         current_row.basis ->> 'versionLabel'
       ) THEN
      RETURN false;
    END IF;
    SELECT * INTO current_input
    FROM learning.resolve_open_assessment_input(
      current_row.learning_profile_id,
      current_row.material_id,
      (current_row.input_reference ->> 'processingJobId')::uuid,
      (current_row.input_reference ->> 'confirmedContentVersionId')::uuid,
      current_row.input_reference ->> 'questionRegionId',
      current_row.input_reference ->> 'responseRegionId',
      (current_row.basis ->> 'sourceVersionId')::uuid,
      (current_row.basis ->> 'selectionVersion')::integer,
      (current_row.basis ->> 'validityEpoch')::integer,
      current_row.age_band,
      current_row.task_type
    );
    IF NOT FOUND
       OR current_input.question_text IS DISTINCT FROM current_row.question ->> 'text'
       OR current_input.response_text IS DISTINCT FROM current_row.response ->> 'text'
       OR current_input.rubric ->> 'id' IS DISTINCT FROM current_row.rubric ->> 'id'
       OR current_input.rubric ->> 'version' IS DISTINCT FROM current_row.rubric ->> 'version' THEN
      RETURN false;
    END IF;
    BEGIN
      PERFORM * FROM metrics.lock_current_family_capability_authorization(
        current_row.authorization_decision_id,
        current_row.capability_version_id,
        current_row.authorization_containment_epoch,
        current_row.family_space_hash,
        'after_receive',
        'primary'
      );
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RETURN false;
    END;
  END IF;
  UPDATE learning.suggested_assessments
  SET status = p_status,
      model_run = p_model_run,
      suggestion = p_suggestion,
      unavailable_reason = p_unavailable_reason,
      requires_professional_review = p_requires_professional_review,
      processing_lease_expires_at = NULL,
      state_revision = state_revision + 1,
      updated_at = p_updated_at
  WHERE id = current_row.id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.complete_suggested_assessment_generation(
  uuid, uuid, integer, text, jsonb, jsonb, text, boolean, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.review_suggested_assessment(
  p_suggestion_id uuid,
  p_learning_profile_id uuid,
  p_expected_state_revision integer,
  p_status text,
  p_review jsonb,
  p_accepted_result jsonb,
  p_updated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  current_row learning.suggested_assessments%ROWTYPE;
  current_input record;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
     current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;
  IF p_status NOT IN ('accepted', 'rejected')
     OR jsonb_typeof(p_review) IS DISTINCT FROM 'object'
     OR (p_status = 'accepted') IS DISTINCT FROM (p_accepted_result IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid suggested assessment review';
  END IF;

  SELECT * INTO current_row
  FROM learning.suggested_assessments
  WHERE id = p_suggestion_id
    AND learning_profile_id = p_learning_profile_id
  FOR UPDATE;
  IF NOT FOUND
     OR current_row.status <> 'pending_review'
     OR current_row.state_revision <> p_expected_state_revision THEN
    RETURN false;
  END IF;
  IF NOT learning.lock_current_assessment_basis(
    current_row.learning_profile_id,
    current_row.material_id,
    (current_row.basis ->> 'sourceVersionId')::uuid,
    (current_row.basis ->> 'selectionVersion')::integer,
    (current_row.basis ->> 'validityEpoch')::integer,
    current_row.basis ->> 'contentHash',
    current_row.basis ->> 'kind',
    current_row.basis ->> 'versionLabel'
  ) THEN
    RETURN false;
  END IF;
  SELECT * INTO current_input
  FROM learning.resolve_open_assessment_input(
    current_row.learning_profile_id,
    current_row.material_id,
    (current_row.input_reference ->> 'processingJobId')::uuid,
    (current_row.input_reference ->> 'confirmedContentVersionId')::uuid,
    current_row.input_reference ->> 'questionRegionId',
    current_row.input_reference ->> 'responseRegionId',
    (current_row.basis ->> 'sourceVersionId')::uuid,
    (current_row.basis ->> 'selectionVersion')::integer,
    (current_row.basis ->> 'validityEpoch')::integer,
    current_row.age_band,
    current_row.task_type
  );
  IF NOT FOUND
     OR current_input.question_text IS DISTINCT FROM current_row.question ->> 'text'
     OR current_input.response_text IS DISTINCT FROM current_row.response ->> 'text'
     OR current_input.rubric ->> 'id' IS DISTINCT FROM current_row.rubric ->> 'id'
     OR current_input.rubric ->> 'version' IS DISTINCT FROM current_row.rubric ->> 'version' THEN
    RETURN false;
  END IF;
  IF p_status = 'accepted' THEN
    IF learning.lock_current_generated_learning_eligibility(
         current_row.learning_profile_id,
         current_row.family_space_id,
         current_row.consent_revision,
         current_row.age_band
       ) <> 'authorized'
       OR current_row.authorization_decision_id IS NULL
       OR current_row.capability_version_id IS NULL THEN
      RETURN false;
    END IF;
    BEGIN
      PERFORM * FROM metrics.lock_current_family_capability_authorization(
        current_row.authorization_decision_id,
        current_row.capability_version_id,
        current_row.authorization_containment_epoch,
        current_row.family_space_hash,
        'before_publish',
        'primary'
      );
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RETURN false;
    END;
  END IF;

  UPDATE learning.suggested_assessments
  SET status = p_status,
      review = p_review,
      accepted_result = p_accepted_result,
      state_revision = state_revision + 1,
      updated_at = p_updated_at
  WHERE id = current_row.id;

  INSERT INTO learning.domain_outbox (
    id, family_space_id, learning_profile_id, aggregate_type,
    aggregate_id, event_type, payload, occurred_at
  ) VALUES (
    (p_review ->> 'id')::uuid,
    current_row.family_space_id,
    current_row.learning_profile_id,
    'suggested_assessment',
    current_row.id,
    CASE p_status
      WHEN 'accepted' THEN 'suggested_assessment.accepted'
      ELSE 'suggested_assessment.rejected'
    END,
    jsonb_build_object(
      'review', p_review,
      'acceptedResult', p_accepted_result,
      'downstreamEligibility', jsonb_build_object(
        'eligible', p_status = 'accepted',
        'reason', CASE WHEN p_status = 'rejected' THEN 'rejected' ELSE NULL END
      )
    ),
    p_updated_at
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION learning.review_suggested_assessment(
  uuid, uuid, integer, text, jsonb, jsonb, timestamptz
) FROM PUBLIC;

ALTER TABLE learning.suggested_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.suggested_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY suggested_assessments_profile_isolation ON learning.suggested_assessments
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

REVOKE ALL ON learning.open_assessment_rubric_versions FROM rhea_assessment_app;
REVOKE ALL ON learning.suggested_assessments FROM rhea_assessment_app;
GRANT SELECT ON learning.suggested_assessments TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.create_suggested_assessment(jsonb)
  TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.mark_suggested_assessment_generating(
  uuid, uuid, integer, timestamptz, timestamptz
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.complete_suggested_assessment_generation(
  uuid, uuid, integer, text, jsonb, jsonb, text, boolean, timestamptz
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.resolve_open_assessment_input(
  uuid, uuid, uuid, uuid, text, text, uuid, integer, integer, text, text
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.review_suggested_assessment(
  uuid, uuid, integer, text, jsonb, jsonb, timestamptz
) TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.lock_current_generated_learning_eligibility(
  uuid, uuid, integer, text
) TO rhea_assessment_app;
