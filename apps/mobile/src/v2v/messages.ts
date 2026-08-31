/**
 * 車車間で運ぶメッセージの型と、送る前・受け取った後の処理。
 *
 * **形の正本は `docs/interfaces/v2v.md`「メッセージ」。**ここはその実装であって、
 * 決め直す場所ではない。単位は m/s と度のままで、ここで換算しない。
 *
 * HTTP も React Native も知らない。受け取った値を検証するだけなので、開発機で
 * そのままテストできる（`docs/adr/0002-development-lifecycle.md`）。
 */

/** 自車の測位。`id` は入らない（自分なので要らない）。 */
export type SelfMessage = {
  k: "self";
  /** 測位した時刻（UTC ミリ秒）。送信した時刻ではない */
  t: number;
  lat: number;
  lon: number;
  /** 対地速度（m/s） */
  spd: number;
  /** 進行方角（度、真北 0、時計回り 0〜360未満）。低速時は null */
  crs: number | null;
  /** 水平位置精度（メートル） */
  hacc: number;
};

/** 周辺車両1台ぶん。`self` に `id` を足しただけ。 */
export type PeerMessage = Omit<SelfMessage, "k"> & {
  k: "peer";
  /** 端末ID（16進の小文字8文字）。BLE の `device_id` と同じ値 */
  id: string;
};

/**
 * 通してよい値の範囲。
 *
 * **コードに直書きしない**（`CLAUDE.md`）。上限を置くのは、壊れた1通を検知に届かせないため。
 * 桁違いの `spd` は相対速度も外挿した位置も桁違いにし、`hacc` が数十メートルの相手を
 * 「そこにいる自転車」として渡すと居ない自転車で警告が鳴る。
 */
export type MessageLimits = {
  /** これを超える `spd` は捨てる（m/s） */
  maxSpdMps: number;
  /** これを超える `hacc` は捨てる（メートル） */
  maxHaccM: number;
};

/** 既定値はすべて仮の値。実走行で調整する（`docs/unverified.md`）。 */
export const messageLimitDefaults: MessageLimits = {
  maxSpdMps: 30,
  maxHaccM: 50,
};

/**
 * `spd` がこれ未満なら `crs` に `null` を入れる（m/s）。
 *
 * 止まっている自転車の進行方角は測位では決まらず、Android は直前の値を返したり
 * `hasBearing()` が `false` になったりする（`docs/interfaces/v2v.md`）。
 */
export const CRS_MIN_SPD_MPS = 1.0;

/** 小数を指定の桁で丸める。`toFixed` の文字列を経由せずに数値のまま返す。 */
const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * 送る前に桁を丸める（`docs/interfaces/v2v.md`「桁を丸める」）。
 *
 * JavaScript の数値は倍精度で `JSON.stringify` が最大17桁まで出すため、測位の値を
 * そのまま入れると `"hacc":5.500000238418579` のようになる。**同じ測位の値が経路に
 * よって違う桁で現れるのを避ける**ために、送る側で丸める。
 */
export function roundForWire<T extends SelfMessage | PeerMessage>(msg: T): T {
  const crs = msg.crs === null ? null : round(msg.crs, 1);
  return {
    ...msg,
    lat: round(msg.lat, 7),
    lon: round(msg.lon, 7),
    spd: round(msg.spd, 2),
    // 丸めた結果が 360.0 になったら 0 にする。受信側の範囲は 0 以上 360 未満なので、
    // そのままだとその1通が丸ごと捨てられる。
    crs: crs === 360 ? 0 : crs,
    // 丸めた結果が 0 になったら下限に寄せる。受信側は `hacc` が 0 以下のものを捨てる
    // ので、**`crs` の 360 と同じ形でその1通が経路の途中から静かに消える。**
    hacc: Math.max(0.1, round(msg.hacc, 1)),
  };
}

/** 有限の数値か。`NaN` と `Infinity` を弾く（`typeof` だけでは通ってしまう）。 */
const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * `self` / `peer` に共通する項目を検証する。通らなければ `null`。
 *
 * **`crs` の `null` を範囲外として捨てない。**`null` は「止まっていて向きが分からない」
 * という正常な値であり、捨てると止まっている自転車と低速の自転車が丸ごと消える。
 * 急接近（#9）が一番見たい相手がこれなので、検知が静かに効かなくなる。
 */
function parseCommon(value: unknown, limits: MessageLimits): Omit<SelfMessage, "k"> | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  // 必須の項目が欠けているメッセージは捨てる。何が必要かは `k` ごとに違うので、
  // `id` はここで見ない（見ると `self` が1通残らず捨てられる）。
  if (!isNum(v.t) || !isNum(v.lat) || !isNum(v.lon) || !isNum(v.spd) || !isNum(v.hacc)) {
    return null;
  }
  // `crs` は「無い」と「null」を区別する。キーごと無ければ欠けている扱い。
  if (!("crs" in v)) return null;
  const crs = v.crs;
  if (crs !== null && !isNum(crs)) return null;

  if (v.lat < -90 || v.lat > 90) return null;
  if (v.lon < -180 || v.lon > 180) return null;
  if (v.spd < 0 || v.spd > limits.maxSpdMps) return null;
  if (crs !== null && (crs < 0 || crs >= 360)) return null;
  // `hacc` は 0 より大きいこと。0 を通すと「誤差 0 の確かな位置」になってしまう。
  if (v.hacc <= 0 || v.hacc > limits.maxHaccM) return null;

  return { t: v.t, lat: v.lat, lon: v.lon, spd: v.spd, crs, hacc: v.hacc };
}

/** 受け取った値を `self` として読む。読めなければ `null`（その1通を捨てる）。 */
export function parseSelf(value: unknown, limits: MessageLimits): SelfMessage | null {
  if (typeof value !== "object" || value === null) return null;
  if ((value as Record<string, unknown>).k !== "self") return null;
  const common = parseCommon(value, limits);
  return common === null ? null : { k: "self", ...common };
}

/** 端末ID の形（16進の小文字8文字）。BLE の `device_id` と同じ。 */
const DEVICE_ID = /^[0-9a-f]{8}$/;

/** 受け取った値を `peer` として読む。読めなければ `null`（その1通を捨てる）。 */
export function parsePeer(value: unknown, limits: MessageLimits): PeerMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.k !== "peer") return null;
  // `id` は `peer` にだけ必須。無ければ誰の位置か分からないので捨てる。
  if (typeof v.id !== "string" || !DEVICE_ID.test(v.id)) return null;
  const common = parseCommon(value, limits);
  return common === null ? null : { k: "peer", id: v.id, ...common };
}
