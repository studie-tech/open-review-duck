import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const VERSION = "v2";

/** Derives a fixed-length encryption key from an application secret. */
function keyFrom(secret: string) {
  if (secret.length < 32)
    throw new Error("ENCRYPTION_KEY must contain at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

/** Encrypts a provider credential with authenticated encryption. */
export function encryptSecret(value: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    process.env.ENCRYPTION_KEY_ID ?? "primary",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypts and authenticates a stored provider credential. */
export function decryptSecret(payload: string, secret: string) {
  const parts = payload.split(".");
  const legacy = parts[0] === "v1";
  const [version, keyId, encodedIv, encodedTag, encodedCiphertext] = legacy
    ? [parts[0], "primary", parts[1], parts[2], parts[3]]
    : parts;
  if (
    (version !== VERSION && version !== "v1") ||
    !keyId ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  )
    throw new Error("Encrypted credential has an unsupported format");
  const currentKeyId = process.env.ENCRYPTION_KEY_ID ?? "primary";
  let selectedSecret = secret;
  if (keyId !== currentKeyId) {
    try {
      const previous = JSON.parse(
        process.env.ENCRYPTION_PREVIOUS_KEYS ?? "{}",
      ) as Record<string, string>;
      selectedSecret = previous[keyId] ?? "";
    } catch {
      selectedSecret = "";
    }
    if (selectedSecret.length < 32) {
      throw new Error(`Encrypted credential key ${keyId} is unavailable`);
    }
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFrom(selectedSecret),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Creates a non-reversible fingerprint for a provider credential. */
export function fingerprintSecret(value: string, secret: string) {
  return createHmac("sha256", keyFrom(secret)).update(value).digest("hex");
}
