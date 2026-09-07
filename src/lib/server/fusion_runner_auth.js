// Shared-secret bearer-token auth for the Fusion CAM Runner. Unlike cron
// URLs, this never accepts a query-string token: URLs are routinely stored
// in proxy and request logs. This endpoint uses a service
// role client, so a missing secret must fail closed instead of turning a
// deployment mistake into unauthenticated database access. Kept as its own
// module rather than reusing cron_auth.js
// directly: the Runner is a different trust boundary (an external Fusion
// 360 machine polling for jobs, not a cron-triggered sweep), so it gets its
// own secret/env var, even though the underlying technique is identical.
export function getFusionRunnerSecrets(envLike = {}) {
  return Array.from(new Set([
    envLike?.FUSION_RUNNER_TOKEN
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function getAuthorizationHeader(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get('authorization') || '').trim();
  }
  return String(headers.authorization || headers.Authorization || '').trim();
}

function getBearerToken(headers) {
  const authorization = getAuthorizationHeader(headers);
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : '';
}

export function isAuthorizedFusionRunnerRequest({ headers, env: envLike = {} }) {
  const expectedSecrets = getFusionRunnerSecrets(envLike);
  if (!expectedSecrets.length) return false;

  const bearerToken = getBearerToken(headers);
  if (bearerToken && expectedSecrets.includes(bearerToken)) return true;

  return false;
}
