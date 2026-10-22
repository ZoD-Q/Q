import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { VideoStudioProvider } from "@/prototype/video/video-state";
import { DesignProvider, useDesign } from "@/prototype/design";
import { PluginWorkbenchProvider } from "@/prototype/plugin-workbench/state";
import { QAccountProvider } from "@/prototype/account/account-state";
import { SocialProvider } from "@/prototype/social";
import { useReducedMotion } from "react-native-reanimated";

import { FinancialPreviewProvider } from "@/prototype/services/preview-state";
function RootStack() {
  const { colors, theme } = useDesign();
  const reducedMotion = useReducedMotion();
  return (
    <>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: reducedMotion ? "none" : "default",
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen
          name="index"
          options={{ title: "小Q · Q makes kai smile" }}
        />
      </Stack>
    </>
  );
}
export default function Layout() {
  return (
    <SafeAreaProvider>
      <DesignProvider>
        <QAccountProvider>
          <SocialProvider>
            <VideoStudioProvider>
              <PluginWorkbenchProvider>
                <FinancialPreviewProvider><RootStack /></FinancialPreviewProvider>
              </PluginWorkbenchProvider>
            </VideoStudioProvider>
          </SocialProvider>
        </QAccountProvider>
      </DesignProvider>
    </SafeAreaProvider>
  );
}
