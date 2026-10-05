import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import fs from "fs";
import path from "path";

export function newId(): string {
  return randomUUID();
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function secretFile(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "app.secret");
}

export function getSecret(): string {
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const file = secretFile();
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}

function key(): Buffer {
  return createHash("sha256").update(getSecret()).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  if (!payload) return "";
  const [version, ivPart, tagPart, dataPart] = payload.split(":");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) {
    throw new Error("SMTP password could not be read. Enter it again in Settings.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/**
 * SHA-256 of a webhook token, domain-separated. The tokens are 192 random bits, so a fast unsalted hash is
 * enough: there is nothing to brute-force, and the stored value cannot be turned back into a working token.
 */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(`postroom-webhook-token-v1:${token}`, "utf8").digest("hex");
}

/** Constant-time string comparison (false on a length mismatch without comparing). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signClick(token: string, target: string): { payload: string; signature: string } {
  const payload = Buffer.from(target, "utf8").toString("base64url");
  const signature = createHmac("sha256", getSecret()).update(`${token}.${payload}`).digest("base64url");
  return { payload, signature };
}

export function readClickTarget(token: string, payload: string, signature: string): string | null {
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", getSecret()).update(`${token}.${payload}`).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let url = "";
  try {
    url = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url) || /[\r\n\0]/.test(url)) return null;
  return url;
}
