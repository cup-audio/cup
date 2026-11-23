import AuthenticationServices
import Capacitor
import UIKit

@objc(WebAuthenticationPlugin)
public class WebAuthenticationPlugin: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding {
    public let identifier = "WebAuthenticationPlugin"
    public let jsName = "WebAuthentication"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
    ]

    private static let callbackScheme = "audio.cup.app"

    private var session: ASWebAuthenticationSession?

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = URL(string: value),
              Self.isAllowedSignInUrl(url) else {
            call.reject("The sign-in URL is not one Cup opens.", "INVALID_URL")
            return
        }
        DispatchQueue.main.async {
            guard self.session == nil else {
                call.reject("Another sign-in is in progress.", "IN_PROGRESS")
                return
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: Self.callbackScheme
            ) { [weak self] callbackUrl, error in
                self?.session = nil
                if let callbackUrl {
                    call.resolve(["url": callbackUrl.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    call.reject("Sign-in was cancelled.", "CANCELED")
                } else {
                    call.reject(error?.localizedDescription ?? "Sign-in failed.", "FAILED", error)
                }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("Sign-in could not start.", "FAILED")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private static func isAllowedSignInUrl(_ url: URL) -> Bool {
        if url.scheme == "https" {
            return true
        }
        #if DEBUG
        return url.scheme == "http" && url.host == "localhost"
        #else
        return false
        #endif
    }
}
