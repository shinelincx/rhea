import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '../design-system/tokens';
import type { MobileLearningProfile } from '../family-entry/gateway';
import type {
  MobileGuardianReport,
  MobileReportDrilldown,
  MobileReportSubject,
  MobileReportTheme,
} from './reporting-gateway';

const SUBJECT_LABELS: Record<MobileReportSubject['subject'], string> = {
  chinese: '语文',
  english: '英语',
  mathematics: '数学',
  science: '科学',
};

const AUTHORITY_LABELS: Record<MobileReportDrilldown['authorityState'], string> = {
  accepted_current: '当前有效',
  disputed: '争议中',
  expired: '已过期',
  invalidated: '已失效',
  pending: '待确认',
};

interface GuardianReportPanelProps {
  learningProfiles: MobileLearningProfile[];
  loading: boolean;
  message: string | null;
  onSelectProfile(profileId: string): void;
  report: MobileGuardianReport | null;
  selectedProfileId: string | null;
}

export function GuardianReportPanel({
  learningProfiles,
  loading,
  message,
  onSelectProfile,
  report,
  selectedProfileId,
}: GuardianReportPanelProps) {
  const [showSources, setShowSources] = useState(false);
  const excluded = report?.learningReport.excluded ?? {
    disputed: 0,
    expired: 0,
    invalidated: 0,
    pending: 0,
    reasons: [],
  };
  const excludedTotal =
    excluded.pending + excluded.disputed + excluded.expired + excluded.invalidated;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          学习概览
        </Text>
        <Text style={styles.sectionHint}>只展示可核验的学习事实，不对孩子做能力或性格标签。</Text>
      </View>

      {learningProfiles.length > 1 ? (
        <View accessibilityRole="radiogroup" style={styles.profileSelector}>
          {learningProfiles.map((profile) => {
            const selected = profile.id === selectedProfileId;
            return (
              <Pressable
                accessibilityLabel={`查看${profile.displayName}的学习概览`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={profile.id}
                onPress={() => onSelectProfile(profile.id)}
                style={({ pressed }) => [
                  styles.profileButton,
                  selected ? styles.profileButtonSelected : null,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text style={selected ? styles.profileTextSelected : styles.profileText}>
                  {profile.displayName}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : learningProfiles[0] ? (
        <Text style={styles.profileName}>
          {learningProfiles[0].displayName}
          {learningProfiles[0].grade ? ` · ${learningProfiles[0].grade} 年级` : ''}
        </Text>
      ) : null}

      {loading ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          正在整理待办和最近 28 天进展…
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {message}
        </Text>
      ) : null}

      {report ? (
        <>
          <View style={styles.subsection}>
            <Text accessibilityRole="header" style={styles.subsectionTitle}>
              待确认事项 · {report.todos.counts.total}
            </Text>
            {report.todos.items.length === 0 ? (
              <Text style={styles.muted}>目前没有需要监护人处理的事项。</Text>
            ) : (
              report.todos.items.map((todo) => (
                <View key={todo.id} style={styles.todoCard}>
                  <Text style={styles.cardTitle}>{todo.title}</Text>
                  <Text style={styles.body}>{todo.detail}</Text>
                </View>
              ))
            )}
          </View>

          <View style={styles.subsection}>
            <Text accessibilityRole="header" style={styles.subsectionTitle}>
              最近 28 天学习进展
            </Text>
            <Text style={styles.muted}>
              {formatDate(report.learningReport.window.from)}—
              {formatDate(report.learningReport.window.to)}
              {' · '}按学科与错题主题汇总
            </Text>
            {report.learningReport.subjects.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.cardTitle}>还没有可计入的学习证据</Text>
                <Text style={styles.body}>
                  完成并确认练习后，这里会出现学科、错题变化与掌握趋势。
                </Text>
              </View>
            ) : (
              report.learningReport.subjects.map((subject) => (
                <SubjectReport key={subject.subject} subject={subject} />
              ))
            )}
          </View>

          <View style={styles.exclusionCard}>
            <Text style={styles.cardTitle}>{excludedTotal} 条结果未计入正式学习进展</Text>
            <Text style={styles.body}>
              待确认 {excluded.pending} · 争议中 {excluded.disputed} · 已过期 {excluded.expired} ·
              已失效 {excluded.invalidated}
            </Text>
            <Text style={styles.muted}>这些内容会保留供复核，但不会影响掌握状态或报告结论。</Text>
            {excluded.reasons.map((reason) => (
              <Text key={reason.reason} style={styles.meta}>
                {reason.reason} · {reason.count} 条
              </Text>
            ))}
          </View>

          <Pressable
            accessibilityLabel={showSources ? '收起来源与状态历史' : '查看来源与状态历史'}
            accessibilityRole="button"
            onPress={() => setShowSources((visible) => !visible)}
            style={({ pressed }) => [styles.traceButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.traceButtonText}>
              {showSources ? '收起来源与状态历史' : '查看来源与状态历史'}
            </Text>
          </Pressable>
          {showSources ? (
            <View style={styles.traceList}>
              {report.learningReport.drilldowns.length === 0 ? (
                <Text style={styles.muted}>当前报告没有可展开的正式证据来源。</Text>
              ) : (
                report.learningReport.drilldowns.map((item) => (
                  <TraceCard item={item} key={`${item.factKind}:${item.factId}`} />
                ))
              )}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function SubjectReport({ subject }: { subject: MobileReportSubject }) {
  return (
    <View style={styles.subjectCard}>
      <Text style={styles.subjectTitle}>{SUBJECT_LABELS[subject.subject]} · 最近 28 天</Text>
      <Text style={styles.evidenceSummary}>
        独立完成 {subject.evidence.independentSuccesses} 次 · 提示后完成{' '}
        {subject.evidence.assistedSuccesses} 次 · 仍需练习 {subject.evidence.incorrectAttempts} 次
      </Text>
      <Text style={styles.body}>
        错题变化：新增 {subject.wrongItems.opened} · 掌握 {subject.wrongItems.mastered} · 重开{' '}
        {subject.wrongItems.reopened}
      </Text>
      <Text style={styles.body}>
        当前主题：学习中 {subject.mastery.activeThemes} · 已掌握 {subject.mastery.masteredThemes}
      </Text>
      {subject.themes.map((theme) => (
        <ThemeReport key={theme.themeId} theme={theme} />
      ))}
    </View>
  );
}

function ThemeReport({ theme }: { theme: MobileReportTheme }) {
  const name = theme.knowledgePointName ?? theme.unitName ?? '未命名错题主题';
  return (
    <View style={styles.themeCard}>
      <View style={styles.themeHeading}>
        <Text style={styles.cardTitle}>{name}</Text>
        <Text style={theme.masteryStatus === 'mastered' ? styles.mastered : styles.learning}>
          {theme.masteryStatus === 'mastered' ? '已掌握' : '学习中'} · 第 {theme.masteryCycle} 轮
        </Text>
      </View>
      {theme.unitName && theme.knowledgePointName ? (
        <Text style={styles.meta}>{theme.unitName}</Text>
      ) : null}
      <Text style={styles.body}>
        证据 {theme.evidence.total} 条 · 独立 {theme.evidence.independentSuccesses} · 提示后{' '}
        {theme.evidence.assistedSuccesses} · 错误 {theme.evidence.incorrectAttempts}
      </Text>
      {theme.trend.length === 0 ? (
        <Text style={styles.meta}>这个时间段还没有逐日变化。</Text>
      ) : (
        theme.trend.map((point) => (
          <Text key={point.date} style={styles.trend}>
            {formatShortDate(point.date)} · 独立 {point.independentSuccesses} · 提示后{' '}
            {point.assistedSuccesses} · 错误 {point.incorrectAttempts} · 掌握主题{' '}
            {point.masteredThemes} · 重开 {point.reopenedThemes}
          </Text>
        ))
      )}
    </View>
  );
}

function TraceCard({ item }: { item: MobileReportDrilldown }) {
  return (
    <View style={styles.traceCard}>
      <Text style={styles.cardTitle}>
        来源 {item.sourceAggregateType} · {item.sourceAggregateId}
      </Text>
      <Text style={styles.meta}>
        {AUTHORITY_LABELS[item.authorityState]} · 事实 {item.factKind} · {item.factId}
      </Text>
      <Text style={styles.body}>版本 {JSON.stringify(item.sourceVersions)}</Text>
      {item.stateHistory.length === 0 ? (
        <Text style={styles.meta}>没有额外的状态变化记录。</Text>
      ) : (
        item.stateHistory.map((entry) => (
          <Text key={`${entry.at}:${entry.to}`} style={styles.meta}>
            {formatDateTime(entry.at)} · {entry.from ?? '初始'} → {entry.to} · {entry.reason}
          </Text>
        ))
      )}
    </View>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function formatShortDate(value: string): string {
  return value.slice(5, 10);
}

function formatDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

const styles = StyleSheet.create({
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  cardTitle: { color: colors.foreground, flex: 1, fontSize: 16, fontWeight: '800' },
  emptyCard: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  error: { color: colors.error, fontSize: 15, lineHeight: 23 },
  evidenceSummary: { color: colors.foreground, fontSize: 15, fontWeight: '700', lineHeight: 23 },
  exclusionCard: {
    backgroundColor: colors.background,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  learning: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  mastered: { color: colors.foreground, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18 },
  muted: { color: colors.mutedForeground, fontSize: 14, lineHeight: 22 },
  pressed: { opacity: 0.8 },
  profileButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  profileButtonSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  profileName: { color: colors.foreground, fontSize: 17, fontWeight: '800' },
  profileSelector: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  profileText: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  profileTextSelected: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  section: { gap: spacing.md },
  sectionHeading: { gap: spacing.xs },
  sectionHint: { color: colors.mutedForeground, fontSize: 14, lineHeight: 22 },
  sectionTitle: { color: colors.foreground, fontSize: 26, fontWeight: '800', lineHeight: 34 },
  subsection: { gap: spacing.sm },
  subsectionTitle: { color: colors.foreground, fontSize: 20, fontWeight: '800' },
  subjectCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  subjectTitle: { color: colors.foreground, fontSize: 19, fontWeight: '800' },
  themeCard: {
    backgroundColor: colors.background,
    borderRadius: radii.md,
    gap: spacing.xs,
    marginTop: spacing.xs,
    padding: spacing.md,
  },
  themeHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  todoCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  traceButton: {
    alignItems: 'center',
    borderColor: colors.primary,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  traceButtonText: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  traceCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  traceList: { gap: spacing.sm },
  trend: { color: colors.mutedForeground, fontSize: 13, lineHeight: 20 },
});
