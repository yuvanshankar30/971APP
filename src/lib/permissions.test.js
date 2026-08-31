import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  getRoleDerivedPermissions,
  canCreateOrders,
  canApprovePurchases,
  canManagePurchasing,
  normalizePermissions,
  TEAM_ROLES,
  FRC_TEAMS,
  PERMISSIONS
} from './permissions.js';

describe('hasPermission', () => {
  it('returns false for missing user', () => {
    expect(hasPermission(null, 'CAN_SEE_ROUTES')).toBe(false);
    expect(hasPermission(undefined, 'CAN_SEE_ROUTES')).toBe(false);
  });

  it('grants everything to legacy admins', () => {
    const admin = { role: 'admin' };
    for (const perm of PERMISSIONS) {
      expect(hasPermission(admin, perm)).toBe(true);
    }
  });

  it('grants via general_role', () => {
    const member = { general_role: 'member' };
    expect(hasPermission(member, 'CAN_SEE_ROUTES')).toBe(true);
    expect(hasPermission(member, 'PLACE_ORDERS_MISC')).toBe(true);
    expect(hasPermission(member, 'APPROVE_PURCHASES')).toBe(false);
    expect(hasPermission(member, 'VIEW_ADMIN_PANEL')).toBe(false);
  });

  it('treats general_role "none" as pending approval (no permissions)', () => {
    const pending = { general_role: 'none', purchasing_role: 'budgeting' };
    expect(hasPermission(pending, 'CAN_SEE_ROUTES')).toBe(false);
  });

  it('grants via purchasing_role independently of general_role', () => {
    const approver = { general_role: 'none', purchasing_role: 'approver' };
    expect(hasPermission(approver, 'APPROVE_PURCHASES')).toBe(true);
    // budgeting role grants only EDIT_BUDGETS
    const budgeting = { general_role: 'none', purchasing_role: 'budgeting' };
    expect(hasPermission(budgeting, 'EDIT_BUDGETS')).toBe(true);
    expect(hasPermission(budgeting, 'PLACE_ORDERS_MISC')).toBe(false);
  });

  it('grants the full purchasing set via the Purchasing Lead team role', () => {
    const lead = { general_role: 'none', team_role: TEAM_ROLES.PURCHASING_LEAD };
    for (const perm of [
      'CAN_SEE_ROUTES',
      'PLACE_ORDERS_MISC',
      'APPROVE_PURCHASES',
      'VIEW_PURCHASING_ADMIN',
      'ADD_VENDORS',
      'EDIT_BUDGETS'
    ]) {
      expect(hasPermission(lead, perm)).toBe(true);
    }
    expect(hasPermission(lead, 'VIEW_ADMIN_PANEL')).toBe(false);
  });

  it('falls back to the explicit permissions array', () => {
    const user = { general_role: 'none', permissions: ['MANAGE_ATTENDANCE'] };
    expect(hasPermission(user, 'MANAGE_ATTENDANCE')).toBe(true);
    expect(hasPermission(user, 'BAN_USERS')).toBe(false);
  });
});

describe('getRoleDerivedPermissions', () => {
  it('grants scouting administration permissions via the Scouting Admin roster key', () => {
    const derived = getRoleDerivedPermissions({ roster_keys: ['Scouting Admin'] });
    expect(derived.has('DATA_SCOUT_ADMIN')).toBe(true);
    expect(derived.has('NOTE_SCOUT_ADMIN')).toBe(true);
  });

  it('merges general, purchasing, and team role permissions', () => {
    const derived = getRoleDerivedPermissions({
      general_role: 'member',
      purchasing_role: 'approver',
      team_role: TEAM_ROLES.PURCHASING_LEAD
    });
    expect(derived.has('CAN_SEE_ROUTES')).toBe(true); // member
    expect(derived.has('APPROVE_PURCHASES')).toBe(true); // approver + team role
    expect(derived.has('VIEW_PURCHASING_ADMIN')).toBe(true); // team role
    expect(derived.has('VIEW_ADMIN_PANEL')).toBe(false);
  });

  it('ignores unknown roles without throwing', () => {
    const derived = getRoleDerivedPermissions({
      general_role: 'bogus',
      purchasing_role: 'bogus',
      team_role: 'Bogus Role'
    });
    expect(derived.size).toBe(0);
  });
});

describe('canCreateOrders', () => {
  it('is restricted to admins, mentors, and Purchasing Leads', () => {
    expect(canCreateOrders({ role: 'admin' })).toBe(true);
    expect(canCreateOrders({ frc_team: FRC_TEAMS.MENTOR })).toBe(true);
    expect(canCreateOrders({ team_role: TEAM_ROLES.PURCHASING_LEAD })).toBe(true);

    // Purchase approvers explicitly may NOT create orders (decoupled Jul 2026)
    expect(canCreateOrders({ purchasing_role: 'approver', general_role: 'lead' })).toBe(false);
    expect(canCreateOrders({ purchasing_role: 'lead' })).toBe(false);
    expect(canCreateOrders({ general_role: 'member', frc_team: '971' })).toBe(false);
    expect(canCreateOrders(null)).toBe(false);
  });
});

describe('canApprovePurchases', () => {
  // This is the exact gate the purchasing page's "Bulk Approve" button, its
  // select-all/per-row checkboxes, and the batched approval write all use —
  // there is no separate bulk-approve permission function. Covering every
  // role combination here is what keeps bulk-approve access correct.
  it('allows admins, mentors, and APPROVE_PURCHASES holders', () => {
    expect(canApprovePurchases({ role: 'admin' })).toBe(true);
    expect(canApprovePurchases({ frc_team: FRC_TEAMS.MENTOR })).toBe(true);
    expect(canApprovePurchases({ purchasing_role: 'approver' })).toBe(true);
    expect(canApprovePurchases({ purchasing_role: 'lead' })).toBe(true);
    expect(canApprovePurchases({ team_role: TEAM_ROLES.PURCHASING_LEAD })).toBe(true);
    expect(canApprovePurchases({ permissions: ['APPROVE_PURCHASES'] })).toBe(true);
  });

  it('denies everyday members and non-approving roles', () => {
    // Plain member: PLACE_ORDERS_MISC only, no approve
    expect(canApprovePurchases({ general_role: 'member', frc_team: '971' })).toBe(false);
    // general_role 'lead' grants admin-panel perms but NOT purchase approval —
    // easy to confuse with the Purchasing Lead *team* role, which does grant it
    expect(canApprovePurchases({ general_role: 'lead' })).toBe(false);
    // basic/budgeting purchasing roles don't grant APPROVE_PURCHASES
    expect(canApprovePurchases({ purchasing_role: 'basic' })).toBe(false);
    expect(canApprovePurchases({ purchasing_role: 'budgeting' })).toBe(false);
    // A non-Purchasing-Lead team role grants nothing here
    expect(canApprovePurchases({ team_role: TEAM_ROLES.MANUFACTURING_LEAD })).toBe(false);
    // frc_team set to a real team (not 'Mentor') grants nothing
    expect(canApprovePurchases({ frc_team: FRC_TEAMS.TEAM_971 })).toBe(false);
    expect(canApprovePurchases(null)).toBe(false);
    expect(canApprovePurchases(undefined)).toBe(false);
  });
});

describe('canManagePurchasing', () => {
  it('requires admin or VIEW_PURCHASING_ADMIN', () => {
    expect(canManagePurchasing({ role: 'admin' })).toBe(true);
    expect(canManagePurchasing({ purchasing_role: 'lead' })).toBe(true);
    expect(canManagePurchasing({ team_role: TEAM_ROLES.PURCHASING_LEAD })).toBe(true);
    expect(canManagePurchasing({ purchasing_role: 'approver' })).toBe(false);
    expect(canManagePurchasing(null)).toBe(false);
  });
});

describe('normalizePermissions', () => {
  it('handles arrays, scalars, and empty input', () => {
    expect(normalizePermissions(null)).toEqual([]);
    expect(normalizePermissions(['A', 'B'])).toEqual(['A', 'B']);
    expect(normalizePermissions('A')).toEqual(['A']);
  });
});
