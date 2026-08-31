// Central permission definitions and helpers
export const PERMISSIONS = [
  'CREATE_SUBSYSTEMS',
  'CREATE_BUILDS',
  'APPROVE_PURCHASES',
  'PLACE_ORDERS_MISC',
  'BAN_USERS',
  'PROMOTE_USERS',
  'APPROVE_USERS',
  'CAN_SEE_ROUTES',
  'EDIT_PERMISSIONS',
  'VIEW_ADMIN_PANEL',
  'VIEW_PURCHASING_ADMIN',
  'ADD_VENDORS',
  'EDIT_BUDGETS',
  // Scouting system permissions
  'NOTE_SCOUT_ADMIN', // can manage note scouting assignments
  'DATA_SCOUT_ADMIN', // can manage data scouting assignments
  'DATA_SCOUT_MEMBER', // eligible to be assigned to data scouting
  'VIDEO_SCOUT_MEMBER', // eligible for future video scouting workflows
  'MANAGE_ATTENDANCE',
  // Vision scouting (see scoutingvision.md) is open to every approved user,
  // same as the rest of Competition - only the "push results into real
  // scout_data_events/power rankings" action is gated, since that's a
  // meaningfully higher-stakes action than just using the tool.
  'VISION_RELEASE'
];

export const GENERAL_ROLES = {
  NONE: 'none',
  MEMBER: 'member',
  SUBSYSTEM_LEAD: 'subsystem_lead',
  LEAD: 'lead'
};

export const PURCHASING_ROLES = {
  BASIC: 'basic',
  APPROVER: 'approver',
  LEAD: 'lead',
  BUDGETING: 'budgeting'
};

export const TEAM_ROLES = {
  COMPETITION_LEAD: 'Competition Lead',
  MECHANICAL_LEAD: 'Mechanical Lead',
  SOFTWARE_LEAD: 'Software Lead',
  MANUFACTURING_LEAD: 'Manufacturing Lead',
  MANUFACTURING_MEMBER: 'Manufacturing Member',
  PURCHASING_LEAD: 'Purchasing Lead',
  CAD_MEMBER: 'CAD Member',
  SOFTWARE_MEMBER: 'Software Member',
  OTHER: 'Other'
};

// FRC Team affiliation options (971, 9584, or Mentor)
export const FRC_TEAMS = {
  TEAM_971: '971',
  TEAM_9584: '9584',
  MENTOR: 'Mentor'
};

// Options for filtering rosters by FRC team
export const ROSTER_TARGET_OPTIONS = {
  ALL: 'all',
  STUDENTS: 'students', // Both 971 and 9584
  TEAM_971: '971',
  TEAM_9584: '9584'
};

export const GENERAL_ROLE_PERMISSIONS = {
  [GENERAL_ROLES.NONE]: [],
  [GENERAL_ROLES.MEMBER]: ['CAN_SEE_ROUTES', 'PLACE_ORDERS_MISC'],
  [GENERAL_ROLES.SUBSYSTEM_LEAD]: ['CAN_SEE_ROUTES', 'PLACE_ORDERS_MISC', 'CREATE_BUILDS', 'CREATE_SUBSYSTEMS', 'MANAGE_ATTENDANCE'],
  [GENERAL_ROLES.LEAD]: ['CAN_SEE_ROUTES', 'PLACE_ORDERS_MISC', 'CREATE_BUILDS', 'CREATE_SUBSYSTEMS', 'VIEW_ADMIN_PANEL', 'PROMOTE_USERS', 'APPROVE_USERS', 'EDIT_PERMISSIONS', 'MANAGE_ATTENDANCE']
};

export const PURCHASING_ROLE_PERMISSIONS = {
  [PURCHASING_ROLES.BASIC]: ['PLACE_ORDERS_MISC'],
  [PURCHASING_ROLES.APPROVER]: ['PLACE_ORDERS_MISC', 'APPROVE_PURCHASES'],
  [PURCHASING_ROLES.LEAD]: ['PLACE_ORDERS_MISC', 'APPROVE_PURCHASES', 'VIEW_PURCHASING_ADMIN', 'ADD_VENDORS'],
  [PURCHASING_ROLES.BUDGETING]: ['EDIT_BUDGETS']
};

const ROSTER_KEY_PERMISSIONS = {
  'Scouting Admin': ['DATA_SCOUT_ADMIN', 'NOTE_SCOUT_ADMIN'],
  'Video Scout Member': ['VIDEO_SCOUT_MEMBER'],
  'Data Scout Member': ['DATA_SCOUT_MEMBER'],
  'Video Scout Lead': [], // Add if needed
  'Data Scout Lead': ['DATA_SCOUT_ADMIN', 'NOTE_SCOUT_ADMIN']
};

// Some team roles carry permissions of their own, independent of the general /
// purchasing role axes. Purchasing Lead grants full control over the purchasing
// tab (place/approve orders, purchasing admin, add vendors, edit budgets).
export const TEAM_ROLE_PERMISSIONS = {
  [TEAM_ROLES.PURCHASING_LEAD]: ['CAN_SEE_ROUTES', 'PLACE_ORDERS_MISC', 'APPROVE_PURCHASES', 'VIEW_PURCHASING_ADMIN', 'ADD_VENDORS', 'EDIT_BUDGETS']
};

export function getRoleDerivedPermissions({ general_role = GENERAL_ROLES.NONE, purchasing_role = PURCHASING_ROLES.BASIC, team_role, roster_keys = [] } = {}) {
  const derived = new Set();
  (GENERAL_ROLE_PERMISSIONS[general_role] || []).forEach((perm) => derived.add(perm));
  (PURCHASING_ROLE_PERMISSIONS[purchasing_role] || []).forEach((perm) => derived.add(perm));
  (TEAM_ROLE_PERMISSIONS[team_role] || []).forEach((perm) => derived.add(perm));

  if (Array.isArray(roster_keys)) {
    for (const key of roster_keys) {
      (ROSTER_KEY_PERMISSIONS[key] || []).forEach((perm) => derived.add(perm));
    }
  }

  return derived;
}

export function hasPermission(user, perm) {
  if (!user) return false;
  // role === 'admin' is a superuser (legacy support)
  if (user.role === 'admin') return true;

  // Check General Role - default to 'none' (pending approval) if not set
  const generalRole = user.general_role || GENERAL_ROLES.NONE;
  if (GENERAL_ROLE_PERMISSIONS[generalRole]?.includes(perm)) return true;

  // Check Purchasing Role
  const purchasingRole = user.purchasing_role || PURCHASING_ROLES.BASIC;
  if (PURCHASING_ROLE_PERMISSIONS[purchasingRole]?.includes(perm)) return true;

  // Check Team Role (e.g. Purchasing Lead grants full purchasing control)
  if (user.team_role && TEAM_ROLE_PERMISSIONS[user.team_role]?.includes(perm)) return true;

  // Check Roster Permissions (assuming user.roster_keys is an array of strings)
  if (user.roster_keys && Array.isArray(user.roster_keys)) {
    for (const key of user.roster_keys) {
      if (ROSTER_KEY_PERMISSIONS[key]?.includes(perm)) return true;
    }
  }

  // Legacy permissions array check
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

export function isManufacturingLead(user) {
  return user?.team_role === TEAM_ROLES.MANUFACTURING_LEAD;
}

// Devs are a tier above regular admins (currently the two account owners):
// they can see/manage things no other admin can, and no one but another dev
// can edit a dev's own roles or remove/ban them. Distinct from role==='admin'
// so promoting more people to admin later doesn't implicitly grant this tier.
export function isDev(user) {
  return !!user?.is_dev;
}

// Temporary CAM review allowlist — only these leads may CAM review for now.
// Replace with a role-based check when ready.
export const CAM_REVIEW_LEADS = ['Liam', 'Caden', 'Arya', 'Arnav', 'David'];

export function canCamReview(user) {
  if (!user) return false;
  const firstName = (user.full_name || '').trim().split(/\s+/)[0];
  return CAM_REVIEW_LEADS.includes(firstName);
}

// Who can open any purchasing entry's full details and delete it, regardless of
// status: admins and Purchasing Leads (who hold VIEW_PURCHASING_ADMIN).
export function canManagePurchasing(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return hasPermission(user, 'VIEW_PURCHASING_ADMIN');
}

// Who can delete parts in the manufacturing hub: admins and Manufacturing Leads.
export function canDeleteParts(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return isManufacturingLead(user);
}

// Who can create/edit AutoCAM machine profiles, materials, and tools: admins,
// Manufacturing Leads, and anyone holding a general "Lead" or "Subsystem Lead"
// role. Machine profiles aren't scoped to a single subsystem, so this uses
// the general_role tier rather than a specific subsystem's lead_user_id.
export function canManageCamProfiles(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (isManufacturingLead(user)) return true;
  return user.general_role === GENERAL_ROLES.LEAD || user.general_role === GENERAL_ROLES.SUBSYSTEM_LEAD;
}

// Who can create orders — bundle requested items into an order and enter the
// total cost after shipping. Restricted to admins, Purchasing Leads, and
// mentors (frc_team = 'Mentor'). Everyone else can only *request* items via
// PLACE_ORDERS_MISC; approving requests is a separate step (APPROVE_PURCHASES).
export function canCreateOrders(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.frc_team === FRC_TEAMS.MENTOR) return true;
  return user.team_role === TEAM_ROLES.PURCHASING_LEAD;
}

// Who can approve or reject purchase requests: admins, mentors (frc_team =
// 'Mentor'), and anyone holding APPROVE_PURCHASES (purchasing approver/lead
// roles and the Purchasing Lead team role).
export function canApprovePurchases(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.frc_team === FRC_TEAMS.MENTOR) return true;
  return hasPermission(user, 'APPROVE_PURCHASES');
}

export function normalizePermissions(arr) {
  if (!arr) return [];
  if (Array.isArray(arr)) return arr.map(String);
  return [String(arr)];
}
