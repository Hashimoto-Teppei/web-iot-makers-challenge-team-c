/**
 * `config`（Write）で上書きするしきい値。**判定と組み立てだけ**を持つ（#124）。
 *
 * **正本は `docs/interfaces/ble-gatt.md`「`config`（Write）」。**ここはその実装であって、
 * 範囲や既定を決め直す場所ではない。**既定はデバイスの `apps/device/src/device/config.py`
 * と同じ値**でなければならない——ずれると、**書いていないキーを「既定と同じだから」と
 * 送らずに済ませた結果、デバイス側では別の値で走る。**
 *
 * **BLE を知らない。**書くのは `./link.ts`、人が触るのは `../app/settings.tsx` で、
 * ここは**実機も Development Build も無いまま Vitest で回せる**
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **キーの名前を電波に流れるものと揃えてある**（`beat_to` を `beatTo` にしない）。
 * 変換表を置くと、**`status` の `cfg` と突き合わせるときにもう一度変換が要る**——
 * 2か所に分かれた対応表は必ず片方だけずれる（`CLAUDE.md`「同じことを2箇所に書かない」）。
 */

export type DeviceConfigKey = "hold1" | "hold2" | "hold3" | "beat_to";

/** 上書きできる4つ。**全部の値を持つ**（送るのは既定と違うものだけ。{@link deviceConfigOverrides}） */
export type DeviceConfig = Record<DeviceConfigKey, number>;

/** 上書きしていないときの値。**`config.py` の `NOTIFY_CONFIG` / `LINK_BEAT_TIMEOUT_S` と同じ。** */
export const DEVICE_CONFIG_DEFAULTS: DeviceConfig = {
  hold1: 3_000,
  hold2: 4_000,
  hold3: 6_000,
  beat_to: 3,
};

/** 1つぶんの決まり。**範囲の正本は `ble-gatt.md`** で、ここはその写し。 */
export type DeviceConfigRange = {
  label: string;
  unit: string;
  min: number;
  max: number;
  /** 画面のボタン1回で動く幅 */
  step: number;
};

/**
 * キーごとの範囲。
 *
 * **どちらも「遅くなる方向にしか動かせない」ように切ってある。**
 * 下端でも警告は出る——これは値の選び方ではなく、**いまペアリング無しで済んでいることの
 * 根拠そのもの**である（`docs/interfaces/ble-security.md`。**広げるときは向こうを開くこと**）。
 */
export const DEVICE_CONFIG_RANGES: Record<DeviceConfigKey, DeviceConfigRange> = {
  hold1: { label: "警告の保持 lv1", unit: "ms", min: 1_000, max: 10_000, step: 500 },
  hold2: { label: "警告の保持 lv2", unit: "ms", min: 1_000, max: 10_000, step: 500 },
  hold3: { label: "警告の保持 lv3", unit: "ms", min: 1_000, max: 10_000, step: 500 },
  beat_to: { label: "心拍の時間切れ", unit: "秒", min: 2, max: 10, step: 1 },
};

/** 並べる順。**`Object.keys()` に頼らない**（画面の並びが実行環境次第で変わらないように）。 */
export const DEVICE_CONFIG_KEYS: readonly DeviceConfigKey[] = [
  "hold1",
  "hold2",
  "hold3",
  "beat_to",
];

/**
 * 範囲に収める。**画面から出る値をここで必ず通す。**
 *
 * **範囲外をそのまま送らない。**デバイスは範囲外のキーだけを捨てるので
 * （`ble-gatt.md`）、送れてしまうと**画面には出ているのに効いていない**値が残る。
 */
export function clampDeviceConfig(key: DeviceConfigKey, value: number): number {
  const range = DEVICE_CONFIG_RANGES[key];
  if (!Number.isFinite(value)) return DEVICE_CONFIG_DEFAULTS[key];
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * 既定と違うキーだけを取り出す。**これが `config` に書く中身になる。**
 *
 * **全部を送らない。**送る値が増えるほど、**デバイス側に項目が増えたときに
 * 古いアプリが既定へ戻す側に回る**危険が上がる（部分更新である理由。`ble-gatt.md`）。
 * 空なら**そもそも書かない**——「変えていなければ書かない」（同「接続してから転送するまで」の 5）。
 */
export function deviceConfigOverrides(config: DeviceConfig): Partial<DeviceConfig> {
  const overrides: Partial<DeviceConfig> = {};
  for (const key of DEVICE_CONFIG_KEYS) {
    if (config[key] !== DEVICE_CONFIG_DEFAULTS[key]) overrides[key] = config[key];
  }
  return overrides;
}

/**
 * この接続に**いま書くべき中身**を組み立てる。
 *
 * `written` は**この接続ですでに書いた上書き**。**戻したキーは、既定の値を明示して書き直す**
 * ——`config` は部分更新なので（`ble-gatt.md`）、**送らなければ前に書いた上書きが残ったまま**
 * である。「既定に戻す」を押したのに送るものが無い、では**画面が既定と言いながらデバイスは
 * 上書きで走る。** デバイス側が既定へ戻すのは切断のときだけ。
 */
export function deviceConfigWrite(
  config: DeviceConfig,
  written: Partial<DeviceConfig>,
): Partial<DeviceConfig> {
  const overrides = deviceConfigOverrides(config);
  const payload: Partial<DeviceConfig> = { ...overrides };
  for (const key of DEVICE_CONFIG_KEYS) {
    if (written[key] !== undefined && overrides[key] === undefined) {
      payload[key] = DEVICE_CONFIG_DEFAULTS[key];
    }
  }
  return payload;
}

/** `config` に書く1通。**1回の Write に収まる大きさしか置かない**（`ble-gatt.md`）。 */
export function deviceConfigPayload(overrides: Partial<DeviceConfig>): string {
  return JSON.stringify(overrides);
}

/**
 * 書いたものが本当に効いているかを、`status` の `cfg` と突き合わせる。
 *
 * **効いていないキーを返す**（全部効いていれば空）。**`last_error` で判定しない**
 * ——あれは `read` を書くと消えるうえ、**別の書き込みを断った理由が残っているだけ**の
 * ことがある。事実の正本は `cfg` の側（`ble-gatt.md`「`status`」）。
 *
 * **`cfg` に無いキーは「既定が効いている」と読む。**`cfg` に載るのは既定と違うキーだけなので
 * （`ble-gatt.md`「`status`」）、**既定へ戻すために書いた値は `cfg` から消えるのが正解**である。
 * 「載っていない＝効いていない」と読むと、**戻せたときに必ず赤が出る。**
 *
 * **`cfg` に余分なキーがあっても失敗にしない。**デバイスが上書きできる項目を1つ増やした
 * だけで、古いアプリが「効いていない」と言い出す（知らないキーは無視する、の裏返し）。
 */
export function unappliedConfigKeys(
  sent: Partial<DeviceConfig>,
  cfg: Readonly<Record<string, number>>,
): DeviceConfigKey[] {
  return DEVICE_CONFIG_KEYS.filter((key) => {
    const want = sent[key];
    return want !== undefined && (cfg[key] ?? DEVICE_CONFIG_DEFAULTS[key]) !== want;
  });
}

/** 効かなかったキーを人へ見せる1行にする。**何が効いていないかまで書く。** */
export function unappliedConfigReason(keys: readonly DeviceConfigKey[]): string {
  const labels = keys.map((key) => DEVICE_CONFIG_RANGES[key].label).join("・");
  return `デバイスが受け付けませんでした（${labels}）。既定のまま走ります。`;
}
