// The native shell: the phone page (app/) full screen in a WKWebView, without Safari's bars.
// The page itself comes from the relay, so a deploy updates it; this shell rarely changes.
import SwiftUI
import WebKit

let home = URL(string: "https://herdr-relay.sir-housir.workers.dev/")!
let pageColor = UIColor(red: 0x0b / 255, green: 0x0b / 255, blue: 0x0c / 255, alpha: 1)

@main
struct HerdrRelay: App {
  var body: some Scene {
    WindowGroup {
      Page().ignoresSafeArea().background(Color(pageColor)).preferredColorScheme(.dark)
    }
  }
}

struct Page: UIViewRepresentable {
  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true            // the camera preview when scanning the pairing code
    config.mediaTypesRequiringUserActionForPlayback = []
    config.limitsNavigationsToAppBoundDomains = true   // WKAppBoundDomains: the relay only; it also enables the service worker
    let web = WKWebView(frame: .zero, configuration: config)
    web.isOpaque = false
    web.backgroundColor = pageColor
    web.scrollView.backgroundColor = pageColor
    web.scrollView.contentInsetAdjustmentBehavior = .never // the page places itself with env(safe-area-inset-*)
    web.scrollView.bounces = false
    web.allowsBackForwardNavigationGestures = false
    web.uiDelegate = context.coordinator
    web.navigationDelegate = context.coordinator
    #if DEBUG
    web.isInspectable = true // Safari ▸ Develop on the Mac
    #endif
    web.load(URLRequest(url: home))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
    // The microphone (hold to talk) and the camera (pairing code), for the relay's page only.
    // iOS asks the person once for the app (Info.plist says why); the page is not asked again.
    func webView(_ web: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
      decisionHandler(origin.host == home.host ? .grant : .deny)
    }

    // Other sites open in Safari.
    func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      if let url = action.request.url, url.host != home.host, url.scheme?.hasPrefix("http") == true {
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
        return
      }
      decisionHandler(.allow)
    }

    // A page that went away (the web content process ended in the background): load it again.
    func webViewWebContentProcessDidTerminate(_ web: WKWebView) { web.load(URLRequest(url: home)) }
  }
}
