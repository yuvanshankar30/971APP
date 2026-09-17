import { describe, expect, it } from 'vitest';
import { GET } from './+server.js';

describe('JProg output curl installer', () => {
  it('serves a portable macOS installer tied to the requesting Hub', async () => {
    const response = GET({ url: new URL('https://hub.example/install/jprog-output') });
    const script = await response.text();

    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain("HUB_URL=${JPROG_OUTPUT_HUB_URL:-'https://hub.example'}");
    expect(script).toContain('OUTPUT_DIR=${JPROG_OUTPUT_DIR:-"$HOME/Desktop/Output"}');
    expect(script).toContain('https://github.com/yuvanshankar30/output.git');
    expect(script).toContain('org.spartanshub.jprog-output-sync');
    expect(script).toContain('StartInterval');
    expect(script).not.toContain('__JPROG_OUTPUT_HUB_ORIGIN__');
  });
});
