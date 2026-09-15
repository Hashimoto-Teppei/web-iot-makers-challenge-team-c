<script setup lang="ts">
// 心拍が途切れたとき、何が止まって何が動き続けるかの図。
//
// **SVG ではなく HTML + UnoCSS で組んでいる。** 中身が帯と文字だけで、SVG にする理由が無い。
// SVG の <text> はスライド側の CSS（`font-size: 80px`）と噛み合わず、
// font-size 属性でも <style> でも狙った大きさにならなかった（README「3. 手書き SVG」）。
//
// 途切れる位置は BEFORE 1つ。帯も破線も同じ値から引くので、ずれようがない。
const BEFORE = "45%";

const rows = [
  {
    name: "スマホがやる検知（4つ）",
    layer: "mobile",
    after: "止まる",
    afterAlive: false,
  },
  {
    name: "装置がやる検知（1つ）",
    layer: "device",
    after: "動く（通信にもスマホにも頼っていない）",
    afterAlive: true,
  },
];
</script>

<template>
  <div class="grid grid-cols-[11rem_1fr] items-center gap-x-4 gap-y-2">
    <!-- 1段目: 毎秒の心拍。途切れたあとは薄い点だけ -->
    <div class="text-right text-xs opacity-60">毎秒の心拍</div>
    <!-- 帯と同じ 45% / 残り で割る。ここだけ幅が違うと、心拍が途切れる位置と帯の境目がずれる -->
    <!-- border-current/15 と書かないこと。UnoCSS は currentColor に不透明度を掛けられず、
         ビルド後は border-color:currentColor だけが残って濃い線になる -->
    <div class="flex gap-3 border-b border-black/15 pb-1">
      <div class="flex items-end justify-between" :style="`flex: 0 0 ${BEFORE}`">
        <div
          v-for="i in 12"
          :key="`beat-${i}`"
          class="h-6 w-1 rounded-full"
          style="background: var(--layer-mobile)"
        />
      </div>
      <div class="flex flex-1 items-end justify-between">
        <div v-for="i in 14" :key="`dot-${i}`" class="h-1 w-1 rounded-full bg-current opacity-20" />
      </div>
    </div>

    <!-- 2段目以降: 行ごとに「途切れる前 / 後」の帯 -->
    <template v-for="row in rows" :key="row.name">
      <div class="text-right text-xs font-bold opacity-75">{{ row.name }}</div>
      <div class="flex gap-3">
        <div
          class="rounded-md px-3 py-2 text-xs font-bold"
          :style="`flex: 0 0 ${BEFORE}; color: var(--layer-${row.layer}); background: color-mix(in srgb, var(--layer-${row.layer}) 14%, transparent)`"
        >
          動く
        </div>
        <div
          class="flex-1 rounded-md px-3 py-2 text-xs"
          :class="row.afterAlive ? 'font-bold' : 'opacity-40'"
          :style="
            row.afterAlive
              ? `color: var(--layer-${row.layer}); background: color-mix(in srgb, var(--layer-${row.layer}) 14%, transparent)`
              : 'background: rgba(0,0,0,0.05)'
          "
        >
          {{ row.after }}
        </div>
      </div>
    </template>

    <!-- 途切れた瞬間の目印。帯と同じ BEFORE から引くので位置が合う -->
    <div />
    <div class="relative">
      <div
        class="absolute -top-30 w-0 border-l-2 border-dashed border-red-600"
        :style="`left: calc(${BEFORE} + 0.375rem); height: 7.5rem`"
      />
      <div class="text-xs text-red-600" :style="`margin-left: calc(${BEFORE} + 1rem)`">
        ここでスマホが落ちた / つながりが切れた
      </div>
    </div>
  </div>
</template>
