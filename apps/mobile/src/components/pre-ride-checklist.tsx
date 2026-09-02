/**
 * 走行前の点検を並べる。**判定はここに書かない**（`@/ride/pre-ride`）。
 *
 * **色だけで伝えない。**記号（○ / × / …）を必ず添える——色覚や、日中の屋外で
 * 画面が見えにくい状況で、**緑と赤の区別だけが頼りになる作りにしない。**
 */

import { StyleSheet, Text, View } from "react-native";
import type { PreRideCheck, PreRideCheckState } from "@/ride/pre-ride";

const MARK: Record<PreRideCheckState, string> = { ok: "○", ng: "×", checking: "…" };

export function PreRideChecklist({ checks }: { checks: readonly PreRideCheck[] }) {
  return (
    <View style={styles.list}>
      {checks.map((check) => (
        <View key={check.key} style={styles.item}>
          <Text style={[styles.mark, styles[check.state]]}>{MARK[check.state]}</Text>
          <View style={styles.body}>
            <Text style={[styles.label, styles[check.state]]}>{check.label}</Text>
            {/* **赤の理由を必ず書く。**「デバイス: ×」だけだと、初めての人は
                何をすればよいか分からない（`CLAUDE.md`）。 */}
            <Text style={styles.detail}>{check.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  item: { flexDirection: "row", gap: 8 },
  mark: { fontSize: 16, fontWeight: "bold", width: 20 },
  body: { flex: 1 },
  label: { fontWeight: "bold" },
  detail: { color: "#374151" },
  ok: { color: "#15803d" },
  ng: { color: "#b91c1c" },
  checking: { color: "#6b7280" },
});
