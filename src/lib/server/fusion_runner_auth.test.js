import { describe, expect, it } from 'vitest';
import { getBearerToken, getFusionRunnerSecrets, isAuthorizedFusionRunnerRequest } from './fusion_runner_auth.js';

describe('fusion runner auth helpers', () => {
  it('fails closed when no runner secret is configured', () => {
    expect(isAuthorizedFusionRunnerRequest({
      url: new URL('https://example.com/api/fusion-runner'),
      headers: new Headers()
    })).toBe(false);
  });

  it('rejects a query token so secrets do not leak into request logs', () => {
    expect(isAuthorizedFusionRunnerRequest({
      url: new URL('https://example.com/api/fusion-runner?token=runner-secret'),
      headers: new Headers(),
      env: { FUSION_RUNNER_TOKEN: 'runner-secret' }
    })).toBe(false);
  });

  it('accepts bearer auth', () => {
    expect(isAuthorizedFusionRunnerRequest({
      url: new URL('https://example.com/api/fusion-runner'),
      headers: new Headers({ authorization: 'Bearer runner-secret' }),
      env: { FUSION_RUNNER_TOKEN: 'runner-secret' }
    })).toBe(true);
  });

  it('rejects requests with the wrong token', () => {
    expect(isAuthorizedFusionRunnerRequest({
      url: new URL('https://example.com/api/fusion-runner?token=wrong'),
      headers: new Headers({ authorization: 'Bearer nope' }),
      env: { FUSION_RUNNER_TOKEN: 'expected-secret' }
    })).toBe(false);
  });

  it('rejects a request with no credentials at all when a secret is configured', () => {
    expect(isAuthorizedFusionRunnerRequest({
      url: new URL('https://example.com/api/fusion-runner'),
      headers: new Headers(),
      env: { FUSION_RUNNER_TOKEN: 'expected-secret' }
    })).toBe(false);
  });

  it('collects the configured secret', () => {
    expect(getFusionRunnerSecrets({ FUSION_RUNNER_TOKEN: 'shared' })).toEqual(['shared']);
    expect(getFusionRunnerSecrets({})).toEqual([]);
  });

  // Issue #309: Fusion and Vision each have their own Secret Manager
  // credential, and an earlier deploy workaround mapped one runner's token
  // to the other's secret. These pin the separation in code so a future
  // change can't quietly re-cross them: a Vision token must never satisfy
  // Fusion's check, and Fusion's own check must not fall back to reading
  // Vision's variable when its own is unset.
  it('never accepts the Vision runner token', () => {
    expect(isAuthorizedFusionRunnerRequest({
      headers: new Headers({ authorization: 'Bearer vision-secret' }),
      env: { FUSION_RUNNER_TOKEN: 'fusion-secret', VISION_RUNNER_TOKEN: 'vision-secret' }
    })).toBe(false);
  });

  it('does not fall back to the Vision runner secret when its own is unset', () => {
    expect(getFusionRunnerSecrets({ VISION_RUNNER_TOKEN: 'vision-secret' })).toEqual([]);
    expect(isAuthorizedFusionRunnerRequest({
      headers: new Headers({ authorization: 'Bearer vision-secret' }),
      env: { VISION_RUNNER_TOKEN: 'vision-secret' }
    })).toBe(false);
  });

  // A per-Runner token (runner_tokens table, looked up by the caller - see
  // this function's own docstring) is passed in as an extra secret rather
  // than this module ever touching the database itself.
  it('accepts a per-Runner token passed in as an extra secret', () => {
    expect(isAuthorizedFusionRunnerRequest({
      headers: new Headers({ authorization: 'Bearer frt_unique-machine-key' }),
      env: {},
      extraSecrets: ['frt_unique-machine-key']
    })).toBe(true);
  });

  it('still rejects a token that matches neither the shared secret nor an extra secret', () => {
    expect(isAuthorizedFusionRunnerRequest({
      headers: new Headers({ authorization: 'Bearer wrong-token' }),
      env: { FUSION_RUNNER_TOKEN: 'shared-secret' },
      extraSecrets: ['frt_unique-machine-key']
    })).toBe(false);
  });

  it('extracts the bearer token for callers that need it directly', () => {
    expect(getBearerToken(new Headers({ authorization: 'Bearer some-token' }))).toBe('some-token');
    expect(getBearerToken(new Headers())).toBe('');
  });
});
