import { describe, expect, it } from 'vitest';
import { GET } from './+server.js';

describe('Windows JProg output installer', () => {
  it('serves a PowerShell installer with a Desktop junction and scheduled sync worker', async () => {
    const response = GET({ url: new URL('https://hub.example/install/jprog-output/windows') });
    const script = await response.text();

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(script).toContain("$HubUrl = if ($env:JPROG_OUTPUT_HUB_URL) { $env:JPROG_OUTPUT_HUB_URL } else { 'https://hub.example' }");
    expect(script).toContain("New-Item -ItemType Junction -Path $DesktopOutputDir -Target $RepoDir");
    expect(script).toContain('git pull --rebase --autostash');
    expect(script).toContain('git diff --cached --name-status -M');
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).not.toContain('__JPROG_OUTPUT_HUB_ORIGIN__');
  });
});
