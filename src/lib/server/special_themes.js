export function canAccessSpecialThemes(user) {
  return !!user;
}

export const DIGGI_THEME_ID = 'theme-diggi';
// Diggi is a single global launch window, not a per-user trial. Once this
// instant passes the server stops publishing it and there is no path that
// can make it available again.
export const DIGGI_THEME_AVAILABLE_AT = Date.parse('2026-10-01T03:27:03.000Z');
export const DIGGI_THEME_EXPIRES_AT = DIGGI_THEME_AVAILABLE_AT + (20 * 60 * 1000);

export const SPECIAL_THEME_GROUPS = [
  { label: 'Atmosphere', themes: [
    { id: 'theme-kind-of-blue', label: 'Kind of Blue', preview: ['#18314a', '#277da1'], palette: ['#071827', '#102a40', '#4aa8d8', '#e7f4fb'] },
    { id: 'theme-funky-fresh', label: 'Funky Fresh', preview: ['#6d5b97', '#52b788'], palette: ['#17152a', '#282342', '#5ecf9a', '#f0ecff'] },
    { id: 'theme-jazz-club', label: 'Jazz Club', preview: ['#8b0000', '#240046'], palette: ['#150510', '#280919', '#d42645', '#fae9ee'] },
    { id: 'theme-neon-night', label: 'Neon Night', preview: ['#1a053a', '#ff00aa'], palette: ['#0d021c', '#1a053a', '#ff00aa', '#ffe5f4'] }
  ] },
  { label: 'Single color', themes: [
    { id: 'theme-aubergine', label: 'Aubergine', preview: ['#2b0a3d', '#7b2cbf'], palette: ['#16091c', '#2a1033', '#b15bd1', '#f4e9f8'] },
    { id: 'theme-clementine', label: 'Clementine', preview: ['#542000', '#e85d04'], palette: ['#1e0c03', '#351306', '#f27422', '#fff0e6'] },
    { id: 'theme-banana', label: 'Banana', preview: ['#3d2d00', '#d4a017'], palette: ['#181305', '#2c2208', '#e0b126', '#fff7d6'] },
    { id: 'theme-jade', label: 'Jade', preview: ['#023c2c', '#2a9d8f'], palette: ['#041914', '#092c23', '#37bd91', '#e1fbf1'] },
    { id: 'theme-lagoon', label: 'Lagoon', preview: ['#003049', '#00b4d8'], palette: ['#041722', '#082b3c', '#20b9d6', '#e1f8fc'] },
    { id: 'theme-barbra', label: 'Barbra', preview: ['#5f0014', '#d90429'], palette: ['#1d0208', '#350610', '#e3264f', '#ffe8ed'] },
    { id: 'theme-matcha', label: 'Matcha', preview: ['#293b21', '#8ca86e'], palette: ['#121a0f', '#1b2615', '#8ca86e', '#eff5ea'] }
  ] },
  { label: 'Fun and new', themes: [
    { id: 'theme-raspberry-beret', label: 'Raspberry Beret', preview: ['#3c001d', '#d0004b'], palette: ['#1b0612', '#330a1d', '#db2464', '#ffe9f1'] },
    { id: 'theme-big-business', label: 'Big Business', preview: ['#111827', '#1d4ed8'], palette: ['#080f22', '#111c38', '#3d6fea', '#eaf0ff'] },
    { id: 'theme-mint-chip', label: 'Mint Chip', preview: ['#053b2c', '#264de4'], palette: ['#061817', '#0b2927', '#54d6b1', '#e5fff8'] },
    { id: 'theme-pbj', label: 'PB&J', preview: ['#5a2a0c', '#9d174d'], palette: ['#1b0d12', '#321722', '#cf4776', '#fbeaf0'] },
    { id: 'theme-chill-vibes', label: 'Chill Vibes', preview: ['#003d36', '#006d77'], palette: ['#041719', '#082a2e', '#27a9b7', '#e2fbfd'] },
    { id: DIGGI_THEME_ID, label: 'Diggi', preview: ['#111111', '#ff5a00'], palette: ['#050505', '#111111', '#ff5a00', '#fff2ec'], expiresAt: new Date(DIGGI_THEME_EXPIRES_AT).toISOString() }
  ] }
];

export function getSpecialThemeGroups(now = Date.now()) {
  return SPECIAL_THEME_GROUPS
    .map((group) => ({
      ...group,
      themes: group.themes.filter((theme) => theme.id !== DIGGI_THEME_ID || now < DIGGI_THEME_EXPIRES_AT)
    }))
    .filter((group) => group.themes.length > 0);
}
