import Capacitor
import Foundation

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

enum CrashReportingSwitch {
    private static let key = "cupCrashReportsEnabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    static func deleteSentryFilesIfDisabled() {
        if !isEnabled {
            deleteSentryFiles()
        }
    }

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
