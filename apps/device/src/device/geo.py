"""緯度経度の計算。

センサーにも通信にも依存しない純粋な関数だけを置く。
そのため実機がなくてもテストできる。
"""

from math import asin, cos, radians, sin, sqrt

# 地球の半径（メートル）。岡山県内の距離であれば球体近似で十分な精度が出る。
EARTH_RADIUS_M = 6_371_000.0


def distance_m(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    """2地点間の距離をメートルで返す（ハーバサイン公式）。

    Args:
        lat1: 1点目の緯度（度）
        lon1: 1点目の経度（度）
        lat2: 2点目の緯度（度）
        lon2: 2点目の経度（度）

    Returns:
        2地点間の距離（メートル）
    """
    lat1_rad, lat2_rad = radians(lat1), radians(lat2)
    delta_lat = radians(lat2 - lat1)
    delta_lon = radians(lon2 - lon1)

    a = sin(delta_lat / 2) ** 2 + cos(lat1_rad) * cos(lat2_rad) * sin(delta_lon / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(a))
