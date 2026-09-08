import { redirect } from '@sveltejs/kit';

const TAB_PATHS = {
  parts: 'parts',
  plates: 'parts',
  'box-tubes': 'tubes',
  tubes: 'tubes',
  turning: 'turning',
  queue: 'jobs',
  jobs: 'jobs',
  'stock-categories': 'stock-categories'
};

export function load({ url }) {
  const params = new URLSearchParams(url.searchParams);
  const tab = params.get('tab');
  params.delete('tab');
  const destination = TAB_PATHS[tab] || 'parts';
  const query = params.toString();
  throw redirect(307, `/autocam/fusion/${destination}${query ? `?${query}` : ''}`);
}
