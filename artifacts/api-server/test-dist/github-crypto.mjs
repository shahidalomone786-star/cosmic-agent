// src/lib/github-crypto.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
function encryptionKey() {
  const secret = process.env.GITHUB_CREDENTIAL_ENCRYPTION_KEY ?? process.env.SESSION_SECRET;
  if (!secret) throw new Error("GitHub credential encryption is not configured.");
  return createHash("sha256").update(secret).digest();
}
function encryptGitHubToken(token) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encryptedToken = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    encryptedToken: encryptedToken.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}
function decryptGitHubToken(encryptedToken, nonce, authTag) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedToken, "base64url")), decipher.final()]).toString("utf8");
}
export {
  decryptGitHubToken,
  encryptGitHubToken
};
