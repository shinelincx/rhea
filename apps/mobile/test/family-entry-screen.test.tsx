import { fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  FamilyEntryScreen,
  type DeviceCredentialStore,
  type FamilyEntryGateway,
} from '../src/family-entry/FamilyEntryScreen';
import { FamilyEntryGatewayError } from '../src/family-entry/gateway';

function createCredentialStore(initial: string | null): DeviceCredentialStore {
  let token = initial;
  return {
    clear: async () => {
      token = null;
    },
    get: async () => token,
    set: async (next) => {
      token = next;
    },
  };
}

const profiles = [
  { displayName: '小禾', familySpaceId: 'family-1', grade: 3, id: 'profile-1' },
  { displayName: '小满', familySpaceId: 'family-1', grade: 5, id: 'profile-2' },
];

describe('shared-device family entry interface', () => {
  it('shows only device-scoped profiles and gives recoverable PIN feedback before entry', async () => {
    const gateway: FamilyEntryGateway = {
      enterProfile: jest
        .fn()
        .mockRejectedValueOnce(
          new FamilyEntryGatewayError('PIN_INVALID', 'PIN 不正确', { remainingAttempts: 4 }),
        )
        .mockResolvedValueOnce({
          accessToken: 'learner-token',
          expiresAt: '2026-09-09T08:00:00.000Z',
        }),
      listProfiles: async () => profiles,
      logout: async () => undefined,
      setupFamily: async () => {
        throw new Error('not used');
      },
    };
    const ready = jest.fn();
    const view = await render(
      <FamilyEntryScreen
        credentialStore={createCredentialStore('device-token')}
        gateway={gateway}
        onSessionReady={ready}
      />,
    );

    await waitFor(() => expect(view.getByText('选择你的学习档案')).toBeTruthy());
    expect(view.getByText('小禾')).toBeTruthy();
    expect(view.getByText('小满')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: '进入小禾的学习档案' }));
    await fireEvent.changeText(view.getByLabelText('学习者 PIN'), '0000');
    await fireEvent.press(view.getByRole('button', { name: '进入学习' }));

    await waitFor(() => expect(view.getByText('PIN 不正确，还可尝试 4 次。')).toBeTruthy());
    await fireEvent.changeText(view.getByLabelText('学习者 PIN'), '2468');
    await fireEvent.press(view.getByRole('button', { name: '进入学习' }));
    await waitFor(() =>
      expect(ready).toHaveBeenCalledWith({
        accessToken: 'learner-token',
        expiresAt: '2026-09-09T08:00:00.000Z',
        profile: profiles[0],
      }),
    );
  });

  it('lets a guardian complete trial setup and stores only the device credential', async () => {
    const credentialStore = createCredentialStore(null);
    const gateway: FamilyEntryGateway = {
      enterProfile: async () => ({
        accessToken: 'unused',
        expiresAt: '2026-09-09T08:00:00.000Z',
      }),
      listProfiles: async () => [],
      logout: async () => undefined,
      setupFamily: jest.fn().mockResolvedValue({
        deviceAccessToken: 'new-device-token',
        profiles: [profiles[0]],
      }),
    };
    const view = await render(
      <FamilyEntryScreen
        credentialStore={credentialStore}
        gateway={gateway}
        onSessionReady={jest.fn()}
      />,
    );

    await waitFor(() => expect(view.getByText('建立家庭空间')).toBeTruthy());
    await fireEvent.changeText(view.getByLabelText('家庭空间名称'), '小禾的家庭');
    await fireEvent.changeText(view.getByLabelText('学习档案名称'), '小禾');
    await fireEvent.changeText(view.getByLabelText('年级'), '3');
    await fireEvent.changeText(view.getByLabelText('设置学习者 PIN'), '2468');
    await fireEvent.press(view.getByRole('button', { name: '完成设置' }));

    await waitFor(() => expect(view.getByText('选择你的学习档案')).toBeTruthy());
    await expect(credentialStore.get()).resolves.toBe('new-device-token');
    expect(gateway.setupFamily).toHaveBeenCalledWith({
      displayName: '小禾',
      familyName: '小禾的家庭',
      grade: 3,
      pin: '2468',
    });
  });

  it('explains how to recover after a session ends', async () => {
    const gateway: FamilyEntryGateway = {
      enterProfile: async () => ({
        accessToken: 'unused',
        expiresAt: '2026-09-09T08:00:00.000Z',
      }),
      listProfiles: async () => profiles,
      logout: async () => undefined,
      setupFamily: async () => {
        throw new Error('not used');
      },
    };
    const view = await render(
      <FamilyEntryScreen
        credentialStore={createCredentialStore('device-token')}
        gateway={gateway}
        initialNotice="本次学习会话已到期，请重新输入 PIN。"
        onSessionReady={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(view.getByText('本次学习会话已到期，请重新输入 PIN。')).toBeTruthy(),
    );
  });
});
