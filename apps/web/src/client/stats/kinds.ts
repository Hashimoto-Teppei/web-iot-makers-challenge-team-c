/**
 * 検知の種別（`kind`）を人が読む言葉にする。
 *
 * **値の正本は `docs/interfaces/detectors.md`「検知の種別」。**ここにあるのは表示名だけで、
 * **知らない `kind` はそのまま出す**——**サーバー側でも読み替えていない**ので、
 * **新しい検知が入っても画面から消えない**（消えると、増えたことに誰も気づけない）。
 */
const LABELS: Record<string, string> = {
  approach: "急接近",
  brake: "前方の急ブレーキ",
  corner: "曲がり角の対向車",
  stop: "一時停止が近い",
  rear_object: "後方の物体",
};

export const kindLabel = (kind: string): string => LABELS[kind] ?? kind;
