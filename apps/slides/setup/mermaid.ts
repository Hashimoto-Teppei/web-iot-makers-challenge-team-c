import { defineMermaidSetup } from "@slidev/types";

// Mermaid の既定の見た目（黄色い箱・紫の枠）はスライドから浮くので、色だけ揃える。
// 図の色はここ1箇所。style.css の --slidev-theme-primary と同じ値にしてある。
export default defineMermaidSetup(() => ({
  theme: "base",
  themeVariables: {
    primaryColor: "#f0fdfa",
    primaryBorderColor: "#0d9488",
    primaryTextColor: "#134e4a",
    lineColor: "#64748b",
    secondaryColor: "#f8fafc",
    tertiaryColor: "#ffffff",
    // 実際のフォントを書く。inherit にすると mermaid が文字の幅を測れず、箱から文字がはみ出す。
    fontFamily:
      '-apple-system, "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", "Noto Sans JP", Meiryo, sans-serif',
    fontSize: "14px",
  },
}));
