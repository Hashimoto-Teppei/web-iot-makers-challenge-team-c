import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRideLoop } from "@/ride/use-ride-loop";

/**
 * 走行前後に見る画面。**走行中に見る前提の表示を足さないこと**（`CLAUDE.md`）。
 * 走行中の通知はデバイス側（ディスプレイ / LED / ブザー）で完結させる。
 *
 * ここに出すのは「仕組みが動いているか」だけである。**警告そのものは出さない**
 * ——出し先はデバイスで、画面に出すと走行中に見る理由を作ってしまう。
 */

/**
 * これだけ続けて中継に失敗したら、人に知らせる。
 *
 * **1回の失敗では出さない。**1Hz で投げているので、1通落ちるのは日常的に起きる。
 * **出さないと気づけない**——近傍が空になるのは「周りに誰もいない」と区別がつかず、
 * デバイスの `link` は `up` のままである（`docs/interfaces/mobile-api.md`）。
 */
const POST_FAILURE_ALERT = 3;

export default function HomeScreen() {
  const ride = useRideLoop();
  const status = ride.status;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>チームC</Text>
        <Text>自転車の事故と違反を未然に防ぐ。</Text>

        <Pressable
          style={styles.button}
          onPress={ride.running ? ride.stop : ride.start}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{ride.running ? "走行を終える" : "走行を始める"}</Text>
        </Pressable>

        {ride.error !== null && <Text style={styles.alert}>{ride.error}</Text>}

        {status === null ? (
          <Text style={styles.note}>走行を始めると、測位と中継の状態がここに出ます。</Text>
        ) : (
          <View style={styles.rows}>
            <Row label="デバイス" value={`${status.deviceId}（モック接続）`} />
            <Row label="測位" value={status.fix === "ok" ? "取れている" : "取れていない"} />
            <Row label="近くの自転車" value={`${status.peers} 台`} />
            <Row label="中継の連続失敗" value={`${status.postFailures} 回`} />
            {status.detectorErrors > 0 && (
              <Row label="検知の不具合" value={`${status.detectorErrors} 回`} />
            )}
          </View>
        )}

        {status !== null && status.postFailures >= POST_FAILURE_ALERT && (
          <Text style={styles.alert}>
            中継が続けて失敗しています。周りの自転車を使う検知は止まっています。
          </Text>
        )}

        <Text style={styles.note}>
          走行中はこの画面を見ないでください。危険はデバイス側の表示・音でお知らせします。
        </Text>
      </View>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  title: { fontSize: 24, fontWeight: "bold" },
  button: { alignItems: "center", backgroundColor: "#1f2937", borderRadius: 8, padding: 16 },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "bold" },
  rows: { gap: 4 },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  rowLabel: { fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  note: { color: "#6b7280" },
});
