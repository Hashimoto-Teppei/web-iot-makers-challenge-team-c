import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      {/* 画面のヘッダーに出るタイトル。画面を増やすときは各画面側で上書きする。 */}
      <Stack screenOptions={{ title: "チームC" }} />
      <StatusBar style="auto" />
    </>
  );
}
