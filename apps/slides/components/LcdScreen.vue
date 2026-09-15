<script setup lang="ts">
// デバイスに載っている 16×2 のキャラクタ LCD（LCD1602A）の見た目。
// `onboarding.md` の2枚（「走行中、何が光って何が出るのか」と「画面と光の決まりごと」）で使う。
// **まだ1つのデッキの中だけなので、components/ に置く条件は満たしていない**
// （README「2つ以上のデッキで使う図は components/」）。それでも分けているのは、
// **同じ画面を2枚で見せることが説明の要**であり、片方だけ直ると話が食い違うためである。
//
// 桁がずれると説明そのものが成り立たないので、等幅フォントに `whitespace-pre` を掛けて
// 空白をそのまま出している。1文字ずつ <div> に分けて並べる形にしない——
// 文字間が空いて、16桁が「16文字ぶんの幅」に見えなくなる。
const props = defineProps<{
  line1: string;
  line2: string;
  /** 上に桁番号（0〜15）を出す。どの桁に何が出るかを説明するとき用 */
  ruler?: boolean;
}>();

// 16桁に満たない行は空白で埋める。埋めないと、短い行の背景だけが途中で切れる。
const pad = (s: string) => s.padEnd(16, " ").slice(0, 16);
</script>

<template>
  <div class="inline-block rounded-lg p-2.5" style="background: #4f6b3f">
    <!-- 桁番号は本体と同じ字送りで出す。小さくすると桁がずれ、説明の役に立たなくなる -->
    <div v-if="ruler" class="px-2 pb-0.5 font-mono text-sm whitespace-pre" style="color: #c2d6b4">
      0123456789012345
    </div>
    <div
      class="rounded px-2 py-1.5 font-mono text-sm leading-relaxed whitespace-pre"
      style="background: #8fc47a; color: #16240f"
    >
      <div>{{ pad(props.line1) }}</div>
      <div>{{ pad(props.line2) }}</div>
    </div>
  </div>
</template>
