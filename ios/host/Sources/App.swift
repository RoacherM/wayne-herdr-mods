// The Swift host of the native Herdr app: one NshAppView, full screen, running ios/App.tsx,
// plus native bridges for hold-to-talk audio recording (voice.*), camera QR scanning (qr.scan),
// local status notifications (notify.*), and native QuickLook / AVPlayer file preview (preview.*).
import AVFoundation
import AVKit
import NativeShell
import QuickLook
import UIKit
import UserNotifications

private final class AppLogger {
  static let shared = AppLogger()
  private let queue = DispatchQueue(label: "com.roacherm.herdr.logger", qos: .utility)
  private let maxBytes: UInt64 = 2 * 1024 * 1024
  private let keepBytes: Int = 1 * 1024 * 1024
  let logURL: URL

  private init() {
    let fm = FileManager.default
    let baseDir = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    try? fm.createDirectory(at: baseDir, withIntermediateDirectories: true)
    self.logURL = baseDir.appendingPathComponent("herdr-ios.log")
  }

  func write(_ level: String, _ event: String, _ detail: String = "") {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = detail.isEmpty ? "\(ts) [\(level)] \(event)\n" : "\(ts) [\(level)] \(event) \(detail)\n"
    NSLog("[herdr] %@ %@ %@", level, event, detail)
    queue.async { [logURL, maxBytes, keepBytes] in
      guard let data = line.data(using: .utf8) else { return }
      let fm = FileManager.default
      if !fm.fileExists(atPath: logURL.path) {
        try? data.write(to: logURL, options: .atomic)
        return
      }
      if let attr = try? fm.attributesOfItem(atPath: logURL.path),
         let size = attr[.size] as? UInt64,
         size > maxBytes,
         let existing = try? Data(contentsOf: logURL)
      {
        let tail = existing.suffix(keepBytes)
        var rotated = Data(tail)
        rotated.append(data)
        try? rotated.write(to: logURL, options: .atomic)
        return
      }
      if let fh = try? FileHandle(forWritingTo: logURL) {
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: data)
      }
    }
  }

  func readTail(maxChars: Int = 32_768) -> String {
    queue.sync {
      guard let data = try? Data(contentsOf: logURL), !data.isEmpty else { return "" }
      let slice = data.count > maxChars ? data.suffix(maxChars) : data
      return String(decoding: slice, as: UTF8.self)
    }
  }
}

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
    NSSetUncaughtExceptionHandler { exc in
      let stack = exc.callStackSymbols.joined(separator: " | ")
      AppLogger.shared.write("FATAL", "objc_exception", "name=\(exc.name.rawValue) reason=\(exc.reason ?? "") stack=\(stack)")
    }
    AppLogger.shared.write("INFO", "app.launch", "logPath=\(AppLogger.shared.logURL.path)")
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

final class ShellController: UIViewController, QLPreviewControllerDataSource {
  private let app = NshAppView()
  private var recorder: AVAudioRecorder?
  private let audioURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("herdr-voice.m4a")
  private let previewDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("herdr-previews", isDirectory: true)
  private var currentPreviewURL: URL?

  private func safePreviewURL(_ rawName: String) -> URL {
    let base = URL(fileURLWithPath: rawName).lastPathComponent
    let cleaned = base.isEmpty || base == "." || base == ".." ? "preview.bin" : base
    return previewDir.appendingPathComponent(cleaned)
  }

  private func topHostController() -> UIViewController {
    var top: UIViewController = self
    while let presented = top.presentedViewController, !presented.isBeingDismissed {
      top = presented
    }
    return top
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    currentPreviewURL == nil ? 0 : 1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    (currentPreviewURL ?? previewDir) as NSURL
  }

  override func loadView() { view = app }

  override func viewDidLoad() {
    super.viewDidLoad()
    // NOTE: Never set `app.onError` here: NativeShell.xcframework's `_nsh_app_set_error_handler`
    // immediately invokes the drop callback on the 32-byte ErrorHandlerBox while keeping a dangling
    // pointer to it, causing a use-after-free SIGSEGV on the first JS error or callBudget timeout.
    // Instead, we raise NshLimits generously and log all JS errors/events through `log.write`.
    app.limits = NshLimits(
      memoryMB: 512,
      stackKB: 8192,
      loadBudget: 30,
      callBudget: 30,
      maxNodes: 500_000
    )
    registerHostHandlers()
    guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
      AppLogger.shared.write("ERROR", "nsh.bundle.missing", "bundle.nshc not found")
      return
    }
    do {
      try app.loadBundle(at: url)
      AppLogger.shared.write("INFO", "nsh.bundle.loaded", url.lastPathComponent)
    } catch {
      AppLogger.shared.write("ERROR", "nsh.bundle.load_failed", "\(error)")
    }
  }

  private func registerHostHandlers() {
    app.handle("haptic") { _, reply in
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      reply.resolve(nil)
    }

    app.handle("log.write") { args, reply in
      let dict = args as? [String: Any] ?? [:]
      let level = (dict["level"] as? String ?? "INFO").uppercased()
      let event = dict["event"] as? String ?? "js"
      let detail = dict["detail"] as? String ?? ""
      AppLogger.shared.write(level, event, detail)
      reply.resolve(["ok": true])
    }

    app.handle("log.read") { args, reply in
      let dict = args as? [String: Any] ?? [:]
      let maxChars = dict["maxChars"] as? Int ?? 32_768
      reply.resolve([
        "path": AppLogger.shared.logURL.path,
        "text": AppLogger.shared.readTail(maxChars: maxChars),
      ])
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

    app.handle("preview.reset") { [weak self] args, reply in
      guard let self else { reply.reject("宿主已关闭"); return }
      let dict = args as? [String: Any] ?? [:]
      let name = dict["name"] as? String ?? "preview.bin"
      let url = self.safePreviewURL(name)
      do {
        try FileManager.default.createDirectory(at: self.previewDir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        try Data().write(to: url)
        AppLogger.shared.write("INFO", "preview.reset", "name=\(name) path=\(url.path)")
        reply.resolve(["path": url.path])
      } catch {
        AppLogger.shared.write("ERROR", "preview.reset_failed", "name=\(name) err=\(error.localizedDescription)")
        reply.reject("无法创建预览缓存：\(error.localizedDescription)")
      }
    }

    app.handle("preview.append") { [weak self] args, reply in
      guard let self else { reply.reject("宿主已关闭"); return }
      let dict = args as? [String: Any] ?? [:]
      let name = dict["name"] as? String ?? "preview.bin"
      let b64 = dict["data"] as? String ?? ""
      guard let chunk = Data(base64Encoded: b64) else {
        AppLogger.shared.write("ERROR", "preview.append_bad_b64", "name=\(name) b64Len=\(b64.count)")
        reply.reject("无效的预览分片数据")
        return
      }
      let url = self.safePreviewURL(name)
      do {
        if !FileManager.default.fileExists(atPath: url.path) {
          try FileManager.default.createDirectory(at: self.previewDir, withIntermediateDirectories: true)
          try chunk.write(to: url)
        } else {
          let fh = try FileHandle(forWritingTo: url)
          defer { try? fh.close() }
          try fh.seekToEnd()
          try fh.write(contentsOf: chunk)
        }
        reply.resolve(["ok": true, "bytes": chunk.count])
      } catch {
        AppLogger.shared.write("ERROR", "preview.append_failed", "name=\(name) chunkBytes=\(chunk.count) err=\(error.localizedDescription)")
        reply.reject("写入预览分片失败：\(error.localizedDescription)")
      }
    }

    app.handle("preview.open") { [weak self] args, reply in
      guard let self else { reply.reject("宿主已关闭"); return }
      let dict = args as? [String: Any] ?? [:]
      let name = dict["name"] as? String ?? "preview.bin"
      let kind = dict["kind"] as? String ?? ""
      let url = self.safePreviewURL(name)
      guard FileManager.default.fileExists(atPath: url.path) else {
        AppLogger.shared.write("ERROR", "preview.open_missing", "name=\(name) path=\(url.path)")
        reply.reject("预览文件不存在")
        return
      }
      let fileBytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? UInt64) ?? 0
      AppLogger.shared.write("INFO", "preview.open", "name=\(name) kind=\(kind) bytes=\(fileBytes)")
      DispatchQueue.main.async {
        let ext = url.pathExtension.lowercased()
        let isAV = kind == "video" || kind == "audio" || ["mp4", "mov", "m4v", "m4a", "mp3", "wav", "aac"].contains(ext)
        if isAV {
          try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
          try? AVAudioSession.sharedInstance().setActive(true)
          let player = AVPlayer(url: url)
          let vc = AVPlayerViewController()
          vc.player = player
          self.topHostController().present(vc, animated: true) {
            player.play()
          }
        } else {
          self.currentPreviewURL = url
          let ql = QLPreviewController()
          ql.dataSource = self
          self.topHostController().present(ql, animated: true)
        }
        reply.resolve(["ok": true, "bytes": fileBytes])
      }
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
