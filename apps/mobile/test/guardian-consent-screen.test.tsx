import { fireEvent, render, waitFor } from '@testing-library/react-native';

import type { FamilyEntryGateway, MobileConsent } from '../src/family-entry/gateway';
import { GuardianConsentScreen } from '../src/guardian-consent/GuardianConsentScreen';

const initialConsents: MobileConsent[] = [
  {
    dataScope: ['学习照片与最小裁剪'],
    familySpaceId: 'family-1',
    kind: 'photo_processing',
    purpose: '识别学习资料与作答',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['已确认学习内容'],
    familySpaceId: 'family-1',
    kind: 'ai_processing',
    purpose: '生成适龄学习内容',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['年级与本场进度'],
    familySpaceId: 'family-1',
    kind: 'peer_challenge',
    purpose: '参与同伴挑战',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['设备推送标识'],
    familySpaceId: 'family-1',
    kind: 'notifications',
    purpose: '发送通用提醒',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
];

describe('guardian consent interface', () => {
  it('shows separate purposes and immediately reflects grant and withdrawal', async () => {
    const granted = {
      ...initialConsents[0]!,
      revision: 1,
      status: 'granted' as const,
      updatedAt: '2026-09-09T08:00:00.000Z',
    };
    const withdrawn = { ...granted, revision: 2, status: 'withdrawn' as const };
    const changeConsent = jest.fn().mockResolvedValueOnce(granted).mockResolvedValueOnce(withdrawn);
    const gateway: FamilyEntryGateway = {
      changeConsent,
      enterProfile: async () => {
        throw new Error('not used');
      },
      listProfiles: async () => [],
      logout: async () => undefined,
      openGuardianSettings: async () => ({
        accessToken: 'guardian-token',
        consents: initialConsents,
      }),
      setupFamily: async () => {
        throw new Error('not used');
      },
    };
    const view = await render(
      <GuardianConsentScreen familySpaceId="family-1" gateway={gateway} onClose={jest.fn()} />,
    );

    await waitFor(() => expect(view.getByText('照片与文件处理')).toBeTruthy());
    expect(view.getByText('AI 处理')).toBeTruthy();
    expect(view.getByText('同伴挑战')).toBeTruthy();
    expect(view.getByText('通知')).toBeTruthy();
    expect(view.getAllByText('尚未选择')).toHaveLength(4);

    await fireEvent.press(view.getByRole('button', { name: '照片与文件处理：重新验证并同意' }));
    await waitFor(() => expect(view.getByText('照片与文件处理已开启。')).toBeTruthy());
    expect(changeConsent).toHaveBeenLastCalledWith({
      accessToken: 'guardian-token',
      familySpaceId: 'family-1',
      granted: true,
      kind: 'photo_processing',
    });

    await fireEvent.press(view.getByRole('button', { name: '照片与文件处理：重新验证并撤回' }));
    await waitFor(() =>
      expect(view.getByText('照片与文件处理已关闭，不会再创建新的相关处理。')).toBeTruthy(),
    );
    expect(view.getByText(/撤回只会停止新的处理或会话，不代表历史资料已删除/)).toBeTruthy();
  });
});
