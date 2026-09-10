import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '../design-system/tokens';
import type {
  GeneratedLearningGateway,
  GeneratedLearningGatewayError,
  MobileGeneratedLearningRequest,
  MobileGenerationRequestStatus,
  MobileGenerationUnavailableReason,
} from './generated-learning-gateway';

const POLL_BASE_DELAY_MS = 700;
const POLL_MAX_DELAY_MS = 5_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 4;
const PERMANENT_POLL_ERROR_CODES = new Set([
  'CONSENT_REQUIRED',
  'FAMILY_SPACE_NOT_FOUND',
  'GENERATION_REQUEST_NOT_FOUND',
  'INPUT_INVALID',
  'LEARNING_PROFILE_NOT_FOUND',
  'PROFILE_ACCESS_DENIED',
  'RESPONSE_INVALID',
  'SESSION_INVALID',
]);

interface GeneratedLearningCardProps {
  accessToken: string;
  familySpaceId: string;
  gateway: GeneratedLearningGateway;
  learningProfileId: string;
  materialId: string;
  processingJobId: string;
}

const requestStatusLabels: Record<MobileGenerationRequestStatus, string> = {
  canceled: '已取消',
  generating: '正在生成',
  queued: '排队中',
  ready: '已就绪',
  unavailable: '暂不可用',
};

const unavailableReasonLabels: Record<MobileGenerationUnavailableReason, string> = {
  CAPABILITY_CONTAINED: '该 AI 能力已被安全隔离，请稍后重新生成。',
  CAPABILITY_UNAVAILABLE: '当前 AI 学习能力尚未开放，请稍后再试。',
  CONSENT_WITHDRAWN: 'AI 处理授权已撤回，因此不会继续展示生成内容。',
  GENERATION_CANCELED: '这次生成已取消，可以稍后重新开始。',
  GENERATION_CHECK_FAILED: '生成内容没有通过发布前检查，因此没有展示。',
  MODEL_UNAVAILABLE: 'AI 服务暂时没有完成生成，请稍后再试。',
  SOURCE_CHANGED: '当前学习依据已更新，请重新整理后再生成。',
  SOURCE_UNAVAILABLE: '当前学习依据不足或存在冲突，暂时无法生成。',
};

function LearningButton({
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
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primaryButton : null,
        disabled ? styles.disabledButton : null,
        pressed ? styles.pressedButton : null,
      ]}
    >
      <Text style={primary ? styles.primaryButtonText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function QuestionList({
  emptyLabel,
  items,
  title,
}: {
  emptyLabel: string;
  items: Array<{ id: string; question: string }>;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {items.length === 0 ? (
        <Text style={styles.mutedText}>{emptyLabel}</Text>
      ) : (
        items.map((item, index) => (
          <View key={item.id} style={styles.questionRow}>
            <Text style={styles.questionNumber}>{index + 1}</Text>
            <Text style={styles.questionText}>{item.question}</Text>
          </View>
        ))
      )}
    </View>
  );
}

export function GeneratedLearningCard({
  accessToken,
  familySpaceId,
  gateway,
  learningProfileId,
  materialId,
  processingJobId,
}: GeneratedLearningCardProps) {
  const [generation, setGeneration] = useState<MobileGeneratedLearningRequest | null>(null);
  const [confirmedRevealLevel, setConfirmedRevealLevel] = useState<0 | 1 | 2 | 3>(0);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const idempotencyKey = useRef(randomUUID());
  const mutationInFlight = useRef(false);
  const operationEpoch = useRef(0);

  const scope = {
    accessToken,
    familySpaceId,
    learningProfileId,
  };

  useEffect(() => {
    if (!generation || working || !['queued', 'generating'].includes(generation.status)) {
      return;
    }

    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    const schedule = (delay: number) => {
      timer = setTimeout(poll, delay);
    };
    const poll = () => {
      if (inFlight || mutationInFlight.current) {
        return;
      }
      inFlight = true;
      const pollEpoch = operationEpoch.current;
      void gateway
        .get({ ...scope, materialId, requestId: generation.id })
        .then((next) => {
          if (active && operationEpoch.current === pollEpoch) {
            setGeneration(next);
            setError(null);
            consecutiveFailures = 0;
            if (next.status === 'queued' || next.status === 'generating') {
              schedule(POLL_BASE_DELAY_MS);
            }
          }
        })
        .catch((caught: unknown) => {
          if (!active || operationEpoch.current !== pollEpoch) {
            return;
          }
          consecutiveFailures += 1;
          const code =
            caught instanceof Error && 'code' in caught
              ? (caught as GeneratedLearningGatewayError).code
              : null;
          if (
            (code !== null && PERMANENT_POLL_ERROR_CODES.has(code)) ||
            consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES
          ) {
            setError('生成状态无法继续更新，请取消后重新生成。');
            return;
          }
          setError('生成状态更新暂时中断，正在继续尝试。');
          schedule(Math.min(POLL_MAX_DELAY_MS, POLL_BASE_DELAY_MS * 2 ** consecutiveFailures));
        })
        .finally(() => {
          inFlight = false;
        });
    };

    schedule(POLL_BASE_DELAY_MS);

    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [
    accessToken,
    familySpaceId,
    gateway,
    generation?.id,
    generation?.status,
    learningProfileId,
    materialId,
    working,
  ]);

  function beginOperation(): number {
    operationEpoch.current += 1;
    mutationInFlight.current = true;
    setWorking(true);
    setError(null);
    return operationEpoch.current;
  }

  function finishOperation(epoch: number) {
    if (operationEpoch.current === epoch) {
      mutationInFlight.current = false;
      setWorking(false);
    }
  }

  async function startGeneration(useNewIdempotencyKey = false) {
    const epoch = beginOperation();
    if (useNewIdempotencyKey) {
      idempotencyKey.current = randomUUID();
    }
    setConfirmedRevealLevel(0);
    try {
      const next = await gateway.request({
        ...scope,
        idempotencyKey: idempotencyKey.current,
        materialId,
        processingJobId,
      });
      if (operationEpoch.current === epoch) {
        setGeneration(next);
      }
    } catch (caught) {
      if (operationEpoch.current === epoch) {
        setError(
          caught instanceof Error ? caught.message : 'AI 学习内容暂时无法生成，请稍后再试。',
        );
      }
    } finally {
      finishOperation(epoch);
    }
  }

  async function revealNextHint() {
    if (!generation) {
      return;
    }
    const epoch = beginOperation();
    const expectedLevel = visibleRevealLevel;
    try {
      const next = await gateway.revealNextHint({
        ...scope,
        expectedLevel,
        materialId,
        requestId: generation.id,
      });
      if (operationEpoch.current === epoch) {
        setGeneration(next);
        setConfirmedRevealLevel(
          Math.min(3, expectedLevel + 1, next.revealedHintLevel) as 0 | 1 | 2 | 3,
        );
      }
    } catch (caught) {
      if (operationEpoch.current === epoch) {
        setError(caught instanceof Error ? caught.message : '提示暂时无法展开，请稍后再试。');
      }
    } finally {
      finishOperation(epoch);
    }
  }

  async function cancelGeneration() {
    if (!generation) {
      return;
    }
    const epoch = beginOperation();
    try {
      const next = await gateway.cancel({ ...scope, materialId, requestId: generation.id });
      if (operationEpoch.current === epoch) {
        setGeneration(next);
        setConfirmedRevealLevel(0);
      }
    } catch (caught) {
      if (operationEpoch.current === epoch) {
        setError(caught instanceof Error ? caught.message : '暂时无法取消，请稍后再试。');
      }
    } finally {
      finishOperation(epoch);
    }
  }

  const isProcessing = generation ? ['queued', 'generating'].includes(generation.status) : false;
  const isUnavailable = generation
    ? ['canceled', 'unavailable'].includes(generation.status) ||
      (generation.status === 'ready' &&
        (generation.contentState === 'unavailable' || !generation.generatedContent))
    : false;
  const content =
    generation?.status === 'ready' &&
    generation.contentState !== 'unavailable' &&
    generation.generatedContent
      ? generation.generatedContent
      : null;
  const visibleRevealLevel = Math.min(generation?.revealedHintLevel ?? 0, confirmedRevealLevel) as
    0 | 1 | 2 | 3;

  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <View style={styles.aiMark} accessibilityElementsHidden>
          <Text style={styles.aiMarkText}>AI</Text>
        </View>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={styles.title}>
            AI 学习助手
          </Text>
          <Text style={styles.mutedText}>根据当前学习依据重新整理，不直接复制原题。</Text>
        </View>
      </View>

      {!generation ? (
        <LearningButton
          disabled={working}
          label="生成 AI 学习内容"
          onPress={() => void startGeneration()}
          primary
        />
      ) : (
        <>
          <Text style={styles.disclosure}>{generation.aiDisclosure}</Text>
          <View style={styles.metadata}>
            <Text style={styles.metadataText}>
              生成任务：{requestStatusLabels[generation.status]}
            </Text>
            <Text style={styles.metadataText}>
              内容状态：
              {isProcessing
                ? '尚未生成'
                : generation.contentState === 'direct_learning'
                  ? '可直接学习'
                  : generation.contentState === 'confirmation_recommended'
                    ? '建议确认'
                    : '暂不可用'}
            </Text>
            <Text style={styles.metadataText}>
              来源版本：{generation.sourceVersion.versionLabel} · 选择{' '}
              {generation.sourceVersion.basisSelectionVersion} · 归类{' '}
              {generation.sourceVersion.classificationRevision}
            </Text>
            <Text style={styles.metadataText}>
              能力版本：{generation.capabilityVersion?.id ?? '等待已签署能力'}
            </Text>
            <Text style={styles.metadataText}>授权决策：{generation.authorizationDecision.id}</Text>
          </View>

          {isProcessing ? (
            <View
              accessibilityLiveRegion="polite"
              accessibilityState={{ busy: true }}
              style={styles.processingRow}
            >
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.processingText}>正在生成并执行发布前检查，请稍候。</Text>
            </View>
          ) : null}

          {isProcessing ? (
            <LearningButton
              disabled={working}
              label="取消生成"
              onPress={() => void cancelGeneration()}
            />
          ) : null}

          {isUnavailable ? (
            <>
              <View accessibilityLiveRegion="assertive" style={styles.unavailableCard}>
                <Text style={styles.unavailableTitle}>AI 学习内容暂不可用</Text>
                <Text style={styles.unavailableText}>
                  {generation.unavailableReason
                    ? unavailableReasonLabels[generation.unavailableReason]
                    : '这次内容没有达到安全展示条件，因此没有展示。'}
                </Text>
              </View>
              <LearningButton
                disabled={working}
                label="重新生成"
                onPress={() => void startGeneration(true)}
                primary
              />
            </>
          ) : null}

          {content ? (
            <>
              <Text accessibilityLiveRegion="polite" style={styles.readyAnnouncement}>
                AI 学习内容已准备好，可以开始复习。
              </Text>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryEyebrow}>本次要点</Text>
                <Text style={styles.summaryTitle}>{content.summary.title}</Text>
                {content.summary.keyPoints.map((point) => (
                  <Text key={point} style={styles.summaryPoint}>
                    {point}
                  </Text>
                ))}
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>依据重点词</Text>
                <Text style={styles.sourceText}>
                  总体来源：{generation.sourceVersion.versionLabel}
                </Text>
                {content.keyTerms.map((keyTerm) => (
                  <View
                    key={`${keyTerm.term}:${keyTerm.sourceRegionIds.join(':')}`}
                    style={styles.keyTermRow}
                  >
                    <Text style={styles.keyTermText}>{keyTerm.term}</Text>
                    <Text style={styles.sourceText}>
                      来源片段：{keyTerm.sourceRegionIds.join('、')}
                    </Text>
                  </View>
                ))}
              </View>

              {visibleRevealLevel >= 1 && content.orientationHint ? (
                <View style={styles.hintCard}>
                  <Text style={styles.hintLabel}>方向提示</Text>
                  <Text style={styles.hintText}>{content.orientationHint}</Text>
                </View>
              ) : null}

              {visibleRevealLevel >= 2 && content.methodHint ? (
                <View style={styles.hintCard}>
                  <Text style={styles.hintLabel}>方法提示</Text>
                  <Text style={styles.hintText}>{content.methodHint}</Text>
                </View>
              ) : null}

              {visibleRevealLevel >= 3 && content.fullExplanation ? (
                <View style={styles.explanationCard}>
                  <Text style={styles.sectionTitle}>完整分步讲解</Text>
                  {content.fullExplanation.steps.map((step, index) => (
                    <View key={`${index}:${step}`} style={styles.explanationStep}>
                      <Text style={styles.stepNumber}>{index + 1}</Text>
                      <Text style={styles.hintText}>{step}</Text>
                    </View>
                  ))}
                  <Text style={styles.answerText}>答案：{content.fullExplanation.answer}</Text>
                </View>
              ) : null}

              {visibleRevealLevel < 3 ? (
                <LearningButton
                  disabled={working}
                  label={
                    visibleRevealLevel === 0
                      ? '先看方向提示'
                      : visibleRevealLevel === 1
                        ? '再看方法提示'
                        : '查看完整分步讲解'
                  }
                  onPress={() => void revealNextHint()}
                />
              ) : null}

              <QuestionList emptyLabel="本次没有生成小测。" items={content.quiz} title="小测一下" />
              <QuestionList
                emptyLabel="本次没有生成变式练习。"
                items={content.variations}
                title="变式练习"
              />

              {content.supplementalNotes.length > 0 ? (
                <View style={styles.supplementalCard}>
                  <Text style={styles.sectionTitle}>补充说明</Text>
                  {content.supplementalNotes.map((note) => (
                    <Text key={note} style={styles.mutedText}>
                      {note}
                    </Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </>
      )}

      {error ? (
        <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  aiMark: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 18,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  aiMarkText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  answerText: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 17,
    fontWeight: '800',
    padding: spacing.md,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  buttonText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  disabledButton: { opacity: 0.42 },
  disclosure: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  errorText: {
    backgroundColor: '#FEE4E2',
    borderRadius: radii.md,
    color: colors.error,
    fontSize: 15,
    lineHeight: 23,
    padding: spacing.md,
  },
  explanationCard: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  explanationStep: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  headingCopy: { flex: 1, gap: 4 },
  headingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  hintCard: {
    backgroundColor: '#FFF8E7',
    borderColor: '#E8BE65',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  hintLabel: { color: '#8A4B08', fontSize: 13, fontWeight: '800' },
  hintText: { color: colors.foreground, flex: 1, fontSize: 16, lineHeight: 25 },
  keyTermRow: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: 4,
    padding: spacing.md,
  },
  keyTermText: { color: colors.foreground, fontSize: 16, fontWeight: '700' },
  metadata: { gap: 4 },
  metadataText: { color: colors.mutedForeground, fontSize: 13, lineHeight: 20 },
  mutedText: { color: colors.mutedForeground, fontSize: 14, lineHeight: 22 },
  pressedButton: { opacity: 0.8 },
  primaryButton: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryButtonText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
  processingRow: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    padding: spacing.md,
  },
  processingText: { color: colors.foreground, flex: 1, fontSize: 15, lineHeight: 22 },
  questionNumber: {
    backgroundColor: colors.primarySoft,
    borderRadius: 14,
    color: colors.primary,
    fontSize: 13,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  questionRow: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  questionText: { color: colors.foreground, flex: 1, fontSize: 15, lineHeight: 23 },
  readyAnnouncement: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 23,
  },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.foreground, fontSize: 17, fontWeight: '800' },
  stepNumber: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '800',
    minWidth: 20,
    paddingTop: 2,
  },
  sourceText: { color: colors.mutedForeground, fontSize: 13, lineHeight: 20 },
  summaryCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  summaryEyebrow: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  summaryPoint: { color: colors.foreground, fontSize: 15, lineHeight: 23 },
  summaryTitle: { color: colors.foreground, fontSize: 20, fontWeight: '800' },
  supplementalCard: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  title: { color: colors.foreground, fontSize: 20, fontWeight: '800' },
  unavailableCard: {
    backgroundColor: '#FFF4E5',
    borderColor: '#F79009',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  unavailableText: { color: '#7A2E0E', fontSize: 15, lineHeight: 23 },
  unavailableTitle: { color: '#7A2E0E', fontSize: 17, fontWeight: '800' },
});
