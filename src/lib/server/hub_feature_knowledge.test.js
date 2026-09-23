import { describe, expect, it } from 'vitest';
import { answerHubFeatureQuestion, classifyHubFeatureQuestion, HUB_FEATURES } from './hub_feature_knowledge.js';

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
    expect(answer).toContain('Accuracy (<https://spartanshub.spartanrobotics.org/epa?tab=accuracy|Open>):');
    expect(answer).toContain('<https://spartanshub.spartanrobotics.org/epa|EPA>');
  });

  it('explains JProg screens, output, and exact routes', () => {
    const answer = answerHubFeatureQuestion('Where are the JProg settings?');
    expect(answer).toContain('Manufacturing → JustinProg');
    expect(answer).toContain('/jprog/settings');
    expect(answer).toContain('*Settings — JProg*');
  });

  it('answers a uniquely named subtab even when the parent tab is omitted', () => {
    const answer = answerHubFeatureQuestion('What does the Accuracy subtab show?');
    expect(answer).toContain('*Accuracy — EPA*');
    expect(answer).toContain('chronological back-test');
    expect(answer).toContain('Competition → EPA → Accuracy');
    expect(answer).toContain('<https://spartanshub.spartanrobotics.org/epa?tab=accuracy|Accuracy>');
  });

  it('uses the named parent to disambiguate generic subtabs', () => {
    const answer = answerHubFeatureQuestion('Where is the Jobs tab inside Fusion AutoCAM?');
    expect(answer).toContain('*Jobs — Fusion AutoCAM*');
    expect(answer).toContain('queued, running, completed, and failed work');
    expect(answer).toContain('<https://spartanshub.spartanrobotics.org/autocam/fusion/jobs|Jobs>');
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

  it('asks for clarification instead of routing a generic feature keyword', () => {
    expect(classifyHubFeatureQuestion('What is strategy in chess?')).toMatchObject({ kind: 'clarify', feature: { name: 'Strategy' } });
    expect(answerHubFeatureQuestion('What is strategy in chess?')).toContain('Do you mean the Spartans Hub *Strategy* area?');
    expect(answerHubFeatureQuestion('What does the Strategy tab do in Spartans Hub?')).toContain('Competition → Strategy');
  });
});
