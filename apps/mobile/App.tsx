import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Platform } from 'react-native';

import { CaptureDraftScreen } from './src/capture-draft/CaptureDraftScreen';
import { expoCaptureSource } from './src/capture-draft/capture-source';
import {
  ExpoAesDraftCryptoPort,
  ExpoDraftFilePort,
  InMemoryAesDraftCryptoPort,
} from './src/capture-draft/expo-repository';
import {
  EncryptedCaptureDraftRepository,
  MemoryDraftFilePort,
} from './src/capture-draft/repository';
import { createSubmissionGateway } from './src/capture-draft/submission-gateway';
import { deviceCredentialStore } from './src/family-entry/device-credential-store';
import { FamilyEntryScreen } from './src/family-entry/FamilyEntryScreen';
import { createFamilyEntryGateway, type MobileLearningProfile } from './src/family-entry/gateway';
import { createGeneratedLearningGateway } from './src/generated-learning/generated-learning-gateway';
import { GuardianConsentScreen } from './src/guardian-consent/GuardianConsentScreen';
import { createReportingGateway } from './src/reporting/reporting-gateway';
import { createReviewCardGateway } from './src/review-cards/review-card-gateway';
import { ShortReviewScreen } from './src/review-cards/ShortReviewScreen';
import { TodayRouteScreen } from './src/today-route/TodayRouteScreen';
import { createTodayRouteLoader } from './src/today-route/load-today-route';
import { ChallengeScreen } from './src/challenge/ChallengeScreen';
import { createChallengeGateway } from './src/challenge/challenge-gateway';

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
const loadTodayRoute = createTodayRouteLoader(apiBaseUrl);
const familyEntryGateway = createFamilyEntryGateway(
  apiBaseUrl,
  process.env.EXPO_PUBLIC_DEVELOPMENT_IDENTITY_ASSERTION ??
    (__DEV__ ? 'development:guardian-demo' : ''),
);
const submissionGateway = createSubmissionGateway(apiBaseUrl);
const generatedLearningGateway = createGeneratedLearningGateway(apiBaseUrl);
const reviewCardGateway = createReviewCardGateway(apiBaseUrl);
const reportingGateway = createReportingGateway(apiBaseUrl);
const challengeGateway = createChallengeGateway(apiBaseUrl);
const captureDraftRepository = new EncryptedCaptureDraftRepository(
  Platform.OS === 'web' ? new InMemoryAesDraftCryptoPort() : new ExpoAesDraftCryptoPort(),
  Platform.OS === 'web' ? new MemoryDraftFilePort() : new ExpoDraftFilePort(),
);

interface LearnerSession {
  accessToken: string;
  expiresAt: string;
  profile: MobileLearningProfile;
}

interface GuardianContext {
  familySpaceId: string;
  learningProfiles: MobileLearningProfile[];
}

export default function App() {
  const [learnerSession, setLearnerSession] = useState<LearnerSession | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [guardianContext, setGuardianContext] = useState<GuardianContext | null>(null);
  const [learnerRoute, setLearnerRoute] = useState<'today' | 'capture' | 'review' | 'challenge'>(
    'today',
  );

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
      setLearnerRoute('today');
      setSessionNotice('已安全退出，可以选择其他学习档案。');
    }
  }

  function startLearnerSession(session: LearnerSession) {
    setSessionNotice(null);
    setLearnerSession(session);
    setLearnerRoute('today');
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {guardianContext ? (
        <GuardianConsentScreen
          familySpaceId={guardianContext.familySpaceId}
          gateway={familyEntryGateway}
          learningProfiles={guardianContext.learningProfiles}
          onClose={() => setGuardianContext(null)}
          reportingGateway={reportingGateway}
        />
      ) : learnerSession ? (
        learnerRoute === 'challenge' ? (
          <ChallengeScreen
            accessToken={learnerSession.accessToken}
            familySpaceId={learnerSession.profile.familySpaceId}
            gateway={challengeGateway}
            learningProfileId={learnerSession.profile.id}
            onBack={() => setLearnerRoute('today')}
          />
        ) : learnerRoute === 'capture' ? (
          <CaptureDraftScreen
            accessToken={learnerSession.accessToken}
            captureSource={expoCaptureSource}
            familySpaceId={learnerSession.profile.familySpaceId}
            generatedLearningGateway={generatedLearningGateway}
            learningProfileId={learnerSession.profile.id}
            onBack={() => setLearnerRoute('today')}
            repository={captureDraftRepository}
            submissionGateway={submissionGateway}
          />
        ) : learnerRoute === 'review' ? (
          <ShortReviewScreen
            accessToken={learnerSession.accessToken}
            familySpaceId={learnerSession.profile.familySpaceId}
            gateway={reviewCardGateway}
            learningProfileId={learnerSession.profile.id}
            onBack={() => setLearnerRoute('today')}
          />
        ) : (
          <TodayRouteScreen
            learningProfileName={learnerSession.profile.displayName}
            loadRoute={() =>
              loadTodayRoute({
                accessToken: learnerSession.accessToken,
                familySpaceId: learnerSession.profile.familySpaceId,
                learningProfileId: learnerSession.profile.id,
              })
            }
            onStartCapture={() => setLearnerRoute('capture')}
            onStartChallenge={() => setLearnerRoute('challenge')}
            onStartReview={() => setLearnerRoute('review')}
            onSwitchProfile={() => void switchProfile()}
          />
        )
      ) : (
        <FamilyEntryScreen
          credentialStore={deviceCredentialStore}
          gateway={familyEntryGateway}
          initialNotice={sessionNotice}
          onOpenGuardianSettings={setGuardianContext}
          onSessionReady={startLearnerSession}
        />
      )}
    </SafeAreaProvider>
  );
}
