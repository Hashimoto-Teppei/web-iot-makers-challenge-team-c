---
theme: default
colorSchema: light
title: 自転車の危険をリアルタイムに知らせるデバイス
info: ハッカソン発表用。持ち時間 7 分（仮）
layout: cover
---

# 自転車の危険をリアルタイムに知らせるデバイス

Web×IoT メイカーズチャレンジ チームC

<div class="opacity-60 mt-8 text-sm">
岡山県の課題を Web×IoT で解決する
</div>

---

# TODO: 課題

岡山 × 自転車。**数字は1つだけ。**出典も添える。

<div class="mt-8 rounded-lg border border-dashed border-gray-400/50 p-8 text-center opacity-50">
ここに大きな数字を1つ
</div>

---

# TODO: 誰の、どんな瞬間か

課題を人の1シーンに落とす。**ここで聴き手を当事者にできるかが、残り6分の効き方を決める。**

<div class="mt-8 rounded-lg border border-dashed border-gray-400/50 p-8 text-center opacity-50">
ここに1シーン（写真か、短い語り）
</div>

---

# 危険に、乗っている人より先に気づく

<ArchitectureDiagram simple />

<div class="mt-10 text-center">
  <div class="text-lg font-bold">判断はスマホ、知らせるのはデバイス。</div>
  <div class="mt-2 text-sm opacity-60">
    走行中にスマホを見る行為は取り締まりの対象。だから警告はハンドルの上で完結させる
  </div>
</div>

---
layout: center
class: text-center
---

# デモ

<div class="opacity-60 text-sm">
約2分。実機・画面切り替え・動画のいずれか。<br/>
動画に差し替えるときは <code>public/demo/</code> に置いて、このスライドに &lt;video&gt; を書く。
</div>

<!--
このスライドは丸ごと抜いてよい。抜いても前後がつながることを、前後のスライドで担保している。
-->

---

# しくみ

<ArchitectureDiagram />

<div class="mt-8 text-sm opacity-70">
スマホどうしが Worker を経由して位置を共有し、<strong>まわりの自転車が見えるようになる。</strong><br/>
BLE でデバイスへ渡すのは<strong>表示指示と心拍だけ</strong>で、位置は流さない。
</div>

---

# 検知するもの

<div class="mt-8 grid grid-cols-3 gap-5">
  <div v-for="g in [
    { head: 'まわりが見えるから分かる', need: '通信が要る',
      items: ['急接近', '前方の急ブレーキ', '曲がり角の対向車'] },
    { head: '自分の位置だけで分かる', need: '通信は要らない',
      items: ['一時停止が近い'] },
    { head: 'デバイスだけで分かる', need: 'スマホも要らない',
      items: ['後方の物体'] },
  ]" :key="g.head" class="rounded-xl border border-gray-400/30 p-5">
    <div class="text-sm font-bold leading-tight">{{ g.head }}</div>
    <div class="mt-1 text-xs font-bold" style="color: var(--slidev-theme-primary)">{{ g.need }}</div>
    <div class="mt-4 space-y-2 text-center text-xs">
      <div v-for="d in g.items" :key="d" class="rounded-lg bg-gray-100 px-2 py-3">{{ d }}</div>
    </div>
  </div>
</div>

<div class="mt-8 text-sm opacity-70">
<strong>右へ行くほど、頼っているものが減る。</strong>
通信が前提の機能だけで組むと、<strong>圏外に入った瞬間にただの飾りになる。</strong>
</div>

---

# 作るうえで効いた2つの判断

<div class="mt-8 space-y-4">
  <div class="rounded-xl border border-gray-400/30 p-5">
    <div class="flex items-center gap-2 font-bold">
      <div class="i-tabler-bulb text-xl" style="color: var(--slidev-theme-primary)" />
      判断をスマホに寄せた
    </div>
    <div class="mt-2 text-sm opacity-75">
      デバイスに GPS を載せず、測位はスマホがやる。<strong>BLE で送れるのは、つながり1回につき1通だけ。</strong>
      まわりの自転車を毎秒ぜんぶ流すとその1通を使い切り、肝心の警告が送れなくなる。
      デバイスは警告を出すことに徹する
    </div>
  </div>
  <div class="rounded-xl border border-gray-400/30 p-5">
    <div class="flex items-center gap-2 font-bold">
      <div class="i-tabler-heartbeat text-xl" style="color: var(--slidev-theme-primary)" />
      止まったことに気づける形にした
    </div>
    <div class="mt-2 text-sm opacity-75">
      スマホは毎秒の心拍を送り、<strong>途切れたらデバイスが自分でそれを表示し続ける。</strong>
      黙って止まる故障は、動いているつもりに化ける
    </div>
  </div>
</div>

---

# 走ったぶんが、地図として残る

<div class="mt-8 flex items-center justify-center gap-2 text-center text-sm">
  <div v-for="(s, i) in [
    { icon: 'i-tabler-bike', title: '走る', note: '測位の点をそのまま残す' },
    { icon: 'i-tabler-database', title: '溜める', note: 'Worker の D1 へ' },
    { icon: 'i-tabler-chart-bar', title: '数える', note: '件数ではなく率で' },
    { icon: 'i-tabler-map-pin', title: '地図にする', note: 'どこが危ないか' },
  ]" :key="s.title" class="contents">
    <div v-if="i > 0" class="i-tabler-chevron-right text-xl opacity-30" />
    <div class="w-40 rounded-xl border border-gray-400/30 p-4">
      <div :class="s.icon" class="mx-auto text-3xl" style="color: var(--slidev-theme-primary)" />
      <div class="mt-2 font-bold">{{ s.title }}</div>
      <div class="mt-1 text-xs opacity-60">{{ s.note }}</div>
    </div>
  </div>
</div>

<div class="mt-8 text-sm opacity-70">
一時停止の標識は公開データから取り込み、走行ログと突き合わせて<strong>従わなかったことを後から計算する。</strong><br/>
走行中の検知と違い<strong>何度でも計算し直せる</strong>ので、実データを見ながらしきい値を詰められる。
</div>

---

# TODO: 今後

実機での検証と、データが溜まったあとにできること。**2つまで。**

---
layout: center
class: text-center
---

# TODO: まとめ

一番伝えたいこと1行に戻る。
