import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { selectPitScoutEntries, upsertPitScoutEntry } from '$lib/server/pitScoutingSchema.js';
import { normalizeTeamKey } from '$lib/server/matchScoutingSchema.js';

const NO_CLIMB_OPTION = 'No Climb';
const CLIMB_OPTIONS = [NO_CLIMB_OPTION, 'L1 Auto', 'L1', 'L2', 'L3'];
const ROBOT_ARCHETYPES = ['Shooter', 'Shuttler', 'Defender', 'Climber', 'Hybrid', 'Support / Feeder', 'Unknown'];

const TECHNICAL_DETAIL_OPTIONS = {
  use_net: ['Yes', 'No'],
  intake_style: ['Slapdown Intake', 'Linkage Intake', 'Other'],
  main_breaker_brand: ['Bussmann', 'OptiFuse', 'Other'],
  sb_connector: ['SB60', 'SB40', 'Other'],
  main_breaker_shroud: ['Yes', 'No'],
  wire_insulation: ['Silicone', 'Other'],
  electrical_connectors: [
    'Molex SL CAN',
    'WAGO CAN',
    'WAGO Power',
    'Anderson Power',
    'Ring Terminal Power',
    'Ring Terminal CAN',
    'Non-locking CAN',
    'WCP Powerpole Board',
    'Custom Powerpole Board',
    'Custom PCBs',
    'Other'
  ],
  battery_type: ['Energizer', 'Duracell', 'MK Battery', 'Other'],
  ground_intake_kicker: ['Yes', 'No'],
  motor_controllers: ['Talon FX', 'Victor SPX', 'Spark MAX', 'Redux', 'Thrifty'],
  motor_types: ['X60', 'X44', '550', 'Vortex', 'Thrifty', 'CIM'],
  uses_canivore: ['Yes', 'No'],
  auto_tools: ['Bline', 'PathPlanner', 'Choreo', 'Custom'],
  vision: ['PhotonVision', 'Limelight', 'Custom'],
  coprocessor: ['Orin', 'Limelight', 'Orange Pi', 'Raspberry Pi', 'Mac Mini', 'Other'],
  programming_language: ['Java', 'C++', 'Python'],
  uses_wpilib: ['Yes', 'No'],
  grip_tape: ['Cat Tongue', 'Silicone', 'Other'],
  swerve_module: ['MK5n', 'MK5i', 'MK4i', 'MK4n', 'MK4', 'WCP X2i', 'X2t', 'X2c', 'X2', 'ThriftySwerve', 'Other'],
  hopper_wall_reinforcement: ['Reinforced Corners', 'Polycarbonate Flanges', 'Other'],
  fits_under_trench: ['Yes', 'No'],
  drives_over_mound: ['Yes', 'No'],
  bumper_foam: ['Pool Noodle', 'EVA', 'XPE', 'Other'],
  hardware_standards: ['E-clip', 'Metric Fasteners', 'Metric Bearings'],
  encoder_types: ['PWM', 'CAN Through Bore', 'Other'],
  printed_roller_hubs: ['Yes', 'No']
};

const TECHNICAL_MULTI_FIELDS = new Set([
  'electrical_connectors',
  'motor_controllers',
  'motor_types',
  'auto_tools',
  'vision',
  'programming_language',
  'hardware_standards',
  'encoder_types'
]);

const TECHNICAL_TEXT_FIELDS = new Set([
  'mostly_used_wire_gauge',
  'drivebase_tube_thickness',
  'roller_hub_material',
  'software_other'
]);

const TECHNICAL_NUMBER_FIELDS = new Set([
  'ground_roller_motor_count',
  'bumper_length',
  'bumper_width',
  'bumper_height',
  'drivetrain_length',
  'drivetrain_width',
  'drivetrain_height',
  'can_bus_count',
  'electrical_rating',
  'drivebase_rating',
  'overall_reliability_rating'
]);

const getClientFromRequest = (request) => {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
};

function getDbClient(fallbackClient) {
  try {
    return getSupabase();
  } catch {
    return fallbackClient;
  }
}

function isLocalHost(url) {
  return url?.hostname === 'localhost' || url?.hostname === '127.0.0.1';
}

function isPublicReadRequest(url) {
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  return Boolean(eventKey);
}

async function getActor(authSupa) {
  const { data } = await authSupa.auth.getUser();
  return data?.user || null;
}

function sanitizePhotoPaths(input) {
  if (!Array.isArray(input)) return [];
  const clean = input
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
  return [...new Set(clean)];
}

function sanitizeAutoOptions(input) {
  if (!Array.isArray(input)) return [];

  const clean = [];
  const seen = new Set();

  for (const value of input) {
    const name = String(value?.name || '').trim().slice(0, 60);
    const description = String(value?.description || '').trim().slice(0, 220);
    if (!name || !description) continue;

    const key = `${name.toLowerCase()}::${description.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ name, description });

    if (clean.length >= 8) break;
  }

  return clean;
}

function sanitizeLongText(input, maxLength = 240) {
  return String(input || '').trim().slice(0, maxLength) || null;
}

function sanitizeEstimatedBps(input) {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'string' ? input.trim() : input;
  if (raw === '') return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return Math.round(parsed * 100) / 100;
}

function sanitizeClimbOptions(input) {
  if (!Array.isArray(input)) return [];
  const selected = new Set(
    input
      .map((value) => String(value || '').trim())
      .filter((value) => CLIMB_OPTIONS.includes(value))
  );
  if (selected.has(NO_CLIMB_OPTION)) return [NO_CLIMB_OPTION];
  return CLIMB_OPTIONS.filter((value) => value !== NO_CLIMB_OPTION && selected.has(value));
}

function sanitizeTechnicalSelect(field, value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return TECHNICAL_DETAIL_OPTIONS[field]?.includes(clean) ? clean : '';
}

function sanitizeTechnicalMulti(field, input) {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(TECHNICAL_DETAIL_OPTIONS[field] || []);
  const clean = [];
  for (const value of input) {
    const option = String(value || '').trim();
    if (!allowed.has(option) || clean.includes(option)) continue;
    clean.push(option);
  }
  return clean;
}

function sanitizeTechnicalNumber(input, { min = 0, max = null, integer = false } = {}) {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'string' ? input.trim() : input;
  if (raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || (max !== null && parsed > max)) return null;
  return integer ? Math.round(parsed) : Math.round(parsed * 1000) / 1000;
}

function sanitizeTechnicalDetails(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clean = {};

  for (const field of Object.keys(TECHNICAL_DETAIL_OPTIONS)) {
    clean[field] = TECHNICAL_MULTI_FIELDS.has(field)
      ? sanitizeTechnicalMulti(field, source[field])
      : sanitizeTechnicalSelect(field, source[field]);
  }

  for (const field of TECHNICAL_TEXT_FIELDS) {
    clean[field] = sanitizeLongText(source[field], 80) || '';
  }

  for (const field of TECHNICAL_NUMBER_FIELDS) {
    clean[field] = field.endsWith('_rating')
      ? sanitizeTechnicalNumber(source[field], { min: 1, max: 10, integer: true })
      : sanitizeTechnicalNumber(source[field]);
  }

  return clean;
}

export async function POST({ request, url }) {
  try {
    const body = await request.json();
    if (body?.action !== 'save-entry') return json({ error: 'Invalid action' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    const isLocal = isLocalHost(url);

    if (!isLocal && !actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });

    const event_key = String(body?.event_key || '').trim();
    const team_key = normalizeTeamKey(body?.team_key);
    const drivebase_type = body?.drivebase_type || null;
    const shooter_type = body?.shooter_type || null;
    const hopper_type = body?.hopper_type || null;
    const human_player_balls_in_auto = body?.human_player_balls_in_auto || null;
    const scout_name = sanitizeLongText(body?.scout_name, 120);
    const robot_archetype = ROBOT_ARCHETYPES.includes(body?.robot_archetype) ? body.robot_archetype : null;
    const additional_notes = sanitizeLongText(body?.additional_notes, 4000);
    const likely_breaking_component = sanitizeLongText(body?.likely_breaking_component);
    const estimated_bps = sanitizeEstimatedBps(body?.estimated_bps);
    const climb_options = sanitizeClimbOptions(body?.climb_options);
    const photo_paths = sanitizePhotoPaths(body?.photo_paths);
    const auto_options = sanitizeAutoOptions(body?.auto_options);
    const technical_details = sanitizeTechnicalDetails(body?.technical_details);

    if (!event_key || !team_key) {
      return json({ error: 'event_key and team_key are required' }, { status: 400 });
    }

    const payload = {
      event_key,
      team_key,
      drivebase_type,
      shooter_type,
      hopper_type,
      human_player_balls_in_auto,
      scout_name,
      robot_archetype,
      additional_notes,
      likely_breaking_component,
      estimated_bps,
      climb_options,
      auto_options,
      technical_details,
      photo_paths,
      created_by: actor?.id || body?.user_id || null,
      updated_at: new Date().toISOString()
    };

    const result = await upsertPitScoutEntry(db, payload);
    if (result.error) return json({ error: result.error.message }, { status: 500 });
    return json({
      success: true,
      data: result.data,
      meta: {
        schema: result.schema,
        warning: result.warning
      }
    });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET({ url, request }) {
  try {
    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    const isLocal = isLocalHost(url);
    const canReadPublic = isPublicReadRequest(url);

    if (!isLocal && !actor?.id && !canReadPublic) return json({ error: 'Unauthorized' }, { status: 401 });

    if (url.searchParams.get('resource') === 'pit-contacts') {
      if (!isLocal && !actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });
      const { data, error } = await db
        .from('pit_scout_entries')
        .select('scout_name')
        .not('scout_name', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(250);
      if (error) return json({ error: error.message }, { status: 500 });
      return json({
        success: true,
        data: [...new Set((data || []).map((row) => String(row.scout_name || '').trim()).filter(Boolean))]
      });
    }

    const event_key = String(url.searchParams.get('event_key') || '').trim();
    const team_key = String(url.searchParams.get('team_key') || '').trim();

    if (event_key && team_key) {
      const result = await selectPitScoutEntries(db, (query) =>
        query.eq('event_key', event_key).eq('team_key', team_key).maybeSingle()
      );

      if (result.error) return json({ error: result.error.message }, { status: 500 });
      return json({
        success: true,
        data: result.data || null,
        meta: {
          schema: result.schema,
          warning: result.warning
        }
      });
    }

    if (event_key) {
      const result = await selectPitScoutEntries(db, (query) =>
        query.eq('event_key', event_key).order('team_key', { ascending: true })
      );

      if (result.error) return json({ error: result.error.message }, { status: 500 });
      return json({
        success: true,
        data: result.data || [],
        meta: {
          schema: result.schema,
          warning: result.warning
        }
      });
    }

    const recent = Number(url.searchParams.get('recent') || '100');
    const result = await selectPitScoutEntries(db, (query) =>
      query.order('updated_at', { ascending: false }).limit(recent)
    );

    if (result.error) return json({ error: result.error.message }, { status: 500 });
    return json({
      success: true,
      data: result.data || [],
      meta: {
        schema: result.schema,
        warning: result.warning
      }
    });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
