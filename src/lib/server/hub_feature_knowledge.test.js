import { describe, expect, it } from 'vitest';
import { answerHubFeatureQuestion, HUB_FEATURES } from './hub_feature_knowledge.js';

describe('Slack Hub feature knowledge', () => {
  it('documents every default navigation feature with routes and sections', () => {
    const names = new Set(HUB_FEATURES.map((feature) => feature.name));
    for (const required of ['Manufacturing', 'Fusion AutoCAM', 'JProg', 'Strategy', 'Drive Team', 'Match Scouting', 'Pit Scouting', 'My Scout', 'Picklist', 'Match Rankings', 'Power Rankings', 'Robot Ratings', 'EPA', 'Vision Scouting', 'Prediction Market', 'Blue Alliance', 'Scouting Admin', 'CAD', 'Build', 'Files', 'Purchasing']) {
      expect(names.has(required), `missing ${required}`).toBe(true);
    }
    expect(HUB_FEATURES.every((feature) => feature.route.startsWith('/') && feature.sections.length > 0)).toBe(true);
  });

  it('explains EPA and keeps it distinct from other ranking measures', () => {
    const answer = answerHubFeatureQuestion('What is the EPA tab and where do I find it?');
    expect(answer).toContain('Competition → EPA');
    expect(answer).toContain('Expected Points Added');
    expect(answer).toContain('not Statbotics EPA');
    expect(answer).toContain('Accuracy:');
    expect(answer).toContain('*Open:* /epa');
  });

  it('explains JProg screens, output, and exact routes', () => {
    const answer = answerHubFeatureQuestion('Where are the JProg settings and sheet editor?');
    expect(answer).toContain('Manufacturing → JustinProg');
    expect(answer).toContain('/jprog/settings');
    expect(answer).toContain('/jprog/sheets/{sheet id}');
    expect(answer).toContain('JustinProgOutput/YYYYMMDD');
  });

  it('lists navigation without sending a broad tab question to a model', () => {
    const answer = answerHubFeatureQuestion('What tabs and pages are available?');
    expect(answer).toContain('*Spartans Hub navigation:*');
    expect(answer).toContain('*Competition:*');
    expect(answer).toContain('Command/Ctrl+K');
  });

  it('does not hijack unrelated general questions', () => {
    expect(answerHubFeatureQuestion('What is computer vision?')).toBeNull();
    expect(answerHubFeatureQuestion('What is 1+1?')).toBeNull();
  });
});
