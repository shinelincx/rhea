import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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

const warningLabels: Record<DraftQualityWarning, string> = {
  blurry: '画面可能模糊，请靠近或重拍',
  glare: '页面有明显反光，请换个角度',
  missing_edge: '纸张边缘可能不完整，请拍全四边',
  too_dark: '画面太暗，请到明亮处重拍',
};

interface CaptureDraftScreenProps {
  captureSource: CaptureSource;
  learningProfileId: string;
  onBack: () => void;
  repository: CaptureDraftRepository;
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
  captureSource,
  learningProfileId,
  onBack,
  repository,
}: CaptureDraftScreenProps) {
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<ScreenStatus>('loading');
  const [working, setWorking] = useState(false);
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

  function validate() {
    if (!draft) {
      return;
    }
    const result = validateDraft(draft);
    setError(result.valid ? null : result.errors.join('\n'));
    setNotice(result.valid ? '草稿检查通过，下一步将安全上传并批改。' : null);
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
                disabled={working}
                label="继续拍照"
                onPress={() => void acquire('camera')}
                primary
              />
              <ActionButton
                disabled={working}
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
                    label={`旋转第 ${index + 1} 页`}
                    onPress={() =>
                      updateDraft((current) => rotateDraftPage(current, page.id, now()))
                    }
                  />
                  <ActionButton
                    label={`裁边第 ${index + 1} 页`}
                    onPress={() => updateDraft((current) => cropDraftPage(current, page.id, now()))}
                  />
                  <ActionButton
                    disabled={working || page.mimeType === 'application/pdf'}
                    label={`重拍第 ${index + 1} 页`}
                    onPress={() => void retake(page.id)}
                  />
                  <ActionButton
                    disabled={index === 0}
                    label={`第 ${index + 1} 页上移`}
                    onPress={() =>
                      updateDraft((current) => moveDraftPage(current, page.id, -1, now()))
                    }
                  />
                  <ActionButton
                    disabled={index === draft.pages.length - 1}
                    label={`第 ${index + 1} 页下移`}
                    onPress={() =>
                      updateDraft((current) => moveDraftPage(current, page.id, 1, now()))
                    }
                  />
                  <ActionButton label={`删除第 ${index + 1} 页`} onPress={() => remove(page.id)} />
                </View>
              </View>
            ))}

            <ActionButton disabled={working} label="检查并继续上传" onPress={validate} primary />
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
  content: { gap: spacing.md, paddingBottom: spacing.xxl },
  editedLabel: { color: colors.primary, fontSize: 14, fontWeight: '700' },
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
  loading: { alignItems: 'center', flex: 1, gap: spacing.md, justifyContent: 'center' },
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
  title: { color: colors.foreground, fontSize: 25, fontWeight: '800' },
  warningText: { color: '#B54708', fontSize: 14, fontWeight: '600', lineHeight: 21 },
});
