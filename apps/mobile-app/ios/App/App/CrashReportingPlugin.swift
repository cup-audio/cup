import Capacitor
import Foundation

/// The "Send crash reports" switch, on by default. The web app reads it before it starts Sentry and
/// starts the native SDK only while it is on, so turning it off takes full effect on the next start.
/// Turning it off also deletes the native SDK's files, such as crash reports waiting to be sent.
@objc(CrashReportingPlugin)
public class CrashReportingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CrashReportingPlugin"
    public let jsName = "CrashReporting"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]

    @objc func isEnabled(_ call: CAPPluginCall) {
        call.resolve(["enabled": CrashReportingSwitch.isEnabled])
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("The enabled option must be a boolean.", "INVALID_ARGUMENT")
            return
        }
        CrashReportingSwitch.isEnabled = enabled
        if !enabled {
            CrashReportingSwitch.deleteSentryFiles()
        }
        call.resolve()
    }
}

/// The switch's value in Cup's own defaults, and the native SDK's files it deletes.
enum CrashReportingSwitch {
    private static let key = "cupCrashReportsEnabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Deletes the files a native SDK left while the switch is off. The SDK of the process in which
    /// the listener turned the switch off keeps running, and can write again, until the app stops.
    static func deleteSentryFilesIfDisabled() {
        if !isEnabled {
            deleteSentryFiles()
        }
    }

    /// The Cocoa SDK keeps its files in `Library/Caches`: envelopes and the scope in `io.sentry/`,
    /// crash reports in `SentryCrash/`, and the log of its crash handler in `async.log`. The
    /// `INSTALLATION` directory stays: it holds nothing, and `SentryInstallationFile` needs it.
    static func deleteSentryFiles() {
        let fileManager = FileManager.default
        guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return
        }
        for name in ["io.sentry", "SentryCrash", "async.log"] {
            let url = caches.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: url.path) else {
                continue
            }
            do {
                try fileManager.removeItem(at: url)
            } catch {
                NSLog("Cup could not delete Sentry's \(name): \(error)")
            }
        }
    }
}
