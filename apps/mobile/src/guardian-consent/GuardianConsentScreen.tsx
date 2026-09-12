import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '../design-system/tokens';
import type {
  FamilyEntryGateway,
  MobileConsent,
  MobileConsentKind,
  MobileLearningProfile,
} from '../family-entry/gateway';
import { GuardianReportPanel } from '../reporting/GuardianReportPanel';
import type { MobileGuardianReport, ReportingGateway } from '../reporting/reporting-gateway';

const LABELS: Record<MobileConsentKind, string> = {
  ai_processing: 'AI 处理',
  notifications: '通知',
  peer_challenge: '同伴挑战',
  photo_processing: '照片与文件处理',
};

const STATUS_LABELS: Record<MobileConsent['status'], string> = {
  denied: '已拒绝',
  granted: '已同意',
  not_decided: '尚未选择',
  withdrawn: '已撤回',
};

interface GuardianConsentScreenProps {
  familySpaceId: string;
  gateway: FamilyEntryGateway;
  learningProfiles: MobileLearningProfile[];
  onClose(): void;
  reportingGateway: ReportingGateway;
}

type ScreenState =
  | { status: 'loading' }
  | { message: string; status: 'error' }
  | { accessToken: string; consents: MobileConsent[]; status: 'ready' };

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法打开监护设置，请稍后重试。';
}

export function GuardianConsentScreen({
  familySpaceId,
  gateway,
  learningProfiles,
  onClose,
  reportingGateway,
}: GuardianConsentScreenProps) {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });
  const [changing, setChanging] = useState<MobileConsentKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    learningProfiles[0]?.id ?? null,
  );
  const [reportState, setReportState] = useState<{
    loading: boolean;
    message: string | null;
    report: MobileGuardianReport | null;
  }>({ loading: false, message: null, report: null });

  useEffect(() => {
    let active = true;
    void gateway
      .openGuardianSettings(familySpaceId)
      .then((result) => {
        if (active) {
          setState({ ...result, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ message: readableError(error), status: 'error' });
        }
      });
    return () => {
      active = false;
    };
  }, [familySpaceId, gateway]);

  const guardianAccessToken = state.status === 'ready' ? state.accessToken : null;
  useEffect(() => {
    if (!guardianAccessToken || !selectedProfileId) {
      return;
    }
    let active = true;
    setReportState({ loading: true, message: null, report: null });
    void reportingGateway
      .getGuardianReport({
        accessToken: guardianAccessToken,
        familySpaceId,
        learningProfileId: selectedProfileId,
      })
      .then((report) => {
        if (active) setReportState({ loading: false, message: null, report });
      })
      .catch((error: unknown) => {
        if (active) {
          setReportState({
            loading: false,
            message: readableError(error),
            report: null,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [familySpaceId, guardianAccessToken, reportingGateway, selectedProfileId]);

  async function decide(consent: MobileConsent, granted: boolean) {
    if (state.status !== 'ready') {
      return;
    }
    setChanging(consent.kind);
    setMessage(null);
    try {
      const updated = await gateway.changeConsent({
        accessToken: state.accessToken,
        familySpaceId,
        granted,
        kind: consent.kind,
      });
      setState({
        ...state,
        consents: state.consents.map((candidate) =>
          candidate.kind === updated.kind ? updated : candidate,
        ),
      });
      setMessage(
        granted
          ? `${LABELS[consent.kind]}已开启。`
          : `${LABELS[consent.kind]}已关闭，不会再创建新的相关处理。`,
      );
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setChanging(null);
    }
  }

  async function close() {
    if (state.status === 'ready') {
      await gateway.logout(state.accessToken).catch(() => undefined);
    }
    onClose();
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void close()}
          style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.backText}>返回学习档案</Text>
        </Pressable>
        <Text style={styles.brand}>Rhea · 监护人</Text>
        <Text accessibilityRole="header" style={styles.title}>
          监护人中心
        </Text>
        <Text style={styles.body}>处理必要待办，查看有证据的学习变化，并独立管理各项授权。</Text>

        {state.status === 'loading' ? (
          <View accessibilityLiveRegion="polite" style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.body}>正在验证监护人并读取授权…</Text>
          </View>
        ) : null}

        {state.status === 'error' ? (
          <View style={styles.card}>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {state.message}
            </Text>
          </View>
        ) : null}

        {message ? (
          <Text accessibilityLiveRegion="polite" style={styles.notice}>
            {message}
          </Text>
        ) : null}

        {state.status === 'ready' ? (
          <GuardianReportPanel
            learningProfiles={learningProfiles}
            loading={reportState.loading}
            message={reportState.message}
            onSelectProfile={setSelectedProfileId}
            report={reportState.report}
            selectedProfileId={selectedProfileId}
          />
        ) : null}

        {state.status === 'ready' ? (
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              分项授权
            </Text>
            <Text style={styles.body}>
              每项用途独立选择；改变任何授权前都会重新验证监护人身份。
            </Text>
          </View>
        ) : null}

        {state.status === 'ready'
          ? state.consents.map((consent) => {
              const busy = changing === consent.kind;
              return (
                <View key={consent.kind} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{LABELS[consent.kind]}</Text>
                    <Text style={consent.status === 'granted' ? styles.enabled : styles.status}>
                      {STATUS_LABELS[consent.status]}
                    </Text>
                  </View>
                  <Text style={styles.purpose}>{consent.purpose}</Text>
                  <Text style={styles.scopeLabel}>使用的数据</Text>
                  {consent.dataScope.map((scope) => (
                    <Text key={scope} style={styles.body}>
                      · {scope}
                    </Text>
                  ))}
                  <Text style={styles.meta}>
                    说明版本 {consent.statementVersion}
                    {consent.updatedAt ? ` · 决定记录 ${consent.updatedAt}` : ' · 尚无决定记录'}
                  </Text>
                  <View style={styles.actions}>
                    {consent.status !== 'granted' ? (
                      <DecisionButton
                        accessibilityLabel={`${LABELS[consent.kind]}：重新验证并同意`}
                        disabled={busy}
                        label={busy ? '正在验证…' : '重新验证并同意'}
                        onPress={() => void decide(consent, true)}
                        primary
                      />
                    ) : (
                      <DecisionButton
                        accessibilityLabel={`${LABELS[consent.kind]}：重新验证并撤回`}
                        disabled={busy}
                        label={busy ? '正在验证…' : '重新验证并撤回'}
                        onPress={() => void decide(consent, false)}
                      />
                    )}
                    {consent.status === 'not_decided' ? (
                      <DecisionButton
                        accessibilityLabel={`${LABELS[consent.kind]}：重新验证并拒绝`}
                        disabled={busy}
                        label="重新验证并拒绝"
                        onPress={() => void decide(consent, false)}
                      />
                    ) : null}
                  </View>
                </View>
              );
            })
          : null}

        <Text style={styles.retentionNote}>
          撤回只会停止新的处理或会话，不代表历史资料已删除。历史资料仍按保存与删除规则处理，可在数据管理中另行申请删除。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function DecisionButton(props: {
  accessibilityLabel: string;
  disabled: boolean;
  label: string;
  onPress(): void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.decisionButton,
        props.primary ? styles.primaryButton : null,
        props.disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={props.primary ? styles.primaryText : styles.secondaryText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  backButton: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 48 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  brand: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  cardHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  cardTitle: { color: colors.foreground, flex: 1, fontSize: 19, fontWeight: '800' },
  content: {
    alignSelf: 'center',
    gap: spacing.md,
    maxWidth: 640,
    padding: spacing.lg,
    width: '100%',
  },
  decisionButton: {
    alignItems: 'center',
    borderColor: colors.primary,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  disabled: { opacity: 0.45 },
  enabled: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  error: { color: colors.error, fontSize: 15, lineHeight: 23 },
  loading: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  meta: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18 },
  notice: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 15,
    lineHeight: 22,
    padding: spacing.md,
  },
  pressed: { opacity: 0.8 },
  primaryButton: { backgroundColor: colors.primary },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  purpose: { color: colors.foreground, fontSize: 16, lineHeight: 24 },
  retentionNote: {
    backgroundColor: colors.background,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 22,
    padding: spacing.md,
  },
  safeArea: { backgroundColor: colors.background, flex: 1 },
  scopeLabel: { color: colors.foreground, fontSize: 14, fontWeight: '800' },
  sectionHeading: {
    borderTopColor: colors.borderStrong,
    borderTopWidth: 1,
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingTop: spacing.lg,
  },
  sectionTitle: { color: colors.foreground, fontSize: 26, fontWeight: '800', lineHeight: 34 },
  secondaryText: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  status: { color: colors.mutedForeground, fontSize: 14, fontWeight: '700' },
  title: { color: colors.foreground, fontSize: 30, fontWeight: '800', lineHeight: 38 },
});
