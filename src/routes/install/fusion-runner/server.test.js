import { describe, expect, it } from 'vitest';
import { GET } from './+server.js';

describe('Fusion Runner curl installer', () => {
  it('serves an executable shell bootstrap tied to the requesting Hub', async () => {
    const response = GET({ url: new URL('https://hub.example/install/fusion-runner') });
    const script = await response.text();

    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain("HUB_URL=${FUSION_RUNNER_HUB_URL:-'https://hub.example'}");
    expect(script).toContain('manifest.json?install=$(date +%s)');
    expect(script).toContain('checksum mismatch; refusing to install');
    expect(script).toContain('archive contains an unsafe path');
    expect(script).toContain('FUSION_RUNNER_INSTALL_BASE_URL="$HUB_URL"');
    expect(script).not.toContain('__FUSION_HUB_ORIGIN__');
  });
});
