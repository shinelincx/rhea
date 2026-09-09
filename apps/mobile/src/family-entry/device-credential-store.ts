import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { DeviceCredentialStore } from './FamilyEntryScreen';

const DEVICE_TOKEN_KEY = 'rhea.device.access-token';

function webStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export const deviceCredentialStore: DeviceCredentialStore = {
  async clear() {
    if (Platform.OS === 'web') {
      webStorage()?.removeItem(DEVICE_TOKEN_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
  },
  async get() {
    if (Platform.OS === 'web') {
      return webStorage()?.getItem(DEVICE_TOKEN_KEY) ?? null;
    }
    return SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
  },
  async set(value) {
    if (Platform.OS === 'web') {
      webStorage()?.setItem(DEVICE_TOKEN_KEY, value);
      return;
    }
    await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};
