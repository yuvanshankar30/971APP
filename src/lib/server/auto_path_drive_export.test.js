import { describe, expect, it, vi } from 'vitest';
import { exportAutoPathImageToDrive } from './auto_path_drive_export.js';

describe('autonomous path Drive export', () => {
  const route = {
    eventKey: '2026test',
    teamKey: 'frc971',
    name: 'Center route',
    alliance: 'red',
    path: [[10, 20], [20, 30]],
    createdAt: '2026-09-02T19:11:12.123Z'
  };

  it('does nothing until a dedicated Drive folder is configured', async () => {
    await expect(exportAutoPathImageToDrive(route, { folderId: '', serviceAccountJson: '{}' }))
      .resolves.toEqual({ ok: false, skipped: true, reason: 'not-configured' });
  });

  it('uploads the rendered route image to the configured folder', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('drive-token');
    const uploadFile = vi.fn().mockResolvedValue({ id: 'file-123', name: 'route.svg', webViewLink: 'https://drive.test/file-123' });

    await expect(exportAutoPathImageToDrive(route, {
      folderId: 'folder-123',
      serviceAccountJson: '{"private_key":"test"}',
      getAccessToken,
      uploadFile
    })).resolves.toEqual({ ok: true, fileId: 'file-123', fileName: 'route.svg', url: 'https://drive.test/file-123' });

    expect(getAccessToken).toHaveBeenCalledWith('{"private_key":"test"}', 'https://www.googleapis.com/auth/drive.file');
    expect(uploadFile).toHaveBeenCalledWith(
      'drive-token',
      'folder-123',
      '2026test_frc971_Center-route_2026-09-02T19-11-12-123Z.svg',
      expect.stringContaining('<svg'),
      'image/svg+xml'
    );
  });

  it('accepts the snake_case fields returned by the saved-path table', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ id: 'file-456' });
    await exportAutoPathImageToDrive({
      event_key: '2026test',
      team_key: 'frc971',
      name: 'Saved route',
      alliance: 'blue',
      path: [[10, 20], [20, 30]],
      created_at: '2026-09-02T19:11:12.123Z'
    }, {
      folderId: 'folder-123',
      serviceAccountJson: '{"private_key":"test"}',
      getAccessToken: vi.fn().mockResolvedValue('drive-token'),
      uploadFile
    });

    expect(uploadFile.mock.calls[0][2]).toBe('2026test_frc971_Saved-route_2026-09-02T19-11-12-123Z.svg');
    expect(uploadFile.mock.calls[0][3]).toContain('frc971 - Saved route');
  });
});
