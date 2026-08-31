# コンポーネント間インターフェース

コンポーネントごとに担当が分かれるため、**境界の仕様を先に決める**。ここが暗黙のまま並行実装が進むと破綻する。
変更したら影響を受ける担当に伝わる形（PR の説明）で行うこと。

**このファイルには決まったことだけを書く。** 何を決める必要があるかは Issue で管理する
（`type:design` ラベル）。決まっていない論点をここにチェックリストで置くと、Issue と二重管理になり必ずずれる。

| 境界 | 状態 | 決めるための Issue |
| --- | --- | --- |
| [デバイス ⇄ モバイル（BLE GATT）](./interfaces/ble-gatt.md) | 決定済み（#5 / #6）。**`uplink` を `alert` に置き換え、`proto` を 2 に上げた**（`adr/0006`）。`config` の中身のみ未確定 | [#33](https://github.com/Hashimoto-Teppei/web-iot-makers-challenge-team-c/issues/33) |
| [車車間の位置共有](./interfaces/v2v.md) | 決定済み（#6 / #7）。**位置は BLE を通らなくなった**（`adr/0006`） | — |
| [モバイル ⇄ API](./interfaces/mobile-api.md) | **決定済み。** 走行中の中継（#7）に加え、**一時停止の標識を配る経路も決まった**（#63。端末側の置き方は `adr/0009`） | — |
| [蓄積したデータの見せ方](./interfaces/web-service.md) | **集計・画面・取り込み・テーブルは決定済み**（生ログを残す判断は `adr/0007`）。**標識を配る経路は #63 で決まった**（`mobile-api.md`）。しきい値の既定値が未確定 | [#7](https://github.com/Hashimoto-Teppei/web-iot-makers-challenge-team-c/issues/7) |
| [危険検知アルゴリズム](./interfaces/detectors.md) | **決定済み（#8）。** `kind` の識別子と `lv` の意味もここが正本 | — |

**このファイルは境界の一覧で、中身は `interfaces/` に分けてある。**
分ける基準は「1ファイルが 400 行を超えたら」（`CLAUDE.md`）だが、
**ドキュメントは再統合のコストがほぼゼロなので、決まった境界は早めに切り出す。**

**`interfaces/` の中では、切り出す単位になる節を `##` で書く。**
`###` から始めると 400 行の基準が**切り出す先を見つけられず、いつまでも発火しない。**
（`ble-gatt.md` が実際にそうなっていたので、`##` に上げてから分割した。）

| ファイル | 中身 |
| --- | --- |
| [`interfaces/ble-gatt.md`](./interfaces/ble-gatt.md) | デバイス ⇄ モバイルの GATT 仕様。UUID・接続手順・Characteristic の役割・ペアリング |
| [`interfaces/ble-log-transfer.md`](./interfaces/ble-log-transfer.md) | `log` で流すレコードの形と、転送を最後までやりきるための約束 |
| [`interfaces/v2v.md`](./interfaces/v2v.md) | 車車間で流すメッセージ、送る間隔、受信側の約束、デバイスへ渡すもの、心拍の見せ方 |
| [`interfaces/mobile-api.md`](./interfaces/mobile-api.md) | モバイル ⇄ API の運び方、Worker と Durable Object の約束、受け取ってから警告までの手順 |
| [`interfaces/web-service.md`](./interfaces/web-service.md) | 集計の単位と指標、画面、取り込み、D1 のテーブル、外部データ |
| [`interfaces/detectors.md`](./interfaces/detectors.md) | 検知アルゴリズムの入出力の型、`kind` と `lv`、しきい値の注入、ファイル構成 |
