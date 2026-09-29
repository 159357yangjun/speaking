import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";

const FINGERPRINT_B64URL = /^[A-Za-z0-9_-]{43}$/;

function toB64url(buf) {
  return buf.toString("base64url").replace(/=+$/, "");
}

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: toB64url(publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
  };
}

export function fingerprintFromPrivate(privatePem) {
  const pub = createPublicKey(createPrivateKey(privatePem));
  return toB64url(pub.export({ type: "spki", format: "der" }).subarray(-32));
}

export function assertFingerprint(value) {
  if (!FINGERPRINT_B64URL.test(value)) {
    throw new Error(`指纹格式非法（应为 43 字符 base64url）：${value}`);
  }
  return value;
}

export function signDigest(privatePem, digestStr) {
  const sig = sign(null, Buffer.from(digestStr, "utf8"), createPrivateKey(privatePem));
  return toB64url(sig);
}

export function verifyDigest(fingerprint, digestStr, sigB64url) {
  assertFingerprint(fingerprint);
  const raw = Buffer.from(fingerprint, "base64url");
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const pub = createPublicKey({ key: der, format: "der", type: "spki" });
  return verify(null, Buffer.from(digestStr, "utf8"), pub, Buffer.from(sigB64url, "base64url"));
}

export function writePrivateKeys(path, handle, privatePem) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privatePem, { mode: 0o600 });
  return { path, handle, note: basename(path) };
}
