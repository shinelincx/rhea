import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { CaptureSource } from '../src/capture-draft/capture-source';
import { CaptureDraftScreen } from '../src/capture-draft/CaptureDraftScreen';
import {
  EncryptedCaptureDraftRepository,
  MemoryDraftFilePort,
  type DraftCryptoPort,
} from '../src/capture-draft/repository';

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
});
