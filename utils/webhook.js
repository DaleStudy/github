/**
 * GitHub Webhook 서명 검증 유틸리티
 */

/**
 * GitHub webhook 서명 검증
 *
 * @param {string} payload - Request body (raw string)
 * @param {string} signature - X-Hub-Signature-256 헤더 값
 * @param {string} secret - Webhook secret
 * @returns {Promise<boolean>} 검증 성공 여부
 */
export async function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.substring(7); // "sha256=" 제거

  // HMAC-SHA256 계산
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const actualSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe 비교
  return timingSafeEqual(actualSignature, expectedSignature);
}

/**
 * Timing-safe 문자열 비교
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
