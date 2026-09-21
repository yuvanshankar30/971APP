const PHOTO_TYPES = new Set(['smugmug-photo', 'imgur', 'instagram-image', 'cdphotothread']);

export function mediaImageUrl(media) {
  if (!media) return '';
  if (media.type === 'avatar' && media.details?.base64Image) {
    return `data:image/png;base64,${media.details.base64Image}`;
  }
  return String(
    media.direct_url
      || media.details?.image_url
      || media.details?.image_url_med
      || media.details?.image_url_sm
      || ''
  ).trim();
}

export function bestTeamPhoto(media = []) {
  const usable = media
    .filter((item) => mediaImageUrl(item))
    .sort((a, b) => {
      const aPhoto = PHOTO_TYPES.has(a.type) ? 1 : 0;
      const bPhoto = PHOTO_TYPES.has(b.type) ? 1 : 0;
      return bPhoto - aPhoto || Number(Boolean(b.preferred)) - Number(Boolean(a.preferred));
    });
  return usable[0] || null;
}

export function matchVideoUrl(match) {
  const youtube = (match?.videos || []).find((video) => video?.type === 'youtube' && video?.key);
  if (youtube) return `https://www.youtube.com/watch?v=${encodeURIComponent(youtube.key)}`;
  return match?.key ? `https://www.thebluealliance.com/match/${encodeURIComponent(match.key)}` : '';
}

export function matchVideoSources(match) {
  const matchKey = String(match?.key || '').trim();
  const sources = [];
  for (const video of match?.videos || []) {
    const provider = String(video?.type || '').trim().toLowerCase();
    const externalId = String(video?.key || '').trim();
    if (!provider || !externalId) continue;
    let url = '';
    if (provider === 'youtube') url = `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}`;
    else if (provider === 'twitch') url = `https://www.twitch.tv/videos/${encodeURIComponent(externalId)}`;
    if (!url) continue;
    sources.push({
      provider, external_id: externalId, url,
      label: `${provider === 'youtube' ? 'YouTube' : 'Twitch'} · ${externalId}`,
      review_only: true, calibrated: false,
      provenance: { resolver: 'tba_match_videos', match_key: matchKey }
    });
  }
  return sources;
}
