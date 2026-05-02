/**
 * GitHub App 인증 및 API 유틸리티
 */

import { GITHUB_USER_AGENT, GITHUB_ACCEPT_HEADER } from "./constants.js";

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

function wrapPkcs1PrivateKey(pkcs1Der) {
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
 * content_node_id로부터 PR 정보 조회 (GraphQL)
 */
export async function getPRInfoFromNodeId(nodeId, token) {
  const query = `
    query($nodeId: ID!) {
      node(id: $nodeId) {
        ... on PullRequest {
          number
          repository {
            owner {
              login
            }
            name
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: getGitHubHeaders(token),
    body: JSON.stringify({
      query,
      variables: { nodeId },
    }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  const prData = result.data?.node;
  if (!prData) {
    return null;
  }

  return {
    number: prData.number,
    owner: prData.repository.owner.login,
    repo: prData.repository.name,
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
export async function createJWT(appId, privateKeyPem) {
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
export async function importPrivateKey(pem) {
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

  let binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  if (!isPKCS8) {
    binaryDer = wrapPkcs1PrivateKey(binaryDer);
  }

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
export async function sign(data, key) {
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
export function base64UrlEncode(data) {
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
