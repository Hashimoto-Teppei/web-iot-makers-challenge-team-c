import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PreRideChecklist } from "@/components/pre-ride-checklist";
import { apiBaseUrl } from "@/lib/api";
import { blocksMockDevice } from "@/lib/mock-guard";
import { getRideLogStore } from "@/log/expo";
import { useRideLogSync } from "@/log/use-ride-log-sync";
import { MOCK_DEVICE_ID } from "@/ride/device";
import { canStartRide, preRideChecks } from "@/ride/pre-ride";
import { useDeviceLink } from "@/ride/use-device-link";
import { useLocationReady } from "@/ride/use-location-ready";
import { useRideLoop } from "@/ride/use-ride-loop";
import { useServerReach } from "@/ride/use-server-reach";
import { useSignStore, useSignsMeta, useSignsUpdate } from "@/signs/expo";

/**
 * 走行前後に見る画面。**走行中に見る前提の表示を足さないこと**（`CLAUDE.md`）。
 * 走行中の通知はデバイス側（ディスプレイ / LED / ブザー）で完結させる。
 *
 * ここに出すのは「仕組みが動いているか」だけである。**警告そのものは出さない**
 * ——出し先はデバイスで、画面に出すと走行中に見る理由を作ってしまう。
 *
 * **この画面の本体は走行前の点検**（`@/ride/pre-ride`）である。この仕組みの故障は
 * どれも「静かに黙る」形を取り、**走行中はスマホを見られない**ので、
 * **走り出す前に人が1画面で見ることが実質唯一の防御**になる。
 * **判定をこの画面に書かない**——2か所で判定すると必ず食い違う。
 */
export default function HomeScreen() {
  const signs = useSignStore();
  // **走行ログの置き場所は `signs.db` と別のファイル**（`docs/adr/0009-on-device-storage.md`）。
  const { store: logs, error: logsError } = getRideLogStore();
  // **デバイスは走行ループの外で持つ。**接続は走行より寿命が長く、走り出す前に
  // つながっていることを確かめられなければ点検が成り立たない（#38 で実物になる）。
  const { device } = useDeviceLink();
  const ride = useRideLoop(signs, logs, device);
  const sync = useRideLogSync(logs);
  const status = ride.status;
  // **起動時に1回だけ標識の更新を取りに行く**（`docs/interfaces/mobile-api.md`）。
  // **走行中かを渡すのはこの画面だけが知っているから**——設定画面は見るだけである。
  const signsUpdate = useSignsUpdate(signs, { riding: ride.running });
  const signsMeta = useSignsMeta(signs);
  // **走り出す前に測位の権限を訊いておく。**走り出してから訊くと、
  // ダイアログが出る頃には人はもう漕いでいる。
  const location = useLocationReady();
  // **走り出す前にサーバーへ届くかを確かめる。**届かなければ近傍が空になり、
  // 車車間の3検知が全部黙る——それは「周りに誰もいない」と区別がつかない。
  const server = useServerReach(ride.running);
  // **走行開始を押したことを覚えておく。**押した直後に1回だけ出す案内のため。
  const [mounted, setMounted] = useState(false);

  // **中継が塞がれていることを、疎通の結果に混ぜない。**モックのデバイスのまま
  // 共有のデプロイ先に向いていると、`/api/health` には届くのに中継は1通も飛ばない
  // （`@/lib/mock-guard`）——**そのまま走り出すと、3秒後に車車間の3検知が全滅する。**
  const relayBlockedReason =
    device !== null && blocksMockDevice(device.deviceId, apiBaseUrl)
      ? "モックのデバイスのままなので、中継を止めています（実機の接続は #38。手元の apps/web に向ければ試せます）。"
      : null;

  const checks = preRideChecks({
    deviceId: device?.deviceId ?? null,
    deviceIsMock: device?.deviceId === MOCK_DEVICE_ID,
    locationReason: location.reason,
    locationChecking: location.checking,
    signsMeta,
    serverReason: server.reason,
    serverChecking: server.checking,
    relayBlockedReason,
    status,
  });
  // **1つでも緑でなければ走行を始めさせない。**押せてしまうと、
  // 黙ったまま走ることになり、その黙り方はデバイスの表示では気づけない。
  const canStart = canStartRide(checks);
  // **確かめている最中と、赤があるのとを混ぜない。**起動直後は「…」しか出ていないのに
  // 「× の項目があるため」と書くと、**無い × を探させる。**
  const hasNg = checks.some((check) => check.state === "ng");

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>チームC</Text>
        <Text>自転車の事故と違反を未然に防ぐ。</Text>

        <Text style={styles.heading}>走行前の点検</Text>
        <PreRideChecklist checks={checks} />

        <Pressable
          style={[styles.button, !canStart && !ride.running && styles.buttonDisabled]}
          onPress={() => {
            if (!ride.running) {
              ride.start();
              setMounted(true);
              return;
            }
            // **走行を閉じてから送る。**終わっていない走行は送信の対象にならない
            // （`docs/interfaces/web-service.md`「1回の送信は分割してよい」——
            // 開始と終了は確定値で、あとから延ばせない）。
            ride.stop();
            setMounted(false);
            sync.sync();
          }}
          disabled={!canStart && !ride.running}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{ride.running ? "走行を終える" : "走行を始める"}</Text>
        </Pressable>

        {/*
          **更新できなかったことを走行の前に見せる。**手元の標識で走れるので
          **点検は赤くしない**（`docs/interfaces/mobile-api.md`「取得に失敗しても
          走行を止めない」）が、**黙ると古い標識のまま走り続けていることに誰も気づけない。**
        */}
        {signsMeta !== null && signsUpdate.outcome?.error != null && (
          <Text style={styles.note}>{signsUpdate.outcome.error}</Text>
        )}

        {!canStart && !ride.running && (
          // **押せない理由は上の点検に出ている。**ここで理由を書き直さない
          // （`CLAUDE.md`「同じことを2箇所に書かない」）。
          <Text style={styles.note}>
            {hasNg
              ? "× の項目があるため、走行を始められません。"
              : "確かめている項目があるため、まだ走行を始められません。"}
          </Text>
        )}

        {/* **直した人が確かめ直せるようにする。**設定で権限を許し直しても、
            この画面は再マウントされない——**押す手が無いと、アプリを終了させるまで
            赤のままで走り出せない。** */}
        {!ride.running && location.reason !== null && !location.checking && (
          <Pressable style={styles.button} onPress={location.recheck} accessibilityRole="button">
            <Text style={styles.buttonLabel}>位置情報の権限をもう一度確かめる</Text>
          </Pressable>
        )}

        {/* 同じ理由。電波を掴み直しても画面が赤いままだと、直ったことに気づけない。 */}
        {!ride.running && server.reason !== null && !server.checking && (
          <Pressable style={styles.button} onPress={server.recheck} accessibilityRole="button">
            <Text style={styles.buttonLabel}>サーバーをもう一度確かめる</Text>
          </Pressable>
        )}

        {/*
          **走り出す前に、スマホの置き方を1回伝える。**走行中にスマホを見る行為は
          取り締まりの対象であり、**ポケットや鞄では測位の精度が落ちて検知の前提が崩れる**
          （`CLAUDE.md` / `docs/hardware.md`）。
        */}
        {mounted && ride.running && (
          <Text style={styles.notice}>
            画面を消して、ハンドルに固定してください。危険はデバイスの表示・音でお知らせします。
          </Text>
        )}

        {/* **開けなかったことを走行の前に見せる。**走り終えてから「送るものが無い」と
            分かるのでは遅い（`docs/interfaces/mobile-api.md`「失敗したときの約束」と同じ理由）。 */}
        {logsError !== null && <Text style={styles.alert}>{logsError}</Text>}

        {ride.error !== null && <Text style={styles.alert}>{ride.error}</Text>}

        {/* **点検の4項目に入らないものだけを出す。**入るものをここにも出すと、
            同じ状態が2か所に出て、片方が古くなる。 */}
        {status !== null && (
          <View style={styles.rows}>
            <Row label="近くの自転車" value={`${status.peers} 台`} />
            {status.detectorErrors > 0 && (
              <Row label="検知の不具合" value={`${status.detectorErrors} 回`} />
            )}
          </View>
        )}

        {/*
          **溜まっているものを走行前後に見せる。**送れていないことは、
          **走ったのにデータが無いと分かるまで誰にも見えない**——中継の連続失敗を
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
      </ScrollView>
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
  content: { flexGrow: 1, gap: 12, justifyContent: "center", padding: 24 },
  title: { fontSize: 24, fontWeight: "bold" },
  heading: { fontSize: 18, fontWeight: "bold", marginTop: 8 },
  button: { alignItems: "center", backgroundColor: "#1f2937", borderRadius: 8, padding: 16 },
  buttonDisabled: { backgroundColor: "#9ca3af" },
  link: { color: "#1d4ed8", fontWeight: "bold" },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "bold" },
  rows: { gap: 4 },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  rowLabel: { fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  notice: { backgroundColor: "#fef3c7", borderRadius: 8, fontWeight: "bold", padding: 12 },
  note: { color: "#6b7280" },
});
