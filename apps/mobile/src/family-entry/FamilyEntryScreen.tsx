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
import {
  FamilyEntryGatewayError,
  type FamilyEntryGateway,
  type MobileLearningProfile,
} from './gateway';

export type { FamilyEntryGateway } from './gateway';

export interface DeviceCredentialStore {
  clear(): Promise<void>;
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

interface FamilyEntryScreenProps {
  credentialStore: DeviceCredentialStore;
  gateway: FamilyEntryGateway;
  initialNotice?: string | null;
  onSessionReady(input: {
    accessToken: string;
    expiresAt: string;
    profile: MobileLearningProfile;
  }): void;
}

type EntryState =
  | { status: 'loading' }
  | { notice?: string; status: 'setup' }
  | {
      deviceAccessToken: string;
      notice?: string;
      profiles: MobileLearningProfile[];
      status: 'profiles';
    }
  | {
      deviceAccessToken: string;
      error: string | null;
      pin: string;
      profile: MobileLearningProfile;
      profiles: MobileLearningProfile[];
      status: 'pin';
    };

function errorMessage(error: unknown): string {
  if (!(error instanceof FamilyEntryGatewayError)) {
    return '暂时没有完成，请检查网络后重试。';
  }
  if (error.code === 'PIN_INVALID') {
    return error.remainingAttempts === undefined
      ? 'PIN 不正确，请重试。'
      : `PIN 不正确，还可尝试 ${error.remainingAttempts} 次。`;
  }
  if (error.code === 'PIN_LOCKED') {
    const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 300) / 60));
    return `尝试次数过多，请在 ${minutes} 分钟后再试。`;
  }
  return error.message;
}

export function FamilyEntryScreen({
  credentialStore,
  gateway,
  initialNotice,
  onSessionReady,
}: FamilyEntryScreenProps) {
  const [state, setState] = useState<EntryState>({ status: 'loading' });
  const [familyName, setFamilyName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [grade, setGrade] = useState('');
  const [pin, setPin] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restoreDevice = useCallback(async () => {
    const deviceAccessToken = await credentialStore.get();
    if (!deviceAccessToken) {
      setState({ status: 'setup' });
      return;
    }
    try {
      const profiles = await gateway.listProfiles(deviceAccessToken);
      setState({ deviceAccessToken, profiles, status: 'profiles' });
    } catch (error) {
      await credentialStore.clear();
      setState({ notice: errorMessage(error), status: 'setup' });
    }
  }, [credentialStore, gateway]);

  useEffect(() => {
    void restoreDevice();
  }, [restoreDevice]);

  async function completeSetup() {
    const gradeNumber = Number.parseInt(grade, 10);
    if (!familyName.trim() || !displayName.trim() || !Number.isInteger(gradeNumber) || !pin) {
      setSetupError('请完整填写家庭空间、学习档案、年级和 PIN。');
      return;
    }
    setBusy(true);
    setSetupError(null);
    try {
      const result = await gateway.setupFamily({
        displayName,
        familyName,
        grade: gradeNumber,
        pin,
      });
      await credentialStore.set(result.deviceAccessToken);
      setState({
        deviceAccessToken: result.deviceAccessToken,
        profiles: result.profiles,
        status: 'profiles',
      });
    } catch (error) {
      setSetupError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function enterProfile() {
    if (state.status !== 'pin') {
      return;
    }
    setBusy(true);
    setState({ ...state, error: null });
    try {
      const session = await gateway.enterProfile({
        deviceAccessToken: state.deviceAccessToken,
        learningProfileId: state.profile.id,
        pin: state.pin,
      });
      onSessionReady({
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        profile: state.profile,
      });
    } catch (error) {
      setState({ ...state, error: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Rhea</Text>

        {state.status === 'loading' ? (
          <View accessibilityLiveRegion="polite" style={styles.loading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.body}>正在检查这个设备…</Text>
          </View>
        ) : null}

        {state.status === 'setup' ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              建立家庭空间
            </Text>
            <Text style={styles.body}>
              由监护人完成一次设置。学习者以后只需选择自己的档案并输入 PIN。
            </Text>
            {state.notice ? <Text style={styles.notice}>{state.notice}</Text> : null}
            <LabeledInput
              label="家庭空间名称"
              onChangeText={setFamilyName}
              placeholder="例如：小禾的家庭"
              value={familyName}
            />
            <LabeledInput
              label="学习档案名称"
              onChangeText={setDisplayName}
              placeholder="仅显示给家庭成员"
              value={displayName}
            />
            <LabeledInput
              keyboardType="number-pad"
              label="年级"
              maxLength={1}
              onChangeText={setGrade}
              placeholder="1–6"
              value={grade}
            />
            <LabeledInput
              keyboardType="number-pad"
              label="设置学习者 PIN"
              maxLength={6}
              onChangeText={setPin}
              placeholder="4–6 位数字"
              secureTextEntry
              value={pin}
            />
            {setupError ? (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {setupError}
              </Text>
            ) : null}
            <PrimaryButton
              accessibilityLabel="完成设置"
              disabled={busy}
              label={busy ? '正在设置…' : '完成设置'}
              onPress={() => void completeSetup()}
            />
          </View>
        ) : null}

        {state.status === 'profiles' ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              选择你的学习档案
            </Text>
            <Text style={styles.body}>每个人的学习内容彼此分开，不会混在一起。</Text>
            {(state.notice ?? initialNotice) ? (
              <Text accessibilityLiveRegion="polite" style={styles.notice}>
                {state.notice ?? initialNotice}
              </Text>
            ) : null}
            <View style={styles.profileList}>
              {state.profiles.map((profile) => (
                <Pressable
                  accessibilityLabel={`进入${profile.displayName}的学习档案`}
                  accessibilityRole="button"
                  key={profile.id}
                  onPress={() =>
                    setState({
                      deviceAccessToken: state.deviceAccessToken,
                      error: null,
                      pin: '',
                      profile,
                      profiles: state.profiles,
                      status: 'pin',
                    })
                  }
                  style={({ pressed }) => [styles.profileButton, pressed ? styles.pressed : null]}
                >
                  <View accessibilityElementsHidden style={styles.profileMark} />
                  <View style={styles.profileCopy}>
                    <Text style={styles.profileName}>{profile.displayName}</Text>
                    <Text style={styles.profileGrade}>
                      {profile.grade ? `${profile.grade} 年级` : '年级待设置'}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {state.status === 'pin' ? (
          <View style={styles.card}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                setState({
                  deviceAccessToken: state.deviceAccessToken,
                  profiles: state.profiles,
                  status: 'profiles',
                })
              }
              style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.backButtonText}>返回选择</Text>
            </Pressable>
            <Text accessibilityRole="header" style={styles.title}>
              {state.profile.displayName}，输入 PIN
            </Text>
            <Text style={styles.body}>PIN 只用于避免共享设备上误入其他人的学习档案。</Text>
            <LabeledInput
              autoFocus
              keyboardType="number-pad"
              label="学习者 PIN"
              maxLength={6}
              onChangeText={(value) => setState({ ...state, error: null, pin: value })}
              placeholder="4–6 位数字"
              secureTextEntry
              value={state.pin}
            />
            {state.error ? (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {state.error}
              </Text>
            ) : null}
            <PrimaryButton
              accessibilityLabel="进入学习"
              disabled={busy || state.pin.length < 4}
              label={busy ? '正在进入…' : '进入学习'}
              onPress={() => void enterProfile()}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

interface LabeledInputProps {
  autoFocus?: boolean;
  keyboardType?: 'default' | 'number-pad';
  label: string;
  maxLength?: number;
  onChangeText(value: string): void;
  placeholder: string;
  secureTextEntry?: boolean;
  value: string;
}

function LabeledInput({ label, ...props }: LabeledInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        placeholderTextColor={colors.mutedForeground}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

function PrimaryButton(props: {
  accessibilityLabel: string;
  disabled: boolean;
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        props.disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={styles.primaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backButton: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: 48,
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  body: {
    color: colors.mutedForeground,
    fontSize: 16,
    lineHeight: 25,
  },
  brand: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
    width: '100%',
  },
  disabled: {
    opacity: 0.45,
  },
  errorText: {
    color: colors.error,
    fontSize: 15,
    lineHeight: 22,
  },
  field: {
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 17,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  label: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '700',
  },
  loading: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  notice: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    color: colors.foreground,
    fontSize: 15,
    lineHeight: 22,
    padding: spacing.md,
  },
  pressed: {
    opacity: 0.8,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  primaryButtonText: {
    color: colors.surface,
    fontSize: 17,
    fontWeight: '800',
  },
  profileButton: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 72,
    padding: spacing.md,
  },
  profileCopy: {
    flex: 1,
    gap: 4,
  },
  profileGrade: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  profileList: {
    gap: spacing.sm,
  },
  profileMark: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
    borderRadius: 22,
    borderWidth: 2,
    height: 44,
    width: 44,
  },
  profileName: {
    color: colors.foreground,
    fontSize: 18,
    fontWeight: '800',
  },
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
  scrollContent: {
    alignSelf: 'center',
    flexGrow: 1,
    justifyContent: 'center',
    maxWidth: 560,
    padding: spacing.lg,
    width: '100%',
  },
  title: {
    color: colors.foreground,
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 36,
  },
});
