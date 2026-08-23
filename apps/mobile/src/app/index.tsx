import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/lib/api";

export default function HomeScreen() {
  const [status, setStatus] = useState("確認中…");

  useEffect(() => {
    // API との疎通確認。ここが動けば hc<AppType>() の配線ができている。
    api.api.health
      .$get()
      .then((res) => {
        // ステータスを見ないと、エラーの JSON をそのまま正常な応答として表示してしまう。
        if (!res.ok) throw new Error(`API が ${res.status} を返しました`);
        return res.json();
      })
      .then((body) => setStatus(`${body.status} / ${body.timestamp}`))
      .catch((error: unknown) => setStatus(`エラー: ${String(error)}`));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>チームC</Text>
        <Text>自転車の事故と違反を未然に防ぐ。</Text>
        <Text style={styles.label}>API の疎通確認</Text>
        <Text>{status}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  title: { fontSize: 24, fontWeight: "bold" },
  label: { marginTop: 16, fontWeight: "bold" },
});
