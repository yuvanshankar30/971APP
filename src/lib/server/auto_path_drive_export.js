import { env } from '$env/dynamic/private';
import { autoPathImageFileName, renderAutoPathImage } from '$lib/autoPathImage.js';
import { getServiceAccountAccessToken } from '$lib/server/google_service_account.js';
import { uploadFileToDriveFolder } from '$lib/server/google_drive.js';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Save is intentionally never held hostage by an optional external export.
// Callers receive the result and can tell the scout whether Drive was skipped
// or unavailable, while the path remains safely stored in Supabase.
export async function exportAutoPathImageToDrive(autoPath, dependencies = {}) {
  const folderId = String(dependencies.folderId ?? env.SCOUTING_AUTO_PATHS_DRIVE_FOLDER_ID ?? '').trim();
  const serviceAccountJson = dependencies.serviceAccountJson ?? env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  if (!folderId) return { ok: false, skipped: true, reason: 'not-configured' };
  if (!serviceAccountJson) return { ok: false, skipped: true, reason: 'no-service-account' };

  try {
    const getAccessToken = dependencies.getAccessToken || getServiceAccountAccessToken;
    const uploadFile = dependencies.uploadFile || uploadFileToDriveFolder;
    const imageInput = {
      eventKey: autoPath.eventKey ?? autoPath.event_key,
      teamKey: autoPath.teamKey ?? autoPath.team_key,
      name: autoPath.name,
      alliance: autoPath.alliance,
      path: autoPath.path,
      createdAt: autoPath.createdAt ?? autoPath.created_at
    };
    const accessToken = await getAccessToken(serviceAccountJson, DRIVE_FILE_SCOPE);
    const filename = autoPathImageFileName(imageInput);
    const file = await uploadFile(accessToken, folderId, filename, renderAutoPathImage(imageInput), 'image/svg+xml');
    return { ok: true, fileId: file.id, fileName: file.name || filename, url: file.webViewLink || null };
  } catch (error) {
    console.error('Could not export saved autonomous path to Drive:', error);
    return { ok: false, skipped: false, reason: 'drive-export-failed' };
  }
}
