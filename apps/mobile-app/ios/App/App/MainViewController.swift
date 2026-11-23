import Capacitor
import UIKit
import WebKit

class MainViewController: CAPBridgeViewController {
    private var webContentTerminationObserver: WebContentTerminationObserver?

    required init?(coder: NSCoder) {
        SentryInstallationFile.block()
        CrashReportingSwitch.deleteSentryFilesIfDisabled()
        super.init(coder: coder)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(WebAuthenticationPlugin())
        bridge?.registerPluginInstance(appleSignInPlugin())
        bridge?.registerPluginInstance(CrashReportingPlugin())
        bridge?.registerPluginInstance(WebViewProcessLossPlugin())
        observeWebContentTermination()
        #if DEBUG
        applyTestLaunchArguments()
        #endif
    }

    private func appleSignInPlugin() -> CAPPlugin {
        #if DEBUG
        let defaults = UserDefaults.standard
        if let origin = TestApiOrigin.fromDefaults(defaults) {
            return FakeAppleSignInPlugin(
                apiOrigin: origin,
                cancels: defaults.bool(forKey: FakeAppleSignInPlugin.cancelKey)
            )
        }
        #endif
        return AppleSignInPlugin()
    }

    private func observeWebContentTermination() {
        guard let webView, let capacitorDelegate = webView.navigationDelegate else {
            fatalError("Capacitor created no WebView with a navigation delegate to observe.")
        }
        let observer = WebContentTerminationObserver(capacitorDelegate: capacitorDelegate)
        webContentTerminationObserver = observer
        webView.navigationDelegate = observer
    }

    #if DEBUG
    private func applyTestLaunchArguments() {
        let defaults = UserDefaults.standard
        let sentryDsn = TestSentryDsn.fromDefaults(defaults)
        guard let origin = TestApiOrigin.fromDefaults(defaults) else {
            return
        }
        guard let contentController = webView?.configuration.userContentController else {
            fatalError("Capacitor created no WebView to apply the test API origin to.")
        }
        var source = "window.cupTestApiOrigin = \"\(origin)\";"
        if let sentryDsn {
            source += " window.cupTestSentryDsn = \"\(sentryDsn)\";"
        }
        contentController.addUserScript(WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }
    #endif
}

final class WebContentTerminationObserver: NSObject, WKNavigationDelegate {
    private let capacitorDelegate: WKNavigationDelegate

    init(capacitorDelegate: WKNavigationDelegate) {
        self.capacitorDelegate = capacitorDelegate
        super.init()
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || capacitorDelegate.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        capacitorDelegate.responds(to: aSelector) ? capacitorDelegate : super.forwardingTarget(for: aSelector)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        WebViewProcessLoss.record(inForeground: UIApplication.shared.applicationState != .background)
        capacitorDelegate.webViewWebContentProcessDidTerminate?(webView)
    }
}

enum WebViewProcessLoss {
    private static let key = "cupWebViewProcessLoss"

    static func record(inForeground: Bool) {
        UserDefaults.standard.set(["platform": "ios", "inForeground": inForeground], forKey: key)
    }

    static func take() -> [String: Any]? {
        let loss = UserDefaults.standard.dictionary(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
        return loss
    }
}

@objc(WebViewProcessLossPlugin)
public class WebViewProcessLossPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebViewProcessLossPlugin"
    public let jsName = "WebViewProcessLoss"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takeLoss", returnType: CAPPluginReturnPromise),
    ]

    @objc func takeLoss(_ call: CAPPluginCall) {
        if let loss = WebViewProcessLoss.take() {
            call.resolve(["loss": loss])
        } else {
            call.resolve([:])
        }
    }
}

enum SentryInstallationFile {
    static func block() {
        let fileManager = FileManager.default
        guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return
        }
        let installation = caches.appendingPathComponent("INSTALLATION")
        try? fileManager.removeItem(at: installation)
        do {
            try fileManager.createDirectory(at: installation, withIntermediateDirectories: true)
        } catch {
            NSLog("Cup could not block Sentry's installation ID file: \(error)")
        }
    }
}

#if DEBUG
enum TestApiOrigin {
    static let key = "cupTestApiOrigin"

    static func fromDefaults(_ defaults: UserDefaults) -> String? {
        guard let stored = defaults.object(forKey: key) else {
            return nil
        }
        guard let value = stored as? String, isLocalhostOrigin(value) else {
            fatalError("The \(key) default must be exactly http://localhost:<port>, got \"\(stored)\".")
        }
        return value
    }

    private static func isLocalhostOrigin(_ value: String) -> Bool {
        let prefix = "http://localhost:"
        guard value.hasPrefix(prefix) else {
            return false
        }
        let port = value.dropFirst(prefix.count)
        guard (1...5).contains(port.count),
              port.first != "0",
              port.allSatisfy({ ("0"..."9").contains($0) }),
              let number = Int(port) else {
            return false
        }
        return number <= 65535
    }
}

enum TestSentryDsn {
    static let key = "cupTestSentryDsn"
    private static let stubDsn = try! NSRegularExpression(
        pattern: "^http://[0-9A-Za-z]+@127\\.0\\.0\\.1:([1-9][0-9]{0,4})/[0-9]+$"
    )

    static func fromDefaults(_ defaults: UserDefaults) -> String? {
        guard let stored = defaults.object(forKey: key) else {
            return nil
        }
        guard let value = stored as? String, isStubDsn(value) else {
            fatalError("The \(key) default must be exactly http://<key>@127.0.0.1:<port>/<project>, got \"\(stored)\".")
        }
        guard defaults.object(forKey: TestApiOrigin.key) != nil else {
            fatalError("The \(key) default needs \(TestApiOrigin.key) too.")
        }
        return value
    }

    private static func isStubDsn(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        guard let match = stubDsn.firstMatch(in: value, range: range),
              let portRange = Range(match.range(at: 1), in: value),
              let port = Int(value[portRange]) else {
            return false
        }
        return port <= 65535
    }
}
#endif
