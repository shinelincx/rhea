import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type { LoadTodayRoute, TodayRoute } from './types';

interface TodayRouteScreenProps {
  loadRoute: LoadTodayRoute;
}

type ScreenState =
  { status: 'loading' } | { status: 'loaded'; route: TodayRoute } | { status: 'error' };

export function TodayRouteScreen({ loadRoute }: TodayRouteScreenProps) {
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.brand}>
            Rhea
          </Text>
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
            </View>
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
  header: {
    gap: spacing.xs,
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
  title: {
    color: colors.foreground,
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 38,
  },
});
