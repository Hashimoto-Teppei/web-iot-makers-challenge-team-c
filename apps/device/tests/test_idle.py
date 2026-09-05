"""心拍の来ない接続を切る判定（`IdleDisconnect`）のテスト。

**BLE も実機も要らない。** 時刻を引数で渡す作りなので、30 秒待たずに「30 秒経った」を作れる
（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/interfaces/ble-gatt.md`「前提」。
**ここで仕様を決め直さない。**
"""

from device.idle import IdleDisconnect

SECOND = 1000
IDLE_MS = 30 * SECOND


def make_idle() -> IdleDisconnect:
    """テスト用の判定。**秒数は `config.py` から読まない**——
    既定値を実地で変えたときにテストが落ちると、値の調整が怖くなる（`test_link.py` と同じ）。
    """
    return IdleDisconnect(idle_ms=IDLE_MS)


def ask(idle: IdleDisconnect, now_ms: int, *, link: str = "down", state: str = "idle") -> bool:
    """いま切るべきかを訊く。"""
    return idle.should_disconnect(
        link=link,  # pyright: ignore[reportArgumentType]
        transfer_state=state,  # pyright: ignore[reportArgumentType]
        now_ms=now_ms,
    )


def test_つながっていなければ切らない() -> None:
    """**繋がる前から数え始めない。** `link` は繋がる前から `down` である。"""
    idle = make_idle()

    assert ask(idle, 60 * SECOND) is False


def test_心拍が来ないまま時間が過ぎたら切る() -> None:
    """**これがこの仕組みの目的。** 他人がつなぎっぱなしにしても、電源を切らずに戻せる。"""
    idle = make_idle()
    idle.on_connect(0)

    assert ask(idle, 30 * SECOND) is False
    assert ask(idle, 31 * SECOND) is True


def test_心拍が届いている間は切らない() -> None:
    idle = make_idle()
    idle.on_connect(0)

    assert ask(idle, 60 * SECOND, link="up") is False


def test_nofix_では切らない() -> None:
    """**測位が出ていないだけで、心拍そのものは届いている。**

    屋内のデモでは `nofix` が出続けるのが正常なので、ここを切ると
    **会場で持ち主の接続を落とし続ける。**
    """
    idle = make_idle()
    idle.on_connect(0)

    assert ask(idle, 60 * SECOND, link="nofix") is False


def test_心拍が戻れば数え直す() -> None:
    """**一度落ちただけで切らない。** BLE の接続間隔のゆらぎで `down` は普通に起きる。"""
    idle = make_idle()
    idle.on_connect(0)
    ask(idle, 20 * SECOND)

    # 心拍が戻った。
    assert ask(idle, 25 * SECOND, link="up") is False
    # 20 秒ぶんは消えているので、ここではまだ切らない。
    assert ask(idle, 50 * SECOND) is False
    assert ask(idle, 56 * SECOND) is True


def test_転送中は切らない() -> None:
    """**ログの回収を途中で終わらせない**（`ble-gatt.md`「前提」）。"""
    idle = make_idle()
    idle.on_connect(0)

    assert ask(idle, 60 * SECOND, state="sending") is False


def test_転送が終わってから改めて待つ() -> None:
    """**終わった瞬間に切らない。** 取り込みの後始末が飛ぶ。"""
    idle = make_idle()
    idle.on_connect(0)
    ask(idle, 60 * SECOND, state="sending")

    assert ask(idle, 80 * SECOND) is False
    assert ask(idle, 91 * SECOND) is True


def test_切ったあとは数え直す() -> None:
    """**毎秒 `Disconnect()` を投げない。**

    切断が終わるまでの間、周期のたびに D-Bus のメソッドが積み上がる。
    """
    idle = make_idle()
    idle.on_connect(0)
    assert ask(idle, 31 * SECOND) is True

    assert ask(idle, 32 * SECOND) is False
    assert ask(idle, 40 * SECOND) is False


def test_切れなかったらもう一度試す() -> None:
    """**「一度答えたら二度と答えない」にしない。**

    `Disconnect()` が失敗すると相手はつないだまま残るので、
    そこで諦めると**電源を切るしか戻す方法がない状態に戻ってしまう。**
    """
    idle = make_idle()
    idle.on_connect(0)
    assert ask(idle, 31 * SECOND) is True

    # 切れないまま次の窓が過ぎた（`on_disconnect` は来ていない）。
    assert ask(idle, 62 * SECOND) is True


def test_切れたら次につながるまで数えない() -> None:
    idle = make_idle()
    idle.on_connect(0)
    idle.on_disconnect()

    assert ask(idle, 60 * SECOND) is False

    idle.on_connect(60 * SECOND)
    assert ask(idle, 80 * SECOND) is False
    assert ask(idle, 91 * SECOND) is True
