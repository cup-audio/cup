import crypto from "node:crypto";

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

export const APPLE_SIGN_IN_KEY = {
  privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  publicKey: pair.publicKey,
  keyId: "QAAPPLEKEY",
  teamId: "QATEAMID01",
};
