"""開発機を BLE セントラルにして、ラズパイの GATT を手で叩く。

**屋内では警告が一度も出ない。** モバイルアプリは**自車の測位が無いと検知を1つも呼ばない**
（`apps/mobile/src/ride/loop.ts`）ので、机の上では `link` が `nofix` のまま何も起きない。
**LCD の上段と警告 LED が本当に動くことを確かめる手段がこれ**である
（`../../../docs/unverified.md` 49 が言う「nRF Connect でも1通書いてみる」の自動版）。

`tools/mock_peripheral.py` とは**向きが逆**——あちらは開発機をラズパイのふりにする。
こちらは**開発機をスマホのふり**にして、**本物のラズパイ**に書き込む。

**セントラルは1台しか繋がらない。** スマホのアプリが繋いでいると2台目は切られるので
（#184）、**先にアプリを終了させること。**

    uv run --group mock python tools/poke_device.py scan        # アドバタイズを見る
    uv run --group mock python tools/poke_device.py warn        # 警告を1通（LED を見る用）
    uv run --group mock python tools/poke_device.py warn corner 3
    uv run --group mock python tools/poke_device.py all         # 端から全部
"""

import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

# UUID の正本は `../../../docs/interfaces/ble-gatt.md`。枝番だけが違う。
_BASE = "68666e0{}-58cc-4540-90ad-18bfae31615f"
SERVICE, INFO, CONTROL, LOG, STATUS, CONFIG, ALERT = (_BASE.format(i) for i in range(7))

# **`beat` を止めない。** 既定のタイムアウトは 3 秒で、止めると `link` が `down` に落ちて
# 警告より先にそちらが表示を取る（`../src/device/alert.py`）。
BEAT_INTERVAL_S = 1.0


def _j(body: dict) -> bytes:
    return json.dumps(body, separators=(",", ":")).encode()


async def _beat(client: BleakClient) -> None:
    await client.write_gatt_char(
        ALERT,
        _j({"k": "beat", "t": int(time.time() * 1000), "st": "ok", "mv": False}),
        response=True,
    )


async def _status(client: BleakClient, label: str) -> bytes:
    raw = await client.read_gatt_char(STATUS)
    print(f"  [{label}] status {len(raw)} バイト: {raw.decode()}")
    return raw


async def _find():
    device = await BleakScanner.find_device_by_filter(
        lambda _d, ad: SERVICE.lower() in [u.lower() for u in ad.service_uuids],
        timeout=20.0,
    )
    if device is None:
        sys.exit(
            "見つからない。**アプリが繋ぎっぱなしだと2台目は切られる**ので、先に終了させること"
        )
    return device


async def cmd_scan() -> None:
    """アドバタイズの中身を見る（`../../../docs/unverified.md` 12）。"""
    found: dict = {}

    def seen(device, ad) -> None:
        if SERVICE.lower() in [u.lower() for u in ad.service_uuids]:
            found[device.address] = ad

    async with BleakScanner(seen):
        await asyncio.sleep(12.0)
    if not found:
        sys.exit("アドバタイズが見つからない")
    for ad in found.values():
        name = ad.local_name or ""
        # **切り詰められていないことは長さで見る。**`bg-` + 4 桁で 7 文字。
        print(f"local_name = {name!r}（{len(name)} 文字）")
        print(f"service_uuids = {ad.service_uuids}")
        print(f"見積もり: Flags 3 + UUID 18 + 名前 {2 + len(name)} = {23 + len(name)} バイト")


async def cmd_warn(kind: str, level: int) -> None:
    """警告を1通書いて、10 秒そのままにする。**その間に LED と LCD を見る。**"""
    device = await _find()
    async with BleakClient(device, timeout=30.0) as client:
        print(f"接続した: {device.name}")
        for _ in range(3):
            await _beat(client)
            await asyncio.sleep(BEAT_INTERVAL_S)
        await client.write_gatt_char(
            ALERT, _j({"k": "warn", "kind": kind, "lv": level}), response=True
        )
        print(f"warn kind={kind} lv={level} を書いた —— **いま LED と LCD を見る**")
        # **保持時間より長く待つ。** `lv 3` でも既定 6 秒なので、消えるところまで見せる。
        for _ in range(10):
            await asyncio.sleep(BEAT_INTERVAL_S)
            await _beat(client)
        await _status(client, "10 秒後")


async def cmd_all() -> None:
    """端から全部（49 / 44 / #124 / #40 / 108）。"""
    device = await _find()
    chunks: list[bytes] = []
    async with BleakClient(device, timeout=30.0) as client:
        print(f"接続した: {device.name} / mtu={getattr(client, 'mtu_size', '?')}")

        info = await client.read_gatt_char(INFO)
        print(f"\n[44] device-info {len(info)} バイト: {info.decode()}")

        await client.start_notify(STATUS, lambda _c, _d: None)
        await client.start_notify(LOG, lambda _c, data: chunks.append(bytes(data)))

        print("\n=== 心拍（#35） ===")
        for _ in range(3):
            await _beat(client)
            await asyncio.sleep(BEAT_INTERVAL_S)
        await _status(client, "beat x3")

        print("\n=== 警告（49 / #151） ===")
        for kind, level in (("stop", 1), ("approach", 2), ("corner", 3)):
            await client.write_gatt_char(
                ALERT, _j({"k": "warn", "kind": kind, "lv": level}), response=True
            )
            print(f"  warn kind={kind} lv={level}")
            await asyncio.sleep(1.5)
            await _beat(client)
        await _status(client, "warn 3件のあと")

        print("\n=== config（#124） ===")
        # **最長の `status` を作る**——4キーとも採用させてから、4キーとも断らせる（44）。
        for label, body in (
            ("4キー採用", {"hold1": 2000, "hold2": 5000, "hold3": 7000, "beat_to": 4}),
            (
                "★最長（4つ埋まり＋4つ断り）",
                {"hold1": 99999, "hold2": 99999, "hold3": 99999, "beat_to": 99999},
            ),
            ("知らないキーを混ぜる", {"hold2": 6000, "nope": 1}),
        ):
            await client.write_gatt_char(CONFIG, _j(body), response=True)
            await asyncio.sleep(0.8)
            await _beat(client)
            await _status(client, label)

        print("\n=== 検知ログ（#40 / 108） ===")
        await client.write_gatt_char(CONTROL, _j({"cmd": "read", "since": 0}), response=True)
        for _ in range(16):
            await asyncio.sleep(0.5)
            await _beat(client)
            if chunks and chunks[-1].endswith(b"\x04"):
                break
        print(f"  塊 {len(chunks)} 個 / 合計 {sum(len(c) for c in chunks)} バイト")
        for i, chunk in enumerate(chunks[:3]):
            print(f"    {i}: {chunk[:120]!r}")
        await _status(client, "転送のあと")

    print("\n切って、繋ぎ直す（`cfg` が {} に戻るか。#124）")
    await asyncio.sleep(6.0)
    device = await _find()
    async with BleakClient(device, timeout=30.0) as client:
        await _beat(client)
        await asyncio.sleep(0.5)
        await _status(client, "再接続の直後")


def main() -> None:
    argv = sys.argv[1:] or ["all"]
    command = argv[0]
    if command == "scan":
        asyncio.run(cmd_scan())
    elif command == "warn":
        kind = argv[1] if len(argv) > 1 else "approach"
        level = int(argv[2]) if len(argv) > 2 else 2
        asyncio.run(cmd_warn(kind, level))
    elif command == "all":
        asyncio.run(cmd_all())
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
