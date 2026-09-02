export function canAccessSpecialThemes(user) {
  return !!user;
}

// Mint Chip is the only theme kept from the original fourteen. The rest were
// removed on request; nothing else in the app referenced them by id, and the
// selection lives in localStorage rather than on the user row, so anyone
// still holding a removed id simply falls back to the default theme the next
// time applyTheme runs (see resolveStoredTheme) rather than breaking.
//
// The group wrapper stays even at one entry - specialThemeGroups is consumed
// as a list of groups, and flattening it here would push that shape change
// into every consumer for no benefit.
export const SPECIAL_THEME_GROUPS = [
  { label: 'Themes', themes: [
    { id: 'theme-mint-chip', label: 'Mint Chip', preview: ['#053b2c', '#264de4'], palette: ['#061817', '#0b2927', '#54d6b1', '#e5fff8'] }
  ] }
];
