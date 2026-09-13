import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type { GrowthGateway, MobileGrowthView } from './growth-gateway';

const LABELS: Record<string, string> = {
  learning_evidence: '学习证据 · 60%',
  review_consistency: '复习坚持 · 30%',
  safe_participation: '安全参与 · 10%',
};

export function GrowthScreen(props: {
  accessToken: string;
  familySpaceId: string;
  gateway: GrowthGateway;
  learningProfileId: string;
  onBack: () => void;
}) {
  const [growth, setGrowth] = useState<MobileGrowthView | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      setError(false);
      setGrowth(await props.gateway.getGrowth(props));
    } catch {
      setError(true);
    }
  }, [props.accessToken, props.familySpaceId, props.gateway, props.learningProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>Rhea</Text>
            <Text accessibilityRole="header" style={styles.title}>
              我的成长
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={props.onBack} style={styles.backButton}>
            <Text style={styles.backText}>返回今日</Text>
          </Pressable>
        </View>
        {!growth && !error ? <ActivityIndicator color={colors.primary} size="large" /> : null}
        {error ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>暂时没有加载出来</Text>
            <Text style={styles.body}>检查网络后重试，已有奖励不会丢失。</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void load()}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>重新加载</Text>
            </Pressable>
          </View>
        ) : null}
        {growth ? (
          <>
            <View style={styles.hero}>
              <Text style={styles.eyebrow}>成长分</Text>
              <Text style={styles.score}>{growth.growthScore}</Text>
              <Text style={styles.heroText}>
                等级 {growth.level} · {growth.xp} XP
              </Text>
              <Text style={styles.body}>
                再积累 {Math.max(0, growth.nextLevelAtXp - growth.xp)} XP 到下一等级
              </Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>成长分从哪里来</Text>
              {growth.components.map((component) => (
                <View key={component.name} style={styles.component}>
                  <View style={styles.row}>
                    <Text style={styles.componentTitle}>
                      {LABELS[component.name] ?? component.name}
                    </Text>
                    <Text style={styles.points}>
                      {component.contribution}/{component.maximumContribution}
                    </Text>
                  </View>
                  <Text style={styles.body}>{component.explanation}</Text>
                </View>
              ))}
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>连续学习 {growth.streak.currentDays} 天</Text>
              <Text style={styles.body}>
                最好记录 {growth.streak.bestDays} 天。{growth.streak.message}
              </Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>我的徽章</Text>
              {growth.badges.length ? (
                growth.badges.map((badge) => (
                  <View key={badge.key} style={styles.badge}>
                    <Text style={styles.badgeIcon}>★</Text>
                    <View style={styles.badgeCopy}>
                      <Text style={styles.componentTitle}>{badge.label}</Text>
                      <Text style={styles.body}>{badge.description}</Text>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.body}>完成第一条有效学习证据，就能获得第一枚徽章。</Text>
              )}
            </View>
            <Text style={styles.policy}>
              没有全网排名或速度榜。退出、举报、断网、错过任务都不扣分；学习功能永远不会被
              XP、付费或个人信息要求锁住。
            </Text>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  backText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  badge: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  badgeCopy: { flex: 1 },
  badgeIcon: {
    backgroundColor: colors.primarySoft,
    borderRadius: 24,
    color: colors.primary,
    fontSize: 22,
    overflow: 'hidden',
    padding: spacing.sm,
  },
  body: { color: colors.mutedForeground, fontSize: 14, lineHeight: 22 },
  brand: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  cardTitle: { color: colors.foreground, fontSize: 20, fontWeight: '800' },
  component: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  componentTitle: { color: colors.foreground, fontSize: 15, fontWeight: '800' },
  content: {
    alignSelf: 'center',
    gap: spacing.md,
    maxWidth: 720,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    width: '100%',
  },
  eyebrow: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  hero: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radii.lg,
    gap: spacing.xs,
    padding: spacing.xl,
  },
  heroText: { color: colors.foreground, fontSize: 18, fontWeight: '800' },
  points: { color: colors.primary, fontSize: 17, fontWeight: '900' },
  policy: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  row: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  safeArea: { backgroundColor: colors.background, flex: 1 },
  score: { color: colors.primary, fontSize: 60, fontWeight: '900' },
  title: { color: colors.foreground, fontSize: 30, fontWeight: '900' },
});
