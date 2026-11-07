// The Swift host of the native Herdr app: one NshAppView, full screen, running ios/App.tsx.
// The app places itself inside the safe area (env(safe-area-inset-*)).
import NativeShell
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: nil, sessionRole: session.role)
    config.delegateClass = SceneDelegate.self // iOS 27 stops an app without the scene lifecycle at launch
    return config
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = ShellController()
    window.makeKeyAndVisible()
    self.window = window
  }
}

final class ShellController: UIViewController {
  private let app = NshAppView()

  override func loadView() { view = app }

  override func viewDidLoad() {
    super.viewDidLoad()
    app.onError = { message in NSLog("nsh error: %@", message) }
    guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
      NSLog("nsh: no bundle in the app"); return
    }
    do { try app.loadBundle(at: url) } catch { NSLog("nsh: cannot load: %@", "\(error)") }
  }

  override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
  override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}
