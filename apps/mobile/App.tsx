import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { deviceCredentialStore } from './src/family-entry/device-credential-store';
import { FamilyEntryScreen } from './src/family-entry/FamilyEntryScreen';
import { createFamilyEntryGateway, type MobileLearningProfile } from './src/family-entry/gateway';
import { GuardianConsentScreen } from './src/guardian-consent/GuardianConsentScreen';
import { TodayRouteScreen } from './src/today-route/TodayRouteScreen';
import { createTodayRouteLoader } from './src/today-route/load-today-route';

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
const loadTodayRoute = createTodayRouteLoader(apiBaseUrl);
const familyEntryGateway = createFamilyEntryGateway(
  apiBaseUrl,
  process.env.EXPO_PUBLIC_DEVELOPMENT_IDENTITY_ASSERTION ??
    (__DEV__ ? 'development:guardian-demo' : ''),
);

interface LearnerSession {
  accessToken: string;
  expiresAt: string;
  profile: MobileLearningProfile;
}

export default function App() {
  const [learnerSession, setLearnerSession] = useState<LearnerSession | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [guardianFamilySpaceId, setGuardianFamilySpaceId] = useState<string | null>(null);

  useEffect(() => {
    if (!learnerSession) {
      return;
    }
    const remainingMs = Date.parse(learnerSession.expiresAt) - Date.now();
    if (!Number.isFinite(remainingMs)) {
      return;
    }
    const timer = setTimeout(
      () => {
        setLearnerSession(null);
        setSessionNotice('本次学习会话已到期，请重新输入 PIN。');
      },
      Math.max(0, remainingMs),
    );
    return () => clearTimeout(timer);
  }, [learnerSession]);

  async function switchProfile() {
    if (!learnerSession) {
      return;
    }
    try {
      await familyEntryGateway.logout(learnerSession.accessToken);
    } finally {
      setLearnerSession(null);
      setSessionNotice('已安全退出，可以选择其他学习档案。');
    }
  }

  function startLearnerSession(session: LearnerSession) {
    setSessionNotice(null);
    setLearnerSession(session);
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {guardianFamilySpaceId ? (
        <GuardianConsentScreen
          familySpaceId={guardianFamilySpaceId}
          gateway={familyEntryGateway}
          onClose={() => setGuardianFamilySpaceId(null)}
        />
      ) : learnerSession ? (
        <TodayRouteScreen
          learningProfileName={learnerSession.profile.displayName}
          loadRoute={loadTodayRoute}
          onSwitchProfile={() => void switchProfile()}
        />
      ) : (
        <FamilyEntryScreen
          credentialStore={deviceCredentialStore}
          gateway={familyEntryGateway}
          initialNotice={sessionNotice}
          onOpenGuardianSettings={setGuardianFamilySpaceId}
          onSessionReady={startLearnerSession}
        />
      )}
    </SafeAreaProvider>
  );
}
