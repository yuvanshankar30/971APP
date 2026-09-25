// Logs every "@Spartans Hub" mention handleHubAppMention finishes handling,
// to hub_bot_requests (see migrations/20260925_hub_bot_requests.sql). Direct
// instruction, motivated by a real /edit failure that was only diagnosable
// by cross-referencing a Slack screenshot against raw Cloud Run stdout logs
// by hand - this gives that picture a permanent, queryable home.
//
// Logging failures must never break the actual Slack reply the bot already
// sent - callers should not await this without a surrounding try/catch, and
// this function itself swallows its own errors rather than throwing.
export async function logBotRequest(supa, {
  slackUserId = null,
  channelId = null,
  threadTs = null,
  eventTs = null,
  requestType,
  question = null,
  outcome,
  errorMessage = null,
  durationMs = null,
  responseTs = null
} = {}) {
  if (!supa) return;
  try {
    const { error } = await supa.from('hub_bot_requests').insert({
      slack_user_id: slackUserId,
      channel_id: channelId,
      thread_ts: threadTs,
      event_ts: eventTs,
      request_type: requestType || 'unknown',
      // Slack messages can run long; the column has no length limit, but a
      // logging row is meant to be skimmed, not a full transcript store.
      question: question ? String(question).slice(0, 2000) : null,
      outcome,
      error_message: errorMessage ? String(errorMessage).slice(0, 2000) : null,
      duration_ms: durationMs,
      response_ts: responseTs
    });
    if (error) console.error('Could not log bot request', error.message);
  } catch (error) {
    console.error('Could not log bot request', error?.message || error);
  }
}

// Mirrors handleHubAppMention's own if/else-if branch order in
// hub_slack_assistant.js exactly, so the logged request_type always matches
// which branch actually answered - kept here as a separate, pure function
// (no side effects, nothing awaited) purely for classification, called
// once per request after the real handling already happened.
export function classifyBotRequestType(question, {
  isCodeChangeRequest,
  isHubStatusRequest,
  isTeamReportStatusRequest,
  isScoutingAssignmentQuestion,
  isAdminProfileQuestion,
  isNamedPurchasingQuestion,
  isFusionRunnerSetupQuestion
}) {
  if (!question) return 'empty';
  if (isCodeChangeRequest(question)) return 'edit';
  if (isHubStatusRequest(question)) return 'status';
  if (isTeamReportStatusRequest(question)) return 'team-report';
  if (isScoutingAssignmentQuestion(question)) return 'scouting-assignment';
  if (isAdminProfileQuestion(question)) return 'admin-profile';
  if (isNamedPurchasingQuestion(question)) return 'purchasing';
  if (isFusionRunnerSetupQuestion(question)) return 'fusion-runner-setup';
  return 'qa';
}
