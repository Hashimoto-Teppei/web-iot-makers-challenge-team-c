import { Stack } from "expo-router";
import { SQLiteProvider } from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import { SIGNS_DATABASE_NAME, signsAssetSource } from "@/signs/expo";

export default function RootLayout() {
  return (
    <>
      {/*
        同梱した一時停止の標識（`assets/signs.db`）を開く。**アプリはこの DB に書かない。**
        走行ログを入れる `app.db` は別のファイルで、**こちらの Provider の下に置かない**
        ——入れ子にすると `useSQLiteContext()` が内側だけを返し、標識を読んでいるつもりで
        走行ログを引く。そちらは `src/log/expo.ts` が名前で直接開く（#73）。
        ファイルを分けるのは、1つにまとめると標識の更新で走行ログが消えるため
        （`docs/adr/0009-on-device-storage.md`）。

        **中身がそろうまで子は描画されない**ので、画面側は「まだ開いていない」を
        考えなくてよい。**開けなかったときは例外が投げられる**——静かに標識ゼロで
        動き出すより、その方がよい（`docs/unverified.md` 60）。

        **その代わり、最初の一瞬は Stack ごと描画されない。**プッシュ通知やディープリンクで
        **起動直後にコードから画面を移動させると落ちる**（expo-router が「Root Layout が
        まだ載っていない」と言う）。**そういう入口を足すときは、ここを組み替えて
        Stack を外に出すこと。**いまは誰もコードから移動していないので、そのままにしてある。
      */}
      <SQLiteProvider databaseName={SIGNS_DATABASE_NAME} assetSource={signsAssetSource}>
        {/* 画面のヘッダーに出るタイトル。画面を増やすときは各画面側で上書きする。 */}
        <Stack screenOptions={{ title: "チームC" }} />
      </SQLiteProvider>
      <StatusBar style="auto" />
    </>
  );
}
