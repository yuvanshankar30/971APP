// Shared read-only Hub data query tool - the allowlisted table/column set
// and its executor, used as a Gemini function-calling tool by BOTH
// hub_slack_assistant.js (general Q&A) and hub_change_request.js (the
// /edit code-change command, which is only ever allowed to READ the
// database through this same allowlist - it has no mutating DB tool at
// all). Split out from hub_slack_assistant.js so the two modules can both
// import it without a circular import between them.
export const HUB_QUERYABLE_TABLES = {
  scout_match_assignments: {
    description: 'Match scouting assignments (who is assigned to which match is intentionally excluded here - ask about "my assignments" instead).',
    columns: ['scouting_type', 'match_key', 'team_key', 'completed_at']
  },
  scout_pit_assignments: {
    description: 'Pit scouting assignments for an event.',
    columns: ['event_key', 'team_key', 'completed_at']
  },
  scout_prescout_assignments: {
    description: 'Pre-scouting assignments for an event.',
    columns: ['event_key', 'team_key', 'completed_at']
  },
  match_scout_entries: {
    description: 'Submitted match-scouting reports: performance observations for one team in one match.',
    columns: ['event_key', 'match_key', 'team_key', 'alliance', 'starting_position', 'auto_points_band',
      'balls_scored_band', 'driver_skill', 'teleop_robot_status', 'card', 'crash_or_break', 'mechanical_break',
      'beached', 'scout_name', 'created_at'],
    defaultOrder: 'created_at'
  },
  pit_scout_entries: {
    description: 'Pit-scouting reports: one robot\'s capabilities and mechanisms at an event.',
    columns: ['event_key', 'team_key', 'drivebase_type', 'shooter_type', 'hopper_type', 'robot_archetype',
      'likely_breaking_component', 'estimated_bps', 'climb_options', 'additional_notes', 'scout_name', 'updated_at'],
    defaultOrder: 'updated_at'
  },
  pit_problem_reports: {
    description: 'ACE/Pit problem reports filed during an event (mechanical/disabled/dead-robot handoffs).',
    columns: ['event_key', 'team_key', 'match_key', 'summary', 'detail', 'severity', 'resolved', 'resolved_at', 'created_at'],
    defaultOrder: 'created_at'
  },
  scouting_robot_ratings: {
    description: 'Subjective 1-5 robot ratings scouts assign after watching a team play.',
    columns: ['event_key', 'team_key', 'team_number', 'overall_rating', 'offense_rating', 'defense_rating',
      'driving_rating', 'auto_rating', 'shuttling_rating', 'notes', 'strategy_notes']
  },
  scouting_match_rankings: {
    description: 'Pairwise-ranked team order the scouting team recorded for a match.',
    columns: ['event_key', 'match_key', 'ranked_team_keys']
  },
  parts: {
    description: 'Manufacturing parts/work orders: what is being made, its workflow, and its status.',
    columns: ['name', 'workflow', 'status', 'router_step', 'quantity', 'material', 'due_date', 'delivered', 'created_at', 'updated_at'],
    defaultOrder: 'updated_at'
  },
  router_groups: {
    description: 'Grouped router (JProg/AutoCAM) cut jobs and their machining status.',
    columns: ['name', 'stock_type', 'status', 'machine', 'material', 'target_date', 'queue_position', 'post_processing_stage']
  },
  orders: {
    description: 'Purchasing orders placed with a vendor.',
    columns: ['order_number', 'vendor', 'total_items', 'total_cost', 'order_total', 'delivery_date', 'placed_at', 'notes'],
    defaultOrder: 'placed_at'
  },
  planner_items: {
    description: 'Planner tasks/events: title, kind, status, and schedule.',
    columns: ['title', 'kind', 'category', 'status', 'critical_level', 'scheduled_start_at', 'scheduled_end_at', 'duration_minutes'],
    defaultOrder: 'scheduled_start_at'
  },
  builds: {
    description: 'Robot subsystem builds tracked against a CAD release.',
    columns: ['release_name', 'status', 'frc_team', 'quantity', 'created_at', 'assembled_at']
  }
};

const MAX_QUERY_LIMIT = 50;
const DEFAULT_QUERY_LIMIT = 20;

export function queryHubDataToolDeclaration() {
  const tableList = Object.entries(HUB_QUERYABLE_TABLES)
    .map(([table, config]) => `- ${table}: ${config.description} Columns: ${config.columns.join(', ')}.`)
    .join('\n');
  return {
    name: 'query_hub_data',
    description: `Run a safe, read-only lookup against one Spartans Hub data table to answer a specific question. Only these tables/columns exist for this tool:\n${tableList}`,
    parameters: {
      type: 'OBJECT',
      properties: {
        table: { type: 'STRING', description: `One of: ${Object.keys(HUB_QUERYABLE_TABLES).join(', ')}` },
        filters: {
          type: 'OBJECT',
          description: 'Optional exact-match filters, e.g. {"event_key": "2026cc", "team_key": "frc971"}. Keys must be one of that table\'s own listed columns.'
        },
        limit: { type: 'INTEGER', description: `Max rows to return (default ${DEFAULT_QUERY_LIMIT}, max ${MAX_QUERY_LIMIT}).` }
      },
      required: ['table']
    }
  };
}

export async function executeHubDataQuery(supa, args = {}) {
  const table = String(args?.table || '').trim();
  const config = HUB_QUERYABLE_TABLES[table];
  if (!config) {
    return { error: `Unknown table "${table}". Valid tables: ${Object.keys(HUB_QUERYABLE_TABLES).join(', ')}` };
  }
  const filters = args?.filters && typeof args.filters === 'object' ? args.filters : {};
  for (const key of Object.keys(filters)) {
    if (!config.columns.includes(key)) {
      return { error: `Column "${key}" is not queryable on "${table}". Queryable columns: ${config.columns.join(', ')}` };
    }
  }
  const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(args?.limit) || DEFAULT_QUERY_LIMIT));
  let query = supa.from(table).select(config.columns.join(',')).limit(limit);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  if (config.defaultOrder) query = query.order(config.defaultOrder, { ascending: false });
  const result = await query;
  if (result.error) return { error: result.error.message || 'Query failed' };
  return { table, rowCount: (result.data || []).length, rows: result.data || [] };
}
