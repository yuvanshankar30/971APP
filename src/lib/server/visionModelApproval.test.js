import { describe, expect, it } from 'vitest';
import { modelApprovalStatus } from './visionModelApproval.js';

describe('vision model approval gate', () => {
  it('is opt-in per event', () => {
    expect(modelApprovalStatus(null, null)).toEqual({ allowed: true, reason: 'policy_disabled' });
  });

  it('accepts a current approval and rejects missing, expired, or revoked approvals', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    const policy = { require_approved_model: true };
    expect(modelApprovalStatus(policy, null, now).reason).toBe('not_approved');
    expect(modelApprovalStatus(policy, { expires_at: '2026-09-21T00:00:00Z' }, now).allowed).toBe(true);
    expect(modelApprovalStatus(policy, { expires_at: '2026-09-19T00:00:00Z' }, now).reason).toBe('expired');
    expect(modelApprovalStatus(policy, { revoked_at: '2026-09-20T01:00:00Z' }, now).reason).toBe('revoked');
  });
});
