<script setup lang="ts">
// 全体像の図。Mermaid ではなく HTML と UnoCSS で組んでいる（見た目を細かく決められるため）。
// 箱を足す・消すときは下の tech / plain を編集する。並びはそのまま左から右になる。
//
// **同じ絵を2種類の語彙で出す。** 抽象版（abstract）はサービス名も製品名も出さず、
// 「何をする係か」だけを言う。具体版は技術スタックまで見せる。
// 箱の並びと色は共通なので、後半で具体版を見たときに前半の絵と重なる。
import { computed } from "vue";

const props = defineProps<{
  /** 箱の下に apps/ のどのフォルダにあたるかを出す（リポジトリの歩き方のスライド用） */
  folders?: boolean;
  /** 箱の中身と「ほかの自転車」を伏せる。発表で先に3つの箱だけを見せるとき用 */
  simple?: boolean;
  /** 製品名を出さない言い方に差し替える。全体像を先に掴んでもらうとき用 */
  abstract?: boolean;
}>();

const tech = {
  nodes: [
    {
      icon: "i-tabler-bike",
      layer: "device",
      title: "自転車デバイス",
      subtitle: "Raspberry Pi Zero W",
      items: ["後方センサー", "LCD と LED ×2"],
      folder: "apps/device",
    },
    {
      icon: "i-tabler-device-mobile",
      layer: "mobile",
      title: "スマホアプリ",
      subtitle: "Expo / ハンドルに固定",
      items: ["測位（GNSS）", "危険の検知 ×4"],
      folder: "apps/mobile",
    },
    {
      icon: "i-tabler-cloud",
      layer: "cloud",
      title: "Cloudflare Worker",
      subtitle: "画面と API",
      items: ["近くにいる自転車", "走行ログと集計"],
      folder: "apps/web",
    },
  ],
  // 箱と箱のあいだ。nodes より1つ少ない。
  links: [
    { label: "BLE", detail: "表示指示と心拍" },
    { label: "HTTPS", detail: "位置" },
  ],
};

const plain = {
  nodes: [
    {
      icon: "i-tabler-bike",
      layer: "device",
      title: "自転車の上の装置",
      subtitle: "知らせる係",
      items: ["後ろを見る", "光らせる・表示する"],
      folder: "apps/device",
    },
    {
      icon: "i-tabler-device-mobile",
      layer: "mobile",
      title: "手元のスマホ",
      subtitle: "考える係",
      items: ["自分がどこにいるか", "危ないかを決める"],
      folder: "apps/mobile",
    },
    {
      icon: "i-tabler-cloud",
      layer: "cloud",
      title: "インターネットの向こう側",
      subtitle: "つなぐ係・覚える係",
      items: ["いま近くにいる自転車", "走った記録"],
      folder: "apps/web",
    },
  ],
  links: [
    { label: "短い距離の無線", detail: "どう光るか・生きているか" },
    { label: "インターネット", detail: "いまの位置" },
  ],
};

// props と同じ名前の変数を置くと、テンプレートでどちらを見ているか分からなくなる（Biome が止める）。
const view = computed(() => (props.abstract ? plain : tech));
</script>

<template>
  <div class="flex items-stretch justify-center gap-1">
    <template v-for="(node, i) in view.nodes" :key="node.title">
      <div
        v-if="i > 0"
        class="flex w-24 shrink-0 flex-col items-center justify-center self-center pb-6 text-center"
      >
        <div class="text-xs font-bold leading-tight">{{ view.links[i - 1].label }}</div>
        <div class="text-[0.6rem] leading-tight opacity-60">{{ view.links[i - 1].detail }}</div>
        <div class="mt-1 flex w-full items-center opacity-50">
          <div class="i-tabler-chevron-left -mr-1 text-sm" />
          <div class="h-px flex-1 bg-current" />
          <div class="i-tabler-chevron-right -ml-1 text-sm" />
        </div>
      </div>

      <!-- 抽象版はタイトルが長いので少しだけ広げる。w-40 のままだと「インターネットの向こう側」が3行に割れる。
           w-48 まで広げると図全体がスライドの幅（980px 相当）を超えて左右が切れるので、ここが上限。 -->
      <div class="shrink-0" :class="abstract ? 'w-44' : 'w-40'">
        <!-- 上辺の色がその箱の層を表す。色の対応はデッキ全体で同じ（style.css の --layer-*） -->
        <div
          class="h-full overflow-hidden rounded-xl border border-gray-400/30 bg-gray-50/60"
          :style="`border-top: 3px solid var(--layer-${node.layer})`"
        >
          <div class="p-3">
            <div class="flex items-center gap-2">
              <div :class="node.icon" class="text-2xl" :style="`color: var(--layer-${node.layer})`" />
              <div class="text-sm font-bold leading-tight">{{ node.title }}</div>
            </div>
            <div class="mt-1 text-[0.6rem] leading-tight opacity-50">{{ node.subtitle }}</div>
            <div v-if="!simple" class="mt-3 space-y-1">
              <div
                v-for="item in node.items"
                :key="item"
                class="rounded-md bg-white px-2 py-1 text-xs"
              >
                {{ item }}
              </div>
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
