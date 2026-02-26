function getWebCrypto() {
  const maybeCrypto = (globalThis as { crypto?: any }).crypto;
  if (!maybeCrypto?.subtle || !maybeCrypto?.getRandomValues) {
    throw new Error("WebCrypto API is unavailable in this runtime");
  }
  return maybeCrypto;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToUtf8(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function bytesToHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function bytesToBase64(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  let index = 0;
  while (index < value.length) {
    const byte0 = value[index++] ?? 0;
    const byte1 = value[index++] ?? 0;
    const byte2 = value[index++] ?? 0;
    const triplet = (byte0 << 16) | (byte1 << 8) | byte2;
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += alphabet[(triplet >> 6) & 0x3f];
    output += alphabet[triplet & 0x3f];
  }
  const remainder = value.length % 3;
  if (remainder === 1) return `${output.slice(0, -2)}==`;
  if (remainder === 2) return `${output.slice(0, -1)}=`;
  return output;
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const reverse = new Map<string, number>(Array.from(alphabet).map((char, i) => [char, i]));
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i += 4) {
    const c0 = normalized[i] ?? "A";
    const c1 = normalized[i + 1] ?? "A";
    const c2 = normalized[i + 2] ?? "A";
    const c3 = normalized[i + 3] ?? "A";
    const v0 = reverse.get(c0) ?? 0;
    const v1 = reverse.get(c1) ?? 0;
    const v2 = c2 === "=" ? 0 : (reverse.get(c2) ?? 0);
    const v3 = c3 === "=" ? 0 : (reverse.get(c3) ?? 0);
    const triplet = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    bytes.push((triplet >> 16) & 0xff);
    if (c2 !== "=") bytes.push((triplet >> 8) & 0xff);
    if (c3 !== "=") bytes.push(triplet & 0xff);
  }

  return new Uint8Array(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

export function pemToDerBytes(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64);
}

export function randomHex(byteLength: number): string {
  const crypto = getWebCrypto();
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return Object.fromEntries(entries.map(([key, child]) => [key, sortJsonValue(child)]));
  }
  return value;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const crypto = getWebCrypto();
  const data = typeof input === "string" ? utf8ToBytes(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(keyHex: string, message: string): Promise<string> {
  const crypto = getWebCrypto();
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8ToBytes(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyEcdsaP256Sha256Signature(input: {
  spkiPem: string;
  message: string;
  signatureBase64: string;
}): Promise<boolean> {
  const crypto = getWebCrypto();
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemToDerBytes(input.spkiPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64ToBytes(input.signatureBase64),
    utf8ToBytes(input.message)
  );
}

export async function aes256GcmEncryptHex(
  keyHex: string,
  plaintext: string,
  aad: string
): Promise<{ ivHex: string; ciphertextHex: string }> {
  const crypto = getWebCrypto();
  const iv = hexToBytes(randomHex(12));
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, [
    "encrypt"
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: utf8ToBytes(aad),
      tagLength: 128
    },
    key,
    utf8ToBytes(plaintext)
  );

  return {
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(new Uint8Array(ciphertext))
  };
}

export async function aes256GcmDecryptHex(
  keyHex: string,
  ciphertextHex: string,
  ivHex: string,
  aad: string
): Promise<string> {
  const crypto = getWebCrypto();
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, [
    "decrypt"
  ]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: hexToBytes(ivHex),
      additionalData: utf8ToBytes(aad),
      tagLength: 128
    },
    key,
    hexToBytes(ciphertextHex)
  );

  return bytesToUtf8(new Uint8Array(plaintext));
}
