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

// Picks the best webcast off an event's TBA `webcasts` array and returns an
// embeddable iframe URL for the types we know how to embed (youtube/twitch),
// or a plain link URL for everything else (ustream/iframe/html5/rtmp/mms
// aren't embeddable the same way, and are rare in practice).
export function eventWebcastEmbed(webcasts = []) {
  const usable = (webcasts || []).find((cast) => cast?.type === 'youtube' && cast?.channel)
    || (webcasts || []).find((cast) => cast?.type === 'twitch' && cast?.channel)
    || (webcasts || [])[0];
  if (!usable) return null;
  if (usable.type === 'youtube') {
    return { embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(usable.channel)}?autoplay=0`, linkUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(usable.channel)}` };
  }
  if (usable.type === 'twitch') {
    const parent = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return { embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(usable.channel)}&parent=${encodeURIComponent(parent)}&autoplay=false`, linkUrl: `https://www.twitch.tv/${encodeURIComponent(usable.channel)}` };
  }
  const linkUrl = usable.channel && /^https?:\/\//.test(usable.channel) ? usable.channel : '';
  return { embedUrl: null, linkUrl };
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
