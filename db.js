'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'scorekeeper.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  seedDefaults(_db);
  return _db;
}

function runSchema(db, sql) {
  db.prepare(sql).run();
}

function initSchema(db) {
  runSchema(db, `
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT ''
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS period_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('AUTO','TRANSITION','TELEOP','ENDGAME','BUZZER','CUSTOM')),
      group_id INTEGER,
      group_repeats INTEGER NOT NULL DEFAULT 1
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_number INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'quals' CHECK(phase IN ('quals','playoffs')),
      red1 INTEGER REFERENCES teams(id),
      red2 INTEGER REFERENCES teams(id),
      blue1 INTEGER REFERENCES teams(id),
      blue2 INTEGER REFERENCES teams(id),
      state TEXT NOT NULL DEFAULT 'UPCOMING' CHECK(state IN ('UPCOMING','QUEUED','ON_FIELD','COMPLETED'))
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS match_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      alliance TEXT NOT NULL CHECK(alliance IN ('red','blue')),
      auto_classified INTEGER NOT NULL DEFAULT 0,
      auto_overflow INTEGER NOT NULL DEFAULT 0,
      auto_leave INTEGER NOT NULL DEFAULT 0,
      auto_pattern INTEGER NOT NULL DEFAULT 0,
      teleop_classified INTEGER NOT NULL DEFAULT 0,
      teleop_overflow INTEGER NOT NULL DEFAULT 0,
      teleop_balls INTEGER NOT NULL DEFAULT 0,
      yellow_cards TEXT NOT NULL DEFAULT '[]',
      red_cards TEXT NOT NULL DEFAULT '[]',
      committed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(match_id, alliance)
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS endgame_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      alliance TEXT NOT NULL CHECK(alliance IN ('red','blue')),
      cycle INTEGER NOT NULL,
      r1_park TEXT NOT NULL DEFAULT 'none' CHECK(r1_park IN ('none','partial','full')),
      r2_park TEXT NOT NULL DEFAULT 'none' CHECK(r2_park IN ('none','partial','full')),
      UNIQUE(match_id, alliance, cycle)
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      period_name TEXT,
      match_time INTEGER,
      alliance TEXT NOT NULL CHECK(alliance IN ('red','blue')),
      team_number INTEGER,
      type TEXT NOT NULL CHECK(type IN ('minor','major','yellow','red')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS score_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      alliance TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Add motif column to matches if it doesn't exist yet (migration)
  try {
    db.prepare("ALTER TABLE matches ADD COLUMN motif TEXT CHECK(motif IN ('GPP','PGP','PPG'))").run();
  } catch (_) { /* column already exists */ }

  // Add per-robot leave columns (replaces single auto_leave count)
  try {
    db.prepare("ALTER TABLE match_scores ADD COLUMN auto_leave_r1 INTEGER NOT NULL DEFAULT 0").run();
  } catch (_) { /* column already exists */ }
  try {
    db.prepare("ALTER TABLE match_scores ADD COLUMN auto_leave_r2 INTEGER NOT NULL DEFAULT 0").run();
  } catch (_) { /* column already exists */ }

  // Per-ball pattern state (9 chars, '0'/'1')
  try {
    db.prepare("ALTER TABLE match_scores ADD COLUMN pattern_balls TEXT NOT NULL DEFAULT '000000000'").run();
  } catch (_) { /* column already exists */ }

  // Teleop (endgame) pattern balls — separate from auto pattern
  try {
    db.prepare("ALTER TABLE match_scores ADD COLUMN teleop_pattern_balls TEXT NOT NULL DEFAULT '000000000'").run();
  } catch (_) { /* column already exists */ }
  try {
    db.prepare("ALTER TABLE match_scores ADD COLUMN teleop_pattern INTEGER NOT NULL DEFAULT 0").run();
  } catch (_) { /* column already exists */ }

  // OPR — computed after each commit, stored per team
  try {
    db.prepare("ALTER TABLE teams ADD COLUMN opr REAL NOT NULL DEFAULT 0").run();
  } catch (_) { /* column already exists */ }

  // Migrate TRANSITION duration from old default (8s) to current default (15s)
  db.prepare("UPDATE period_config SET duration=15 WHERE type='TRANSITION' AND duration=8").run();

  // Migrate RP thresholds from old defaults to the SEC Game Manual's values
  // (Movement RP = LEAVE + BASE at 60/85; Pattern RP = PATTERN points at 50/72)
  db.prepare("UPDATE settings SET value='60' WHERE key='rp_park_threshold_1' AND value='63'").run();
  db.prepare("UPDATE settings SET value='85' WHERE key='rp_park_threshold_2' AND value='90'").run();
  db.prepare("UPDATE settings SET value='50' WHERE key='rp_pattern_threshold_1' AND value='23'").run();
  db.prepare("UPDATE settings SET value='72' WHERE key='rp_pattern_threshold_2' AND value='33'").run();

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS alliance_selections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alliance_number INTEGER NOT NULL UNIQUE,
      captain_team INTEGER REFERENCES teams(id),
      partner_team INTEGER REFERENCES teams(id)
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS bracket_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bracket_round TEXT NOT NULL,
      bracket_slot INTEGER NOT NULL,
      red_alliance INTEGER,
      blue_alliance INTEGER,
      winner_alliance INTEGER,
      match_id INTEGER REFERENCES matches(id),
      UNIQUE(bracket_round, bracket_slot)
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      alliance TEXT CHECK(alliance IN ('red','blue')),
      team_number INTEGER,
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'headref',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  runSchema(db, `
    CREATE TABLE IF NOT EXISTS rp_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      alliance TEXT NOT NULL CHECK(alliance IN ('red','blue')),
      category TEXT NOT NULL CHECK(category IN ('win','park','pattern','ball')),
      mode TEXT NOT NULL CHECK(mode IN ('grant','exclude','override')),
      value REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(match_id, alliance, category)
    )
  `);

  // Outstanding yellow/red cards that carry forward from match to match within
  // a phase (quals or playoffs) until deleted. See getEffectiveCards() below —
  // these are merged with each match's own match_scores cards at read time,
  // never written into match_scores directly.
  runSchema(db, `
    CREATE TABLE IF NOT EXISTS team_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_number INTEGER NOT NULL,
      card_type TEXT NOT NULL CHECK(card_type IN ('yellow','red')),
      phase TEXT NOT NULL CHECK(phase IN ('quals','playoffs')),
      origin_match_id INTEGER REFERENCES matches(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(team_number, phase, card_type)
    )
  `);
}

const DEFAULT_SETTINGS = {
  pts_auto_classified: '3',
  pts_auto_overflow: '1',
  pts_auto_leave: '5',
  pts_auto_pattern: '2',
  pts_teleop_classified: '3',
  pts_teleop_overflow: '1',
  pts_park_partial: '5',
  pts_park_full: '10',
  pts_park_bonus: '10',
  pts_foul_minor: '5',
  pts_foul_major: '15',
  rp_win: '4',
  rp_tie: '2',
  rp_loss: '0',
  rp_park_threshold_1: '60',
  rp_park_threshold_2: '85',
  rp_pattern_threshold_1: '50',
  rp_pattern_threshold_2: '72',
  rp_ball_threshold_1: '210',
  rp_ball_threshold_2: '300',
  matches_per_team: '4',
  pin_red: '1001',
  pin_blue: '1002',
  pin_ref: '2001',
  pin_headref: '3001',
  pin_control: '3002',
  pin_queue: '2002',
  admin_password: 'ftcadmin',
  event_name: 'Score Keeper Event',
};

const DEFAULT_PERIODS = [
  { position: 1, name: 'AUTO',       duration: 60,  type: 'AUTO',       group_id: null, group_repeats: 1 },
  { position: 2, name: 'TRANSITION', duration: 15,  type: 'TRANSITION', group_id: null, group_repeats: 1 },
  { position: 3, name: 'TELEOP',     duration: 110, type: 'TELEOP',     group_id: 1,    group_repeats: 5 },
  { position: 4, name: 'ENDGAME',    duration: 10,  type: 'ENDGAME',    group_id: 1,    group_repeats: 5 },
  { position: 5, name: 'BUZZER',     duration: 10,  type: 'BUZZER',     group_id: 1,    group_repeats: 5 },
];

function seedDefaults(db) {
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, value);
  }

  const hasPeriods = db.prepare('SELECT COUNT(*) as c FROM period_config').get().c;
  if (hasPeriods === 0) {
    const insertPeriod = db.prepare(`
      INSERT INTO period_config(position, name, duration, type, group_id, group_repeats)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of DEFAULT_PERIODS) {
      insertPeriod.run(p.position, p.name, p.duration, p.type, p.group_id, p.group_repeats);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function getSettingsMap(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

function getPointValues(db) {
  const map = getSettingsMap(db);
  const pv = {};
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith('pts_')) {
      pv[key.slice(4)] = parseFloat(val);
    }
  }
  return pv;
}

/**
 * Expand period_config rows into the actual flat period sequence.
 * Groups (same group_id, non-null) repeat together group_repeats times.
 * @param {Object[]} rows - rows from period_config ordered by position
 * @returns {Object[]} flat array of { name, duration, type, cycle }
 */
function expandPeriods(rows) {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  const result = [];
  const seenGroups = new Set();

  for (const row of sorted) {
    if (row.group_id === null || row.group_id === undefined) {
      result.push({ name: row.name, duration: row.duration, type: row.type, cycle: null });
    } else if (!seenGroups.has(row.group_id)) {
      seenGroups.add(row.group_id);
      const groupRows = sorted.filter(r => r.group_id === row.group_id);
      const repeats = row.group_repeats || 1;
      for (let i = 1; i <= repeats; i++) {
        for (const gr of groupRows) {
          result.push({ name: gr.name, duration: gr.duration, type: gr.type, cycle: i });
        }
      }
    }
  }
  return result;
}

function ensureMatchScores(db, matchId) {
  db.prepare(`INSERT OR IGNORE INTO match_scores(match_id, alliance) VALUES (?, 'red')`).run(matchId);
  db.prepare(`INSERT OR IGNORE INTO match_scores(match_id, alliance) VALUES (?, 'blue')`).run(matchId);
}

function getFullScore(db, matchId, alliance) {
  const pv = getPointValues(db);
  const scores = db.prepare('SELECT * FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (!scores) {
    return {
      total: 0, breakdown: {}, raw: null, cycles: [],
      yellow_cards: getEffectiveCards(db, matchId, alliance, 'yellow'),
      red_cards: getEffectiveCards(db, matchId, alliance, 'red'),
    };
  }

  const cycles = db.prepare('SELECT * FROM endgame_cycles WHERE match_id=? AND alliance=?').all(matchId, alliance);
  const opp = alliance === 'red' ? 'blue' : 'red';
  const oppPenalties = db.prepare(
    "SELECT * FROM penalties WHERE match_id=? AND alliance=? AND type IN ('minor','major')"
  ).all(matchId, opp);

  const leaveR1 = scores.auto_leave_r1 ?? 0;
  const leaveR2 = scores.auto_leave_r2 ?? 0;
  const leaveCount = leaveR1 + leaveR2;

  let total = 0;
  total += scores.auto_classified * pv.auto_classified;
  total += scores.auto_overflow * pv.auto_overflow;
  total += leaveCount * pv.auto_leave;
  total += scores.auto_pattern * pv.auto_pattern;
  total += scores.teleop_classified * pv.teleop_classified;
  total += scores.teleop_overflow * pv.teleop_overflow;
  total += (scores.teleop_pattern || 0) * pv.auto_pattern;

  let parkScore = 0;
  for (const c of cycles) {
    const r1 = c.r1_park === 'partial' ? pv.park_partial : c.r1_park === 'full' ? pv.park_full : 0;
    const r2 = c.r2_park === 'partial' ? pv.park_partial : c.r2_park === 'full' ? pv.park_full : 0;
    const bonus = (c.r1_park === 'full' && c.r2_park === 'full') ? pv.park_bonus : 0;
    parkScore += r1 + r2 + bonus;
  }
  total += parkScore;

  let penaltyPts = 0;
  for (const p of oppPenalties) {
    penaltyPts += p.type === 'minor' ? pv.foul_minor : pv.foul_major;
  }
  total += penaltyPts;

  const autoTotal   = scores.auto_classified * pv.auto_classified
                    + scores.auto_overflow   * pv.auto_overflow
                    + leaveCount             * pv.auto_leave
                    + scores.auto_pattern    * pv.auto_pattern;
  const teleopTotal = scores.teleop_classified * pv.teleop_classified
                    + scores.teleop_overflow   * pv.teleop_overflow;

  return {
    total,
    autoTotal,
    teleopTotal,
    // Flat fields so client can access them directly (e.g. allianceData.auto_classified)
    auto_classified: scores.auto_classified,
    auto_overflow: scores.auto_overflow,
    auto_leave_r1: leaveR1,
    auto_leave_r2: leaveR2,
    auto_pattern: scores.auto_pattern,
    pattern_balls: scores.pattern_balls || '000000000',
    teleop_pattern_balls: scores.teleop_pattern_balls || '000000000',
    teleop_classified: scores.teleop_classified,
    teleop_overflow: scores.teleop_overflow,
    penalties: penaltyPts,
    breakdown: {
      auto_classified: scores.auto_classified,
      auto_overflow: scores.auto_overflow,
      auto_leave: leaveCount,
      auto_pattern: scores.auto_pattern,
      teleop_classified: scores.teleop_classified,
      teleop_overflow: scores.teleop_overflow,
      teleop_pattern: scores.teleop_pattern || 0,
      park_score: parkScore,
      penalty_pts: penaltyPts,
    },
    ptsBreakdown: {
      auto_classified: scores.auto_classified * pv.auto_classified,
      auto_overflow:   scores.auto_overflow   * pv.auto_overflow,
      auto_leave:      leaveCount             * pv.auto_leave,
      auto_pattern:    scores.auto_pattern    * pv.auto_pattern,
      teleop_classified: scores.teleop_classified * pv.teleop_classified,
      teleop_overflow:   scores.teleop_overflow   * pv.teleop_overflow,
      teleop_pattern:    (scores.teleop_pattern || 0) * pv.auto_pattern,
      park:     parkScore,
      penalties: penaltyPts,
    },
    raw: scores,
    cycles,
    yellow_cards: getEffectiveCards(db, matchId, alliance, 'yellow'),
    red_cards: getEffectiveCards(db, matchId, alliance, 'red'),
  };
}

/**
 * Effective cards for an alliance in a match = cards issued directly in this
 * match (match_scores.<field>) unioned with each team's outstanding carried
 * card for the match's phase (team_cards). Carried cards are never written
 * into match_scores — they're merged here at read time, so deleting a
 * team_cards row (playoff reset, or a manual delete) takes effect everywhere
 * on the next read without touching any historical match row.
 */
function getEffectiveCards(db, matchId, alliance, cardType) {
  const field = cardType === 'red' ? 'red_cards' : 'yellow_cards';
  const match = db.prepare('SELECT phase, red1, red2, blue1, blue2 FROM matches WHERE id=?').get(matchId);
  if (!match) return [];

  const row = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
  const cards = new Set(JSON.parse(row?.[field] || '[]'));

  const teamIds = alliance === 'red' ? [match.red1, match.red2] : [match.blue1, match.blue2];
  for (const teamId of teamIds) {
    if (!teamId) continue;
    const team = db.prepare('SELECT number FROM teams WHERE id=?').get(teamId);
    if (!team) continue;
    const outstanding = db.prepare(
      'SELECT 1 FROM team_cards WHERE team_number=? AND phase=? AND card_type=?'
    ).get(team.number, match.phase, cardType);
    if (outstanding) cards.add(team.number);
  }
  return Array.from(cards);
}

/**
 * True when an alliance has any effective red card (issued in this match, or
 * carried in from an earlier match in the same phase) — any one team is
 * enough, per the SEC Game Manual: a single confirmed red card ends the
 * match immediately. Used to force an early match end and to auto-grant the
 * opposing alliance's full RP.
 */
function isAllianceRedCarded(db, matchId, alliance) {
  return getEffectiveCards(db, matchId, alliance, 'red').length > 0;
}

// Records a card as outstanding so it carries into the team's future matches
// within the same phase until deleted. No-ops if already outstanding
// (a team can only carry one open yellow and one open red per phase).
function addOutstandingCard(db, matchId, teamNumber, cardType) {
  if (teamNumber == null) return;
  const match = db.prepare('SELECT phase FROM matches WHERE id=?').get(matchId);
  const phase = match && match.phase === 'playoffs' ? 'playoffs' : 'quals';
  db.prepare(`
    INSERT INTO team_cards(team_number, card_type, phase, origin_match_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_number, phase, card_type) DO NOTHING
  `).run(teamNumber, cardType, phase, matchId);
}

// Undoing a card in the same match it was issued in shouldn't leave a
// phantom outstanding record — only clears it if this match is the origin,
// so undoing a carried-in card here (issued in an earlier match) is a no-op.
function clearOutstandingCardIfOrigin(db, matchId, teamNumber, cardType) {
  db.prepare(
    'DELETE FROM team_cards WHERE origin_match_id=? AND team_number=? AND card_type=?'
  ).run(matchId, teamNumber, cardType);
}

// Explicit admin action: stop a card from carrying forward at all, regardless
// of which match it originated in.
function deleteOutstandingCard(db, teamNumber, cardType) {
  db.prepare('DELETE FROM team_cards WHERE team_number=? AND card_type=?').run(teamNumber, cardType);
}

function getOutstandingCards(db) {
  return db.prepare(`
    SELECT tc.id, tc.team_number, tc.card_type, tc.phase, tc.origin_match_id,
           tc.created_at, t.name AS team_name, m.match_number AS origin_match_number
    FROM team_cards tc
    LEFT JOIN teams t ON t.number = tc.team_number
    LEFT JOIN matches m ON m.id = tc.origin_match_id
    ORDER BY tc.created_at DESC
  `).all();
}

module.exports = {
  getDb,
  getSettingsMap,
  getPointValues,
  expandPeriods,
  ensureMatchScores,
  getFullScore,
  getEffectiveCards,
  isAllianceRedCarded,
  addOutstandingCard,
  clearOutstandingCardIfOrigin,
  deleteOutstandingCard,
  getOutstandingCards,
};
