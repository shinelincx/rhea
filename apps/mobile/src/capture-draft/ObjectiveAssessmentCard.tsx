import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '../design-system/tokens';
import type {
  MobileLearningMaterial,
  MobileObjectiveAssessment,
  MobileProcessingJob,
  SubmissionGateway,
} from './submission-gateway';

type DisputeTarget = 'assessment' | 'question' | 'response';

const DISPUTE_TARGET_OPTIONS: ReadonlyArray<{ label: string; value: DisputeTarget }> = [
  { label: '题目识别', value: 'question' },
  { label: '我的作答', value: 'response' },
  { label: '批改结论', value: 'assessment' },
];

interface ObjectiveAssessmentCardProps {
  accessToken: string;
  completedContent: NonNullable<MobileProcessingJob['completedContent']>;
  familySpaceId: string;
  learningMaterial: MobileLearningMaterial;
  learningProfileId: string;
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
  processingJobId: string;
  submissionGateway: SubmissionGateway;
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
      accessibilityState={{ disabled }}
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

export function ObjectiveAssessmentCard({
  accessToken,
  completedContent,
  familySpaceId,
  learningMaterial,
  learningProfileId,
  onError,
  onNotice,
  processingJobId,
  submissionGateway,
}: ObjectiveAssessmentCardProps) {
  const [assessment, setAssessment] = useState<MobileObjectiveAssessment | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeTarget, setDisputeTarget] = useState<DisputeTarget>('response');
  const [showDispute, setShowDispute] = useState(false);
  const [working, setWorking] = useState(false);
  const question = completedContent.regions.find((region) => region.kind === 'question');
  const response = completedContent.regions.find((region) => region.kind === 'answer');
  const latestDispute = assessment?.disputes.at(-1);

  async function gradeObjective() {
    if (!question || !response) {
      onError('确认内容中缺少可配对的题目或作答，暂无法可靠批改。');
      return;
    }
    setWorking(true);
    onError(null);
    try {
      const result = await submissionGateway.gradeObjective({
        accessToken,
        familySpaceId,
        inputReference: {
          confirmedContentVersionId: completedContent.id,
          processingJobId,
          questionRegionId: question.id,
          responseRegionId: response.id,
        },
        learningProfileId,
        materialId: learningMaterial.id,
      });
      setAssessment(result);
      setShowDispute(false);
      onNotice(
        result.currentVersion.decision.outcome === 'ungradable'
          ? '已明确标记为暂无法可靠批改，不会猜测对错。'
          : '确定性批改已完成，结果已绑定当前学习依据。',
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : '批改暂时没有完成，请稍后重试。');
    } finally {
      setWorking(false);
    }
  }

  async function submitDispute() {
    if (!assessment || !disputeReason.trim() || !correctionText.trim()) {
      onError('请填写质疑原因和补充修正信息。');
      return;
    }
    setWorking(true);
    onError(null);
    try {
      const disputed = await submissionGateway.disputeAssessment({
        accessToken,
        assessmentId: assessment.id,
        correctionText,
        familySpaceId,
        learningProfileId,
        reason: disputeReason,
        target: disputeTarget,
      });
      setAssessment(disputed);
      setShowDispute(false);
      onNotice(
        disputed.disputes.at(-1)?.reviewRoute === 'professional'
          ? '批改质疑已提交并转入专业复核。'
          : '批改质疑已提交，结果进入待复核。',
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : '质疑没有提交成功，请稍后重试。');
    } finally {
      setWorking(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>客观题批改</Text>
      {!assessment ? (
        <>
          <Text style={styles.guideText}>
            系统只读取后端已确认的题目、作答和受控答案规则；依据不足时会标记暂无法可靠批改。
          </Text>
          <Text style={styles.detail}>题目：{question?.text ?? '未找到确认题目'}</Text>
          <Text style={styles.detail}>我的作答：{response?.text ?? '未找到确认作答'}</Text>
          <ActionButton
            disabled={working || !question || !response}
            label="按当前学习依据批改"
            onPress={() => void gradeObjective()}
            primary
          />
        </>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.outcome}>
            {assessment.openDisputeId
              ? latestDispute?.reviewRoute === 'professional'
                ? '已转专业复核'
                : '结果待复核'
              : assessment.currentVersion.decision.outcome === 'correct'
                ? '答对了'
                : assessment.currentVersion.decision.outcome === 'incorrect'
                  ? '需要订正'
                  : '暂无法可靠批改'}
          </Text>
          <Text style={styles.detail}>题目：{assessment.currentVersion.question.text}</Text>
          <Text style={styles.detail}>我的作答：{assessment.currentVersion.response.text}</Text>
          <Text style={styles.detail}>
            采用答案：{assessment.currentVersion.decision.expectedDisplay ?? '依据不足'}
          </Text>
          <Text style={styles.guideText}>批改版本：{assessment.currentVersion.revision}</Text>
          <Text style={styles.guideText}>
            当前学习依据版本：{assessment.currentVersion.basis.selectionVersion}
          </Text>
          {assessment.openDisputeId ? (
            <Text style={styles.warningText}>
              {latestDispute?.reviewRoute === 'professional'
                ? '已交由专业人员复核；相关错题、掌握度、复习和挑战计分均已暂停。'
                : '结果待监护人复核；相关错题、掌握度、复习和挑战计分均已暂停。'}
            </Text>
          ) : (
            <ActionButton
              disabled={working}
              label="我觉得批改不对"
              onPress={() => setShowDispute(true)}
            />
          )}
          {showDispute && !assessment.openDisputeId ? (
            <View style={styles.disputePanel}>
              <Text style={styles.inputLabel}>哪里需要复核？</Text>
              <View accessibilityRole="radiogroup" style={styles.targetOptions}>
                {DISPUTE_TARGET_OPTIONS.map((option) => {
                  const selected = option.value === disputeTarget;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={option.value}
                      onPress={() => setDisputeTarget(option.value)}
                      style={({ pressed }) => [
                        styles.targetOption,
                        selected ? styles.targetOptionSelected : null,
                        pressed ? styles.pressed : null,
                      ]}
                    >
                      <Text
                        style={selected ? styles.targetOptionTextSelected : styles.targetOptionText}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.guideText}>
                首次质疑通常由监护人核对；依据冲突、需专业判断或重复质疑会转入专业复核。
              </Text>
              <Text style={styles.inputLabel}>为什么觉得不对？</Text>
              <TextInput
                accessibilityLabel="质疑原因"
                onChangeText={setDisputeReason}
                placeholder="例如：作答识别错误"
                style={styles.input}
                value={disputeReason}
              />
              <Text style={styles.inputLabel}>补充修正信息</Text>
              <TextInput
                accessibilityLabel="补充修正信息"
                multiline
                onChangeText={setCorrectionText}
                placeholder="说明你看到的内容或正确写法"
                style={[styles.input, styles.multilineInput]}
                value={correctionText}
              />
              <ActionButton
                disabled={working || !disputeReason.trim() || !correctionText.trim()}
                label="提交质疑并暂停结果"
                onPress={() => void submitDispute()}
                primary
              />
            </View>
          ) : null}
        </>
      )}
    </View>
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
  card: {
    backgroundColor: '#FFFCF5',
    borderColor: '#F2C94C',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  detail: { color: colors.foreground, fontSize: 16, lineHeight: 24 },
  disputePanel: { gap: spacing.sm },
  guideText: { color: colors.mutedForeground, fontSize: 15, lineHeight: 23 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 48,
    padding: spacing.sm,
  },
  inputLabel: { color: colors.foreground, fontSize: 15, fontWeight: '700' },
  multilineInput: { minHeight: 72 },
  outcome: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  targetOption: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.xs,
  },
  targetOptionSelected: { backgroundColor: '#EAF3FF', borderColor: colors.primary },
  targetOptionText: { color: colors.mutedForeground, fontSize: 14, fontWeight: '600' },
  targetOptionTextSelected: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  targetOptions: { flexDirection: 'row', gap: spacing.sm },
  title: { color: colors.foreground, fontSize: 19, fontWeight: '700' },
  warningText: { color: '#B54708', fontSize: 14, lineHeight: 21 },
});
