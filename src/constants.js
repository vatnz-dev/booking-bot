const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const { parseStaffRoleIds } = require('./utils/permissions');
// Keep existing single-role deployments working while supporting several staff roles.
const STAFF_ROLE_IDS = parseStaffRoleIds(process.env.STAFF_ROLE_IDS || process.env.STAFF_ROLE_ID);
const EVENT_NOTIFICATIONS_ROLE_ID = process.env.EVENT_NOTIFICATIONS_ROLE_ID;
const BOOKING_REMINDERS_ENABLED = String(process.env.BOOKING_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
const EVENT_CALENDAR_URL = process.env.EVENT_CALENDAR_URL || 'https://www.vatnz.net/events/calendar/vatnz-lite.ics';
const VATNZ_POSITIONS_URL = process.env.VATNZ_POSITIONS_URL || 'https://www.vatnz.net/airspace/positions/';
const SOLO_ENDORSEMENTS_URL = process.env.SOLO_ENDORSEMENTS_URL || 'https://www.vatnz.net/controllers/endorsements/approved-solo-endorsements/';
const S1_SOLO_ENDORSEMENTS_URL = process.env.S1_SOLO_ENDORSEMENTS_URL || 'https://www.vatnz.net/controllers/endorsements/list-s1-holders-approved-connect-under-622-s1-tower-trainee-policy/';

function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const EVENT_LOOKAHEAD_DAYS = 7;
const ONE_HOUR_MS = 60 * 60 * 1000;
const EVENT_CHECK_INTERVAL_MS = readPositiveNumberEnv('EVENT_CHECK_INTERVAL_MS', 5 * 60 * 1000);
const EVENT_NOTIFICATION_LEAD_MS = ONE_HOUR_MS;
const VATNZ_POSITION_CACHE_MS = 12 * ONE_HOUR_MS;
const SOLO_ENDORSEMENT_CACHE_MS = 6 * ONE_HOUR_MS;
const ENDORSEMENT_WARNING_CHECK_MS = 12 * ONE_HOUR_MS;
const ENDORSEMENT_WARNING_DAYS = [30, 1, 0];
const MIN_BOOKING_DURATION_MINUTES = 30;
const BOOKING_REMINDER_MINUTES = readPositiveNumberEnv('BOOKING_REMINDER_MINUTES', 30);
const MENTOR_TAG_TIMEOUT_MS = 5 * 60 * 1000;
const MENTOR_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const FSS_ROLE_ID = (process.env.FSS_ROLE_ID || '').trim();
const THUMBS_UP = '\u{1F44D}';

const ratingRoleIds = {
  S1: (process.env.S1_ROLE_ID || '').trim(),
  S2: (process.env.S2_ROLE_ID || '').trim(),
  S3: (process.env.S3_ROLE_ID || '').trim(),
  I3: (process.env.I3_ROLE_ID || '').trim(),
  C1: (process.env.C1_ROLE_ID || '').trim(),
  C3: (process.env.C3_ROLE_ID || '').trim(),
  I1: (process.env.I1_ROLE_ID || '').trim()
};

const RATING_PRIORITY = ['I3', 'I1', 'C3', 'C1', 'S3', 'S2', 'S1'];

const ratingLabels = {
  S1: 'S1 - Developing Controller',
  S2: 'S2 - Aerodrome Controller',
  S3: 'S3 - Terminal Controller',
  I3: 'I3 - Senior Instructor',
  C1: 'C1 - Enroute Controller',
  C3: 'C3 - Senior Controller',
  I1: 'I1 - Instructor'
};
const roleMap = Object.fromEntries(
  Object.entries(ratingRoleIds).filter(([, id]) => id).map(([rating, id]) => [id, ratingLabels[rating]])
);

const FALLBACK_EVENT_POSITIONS = [
  'NZZO-E_FSS', 'NZAA-R_CTR', 'NZCH-D_CTR', 'NZAA_DEP', 'NZCH_DEP',
  'NZWN_DEP', 'NSTU_TWR', 'NZFX_TWR', 'NZMF_TWR', 'NZPP_TWR',
  'NZFX_GND', 'NZQN_GND', 'NCRG_DEL', 'NZFX_DEL'
];

const sectorAerodromeMap = {
  "NZCH-S_CTR": ["NZQN", "NZDN", "NZNV"],
  "NZCH-T_CTR": ["NZWN", "NZWB", "NZNS"],
  "NZAA_CTR": ["NZAA", "NZWP", "NZHN"],
  "NZCH-B_CTR": ["NZRO", "NZTG", "NZGS"],
  "NZCH-K_CTR": ["NZCH"],
  "NZOH_CTR": ["NZOH", "NZPM", "NZNR"],
  "NZAA-R_CTR": ["NZHN", "NZNP"],
  "NZWN_APP": ["NZWN", "NZWB"],
  "NZOH_APP": ["NZOH", "NZPM"],
  "NZAA_APP": ["NZAA", "NZWP"]
};

const sectorCodeMap = {
  "NZAA_CTR": "OCR",
  "NZCH-B_CTR": "BAY",
  "NZOH_CTR": "OHA",
  "NZCH-K_CTR": "KAI",
  "NZCH-T_CTR": "NAK",
  "NZCH-S_CTR": "STH",
  "NZAA-R_CTR": "RAN"
};

const autoInheritanceMap = {
  "NZAA_CTR": ["NZCH-B_CTR"],
  "NZCH-T_CTR": ["NZOH_CTR"],
  "NZCH-S_CTR": ["NZCH-K_CTR"]
};

const allExtendableSectors = [
  'NZCH-B_CTR', 'NZOH_CTR', 'NZCH-K_CTR',
  'NZCH-S_CTR', 'NZCH-T_CTR', 'NZAA_CTR'
];

module.exports = {
  LOG_CHANNEL_ID,
  STAFF_ROLE_IDS,
  EVENT_NOTIFICATIONS_ROLE_ID,
  BOOKING_REMINDERS_ENABLED,
  EVENT_CALENDAR_URL,
  VATNZ_POSITIONS_URL,
  SOLO_ENDORSEMENTS_URL,
  S1_SOLO_ENDORSEMENTS_URL,
  EVENT_LOOKAHEAD_DAYS,
  ONE_HOUR_MS,
  EVENT_CHECK_INTERVAL_MS,
  EVENT_NOTIFICATION_LEAD_MS,
  VATNZ_POSITION_CACHE_MS,
  SOLO_ENDORSEMENT_CACHE_MS,
  ENDORSEMENT_WARNING_CHECK_MS,
  ENDORSEMENT_WARNING_DAYS,
  MIN_BOOKING_DURATION_MINUTES,
  BOOKING_REMINDER_MINUTES,
  MENTOR_TAG_TIMEOUT_MS,
  MENTOR_APPROVAL_TIMEOUT_MS,
  FSS_ROLE_ID,
  THUMBS_UP,
  ratingRoleIds,
  ratingLabels,
  RATING_PRIORITY,
  roleMap,
  FALLBACK_EVENT_POSITIONS,
  sectorAerodromeMap,
  sectorCodeMap,
  autoInheritanceMap,
  allExtendableSectors
};
