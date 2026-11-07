// The Swift host of the native Herdr app: one NshAppView, full screen, running ios/App.tsx,
// plus native bridges for hold-to-talk audio recording (voice.*), camera QR scanning (qr.scan),
// and local status notifications (notify.*).
import AVFoundation
import NativeShell
import UIKit
import UserNotifications

private final class NotificationBridge: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationBridge()
  var pendingTap: [String: String]?

  func install() {
    UNUserNotificationCenter.current().delegate = self
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let desktopId = info["desktopId"] as? String ?? ""
    let address = info["address"] as? String ?? ""
    if !address.isEmpty {
      pendingTap = ["desktopId": desktopId, "address": address]
    }
    completionHandler()
  }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationBridge.shared.install()
    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: nil, sessionRole: session.role)
    config.delegateClass = SceneDelegate.self // iOS 27 stops an app without the scene lifecycle at launch
    return config
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var bgTask: UIBackgroundTaskIdentifier = .invalid

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = ShellController()
    window.makeKeyAndVisible()
    self.window = window
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    guard bgTask == .invalid else { return }
    bgTask = UIApplication.shared.beginBackgroundTask(withName: "HerdrRelayWatch") { [weak self] in
      guard let self, self.bgTask != .invalid else { return }
      UIApplication.shared.endBackgroundTask(self.bgTask)
      self.bgTask = .invalid
    }
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    guard bgTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(bgTask)
    bgTask = .invalid
  }
}

final class ShellController: UIViewController {
  private let app = NshAppView()
  private var recorder: AVAudioRecorder?
  private let audioURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("herdr-voice.m4a")

  override func loadView() { view = app }

  override func viewDidLoad() {
    super.viewDidLoad()
    app.onError = { message in NSLog("nsh error: %@", message) }
    registerHostHandlers()
    guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
      NSLog("nsh: no bundle in the app"); return
    }
    do { try app.loadBundle(at: url) } catch { NSLog("nsh: cannot load: %@", "\(error)") }
  }

  private func registerHostHandlers() {
    app.handle("haptic") { _, reply in
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      reply.resolve(nil)
    }

    app.handle("voice.start") { [weak self] _, reply in
      guard let self else { reply.reject("宿主已关闭"); return }
      AVAudioApplication.requestRecordPermission { allowed in
        DispatchQueue.main.async {
          guard allowed else {
            reply.reject("没有麦克风权限：请在 设置 ▸ Herdr ▸ 麦克风 里打开")
            return
          }
          do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            try? FileManager.default.removeItem(at: self.audioURL)
            let settings: [String: Any] = [
              AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
              AVSampleRateKey: 16_000,
              AVNumberOfChannelsKey: 1,
              AVEncoderBitRateKey: 32_000,
            ]
            let rec = try AVAudioRecorder(url: self.audioURL, settings: settings)
            rec.isMeteringEnabled = true
            rec.prepareToRecord()
            guard rec.record(forDuration: 120) else {
              reply.reject("无法启动录音")
              return
            }
            self.recorder = rec
            reply.resolve(["ok": true])
          } catch {
            reply.reject("录音失败：\(error.localizedDescription)")
          }
        }
      }
    }

    app.handle("voice.level") { [weak self] _, reply in
      guard let self, let rec = self.recorder, rec.isRecording else {
        reply.resolve(["level": 0])
        return
      }
      rec.updateMeters()
      let db = rec.averagePower(forChannel: 0) // -160 ... 0 dB
      let normalized = max(0.0, min(1.0, Double((db + 50.0) / 50.0)))
      reply.resolve(["level": normalized])
    }

    app.handle("voice.stop") { [weak self] _, reply in
      guard let self else { reply.reject("宿主已关闭"); return }
      self.recorder?.stop()
      self.recorder = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      defer { try? FileManager.default.removeItem(at: self.audioURL) }
      guard let data = try? Data(contentsOf: self.audioURL), !data.isEmpty else {
        reply.resolve(["data": "", "mime": "audio/mp4"])
        return
      }
      reply.resolve(["data": data.base64EncodedString(), "mime": "audio/mp4"])
    }

    app.handle("voice.cancel") { [weak self] _, reply in
      guard let self else { reply.resolve(["ok": true]); return }
      self.recorder?.stop()
      self.recorder = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      try? FileManager.default.removeItem(at: self.audioURL)
      reply.resolve(["ok": true])
    }

    app.handle("qr.scan") { [weak self] _, reply in
      guard let self else { reply.resolve(nil); return }
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          guard granted else {
            reply.reject("没有相机权限：请在 设置 ▸ Herdr ▸ 相机 里打开，或直接粘贴配对链接")
            return
          }
          guard AVCaptureDevice.default(for: .video) != nil else {
            reply.reject("当前设备没有可用相机，请直接粘贴配对链接")
            return
          }
          let scanner = QRScannerController { result in
            switch result {
            case .success(let code): reply.resolve(code)
            case .failure(let err): reply.reject(err.localizedDescription)
            }
          }
          self.present(scanner, animated: true)
        }
      }
    }

    app.handle("notify.status") { _, reply in
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        let status: String
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: status = "granted"
        case .denied: status = "denied"
        default: status = "prompt"
        }
        DispatchQueue.main.async {
          reply.resolve(["permission": status])
        }
      }
    }

    app.handle("notify.request") { _, reply in
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in
        DispatchQueue.main.async {
          if let err {
            reply.reject("通知权限请求失败：\(err.localizedDescription)")
            return
          }
          reply.resolve(["granted": granted, "permission": granted ? "granted" : "denied"])
        }
      }
    }

    app.handle("notify.send") { args, reply in
      let dict = args as? [String: Any] ?? [:]
      let title = dict["title"] as? String ?? "Herdr"
      let body = dict["body"] as? String ?? ""
      let tag = dict["tag"] as? String ?? UUID().uuidString
      let desktopId = dict["desktopId"] as? String ?? ""
      let address = dict["address"] as? String ?? ""

      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      content.userInfo = ["desktopId": desktopId, "address": address]

      let req = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
      UNUserNotificationCenter.current().add(req) { err in
        DispatchQueue.main.async {
          if let err {
            reply.reject(err.localizedDescription)
          } else {
            reply.resolve(["ok": true])
          }
        }
      }
    }

    app.handle("notify.consumeTap") { _, reply in
      let tap = NotificationBridge.shared.pendingTap
      NotificationBridge.shared.pendingTap = nil
      reply.resolve(tap)
    }
  }

  override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
  override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}

private final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private var done = false
  private let onFinish: (Result<String?, Error>) -> Void

  init(onFinish: @escaping (Result<String?, Error>) -> Void) {
    self.onFinish = onFinish
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .pageSheet
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    guard
      let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      finish(.failure(NSError(domain: "HerdrQR", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法打开相机"])))
      return
    }
    session.addInput(input)

    let output = AVCaptureMetadataOutput()
    if session.canAddOutput(output) {
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      if output.availableMetadataObjectTypes.contains(.qr) {
        output.metadataObjectTypes = [.qr]
      }
    }

    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = view.bounds
    view.layer.addSublayer(layer)
    preview = layer

    let bar = UIView()
    bar.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    bar.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(bar)

    let title = UILabel()
    title.text = "扫描 Mac 上的配对二维码"
    title.textColor = .white
    title.font = .systemFont(ofSize: 16, weight: .semibold)
    title.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(title)

    let close = UIButton(type: .system)
    close.setTitle("取消", for: .normal)
    close.setTitleColor(.systemBlue, for: .normal)
    close.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
    close.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    close.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(close)

    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.topAnchor),
      bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      bar.heightAnchor.constraint(equalToConstant: 60),
      title.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
      title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
      close.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
      close.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
    ])

    DispatchQueue.global(qos: .userInitiated).async { [session] in
      session.startRunning()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if !done {
      done = true
      let s = session
      DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
      onFinish(.success(nil))
    }
  }

  @objc private func cancelTapped() {
    finish(.success(nil))
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard
      !done,
      let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      obj.type == .qr,
      let text = obj.stringValue,
      !text.isEmpty
    else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    finish(.success(text))
  }

  private func finish(_ result: Result<String?, Error>) {
    guard !done else { return }
    done = true
    let s = session
    DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
    dismiss(animated: true) { [onFinish] in
      onFinish(result)
    }
  }
}
