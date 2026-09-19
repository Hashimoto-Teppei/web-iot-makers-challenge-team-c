<script setup lang="ts">
// デバイスに載っている 16×2 のキャラクタ LCD（LCD1602A）の見た目。
// `onboarding.md` の2枚（「走行中、何が光って何が出るのか」と「画面と光の決まりごと」）で使う。
// **まだ1つのデッキの中だけなので、components/ に置く条件は満たしていない**
// （README「2つ以上のデッキで使う図は components/」）。それでも分けているのは、
// **同じ画面を2枚で見せることが説明の要**であり、片方だけ直ると話が食い違うためである。
//
// 桁がずれると説明そのものが成り立たないので、**1桁を `1ch` の枠に入れて並べている。**
// 等幅フォントに流し込むだけでは足りない——**半角カタカナ（`ｾｯｷﾝ`）は Menlo などの
// 等幅フォントに無く、CJK フォントへ落ちる**ので、字送りがそこだけ変わって桁がずれる。
// `■` や `→` も全角幅で描かれることがある。**枠を並べる形なら、字の幅に関係なく桁は合う。**
// 枠の間に隙間を作らないよう `flex` で並べ、要素の間に空白を置かない。
// **`shrink-0 overflow-hidden` が要る。** flex の項目は既定で `min-width: auto` なので、
// **全角で描かれた1字はその桁を広げ、以降の桁ぜんぶを右へ押す**
// ——桁番号の行は ASCII で動かないので、そこで定規が合わなくなる。
const props = defineProps<{
  line1: string;
  line2: string;
  /** 上に桁番号（0〜15）を出す。どの桁に何が出るかを説明するとき用 */
  ruler?: boolean;
}>();

// 16桁に満たない行は空白で埋める。埋めないと、短い行の背景だけが途中で切れる。
const pad = (s: string) => s.padEnd(16, " ").slice(0, 16);

// 16桁を1マスずつに分ける。**桁番号の行も同じ形で並べる**（別の並べ方にすると、
// 説明したい「どの桁に何が出るか」がそこでずれる）。
const cells = (s: string) => [...pad(s)];
</script>

<template>
  <div class="inline-block rounded-lg p-2.5" style="background: #4f6b3f">
    <!-- 桁番号は本体と同じ字送りで出す。小さくすると桁がずれ、説明の役に立たなくなる -->
    <div v-if="ruler" class="flex px-2 pb-0.5 font-mono text-sm" style="color: #c2d6b4">
      <span
        v-for="(ch, i) in cells('0123456789012345')"
        :key="i"
        class="w-[1ch] shrink-0 overflow-hidden text-center"
        >{{ ch }}</span
      >
    </div>
    <div
      class="rounded px-2 py-1.5 font-mono text-sm leading-relaxed"
      style="background: #8fc47a; color: #16240f"
    >
      <div v-for="(line, row) in [props.line1, props.line2]" :key="row" class="flex">
        <span
          v-for="(ch, i) in cells(line)"
          :key="i"
          class="w-[1ch] shrink-0 overflow-hidden text-center"
          >{{ ch }}</span
        >
      </div>
    </div>
  </div>
</template>
