import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { StopSignPref } from "web/src/shared/api";
import { useRiding } from "@/ride/riding";
import { fetchStopSignPrefs } from "@/signs/api";
import { useSelectPref, useSignStore, useSignsMeta } from "@/signs/expo";
import { prefLabel } from "@/signs/pref";
import type { SignsUpdateOutcome } from "@/signs/update";

/**
 * 対象の都道府県を選ぶ画面（#71）。**走行前後に見る画面である**（`CLAUDE.md`）。
 *
 * **選択肢はサーバーが決める**（`docs/interfaces/mobile-api.md`
 * 「どの県を選べるかはサーバーが決める」）。47 県をここに並べると、
 * **取り込んでいない県が並び、選んだ瞬間に 404 になる。**
 *
 * **一覧が取れないときは選ばせない。**手元の県だけを並べて選べるように見せると、
 * **選択肢が1つしかない理由が電波なのか取り込みなのか、誰にも区別が付かない。**
 */
export default function PrefsScreen() {
  const router = useRouter();
  const signs = useSignStore();
  const meta = useSignsMeta(signs);
  const { select, running } = useSelectPref(signs);
  // **走行中は選ばせない。**走行は画面より寿命が長く、設定画面へ移っても走り続けている
  // ——数万行の入れ替えが 1Hz の中継と同じ接続を握る。
  const riding = useRiding();

  const [prefs, setPrefs] = useState<readonly StopSignPref[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // **押した結果はこの画面で持つ。**共有の更新の状態（`useSignsUpdateState()`）には
  // **起動時の更新の結果も入っている**ので、そちらを出すと、**まだ何も押していない人に
  // 「変えられませんでした」と見せる**（圏外で起動しただけで赤が出る）。
  const [selected, setSelected] = useState<SignsUpdateOutcome | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    // **返らないまま終わらせない。**打ち切らないと、電波の弱い場所で
    // **「確かめています…」のまま固まり、もう一度試すボタンも出ない**
    // （`@/signs/expo` の起動時の更新が時間切れを持っているのと同じ理由）。
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, PREFS_TIMEOUT_MS);

    const result = await fetchStopSignPrefs(abort.signal);
    clearTimeout(timeout);
    setLoading(false);

    // **「取れなかった」と「1件も無い」を混ぜない**——前者は待てば直り、
    // 後者は取り込みが要る（`docs/interfaces/mobile-api.md`）。
    if (result.kind === "failed") {
      setPrefs(null);
      setListError(
        timedOut ? "選べる県を確かめましたが、時間内に返りませんでした" : result.message,
      );
      return;
    }
    setPrefs(result.prefs);
    setListError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = useCallback(
    async (pref: number) => {
      setSelected(null);
      const outcome = await select(pref);
      // **入れ替わったときだけ戻る。**失敗したのに戻すと、**選んだつもりの人が
      // 前の県のまま走り出す**——理由は下に出したまま、この画面に留める。
      if (outcome?.status === "replaced") {
        router.back();
        return;
      }
      setSelected(outcome);
    },
    [select, router],
  );

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: "対象の都道府県" }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>対象の都道府県</Text>
        <Text style={styles.note}>
          選び直すと、その県の標識を丸ごと取り直します。失敗しても、いまの標識はそのまま残ります。
        </Text>

        {riding && (
          <Text style={styles.alert}>走行中は選び直せません。走行を終えてから選んでください。</Text>
        )}

        {running && <Text style={styles.note}>標識を取り直しています…</Text>}

        {/* **取りに行けなかったことを、県が無いことと混ぜない。** */}
        {listError !== null && (
          <>
            <Text style={styles.alert}>{listError}</Text>
            <Text style={styles.note}>
              選べる県が分からないため、選び直せません。いまの県（{prefLabel(meta?.pref ?? null)}
              ）のまま走れます。
            </Text>
            <Pressable
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={() => void load()}
              disabled={loading}
              accessibilityRole="button"
            >
              <Text style={styles.buttonLabel}>{loading ? "確かめています…" : "もう一度試す"}</Text>
            </Pressable>
          </>
        )}

        {prefs !== null && prefs.length === 0 && (
          // **選べる県が1つも無い。**これは電波の問題ではないので、再試行を勧めない。
          <Text style={styles.alert}>
            サーバーに取り込まれている県がありません。取り込みが済むまで選び直せません。
          </Text>
        )}

        {prefs?.map((pref) => {
          const current = pref.pref === meta?.pref;
          return (
            <Pressable
              key={pref.pref}
              style={[styles.row, (riding || running || current) && styles.rowDisabled]}
              onPress={() => void onSelect(pref.pref)}
              disabled={riding || running || current}
              accessibilityRole="button"
            >
              <Text style={styles.rowLabel}>{prefLabel(pref.pref)}</Text>
              <Text style={styles.note}>
                {/* **いま持っている県は選ばせない。**押せると、同じものを数 MB
                    落とし直すだけの操作になる。 */}
                {current ? "いま使っています" : `${pref.count} 件`}
              </Text>
            </Pressable>
          );
        })}

        {prefs === null && listError === null && loading && (
          <Text style={styles.note}>選べる県を確かめています…</Text>
        )}

        {/* **入れ替わらなかった理由を、押した場所に出す。**失敗したときはこの画面に
            留まるので（上）、**ここに出さないと「押したのに何も起きない」に見える。** */}
        {selected !== null && !running && (
          <Text style={styles.alert}>{selectFailureLabel(selected)}</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { gap: 12, padding: 24 },
  title: { fontSize: 20, fontWeight: "bold" },
  row: {
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    padding: 16,
  },
  rowDisabled: { opacity: 0.5 },
  rowLabel: { fontWeight: "bold" },
  button: { alignItems: "center", backgroundColor: "#1f2937", borderRadius: 8, padding: 16 },
  buttonDisabled: { backgroundColor: "#9ca3af" },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "bold" },
  alert: { color: "#b91c1c", fontWeight: "bold" },
  note: { color: "#6b7280" },
});

/**
 * 入れ替わらなかったことを1行にする。
 *
 * **`error` が `null` のときに黙らない。**走行が始まって取りやめた場合がそれで
 * （`@/signs/update` の `skipped`）、**黙ると「押したのに何も起きない」ように見える。**
 */
function selectFailureLabel(outcome: SignsUpdateOutcome): string {
  if (outcome.error !== null) return outcome.error;
  if (outcome.status === "skipped") {
    return "走行が始まったため、都道府県を変えていません。走行を終えてからもう一度選んでください。";
  }
  return "都道府県を変えられませんでした。";
}

/**
 * 選べる県の一覧をこれだけ待って返らなければ諦める。
 *
 * **返るのは数十行**なので、標識そのもの（30 秒）ほど待つ意味がない。
 * **待たせるより、もう一度試すボタンを出す方が早い。**
 */
const PREFS_TIMEOUT_MS = 10_000;
