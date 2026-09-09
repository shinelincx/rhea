import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type { CaptureSource, CapturedDraftPage } from './capture-source';
import {
  addDraftPages,
  createCaptureDraft,
  cropDraftPage,
  deleteDraftPage,
  moveDraftPage,
  replaceDraftPage,
  rotateDraftPage,
  validateDraft,
  type CaptureDraft,
  type DraftQualityWarning,
} from './model';
import type { CaptureDraftRepository } from './repository';
import type {
  MobileLearningMaterial,
  MobileObjectiveAssessment,
  MobileObjectiveGradingRule,
  MobileProcessingJob,
  MobileSubject,
  SubmissionGateway,
} from './submission-gateway';

const warningLabels: Record<DraftQualityWarning, string> = {
  blurry: '画面可能模糊，请靠近或重拍',
  glare: '页面有明显反光，请换个角度',
  missing_edge: '纸张边缘可能不完整，请拍全四边',
  too_dark: '画面太暗，请到明亮处重拍',
};

const subjectLabels: Record<MobileSubject, string> = {
  chinese: '语文',
  english: '英语',
  mathematics: '数学',
  science: '科学',
};

interface CaptureDraftScreenProps {
  accessToken?: string;
  captureSource: CaptureSource;
  familySpaceId?: string;
  learningProfileId: string;
  onBack: () => void;
  repository: CaptureDraftRepository;
  submissionGateway?: SubmissionGateway;
}

type ScreenStatus = 'loading' | 'ready';

function now(): string {
  return new Date().toISOString();
}

function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  const chunkSize = 8_192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function ActionButton({
  disabled = false,
  label,
  onPress,
  primary = false,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        primary ? styles.actionButtonPrimary : null,
        disabled ? styles.actionButtonDisabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={primary ? styles.actionButtonPrimaryText : styles.actionButtonText}>
        {label}
      </Text>
    </Pressable>
  );
}

export function CaptureDraftScreen({
  accessToken,
  captureSource,
  familySpaceId,
  learningProfileId,
  onBack,
  repository,
  submissionGateway,
}: CaptureDraftScreenProps) {
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<ScreenStatus>('loading');
  const [working, setWorking] = useState(false);
  const [job, setJob] = useState<MobileProcessingJob | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selectedSubject, setSelectedSubject] = useState<MobileSubject | null>(null);
  const [coursePathName, setCoursePathName] = useState('');
  const [unitName, setUnitName] = useState('');
  const [knowledgePointNames, setKnowledgePointNames] = useState('');
  const [learningMaterial, setLearningMaterial] = useState<MobileLearningMaterial | null>(null);
  const [editingClassification, setEditingClassification] = useState(false);
  const [acceptedAnswer, setAcceptedAnswer] = useState('');
  const [assessment, setAssessment] = useState<MobileObjectiveAssessment | null>(null);
  const [showDispute, setShowDispute] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [correctionText, setCorrectionText] = useState('');
  const pageContents = useRef(new Map<string, Uint8Array>());

  useEffect(() => {
    let active = true;
    void repository
      .loadLatest(learningProfileId)
      .then((restored) => {
        if (!active) {
          return;
        }
        if (restored) {
          pageContents.current = restored.pageContents;
          setDraft(restored.draft);
          setPreviews(
            new Map(
              restored.draft.pages
                .filter((page) => page.mimeType.startsWith('image/'))
                .map((page) => [
                  page.id,
                  bytesToDataUri(restored.pageContents.get(page.id)!, page.mimeType),
                ]),
            ),
          );
          setNotice(`已恢复上次未提交的 ${restored.draft.pages.length} 页草稿。`);
        } else {
          setDraft(createCaptureDraft({ id: randomUUID(), learningProfileId, now: now() }));
        }
      })
      .catch(() => {
        if (active) {
          setError('草稿暂时无法读取，请返回后重试。');
        }
      })
      .finally(() => {
        if (active) {
          setStatus('ready');
        }
      });
    return () => {
      active = false;
    };
  }, [learningProfileId, repository]);

  useEffect(() => {
    if (
      !accessToken ||
      !submissionGateway ||
      !job ||
      ['awaiting_confirmation', 'completed', 'failed', 'canceled'].includes(job.status)
    ) {
      return;
    }
    const timer = setInterval(() => {
      void submissionGateway
        .getJob(accessToken, job.id)
        .then((next) => setJob(next))
        .catch(() => setError('状态更新暂时中断，草稿仍在本机，可稍后继续。'));
    }, 700);
    return () => clearInterval(timer);
  }, [accessToken, job, submissionGateway]);

  const persist = useCallback(
    async (nextDraft: CaptureDraft) => {
      setDraft(nextDraft);
      setNotice(null);
      setError(null);
      try {
        await repository.save(nextDraft, pageContents.current);
      } catch {
        setError('草稿保存失败，请不要退出并稍后重试。当前页面仍会保留。');
      }
    },
    [repository],
  );

  const addCaptured = useCallback(
    async (captured: CapturedDraftPage[]) => {
      if (!draft || captured.length === 0) {
        return;
      }
      const nextPreviews = new Map(previews);
      for (const item of captured) {
        pageContents.current.set(item.page.id, item.bytes);
        if (item.previewUri) {
          nextPreviews.set(item.page.id, item.previewUri);
        }
      }
      setPreviews(nextPreviews);
      await persist(
        addDraftPages(
          draft,
          captured.map(({ page }) => page),
          now(),
        ),
      );
    },
    [draft, persist, previews],
  );

  const acquire = useCallback(
    async (method: 'camera' | 'files') => {
      setWorking(true);
      setError(null);
      try {
        await addCaptured(
          method === 'camera' ? await captureSource.takePhoto() : await captureSource.importFiles(),
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '没有成功添加页面，请再试一次。');
      } finally {
        setWorking(false);
      }
    },
    [addCaptured, captureSource],
  );

  const updateDraft = useCallback(
    (operation: (current: CaptureDraft) => CaptureDraft) => {
      if (draft) {
        void persist(operation(draft));
      }
    },
    [draft, persist],
  );

  async function retake(pageId: string) {
    if (!draft) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const [captured] = await captureSource.takePhoto();
      if (!captured) {
        return;
      }
      pageContents.current.set(pageId, captured.bytes);
      pageContents.current.delete(captured.page.id);
      const nextPreviews = new Map(previews);
      if (captured.previewUri) {
        nextPreviews.set(pageId, captured.previewUri);
      } else {
        nextPreviews.delete(pageId);
      }
      setPreviews(nextPreviews);
      await persist(replaceDraftPage(draft, pageId, captured.page, now()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重拍失败，原页面已经保留。');
    } finally {
      setWorking(false);
    }
  }

  function remove(pageId: string) {
    if (!draft) {
      return;
    }
    pageContents.current.delete(pageId);
    const nextPreviews = new Map(previews);
    nextPreviews.delete(pageId);
    setPreviews(nextPreviews);
    void persist(deleteDraftPage(draft, pageId, now()));
  }

  async function validate() {
    if (!draft) {
      return;
    }
    const result = validateDraft(draft);
    setError(result.valid ? null : result.errors.join('\n'));
    if (!result.valid) {
      setNotice(null);
      return;
    }
    if (!submissionGateway || !accessToken) {
      setNotice('草稿检查通过，下一步将安全上传并批改。');
      return;
    }
    setWorking(true);
    setNotice('正在创建安全上传…');
    try {
      const submitted = await submissionGateway.submit({
        accessToken,
        draft,
        onProgress: (uploaded, total) => setNotice(`正在上传第 ${uploaded}/${total} 页…`),
        pageContents: pageContents.current,
      });
      setJob(submitted);
      setNotice('上传完成，后端正在检查并识别。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '上传没有完成，草稿已保留。');
      setNotice(null);
    } finally {
      setWorking(false);
    }
  }

  async function confirmRecognition() {
    if (!accessToken || !submissionGateway || !job) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const completed = await submissionGateway.confirm(accessToken, job.id, edits);
      setJob(completed);
      if (draft) {
        await repository.clear(draft);
      }
      setNotice('识别内容已确认，原始整页文件已进入删除流程。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认没有完成，请检查后重试。');
    } finally {
      setWorking(false);
    }
  }

  async function cancelProcessing() {
    if (!accessToken || !submissionGateway || !job) {
      return;
    }
    setWorking(true);
    try {
      const canceled = await submissionGateway.cancel(accessToken, job.id);
      setJob(canceled);
      setNotice('处理已取消，迟到的识别结果不会进入后续批改。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消没有完成，请重试。');
    } finally {
      setWorking(false);
    }
  }

  async function organizeConfirmedContent(asPending: boolean) {
    if (!accessToken || !familySpaceId || !submissionGateway || !job?.completedContent) {
      return;
    }
    const subject = asPending ? null : selectedSubject;
    if (!asPending && !subject) {
      setError('请选择主学科，或先放入待归类。');
      return;
    }
    const points = asPending
      ? []
      : knowledgePointNames
          .split(/[，,]/)
          .map((name) => name.trim())
          .filter(Boolean);
    setWorking(true);
    setError(null);
    try {
      const classification = {
        coursePathName: asPending ? null : coursePathName.trim() || null,
        knowledgePointNames: points,
        primaryKnowledgePointName: points[0] ?? null,
        primarySubject: subject,
        relatedSubjects: [],
        unitName: asPending ? null : unitName.trim() || null,
      };
      const material = learningMaterial
        ? await submissionGateway.correctClassification({
            accessToken,
            classification,
            familySpaceId,
            learningProfileId,
            materialId: learningMaterial.id,
            reason: '学习者修正学习归类',
          })
        : await submissionGateway.organize({
            accessToken,
            classification,
            familySpaceId,
            learningProfileId,
            processingJobId: job.id,
          });
      setLearningMaterial(material);
      setAssessment(null);
      setEditingClassification(false);
      setNotice(
        material.currentClassification.status === 'pending'
          ? '已放入待归类，系统不会猜测学科或知识点。'
          : `已整理到${subjectLabels[material.currentClassification.primarySubject!]}，当前学习依据版本已记录。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '学习内容暂时无法整理，请稍后重试。');
    } finally {
      setWorking(false);
    }
  }

  function gradingRule(
    subject: MobileSubject,
    expected: string,
  ): MobileObjectiveGradingRule | null {
    const normalized = expected.trim();
    if (!normalized) return null;
    if (subject === 'mathematics' && /^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
      return { expected: normalized, kind: 'numeric' };
    }
    if (subject === 'science') {
      return { correctOption: normalized, kind: 'single_choice' };
    }
    return {
      acceptedAnswers: [normalized],
      caseSensitive: subject === 'chinese',
      collapseWhitespace: true,
      kind: 'accepted_text',
    };
  }

  async function gradeObjective(useEnteredRule: boolean) {
    const content = job?.completedContent;
    const subject = learningMaterial?.currentClassification.primarySubject;
    const question = content?.regions.find((region) => region.kind === 'question');
    const response = content?.regions.find((region) => region.kind === 'answer');
    if (
      !accessToken ||
      !familySpaceId ||
      !submissionGateway ||
      !content ||
      !learningMaterial ||
      !subject ||
      !question ||
      !response
    ) {
      setError('确认内容中缺少可配对的题目或作答，暂无法可靠批改。');
      return;
    }
    if (useEnteredRule && !acceptedAnswer.trim()) {
      setError('请填写当前学习依据中的答案或规则；如果没有，请选择暂无法可靠批改。');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const result = await submissionGateway.gradeObjective({
        accessToken,
        familySpaceId,
        learningProfileId,
        materialId: learningMaterial.id,
        question: {
          subject,
          text: question.text,
          versionId: `${content.id}:${question.id}`,
        },
        response: {
          text: response.text,
          versionId: `${content.id}:${response.id}`,
        },
        rule: useEnteredRule ? gradingRule(subject, acceptedAnswer) : null,
      });
      setAssessment(result);
      setShowDispute(false);
      setNotice(
        result.currentVersion.decision.outcome === 'ungradable'
          ? '已明确标记为暂无法可靠批改，不会猜测对错。'
          : '确定性批改已完成，结果已绑定当前学习依据。',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批改暂时没有完成，请稍后重试。');
    } finally {
      setWorking(false);
    }
  }

  async function submitDispute() {
    if (
      !accessToken ||
      !familySpaceId ||
      !submissionGateway ||
      !assessment ||
      !disputeReason.trim() ||
      !correctionText.trim()
    ) {
      setError('请填写质疑原因和补充修正信息。');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const disputed = await submissionGateway.disputeAssessment({
        accessToken,
        assessmentId: assessment.id,
        correctionText,
        familySpaceId,
        learningProfileId,
        reason: disputeReason,
        target: 'assessment',
      });
      setAssessment(disputed);
      setShowDispute(false);
      setNotice('批改质疑已提交，结果进入待复核。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '质疑没有提交成功，请稍后重试。');
    } finally {
      setWorking(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.headerRow}>
          <ActionButton label="返回" onPress={onBack} />
          <Text accessibilityRole="header" style={styles.title}>
            拍作业
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        {status === 'loading' ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.mutedText}>正在打开加密草稿…</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.guideCard}>
              <Text style={styles.guideTitle}>拍清楚，批改才准确</Text>
              <Text style={styles.guideText}>
                请确认文字清晰、光线充足、没有反光，并拍全纸张四边。
              </Text>
            </View>

            <View style={styles.primaryActions}>
              <ActionButton
                disabled={working || job !== null}
                label="继续拍照"
                onPress={() => void acquire('camera')}
                primary
              />
              <ActionButton
                disabled={working || job !== null}
                label="导入图片或 PDF"
                onPress={() => void acquire('files')}
              />
            </View>

            {error ? (
              <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            {notice ? (
              <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
                {notice}
              </Text>
            ) : null}

            {job ? (
              <View style={styles.jobCard}>
                <Text style={styles.guideTitle}>识别任务</Text>
                <Text style={styles.mutedText}>{statusLabel(job.status)}</Text>
                {job.qualityIssues.map(({ issue, pageId }) => (
                  <Text key={`${pageId}:${issue}`} style={styles.warningText}>
                    {warningLabels[issue]}
                  </Text>
                ))}
                {!['completed', 'failed', 'canceled'].includes(job.status) ? (
                  <ActionButton
                    disabled={working}
                    label="取消处理"
                    onPress={() => void cancelProcessing()}
                  />
                ) : null}
              </View>
            ) : null}

            {job?.status === 'awaiting_confirmation' && job.candidate ? (
              <View style={styles.confirmationCard}>
                <Text style={styles.guideTitle}>确认识别内容</Text>
                <Text style={styles.guideText}>黄色项目置信度较低，请重点核对；修改后再确认。</Text>
                {[...job.candidate.regions]
                  .sort((left, right) => left.readingOrder - right.readingOrder)
                  .map((region) => (
                    <View
                      key={region.id}
                      style={region.lowConfidence ? styles.lowConfidenceRegion : styles.region}
                    >
                      <Text style={styles.regionLabel}>
                        {region.kind === 'answer'
                          ? '作答'
                          : region.kind === 'question'
                            ? '题目'
                            : '公共题干'}
                        {region.lowConfidence
                          ? ` · 需要核对 ${Math.round(region.confidence * 100)}%`
                          : ''}
                      </Text>
                      <TextInput
                        accessibilityLabel={`编辑${region.kind === 'answer' ? '作答' : '题目'}内容`}
                        multiline
                        onChangeText={(text) =>
                          setEdits((current) => ({ ...current, [region.id]: text }))
                        }
                        style={styles.regionInput}
                        value={edits[region.id] ?? region.text}
                      />
                    </View>
                  ))}
                <ActionButton
                  disabled={working}
                  label="确认识别内容"
                  onPress={() => void confirmRecognition()}
                  primary
                />
              </View>
            ) : null}

            {job?.status === 'completed' &&
            familySpaceId &&
            (!learningMaterial || editingClassification) ? (
              <View style={styles.classificationCard}>
                <Text style={styles.guideTitle}>整理到哪里？</Text>
                <Text style={styles.guideText}>
                  确定时选择学科并补充路径；不确定就先放入待归类，系统不会替你猜。
                </Text>
                <View style={styles.subjectRow}>
                  {(Object.keys(subjectLabels) as MobileSubject[]).map((subject) => (
                    <Pressable
                      accessibilityRole="button"
                      key={subject}
                      onPress={() => setSelectedSubject(subject)}
                      style={[
                        styles.subjectButton,
                        selectedSubject === subject ? styles.subjectButtonSelected : null,
                      ]}
                    >
                      <Text
                        style={
                          selectedSubject === subject
                            ? styles.subjectButtonSelectedText
                            : styles.subjectButtonText
                        }
                      >
                        {subjectLabels[subject]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  accessibilityLabel="课程路径"
                  onChangeText={setCoursePathName}
                  placeholder="课程路径（可选，例如沪教版三年级上册）"
                  style={styles.taxonomyInput}
                  value={coursePathName}
                />
                <TextInput
                  accessibilityLabel="学习单元"
                  onChangeText={setUnitName}
                  placeholder="学习单元（可选）"
                  style={styles.taxonomyInput}
                  value={unitName}
                />
                <TextInput
                  accessibilityLabel="知识点"
                  onChangeText={setKnowledgePointNames}
                  placeholder="知识点（可用逗号分开，第一个为主要知识点）"
                  style={styles.taxonomyInput}
                  value={knowledgePointNames}
                />
                <View style={styles.primaryActions}>
                  <ActionButton
                    disabled={working || !selectedSubject}
                    label="保存学习归类"
                    onPress={() => void organizeConfirmedContent(false)}
                    primary
                  />
                  <ActionButton
                    disabled={working}
                    label="先放入待归类"
                    onPress={() => void organizeConfirmedContent(true)}
                  />
                </View>
              </View>
            ) : null}

            {learningMaterial && !editingClassification ? (
              <View style={styles.classificationCard}>
                <Text style={styles.guideTitle}>
                  {learningMaterial.currentClassification.status === 'pending'
                    ? '待归类'
                    : `已归入${subjectLabels[learningMaterial.currentClassification.primarySubject!]}`}
                </Text>
                <Text style={styles.guideText}>
                  归类版本 {learningMaterial.currentClassification.revision} · 当前学习依据版本{' '}
                  {learningMaterial.basis.selectionRevision}
                </Text>
                {learningMaterial.basis.hasConflict ? (
                  <Text style={styles.warningText}>
                    学习来源存在冲突，已明确保留当前采用的依据。
                  </Text>
                ) : null}
                <ActionButton
                  disabled={working}
                  label="修改归类"
                  onPress={() => setEditingClassification(true)}
                />
              </View>
            ) : null}

            {learningMaterial?.currentClassification.status === 'classified' &&
            job?.completedContent ? (
              <View style={styles.assessmentCard}>
                <Text style={styles.guideTitle}>客观题批改</Text>
                {!assessment ? (
                  <>
                    <Text style={styles.guideText}>
                      只按当前学习依据做确定性比较。没有可靠答案时，请直接标记暂无法批改。
                    </Text>
                    <Text style={styles.assessmentDetail}>
                      题目：
                      {job.completedContent.regions.find((region) => region.kind === 'question')
                        ?.text ?? '未找到确认题目'}
                    </Text>
                    <Text style={styles.assessmentDetail}>
                      我的作答：
                      {job.completedContent.regions.find((region) => region.kind === 'answer')
                        ?.text ?? '未找到确认作答'}
                    </Text>
                    <Text style={styles.inputLabel}>采用答案或规则</Text>
                    <TextInput
                      accessibilityLabel="采用答案或规则"
                      onChangeText={setAcceptedAnswer}
                      placeholder="填写当前学习依据中的答案或选项"
                      style={styles.taxonomyInput}
                      value={acceptedAnswer}
                    />
                    <View style={styles.primaryActions}>
                      <ActionButton
                        disabled={working || !acceptedAnswer.trim()}
                        label="进行确定性批改"
                        onPress={() => void gradeObjective(true)}
                        primary
                      />
                      <ActionButton
                        disabled={working}
                        label="没有可靠答案，标记暂无法批改"
                        onPress={() => void gradeObjective(false)}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <Text accessibilityLiveRegion="polite" style={styles.assessmentOutcome}>
                      {assessment.openDisputeId
                        ? '结果待复核'
                        : assessment.currentVersion.decision.outcome === 'correct'
                          ? '答对了'
                          : assessment.currentVersion.decision.outcome === 'incorrect'
                            ? '需要订正'
                            : '暂无法可靠批改'}
                    </Text>
                    <Text style={styles.assessmentDetail}>
                      题目：{assessment.currentVersion.question.text}
                    </Text>
                    <Text style={styles.assessmentDetail}>
                      我的作答：{assessment.currentVersion.response.text}
                    </Text>
                    <Text style={styles.assessmentDetail}>
                      采用答案：{assessment.currentVersion.decision.expectedDisplay ?? '依据不足'}
                    </Text>
                    <Text style={styles.guideText}>
                      批改版本：{assessment.currentVersion.revision}
                    </Text>
                    <Text style={styles.guideText}>
                      当前学习依据版本：{assessment.currentVersion.basis.selectionVersion}
                    </Text>
                    {assessment.openDisputeId ? (
                      <Text style={styles.warningText}>
                        结果待复核，相关错题、掌握度、复习和挑战计分已暂停。
                      </Text>
                    ) : (
                      <ActionButton
                        disabled={working}
                        label="我觉得批改不对"
                        onPress={() => setShowDispute(true)}
                      />
                    )}
                    {showDispute && !assessment.openDisputeId ? (
                      <View style={styles.disputePanel}>
                        <Text style={styles.inputLabel}>为什么觉得不对？</Text>
                        <TextInput
                          accessibilityLabel="质疑原因"
                          onChangeText={setDisputeReason}
                          placeholder="例如：作答识别错误"
                          style={styles.taxonomyInput}
                          value={disputeReason}
                        />
                        <Text style={styles.inputLabel}>补充修正信息</Text>
                        <TextInput
                          accessibilityLabel="补充修正信息"
                          multiline
                          onChangeText={setCorrectionText}
                          placeholder="说明你看到的内容或正确写法"
                          style={styles.regionInput}
                          value={correctionText}
                        />
                        <ActionButton
                          disabled={working || !disputeReason.trim() || !correctionText.trim()}
                          label="提交质疑并暂停结果"
                          onPress={() => void submitDispute()}
                          primary
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            ) : null}

            {draft?.pages.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>还没有页面</Text>
                <Text style={styles.mutedText}>可以连续拍多页，也可以一次导入多张图片或 PDF。</Text>
              </View>
            ) : null}

            {draft?.pages.map((page, index) => (
              <View key={page.id} style={styles.pageCard}>
                <View style={styles.pageHeader}>
                  <Text style={styles.pageTitle}>第 {index + 1} 页</Text>
                  <Text numberOfLines={1} style={styles.fileName}>
                    {page.fileName}
                  </Text>
                </View>
                {previews.get(page.id) ? (
                  <View style={styles.previewFrame}>
                    <Image
                      accessibilityLabel={`第 ${index + 1} 页预览`}
                      resizeMode="contain"
                      source={{ uri: previews.get(page.id) }}
                      style={[
                        styles.preview,
                        {
                          transform: [
                            { rotate: `${page.rotation}deg` },
                            { scale: page.crop ? 1.08 : 1 },
                          ],
                        },
                      ]}
                    />
                  </View>
                ) : (
                  <View style={styles.pdfPreview}>
                    <Text style={styles.pdfLabel}>PDF</Text>
                  </View>
                )}
                {page.crop ? <Text style={styles.editedLabel}>已裁边</Text> : null}
                {page.qualityWarnings.map((warning) => (
                  <Text key={warning} style={styles.warningText}>
                    {warningLabels[warning]}
                  </Text>
                ))}
                <View style={styles.pageActions}>
                  <ActionButton
                    disabled={job !== null}
                    label={`旋转第 ${index + 1} 页`}
                    onPress={() =>
                      updateDraft((current) => rotateDraftPage(current, page.id, now()))
                    }
                  />
                  <ActionButton
                    disabled={job !== null}
                    label={`裁边第 ${index + 1} 页`}
                    onPress={() => updateDraft((current) => cropDraftPage(current, page.id, now()))}
                  />
                  <ActionButton
                    disabled={working || job !== null || page.mimeType === 'application/pdf'}
                    label={`重拍第 ${index + 1} 页`}
                    onPress={() => void retake(page.id)}
                  />
                  <ActionButton
                    disabled={job !== null || index === 0}
                    label={`第 ${index + 1} 页上移`}
                    onPress={() =>
                      updateDraft((current) => moveDraftPage(current, page.id, -1, now()))
                    }
                  />
                  <ActionButton
                    disabled={job !== null || index === draft.pages.length - 1}
                    label={`第 ${index + 1} 页下移`}
                    onPress={() =>
                      updateDraft((current) => moveDraftPage(current, page.id, 1, now()))
                    }
                  />
                  <ActionButton
                    disabled={job !== null}
                    label={`删除第 ${index + 1} 页`}
                    onPress={() => remove(page.id)}
                  />
                </View>
              </View>
            ))}

            <ActionButton
              disabled={working || job !== null}
              label="检查并继续上传"
              onPress={() => void validate()}
              primary
            />
            <Text style={styles.securityText}>草稿已在本机加密保存，只能由当前学习档案恢复。</Text>
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  actionButtonDisabled: { opacity: 0.42 },
  actionButtonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionButtonPrimaryText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
  actionButtonText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  assessmentCard: {
    backgroundColor: '#FFFCF5',
    borderColor: '#F2C94C',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  assessmentDetail: { color: colors.foreground, fontSize: 16, lineHeight: 24 },
  assessmentOutcome: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  confirmationCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  classificationCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: { gap: spacing.md, paddingBottom: spacing.xxl },
  editedLabel: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  disputePanel: { gap: spacing.sm },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.xl,
  },
  emptyTitle: { color: colors.foreground, fontSize: 20, fontWeight: '700' },
  errorText: {
    backgroundColor: '#FEE4E2',
    borderRadius: radii.md,
    color: colors.error,
    fontSize: 15,
    lineHeight: 23,
    padding: spacing.md,
  },
  fileName: { color: colors.mutedForeground, flex: 1, fontSize: 14, textAlign: 'right' },
  guideCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.lg,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  guideText: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  guideTitle: { color: colors.foreground, fontSize: 19, fontWeight: '700' },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  headerSpacer: { width: 72 },
  inputLabel: { color: colors.foreground, fontSize: 15, fontWeight: '700' },
  jobCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  loading: { alignItems: 'center', flex: 1, gap: spacing.md, justifyContent: 'center' },
  lowConfidenceRegion: {
    backgroundColor: '#FFF4E5',
    borderColor: '#F79009',
    borderRadius: radii.md,
    borderWidth: 2,
    gap: spacing.xs,
    padding: spacing.md,
  },
  mutedText: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23, textAlign: 'center' },
  noticeText: {
    backgroundColor: '#ECFDF3',
    borderRadius: radii.md,
    color: '#027A48',
    fontSize: 15,
    lineHeight: 23,
    padding: spacing.md,
  },
  pageActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  pageCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  pageHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  pageTitle: { color: colors.foreground, fontSize: 18, fontWeight: '700' },
  pdfLabel: { color: colors.primary, fontSize: 24, fontWeight: '800' },
  pdfPreview: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    height: 120,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  preview: { height: 220, width: '100%' },
  previewFrame: {
    backgroundColor: '#F4F1F8',
    borderRadius: radii.md,
    height: 220,
    overflow: 'hidden',
  },
  primaryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  region: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  regionInput: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 52,
    padding: spacing.sm,
  },
  regionLabel: { color: colors.mutedForeground, fontSize: 13, fontWeight: '700' },
  safeArea: { backgroundColor: colors.background, flex: 1 },
  screen: {
    alignSelf: 'center',
    flex: 1,
    maxWidth: 720,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    width: '100%',
  },
  securityText: { color: colors.mutedForeground, fontSize: 13, textAlign: 'center' },
  subjectButton: {
    backgroundColor: colors.background,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  subjectButtonSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  subjectButtonSelectedText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
  subjectButtonText: { color: colors.foreground, fontSize: 15, fontWeight: '700' },
  subjectRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  taxonomyInput: {
    backgroundColor: colors.background,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  title: { color: colors.foreground, fontSize: 25, fontWeight: '800' },
  warningText: { color: '#B54708', fontSize: 14, fontWeight: '600', lineHeight: 21 },
});

function statusLabel(status: MobileProcessingJob['status']): string {
  const labels: Record<MobileProcessingJob['status'], string> = {
    awaiting_confirmation: '等待你确认识别内容',
    canceled: '已取消',
    completed: '内容确认完成',
    failed: '处理失败，草稿仍可重新提交',
    quality_check: '正在检查图片质量',
    queued: '正在排队',
    recognizing: '正在识别题目与作答',
    security_check: '正在检查文件安全',
  };
  return labels[status];
}
