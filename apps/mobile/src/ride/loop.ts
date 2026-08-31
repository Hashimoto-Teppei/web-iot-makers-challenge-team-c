/**
 * 走行ループ。**測位 → 中継 → 検知 → 出力**をつなぐ場所。
 *
 * ```
 * 測位が更新された → POST /api/v2v/exchange → peers を NeighborStore へ →
 * 登録されている検知を全部回す → 発火したら warn を alert へ
 * （これとは別に）1秒のタイマー → beat を alert へ
 * ```
 *
 * **検知そのものはここに書かない**（`../detect/`）。**BLE の実装もここに書かない**
 * （`./device.ts` の口だけを使う）。**測位の読み取りもここに書かない**（`./location.ts`）。
 * おかげでこのファイルは React Native も expo-location も知らず、**実機なしで
 * Vitest から回せる**（`docs/adr/0002-development-lifecycle.md`）。
 *
 * 守っている約束は `docs/interfaces/mobile-api.md`「スマホの約束」と
 * 「失敗したときの約束」。**理由をここに写さない。**
 */

import type { StopSign, Warning } from "../detect/types";
import type { BeatMessage } from "../v2v/alert";
import type { SelfMessage } from "../v2v/messages";
import { NeighborStore, type NeighborsConfig, neighborsDefaults } from "../v2v/neighbors";
import { type RegisteredDetector, registeredDetectors } from "./detectors";
import type { DeviceLink } from "./device";
import { WarnGate, type WarnGateConfig, warnGateDefaults } from "./warn-gate";

/**
 * 中継の1往復。**失敗は例外で表す**（`peers` が空の配列とは意味が違う——
 * 空は「届いたが半径内に誰も居なかった」）。
 *
 * 返す値を検証済みの型にしていないのは、**近傍に入れる前にもう一度検証する**からである
 * （`docs/interfaces/v2v.md`「受信側（モバイル）の約束」）。サーバー側にも検証はあるが、
 * 受け取った側で確かめるのをやめない。
 */
export type ExchangeFn = (id: string, self: SelfMessage) => Promise<readonly unknown[]>;

/** 走行ループの設定。**しきい値をコードに直書きしない**（`CLAUDE.md`）。 */
export type RideConfig = {
  /** 近傍の保ち方（失効・履歴の長さ） */
  neighbors: NeighborsConfig;
  /** 同じ警告を書き直す間隔 */
  warnGate: WarnGateConfig;
  /**
   * これ以上の速度なら「走行中」とする（m/s）。`beat` の `mv` に入る。
   *
   * **速度を持っているのはスマホだけなので、判定もスマホが行う**
   * （`docs/interfaces/v2v.md`「デバイスへ渡すもの」）。
   */
  movingSpdMps: number;
};

/** 既定値は仮の値（`docs/unverified.md`）。 */
export const rideDefaults: RideConfig = {
  neighbors: neighborsDefaults,
  warnGate: warnGateDefaults,
  // 歩くより速ければ走行中とみなす。
  movingSpdMps: 1.5,
};

/**
 * 走行前後の画面に出すためのもの。**走行中に見る前提の画面を作らないこと**（`CLAUDE.md`）。
 *
 * ここに出すのは「仕組みが動いているか」であって、警告そのものではない
 * （警告の出し先はデバイス）。
 */
export type RideStatus = {
  /** 名乗っている端末ID */
  deviceId: string;
  /** 測位が取れているか。`beat` の `st` と同じ値 */
  fix: "ok" | "nofix";
  /** 最後に測位を取り込んだ時刻（UTC ミリ秒）。一度も無ければ `null` */
  lastFixAt: number | null;
  /** 直近の交換で受け取った近傍の台数 */
  peers: number;
  /**
   * **連続して POST に失敗している回数。**成功すると 0 に戻る。
   *
   * **これを画面に出す。**近傍が空になるのは「周りに誰もいない」と区別がつかず、
   * デバイスの `link` は `up` のままなので、**そちらの表示では気づけない**
   * （`docs/interfaces/mobile-api.md`「失敗したときの約束」）。
   */
  postFailures: number;
  /** 最後に POST が成功した時刻（UTC ミリ秒）。一度も無ければ `null` */
  lastPostOkAt: number | null;
  /**
   * 検知が例外を投げた回数（累計）。
   *
   * **0 でないことに意味がある。**1つの検知の不具合で走行ループ全体を止めないように
   * 握りつぶしているので、**握りつぶしたことが表に出ないと、静かに効かなくなる。**
   */
  detectorErrors: number;
};

/** 走行ループを組み立てるのに要るもの。 */
export type RideDeps = {
  /** 接続中のデバイス。**つながっていない間はループを作らない**（`./device.ts`） */
  device: DeviceLink;
  /** 中継の1往復。実装は `./api.ts` */
  exchange: ExchangeFn;
  /** 回す検知。既定は `./detectors.ts` に登録されているもの */
  detectors?: readonly RegisteredDetector[];
  /**
   * 近傍の一時停止の標識（#27）。
   *
   * **県ぶんの全件を渡さない。**端末の SQLite からセルで絞って渡すのは呼び出し側で、
   * 置き方は `docs/adr/0009-on-device-storage.md`、配り方は
   * `docs/interfaces/mobile-api.md`「一時停止の標識をスマホに配る」。
   */
  signs?: readonly StopSign[];
  /**
   * 自分の時計。**既定は `Date.now`。**
   *
   * 差し替えられるようにしてあるのは、**POST の往復を挟んだ前後で時刻が進む**ことを
   * テストで再現するため（`rxAt` は受け取った側が打つ）。**検知の中では時刻を取らない**
   * （`docs/interfaces/detectors.md`）が、ここは呼び出し側なので取ってよい。
   */
  now?: () => number;
  /** 状態が変わったときに呼ばれる。走行前後の画面が購読する */
  onStatus?: (status: RideStatus) => void;
  config?: Partial<RideConfig>;
};

/**
 * 走行中ずっと動き続けるもの。
 *
 * **`beat` を測位や POST の中に置いていない。**{@link beat} は独立したタイマーから
 * 呼ばれ、{@link onFix} の成否を見ない。ぶら下げると、**通信が詰まるたびに心拍が遅れ、
 * デバイスが「アプリが落ちた」と表示する**（`docs/interfaces/mobile-api.md`）。
 */
export class RideLoop {
  private readonly config: RideConfig;
  private readonly store: NeighborStore;
  private readonly gate: WarnGate;
  private readonly detectors: readonly RegisteredDetector[];
  private readonly now: () => number;

  private signs: readonly StopSign[];
  /** 直近に取り込めた測位。`mv` の判定に使う */
  private lastFix: SelfMessage | null = null;
  private lastFixAt: number | null = null;
  private lastPostOkAt: number | null = null;
  private postFailures = 0;
  private peerCount = 0;
  private detectorErrors = 0;
  /**
   * POST が返ってくるのを待っている最中か。
   *
   * **重ねて投げない。**往復が1秒を超えると次の測位が来るので、放っておくと同時に何本も
   * 飛ぶ。**待っている間の測位は POST を飛ばすだけで、検知は回す**（自車の測位は
   * 生きているので、標識を見る検知は動く）。**溜めて後で送らない**——次の測位が1秒後に来る。
   */
  private exchanging = false;

  constructor(private readonly deps: RideDeps) {
    this.config = { ...rideDefaults, ...deps.config };
    this.store = new NeighborStore(deps.device.deviceId, this.config.neighbors);
    this.gate = new WarnGate(this.config.warnGate);
    this.detectors = deps.detectors ?? registeredDetectors;
    this.signs = deps.signs ?? [];
    this.now = deps.now ?? Date.now;
  }

  /**
   * 心拍を1通書く。**1秒のタイマーから呼ぶ**（{@link startHeartbeat}）。
   *
   * **測位が無い間も呼ぶこと。**測位が更新されないと更新イベントは起きないので、
   * 測位に合わせた実装だけだと `beat` が1通も飛ばず、デバイスは `down`
   * （＝アプリが落ちた）と表示する。
   */
  beat(): void {
    const now = this.now();
    const hasFix = this.store.hasSelfFix(now);
    const beat: BeatMessage = {
      k: "beat",
      t: now,
      st: hasFix ? "ok" : "nofix",
      // **測位が無い間は「走行中」に倒す。**止まっているかは測位が無いと分からず、
      // 迷ったら走行中に倒すのが `docs/notifications.md` の立場である。
      mv: hasFix ? (this.lastFix?.spd ?? 0) >= this.config.movingSpdMps : true,
    };
    this.deps.device.writeAlert(beat);
    // **心拍のたびに状態も流す。**測位が完全に途切れると `onFix()` が二度と呼ばれないので、
    // ここで流さないと**画面が「測位: 取れている」を出したまま固まる**——`beat` には
    // `st: "nofix"` が流れているのに、である。**一番知らせるべき故障のときだけ
    // 画面が正しくない**という形になる。
    this.emitStatus();
  }

  /**
   * 1秒ごとに {@link beat} を呼び続ける。**止めるための関数を返す。**
   *
   * **測位の購読と別に始める。**`setInterval` を使うのは、心拍が「何も起きていなくても
   * 進み続けるもの」だからで、**測位や POST のイベントに乗せない。**
   */
  startHeartbeat(intervalMs = 1_000): () => void {
    // 起動直後に1通書く。最初の1秒を待つと、その間デバイスは `link` を決められない。
    this.beat();
    const timer = setInterval(() => this.beat(), intervalMs);
    return () => clearInterval(timer);
  }

  /**
   * 測位が1つ更新されたときの1周期。**中継 → 検知 → 出力**まで行う。
   *
   * **測位が取れていない間は呼ばない**（`self` を作らない。前回の位置を送り直さない）。
   *
   * @param fix 自車の測位。**送る前の丸めは済ませてある**こと（`./location.ts`）
   */
  async onFix(fix: SelfMessage): Promise<void> {
    const accepted = this.store.acceptSelf(fix, this.now());
    if (accepted) {
      this.lastFix = fix;
      this.lastFixAt = this.now();
    }

    // **取り込めなかった測位を送らない。**壊れているか、`t` が前回より進んでいない
    // （＝測位が固まっている）ものであり、送っても他人の近傍に古い位置を配るだけ。
    if (accepted) await this.exchangeOnce(fix);

    this.runDetectors();
    this.emitStatus();
  }

  /** 近傍の標識を差し替える（#27 / #63）。**絞るのは呼び出し側の責務。** */
  setSigns(signs: readonly StopSign[]): void {
    this.signs = signs;
  }

  /** いまの状態。走行前後の画面が読む。 */
  status(): RideStatus {
    return {
      deviceId: this.deps.device.deviceId,
      fix: this.store.hasSelfFix(this.now()) ? "ok" : "nofix",
      lastFixAt: this.lastFixAt,
      peers: this.peerCount,
      postFailures: this.postFailures,
      lastPostOkAt: this.lastPostOkAt,
      detectorErrors: this.detectorErrors,
    };
  }

  /**
   * 中継を1往復。**失敗しても投げ返さない**（呼び出し側は検知へ進む）。
   *
   * **再送しない。**次の測位が1秒後に来るので、アプリ層の再送を作らない
   * （`docs/interfaces/mobile-api.md`「運び方」）。
   */
  private async exchangeOnce(fix: SelfMessage): Promise<void> {
    if (this.exchanging) return;
    this.exchanging = true;
    try {
      const peers = await this.deps.exchange(this.deps.device.deviceId, fix);
      // **`rxAt` はレスポンスを受け取った時刻。**送った時刻ではない。往復のぶん
      // （150〜350ms）古いことが `now - rxAt` に含まれている必要がある
      // （`docs/interfaces/detectors.md`）。
      this.store.acceptPeers(peers, this.now());
      this.peerCount = peers.length;
      this.postFailures = 0;
      this.lastPostOkAt = this.now();
    } catch {
      // **中身を見ない。**通信の失敗も 400 も、スマホがすることは同じ（次の測位を待つ）。
      // **近傍は消さない**——失効が時間で消す。ここで消すと、1回の失敗で
      // 「周りに誰も居ない」状態が作られる。
      this.postFailures += 1;
      this.peerCount = 0;
    } finally {
      this.exchanging = false;
    }
  }

  /** 登録された検知を全部回し、書いてよいものを `alert` へ書く。 */
  private runDetectors(): void {
    const now = this.now();
    const input = this.store.detectorInput(now, this.signs);
    // **自車の測位が無い間は検知を1つも呼ばない**（`docs/interfaces/detectors.md`）。
    // このとき人に見えるのは `beat` の `st: "nofix"` である。
    if (input === null) return;

    const fired: Warning[] = [];
    for (const detector of this.detectors) {
      try {
        const warning = detector.run(input);
        if (warning !== null) fired.push(warning);
      } catch {
        // **1つの検知の不具合で走行ループを止めない。**止めると、他の検知も心拍も
        // 一緒に死ぬ。**握りつぶしたことは status に出す**（気づけないと静かに効かなくなる）。
        this.detectorErrors += 1;
      }
    }

    // **スマホ側で1つに絞らない。**発火したものは全部書く。後方物体（`rear_object`）と
    // 合流させて1件を選ぶのはデバイスの仕事で、ここで絞るとデバイスから見て
    // 「起きなかったこと」になる（`docs/interfaces/detectors.md`）。
    for (const warning of this.gate.admit(fired, now)) {
      this.deps.device.writeAlert({ k: "warn", kind: warning.kind, lv: warning.lv });
    }
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.status());
  }
}
