import crypto from 'node:crypto';

const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

// Shared by Drive exports that create a small generated file. Keeping this
// here prevents scouting from depending on the AutoCAM Drive watcher.
export async function uploadFileToDriveFolder(accessToken, folderId, filename, content, mimeType, fetchImpl = fetch) {
  const boundary = `971hub-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  const response = await fetchImpl(`${DRIVE_UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Drive upload failed (${response.status}): ${data.error?.message || response.statusText}`);
  return data;
}
