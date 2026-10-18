import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { VideoStudioProvider } from "@/prototype/video/video-state";
import { DesignProvider, useDesign } from "@/prototype/design";

function RootStack() {
  const { colors, theme } = useDesign();
  return (
    <>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
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
        <VideoStudioProvider>
          <RootStack />
        </VideoStudioProvider>
      </DesignProvider>
    </SafeAreaProvider>
  );
}
