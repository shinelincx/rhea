import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { expoCaptureSource } from '../capture-draft/capture-source';
import { CaptureDraftScreen } from '../capture-draft/CaptureDraftScreen';
import { InMemoryAesDraftCryptoPort } from '../capture-draft/expo-repository';
import { EncryptedCaptureDraftRepository, MemoryDraftFilePort } from '../capture-draft/repository';
import { ChallengeScreen } from '../challenge/ChallengeScreen';
import { colors, spacing } from '../design-system/tokens';
import { GrowthScreen } from '../growth/GrowthScreen';
import { ShortReviewScreen } from '../review-cards/ShortReviewScreen';
import { TodayRouteScreen } from '../today-route/TodayRouteScreen';
import { createPrototypeDemoRuntime } from './runtime';

type DemoRoute = 'capture' | 'challenge' | 'growth' | 'review' | 'today';

export function PrototypeDemoContent() {
  const [route, setRoute] = useState<DemoRoute>('today');
  const [runtime] = useState(() => createPrototypeDemoRuntime());
  const [repository] = useState(
    () =>
      new EncryptedCaptureDraftRepository(
        new InMemoryAesDraftCryptoPort(),
        new MemoryDraftFilePort(),
      ),
  );
  const session = runtime.session;
  const back = () => setRoute('today');

  return (
    <View style={styles.app}>
      <View style={styles.demoBanner}>
        <Text style={styles.demoTitle}>原型体验版 · 数据保存在本次运行中</Text>
        <Text style={styles.demoBody}>无需后端即可体验；OCR 与 AI 结果为可交互演示数据。</Text>
      </View>
      <View style={styles.screen}>
        {route === 'capture' ? (
          <CaptureDraftScreen
            accessToken={session.accessToken}
            captureSource={expoCaptureSource}
            familySpaceId={session.familySpaceId}
            generatedLearningGateway={runtime.generatedLearningGateway}
            learningProfileId={session.profile.id}
            onBack={back}
            repository={repository}
            submissionGateway={runtime.submissionGateway}
          />
        ) : route === 'review' ? (
          <ShortReviewScreen
            accessToken={session.accessToken}
            familySpaceId={session.familySpaceId}
            gateway={runtime.reviewCardGateway}
            learningProfileId={session.profile.id}
            onBack={back}
          />
        ) : route === 'challenge' ? (
          <ChallengeScreen
            accessToken={session.accessToken}
            familySpaceId={session.familySpaceId}
            gateway={runtime.challengeGateway}
            learningProfileId={session.profile.id}
            onBack={back}
          />
        ) : route === 'growth' ? (
          <GrowthScreen
            accessToken={session.accessToken}
            familySpaceId={session.familySpaceId}
            gateway={runtime.growthGateway}
            learningProfileId={session.profile.id}
            onBack={back}
          />
        ) : (
          <TodayRouteScreen
            learningProfileName={`${session.profile.displayName} · 四年级`}
            loadRoute={runtime.loadTodayRoute}
            onOpenGrowth={() => setRoute('growth')}
            onStartCapture={() => setRoute('capture')}
            onStartChallenge={() => setRoute('challenge')}
            onStartReview={() => setRoute('review')}
          />
        )}
      </View>
    </View>
  );
}

export function PrototypeDemoApp() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <PrototypeDemoContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { backgroundColor: colors.background, flex: 1 },
  demoBanner: {
    backgroundColor: '#FFF4D8',
    borderBottomColor: '#E7CC86',
    borderBottomWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  demoBody: { color: '#694F16', fontSize: 12, marginTop: 2 },
  demoTitle: { color: '#4E3909', fontSize: 13, fontWeight: '800' },
  screen: { flex: 1 },
});
