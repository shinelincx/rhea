import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type { LoadTodayRoute, TodayRoute, TodayRouteItem } from './types';

interface TodayRouteScreenProps {
  learningProfileName?: string;
  loadRoute: LoadTodayRoute;
  onStartCapture?: () => void;
  onStartReview?: () => void;
  onSwitchProfile?: () => void;
}

type ScreenState =
  { status: 'loading' } | { status: 'loaded'; route: TodayRoute } | { status: 'error' };

export function TodayRouteScreen({
  learningProfileName,
  loadRoute,
  onStartCapture,
  onStartReview,
  onSwitchProfile,
}: TodayRouteScreenProps) {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const route = await loadRoute();
      setState({ route, status: 'loaded' });
    } catch {
      setState({ status: 'error' });
    }
  }, [loadRoute]);

  useEffect(() => {
    void load();
  }, [load]);

  function start(item: TodayRouteItem) {
    if (
      item.action === 'confirm_content' ||
      item.action === 'resume_learning' ||
      item.action === 'review_result'
    ) {
      onStartCapture?.();
      return;
    }
    if (
      item.action === 'correct_wrong_item' ||
      item.action === 'start_review' ||
      item.action === 'start_variation'
    ) {
      onStartReview?.();
    }
  }

  function canStart(item: TodayRouteItem): boolean {
    if (
      item.action === 'confirm_content' ||
      item.action === 'resume_learning' ||
      item.action === 'review_result'
    ) {
      return Boolean(onStartCapture);
    }
    if (
      item.action === 'correct_wrong_item' ||
      item.action === 'start_review' ||
      item.action === 'start_variation'
    ) {
      return Boolean(onStartReview);
    }
    return false;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <Text style={styles.brand}>Rhea</Text>
            {learningProfileName && onSwitchProfile ? (
              <Pressable
                accessibilityRole="button"
                onPress={onSwitchProfile}
                style={({ pressed }) => [
                  styles.switchButton,
                  pressed ? styles.switchButtonPressed : null,
                ]}
              >
                <Text style={styles.switchButtonText}>{learningProfileName} · 切换</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.title}>今天先做什么？</Text>
        </View>

        <View accessibilityLiveRegion="polite" style={styles.content}>
          {state.status === 'loading' ? (
            <View style={styles.centeredState}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.stateText}>正在整理今日路线…</Text>
            </View>
          ) : null}

          {state.status === 'loaded' && state.route.items.length === 0 ? (
            <View style={styles.emptyState}>
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.orbit}
              >
                <View style={styles.orbitCore} />
              </View>
              <Text accessibilityRole="header" style={styles.emptyTitle}>
                今天没有待办
              </Text>
              <Text style={styles.emptyBody}>想学习时，拍一页练习就能开始。</Text>
              {onStartCapture ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onStartCapture}
                  style={({ pressed }) => [
                    styles.captureButton,
                    pressed ? styles.retryButtonPressed : null,
                  ]}
                >
                  <Text style={styles.retryButtonText}>拍照或导入作业</Text>
                </Pressable>
              ) : null}
              {onStartReview ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onStartReview}
                  style={({ pressed }) => [
                    styles.reviewButton,
                    pressed ? styles.retryButtonPressed : null,
                  ]}
                >
                  <Text style={styles.reviewButtonText}>开始今日短复习</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {state.status === 'loaded' && state.route.items.length > 0 ? (
            <ScrollView
              contentContainerStyle={styles.routeContent}
              showsVerticalScrollIndicator={false}
              style={styles.routeScroll}
            >
              <View style={styles.routeHeader}>
                <Text accessibilityRole="header" style={styles.routeTitle}>
                  今天有 {state.route.items.length} 个小步骤
                </Text>
                <Text style={styles.routeIntro}>从第一项开始就好，每次只处理一个明确行动。</Text>
                <Text style={styles.noPenalty}>{state.route.noPenaltyMessage}</Text>
              </View>
              {state.route.items.map((item, index) => {
                const enabled = canStart(item);
                return (
                  <View key={item.id} style={styles.routeCard}>
                    <View style={styles.routeCardHeader}>
                      <Text style={styles.stepBadge}>第 {index + 1} 步</Text>
                      <Text style={item.isOptional ? styles.optional : styles.required}>
                        {item.isOptional ? '可稍后' : '先完成'}
                      </Text>
                    </View>
                    <Text accessibilityRole="header" style={styles.routeCardTitle}>
                      {item.title}
                    </Text>
                    <Text style={styles.routeDetail}>{item.detail}</Text>
                    <Text style={styles.routeExplanation}>为什么现在做：{item.explanation}</Text>
                    <Text style={styles.routeMeta}>
                      约 {item.estimatedMinutes} 分钟 · 本次 {item.count} 项
                      {item.remainingCount > 0 ? ` · 另有 ${item.remainingCount} 项稍后安排` : ''}
                    </Text>
                    <Pressable
                      accessibilityLabel={`开始：${item.title}`}
                      accessibilityRole="button"
                      disabled={!enabled}
                      onPress={() => start(item)}
                      style={({ pressed }) => [
                        styles.routeButton,
                        !enabled ? styles.disabled : null,
                        pressed ? styles.retryButtonPressed : null,
                      ]}
                    >
                      <Text style={styles.retryButtonText}>
                        {enabled ? '开始这一步' : '即将开放'}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          ) : null}

          {state.status === 'error' ? (
            <View style={styles.centeredState}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>
                今日路线暂时没加载出来
              </Text>
              <Text style={styles.emptyBody}>检查网络后再试一次，内容不会丢失。</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void load()}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed ? styles.retryButtonPressed : null,
                ]}
              >
                <Text style={styles.retryButtonText}>重新加载</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  brand: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  centeredState: {
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 320,
  },
  captureButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  content: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: spacing.xxl,
  },
  emptyBody: {
    color: colors.mutedForeground,
    fontSize: 17,
    lineHeight: 27,
    maxWidth: 300,
    textAlign: 'center',
  },
  emptyState: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    maxWidth: 420,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    width: '100%',
  },
  emptyTitle: {
    color: colors.foreground,
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 32,
    textAlign: 'center',
  },
  disabled: { opacity: 0.45 },
  header: {
    gap: spacing.xs,
  },
  headerTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  orbit: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: 32,
    height: 64,
    justifyContent: 'center',
    marginBottom: spacing.sm,
    width: 64,
  },
  orbitCore: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    height: 24,
    width: 24,
  },
  retryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 48,
    minWidth: 144,
    paddingHorizontal: spacing.lg,
  },
  reviewButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  reviewButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  noPenalty: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  optional: { color: colors.mutedForeground, fontSize: 13, fontWeight: '700' },
  required: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  routeButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  routeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
    width: '100%',
  },
  routeCardHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  routeCardTitle: { color: colors.foreground, fontSize: 21, fontWeight: '800', lineHeight: 28 },
  routeContent: { gap: spacing.md, paddingBottom: spacing.xxl, paddingTop: spacing.lg },
  routeDetail: { color: colors.foreground, fontSize: 16, lineHeight: 24 },
  routeExplanation: { color: colors.mutedForeground, fontSize: 14, lineHeight: 22 },
  routeHeader: { gap: spacing.sm },
  routeIntro: { color: colors.mutedForeground, fontSize: 16, lineHeight: 24 },
  routeMeta: { color: colors.mutedForeground, fontSize: 13, fontWeight: '700', lineHeight: 20 },
  routeScroll: { alignSelf: 'stretch', flex: 1 },
  routeTitle: { color: colors.foreground, fontSize: 24, fontWeight: '800', lineHeight: 32 },
  stepBadge: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.primary,
    fontSize: 13,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  retryButtonPressed: {
    opacity: 0.82,
  },
  retryButtonText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '700',
  },
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
  screen: {
    alignSelf: 'center',
    flex: 1,
    maxWidth: 720,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    width: '100%',
  },
  stateText: {
    color: colors.mutedForeground,
    fontSize: 16,
    lineHeight: 24,
  },
  switchButton: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  switchButtonPressed: {
    opacity: 0.8,
  },
  switchButtonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  title: {
    color: colors.foreground,
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 38,
  },
});
