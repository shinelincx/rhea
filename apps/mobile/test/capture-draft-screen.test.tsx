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

    await act(async () => {
      fireEvent.press(await first.findByRole('button', { name: '导入图片或 PDF' }));
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
    await act(async () => {
      fireEvent.press(await view.findByRole('button', { name: '继续拍照' }));
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
          sourceCandidateId: 'candidate-1',
          sourceHash: 'source-hash',
        },
        status: 'completed',
      })),
      getJob: jest.fn(async () => awaiting),
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
    await act(async () => {
      fireEvent.press(await view.findByRole('button', { name: '继续拍照' }));
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
    expect(gateway.organize).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: expect.objectContaining({ primarySubject: null }),
        familySpaceId: 'family-a',
        learningProfileId: 'profile-a',
        processingJobId: 'job-1',
      }),
    );
    expect(await view.findByText('待归类')).toBeVisible();
  });
});
