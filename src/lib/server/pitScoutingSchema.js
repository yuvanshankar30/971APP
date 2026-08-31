const PIT_SCOUT_OPTIONAL_COLUMN_DEFAULTS = Object.freeze({
  scout_name: null,
  robot_archetype: null,
  additional_notes: null,
  likely_breaking_component: null,
  estimated_bps: null,
  climb_options: [],
  auto_options: [],
  technical_details: {}
});

const BASE_PIT_SCOUT_SELECT_COLUMNS = [
  'id',
  'event_key',
  'team_key',
  'drivebase_type',
  'shooter_type',
  'hopper_type',
  'human_player_balls_in_auto',
  'photo_paths',
  'created_by',
  'created_at',
  'updated_at'
];

export const PIT_SCOUT_OPTIONAL_COLUMNS = Object.keys(PIT_SCOUT_OPTIONAL_COLUMN_DEFAULTS);

function cloneDefaultValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

export function buildPitScoutSchema(supportedColumns = PIT_SCOUT_OPTIONAL_COLUMNS) {
  const supported = new Set((supportedColumns || []).map(String));
  return {
    scout_name: supported.has('scout_name'),
    robot_archetype: supported.has('robot_archetype'),
    additional_notes: supported.has('additional_notes'),
    likely_breaking_component: supported.has('likely_breaking_component'),
    estimated_bps: supported.has('estimated_bps'),
    climb_options: supported.has('climb_options'),
    auto_options: supported.has('auto_options'),
    technical_details: supported.has('technical_details')
  };
}

export function buildPitScoutSelectColumns(supportedColumns = PIT_SCOUT_OPTIONAL_COLUMNS) {
  return [...BASE_PIT_SCOUT_SELECT_COLUMNS, ...(supportedColumns || [])].join(', ');
}

export function missingPitScoutOptionalColumn(error, supportedColumns = PIT_SCOUT_OPTIONAL_COLUMNS) {
  const text = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!text) return null;
  if (
    !text.includes('column') &&
    !text.includes('schema cache') &&
    !text.includes('does not exist')
  ) {
    return null;
  }

  return (supportedColumns || []).find((columnName) => text.includes(String(columnName).toLowerCase())) || null;
}

export function normalizePitScoutRow(row, schema = buildPitScoutSchema()) {
  if (!row) return row ?? null;

  const normalized = { ...row };
  for (const [columnName, defaultValue] of Object.entries(PIT_SCOUT_OPTIONAL_COLUMN_DEFAULTS)) {
    if (schema?.[columnName]) {
      const value = row?.[columnName];
      normalized[columnName] =
        value === undefined || value === null ? cloneDefaultValue(defaultValue) : value;
      continue;
    }

    normalized[columnName] = cloneDefaultValue(defaultValue);
  }

  return normalized;
}

export function normalizePitScoutRows(rows, schema = buildPitScoutSchema()) {
  return Array.isArray(rows) ? rows.map((row) => normalizePitScoutRow(row, schema)) : [];
}

export function pitScoutSchemaWarning(schema = buildPitScoutSchema()) {
  const missing = [];
  if (!schema?.scout_name) missing.push('scout name');
  if (!schema?.robot_archetype) missing.push('robot archetype');
  if (!schema?.additional_notes) missing.push('additional notes');
  if (!schema?.likely_breaking_component) missing.push('likely breaking component');
  if (!schema?.estimated_bps) missing.push('estimated BPS');
  if (!schema?.climb_options) missing.push('climb options');
  if (!schema?.auto_options) missing.push('auto options');
  if (!schema?.technical_details) missing.push('technical details');

  return missing.length
    ? `Pit scout optional fields are unavailable until the latest migration runs: ${missing.join(', ')}.`
    : null;
}

export async function selectPitScoutEntries(db, configureQuery) {
  let supportedColumns = [...PIT_SCOUT_OPTIONAL_COLUMNS];

  while (true) {
    const schema = buildPitScoutSchema(supportedColumns);
    const { data, error } = await configureQuery(
      db.from('pit_scout_entries').select(buildPitScoutSelectColumns(supportedColumns))
    );

    if (!error) {
      return {
        data: Array.isArray(data) ? normalizePitScoutRows(data, schema) : normalizePitScoutRow(data, schema),
        error: null,
        schema,
        warning: pitScoutSchemaWarning(schema)
      };
    }

    const missingColumn = missingPitScoutOptionalColumn(error, supportedColumns);
    if (!missingColumn) {
      return {
        data: null,
        error,
        schema,
        warning: pitScoutSchemaWarning(schema)
      };
    }

    supportedColumns = supportedColumns.filter((columnName) => columnName !== missingColumn);
  }
}

export async function upsertPitScoutEntry(db, payload) {
  let supportedColumns = [...PIT_SCOUT_OPTIONAL_COLUMNS];
  let workingPayload = { ...payload };

  while (true) {
    const schema = buildPitScoutSchema(supportedColumns);
    const { data, error } = await db
      .from('pit_scout_entries')
      .upsert(workingPayload, { onConflict: 'event_key,team_key' })
      .select(buildPitScoutSelectColumns(supportedColumns))
      .single();

    if (!error) {
      return {
        data: normalizePitScoutRow(data, schema),
        error: null,
        schema,
        warning: pitScoutSchemaWarning(schema)
      };
    }

    const missingColumn = missingPitScoutOptionalColumn(error, supportedColumns);
    if (!missingColumn) {
      return {
        data: null,
        error,
        schema,
        warning: pitScoutSchemaWarning(schema)
      };
    }

    supportedColumns = supportedColumns.filter((columnName) => columnName !== missingColumn);
    delete workingPayload[missingColumn];
  }
}
