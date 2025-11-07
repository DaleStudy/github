/**
 * GitHub App 인증 및 API 유틸리티
 */

import { GITHUB_USER_AGENT, GITHUB_ACCEPT_HEADER } from "./constants.js";

/**
 * GitHub API 요청 헤더 생성
 */
export function getGitHubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: GITHUB_ACCEPT_HEADER,
    "User-Agent": GITHUB_USER_AGENT,
  };
}

/**
 * GitHub App Installation Token 발급
 */
export async function generateGitHubAppToken(env) {
  // JWT 생성
  const jwt = await createJWT(env.APP_ID, env.PRIVATE_KEY);

  // Installation ID 조회
  const installationsResponse = await fetch(
    "https://api.github.com/app/installations",
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-GitHub-App",
      },
    }
  );

  const installations = await installationsResponse.json();
  const installation = installations.find(
    (inst) => inst.account.login === "DaleStudy"
  );

  if (!installation) {
    throw new Error("DaleStudy installation not found");
  }

  // Installation Token 생성
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-GitHub-App",
      },
    }
  );

  const tokenData = await tokenResponse.json();

  if (!tokenData.token) {
    throw new Error(`Failed to get token: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.token;
}

/**
 * JWT 생성 (RS256)
 */
async function createJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60,
    exp: now + 10 * 60, // 10분
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await sign(
    `${encodedHeader}.${encodedPayload}`,
    privateKey
  );

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Private Key import
 */
async function importPrivateKey(pem) {
  // PKCS8 또는 PKCS1 형식 지원
  const isPKCS8 = pem.includes("BEGIN PRIVATE KEY");
  const pemHeader = isPKCS8
    ? "-----BEGIN PRIVATE KEY-----"
    : "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = isPKCS8
    ? "-----END PRIVATE KEY-----"
    : "-----END RSA PRIVATE KEY-----";

  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

/**
 * Sign with RS256
 */
async function sign(data, key) {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );

  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(data) {
  if (typeof data === "string") {
    data = new TextEncoder().encode(data);
  }

  let binary = "";
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
