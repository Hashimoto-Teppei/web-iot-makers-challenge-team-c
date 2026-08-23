import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/api";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 画面と API は同じ Worker（＝同じオリジン）にあるので、相対パスで呼べる。
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>Web×IoT メイカーズチャレンジ チームC</h1>
      <p>自転車の事故と違反を未然に防ぐ。</p>
      <h2>API の疎通確認</h2>
      {error && <p>エラー: {error}</p>}
      {health ? <p>{`${health.status} / ${health.timestamp}`}</p> : <p>確認中…</p>}
    </main>
  );
}
