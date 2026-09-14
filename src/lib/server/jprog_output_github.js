const OUTPUT_ROOT = 'Jprog Output/';

export function githubJprogOutputPath(storagePath) {
  const path = String(storagePath || '');
  if (!path.startsWith(OUTPUT_ROOT)) throw new Error('JProg output must be stored under Jprog Output');
  const repositoryPath = path.slice(OUTPUT_ROOT.length);
  if (!/^\d{8}\/[A-Za-z0-9._-]+\.(?:ngc|tap)$/i.test(repositoryPath)) throw new Error('Invalid JProg output path');
  return repositoryPath;
}

export function githubContentsPayload(path, content) {
  return { message: `Add JProg output ${path}`, content: Buffer.from(content).toString('base64') };
}
