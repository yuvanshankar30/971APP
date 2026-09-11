import { env } from '$env/dynamic/private';
import { authorizeFusionRunnerSetup, FusionRunnerSetupError } from '$lib/server/fusion_runner_setup.js';
import { createClient } from '@supabase/supabase-js';

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Fusion Runner setup is missing Supabase service configuration');
  return createClient(url, serviceKey);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page({ sessionId = '', message = 'Enter the Fusion Runner token.', showInput = true, status = 200 }) {
  const input = showInput ? `
      <form method="post">
        <input type="hidden" name="session" value="${escapeHtml(sessionId)}">
        <input name="token" type="password" aria-label="Fusion Runner token" autocomplete="off" autofocus required>
      </form>` : '';
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Fusion Runner Setup</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(30rem, calc(100% - 2rem)); }
      p { margin: 0 0 0.6rem; font-size: 0.9rem; color: color-mix(in srgb, CanvasText 70%, transparent); }
      input[type="password"] { box-sizing: border-box; width: 100%; height: 2.75rem; padding: 0 0.75rem; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 4px; background: Canvas; color: CanvasText; font: inherit; }
      input:focus { outline: 2px solid #cc8b00; outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <p>${escapeHtml(message)}</p>${input}
    </main>
  </body>
</html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function GET({ url }) {
  return page({ sessionId: url.searchParams.get('session') || '' });
}

export async function POST({ request }) {
  const form = await request.formData();
  const sessionId = String(form.get('session') || '');
  try {
    await authorizeFusionRunnerSetup(getServiceSupabase(), env, sessionId, String(form.get('token') || ''));
    return page({ message: 'Runner configured. You can close this page.', showInput: false });
  } catch (error) {
    const status = error instanceof FusionRunnerSetupError ? error.status : 500;
    const message = status === 401
      ? 'Fusion Runner token is wrong.'
      : error?.message || 'Fusion Runner setup failed.';
    return page({ sessionId, message, status });
  }
}
