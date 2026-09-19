/**
 * `AppDelegate.swift` に `SceneDelegate` を足す（iOS の UIScene ライフサイクル）。
 *
 * **Xcode 27（iOS 27 SDK）でビルドすると、これが無いアプリは起動した瞬間に落ちる**
 * —— UIKit が `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` で
 * トラップする（2026-09-20 に実機で踏んだ。`docs/deploy-mobile.md`）。
 *
 * **`Info.plist` の `UIApplicationSceneManifest` だけでは足りない。**
 * 宣言するとシーン方式に入るため、**`AppDelegate` が作った `window` を誰も拾わなくなり、
 * 落ちない代わりに画面が真っ暗になる。**シーンにぶら下がるウィンドウを作る実体が要る。
 * マニフェスト側は `app.json` の `ios.infoPlist` にあり、ここのクラスを名指ししている。
 *
 * **`ios/` は生成物で gitignore 済み**（`docs/adr/0010-ios-primary-target.md`）。
 * `expo prebuild` が `AppDelegate.swift` を作り直すので、**手で直すと次の prebuild で消える。**
 * ここに置くのはそのため。
 *
 * **expo 57 系では直らない。** テンプレート（`expo-template-bare-minimum@57.0.26`）にも
 * `node_modules` にもシーン対応は入っていない。**SDK を上げたら、まずこれが要らなくなったかを見る。**
 */

const { withAppDelegate } = require("expo/config-plugins");

/** 起動の引数を預かるだけにして、ウィンドウ生成をシーンへ移す。 */
const WINDOW_SETUP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const WINDOW_SETUP_REPLACEMENT = `    // **ウィンドウはここで作らない。** UIScene ライフサイクルでは画面は
    // \`UIWindowScene\` にぶら下がり、\`UIScreen.main.bounds\` から作ったウィンドウは
    // どのシーンにも繋がらない——**起動はするが真っ暗になる。**
    // 作るのは \`SceneDelegate\`。ここは起動の引数を預かるだけである。
    self.launchOptions = launchOptions`;

const LAUNCH_OPTIONS_PROPERTY = `  var reactNativeFactory: RCTReactNativeFactory?
  // **シーンが繋がるのは \`didFinishLaunching\` の後**なので、ここで預かって渡す。
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?`;

const SCENE_DELEGATE = `
/// 画面を \`UIWindowScene\` に繋ぐ。**無いと起動直後に落ちる**（このファイルを足した
/// config plugin \`plugins/with-scene-delegate.js\` に理由がある）。
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions)

    self.window = window
    // **\`AppDelegate\` 側にも持たせる。** 空のままだと、
    // \`UIApplicationDelegate.window\` を見るコードから画面が見えなくなる。
    appDelegate.window = window
  }

  // Linking API —— **シーン方式では URL がこちらへ来る。**
  // \`AppDelegate\` の \`application(_:open:options:)\` は呼ばれない。
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  // Universal Links —— 同じ理由でこちらへ来る。
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }
}
`;

/** テンプレートが変わって当て先を見失ったら、**黙って通さずに止める。** */
function replaceOnce(contents, needle, replacement, what) {
  const hits = contents.split(needle).length - 1;
  if (hits !== 1) {
    throw new Error(
      `with-scene-delegate: AppDelegate.swift の「${what}」が ${hits} 箇所ある（1 を期待）。` +
        "テンプレートが変わった可能性がある。plugins/with-scene-delegate.js を直すこと。",
    );
  }
  return contents.replace(needle, replacement);
}

module.exports = function withSceneDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error(
        `with-scene-delegate: Swift の AppDelegate を前提にしている（${cfg.modResults.language}）`,
      );
    }
    let contents = cfg.modResults.contents;
    if (contents.includes("class SceneDelegate")) return cfg;

    contents = replaceOnce(
      contents,
      "  var reactNativeFactory: RCTReactNativeFactory?",
      LAUNCH_OPTIONS_PROPERTY,
      "factory のプロパティ",
    );
    contents = replaceOnce(contents, WINDOW_SETUP, WINDOW_SETUP_REPLACEMENT, "ウィンドウの生成");
    contents = replaceOnce(
      contents,
      "\nclass ReactNativeDelegate:",
      `${SCENE_DELEGATE}\nclass ReactNativeDelegate:`,
      "ReactNativeDelegate の手前",
    );

    cfg.modResults.contents = contents;
    return cfg;
  });
};
