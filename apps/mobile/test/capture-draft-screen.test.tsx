import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { CaptureSource } from '../src/capture-draft/capture-source';
import { CaptureDraftScreen } from '../src/capture-draft/CaptureDraftScreen';
import {
  EncryptedCaptureDraftRepository,
  MemoryDraftFilePort,
  type DraftCryptoPort,
} from '../src/capture-draft/repository';
import type {
  MobileLearningMaterial,
  MobileProcessingJob,
  SubmissionGateway,
} from '../src/capture-draft/submission-gateway';

const passThroughCrypto: DraftCryptoPort = {
  decrypt: async (_profileId, _context, ciphertext) => ciphertext,
  encrypt: async (_profileId, _context, plaintext) => plaintext,
};

function captureSource(): CaptureSource {
  let sequence = 0;
  const capture = async () => {
    sequence += 1;
    return [
      {
        bytes: new Uint8Array([sequence, 2, 3]),
        page: {
          crop: null,
          fileName: `数学练习-${sequence}.jpg`,
          height: 600,
          id: `page-${sequence}`,
          mimeType: 'image/jpeg',
          qualityWarnings: ['blurry' as const],
          rotation: 0 as const,
          sizeBytes: 3,
          width: 800,
        },
        previewUri: `data:image/jpeg;base64,AA${sequence}=`,
      },
    ];
  };
  return { importFiles: capture, takePhoto: capture };
}

describe('capture draft mobile flow', () => {
  it('imports, edits, validates, and restores a profile-scoped draft', async () => {
    const repository = new EncryptedCaptureDraftRepository(
      passThroughCrypto,
      new MemoryDraftFilePort(),
    );
    const source = captureSource();
    const first = await render(
      <CaptureDraftScreen
        captureSource={source}
        learningProfileId="profile-a"
        onBack={jest.fn()}
        repository={repository}
      />,
    );

    const importButton = await first.findByRole('button', { name: '导入图片或 PDF' });
    await act(async () => {
      fireEvent.press(importButton);
    });
    expect(await first.findByText('第 1 页')).toBeVisible();
    expect(first.getByText('画面可能模糊，请靠近或重拍')).toBeVisible();

    await act(async () => {
      fireEvent.press(first.getByRole('button', { name: '旋转第 1 页' }));
    });
    await act(async () => {
      fireEvent.press(first.getByRole('button', { name: '裁边第 1 页' }));
    });
    expect(await first.findByText('已裁边')).toBeVisible();

    await act(async () => {
      fireEvent.press(first.getByRole('button', { name: '检查并继续上传' }));
    });
    expect(await first.findByText('草稿检查通过，下一步将安全上传并批改。')).toBeVisible();
    await first.unmount();

    const restored = await render(
      <CaptureDraftScreen
        captureSource={source}
        learningProfileId="profile-a"
        onBack={jest.fn()}
        repository={repository}
      />,
    );
    expect(await restored.findByText('已恢复上次未提交的 1 页草稿。')).toBeVisible();
    expect(restored.getByText('已裁边')).toBeVisible();

    await waitFor(async () => {
      await expect(repository.loadLatest('profile-b')).resolves.toBeNull();
    });
  });

  it('keeps the original page when retaking is cancelled', async () => {
    const repository = new EncryptedCaptureDraftRepository(
      passThroughCrypto,
      new MemoryDraftFilePort(),
    );
    const source = captureSource();
    const view = await render(
      <CaptureDraftScreen
        captureSource={source}
        learningProfileId="profile-a"
        onBack={jest.fn()}
        repository={repository}
      />,
    );
    const continueButton = await view.findByRole('button', { name: '继续拍照' });
    await act(async () => {
      fireEvent.press(continueButton);
    });
    expect(await view.findByText('数学练习-1.jpg')).toBeVisible();
    source.takePhoto = async () => [];
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '重拍第 1 页' }));
    });
    expect(view.getByText('数学练习-1.jpg')).toBeVisible();
  });

  it('shows backend quality and confidence, accepts edits, and clears confirmed raw draft', async () => {
    const repository = new EncryptedCaptureDraftRepository(
      passThroughCrypto,
      new MemoryDraftFilePort(),
    );
    const awaiting: MobileProcessingJob = {
      candidate: {
        adapterVersion: 'fixture-v1',
        id: 'candidate-1',
        regions: [
          {
            confidence: 0.62,
            id: 'region-1',
            kind: 'answer',
            lowConfidence: true,
            pageId: 'page-1',
            readingOrder: 0,
            text: '8',
          },
        ],
        sourceHash: 'source-hash',
      },
      completedContent: null,
      errorCode: null,
      id: 'job-1',
      qualityIssues: [{ issue: 'too_dark', pageId: 'page-1' }],
      status: 'awaiting_confirmation',
      updatedAt: '2026-09-09T10:00:00.000Z',
    };
    const gateway: SubmissionGateway = {
      cancel: jest.fn(),
      confirm: jest.fn(async (): Promise<MobileProcessingJob> => ({
        ...awaiting,
        completedContent: {
          id: 'content-1',
          regions: awaiting.candidate!.regions,
          sourceCandidateId: 'candidate-1',
          sourceHash: 'source-hash',
        },
        status: 'completed',
      })),
      correctClassification: jest.fn(async (input): Promise<MobileLearningMaterial> => ({
        basis: {
          currentSourceVersionId: 'source-1',
          hasConflict: false,
          selectionRevision: 1,
        },
        currentClassification: {
          primarySubject: input.classification.primarySubject,
          revision: 2,
          status: 'classified',
        },
        id: 'material-1',
        sourceVersions: [{ id: 'source-1', versionLabel: 'confirmed-content-v1' }],
      })),
      disputeAssessment: jest.fn(),
      getJob: jest.fn(async () => awaiting),
      gradeObjective: jest.fn(),
      organize: jest.fn(async (): Promise<MobileLearningMaterial> => ({
        basis: {
          currentSourceVersionId: 'source-1',
          hasConflict: false,
          selectionRevision: 1,
        },
        currentClassification: { primarySubject: null, revision: 1, status: 'pending' },
        id: 'material-1',
        sourceVersions: [{ id: 'source-1', versionLabel: 'confirmed-content-v1' }],
      })),
      submit: jest.fn(async () => awaiting),
    };
    const view = await render(
      <CaptureDraftScreen
        accessToken="learner-token"
        captureSource={captureSource()}
        familySpaceId="family-a"
        learningProfileId="profile-a"
        onBack={jest.fn()}
        repository={repository}
        submissionGateway={gateway}
      />,
    );
    const continueButton = await view.findByRole('button', { name: '继续拍照' });
    await act(async () => {
      fireEvent.press(continueButton);
    });
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '检查并继续上传' }));
    });

    expect(await view.findByText('画面太暗，请到明亮处重拍')).toBeVisible();
    expect(view.getByText('作答 · 需要核对 62%')).toBeVisible();
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('编辑作答内容'), '9');
    });
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '确认识别内容' }));
    });

    expect(gateway.confirm).toHaveBeenCalledWith('learner-token', 'job-1', { 'region-1': '9' });
    expect(await view.findByText('识别内容已确认，原始整页文件已进入删除流程。')).toBeVisible();
    await expect(repository.loadLatest('profile-a')).resolves.toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '先放入待归类' }));
    });
    await waitFor(() =>
      expect(gateway.organize).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: expect.objectContaining({ primarySubject: null }),
          familySpaceId: 'family-a',
          learningProfileId: 'profile-a',
          processingJobId: 'job-1',
        }),
      ),
    );
    expect(await view.findByText('待归类')).toBeVisible();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '修改归类' }));
    });
    const mathematicsButton = await view.findByRole('button', { name: '数学' });
    await act(async () => {
      fireEvent.press(mathematicsButton);
      fireEvent.changeText(view.getByLabelText('知识点'), '两位数乘法');
    });
    await waitFor(() => expect(view.getByRole('button', { name: '保存学习归类' })).toBeEnabled());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '保存学习归类' }));
    });
    await waitFor(() =>
      expect(gateway.correctClassification).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: expect.objectContaining({
            primaryKnowledgePointName: '两位数乘法',
            primarySubject: 'mathematics',
          }),
          materialId: 'material-1',
          reason: '学习者修正学习归类',
        }),
      ),
    );
    expect(await view.findByText('已整理到数学，当前学习依据版本已记录。')).toBeVisible();
  });

  it('shows a traceable objective result and lets the learner pause it with a dispute', async () => {
    const repository = new EncryptedCaptureDraftRepository(
      passThroughCrypto,
      new MemoryDraftFilePort(),
    );
    const regions = [
      {
        confidence: 0.97,
        id: 'question-1',
        kind: 'question' as const,
        lowConfidence: false,
        pageId: 'page-1',
        readingOrder: 0,
        text: '计算：36 ÷ 4 =',
      },
      {
        confidence: 0.95,
        id: 'answer-1',
        kind: 'answer' as const,
        lowConfidence: false,
        pageId: 'page-1',
        readingOrder: 1,
        text: '8',
      },
    ];
    const awaiting: MobileProcessingJob = {
      candidate: {
        adapterVersion: 'fixture-v1',
        id: 'candidate-1',
        regions,
        sourceHash: 'a'.repeat(64),
      },
      completedContent: null,
      errorCode: null,
      id: 'job-1',
      qualityIssues: [],
      status: 'awaiting_confirmation',
      updatedAt: '2026-09-09T10:00:00.000Z',
    };
    const graded = {
      currentVersion: {
        basis: {
          selectionVersion: 1,
          sourceVersionId: 'source-1',
          versionLabel: '确认内容第 1 版',
        },
        decision: {
          expectedDisplay: '9',
          normalizedResponse: '8',
          outcome: 'incorrect' as const,
          reasonCode: null,
        },
        id: 'assessment-version-1',
        question: {
          subject: 'mathematics' as const,
          text: regions[0]!.text,
          versionId: 'question-1',
        },
        response: { text: regions[1]!.text, versionId: 'answer-1' },
        revision: 1,
      },
      disputes: [],
      id: 'assessment-1',
      openDisputeId: null,
      resolutions: [],
      versions: [],
    };
    const gateway = {
      cancel: jest.fn(),
      confirm: jest.fn(async () => ({
        ...awaiting,
        completedContent: {
          id: 'content-1',
          regions,
          sourceCandidateId: 'candidate-1',
          sourceHash: 'a'.repeat(64),
        },
        status: 'completed' as const,
      })),
      correctClassification: jest.fn(),
      disputeAssessment: jest.fn(async () => ({
        ...graded,
        disputes: [{ id: 'dispute-1', reviewRoute: 'guardian' as const }],
        openDisputeId: 'dispute-1',
      })),
      getJob: jest.fn(async () => awaiting),
      gradeObjective: jest.fn(async () => graded),
      organize: jest.fn(async () => ({
        basis: { currentSourceVersionId: 'source-1', hasConflict: false, selectionRevision: 1 },
        currentClassification: {
          primarySubject: 'mathematics' as const,
          revision: 1,
          status: 'classified' as const,
        },
        id: 'material-1',
        sourceVersions: [{ id: 'source-1', versionLabel: '确认内容第 1 版' }],
      })),
      submit: jest.fn(async () => awaiting),
    };
    const view = await render(
      <CaptureDraftScreen
        accessToken="learner-token"
        captureSource={captureSource()}
        familySpaceId="family-a"
        learningProfileId="profile-a"
        onBack={jest.fn()}
        repository={repository}
        submissionGateway={gateway}
      />,
    );
    const continueButton = await view.findByRole('button', { name: '继续拍照' });
    await act(async () => {
      fireEvent.press(continueButton);
    });
    const uploadButton = await view.findByRole('button', { name: '检查并继续上传' });
    await act(async () => {
      fireEvent.press(uploadButton);
    });
    const confirmButton = await view.findByRole('button', { name: '确认识别内容' });
    await act(async () => {
      fireEvent.press(confirmButton);
    });
    const mathematicsButton = await view.findByRole('button', { name: '数学' });
    await act(async () => {
      fireEvent.press(mathematicsButton);
      fireEvent.changeText(view.getByLabelText('知识点'), '除法');
    });
    await waitFor(() => expect(view.getByRole('button', { name: '保存学习归类' })).toBeEnabled());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '保存学习归类' }));
    });

    await waitFor(() =>
      expect(view.getByRole('button', { name: '按当前学习依据批改' })).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '按当前学习依据批改' }));
    });
    expect(gateway.gradeObjective).toHaveBeenCalledWith(
      expect.objectContaining({
        inputReference: {
          confirmedContentVersionId: 'content-1',
          processingJobId: 'job-1',
          questionRegionId: 'question-1',
          responseRegionId: 'answer-1',
        },
      }),
    );
    expect(await view.findByText('需要订正')).toBeVisible();
    expect(view.getByText('我的作答：8')).toBeVisible();
    expect(view.getByText('采用答案：9')).toBeVisible();
    expect(view.getByText('当前学习依据版本：1')).toBeVisible();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '我觉得批改不对' }));
    });
    expect(view.getByRole('radio', { name: '题目识别' })).toBeVisible();
    expect(view.getByRole('radio', { name: '我的作答' }).props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(view.getByRole('radio', { name: '批改结论' })).toBeVisible();
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('质疑原因'), '作答识别错误');
      fireEvent.changeText(view.getByLabelText('补充修正信息'), '我写的是 9，请核对原稿。');
    });
    await waitFor(() =>
      expect(view.getByRole('button', { name: '提交质疑并暂停结果' })).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '提交质疑并暂停结果' }));
    });
    expect(gateway.disputeAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'response' }),
    );
    expect(await view.findByText('结果待复核')).toBeVisible();
    expect(
      view.getByText('结果待监护人复核；相关错题、掌握度、复习和挑战计分均已暂停。'),
    ).toBeVisible();
  });
});
