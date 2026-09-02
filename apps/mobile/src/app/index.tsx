import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getRideLogStore } from "@/log/expo";
import { useRideLogSync } from "@/log/use-ride-log-sync";
import { useRideLoop } from "@/ride/use-ride-loop";
import { useSignStore, useSignsMeta, useSignsUpdate } from "@/signs/expo";

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
  const signs = useSignStore();
  // **走行ログの置き場所は `signs.db` と別のファイル**（`docs/adr/0009-on-device-storage.md`）。
  const { store: logs, error: logsError } = getRideLogStore();
  const ride = useRideLoop(signs, logs);
  const sync = useRideLogSync(logs);
  const status = ride.status;
  // **起動時に1回だけ標識の更新を取りに行く**（`docs/interfaces/mobile-api.md`）。
  // **走行中かを渡すのはこの画面だけが知っているから**——設定画面は見るだけである。
  const signsUpdate = useSignsUpdate(signs, { riding: ride.running });
  const signsMeta = useSignsMeta(signs);
  // **標識を持っていない端末で走らせない**（`docs/adr/0009-on-device-storage.md`）。
  // 走れてしまうと、一時停止の事前通知だけが黙ったまま走ることになり、
  // **その黙り方はデバイスの表示では気づけない。**
  // 走行前に確かめるものは他にもある（測位・デバイス・サーバー）が、
  // それを1画面にまとめるのは #70。
  const hasSigns = signsMeta !== null && signsMeta.count > 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>チームC</Text>
        <Text>自転車の事故と違反を未然に防ぐ。</Text>

        <Pressable
          style={[styles.button, !hasSigns && !ride.running && styles.buttonDisabled]}
          onPress={() => {
            if (!ride.running) {
              ride.start();
              return;
            }
            // **走行を閉じてから送る。**終わっていない走行は送信の対象にならない
            // （`docs/interfaces/web-service.md`「1回の送信は分割してよい」——
            // 開始と終了は確定値で、あとから延ばせない）。
            ride.stop();
            sync.sync();
          }}
          disabled={!hasSigns && !ride.running}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{ride.running ? "走行を終える" : "走行を始める"}</Text>
        </Pressable>

        {!hasSigns && (
          // **理由を書く。**「押せません」だけだと、初めての人は何をすればよいか分からない。
          <Text style={styles.alert}>
            一時停止の標識を持っていないため、走行を始められません（docs/setup.md の手順で
            同梱物を作ってください）。
          </Text>
        )}

        {/*
          **更新できなかったことを走行の前に見せる。**失敗しても走行は普通に始められる
          （手元の標識で動く）ので、**黙ると古い標識のまま走り続けていることに誰も気づけない**
          ——`POST` の連続失敗を出しているのと同じ理由である。

          **標識を持っていないときは出さない。**すぐ上の赤い行が同じことを言っており、
          **2つ並ぶと、直し方が2通りあるように読める。**
        */}
        {hasSigns && signsUpdate.outcome?.error != null && (
          <Text style={styles.note}>{signsUpdate.outcome.error}</Text>
        )}

        {/* **開けなかったことを走行の前に見せる。**走り終えてから「送るものが無い」と
            分かるのでは遅い（`docs/interfaces/mobile-api.md`「失敗したときの約束」と同じ理由）。 */}
        {logsError !== null && <Text style={styles.alert}>{logsError}</Text>}

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

        {/*
          **溜まっているものを走行前後に見せる。**送れていないことは、
          **走ったのにデータが無いと分かるまで誰にも見えない**——`POST` の連続失敗を
          出しているのと同じ理由である（`docs/interfaces/mobile-api.md`「失敗したときの約束」）。
        */}
        {sync.summary !== null && (
          <View style={styles.rows}>
            <Row
              label="送っていない走行"
              value={
                sync.summary.pendingRides === 0
                  ? "なし"
                  : `${sync.summary.pendingRides} 件（測位 ${sync.summary.pendingPoints} 点 / 検知 ${sync.summary.pendingDetections} 件）`
              }
            />
            <Row
              label="最後に送れたとき"
              value={
                sync.summary.lastSentAt === null
                  ? "まだ送れていません"
                  : new Date(sync.summary.lastSentAt).toLocaleString("ja-JP")
              }
            />
          </View>
        )}

        {sync.error !== null && <Text style={styles.alert}>{sync.error}</Text>}

        {/*
          **消し損ねも出す。**送り終えたのに消えていない測位は、
          **上の件数（送っていない走行）には現れない**ので、
          ここで出さないと**位置情報が端末に溜まり続けていることに誰も気づけない**
          （`docs/interfaces/mobile-api.md`「送り終えたものを端末に置き続けない」）。
        */}
        {sync.purgeError !== null && <Text style={styles.alert}>{sync.purgeError}</Text>}

        {/* **走行中は押せないようにする。**数千点の送信が 1Hz の中継と同じ回線を奪う。 */}
        {!ride.running && sync.summary !== null && sync.summary.pendingRides > 0 && (
          <Pressable
            style={[styles.button, sync.syncing && styles.buttonDisabled]}
            onPress={sync.sync}
            disabled={sync.syncing}
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>
              {sync.syncing ? "送っています…" : "走行ログを送る"}
            </Text>
          </Pressable>
        )}

        <Link href="/settings" style={styles.link}>
          設定と標識の状態
        </Link>

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
  buttonDisabled: { backgroundColor: "#9ca3af" },
  link: { color: "#1d4ed8", fontWeight: "bold" },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "bold" },
  rows: { gap: 4 },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  rowLabel: { fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  note: { color: "#6b7280" },
});
