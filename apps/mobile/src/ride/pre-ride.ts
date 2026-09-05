/**
 * 走り出す前の点検。**4つがそろっているかを判定するのはここだけ。**
 *
 * **判定を画面に散らさない。**同じ「走れない」を2か所で判定すると、片方だけを直したときに
 * **押せるのに黙る**（あるいはその逆の）状態ができる。画面（`../app/index.tsx`）は
 * ここが返したものを並べるだけにする。
 *
 * **なぜ要るか。**この仕組みの故障はどれも「静かに黙る」形を取る——デバイスに
 * つながっていなければ検知は動いても出し先が無く、標識が無ければ一時停止の事前通知だけが
 * 黙り、中継が届かなければ近傍が空になる。**そのどれもデバイスの `link` は `up` のまま**
 * である（`docs/adr/0004-v2v-transport.md`）。**走行中はスマホを見られない**
 * （見る行為が取り締まりの対象。`CLAUDE.md`）ので、**走り出す前に人が1画面で見ることが
 * 実質唯一の防御**になる。
 *
 * **React も expo も知らない**ので、実機なしで Vitest から回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 */

import type { SignsMeta } from "../signs/store";
import type { RideStatus } from "./loop";

/**
 * これだけ続けて中継に失敗したら「サーバー」を赤にする。
 *
 * **1回の失敗では赤にしない。**1Hz で投げているので、1通落ちるのは日常的に起きる。
 * **それでも赤にする**——近傍が空になるのは「周りに誰もいない」と区別がつかない
 * （`docs/interfaces/mobile-api.md`「失敗したときの約束」）。
 */
export const POST_FAILURE_ALERT = 3;

/** 点検の1項目。**並び順はこの配列の順**（`preRideChecks`）。 */
export type PreRideCheckKey = "device" | "fix" | "signs" | "server";

/**
 * 1項目の状態。
 *
 * **「確かめている最中」を緑にも赤にもしない。**緑にすると確かめる前に走り出せてしまい、
 * 赤にすると**起動直後の数秒がいつも故障に見える**——どちらも、この画面が伝えたい
 * 「本当に赤いとき」を薄める。
 */
export type PreRideCheckState = "ok" | "ng" | "checking";

export type PreRideCheck = {
  key: PreRideCheckKey;
  label: string;
  state: PreRideCheckState;
  /**
   * 状態の理由。**赤のときは何をすればよいかまで書く。**
   *
   * 「デバイス: ✗」だけだと、初めての人は手が止まる（`CLAUDE.md`
   * 「開発が初めてのメンバーが多い」）。
   */
  detail: string;
};

/** 点検に要るもの。**画面が持っている値をそのまま渡す。** */
export type PreRideInput = {
  /**
   * 接続中のデバイスの端末ID。**つながっていなければ `null`**（`./device.ts`）。
   *
   * つながっていないと**検知が動いても警告の出し先が無い**
   * （`docs/adr/0006-decision-layer-on-mobile.md`）。
   */
  deviceId: string | null;
  /**
   * 接続中のデバイスがモック（実機の BLE を使わない仮のもの）か。**画面に必ず出す。**
   *
   * 隠すと、**BLE を通っていないことを画面が「接続しています」と言い切る**
   * ——この画面が防ごうとしている「動いているつもり」そのものになる。
   */
  deviceIsMock: boolean;
  /**
   * つながっていない理由。**つながっているか、まだ探しているだけなら `null`**
   * （`../ble/link.ts`）。
   *
   * **「見つからない」と「MTU が足りない」と「バージョンが違う」で直し方が違う。**
   * 「デバイス: ✗」だけだと初めての人は手が止まる（`CLAUDE.md`）。
   */
  deviceReason: string | null;
  /** まだ探している最中か。**「探している」と「駄目だった」を混ぜない** */
  deviceChecking: boolean;
  /**
   * デバイスが `status` で言ってくる `link`。**購読が始まるまでは `null`**
   * （`../ble/protocol.ts`）。
   *
   * **デバイス側から見た心拍の状態**であって、こちらの接続の有無ではない。
   * **`down` のまま走り出すと、書いたつもりの `alert` が届いていない**
   * （`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
   */
  deviceLink: "up" | "nofix" | "down" | null;
  /** 測位の見込み。**権限などで測れないなら理由、測れそうなら `null`**（`./location.ts`） */
  locationReason: string | null;
  /** 測位の権限をまだ確かめている最中か */
  locationChecking: boolean;
  /** 手元の標識の素性。**持っていなければ `null`**（`0` 件とは別物） */
  signsMeta: SignsMeta | null;
  /**
   * 走行前のサーバー疎通（`./server-reach.ts`）。**届かない理由、届けば `null`。**
   *
   * **標識の更新の成否で代用しない。**あちらは失敗しても走行を止めないと決めてある
   * （`docs/interfaces/stop-signs-delivery.md`）。
   */
  serverReason: string | null;
  /** サーバーへ届くかを確かめている最中か */
  serverChecking: boolean;
  /**
   * **中継そのものが塞がれている理由。**塞がれていなければ `null`。
   *
   * **疎通が取れていても中継が飛ばないこと**がある——モックのデバイスのまま共有の
   * デプロイ先へ位置を出さない歯止め（`../lib/mock-guard.ts`）がその一例で、
   * **同じ Worker に届いてはいるので `/api/health` は緑になる。**
   * **ここを見ないと、既定のビルドで4つ緑のまま走り出し、3秒後に中継が全滅する。**
   */
  relayBlockedReason: string | null;
  /** 走行ループの状態。**走り出すまでは `null`**（`./loop.ts`） */
  status: RideStatus | null;
};

/**
 * 4項目を判定する。**走行前と走行中で、見ている値が変わる項目がある。**
 *
 * 走り出すまでは測位も中継も動いていないので、**動いていないものの代わりに
 * 「動かせる見込み」を見る**（測位は権限、サーバーは起動時の更新が届いたか）。
 * 走り出したあとは実測（`status`）に切り替わる。
 */
export function preRideChecks(input: PreRideInput): readonly PreRideCheck[] {
  return [device(input), fix(input), signs(input), server(input)];
}

/**
 * 走行を始めてよいか。**1つでも緑でなければ始めない**（「確かめている最中」も含む）。
 *
 * **押せないことを人が直せる形にするのは画面の責務**である——ここは可否だけを返す。
 */
export function canStartRide(checks: readonly PreRideCheck[]): boolean {
  return checks.every((check) => check.state === "ok");
}

function device({
  deviceId,
  deviceIsMock,
  deviceReason,
  deviceChecking,
  deviceLink,
  status,
}: PreRideInput): PreRideCheck {
  const label = "デバイス";
  if (deviceId === null) {
    // **探している最中を赤にしない。**スキャンには数秒かかるので、
    // **起動直後の数秒がいつも故障に見える**（本物の赤が読み飛ばされるようになる）。
    if (deviceReason === null && deviceChecking) {
      // **待てば直ることを、この行に書いておく。**別のスマホがつながっている間は
      // アドバタイズが出ないが、デバイスは 30 秒ほどで自分から手放す
      // （`docs/interfaces/ble-gatt.md`「前提」）。**書いておかないと、
      // 人は電源を切りに行く**——それが要らなくなったことが伝わらない。
      return {
        key: "device",
        label,
        state: "checking",
        detail:
          "デバイスを探しています…（別のスマホがつながったままでも、しばらく待てば繋がります）",
      };
    }
    return {
      key: "device",
      label,
      state: "ng",
      // **理由が分かっていればそれを出す。**分からないときだけ既定の文にする。
      detail:
        deviceReason ??
        "デバイスにつながっていません。デバイスの電源を入れて、近くに置いてください" +
          "（つながっていないと、危険を検知しても知らせる先がありません）。",
    };
  }
  // **モックであることを隠さない。**隠すと、**BLE を通っていないことを画面が
  // 「接続しています」と言い切る**——この画面が防ごうとしている「動いているつもり」
  // そのものになる。
  if (deviceIsMock) {
    return {
      key: "device",
      label,
      state: "ok",
      detail: `${deviceId} に接続しています（モック接続。実機の BLE は通っていません）。`,
    };
  }
  // **走行中だけ見る。**心拍を書き始めるのは走行を始めてから（`./loop.ts` の
  // `startHeartbeat()`）なので、**走り出す前の `down` は正常な状態**である。
  // ここで赤くすると、**つながっているのに永久に走り始められない**
  // （赤 → 走れない → 心拍が出ない → 赤のまま）。
  //
  // **デバイス側が「心拍が来ていない」と言っていたら赤にする。**こちらは接続できて
  // いるので緑に見えるが、**`alert` が届いていないなら警告は1つも出ない**
  // （`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
  if (status !== null && deviceLink === "down") {
    return {
      key: "device",
      label,
      state: "ng",
      detail:
        `${deviceId} につながっていますが、デバイスは心拍を受け取れていません。` +
        "つなぎ直してください（このままだと警告が出ません）。",
    };
  }
  return {
    key: "device",
    label,
    state: "ok",
    detail: `${deviceId} に接続しています。`,
  };
}

function fix({ status, locationReason, locationChecking }: PreRideInput): PreRideCheck {
  const label = "測位";
  // 走行中は実測を見る。**「権限はある」で緑にしない**——権限があっても、
  // 屋内や谷では測位そのものが出ない。
  if (status !== null) {
    if (status.fix === "ok") return { key: "fix", label, state: "ok", detail: "取れています。" };
    // **走り出した直後をいきなり赤にしない。**GNSS の初回の測位は数十秒かかることがあり、
    // **人がスマホを固定するその瞬間に赤が出る**——**最初に見る赤が偽物**だと、
    // 本物の赤も読み飛ばされるようになる。**一度でも取れたあとの `nofix` は本物**
    // なので、そちらは赤のままにする。
    if (status.lastFixAt === null) {
      return { key: "fix", label, state: "checking", detail: "最初の測位を待っています…" };
    }
    return {
      key: "fix",
      label,
      state: "ng",
      detail: "測位が取れていません。空の見える場所へ出てください（中継も検知も止まります）。",
    };
  }
  if (locationChecking) {
    return { key: "fix", label, state: "checking", detail: "位置情報の権限を確かめています…" };
  }
  if (locationReason !== null) {
    return { key: "fix", label, state: "ng", detail: locationReason };
  }
  return {
    key: "fix",
    label,
    state: "ok",
    // **緑の意味を書く。**走行前に確かめられるのは権限までで、実際の測位は走り出してから。
    detail: "位置情報の権限は下りています（実際の測位は走り始めてから出ます）。",
  };
}

function signs({ signsMeta }: PreRideInput): PreRideCheck {
  const label = "標識";
  // **「持っていない」と「0 件」を混ぜない**（`docs/interfaces/stop-signs-delivery.md`）。直し方が違う。
  if (signsMeta === null) {
    return {
      key: "signs",
      label,
      state: "ng",
      detail: "一時停止の標識を持っていません（docs/setup.md の手順で同梱物を作ってください）。",
    };
  }
  if (signsMeta.count === 0) {
    return {
      key: "signs",
      label,
      state: "ng",
      detail: "一時停止の標識が 0 件です。同梱物を作り直してください。",
    };
  }
  return {
    key: "signs",
    label,
    state: "ok",
    detail: `${signsMeta.count} 件（版 ${signsMeta.version}）。`,
  };
}

function server({
  status,
  serverReason,
  serverChecking,
  relayBlockedReason,
}: PreRideInput): PreRideCheck {
  const label = "サーバー";
  // **疎通より先に見る。**塞がれていれば、届くかどうかは意味を持たない。
  if (relayBlockedReason !== null) {
    return { key: "server", label, state: "ng", detail: relayBlockedReason };
  }
  // 走行中は中継の実測を見る。**走行前の疎通確認より確かで、余計な往復も足さない。**
  if (status !== null) {
    if (status.postFailures >= POST_FAILURE_ALERT) {
      return {
        key: "server",
        label,
        state: "ng",
        detail: `中継が ${status.postFailures} 回続けて失敗しています（周りの自転車を使う検知は止まっています）。`,
      };
    }
    return {
      key: "server",
      label,
      state: "ok",
      detail: status.lastPostOkAt === null ? "中継を始めています…" : "中継が届いています。",
    };
  }

  // 走行前。中継はまだ1通も飛んでいないので、**届くかどうかだけを確かめる。**
  if (serverChecking) {
    return { key: "server", label, state: "checking", detail: "サーバーに届くか確かめています…" };
  }
  if (serverReason !== null) {
    return {
      key: "server",
      label,
      state: "ng",
      // **届かないと何が黙るかまで書く。**「サーバー: ×」だけでは、
      // 走ってはいけない理由が伝わらない。
      detail: `${serverReason}（電波を確かめてください。届かない間、周りの自転車を使う検知は動きません）`,
    };
  }
  return { key: "server", label, state: "ok", detail: "サーバーに届いています。" };
}
