#if DEBUG
import Capacitor
import Foundation

@objc(FakeAppleSignInPlugin)
public class FakeAppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FakeAppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
    ]

    static let cancelKey = "cupTestCancelAppleSignIn"

    private let apiOrigin: String
    private let cancels: Bool

    init(apiOrigin: String, cancels: Bool) {
        self.apiOrigin = apiOrigin
        self.cancels = cancels
        super.init()
    }

    @objc func signIn(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("The Apple sign-in fake needs a nonce.", "FAILED")
            return
        }
        if cancels {
            call.reject("Sign in with Apple was cancelled.", "CANCELED")
            return
        }
        Task {
            do {
                let credential = try await Self.credential(apiOrigin: apiOrigin, nonce: nonce)
                call.resolve(credential)
            } catch {
                call.reject("The Apple sign-in fake could not reach the fake auth provider: \(error)", "FAILED")
            }
        }
    }

    private static func credential(apiOrigin: String, nonce: String) async throws -> [String: String] {
        let config = try await requestJson(URL(string: "\(apiOrigin)/api/auth/config")!, body: nil)
        guard let authOrigin = config["supabaseUrl"] as? String,
              authOrigin.hasPrefix("http://localhost:"),
              let credentialUrl = URL(string: "\(authOrigin)/qa/apple-credential") else {
            throw FakeAppleSignInError.notLocalhost(String(describing: config["supabaseUrl"]))
        }
        let credential = try await requestJson(credentialUrl, body: ["nonce": nonce])
        guard let identityToken = credential["identityToken"] as? String,
              let authorizationCode = credential["authorizationCode"] as? String else {
            throw FakeAppleSignInError.missingCredential
        }
        var result = ["identityToken": identityToken, "authorizationCode": authorizationCode]
        result["givenName"] = credential["givenName"] as? String
        result["familyName"] = credential["familyName"] as? String
        return result
    }

    private static func requestJson(_ url: URL, body: [String: String]?) async throws -> [String: Any] {
        var request = URLRequest(url: url, timeoutInterval: 10)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, status == 200 else {
            throw FakeAppleSignInError.status(url)
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FakeAppleSignInError.missingCredential
        }
        return json
    }
}

enum FakeAppleSignInError: Error {
    case notLocalhost(String)
    case missingCredential
    case status(URL)
}
#endif
