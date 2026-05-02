import { describe, it, expect, vi, afterEach } from "vitest";

import {
  base64UrlEncode,
  createJWT,
  importPrivateKey,
  sign,
} from "./github.js";

const SIGN_ALGORITHM = "RSASSA-PKCS1-v1_5";
const HASH_ALGORITHM = "SHA-256";

async function generateSigningKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: SIGN_ALGORITHM,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: HASH_ALGORITHM,
    },
    true,
    ["sign", "verify"]
  );
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function formatPem(buffer, label = "PRIVATE KEY") {
  const base64 = arrayBufferToBase64(buffer);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return formatPem(pkcs8);
}

function readDerLength(bytes, offset) {
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return { length: first, bytesRead: 1 };
  }

  const size = first & 0x7f;
  let length = 0;
  for (let i = 0; i < size; i++) {
    length = (length << 8) | bytes[offset + 1 + i];
  }

  return { length, bytesRead: 1 + size };
}

function readDerElement(bytes, offset = 0) {
  const tag = bytes[offset];
  const { length, bytesRead } = readDerLength(bytes, offset + 1);
  const headerLength = 1 + bytesRead;
  const start = offset + headerLength;
  const end = start + length;

  return {
    tag,
    length,
    headerLength,
    start,
    end,
    value: bytes.slice(start, end),
  };
}

function encodeDerLength(length) {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }

  const octets = [];
  let value = length;
  while (value > 0) {
    octets.unshift(value & 0xff);
    value >>= 8;
  }

  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function encodeDer(tag, value) {
  return Uint8Array.of(tag, ...encodeDerLength(value.length), ...value);
}

function concatUint8Arrays(...arrays) {
  const totalLength = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }

  return result;
}

function wrapPkcs1InPkcs8(pkcs1Der) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algorithmIdentifier = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00
  );
  const privateKey = encodeDer(0x04, pkcs1Der);

  return encodeDer(
    0x30,
    concatUint8Arrays(version, algorithmIdentifier, privateKey)
  );
}

async function exportPkcs1PrivateKey(privateKey) {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const privateKeyInfo = readDerElement(pkcs8);
  let offset = privateKeyInfo.start;

  const version = readDerElement(pkcs8, offset);
  offset = version.end;

  const algorithm = readDerElement(pkcs8, offset);
  offset = algorithm.end;

  const privateKeyOctetString = readDerElement(pkcs8, offset);
  return {
    der: privateKeyOctetString.value,
    pem: formatPem(privateKeyOctetString.value, "RSA PRIVATE KEY"),
  };
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

async function verifySignature(publicKey, data, signature) {
  return await crypto.subtle.verify(
    SIGN_ALGORITHM,
    publicKey,
    base64UrlDecode(signature),
    new TextEncoder().encode(data)
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("base64UrlEncode", () => {
  it("문자열을 padding 없는 base64url 로 인코딩한다", () => {
    expect(base64UrlEncode("Hello")).toBe("SGVsbG8");
  });

  it("+, /, = 문자를 URL-safe 문자로 치환한다", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 238]))).toBe("-__u");
  });
});

describe("importPrivateKey", () => {
  it("PKCS8 PEM private key 를 Web Crypto 서명 키로 import 한다", async () => {
    const keyPair = await generateSigningKeyPair();
    const pem = await exportPrivateKeyPem(keyPair.privateKey);

    const importedKey = await importPrivateKey(pem);
    const signature = await crypto.subtle.sign(
      SIGN_ALGORITHM,
      importedKey,
      new TextEncoder().encode("payload")
    );

    const isValid = await crypto.subtle.verify(
      SIGN_ALGORITHM,
      keyPair.publicKey,
      signature,
      new TextEncoder().encode("payload")
    );

    expect(importedKey.type).toBe("private");
    expect(importedKey.extractable).toBe(false);
    expect(importedKey.usages).toEqual(["sign"]);
    expect(isValid).toBe(true);
  });

  it("PKCS1 PEM RSA private key 도 Web Crypto 서명 키로 import 한다", async () => {
    const keyPair = await generateSigningKeyPair();
    const { der: pkcs1Der, pem } = await exportPkcs1PrivateKey(keyPair.privateKey);
    const expectedPkcs8Bytes = wrapPkcs1InPkcs8(pkcs1Der);

    const importKeySpy = vi.spyOn(crypto.subtle, "importKey");

    const importedKey = await importPrivateKey(pem);
    const signature = await crypto.subtle.sign(
      SIGN_ALGORITHM,
      importedKey,
      new TextEncoder().encode("payload")
    );

    const isValid = await crypto.subtle.verify(
      SIGN_ALGORITHM,
      keyPair.publicKey,
      signature,
      new TextEncoder().encode("payload")
    );

    expect(importedKey.type).toBe("private");
    expect(importedKey.extractable).toBe(false);
    expect(importedKey.usages).toEqual(["sign"]);
    const importedDer = new Uint8Array(importKeySpy.mock.calls[0][1]);
    expect(Array.from(importedDer)).toEqual(Array.from(expectedPkcs8Bytes));
    expect(isValid).toBe(true);
  });
});

describe("sign", () => {
  it("RS256 서명을 base64url 문자열로 반환한다", async () => {
    const keyPair = await generateSigningKeyPair();
    const pem = await exportPrivateKeyPem(keyPair.privateKey);
    const importedKey = await importPrivateKey(pem);

    const signature = await sign("header.payload", importedKey);

    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature).not.toContain("=");
    expect(await verifySignature(keyPair.publicKey, "header.payload", signature)).toBe(
      true
    );
  });
});

describe("createJWT", () => {
  it("GitHub App JWT header/payload 를 만들고 RS256 으로 서명한다", async () => {
    const keyPair = await generateSigningKeyPair();
    const pem = await exportPrivateKeyPem(keyPair.privateKey);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const jwt = await createJWT("12345", pem);
    const [encodedHeader, encodedPayload, signature] = jwt.split(".");

    expect(jwt.split(".")).toHaveLength(3);
    expect(decodeJwtPart(encodedHeader)).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(decodeJwtPart(encodedPayload)).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_600,
      iss: "12345",
    });
    expect(
      await verifySignature(
        keyPair.publicKey,
        `${encodedHeader}.${encodedPayload}`,
        signature
      )
    ).toBe(true);
  });
});
