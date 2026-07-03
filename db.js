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
}

const DEFAULT_SETTINGS = {
  pts_auto_classified: '3',
  pts_auto_overflow: '1',
  pts_auto_leave: '5',
  pts_auto_pattern: '2',
  pts_teleop_classified: '3',
  pts_teleop_overflow: '1',
  pts_teleop_balls: '1',
  pts_park_partial: '5',
  pts_park_full: '10',
  pts_park_bonus: '10',
  pts_foul_minor: '5',
  pts_foul_major: '15',
  rp_win: '4',
  rp_tie: '2',
  rp_loss: '0',
  rp_park_threshold_1: '63',
  rp_park_threshold_2: '90',
  rp_pattern_threshold_1: '23',
  rp_pattern_threshold_2: '33',
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
  { position: 2, name: 'TRANSITION', duration: 8,   type: 'TRANSITION', group_id: null, group_repeats: 1 },
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
  if (!scores) return { total: 0, breakdown: {}, raw: null, cycles: [], yellow_cards: [], red_cards: [] };

  const cycles = db.prepare('SELECT * FROM endgame_cycles WHERE match_id=? AND alliance=?').all(matchId, alliance);
  const opp = alliance === 'red' ? 'blue' : 'red';
  const oppPenalties = db.prepare(
    "SELECT * FROM penalties WHERE match_id=? AND alliance=? AND type IN ('minor','major')"
  ).all(matchId, opp);

  let total = 0;
  total += scores.auto_classified * pv.auto_classified;
  total += scores.auto_overflow * pv.auto_overflow;
  total += scores.auto_leave * pv.auto_leave;
  total += scores.auto_pattern * pv.auto_pattern;
  total += scores.teleop_classified * pv.teleop_classified;
  total += scores.teleop_overflow * pv.teleop_overflow;
  total += scores.teleop_balls * pv.teleop_balls;

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
                    + scores.auto_leave      * pv.auto_leave
                    + scores.auto_pattern    * pv.auto_pattern;
  const teleopTotal = scores.teleop_classified * pv.teleop_classified
                    + scores.teleop_overflow   * pv.teleop_overflow
                    + scores.teleop_balls      * pv.teleop_balls;

  return {
    total,
    autoTotal,
    teleopTotal,
    breakdown: {
      auto_classified: scores.auto_classified,
      auto_overflow: scores.auto_overflow,
      auto_leave: scores.auto_leave,
      auto_pattern: scores.auto_pattern,
      teleop_classified: scores.teleop_classified,
      teleop_overflow: scores.teleop_overflow,
      teleop_balls: scores.teleop_balls,
      park_score: parkScore,
      penalty_pts: penaltyPts,
    },
    raw: scores,
    cycles,
    yellow_cards: JSON.parse(scores.yellow_cards || '[]'),
    red_cards: JSON.parse(scores.red_cards || '[]'),
  };
}

module.exports = {
  getDb,
  getSettingsMap,
  getPointValues,
  expandPeriods,
  ensureMatchScores,
  getFullScore,
};
