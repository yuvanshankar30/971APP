export const REJECT_EDIT_ACTION_ID = 'hub_reject_edit_pr';
export const APPROVE_EDIT_ACTION_ID = 'hub_approve_edit_pr';

export function changeLeadReviewBlocks({ requesterName, request, summary, prUrl, prNumber, approvalStatus = null }) {
  const requester = requesterName || 'an unknown Slack user';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Edit review needed*\n${requester} requested: ${request}\n\n${summary || 'A draft pull request was created.'}`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve & merge' },
          style: 'primary',
          action_id: APPROVE_EDIT_ACTION_ID,
          value: String(prNumber),
          confirm: {
            title: { type: 'plain_text', text: 'Approve and merge this draft?' },
            text: { type: 'mrkdwn', text: 'Spartans Hub will first require all GitHub checks to pass and an approving Gemini code review. It will merge only if both gates pass.' },
            confirm: { type: 'plain_text', text: 'Approve & merge' },
            deny: { type: 'plain_text', text: 'Cancel' }
          }
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject & close PR' },
          style: 'danger',
          action_id: REJECT_EDIT_ACTION_ID,
          value: String(prNumber),
          confirm: {
            title: { type: 'plain_text', text: 'Reject this draft?' },
            text: { type: 'mrkdwn', text: 'This closes the pull request and deletes its bot-created branch.' },
            confirm: { type: 'plain_text', text: 'Reject draft' },
            deny: { type: 'plain_text', text: 'Keep draft' }
          }
        }
      ]
    }
  ].concat(approvalStatus ? [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text: approvalStatus }]
  }] : []);
}

export function rejectedEditBlocks(prNumber, reviewerName) {
  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*Draft PR #${prNumber} rejected* by ${reviewerName || 'a Change Lead'}. The PR was closed and its bot-created branch was deleted.` }
  }];
}

export function mergedEditBlocks(prNumber, reviewerName, mergeUrl) {
  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*Draft PR #${prNumber} merged* by ${reviewerName || 'a Change Lead'} after GitHub checks and Gemini review passed.${mergeUrl ? ` <${mergeUrl}|View merge>.` : ''}` }
  }];
}
