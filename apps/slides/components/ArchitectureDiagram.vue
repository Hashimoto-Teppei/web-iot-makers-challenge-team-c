<script setup lang="ts">
// 全体像の図。Mermaid ではなく HTML と UnoCSS で組んでいる（見た目を細かく決められるため）。
// 箱を足す・消すときは下の nodes を編集する。並びはそのまま左から右になる。

defineProps<{
  /** 箱の下に apps/ のどのフォルダにあたるかを出す（リポジトリの歩き方のスライド用） */
  folders?: boolean;
  /** 箱の中身と「ほかの自転車」を伏せる。発表で先に3つの箱だけを見せるとき用 */
  simple?: boolean;
}>();

const nodes = [
  {
    icon: "i-tabler-bike",
    title: "自転車デバイス",
    subtitle: "Raspberry Pi Zero W",
    items: ["後方センサー", "LCD と LED ×2"],
    folder: "apps/device",
  },
  {
    icon: "i-tabler-device-mobile",
    title: "スマホアプリ",
    subtitle: "ハンドルに固定",
    items: ["測位（GNSS）", "危険の検知 ×4"],
    folder: "apps/mobile",
  },
  {
    icon: "i-tabler-cloud",
    title: "Cloudflare Worker",
    subtitle: "画面と API",
    items: ["近くにいる自転車", "走行ログと集計"],
    folder: "apps/web",
  },
];

// 箱と箱のあいだ。nodes より1つ少ない。
const links = [
  { label: "BLE", detail: "表示指示と心拍" },
  { label: "HTTPS", detail: "位置" },
];
</script>

<template>
  <div class="flex items-stretch justify-center gap-1">
    <template v-for="(node, i) in nodes" :key="node.title">
      <div
        v-if="i > 0"
        class="flex w-24 shrink-0 flex-col items-center justify-center self-center pb-6 text-center"
      >
        <div class="text-xs font-bold">{{ links[i - 1].label }}</div>
        <div class="text-[0.6rem] leading-tight opacity-60">{{ links[i - 1].detail }}</div>
        <div class="mt-1 flex w-full items-center opacity-50">
          <div class="i-tabler-chevron-left -mr-1 text-sm" />
          <div class="h-px flex-1 bg-current" />
          <div class="i-tabler-chevron-right -ml-1 text-sm" />
        </div>
      </div>

      <div class="w-40 shrink-0">
        <div
          class="h-full rounded-xl border border-gray-400/30 bg-gray-50/60 p-3 dark:bg-gray-800/40"
        >
          <div class="flex items-center gap-2">
            <div :class="node.icon" class="text-2xl" style="color: var(--slidev-theme-primary)" />
            <div class="text-sm font-bold leading-tight">{{ node.title }}</div>
          </div>
          <div class="mt-1 text-[0.6rem] leading-tight opacity-50">{{ node.subtitle }}</div>
          <div v-if="!simple" class="mt-3 space-y-1">
            <div
              v-for="item in node.items"
              :key="item"
              class="rounded-md bg-white px-2 py-1 text-xs dark:bg-gray-900/60"
            >
              {{ item }}
            </div>
          </div>
        </div>
        <div v-if="folders" class="mt-2 text-center font-mono text-xs opacity-70">
          {{ node.folder }}
        </div>
      </div>
    </template>

    <div v-if="!simple" class="flex w-14 shrink-0 items-center self-center pb-6 opacity-50">
      <div class="i-tabler-chevron-left -mr-1 text-sm" />
      <div class="h-px flex-1 bg-current" />
      <div class="i-tabler-chevron-right -ml-1 text-sm" />
    </div>
    <div v-if="!simple" class="w-24 shrink-0 self-center pb-6 text-center">
      <div class="i-tabler-bike mx-auto text-2xl opacity-40" />
      <div class="mt-1 text-xs opacity-60">ほかの自転車の<br />スマホ</div>
    </div>
  </div>
</template>
