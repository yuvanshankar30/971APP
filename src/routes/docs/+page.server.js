// Every *.md file in the repo, bundled as raw text at BUILD time via Vite's
// import.meta.glob - not read from disk per-request. That's a deliberate
// choice, not a style preference: this app's production runtime (Cloud Run,
// via the Dockerfile) only ever gets the compiled `build/` output copied
// into the final image, and `.dockerignore` separately excludes the docs/
// and implementations/ source folders from even reaching the build stage.
// A naive `fs.readdir` at request time would find nothing in production.
// Routing this through import.meta.glob instead means the content becomes
// part of the compiled bundle itself, so it ships regardless of what the
// deploy pipeline does or doesn't copy from the raw source tree.
//
// Excludes node_modules because some packages ship README.md files that are
// not project documentation.
const rawFiles = import.meta.glob(
  ['/**/*.md', '!/**/node_modules/**'],
  { eager: true, query: '?raw', import: 'default' }
);

function humanizeSegment(segment) {
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\.md$/i, '')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function load() {
  const files = Object.entries(rawFiles)
    .map(([fullPath, content]) => {
      // fullPath is like "/autocam/docs/cam-engineering-plan.md" - strip the
      // leading slash so it reads as a normal repo-relative path.
      const path = fullPath.replace(/^\//, '');
      const segments = path.split('/');
      const name = segments[segments.length - 1];
      const folder = segments.slice(0, -1).join('/') || '(repo root)';
      return { path, name, folder, label: humanizeSegment(name), content };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { files };
}
