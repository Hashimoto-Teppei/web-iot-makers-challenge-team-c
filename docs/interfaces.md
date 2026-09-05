# コンポーネント間インターフェース

コンポーネントごとに担当が分かれるため、**境界の仕様を先に決める**。ここが暗黙のまま並行実装が進むと破綻する。
変更したら影響を受ける担当に伝わる形（PR の説明）で行うこと。

**このファイルには決まったことだけを書く。** 何を決める必要があるかは Issue で管理する
（`type:design` ラベル）。決まっていない論点をここにチェックリストで置くと、Issue と二重管理になり必ずずれる。

| 境界 | 状態 | 決めるための Issue |
| --- | --- | --- |
| [デバイス ⇄ モバイル（BLE GATT）](./interfaces/ble-gatt.md) | 決定済み（#5 / #6）。**`uplink` を `alert` に置き換え、`proto` を 2 に上げた**（`adr/0006`）。**`config` も決定済み**（#33。接続の間だけ効く上書き。ペアリングは戻さない） | — |
| [車車間の位置共有](./interfaces/v2v.md) | 決定済み（#6 / #7）。**位置は BLE を通らなくなった**（`adr/0006`） | — |
| [モバイル ⇄ API](./interfaces/mobile-api.md) | **決定済み。** 走行中の中継（#7）。**一時停止の標識を配る経路も決定済みで、[別ファイル](./interfaces/stop-signs-delivery.md)に分けた**（#63。端末側の置き方は `adr/0009`） | — |
| [受け取り方と持ち方](./interfaces/web-service.md)・[数え方](./interfaces/web-stats.md)・[画面](./interfaces/web-ui.md) | **決定済み（#7）。** 集計・取り込み・テーブル・端末の識別・再計算の経路・画面が決まった（生ログを残す判断は `adr/0007`）。**しきい値の既定値は暫定**（`unverified.md` 64・65）で、**設定として外に出してある** | — |
| [危険検知アルゴリズム](./interfaces/detectors.md) | **決定済み（#8）。** `kind` の識別子と `lv` の意味もここが正本 | — |

**このファイルは境界の一覧で、中身は `interfaces/` に分けてある。**
分ける基準は「1ファイルが 400 行に達したら判断する」（`CLAUDE.md`）だが、
**ドキュメントは再統合のコストがほぼゼロなので、決まった境界は早めに切り出す。**

**`interfaces/` の中では、切り出す単位になる節を `##` で書く。**
`###` から始めると 400 行の基準が**切り出す先を見つけられず、いつまでも発火しない。**
（`ble-gatt.md` が実際にそうなっていたので、`##` に上げてから分割した。）

| ファイル | 中身 |
| --- | --- |
| [`interfaces/ble-gatt.md`](./interfaces/ble-gatt.md) | デバイス ⇄ モバイルの GATT 仕様。UUID・接続手順・Characteristic の役割（`config` を含む） |
| [`interfaces/ble-security.md`](./interfaces/ble-security.md) | 誰が読み書きできるか。ペアリングを戻さない判断、割り切っていること、運用で気をつけること |
| [`interfaces/ble-log-transfer.md`](./interfaces/ble-log-transfer.md) | `log` で流すレコードの形と、転送を最後までやりきるための約束 |
| [`interfaces/v2v.md`](./interfaces/v2v.md) | 車車間で流すメッセージ、送る間隔、受信側の約束、デバイスへ渡すもの、心拍の見せ方 |
| [`interfaces/mobile-api.md`](./interfaces/mobile-api.md) | モバイル ⇄ API の運び方、Worker と Durable Object の約束、受け取ってから警告までの手順、失敗したときの約束、走行後の同期 |
| [`interfaces/stop-signs-delivery.md`](./interfaces/stop-signs-delivery.md) | 一時停止の標識をスマホに配る経路（`GET /api/stop-signs`）、県の選び方、版の決め方 |
| [`interfaces/web-service.md`](./interfaces/web-service.md) | 言葉の定義、取り込み（`POST /api/logs`）、D1 のテーブル、割り切っていること |
| [`interfaces/web-stats.md`](./interfaces/web-stats.md) | 集計の単位と指標、検知を場所に結びつける規則、不停止の判定と再計算の経路、しきい値の既定値 |
| [`interfaces/stop-signs-source.md`](./interfaces/stop-signs-source.md) | 一時停止の標識の出どころ（JARTIC）、原本の置き場所、取り込む列と捨てた列 |
| [`interfaces/web-ui.md`](./interfaces/web-ui.md) | 走行後の画面、地図の描き方、場所の示し方、地図の鍵 |
| [`interfaces/detectors.md`](./interfaces/detectors.md) | 検知アルゴリズムの入出力の型、`kind` と `lv`、しきい値の注入、ファイル構成 |
