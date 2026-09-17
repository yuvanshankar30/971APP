import './lib/server/dnsFallback.js'; // must run before anything else does a network request - see file for why
import * as Sentry from '@sentry/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/public';

// Real, confirmed report: setup.py opens /install/fusion-runner/setup in
// the reader's own browser (via webbrowser.open()) so they can type their
// Fusion Runner admin token into a plain, no-JS <form method="post"> -
// there is no other way for that page to work, since it has to render and
// submit correctly with zero client-side JavaScript for a bare `python3
// setup.py` run. SvelteKit's own checkOrigin (svelte.config.js now
// disables it - it has no per-route opt-out) rejected that exact
// submission with "Cross-site POST form submissions are forbidden",
// stranding the reader mid-install with no way to finish pairing. Every
// other route in this app POSTs JSON over fetch(), never a real HTML
// form (confirmed: no route uses SvelteKit's form-actions,
// `export const actions`, anywhere) - CSRF_EXEMPT_PATHS names the one
// genuine exception, and this hook otherwise re-implements SvelteKit's
// own check faithfully for everything else.
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const CSRF_EXEMPT_PATHS = new Set(['/install/fusion-runner/setup']);

export function csrfCheck({ event, resolve }) {
  const { request, url } = event;
  const method = request.method;
  if (
    !CSRF_EXEMPT_PATHS.has(url.pathname) &&
    (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
  ) {
    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (FORM_CONTENT_TYPES.includes(contentType)) {
      const origin = request.headers.get('origin');
      if (!origin || origin !== url.origin) {
        return new Response(`Cross-site ${method} form submissions are forbidden`, { status: 403 });
      }
    }
  }
  return resolve(event);
}

// Error monitoring: no-op unless PUBLIC_SENTRY_DSN is set (locally and in
// Vercel). With no DSN, init is skipped and behavior is unchanged.
const dsn = env.PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'
  });
}

export const handle = sequence(csrfCheck, Sentry.sentryHandle());

export const handleError = Sentry.handleErrorWithSentry(({ error }) => {
  console.error('Server error:', error);
});
