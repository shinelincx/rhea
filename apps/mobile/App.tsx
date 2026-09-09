import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { TodayRouteScreen } from './src/today-route/TodayRouteScreen';
import { createTodayRouteLoader } from './src/today-route/load-today-route';

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
const loadTodayRoute = createTodayRouteLoader(apiBaseUrl);

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <TodayRouteScreen loadRoute={loadTodayRoute} />
    </SafeAreaProvider>
  );
}
