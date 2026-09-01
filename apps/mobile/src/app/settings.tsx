import { Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSignStore, useSignsMeta } from "@/signs/expo";

/**
 * 設定と、手元の標識の素性を見る画面。
 *
 * **走行前後に見る画面である**（`CLAUDE.md`）。ここに走行中の情報を足さないこと。
 *
 * **標識の件数と版をここに出す。**標識を持っていない端末では一時停止の事前通知だけが
 * 黙るが、**`link` は `up`、`beat` も出ているのでデバイスの表示では絶対に気づけない**
 * （`docs/interfaces/mobile-api.md`「『持っていない』と『0件』を混ぜない」）。
 * **静かに効かなくなるものは、走る前に人が見られる場所に出す。**
 */

/**
 * 都道府県コードと名前。**いまは岡山県だけ。**
 *
 * 選べるようにするのは #71。**器だけを先に用意してある**——
 * 「選べるのに反映されない」状態を作らないため（`docs/interfaces/mobile-api.md`）。
 */
const PREF_NAMES: Record<number, string> = { 33: "岡山県" };

/**
 * 県コードを人に見せる形にする。
 *
 * **知らないコードを岡山県と言わない。**この画面は「いま何を持っているか」を
 * 見るためのものなので、**名前を知らないなら番号のまま出す**——
 * 別の県の同梱物を持っている端末に「岡山県」と表示するのが一番まずい。
 */
function prefLabel(pref: number | null): string {
  if (pref === null) return "不明";
  return PREF_NAMES[pref] ?? `都道府県コード ${pref}`;
}

export default function SettingsScreen() {
  const signs = useSignStore();
  const meta = useSignsMeta(signs);

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: "設定" }} />
      <View style={styles.content}>
        <Text style={styles.title}>設定</Text>

        <View style={styles.rows}>
          {/* 値は固定。選び直せるようにするのは #71。 */}
          <Row label="対象の都道府県" value={prefLabel(meta?.pref ?? null)} />
        </View>

        <Text style={styles.title}>一時停止の標識</Text>
        {meta === null ? (
          // **「持っていない」と「0 件」を混ぜない。**どちらも危ないが、直し方が違う。
          <Text style={styles.alert}>
            標識を持っていません。一時停止の事前通知は動きません（docs/setup.md の手順で
            同梱物を作り直してください）。
          </Text>
        ) : (
          <View style={styles.rows}>
            <Row label="件数" value={`${meta.count} 件`} />
            <Row label="版" value={meta.version} />
            <Row label="作成" value={meta.builtAt} />
          </View>
        )}
        {meta !== null && meta.count === 0 && (
          <Text style={styles.alert}>標識が 0 件です。この状態では走行を始められません。</Text>
        )}

        <Text style={styles.note}>
          標識は月に1回ほどしか変わりません。走行中には取りに行きません。
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
  content: { flex: 1, gap: 12, padding: 24 },
  title: { fontSize: 20, fontWeight: "bold" },
  rows: { gap: 4 },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  rowLabel: { fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  note: { color: "#6b7280" },
});
