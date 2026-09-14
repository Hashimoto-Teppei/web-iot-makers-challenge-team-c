<script setup lang="ts">
// 心拍が途切れたときに何が起きるかの図。時間の流れなので SVG で描いている。
//
// viewBox はスライドに置いたときの実寸（幅 1100）に合わせてある。
// 小さい viewBox にすると、文字だけが引き伸ばされて他の要素と重なる。
//
// 文字の大きさは font-size 属性ではなく下の <style> で指定している。
// スライド側の CSS（font-size: 80px）が属性に勝ってしまい、属性で書くと効かない。
const total = 20;
const dead = 9;
const x = (i: number) => 60 + i * 50;
</script>

<template>
  <svg viewBox="0 0 1100 250" class="w-full h-auto">
    <line x1="40" y1="130" x2="1060" y2="130" stroke="currentColor" stroke-opacity="0.2" />

    <!-- 1秒ごとの心拍。途切れたあとは薄い点だけ -->
    <template v-for="i in total" :key="i">
      <line
        v-if="i - 1 < dead"
        :x1="x(i - 1)"
        y1="130"
        :x2="x(i - 1)"
        y2="80"
        stroke="var(--slidev-theme-primary)"
        stroke-width="5"
        stroke-linecap="round"
      />
      <circle v-else :cx="x(i - 1)" cy="130" r="3" fill="currentColor" fill-opacity="0.2" />
    </template>

    <!-- 途切れた瞬間 -->
    <line
      :x1="x(dead) - 25"
      y1="55"
      :x2="x(dead) - 25"
      y2="235"
      stroke="#dc2626"
      stroke-width="2"
      stroke-dasharray="6 4"
    />

    <text x="40" y="40" fill="currentColor" fill-opacity="0.75">
      毎秒の心拍が届いている
    </text>
    <text :x="x(dead) - 10" y="40" fill="#dc2626">スマホが落ちた / 圏外</text>

    <text x="40" y="185" fill="currentColor" fill-opacity="0.75">
      車車間の検知：動く
    </text>
    <text :x="x(dead) - 10" y="185" fill="currentColor" fill-opacity="0.75">
      車車間の検知：止まる
    </text>

    <text x="40" y="225" fill="currentColor" fill-opacity="0.75">
      後方物体検知：動く
    </text>
    <text :x="x(dead) - 10" y="225" fill="currentColor" fill-opacity="0.75">
      後方物体検知：動く（通信に依存しない）
    </text>
  </svg>
</template>

<style scoped>
text {
  font-size: 20px;
}
</style>
