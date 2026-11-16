import Capacitor
import UIKit
import WebKit

/// Cup's only view controller: Capacitor's bridge with the app's own plugins.
class MainViewController: CAPBridgeViewController {
    /// UIKit creates the controller from `Main.storyboard`, before the page loads and so before the
    /// web app starts the native Sentry SDK.
    required init?(coder: NSCoder) {
        SentryInstallationFile.block()
        super.init(coder: coder)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // The app's own plugins are not npm packages, so Capacitor does not find them by itself.
        bridge?.registerPluginInstance(WebAuthenticationPlugin())
        #if DEBUG
        applyTestLaunchArguments()
        #endif
    }

    #if DEBUG
    /// Points the web app at the test Worker: before the page loads, sets the global that
    /// `apiOrigin()` reads, and with a `TestSentryDsn` the global the web app's telemetry reads. ATS's
    /// built-in exemption for `localhost` allows the plain HTTP. Capacitor replaces the
    /// configuration's content controller while preparing the WebView, so the script is added here,
    /// after the bridge exists and before `viewDidLoad` loads the page.
    private func applyTestLaunchArguments() {
        // Both stop the app on a malformed value, before it can reach production.
        let defaults = UserDefaults.standard
        let sentryDsn = TestSentryDsn.fromDefaults(defaults)
        guard let origin = TestApiOrigin.fromDefaults(defaults) else {
            return
        }
        guard let contentController = webView?.configuration.userContentController else {
            fatalError("Capacitor created no WebView to apply the test API origin to.")
        }
        // Both values are validated to contain no characters that need escaping in a string literal.
        var source = "window.cupTestApiOrigin = \"\(origin)\";"
        if let sentryDsn {
            // The web app's telemetry, and through it the native Sentry SDK, sends only here.
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

/// Keeps the Sentry Cocoa SDK's installation ID in memory only. The SDK reads the ID from the file
/// `INSTALLATION` in its cache directory, `Library/Caches`, and writes a new random one there when
/// it finds none. With a directory in the file's place, reading and writing both fail, so the SDK
/// keeps its new ID for this process only. Whatever is there is replaced, such as a file that an
/// earlier build let the SDK write.
enum SentryInstallationFile {
    static func block() {
        let fileManager = FileManager.default
        guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return
        }
        let installation = caches.appendingPathComponent("INSTALLATION")
        // On a failure, an ID the SDK writes lasts this launch only: the next launch removes it.
        try? fileManager.removeItem(at: installation)
        do {
            try fileManager.createDirectory(at: installation, withIntermediateDirectories: true)
        } catch {
            NSLog("Cup could not block Sentry's installation ID file: \(error)")
        }
    }
}

#if DEBUG
/// Debug builds only: the test Worker origin the mobile E2E suite sets as the defaults key
/// `cupTestApiOrigin`. The process arguments `-cupTestApiOrigin <origin>` set it for one launch,
/// through the defaults' arguments domain. A launch without arguments, such as one a shared URL
/// starts, reads the value the suite wrote into Cup's own defaults with
/// `xcrun simctl spawn <simulator> defaults write audio.cup.app cupTestApiOrigin <origin>`.
enum TestApiOrigin {
    static let key = "cupTestApiOrigin"

    /// Returns the origin, or nil when the defaults hold none. Stops the app when the value is
    /// anything but `http://localhost:<port>`.
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

/// Debug builds only: the Sentry stub's DSN the mobile E2E suite passes as the defaults key
/// `cupTestSentryDsn`, through the process arguments `-cupTestSentryDsn <dsn>` next to
/// `TestApiOrigin`'s. Without it, a debug build sends nothing to Sentry.
enum TestSentryDsn {
    static let key = "cupTestSentryDsn"
    /// The stub listens on the host's 127.0.0.1, which the simulator shares.
    private static let stubDsn = try! NSRegularExpression(
        pattern: "^http://[0-9A-Za-z]+@127\\.0\\.0\\.1:([1-9][0-9]{0,4})/[0-9]+$"
    )

    /// Returns the DSN, or nil when the defaults hold none. Stops the app when the value is anything
    /// but `http://<key>@127.0.0.1:<port>/<project>`, or when the defaults hold no test API origin,
    /// whose telemetry tunnel the web app sends through.
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
