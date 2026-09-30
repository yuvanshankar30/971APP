export const REJECT_EDIT_ACTION_ID = 'hub_reject_edit_pr';

export function changeLeadReviewBlocks({ requesterName, request, summary, prUrl, prNumber }) {
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
        { type: 'button', text: { type: 'plain_text', text: 'Review PR' }, url: prUrl, action_id: 'hub_review_edit_pr' },
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
  ];
}

export function rejectedEditBlocks(prNumber, reviewerName) {
  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*Draft PR #${prNumber} rejected* by ${reviewerName || 'a Change Lead'}. The PR was closed and its bot-created branch was deleted.` }
  }];
}
