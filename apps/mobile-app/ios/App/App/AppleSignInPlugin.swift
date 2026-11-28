import AuthenticationServices
import Capacitor
import UIKit

@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?
    private var controller: ASAuthorizationController?

    @objc func signIn(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("Sign in with Apple needs a nonce.", "FAILED")
            return
        }
        DispatchQueue.main.async {
            guard self.pendingCall == nil else {
                call.reject("Another sign-in is in progress.", "IN_PROGRESS")
                return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email, .fullName]
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pendingCall = call
            self.controller = controller
            controller.performRequests()
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let call = finish() else {
            return
        }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityToken = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
              let authorizationCode = credential.authorizationCode.flatMap({ String(data: $0, encoding: .utf8) })
        else {
            call.reject("Sign in with Apple returned no identity token or authorization code.", "FAILED")
            return
        }
        var result: [String: String] = ["identityToken": identityToken, "authorizationCode": authorizationCode]
        result["givenName"] = credential.fullName?.givenName
        result["familyName"] = credential.fullName?.familyName
        call.resolve(result)
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        guard let call = finish() else {
            return
        }
        if let error = error as? ASAuthorizationError, error.code == .canceled {
            call.reject("Sign in with Apple was cancelled.", "CANCELED")
        } else {
            call.reject(error.localizedDescription, "FAILED", error)
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func finish() -> CAPPluginCall? {
        let call = pendingCall
        pendingCall = nil
        controller = nil
        return call
    }
}
