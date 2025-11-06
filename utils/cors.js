/**
 * CORS 헤더 및 응답 유틸리티
 */

/**
 * CORS 헤더
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * CORS를 포함한 JSON 응답 생성
 */
export function corsResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

/**
 * CORS preflight 응답
 */
export function preflightResponse() {
  return new Response(null, {
    headers: CORS_HEADERS,
  });
}

/**
 * 에러 응답
 */
export function errorResponse(message, status = 500) {
  return corsResponse({ error: message }, status);
}
