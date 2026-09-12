import { useCallback, useEffect, useMemo, useState } from 'react';
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
  ChallengeGateway,
  ChallengeScope,
  MobileChallenge,
  MobilePartnerRelation,
} from './challenge-gateway';

interface ChallengeScreenProps extends ChallengeScope {
  gateway: ChallengeGateway;
  onBack: () => void;
}

interface Dashboard {
  challenges: MobileChallenge[];
  relations: MobilePartnerRelation[];
}

export function ChallengeScreen({
  accessToken,
  familySpaceId,
  gateway,
  learningProfileId,
  onBack,
}: ChallengeScreenProps) {
  const scope = useMemo(
    () => ({ accessToken, familySpaceId, learningProfileId }),
    [accessToken, familySpaceId, learningProfileId],
  );
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selected, setSelected] = useState<MobileChallenge | null>(null);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [answer, setAnswer] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [relations, challenges] = await Promise.all([
        gateway.listRelations(scope),
        gateway.listChallenges(scope),
      ]);
      setDashboard({ challenges, relations });
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '挑战暂时没有加载出来');
    }
  }, [gateway, scope]);

  useEffect(() => void load(), [load]);

  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作没有完成，请再试一次');
    } finally {
      setBusy(false);
    }
  }

  const currentItem = selected?.items.find((item) => !item.response) ?? null;

  if (selected) {
    const completed = selected.status === 'completed';
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(null)}
            style={styles.backButton}
          >
            <Text style={styles.backText}>返回挑战中心</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            {selected.target}
          </Text>
          <Text style={styles.rule}>异步完成 · 速度不计分 · 随时退出不受惩罚</Text>
          <View style={styles.progressCard}>
            <Text style={styles.cardTitle}>本场进度</Text>
            <Text style={styles.body}>
              我：{selected.myProgress.completedItems}/{selected.myProgress.totalItems}　同学：
              {selected.opponentProgress.completedItems}/{selected.opponentProgress.totalItems}
            </Text>
          </View>

          {completed && selected.score ? (
            <View style={styles.resultCard}>
              <Text accessibilityRole="header" style={styles.cardTitle}>
                一起完成啦
              </Text>
              <Text style={styles.resultNumber}>{Math.round(selected.score.accuracy * 100)}%</Text>
              <Text style={styles.body}>
                答对 {selected.score.correctItems} / {selected.score.totalItems}{' '}
                题。挑战只作为辅助学习反馈，不单独改变掌握状态。
              </Text>
              {selected.knowledgeFeedback.map((feedback) => (
                <Text key={feedback.knowledgePoint} style={styles.feedback}>
                  {feedback.knowledgePoint}：{feedback.correctItems}/{feedback.totalItems}
                </Text>
              ))}
            </View>
          ) : selected.status === 'cancelled' ? (
            <View style={styles.progressCard}>
              <Text style={styles.cardTitle}>这场挑战已结束</Text>
              <Text style={styles.body}>没有扣分或其他惩罚，想学习时可以再发起一场。</Text>
            </View>
          ) : currentItem ? (
            <View style={styles.questionCard}>
              <Text style={styles.eyebrow}>
                第 {selected.myProgress.completedItems + 1} 题 · {currentItem.knowledgePoint}
              </Text>
              <Text accessibilityRole="header" style={styles.question}>
                {currentItem.prompt}
              </Text>
              {currentItem.options ? (
                currentItem.options.map((option) => (
                  <Pressable
                    accessibilityRole="button"
                    key={option.id}
                    onPress={() => setAnswer(option.id)}
                    style={[styles.option, answer === option.id ? styles.optionSelected : null]}
                  >
                    <Text style={styles.optionText}>
                      {option.id.toUpperCase()}　{option.text}
                    </Text>
                  </Pressable>
                ))
              ) : (
                <TextInput
                  accessibilityLabel="我的挑战答案"
                  keyboardType="numbers-and-punctuation"
                  onChangeText={setAnswer}
                  placeholder="写下答案"
                  style={styles.input}
                  value={answer}
                />
              )}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !answer.trim()}
                onPress={() =>
                  void act(async () => {
                    const updated = await gateway.submitAnswer({
                      ...scope,
                      answer,
                      challengeId: selected.id,
                      commandId: `${selected.id}-${currentItem.id}-${Date.now()}`,
                      itemId: currentItem.id,
                    });
                    setSelected(updated);
                    setAnswer('');
                  })
                }
                style={[styles.primaryButton, busy || !answer.trim() ? styles.disabled : null]}
              >
                <Text style={styles.primaryText}>{busy ? '正在提交…' : '提交这一题'}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.progressCard}>
              <Text style={styles.cardTitle}>我的题已完成</Text>
              <Text style={styles.body}>同学可以按自己的节奏完成，结果会在双方完成后显示。</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void act(async () =>
                    setSelected(await gateway.getChallenge({ ...scope, challengeId: selected.id })),
                  )
                }
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryText}>刷新进度</Text>
              </Pressable>
            </View>
          )}

          {selected.status === 'active' ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void act(async () =>
                  setSelected(await gateway.leaveChallenge({ ...scope, challengeId: selected.id })),
                )
              }
              style={styles.leaveButton}
            >
              <Text style={styles.leaveText}>退出这场挑战（无惩罚）</Text>
            </Pressable>
          ) : null}
          {notice ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {notice}
            </Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.brand}>Rhea</Text>
            <Text accessibilityRole="header" style={styles.title}>
              同伴挑战
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
            <Text style={styles.backText}>返回今日</Text>
          </Pressable>
        </View>
        <Text style={styles.intro}>
          和学习伙伴做不同题面的同目标练习。没有速度排名，也不会因退出受惩罚。
        </Text>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            邀请学习伙伴
          </Text>
          <Text style={styles.body}>邀请码 15 分钟内一次有效，只用来建立学习伙伴关系。</Text>
          {invite ? (
            <View style={styles.inviteCode}>
              <Text selectable style={styles.code}>
                {invite.code}
              </Text>
              <Text style={styles.meta}>请当面或通过监护人分享，过期后重新创建。</Text>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void act(async () => setInvite(await gateway.createInvite(scope)))}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryText}>{invite ? '创建新的邀请码' : '创建邀请码'}</Text>
          </Pressable>
          <View style={styles.divider} />
          <TextInput
            accessibilityLabel="同学的邀请码"
            autoCapitalize="characters"
            maxLength={14}
            onChangeText={setInviteCode}
            placeholder="输入 12 位邀请码"
            style={styles.input}
            value={inviteCode}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || inviteCode.trim().length < 12}
            onPress={() =>
              void act(async () => {
                await gateway.redeemInvite({ ...scope, code: inviteCode });
                setInviteCode('');
                await load();
                setNotice('已成为学习伙伴，可以一起挑战了。');
              })
            }
            style={[
              styles.secondaryButton,
              busy || inviteCode.trim().length < 12 ? styles.disabled : null,
            ]}
          >
            <Text style={styles.secondaryText}>使用邀请码</Text>
          </Pressable>
        </View>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            我的学习伙伴
          </Text>
          {!dashboard ? (
            <ActivityIndicator color={colors.primary} />
          ) : dashboard.relations.filter((relation) => relation.status === 'active').length ===
            0 ? (
            <Text style={styles.body}>还没有学习伙伴，先创建或使用邀请码吧。</Text>
          ) : (
            dashboard.relations
              .filter((relation) => relation.status === 'active')
              .map((relation) => {
                const partner = relation.participants.find(
                  (participant) => participant.learningProfileId !== learningProfileId,
                )!;
                return (
                  <View key={relation.id} style={styles.partnerCard}>
                    <View style={styles.partnerIdentity}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>伴</Text>
                      </View>
                      <View>
                        <Text style={styles.partnerName}>学习伙伴</Text>
                        <Text style={styles.meta}>
                          伙伴编号 {partner.learningProfileId.slice(0, 6)}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() =>
                        void act(async () => {
                          const challenge = await gateway.createChallenge({
                            ...scope,
                            relationId: relation.id,
                            subject: 'mathematics',
                            target: '今日数学知识巩固',
                          });
                          setSelected(challenge);
                        })
                      }
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryText}>发起数学挑战</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() =>
                        void act(async () => {
                          await gateway.dissolveRelation({ ...scope, relationId: relation.id });
                          await load();
                        })
                      }
                      style={styles.textButton}
                    >
                      <Text style={styles.leaveText}>解除学习伙伴关系</Text>
                    </Pressable>
                  </View>
                );
              })
          )}
        </View>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            可以继续的挑战
          </Text>
          {dashboard?.challenges
            .filter((challenge) => challenge.status === 'active')
            .map((challenge) => (
              <Pressable
                accessibilityRole="button"
                key={challenge.id}
                onPress={() => setSelected(challenge)}
                style={styles.challengeRow}
              >
                <View>
                  <Text style={styles.partnerName}>{challenge.target}</Text>
                  <Text style={styles.meta}>
                    我的进度 {challenge.myProgress.completedItems}/{challenge.myProgress.totalItems}
                  </Text>
                </View>
                <Text style={styles.secondaryText}>继续</Text>
              </Pressable>
            ))}
          {dashboard &&
          dashboard.challenges.filter((challenge) => challenge.status === 'active').length === 0 ? (
            <Text style={styles.body}>目前没有进行中的挑战。</Text>
          ) : null}
        </View>
        {notice ? (
          <Text
            accessibilityLiveRegion="polite"
            style={notice.startsWith('已') ? styles.notice : styles.error}
          >
            {notice}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  avatarText: { color: colors.primary, fontSize: 18, fontWeight: '800' },
  backButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  backText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  brand: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  cardTitle: { color: colors.foreground, fontSize: 20, fontWeight: '800', lineHeight: 28 },
  challengeRow: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
    padding: spacing.md,
  },
  code: { color: colors.primary, fontSize: 28, fontWeight: '900', letterSpacing: 3 },
  content: {
    alignSelf: 'center',
    gap: spacing.md,
    maxWidth: 720,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    width: '100%',
  },
  disabled: { opacity: 0.45 },
  divider: { backgroundColor: colors.border, height: 1, marginVertical: spacing.xs },
  error: {
    backgroundColor: '#FEE4E2',
    borderRadius: radii.md,
    color: colors.error,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  eyebrow: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  feedback: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    padding: spacing.sm,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 17,
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  intro: { color: colors.mutedForeground, fontSize: 16, lineHeight: 25 },
  inviteCode: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  leaveButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  leaveText: { color: colors.mutedForeground, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.mutedForeground, fontSize: 13, lineHeight: 20 },
  notice: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  option: {
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  optionSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  optionText: { color: colors.foreground, fontSize: 16 },
  partnerCard: {
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  partnerIdentity: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  partnerName: { color: colors.foreground, fontSize: 16, fontWeight: '800' },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  progressCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  question: { color: colors.foreground, fontSize: 24, fontWeight: '800', lineHeight: 34 },
  questionCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  resultCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.lg,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  resultNumber: { color: colors.primary, fontSize: 42, fontWeight: '900' },
  rule: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  safeArea: { backgroundColor: colors.background, flex: 1 },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.primary,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  secondaryText: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  textButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  title: { color: colors.foreground, fontSize: 30, fontWeight: '900', lineHeight: 38 },
});
