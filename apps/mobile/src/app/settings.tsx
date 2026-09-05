import { Link, Stack } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  DEVICE_CONFIG_DEFAULTS,
  DEVICE_CONFIG_KEYS,
  DEVICE_CONFIG_RANGES,
  type DeviceConfigKey,
  deviceConfigOverrides,
} from "@/ble/device-config";
import {
  type DeviceConfigOutcome,
  resetDeviceConfig,
  setDeviceConfig,
  useDeviceConfig,
  useDeviceConfigOutcome,
} from "@/ble/device-config-store";
import { useRiding } from "@/ride/riding";
import {
  type SignsUpdateState,
  useSignStore,
  useSignsMeta,
  useSignsUpdateState,
} from "@/signs/expo";
import { prefLabel } from "@/signs/pref";

/**
 * 設定と、手元の標識の素性を見る画面。
 *
 * **走行前後に見る画面である**（`CLAUDE.md`）。ここに走行中の情報を足さないこと。
 *
 * **標識の件数と版をここに出す。**標識を持っていない端末では一時停止の事前通知だけが
 * 黙るが、**`link` は `up`、`beat` も出ているのでデバイスの表示では絶対に気づけない**
 * （`docs/interfaces/stop-signs-delivery.md`「『持っていない』と『0件』を混ぜない」）。
 * **静かに効かなくなるものは、走る前に人が見られる場所に出す。**
 *
 * **デバイスのしきい値もここで変える**（#124）。**走行中に触らせない**——変えられるのは
 * 走行前に限る（`CLAUDE.md`）。**上書きはこの接続の間だけ効き、端末にも保存しない**
 * （`@/ble/device-config-store`）ので、**走るたびに入れ直す。**
 */

/**
 * 標識の更新がどうなったかを1行にする。
 *
 * **「変わっていなかった」と「取りに行けなかった」を同じ文にしない。**
 * 前者は正常な終わり方で、後者は**古い標識のまま走ることになる**
 * （`docs/interfaces/stop-signs-delivery.md`「『持っていない』と『0件』を混ぜない」と同じ理由）。
 *
 * **「起動時に」と書かない。**同じ場所に**人が県を選び直した結果も出る**ようになった
 * （#71）ので、**書くと、たったいま自分でやったことを起動のせいにして見せる。**
 */
function updateLabel(update: SignsUpdateState): string {
  if (update.running) return "サーバーの版を確かめています…";
  if (update.outcome === null) return "まだ確かめていません。";

  switch (update.outcome.status) {
    case "replaced":
      return "新しい標識へ入れ替えました。";
    case "not-modified":
      return "確かめました。サーバーの版と同じです。";
    // **理由をそのまま出す。**「失敗しました」だけだと、何をすればよいか分からない。
    case "failed":
    case "skipped":
      return update.outcome.error ?? "標識を取りに行っていません。";
  }
}

/**
 * しきい値の上書きがどうなったかを1行にする。
 *
 * **「書いていない」と「書けなかった」を同じ文にしない。**前者は既定どおりという正常な
 * 状態で、後者は**画面の値と違う値で走る**（`@/ble/device-config-store`）。
 */
function configLabel(outcome: DeviceConfigOutcome, changed: boolean): string {
  switch (outcome.state) {
    case "default":
      // **「既定のまま」と「まだ書けていない」を混ぜない。**画面の値を変えたのに
      // 既定と言われると、**変えた値で走っているつもり**になる——書くのは接続したときで、
      // つながっていなければ**まだどこにも効いていない。**
      return changed
        ? "デバイスにつながっていないので、まだ書いていません。つなぐと書きます。"
        : "既定のままです（デバイスには書いていません）。";
    case "writing":
      return "デバイスに書いています…";
    case "applied":
      return "デバイスに入りました。この接続の間だけ効きます。";
    case "failed":
      // **理由をそのまま出す。**どのキーが効いていないかまで書いてある。
      return outcome.reason ?? "デバイスに書けませんでした。既定のまま走ります。";
  }
}

export default function SettingsScreen() {
  const signs = useSignStore();
  const meta = useSignsMeta(signs);
  // **見るだけ。**取りに行くのはホーム画面（起動時に1回）である——
  // ここで取りに行くと、**走行中に設定を開いただけで数 MB の取得が始まりうる。**
  const update = useSignsUpdateState();
  const deviceConfig = useDeviceConfig();
  const configOutcome = useDeviceConfigOutcome();
  // **走行中は触らせない。**走行はこの画面より寿命が長く、**走りながら保持時間を
  // 変えると、いま出ている警告の消え方が途中で変わる。**
  const riding = useRiding();

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: "設定" }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>設定</Text>

        <View style={styles.rows}>
          <Row label="対象の都道府県" value={prefLabel(meta?.pref ?? null)} />
        </View>
        {/* **選択肢はこの画面に持たない。**取り込んである県はサーバーが決めるので、
            向こうで取りに行く（`docs/interfaces/stop-signs-delivery.md`）。 */}
        <Link href="/prefs" style={styles.link}>
          都道府県を選び直す
        </Link>

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

        <Text style={styles.rowLabel}>更新</Text>
        <Text style={styles.note}>{updateLabel(update)}</Text>

        <Text style={styles.note}>
          標識は月に1回ほどしか変わりません。走行中には取りに行きません。
        </Text>

        <Text style={styles.title}>デバイスのしきい値</Text>
        <Text style={styles.note}>
          走行ごとの上書きです。デバイスには保存されず、接続が切れると既定へ戻ります。
        </Text>
        <View style={styles.rows}>
          {DEVICE_CONFIG_KEYS.map((key) => (
            <ConfigRow
              key={key}
              configKey={key}
              value={deviceConfig[key]}
              disabled={riding}
              onChange={(next) => setDeviceConfig(key, next)}
            />
          ))}
        </View>
        <Text style={configOutcome.state === "failed" ? styles.alert : styles.note}>
          {configLabel(configOutcome, Object.keys(deviceConfigOverrides(deviceConfig)).length > 0)}
        </Text>
        {riding ? (
          <Text style={styles.note}>走行中は変えられません。止まってから変えてください。</Text>
        ) : (
          <Pressable onPress={resetDeviceConfig}>
            <Text style={styles.link}>すべて既定に戻す</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * しきい値1つ。**押すたびに `step` ぶん動かす**（数字を打たせない）。
 *
 * **範囲外へは動かない**（`clampDeviceConfig`）——送れてしまうと、デバイスはそのキーだけを
 * 捨てるので、**画面には出ているのに効いていない値**が残る。
 */
function ConfigRow({
  configKey,
  value,
  disabled,
  onChange,
}: {
  configKey: DeviceConfigKey;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  const range = DEVICE_CONFIG_RANGES[configKey];
  const isDefault = value === DEVICE_CONFIG_DEFAULTS[configKey];
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{range.label}</Text>
      <View style={styles.stepper}>
        <Step label="−" disabled={disabled} onPress={() => onChange(value - range.step)} />
        <Text style={styles.value}>
          {value}
          {range.unit}
          {/* **既定かどうかを出す。**書かれるのは既定と違うキーだけなので、
              ここが「既定」なら、その行はデバイスに送られていない。 */}
          {isDefault ? "（既定）" : ""}
        </Text>
        <Step label="＋" disabled={disabled} onPress={() => onChange(value + range.step)} />
      </View>
    </View>
  );
}

function Step({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.step, disabled && styles.stepOff]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.stepLabel}>{label}</Text>
    </Pressable>
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
  stepper: { alignItems: "center", flexDirection: "row", gap: 8 },
  value: { minWidth: 96, textAlign: "center" },
  step: {
    backgroundColor: "#e5e7eb",
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  stepOff: { opacity: 0.4 },
  stepLabel: { fontSize: 16, fontWeight: "bold" },
  link: { color: "#1d4ed8", fontWeight: "bold" },
  content: { gap: 12, padding: 24 },
  title: { fontSize: 20, fontWeight: "bold" },
  rows: { gap: 4 },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  rowLabel: { fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  note: { color: "#6b7280" },
});
