"""geo.py のテスト。実機もセンサーも使わない。"""

from device.geo import distance_m


def test_同じ地点の距離は0() -> None:
    assert distance_m(34.6551, 133.9195, 34.6551, 133.9195) == 0.0


def test_岡山駅から岡山城までの距離はおよそ1_6km() -> None:
    # 岡山駅（34.6664, 133.9181）と岡山城（34.6653, 133.9361）。実測は約 1650.7m。
    # 幅を広く取ると、赤道半径を使う・緯度差の項を落とすといった間違いを通してしまうため、
    # 前後 10m まで絞る。
    distance = distance_m(34.6664, 133.9181, 34.6653, 133.9361)

    assert 1640 < distance < 1660


def test_距離は向きによらず同じ() -> None:
    forward = distance_m(34.6664, 133.9181, 34.6653, 133.9361)
    backward = distance_m(34.6653, 133.9361, 34.6664, 133.9181)

    assert forward == backward
