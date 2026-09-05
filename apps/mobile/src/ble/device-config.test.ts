/**
 * しきい値の上書きの判定（#124）。**実機も BLE も要らない**
 * （`docs/adr/0002-development-lifecycle.md`）。
 */

import { describe, expect, it } from "vitest";
import {
  clampDeviceConfig,
  DEVICE_CONFIG_DEFAULTS,
  DEVICE_CONFIG_RANGES,
  type DeviceConfig,
  deviceConfigOverrides,
  deviceConfigPayload,
  deviceConfigWrite,
  unappliedConfigKeys,
} from "./device-config";

function withOverride(partial: Partial<DeviceConfig>): DeviceConfig {
  return { ...DEVICE_CONFIG_DEFAULTS, ...partial };
}

describe("clampDeviceConfig", () => {
  it("範囲の外は端で止める", () => {
    expect(clampDeviceConfig("hold2", 99_999)).toBe(DEVICE_CONFIG_RANGES.hold2.max);
    expect(clampDeviceConfig("hold2", 0)).toBe(DEVICE_CONFIG_RANGES.hold2.min);
    expect(clampDeviceConfig("beat_to", 1)).toBe(DEVICE_CONFIG_RANGES.beat_to.min);
  });

  it("数でないものは既定へ戻す", () => {
    expect(clampDeviceConfig("hold1", Number.NaN)).toBe(DEVICE_CONFIG_DEFAULTS.hold1);
  });
});

describe("deviceConfigOverrides", () => {
  it("既定のままなら空（書かない）", () => {
    expect(deviceConfigOverrides(DEVICE_CONFIG_DEFAULTS)).toEqual({});
  });

  it("変えたキーだけを出す", () => {
    expect(deviceConfigOverrides(withOverride({ hold2: 5_000 }))).toEqual({ hold2: 5_000 });
  });

  it("電波に流れる名前で出す", () => {
    // **変換表を作らないことの確認。**`beatTo` になっていると、デバイスは
    // 知らないキーとして黙って捨てる（`docs/interfaces/ble-gatt.md`）。
    expect(deviceConfigPayload(deviceConfigOverrides(withOverride({ beat_to: 5 })))).toBe(
      '{"beat_to":5}',
    );
  });
});

describe("unappliedConfigKeys", () => {
  it("cfg に入っていれば効いている", () => {
    expect(unappliedConfigKeys({ hold2: 5_000 }, { hold2: 5_000 })).toEqual([]);
  });

  it("cfg に無ければ効いていない", () => {
    // 範囲外を捨てられた場合がこれ。**Write が成功していても効いていない。**
    expect(unappliedConfigKeys({ hold2: 5_000 }, {})).toEqual(["hold2"]);
  });

  it("違う値が入っていれば効いていない", () => {
    expect(unappliedConfigKeys({ hold2: 5_000 }, { hold2: 4_000 })).toEqual(["hold2"]);
  });

  it("知らないキーが cfg にあっても失敗にしない", () => {
    // デバイスが上書きできる項目を1つ増やしただけで、古いアプリが赤を出さないため。
    expect(unappliedConfigKeys({ hold2: 5_000 }, { hold2: 5_000, rear_cm: 120 })).toEqual([]);
  });
});

describe("deviceConfigWrite", () => {
  it("何も書いていなければ、変えたキーだけ", () => {
    expect(deviceConfigWrite(withOverride({ hold2: 5_000 }), {})).toEqual({ hold2: 5_000 });
  });

  it("既定へ戻したキーは、既定の値を明示して書き直す", () => {
    // **送らないと前の上書きが残る**（`config` は部分更新）。ここを落とすと、
    // 「既定に戻す」を押しても**デバイスは 5000 のまま走る。**
    expect(deviceConfigWrite(DEVICE_CONFIG_DEFAULTS, { hold2: 5_000 })).toEqual({
      hold2: DEVICE_CONFIG_DEFAULTS.hold2,
    });
  });

  it("戻したものと変えたものが混ざっても、両方送る", () => {
    expect(deviceConfigWrite(withOverride({ hold1: 2_000 }), { hold2: 5_000 })).toEqual({
      hold1: 2_000,
      hold2: DEVICE_CONFIG_DEFAULTS.hold2,
    });
  });

  it("一度も書いていなければ、既定のままは空（書かない）", () => {
    expect(deviceConfigWrite(DEVICE_CONFIG_DEFAULTS, {})).toEqual({});
  });
});

describe("unappliedConfigKeys（既定へ戻したとき）", () => {
  it("cfg から消えていれば戻せている", () => {
    // `cfg` に載るのは既定と違うキーだけ。**載っていないことが「戻った」の印。**
    expect(unappliedConfigKeys({ hold2: DEVICE_CONFIG_DEFAULTS.hold2 }, {})).toEqual([]);
  });

  it("cfg に残っていれば戻せていない", () => {
    expect(unappliedConfigKeys({ hold2: DEVICE_CONFIG_DEFAULTS.hold2 }, { hold2: 5_000 })).toEqual([
      "hold2",
    ]);
  });
});
