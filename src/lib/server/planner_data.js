import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import {
  nextWorkMoment,
  recomputePlannerSchedule,
  roundUpToSlot,
  toDateOrNull,
  workingMinutesBetween
} from '$lib/planner/schedule.js';
import { rollupPlannerStatuses } from '$lib/planner/status.js';
import {
  PLANNER_AUTO_FIXING_TASK_DAYS,
  PLANNER_DEFAULT_MIN_DURATION_MINUTES,
  PLANNER_DEFAULT_P0_BUG_STATUS,
  PLANNER_DEFAULT_TASK_DURATION_MINUTES,
  PLANNER_DRIVE_PRACTICE_CATEGORY,
  PLANNER_FIXING_TASK_MODE,
  PLANNER_STANDARD_TASK_MODE,
  plannerItemCategory,
  plannerItemKind,
  plannerItemTaskMode,
  plannerItemType
} from '$lib/planner/constants.js';

const PLANNER_ITEM_SELECT = `
  id,
  frc_team,
  item_type,
  title,
  details,
  work_category,
  status,
  critical_level,
  duration_minutes,
  requested_duration_minutes,
  min_duration_minutes,
  manual_start_at,
  scheduled_start_at,
  scheduled_end_at,
  sort_order,
  created_by,
  created_at,
  updated_at,
  scope,
  general_type,
  subsystem_id,
  needs_manufacturing,
  attachment_path,
  attachment_name,
  attachment_uploaded_at,
  auto_completed_from_parts,
  state_before_auto_complete
`;

// The hosted production database still has the pre-merge planner schema on
// some installations: planner_items uses kind/notes/category and ownership
// lives in planner_item_owners. Keep server-side notification sweeps working
// during that migration window instead of turning a schema mismatch into a
// 500 every fifteen minutes.
const LEGACY_PLANNER_ITEM_SELECT = `
  id,
  frc_team,
  kind,
  title,
  notes,
  category,
  status,
  critical_level,
  duration_minutes,
  requested_duration_minutes,
  min_duration_minutes,
  manual_start_at,
  scheduled_start_at,
  scheduled_end_at,
  sort_order,
  created_by,
  created_at,
  updated_at,
  task_mode
`;

const P0_STATUS_ORDER = new Map([
  ['red', 0],
  ['yellow', 1],
  ['green', 2],
  ['completed', 3]
]);

export function getPlannerDbFromRequest(request) {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
}

function normalizeLegacyTaskStatus(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeP0BugStatus(value, fallback = PLANNER_DEFAULT_P0_BUG_STATUS) {
  const normalized = normalizeLegacyTaskStatus(value);
  if (normalized === 'red' || normalized === 'yellow' || normalized === 'green' || normalized === 'completed') {
    return normalized;
  }
  if (normalized === 'done' || normalized === 'closed') return 'completed';
  if (normalized === 'approved') return 'green';
  if (
    normalized === 'in_progress'
    || normalized === 'file_uploaded'
    || normalized === 'under_review'
  ) {
    return 'yellow';
  }
  if (normalized === 'open' || normalized === 'changes_requested') return 'red';
  return fallback;
}

function compareP0BugRows(a, b) {
  const leftStatus = normalizeP0BugStatus(a?.status);
  const rightStatus = normalizeP0BugStatus(b?.status);
  const leftRank = P0_STATUS_ORDER.get(leftStatus) ?? 999;
  const rightRank = P0_STATUS_ORDER.get(rightStatus) ?? 999;

  if (leftRank !== rightRank) return leftRank - rightRank;

  const leftUpdated = Date.parse(a?.updated_at || a?.created_at || '') || 0;
  const rightUpdated = Date.parse(b?.updated_at || b?.created_at || '') || 0;
  return rightUpdated - leftUpdated;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function buildPlannerFixingTaskTitle(title) {
  const bugTitle = String(title || '').trim() || 'Untitled bug';
  return `P0 Fix: ${bugTitle}`;
}

function withLegacyPlannerAliases(row) {
  const itemType = plannerItemType(row?.item_type);
  const legacyCategory = plannerItemCategory({ item_type: itemType, work_category: row?.work_category });
  return {
    ...row,
    item_type: itemType,
    kind: plannerItemKind({ item_type: itemType }),
    task_mode: plannerItemTaskMode({ item_type: itemType }),
    category: legacyCategory,
    notes: row?.details || null
  };
}

function isMissingPlannerSchemaError(error) {
  return ['42P01', '42703', 'PGRST204'].includes(error?.code)
    || /does not exist|could not find.*column/i.test(String(error?.message || ''));
}

function modernizeLegacyPlannerItem(row) {
  const itemType = row?.kind === 'milestone' ? 'milestone' : 'task';
  return withLegacyPlannerAliases({
    ...row,
    item_type: itemType,
    details: row?.notes || null,
    work_category: row?.category || null,
    scope: null,
    general_type: null,
    subsystem_id: null,
    needs_manufacturing: false,
    attachment_path: null,
    attachment_name: null,
    attachment_uploaded_at: null,
    auto_completed_from_parts: false,
    state_before_auto_complete: null
  });
}

function withLegacyP0Aliases(row, owner = null, creator = null, subsystem = null, partIds = [], reportedDrivePractices = []) {
  const ownerId = owner?.id || null;
  return {
    ...withLegacyPlannerAliases(row),
    description: row?.details || null,
    owner_id: ownerId,
    owner,
    assignee_id: ownerId,
    assignee: owner,
    reviewer_id: null,
    reviewer: null,
    creator,
    subsystem,
    needs_review: false,
    review_decision: null,
    review_notes: null,
    reviewed_at: null,
    deadline_at: null,
    status: normalizeP0BugStatus(row?.status),
    part_ids: partIds,
    parts_id: partIds[0] || null,
    reported_drive_practices: reportedDrivePractices
  };
}

async function fetchSubsystemMap(db, subsystemIds = []) {
  const uniqueIds = Array.from(new Set((subsystemIds || []).filter(Boolean)));
  if (!uniqueIds.length) return new Map();

  const { data, error } = await db
    .from('subsystems')
    .select('id, name')
    .in('id', uniqueIds);
  if (error) throw error;

  return new Map((data || []).map((row) => [row.id, {
    id: row.id,
    name: row.name || 'Unknown'
  }]));
}

async function fetchPlannerItemPeopleRows(db, team, plannerItemIds = []) {
  const uniqueIds = Array.from(new Set((plannerItemIds || []).filter(Boolean)));
  if (!uniqueIds.length) return [];

  const { data, error } = await db
    .from('planner_item_people')
    .select('id, frc_team, planner_item_id, user_id, created_at')
    .eq('frc_team', team)
    .in('planner_item_id', uniqueIds);
  if (error) throw error;
  return data || [];
}

async function fetchPlannerItemPartRows(db, team, plannerItemIds = []) {
  const uniqueIds = Array.from(new Set((plannerItemIds || []).filter(Boolean)));
  if (!uniqueIds.length) return [];

  const { data, error } = await db
    .from('planner_item_parts')
    .select('id, frc_team, planner_item_id, part_id, created_at')
    .eq('frc_team', team)
    .in('planner_item_id', uniqueIds);
  if (error) throw error;
  return data || [];
}

async function fetchPlannerTeamParts(db, team) {
  const { data, error } = await db
    .from('parts')
    .select('id, name, project_id, workflow, status, frc_team')
    .eq('frc_team', team)
    .order('id', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: Number(row.id),
    name: row.name || null,
    project_id: row.project_id || null,
    workflow: row.workflow || null,
    status: row.status || null,
    frc_team: row.frc_team || null
  }));
}

async function fetchPlannerP0BugRowsRaw(db, team, { itemIds = null, includeCompleted = true } = {}) {
  let query = db
    .from('planner_items')
    .select(PLANNER_ITEM_SELECT)
    .eq('frc_team', team)
    .eq('item_type', 'p0_bug')
    .order('created_at', { ascending: false });

  if (Array.isArray(itemIds)) {
    const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
    if (!uniqueIds.length) return [];
    query = query.in('id', uniqueIds);
  }

  if (!includeCompleted) {
    query = query.neq('status', 'completed');
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(withLegacyPlannerAliases).sort(compareP0BugRows);
}

async function hydratePlannerP0BugRows(db, team, rows = [], people = null) {
  if (!rows.length) return [];

  const resolvedPeople = people || await fetchPlannerTeamPeople(db, team);
  const peopleMap = new Map(resolvedPeople.map((person) => [person.id, person]));
  const itemIds = rows.map((row) => row.id).filter(Boolean);

  const [peopleRows, partRows, subsystemMap, reportRows] = await Promise.all([
    fetchPlannerItemPeopleRows(db, team, itemIds),
    fetchPlannerItemPartRows(db, team, itemIds),
    fetchSubsystemMap(db, rows.map((row) => row?.subsystem_id)),
    db
      .from('planner_item_p0_bugs')
      .select('id, frc_team, planner_item_id, p0_bug_item_id, report_area, created_by, created_at')
      .eq('frc_team', team)
      .in('p0_bug_item_id', itemIds)
      .not('report_area', 'is', null)
  ]);

  if (reportRows.error) throw reportRows.error;

  const drivePracticeItemIds = Array.from(new Set(
    (reportRows.data || []).map((row) => row?.planner_item_id).filter(Boolean)
  ));

  let drivePracticeMap = new Map();
  if (drivePracticeItemIds.length) {
    const { data, error } = await db
      .from('planner_items')
      .select('id, title, scheduled_start_at, scheduled_end_at')
      .in('id', drivePracticeItemIds);
    if (error) throw error;
    drivePracticeMap = new Map((data || []).map((row) => [row.id, row]));
  }

  const ownerByItem = new Map();
  for (const ownerRow of peopleRows) {
    if (!ownerByItem.has(ownerRow.planner_item_id)) ownerByItem.set(ownerRow.planner_item_id, ownerRow.user_id);
  }

  const partIdsByItem = new Map();
  for (const partRow of partRows) {
    if (!partIdsByItem.has(partRow.planner_item_id)) partIdsByItem.set(partRow.planner_item_id, []);
    partIdsByItem.get(partRow.planner_item_id).push(partRow.part_id);
  }

  const reportsByBug = new Map();
  for (const reportRow of reportRows.data || []) {
    if (!reportsByBug.has(reportRow.p0_bug_item_id)) reportsByBug.set(reportRow.p0_bug_item_id, []);
    const item = drivePracticeMap.get(reportRow.planner_item_id);
    if (!item?.id) continue;
    reportsByBug.get(reportRow.p0_bug_item_id).push({
      id: item.id,
      title: item.title || 'Drive Practice',
      scheduled_start_at: item.scheduled_start_at || null,
      scheduled_end_at: item.scheduled_end_at || null,
      report_area: reportRow.report_area || null,
      created_at: reportRow.created_at || null
    });
  }

  return rows
    .map((row) => {
      const owner = peopleMap.get(ownerByItem.get(row.id)) || null;
      const creator = row?.created_by ? (peopleMap.get(row.created_by) || null) : null;
      const subsystem = row?.subsystem_id ? (subsystemMap.get(row.subsystem_id) || null) : null;
      const partIds = Array.from(new Set(partIdsByItem.get(row.id) || []));
      const reportedDrivePractices = reportsByBug.get(row.id) || [];
      return withLegacyP0Aliases(row, owner, creator, subsystem, partIds, reportedDrivePractices);
    })
    .sort(compareP0BugRows);
}

export async function getPlannerActor(db) {
  const { data: authData, error: authErr } = await db.auth.getUser();
  if (authErr || !authData?.user?.id) return null;
  const actorId = authData.user.id;
  const { data: profile } = await db
    .from('user_profiles')
    .select('id, full_name, email, frc_team, role, banned')
    .eq('id', actorId)
    .maybeSingle();
  if (!profile?.id || profile?.banned) return null;
  return {
    id: profile.id,
    fullName: profile.full_name || null,
    email: profile.email || null,
    frcTeam: profile.frc_team || null,
    role: profile.role || 'member'
  };
}

export function plannerTeamEnabled(team) {
  return team === '971' || team === '9584';
}

export async function fetchPlannerTeamPeople(db, team) {
  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, email, frc_team, slack_user_id, slack_dm_channel, banned')
    .eq('frc_team', team)
    .order('full_name', { ascending: true });
  if (error) throw error;
  return (data || [])
    .filter((row) => !row?.banned)
    .map((row) => ({
      id: row.id,
      full_name: row.full_name || null,
      email: row.email || null,
      frc_team: row.frc_team || null,
      slack_user_id: row.slack_user_id || null,
      slack_dm_channel: row.slack_dm_channel || null
    }));
}

export async function fetchPlannerP0BugRows(db, team, options = {}) {
  const rows = await fetchPlannerP0BugRowsRaw(db, team, options);
  return hydratePlannerP0BugRows(db, team, rows, options.people || null);
}

export async function fetchPlannerSnapshot(db, team) {
  const [itemsResult, dependenciesResult, rulesResult, peopleResult, p0BugLinksResult, ruleRecipientsResult] = await Promise.all([
    db
      .from('planner_items')
      .select(PLANNER_ITEM_SELECT)
      .eq('frc_team', team)
      .neq('item_type', 'p0_bug')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    db
      .from('planner_dependencies')
      .select('id, frc_team, predecessor_item_id, successor_item_id, created_by, created_at')
      .eq('frc_team', team),
    db
      .from('planner_calendar_rules')
      .select('id, frc_team, rule_type, label, weekday, specific_date, starts_at, ends_at, enabled, is_default, created_by, created_at, updated_at')
      .eq('frc_team', team)
      .order('specific_date', { ascending: true, nullsFirst: true })
      .order('weekday', { ascending: true, nullsFirst: true })
      .order('starts_at', { ascending: true }),
    db
      .from('planner_item_people')
      .select('id, frc_team, planner_item_id, user_id, created_at')
      .eq('frc_team', team),
    db
      .from('planner_item_p0_bugs')
      .select('id, frc_team, planner_item_id, p0_bug_item_id, report_area, created_by, created_at')
      .eq('frc_team', team),
    db
      .from('planner_calendar_rule_recipients')
      .select('id, frc_team, planner_calendar_rule_id, user_id, created_at')
      .eq('frc_team', team)
  ]);

  if (itemsResult.error) {
    if (!isMissingPlannerSchemaError(itemsResult.error)) throw itemsResult.error;
    return fetchLegacyPlannerSnapshot(db, team);
  }
  if (dependenciesResult.error) throw dependenciesResult.error;
  if (rulesResult.error) throw rulesResult.error;
  if (peopleResult.error) throw peopleResult.error;
  if (p0BugLinksResult.error) throw p0BugLinksResult.error;
  if (ruleRecipientsResult.error) throw ruleRecipientsResult.error;

  const p0LinkRows = (p0BugLinksResult.data || []).map((row) => ({
    ...row,
    task_id: row.p0_bug_item_id
  }));

  return {
    items: (itemsResult.data || []).map(withLegacyPlannerAliases),
    dependencies: dependenciesResult.data || [],
    calendar_rules: rulesResult.data || [],
    owner_rows: (peopleResult.data || []).map((row) => ({
      ...row,
      owner_type: 'owner'
    })),
    p0_bug_link_rows: p0LinkRows,
    rule_recipient_rows: ruleRecipientsResult.data || [],
    drive_practice_bug_report_rows: p0LinkRows.filter((row) => !!row?.report_area)
  };
}

async function fetchLegacyPlannerSnapshot(db, team) {
  const [itemsResult, dependenciesResult, rulesResult, ownersResult, p0BugLinksResult, ruleRecipientsResult] = await Promise.all([
    db.from('planner_items').select(LEGACY_PLANNER_ITEM_SELECT).eq('frc_team', team).order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
    db.from('planner_dependencies').select('id, frc_team, predecessor_item_id, successor_item_id, created_by, created_at').eq('frc_team', team),
    db.from('planner_calendar_rules').select('id, frc_team, rule_type, label, weekday, specific_date, starts_at, ends_at, enabled, is_default, created_by, created_at, updated_at').eq('frc_team', team).order('specific_date', { ascending: true, nullsFirst: true }).order('weekday', { ascending: true, nullsFirst: true }).order('starts_at', { ascending: true }),
    db.from('planner_item_owners').select('id, frc_team, planner_item_id, user_id, owner_type, created_at').eq('frc_team', team),
    db.from('planner_item_p0_bugs').select('id, frc_team, planner_item_id, p0_bug_item_id, report_area, created_by, created_at').eq('frc_team', team),
    db.from('planner_calendar_rule_recipients').select('id, frc_team, planner_calendar_rule_id, user_id, created_at').eq('frc_team', team)
  ]);
  for (const result of [itemsResult, dependenciesResult, rulesResult, ownersResult, p0BugLinksResult, ruleRecipientsResult]) {
    if (result.error) throw result.error;
  }
  const p0LinkRows = (p0BugLinksResult.data || []).map((row) => ({ ...row, task_id: row.p0_bug_item_id }));
  return {
    items: (itemsResult.data || []).map(modernizeLegacyPlannerItem),
    dependencies: dependenciesResult.data || [],
    calendar_rules: rulesResult.data || [],
    owner_rows: (ownersResult.data || []).map((row) => ({ ...row, owner_type: row.owner_type || 'owner' })),
    p0_bug_link_rows: p0LinkRows,
    rule_recipient_rows: ruleRecipientsResult.data || [],
    drive_practice_bug_report_rows: p0LinkRows.filter((row) => !!row?.report_area)
  };
}

export async function fetchPlannerBundle(db, team, { warnings = [] } = {}) {
  const people = await fetchPlannerTeamPeople(db, team);
  const [snapshot, p0BugRows, teamParts] = await Promise.all([
    fetchPlannerSnapshot(db, team),
    fetchPlannerP0BugRows(db, team, { includeCompleted: true, people }),
    fetchPlannerTeamParts(db, team)
  ]);

  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const activeP0BugMap = new Map(p0BugRows.map((row) => [row.id, row]));
  const partById = new Map(teamParts.map((part) => [Number(part.id), part]));
  const ownersByItem = new Map();
  for (const ownerRow of snapshot.owner_rows) {
    if (!ownersByItem.has(ownerRow.planner_item_id)) ownersByItem.set(ownerRow.planner_item_id, []);
    ownersByItem.get(ownerRow.planner_item_id).push(ownerRow);
  }

  const itemIds = snapshot.items.map((item) => item.id).filter(Boolean);
  const itemPartRows = await fetchPlannerItemPartRows(db, team, itemIds);
  const partIdsByItem = new Map();
  for (const partRow of itemPartRows) {
    if (!partIdsByItem.has(partRow.planner_item_id)) partIdsByItem.set(partRow.planner_item_id, []);
    partIdsByItem.get(partRow.planner_item_id).push(Number(partRow.part_id));
  }

  const p0BugsByItem = new Map();
  for (const linkRow of snapshot.p0_bug_link_rows || []) {
    if (linkRow?.report_area) continue;
    if (!p0BugsByItem.has(linkRow.planner_item_id)) p0BugsByItem.set(linkRow.planner_item_id, []);
    p0BugsByItem.get(linkRow.planner_item_id).push(linkRow.task_id);
  }

  const recipientsByRule = new Map();
  for (const recipientRow of snapshot.rule_recipient_rows || []) {
    if (!recipientsByRule.has(recipientRow.planner_calendar_rule_id)) recipientsByRule.set(recipientRow.planner_calendar_rule_id, []);
    recipientsByRule.get(recipientRow.planner_calendar_rule_id).push(recipientRow);
  }

  const items = rollupPlannerStatuses(snapshot.items.map((item) => {
    const ownerRows = ownersByItem.get(item.id) || [];
    const owners = ownerRows
      .map((row) => peopleMap.get(row.user_id))
      .filter(Boolean);
    const p0BugIds = Array.from(new Set((p0BugsByItem.get(item.id) || []).filter(Boolean)));
    const partIds = Array.from(new Set((partIdsByItem.get(item.id) || []).filter(Number.isFinite)));
    const milestoneOwner = item.item_type === 'milestone' ? (owners[0] || null) : null;
    return {
      ...item,
      owners,
      owner_ids: owners.map((owner) => owner.id),
      p0_bug_ids: p0BugIds,
      p0_bugs: p0BugIds
        .map((bugId) => activeP0BugMap.get(bugId) || null)
        .filter(Boolean),
      part_ids: partIds,
      linked_parts: partIds
        .map((partId) => partById.get(Number(partId)) || null)
        .filter(Boolean),
      accountable: milestoneOwner,
      accountable_user_id: milestoneOwner?.id || null
    };
  }), snapshot.dependencies);

  const calendar_rules = snapshot.calendar_rules.map((rule) => {
    const recipientRows = recipientsByRule.get(rule.id) || [];
    const recipients = recipientRows
      .map((row) => peopleMap.get(row.user_id))
      .filter(Boolean);
    return {
      ...rule,
      recipients,
      recipient_ids: recipients.map((person) => person.id)
    };
  });

  return {
    items,
    dependencies: snapshot.dependencies,
    calendar_rules,
    people,
    parts: teamParts,
    p0_bugs: p0BugRows,
    warnings
  };
}

export async function replacePlannerOwners(db, team, itemId, ownerIds = [], accountableUserId = null) {
  await db
    .from('planner_item_people')
    .delete()
    .eq('frc_team', team)
    .eq('planner_item_id', itemId);

  const combinedOwnerIds = Array.from(new Set([
    ...ownerIds.filter(Boolean),
    accountableUserId || null
  ].filter(Boolean)));

  if (!combinedOwnerIds.length) return;

  const inserts = combinedOwnerIds.map((userId) => ({
    frc_team: team,
    planner_item_id: itemId,
    user_id: userId
  }));

  const { error } = await db.from('planner_item_people').insert(inserts);
  if (error) throw error;
}

export async function replacePlannerP0BugLinks(db, team, itemId, taskIds = [], createdBy = null) {
  await db
    .from('planner_item_p0_bugs')
    .delete()
    .eq('frc_team', team)
    .eq('planner_item_id', itemId)
    .is('report_area', null);

  const inserts = Array.from(new Set((taskIds || []).filter(Boolean))).map((taskId) => ({
    frc_team: team,
    planner_item_id: itemId,
    p0_bug_item_id: taskId,
    report_area: null,
    created_by: createdBy
  }));

  if (!inserts.length) return;
  const { error } = await db.from('planner_item_p0_bugs').insert(inserts);
  if (error) throw error;
}

export async function addDrivePracticeBugReportLinks(db, team, itemId, taskIds = [], createdBy = null, reportArea = null) {
  const uniqueTaskIds = Array.from(new Set((taskIds || []).filter(Boolean)));
  if (!itemId || !uniqueTaskIds.length || !createdBy || !reportArea) return;

  const { data: existing, error: existingError } = await db
    .from('planner_item_p0_bugs')
    .select('p0_bug_item_id')
    .eq('frc_team', team)
    .eq('planner_item_id', itemId)
    .eq('report_area', reportArea)
    .in('p0_bug_item_id', uniqueTaskIds);
  if (existingError) throw existingError;

  const existingIds = new Set((existing || []).map((row) => row.p0_bug_item_id).filter(Boolean));
  const inserts = uniqueTaskIds
    .filter((taskId) => !existingIds.has(taskId))
    .map((taskId) => ({
      frc_team: team,
      planner_item_id: itemId,
      p0_bug_item_id: taskId,
      report_area: reportArea,
      created_by: createdBy
    }));

  if (!inserts.length) return;
  const { error } = await db.from('planner_item_p0_bugs').insert(inserts);
  if (error) throw error;
}

export async function replacePlannerItemPartLinks(db, team, itemId, partIds = []) {
  await db
    .from('planner_item_parts')
    .delete()
    .eq('frc_team', team)
    .eq('planner_item_id', itemId);

  const uniquePartIds = Array.from(new Set((partIds || []).map((value) => Number(value)).filter(Number.isFinite)));
  if (!uniquePartIds.length) return;

  const inserts = uniquePartIds.map((partId) => ({
    frc_team: team,
    planner_item_id: itemId,
    part_id: partId
  }));

  const { error } = await db.from('planner_item_parts').insert(inserts);
  if (error) throw error;
}

export async function replacePlannerRuleRecipients(db, team, ruleId, recipientIds = []) {
  await db
    .from('planner_calendar_rule_recipients')
    .delete()
    .eq('frc_team', team)
    .eq('planner_calendar_rule_id', ruleId);

  const inserts = Array.from(new Set((recipientIds || []).filter(Boolean))).map((recipientId) => ({
    frc_team: team,
    planner_calendar_rule_id: ruleId,
    user_id: recipientId
  }));

  if (!inserts.length) return;
  const { error } = await db.from('planner_calendar_rule_recipients').insert(inserts);
  if (error) throw error;
}

export async function ensurePlannerUsersOnTeam(db, team, userIds = []) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (!uniqueIds.length) return [];
  const { data, error } = await db
    .from('user_profiles')
    .select('id, frc_team, banned')
    .in('id', uniqueIds);
  if (error) throw error;
  const valid = new Set(
    (data || [])
      .filter((row) => row?.id && !row?.banned && row?.frc_team === team)
      .map((row) => row.id)
  );
  for (const userId of uniqueIds) {
    if (!valid.has(userId)) {
      throw new Error('All selected people must be active members of your team.');
    }
  }
  return uniqueIds;
}

export async function ensurePlannerP0BugsOnTeam(db, team, taskIds = []) {
  const uniqueIds = Array.from(new Set(taskIds.filter(Boolean)));
  if (!uniqueIds.length) return [];
  const { data, error } = await db
    .from('planner_items')
    .select('id, frc_team, item_type')
    .eq('item_type', 'p0_bug')
    .in('id', uniqueIds);
  if (error) throw error;
  const valid = new Set(
    (data || [])
      .filter((row) => row?.id && row?.frc_team === team && row?.item_type === 'p0_bug')
      .map((row) => row.id)
  );
  for (const taskId of uniqueIds) {
    if (!valid.has(taskId)) {
      throw new Error('All selected P0 bugs must be on your team.');
    }
  }
  return uniqueIds;
}

export async function ensurePlannerPartsOnTeam(db, team, partIds = []) {
  const uniqueIds = Array.from(new Set((partIds || []).map((value) => Number(value)).filter(Number.isFinite)));
  if (!uniqueIds.length) return [];
  const { data, error } = await db
    .from('parts')
    .select('id, frc_team')
    .in('id', uniqueIds);
  if (error) throw error;
  const valid = new Set(
    (data || [])
      .filter((row) => Number.isFinite(Number(row?.id)) && row?.frc_team === team)
      .map((row) => Number(row.id))
  );
  for (const partId of uniqueIds) {
    if (!valid.has(partId)) {
      throw new Error('All selected parts must belong to your team.');
    }
  }
  return uniqueIds;
}

export function getPlannerAutoFixingDurationMinutes(reportedAt, rules = [], days = PLANNER_AUTO_FIXING_TASK_DAYS) {
  const startAt = toDateOrNull(reportedAt) || new Date();
  const endAt = addDays(startAt, days);
  const workingMinutes = roundUpToSlot(workingMinutesBetween(startAt, endAt, rules));
  return Math.max(PLANNER_DEFAULT_TASK_DURATION_MINUTES, workingMinutes);
}

export async function createPlannerFixingTaskFromP0Bug(db, actor, bug) {
  if (!actor?.frcTeam || !actor?.id || !bug?.id) {
    throw new Error('Missing actor or P0 bug data for planner task creation.');
  }

  const snapshot = await fetchPlannerSnapshot(db, actor.frcTeam);
  const sortOrder = snapshot.items.length
    ? Math.max(...snapshot.items.map((item) => Number(item.sort_order) || 0)) + 1000
    : 0;
  const manualStartAt = toDateOrNull(bug.created_at) || new Date();
  const durationMinutes = getPlannerAutoFixingDurationMinutes(
    manualStartAt,
    snapshot.calendar_rules,
    PLANNER_AUTO_FIXING_TASK_DAYS
  );

  const { data: created, error: createError } = await db
    .from('planner_items')
    .insert([{
      frc_team: actor.frcTeam,
      item_type: 'fixing_block',
      title: buildPlannerFixingTaskTitle(bug.title),
      details: null,
      work_category: null,
      status: 'not_started',
      critical_level: 1,
      duration_minutes: durationMinutes,
      requested_duration_minutes: durationMinutes,
      min_duration_minutes: Math.min(durationMinutes, PLANNER_DEFAULT_MIN_DURATION_MINUTES),
      manual_start_at: manualStartAt.toISOString(),
      sort_order: sortOrder,
      created_by: actor.id
    }])
    .select('id')
    .single();
  if (createError) throw createError;

  try {
    await replacePlannerP0BugLinks(db, actor.frcTeam, created.id, [bug.id], actor.id);
    const recompute = await recomputePlannerTeam(db, actor.frcTeam, { now: manualStartAt });
    return {
      item_id: created.id,
      warnings: recompute.warnings || []
    };
  } catch (error) {
    await db
      .from('planner_items')
      .delete()
      .eq('frc_team', actor.frcTeam)
      .eq('id', created.id);
    throw error;
  }
}

export async function recomputePlannerTeam(db, team, options = {}) {
  const snapshot = await fetchPlannerSnapshot(db, team);
  const result = recomputePlannerSchedule(snapshot.items, snapshot.dependencies, snapshot.calendar_rules, options);

  for (const item of result.items) {
    const source = snapshot.items.find((entry) => entry.id === item.id);
    if (!source) continue;

    const nextDuration = item.kind === 'task'
      ? roundUpToSlot(Number(item.duration_minutes) || PLANNER_DEFAULT_TASK_DURATION_MINUTES)
      : null;
    const nextRequestedDuration = item.kind === 'task'
      ? roundUpToSlot(Number(item.requested_duration_minutes) || Number(item.duration_minutes) || PLANNER_DEFAULT_TASK_DURATION_MINUTES)
      : null;
    const nextMinDuration = item.kind === 'task'
      ? roundUpToSlot(Number(item.min_duration_minutes) || PLANNER_DEFAULT_MIN_DURATION_MINUTES)
      : PLANNER_DEFAULT_MIN_DURATION_MINUTES;
    const nextManualStart = item.manual_start_at || null;
    const nextScheduledStart = item.scheduled_start_at || null;
    const nextScheduledEnd = item.scheduled_end_at || null;

    const unchanged =
      String(source.manual_start_at || '') === String(nextManualStart || '') &&
      String(source.scheduled_start_at || '') === String(nextScheduledStart || '') &&
      String(source.scheduled_end_at || '') === String(nextScheduledEnd || '') &&
      Number(source.duration_minutes || 0) === Number(nextDuration || 0) &&
      Number(source.requested_duration_minutes || 0) === Number(nextRequestedDuration || 0) &&
      Number(source.min_duration_minutes || 0) === Number(nextMinDuration || 0);

    if (unchanged) continue;

    const { error } = await db
      .from('planner_items')
      .update({
        manual_start_at: nextManualStart,
        scheduled_start_at: nextScheduledStart,
        scheduled_end_at: nextScheduledEnd,
        duration_minutes: nextDuration,
        requested_duration_minutes: nextRequestedDuration,
        min_duration_minutes: nextMinDuration
      })
      .eq('id', item.id);
    if (error) throw error;
  }

  return {
    warnings: result.warnings || [],
    hasCycle: !!result.hasCycle
  };
}

export async function getDefaultPlannerStart(db, team, now = new Date()) {
  const snapshot = await fetchPlannerSnapshot(db, team);
  return nextWorkMoment(now, snapshot.calendar_rules).toISOString();
}
