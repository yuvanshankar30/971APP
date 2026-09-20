export function modelApprovalStatus(policy, approval, now = Date.now()) {
  if (!policy?.require_approved_model) return { allowed: true, reason: 'policy_disabled' };
  if (!approval) return { allowed: false, reason: 'not_approved' };
  if (approval.revoked_at) return { allowed: false, reason: 'revoked' };
  if (approval.expires_at && new Date(approval.expires_at).getTime() <= now) {
    return { allowed: false, reason: 'expired' };
  }
  return { allowed: true, reason: 'approved' };
}
