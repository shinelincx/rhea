import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type {
  MobileReviewAttemptResult,
  MobileShortReviewSession,
  PerceivedDifficulty,
  ReviewCardGateway,
  ReviewSubject,
} from './review-card-gateway';

interface ShortReviewScreenProps {
  accessToken: string;
  familySpaceId: string;
  gateway: ReviewCardGateway;
  learningProfileId: string;
  onBack: () => void;
}

const SUBJECT_LABELS: Record<ReviewSubject, string> = {
  chinese: '语文',
  english: '英语',
  mathematics: '数学',
  science: '科学',
};

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

export function ShortReviewScreen({
  accessToken,
  familySpaceId,
  gateway,
  learningProfileId,
  onBack,
}: ShortReviewScreenProps) {
  const [session, setSession] = useState<MobileShortReviewSession | null>(null);
  const [index, setIndex] = useState(0);
  const [responseText, setResponseText] = useState('');
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2>(0);
  const [difficulty, setDifficulty] = useState<PerceivedDifficulty | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<MobileReviewAttemptResult | null>(null);
  const [completed, setCompleted] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = { accessToken, familySpaceId, learningProfileId };
  const load = useCallback(async () => {
    setWorking(true);
    setError(null);
    try {
      setSession(await gateway.createSession(scope));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '短复习暂时无法加载，请稍后再试。');
    } finally {
      setWorking(false);
    }
  }, [accessToken, familySpaceId, gateway, learningProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = session?.cards[index] ?? null;
  const finished = Boolean(
    session && (session.cards.length === 0 || index >= session.cards.length),
  );

  async function submit() {
    if (!session || !card || !responseText.trim() || working) return;
    setWorking(true);
    setError(null);
    try {
      const result = await gateway.submitAttempt({
        ...scope,
        cardId: card.id,
        hintLevel,
        idempotencyKey: randomUUID(),
        perceivedDifficulty: difficulty,
        responseText,
        sessionId: session.id,
      });
      setFeedback(result);
      setCompleted((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '这次作答暂时没有提交成功，请重试。');
    } finally {
      setWorking(false);
    }
  }

  function nextCard() {
    setIndex((value) => value + 1);
    setResponseText('');
    setHintLevel(0);
    setDifficulty(null);
    setExpanded(false);
    setFeedback(null);
    setError(null);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.screen}>
          <View style={styles.headerRow}>
            <ActionButton label="返回今日路线" onPress={onBack} />
            {session && session.cards.length > 0 && !finished ? (
              <Text accessibilityLiveRegion="polite" style={styles.progressText}>
                {index + 1} / {session.cards.length}
              </Text>
            ) : null}
          </View>

          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>
              今日短复习
            </Text>
            <Text style={styles.subtitle}>一次最多 5 张，有明确结束点。</Text>
          </View>

          {working && !session ? (
            <View accessibilityLiveRegion="polite" style={styles.centerState}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.mutedText}>正在整理到期复习卡…</Text>
            </View>
          ) : null}

          {error && !session ? (
            <View accessibilityLiveRegion="assertive" style={styles.stateCard}>
              <Text accessibilityRole="header" style={styles.stateTitle}>
                暂时没加载出来
              </Text>
              <Text style={styles.errorText}>{error}</Text>
              <ActionButton label="重新加载" onPress={() => void load()} primary />
            </View>
          ) : null}

          {finished ? (
            <View accessibilityLiveRegion="polite" style={styles.stateCard}>
              <Text accessibilityRole="header" style={styles.stateTitle}>
                本次复习完成
              </Text>
              <Text style={styles.stateBody}>
                {completed > 0
                  ? `已完成 ${completed} 张。其余卡片会按到期时间自动顺延，不会扣分。`
                  : '今天没有到期卡片，可以安心去做其他学习任务。'}
              </Text>
              <ActionButton label="回到今日路线" onPress={onBack} primary />
            </View>
          ) : null}

          {card && !finished ? (
            <View style={styles.card}>
              <View style={styles.metaRow}>
                <Text style={styles.aiBadge}>AI 重新生成 · 已检查</Text>
                <Text style={styles.subjectBadge}>{SUBJECT_LABELS[card.content.subject]}</Text>
                <Text style={styles.dueBadge}>
                  {card.schedule.pendingCorrection ? '待订正 · 今日优先' : '今日到期'}
                </Text>
              </View>
              <Text style={styles.knowledgePoint}>{card.content.knowledgePointName}</Text>
              <Text accessibilityRole="header" style={styles.question}>
                {card.content.question}
              </Text>

              {!feedback ? (
                <>
                  {hintLevel >= 1 ? (
                    <View accessibilityLiveRegion="polite" style={styles.hintBox}>
                      <Text style={styles.hintLabel}>定位提示</Text>
                      <Text style={styles.hintText}>{card.content.orientationHint}</Text>
                    </View>
                  ) : null}
                  {hintLevel >= 2 ? (
                    <View accessibilityLiveRegion="polite" style={styles.hintBox}>
                      <Text style={styles.hintLabel}>方法提示</Text>
                      <Text style={styles.hintText}>{card.content.methodHint}</Text>
                    </View>
                  ) : null}
                  {hintLevel < 2 ? (
                    <ActionButton
                      label={hintLevel === 0 ? '看定位提示' : '再看方法提示'}
                      onPress={() => setHintLevel((hintLevel + 1) as 1 | 2)}
                    />
                  ) : null}

                  <View style={styles.formGroup}>
                    <Text nativeID="review-answer-label" style={styles.label}>
                      我的答案
                    </Text>
                    <TextInput
                      accessibilityLabelledBy="review-answer-label"
                      editable={!working}
                      onChangeText={setResponseText}
                      placeholder="在这里作答"
                      placeholderTextColor={colors.mutedForeground}
                      returnKeyType="done"
                      style={styles.input}
                      value={responseText}
                    />
                  </View>

                  <View style={styles.formGroup}>
                    <Text style={styles.label}>这张卡感觉怎样？（不影响评分和间隔）</Text>
                    <View style={styles.choiceRow}>
                      {(
                        [
                          ['easy', '太简单'],
                          ['okay', '正合适'],
                          ['hard', '有点难'],
                        ] as const
                      ).map(([value, label]) => (
                        <Pressable
                          accessibilityLabel={label}
                          accessibilityRole="button"
                          accessibilityState={{ selected: difficulty === value }}
                          key={value}
                          onPress={() => setDifficulty(value)}
                          style={({ pressed }) => [
                            styles.choiceButton,
                            difficulty === value ? styles.choiceButtonSelected : null,
                            pressed ? styles.pressedButton : null,
                          ]}
                        >
                          <Text
                            style={
                              difficulty === value ? styles.choiceTextSelected : styles.choiceText
                            }
                          >
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  {error ? (
                    <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
                      {error}
                    </Text>
                  ) : null}
                  <ActionButton
                    disabled={!responseText.trim() || working}
                    label={working ? '正在提交…' : '提交答案'}
                    onPress={() => void submit()}
                    primary
                  />
                </>
              ) : (
                <View accessibilityLiveRegion="polite" style={styles.feedbackBox}>
                  {feedback.feedback.currentState === 'theme_mastered' ? (
                    <Text style={styles.masteryBadge}>已掌握 · 已归档</Text>
                  ) : null}
                  <Text accessibilityRole="header" style={styles.feedbackTitle}>
                    {feedback.feedback.currentState === 'theme_mastered'
                      ? '这个主题已掌握'
                      : feedback.feedback.outcome === 'correct'
                        ? '本次回答正确'
                        : '这次还需要订正'}
                  </Text>
                  <Text style={styles.feedbackLine}>参考答案：{feedback.feedback.answer}</Text>
                  {feedback.feedback.explanationSteps.map((step, stepIndex) => (
                    <Text key={`${stepIndex}-${step}`} style={styles.feedbackLine}>
                      {stepIndex + 1}. {step}
                    </Text>
                  ))}
                  <Text style={styles.feedbackNote}>{feedback.feedback.hintImpact}</Text>
                  <Text style={styles.feedbackNote}>{feedback.feedback.nextAction}</Text>
                  <ActionButton
                    label={index + 1 >= (session?.cards.length ?? 0) ? '完成本次复习' : '下一张'}
                    onPress={nextCard}
                    primary
                  />
                </View>
              )}

              <Pressable
                accessibilityLabel={expanded ? '收起原题与依据' : '查看原题与依据'}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((value) => !value)}
                style={({ pressed }) => [
                  styles.originalToggle,
                  pressed ? styles.pressedButton : null,
                ]}
              >
                <Text style={styles.originalToggleText}>
                  {expanded ? '收起原题与依据' : '查看原题与依据'}
                </Text>
              </Pressable>
              {expanded ? (
                <View style={styles.originalBox}>
                  <Text style={styles.originalLabel}>原题</Text>
                  <Text style={styles.originalText}>{card.original.question}</Text>
                  <Text style={styles.originalLabel}>原作答</Text>
                  <Text style={styles.originalText}>{card.original.response}</Text>
                  <Text style={styles.originalLabel}>当前学习依据</Text>
                  <Text style={styles.originalText}>
                    {card.original.currentLearningBasis.versionLabel}
                  </Text>
                  <Text style={styles.originalLabel}>重新生成改变点</Text>
                  {card.content.keyChanges.map((change) => (
                    <Text key={change} style={styles.originalText}>
                      · {change}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  aiBadge: {
    backgroundColor: colors.primarySoft,
    borderRadius: 14,
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  button: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  buttonText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  centerState: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  choiceButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    flexBasis: 96,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  choiceButtonSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choiceText: { color: colors.foreground, fontSize: 14, fontWeight: '600' },
  choiceTextSelected: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  disabledButton: { opacity: 0.48 },
  dueBadge: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  errorText: { color: colors.error, fontSize: 16, lineHeight: 24 },
  feedbackBox: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  feedbackLine: { color: colors.foreground, fontSize: 16, lineHeight: 25 },
  feedbackNote: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  feedbackTitle: { color: colors.foreground, fontSize: 21, fontWeight: '800' },
  formGroup: { gap: spacing.xs },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  heading: { gap: spacing.xs },
  hintBox: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  hintLabel: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  hintText: { color: colors.foreground, fontSize: 16, lineHeight: 25 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 18,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  knowledgePoint: { color: colors.mutedForeground, fontSize: 15, fontWeight: '600' },
  label: { color: colors.foreground, fontSize: 16, fontWeight: '700', lineHeight: 24 },
  metaRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  masteryBadge: {
    alignSelf: 'flex-start',
    borderColor: colors.primary,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  mutedText: { color: colors.mutedForeground, fontSize: 16, lineHeight: 24 },
  originalBox: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  originalLabel: { color: colors.primary, fontSize: 14, fontWeight: '800', marginTop: spacing.xs },
  originalText: { color: colors.foreground, fontSize: 15, lineHeight: 23 },
  originalToggle: { alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  originalToggleText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  pressedButton: { opacity: 0.78 },
  primaryButton: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryButtonText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  progressText: { color: colors.mutedForeground, fontSize: 16, fontWeight: '700' },
  question: { color: colors.foreground, fontSize: 25, fontWeight: '800', lineHeight: 36 },
  safeArea: { backgroundColor: colors.background, flex: 1 },
  screen: { alignSelf: 'center', gap: spacing.lg, maxWidth: 720, width: '100%' },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  stateBody: { color: colors.mutedForeground, fontSize: 17, lineHeight: 27, textAlign: 'center' },
  stateCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.xl,
  },
  stateTitle: { color: colors.foreground, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  subjectBadge: {
    borderColor: colors.borderStrong,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  subtitle: { color: colors.mutedForeground, fontSize: 16, lineHeight: 24 },
  title: { color: colors.foreground, fontSize: 30, fontWeight: '800', lineHeight: 38 },
});
