'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

const SqliteSessionStore = require('./session-store');
const { getDb, getSettingsMap, getPointValues, expandPeriods, ensureMatchScores, getFullScore } = require('./db');
const { MatchTimer } = require('./timer');
const { calculateScore, computeLiveRP, getRpOverrides, updateRankings } = require('./scoring');
const { generateSchedule } = require('./scheduler');
const { getAllianceCount, initBracket, getBracket, advanceBracket, getAllianceRoster } = require('./bracket');

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

const db = getDb();
const timer = new MatchTimer(io);

// Reset pattern grid at the start of each new AUTO or TELEOP cycle so scorers start fresh.
// The accumulated count (auto_pattern / teleop_pattern) is preserved for scoring.
timer.onPeriodChange = function(state) {
  if (!timer.matchId || !state.period) return;
  const { type, cycle } = state.period;
  if (type === 'AUTO' && cycle > 1) {
    db.prepare("UPDATE match_scores SET pattern_balls='nnnnnnnnn' WHERE match_id=?").run(timer.matchId);
    broadcastScores(timer.matchId);
  }
  if (type === 'TELEOP' && cycle > 1) {
    db.prepare("UPDATE match_scores SET teleop_pattern_balls='nnnnnnnnn' WHERE match_id=?").run(timer.matchId);
    broadcastScores(timer.matchId);
  }
};

app.use(express.json());
app.use(cookieParser());
app.use(session({
  store: new SqliteSessionStore(), // survives server restarts, not just page refreshes
  secret: 'scorekeeper-secret-2024',
  resave: false,
  saveUninitialized: false,
  rolling: true, // refresh expiry on every request so an active tab never times out mid-event
  cookie: { maxAge: 12 * 60 * 60 * 1000 }, // 12h — survives refreshes/backgrounding for a full event day
}));

// Serve static assets (CSS, JS, sounds)
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js',  express.static(path.join(__dirname, 'public', 'js')));
app.use('/sounds', express.static(path.join(__dirname, 'public', 'sounds')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts')));
// socket.io client is served automatically by the socket.io library
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

// ─── HTML route serving ───────────────────────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, 'public');

function servePage(page) {
  return (_req, res) => res.sendFile(path.join(PUBLIC_DIR, page));
}

// Public — no auth required
app.get('/',           servePage('index.html'));
app.get('/display',    servePage('display.html'));
app.get('/public',     servePage('public.html'));
app.get('/rankings',   servePage('rankings.html'));
app.get('/bracket',    servePage('bracket.html'));

// PIN-protected pages — auth is enforced on the client side via /api/auth/check
app.get('/control',    servePage('control.html'));
app.get('/red',        servePage('red.html'));
app.get('/blue',       servePage('blue.html'));
app.get('/referee',    servePage('referee.html'));
app.get('/headref',    servePage('headref.html'));
app.get('/queue',      servePage('queue.html'));

// Admin
app.get('/admin',      servePage('admin.html'));

// Documentation
app.get('/docs',       servePage('docs.html'));
app.get('/api/docs/readme', (_req, res) => {
  const fs = require('fs');
  const readmePath = path.join(__dirname, 'README.md');
  try {
    const content = fs.readFileSync(readmePath, 'utf8');
    res.type('text/plain').send(content);
  } catch (e) {
    res.status(404).send('README.md not found');
  }
});

// ─── Auth API ─────────────────────────────────────────────────────────────────

const ROLE_TO_SETTING = {
  red:     'pin_red',
  blue:    'pin_blue',
  ref:     'pin_ref',
  headref: 'pin_headref',
  control: 'pin_control',
  queue:   'pin_queue',
};

app.post('/api/auth/pin', (req, res) => {
  const { role, pin } = req.body;
  if (!ROLE_TO_SETTING[role]) return res.status(400).json({ error: 'Unknown role' });
  const settings = getSettingsMap(db);
  const correct = settings[ROLE_TO_SETTING[role]];
  if (String(pin) === String(correct)) {
    req.session.role = role;
    // headref gets ref perms too
    if (role === 'headref') req.session.role = 'headref';
    return res.json({ ok: true, role });
  }
  return res.status(401).json({ error: 'Wrong PIN' });
});

app.post('/api/auth/admin', (req, res) => {
  const { password } = req.body;
  const settings = getSettingsMap(db);
  if (password === settings.admin_password) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/auth/check', (req, res) => {
  const { role } = req.query;
  if (role === 'admin') {
    return req.session.isAdmin ? res.json({ ok: true }) : res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.role === role || (role === 'ref' && req.session.role === 'headref')) {
    return res.json({ ok: true, role: req.session.role });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Teams API ────────────────────────────────────────────────────────────────

app.get('/api/teams', (_req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY number').all();
  res.json(teams);
});

app.post('/api/teams', (req, res) => {
  const { number, name } = req.body;
  if (!number) return res.status(400).json({ error: 'number required' });
  try {
    const result = db.prepare('INSERT INTO teams(number, name) VALUES (?, ?)').run(Number(number), name || '');
    res.json({ id: result.lastInsertRowid, number: Number(number), name: name || '' });
  } catch (e) {
    res.status(400).json({ error: 'Team number already exists' });
  }
});

app.put('/api/teams/:id', (req, res) => {
  const { number, name } = req.body;
  db.prepare('UPDATE teams SET number=?, name=? WHERE id=?').run(Number(number), name || '', Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/teams/:id', (req, res) => {
  db.prepare('DELETE FROM teams WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Import teams from CSV: body is array of { number, name }
app.post('/api/teams/import', (req, res) => {
  const teams = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'Expected array' });
  const insert = db.prepare('INSERT OR IGNORE INTO teams(number, name) VALUES (?, ?)');
  const trx = db.transaction(() => {
    for (const t of teams) insert.run(Number(t.number), t.name || '');
  });
  trx();
  res.json({ ok: true, count: teams.length });
});

// ─── Matches API ──────────────────────────────────────────────────────────────

function matchWithTeams(match) {
  const teamById = (id) => id ? db.prepare('SELECT * FROM teams WHERE id=?').get(id) : null;
  return {
    ...match,
    red1_team: teamById(match.red1),
    red2_team: teamById(match.red2),
    blue1_team: teamById(match.blue1),
    blue2_team: teamById(match.blue2),
  };
}

app.get('/api/matches', (req, res) => {
  const { phase } = req.query;
  const rows = phase
    ? db.prepare('SELECT * FROM matches WHERE phase=? ORDER BY match_number').all(phase)
    : db.prepare('SELECT * FROM matches ORDER BY match_number').all();
  res.json(rows.map(matchWithTeams));
});

app.get('/api/matches/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(matchWithTeams(m));
});

app.post('/api/matches/generate', (req, res) => {
  const settings = getSettingsMap(db);
  const matchesPerTeam = parseInt(settings.matches_per_team || 4);
  const teams = db.prepare('SELECT * FROM teams ORDER BY number').all();
  if (teams.length < 4) return res.status(400).json({ error: 'Need at least 4 teams' });

  // Clear existing quals matches
  const existingQuals = db.prepare("SELECT id FROM matches WHERE phase='quals'").all();
  for (const m of existingQuals) {
    db.prepare('DELETE FROM match_scores WHERE match_id=?').run(m.id);
    db.prepare('DELETE FROM endgame_cycles WHERE match_id=?').run(m.id);
    db.prepare('DELETE FROM penalties WHERE match_id=?').run(m.id);
  }
  db.prepare("DELETE FROM matches WHERE phase='quals'").run();

  try {
    const schedule = generateSchedule(teams, matchesPerTeam);
    const insert = db.prepare(`
      INSERT INTO matches(match_number, phase, red1, red2, blue1, blue2, state)
      VALUES (?, 'quals', ?, ?, ?, ?, 'UPCOMING')
    `);
    const trx = db.transaction(() => {
      for (const m of schedule) insert.run(m.match_number, m.red1, m.red2, m.blue1, m.blue2);
    });
    trx();
    res.json({ ok: true, count: schedule.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/matches/:id/state', (req, res) => {
  const { state } = req.body;
  const validStates = ['UPCOMING', 'QUEUED', 'ON_FIELD', 'COMPLETED'];
  if (!validStates.includes(state)) return res.status(400).json({ error: 'Invalid state' });

  const matchId = Number(req.params.id);
  db.prepare('UPDATE matches SET state=? WHERE id=?').run(state, matchId);

  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  io.emit('match_state_change', { matchId, state, match: matchWithTeams(match) });
  io.emit('queue_update', getQueueState());
  pushQueueData();

  res.json({ ok: true });
});

// Load a match into the timer (ON_FIELD → timer ready)
app.post('/api/matches/:id/load', (req, res) => {
  const matchId = Number(req.params.id);
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  ensureMatchScores(db, matchId);

  const periodRows = db.prepare('SELECT * FROM period_config ORDER BY position').all();
  const periods = expandPeriods(periodRows);
  timer.load(matchId, periods);

  // Broadcast to all clients that a new match is now loaded
  io.emit('match_loaded', { matchId, match: matchWithTeams(match) });
  io.emit('motif_update', { matchId, motif: match.motif || null });

  res.json({ ok: true, periods });
});

// Randomize motif for a match (GPP / PGP / PPG)
const MOTIFS = ['GPP', 'PGP', 'PPG'];

app.post('/api/matches/:id/motif/randomize', (req, res) => {
  const matchId = Number(req.params.id);
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (timer.running && timer.matchId === matchId) {
    return res.status(409).json({ error: 'Cannot change motif while match is running' });
  }

  const motif = MOTIFS[Math.floor(Math.random() * MOTIFS.length)];
  db.prepare('UPDATE matches SET motif=? WHERE id=?').run(motif, matchId);

  io.emit('motif_update', { matchId, motif, reveal: true });
  res.json({ ok: true, motif });
});

app.put('/api/matches/:id/motif', (req, res) => {
  const matchId = Number(req.params.id);
  const { motif } = req.body;
  if (!MOTIFS.includes(motif)) return res.status(400).json({ error: 'Invalid motif' });
  if (timer.running && timer.matchId === matchId) {
    return res.status(409).json({ error: 'Cannot change motif while match is running' });
  }
  db.prepare('UPDATE matches SET motif=? WHERE id=?').run(motif, matchId);
  io.emit('motif_update', { matchId, motif });
  res.json({ ok: true, motif });
});

// ─── Scoring API ──────────────────────────────────────────────────────────────

app.get('/api/matches/:id/scores', (req, res) => {
  const matchId = Number(req.params.id);
  const red = getFullScore(db, matchId, 'red');
  const blue = getFullScore(db, matchId, 'blue');
  const redRP = computeLiveRP(db, matchId, 'red');
  const blueRP = computeLiveRP(db, matchId, 'blue');
  res.json({ red, blue, redRP, blueRP });
});

// ── Head Referee RP Overrides ─────────────────────────────────────────────────

const RP_CATEGORIES = ['win', 'park', 'pattern', 'ball'];

app.get('/api/matches/:id/rp-overrides', (req, res) => {
  const matchId = Number(req.params.id);
  const red = getRpOverrides(db, matchId, 'red');
  const blue = getRpOverrides(db, matchId, 'blue');
  res.json({ red, blue });
});

app.put('/api/matches/:id/rp-overrides', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, category, mode, value } = req.body;
  if (!['red', 'blue'].includes(alliance)) return res.status(400).json({ error: 'Invalid alliance' });
  if (!RP_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!['grant', 'exclude', 'override'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (mode === 'override' && (value === undefined || value === null || isNaN(Number(value)))) {
    return res.status(400).json({ error: 'Override requires a numeric value' });
  }

  db.prepare(`
    INSERT INTO rp_overrides(match_id, alliance, category, mode, value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_id, alliance, category) DO UPDATE SET
      mode=excluded.mode, value=excluded.value, created_at=unixepoch()
  `).run(matchId, alliance, category, mode, mode === 'override' ? Number(value) : null);

  const overrides = { red: getRpOverrides(db, matchId, 'red'), blue: getRpOverrides(db, matchId, 'blue') };
  io.emit('rp_override_changed', { matchId, overrides });
  broadcastScores(matchId);
  res.json({ ok: true, overrides });
});

app.delete('/api/matches/:id/rp-overrides/:alliance/:category', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, category } = req.params;
  db.prepare('DELETE FROM rp_overrides WHERE match_id=? AND alliance=? AND category=?').run(matchId, alliance, category);

  const overrides = { red: getRpOverrides(db, matchId, 'red'), blue: getRpOverrides(db, matchId, 'blue') };
  io.emit('rp_override_changed', { matchId, overrides });
  broadcastScores(matchId);
  res.json({ ok: true, overrides });
});

app.get('/api/matches/:id/penalties', (req, res) => {
  const matchId = Number(req.params.id);
  const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
  res.json(penalties);
});

app.post('/api/matches/:id/penalties', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, type, team_number } = req.body;
  if (!['red', 'blue'].includes(alliance)) return res.status(400).json({ error: 'Invalid alliance' });
  if (!['minor', 'major'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  db.prepare('INSERT INTO penalties(match_id, period_name, match_time, alliance, team_number, type) VALUES (?,?,?,?,?,?)')
    .run(matchId, 'admin', 0, alliance, team_number || null, type);
  broadcastScores(matchId);
  const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
  res.json({ ok: true, penalties });
});

app.delete('/api/matches/:id/penalties/:penaltyId', (req, res) => {
  const matchId = Number(req.params.id);
  const penaltyId = Number(req.params.penaltyId);
  db.prepare('DELETE FROM penalties WHERE id=? AND match_id=?').run(penaltyId, matchId);
  broadcastScores(matchId);
  const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
  res.json({ ok: true, penalties });
});

// ── Head Referee / Admin Notes ────────────────────────────────────────────────

function noteWithMatchNumber(note) {
  const match = db.prepare('SELECT match_number, phase FROM matches WHERE id=?').get(note.match_id);
  return { ...note, match_number: match ? match.match_number : null, phase: match ? match.phase : null };
}

app.get('/api/notes', (req, res) => {
  const { team, match } = req.query;
  let notes;
  if (team) {
    notes = db.prepare('SELECT * FROM notes WHERE team_number=? ORDER BY created_at DESC').all(Number(team));
  } else if (match) {
    const m = db.prepare('SELECT id FROM matches WHERE match_number=?').get(Number(match));
    notes = m ? db.prepare('SELECT * FROM notes WHERE match_id=? ORDER BY created_at DESC').all(m.id) : [];
  } else {
    notes = db.prepare('SELECT * FROM notes ORDER BY created_at DESC').all();
  }
  res.json(notes.map(noteWithMatchNumber));
});

app.post('/api/notes', (req, res) => {
  const { matchId, alliance, teamNumber, note, author } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  if (!note || !note.trim()) return res.status(400).json({ error: 'note text required' });
  if (alliance && !['red', 'blue'].includes(alliance)) return res.status(400).json({ error: 'Invalid alliance' });

  const info = db.prepare(`
    INSERT INTO notes(match_id, alliance, team_number, note, author)
    VALUES (?, ?, ?, ?, ?)
  `).run(matchId, alliance || null, teamNumber || null, note.trim(), author === 'admin' ? 'admin' : 'headref');

  const created = noteWithMatchNumber(db.prepare('SELECT * FROM notes WHERE id=?').get(info.lastInsertRowid));
  io.emit('note_added', created);
  res.json({ ok: true, note: created });
});

app.put('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  const { note, alliance, teamNumber } = req.body;
  const existing = db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  if (alliance && !['red', 'blue'].includes(alliance)) return res.status(400).json({ error: 'Invalid alliance' });

  db.prepare(`
    UPDATE notes SET
      note=?,
      alliance=?,
      team_number=?,
      updated_at=unixepoch()
    WHERE id=?
  `).run(
    note != null ? note.trim() : existing.note,
    alliance !== undefined ? (alliance || null) : existing.alliance,
    teamNumber !== undefined ? (teamNumber || null) : existing.team_number,
    id
  );

  const updated = noteWithMatchNumber(db.prepare('SELECT * FROM notes WHERE id=?').get(id));
  io.emit('note_updated', updated);
  res.json({ ok: true, note: updated });
});

app.delete('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM notes WHERE id=?').run(id);
  io.emit('note_removed', { id });
  res.json({ ok: true });
});

// Commit final scores → update rankings
// ─── Push public snapshot to Vercel ──────────────────────────────────────────

function pushPublicData() {
  const vercelUrl = process.env.PUBLIC_VERCEL_URL;
  const secret    = process.env.SYNC_SECRET;
  if (!vercelUrl || !secret) return; // not configured, skip silently

  const matches   = db.prepare('SELECT * FROM matches ORDER BY match_number').all().map(matchWithTeams);
  const completed = db.prepare("SELECT id FROM matches WHERE state='COMPLETED'").all();
  const results   = {};
  for (const m of completed) {
    const red  = getFullScore(db, m.id, 'red');
    const blue = getFullScore(db, m.id, 'blue');
    results[m.id] = { red: red.total, blue: blue.total };
  }
  const rankings = updateRankings(db);
  const bracket  = getBracket(db);

  const body = JSON.stringify({ rankings, matches, results, bracket, updatedAt: new Date().toISOString() });

  fetch(vercelUrl + '/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
    body,
  }).then(function (r) {
    if (!r.ok) console.error('[public sync] HTTP', r.status);
  }).catch(function (err) {
    console.error('[public sync] failed:', err.message);
  });
}

// ─── Push queue snapshot to Vercel (PIN-gated public queue view) ─────────────

function pushQueueData() {
  const vercelUrl = process.env.PUBLIC_VERCEL_URL;
  const secret    = process.env.SYNC_SECRET;
  if (!vercelUrl || !secret) return; // not configured, skip silently

  const settings = getSettingsMap(db);
  const body = JSON.stringify({ ...getQueueState(), pin: settings.pin_queue, updatedAt: new Date().toISOString() });

  fetch(vercelUrl + '/api/queue-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
    body,
  }).then(function (r) {
    if (!r.ok) console.error('[queue sync] HTTP', r.status);
  }).catch(function (err) {
    console.error('[queue sync] failed:', err.message);
  });
}

// If this match is linked to a bracket slot, record the winning alliance
// (by score comparison) once it's committed. Ties are left unresolved for
// the admin to set manually via POST /api/bracket/matches/:id/winner —
// elimination matches aren't expected to tie under normal play.
function recordBracketWinnerIfLinked(matchId) {
  const slot = db.prepare('SELECT id, red_alliance, blue_alliance FROM bracket_matches WHERE match_id=?').get(matchId);
  if (!slot) return;
  const redTotal = getFullScore(db, matchId, 'red').total;
  const blueTotal = getFullScore(db, matchId, 'blue').total;
  if (redTotal === blueTotal) return;
  const winnerAlliance = redTotal > blueTotal ? slot.red_alliance : slot.blue_alliance;
  advanceBracket(db, slot.id, winnerAlliance);
  io.emit('bracket_update', getBracket(db));
}

app.post('/api/matches/:id/commit', (req, res) => {
  const matchId = Number(req.params.id);
  db.prepare("UPDATE match_scores SET committed=1 WHERE match_id=?").run(matchId);
  db.prepare("UPDATE matches SET state='COMPLETED' WHERE id=?").run(matchId);

  const rankings = updateRankings(db);
  io.emit('rankings_update', rankings);
  io.emit('queue_update', getQueueState());
  io.emit('match_state_change', { matchId, state: 'COMPLETED' });

  recordBracketWinnerIfLinked(matchId);
  pushPublicData();
  pushQueueData();

  res.json({ ok: true, rankings });
});

// Override a score field (head ref / match history editor)
app.post('/api/matches/:id/override', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, field, value, changedBy } = req.body;

  const numericFields = ['auto_classified','auto_overflow','auto_leave','auto_leave_r1','auto_leave_r2','auto_pattern',
    'teleop_classified','teleop_overflow','teleop_pattern'];
  const cardFields = ['yellow_cards','red_cards'];
  if (!numericFields.includes(field) && !cardFields.includes(field)) {
    return res.status(400).json({ error: 'Unknown field' });
  }

  if (!['red', 'blue'].includes(alliance)) return res.status(400).json({ error: 'Unknown alliance' });

  const current = db.prepare(`SELECT ${field}, committed FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);

  let stored;
  if (cardFields.includes(field)) {
    if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v))) {
      return res.status(400).json({ error: 'Card value must be an array of team numbers' });
    }
    stored = JSON.stringify(value);
  } else {
    stored = Number(value);
  }

  db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(stored, matchId, alliance);
  db.prepare('INSERT INTO score_audit(match_id, alliance, field, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?)')
    .run(matchId, alliance, field, String(current ? current[field] : 0), String(stored), changedBy || 'headref');

  broadcastScores(matchId);

  // Editing an already-committed match must re-run rankings
  if (current && current.committed === 1) {
    io.emit('rankings_update', updateRankings(db));
  }

  res.json({ ok: true });
});

// Replay: reset scores for a match
app.post('/api/matches/:id/replay', (req, res) => {
  const matchId = Number(req.params.id);
  db.prepare("UPDATE match_scores SET auto_classified=0,auto_overflow=0,auto_leave=0,auto_leave_r1=0,auto_leave_r2=0,auto_pattern=0,pattern_balls='nnnnnnnnn',teleop_classified=0,teleop_overflow=0,teleop_balls=0,teleop_pattern=0,teleop_pattern_balls='nnnnnnnnn',yellow_cards=?,red_cards=?,committed=0 WHERE match_id=?")
    .run('[]', '[]', matchId);
  db.prepare('DELETE FROM endgame_cycles WHERE match_id=?').run(matchId);
  db.prepare('DELETE FROM penalties WHERE match_id=?').run(matchId);
  db.prepare("UPDATE matches SET state='ON_FIELD' WHERE id=?").run(matchId);

  broadcastScores(matchId);
  io.emit('match_replay', { matchId });
  res.json({ ok: true });
});

// Reveal scores → winner animation + results screen on /display
app.post('/api/matches/:id/reveal', (req, res) => {
  const matchId = Number(req.params.id);
  if (timer.matchId !== matchId) return res.status(409).json({ error: 'Match not loaded' });
  if (!timer.matchEnded) return res.status(409).json({ error: 'Match not ended yet' });
  if (timer.scoresRevealed) return res.status(409).json({ error: 'Scores already revealed' });

  const results = buildResultsPayload(matchId);
  if (!results) return res.status(404).json({ error: 'Match not found' });
  timer.scoresRevealed = true;
  io.emit('scores_reveal', results);
  res.json({ ok: true });
});

// Results payload (page-refresh recovery for /display)
app.get('/api/matches/:id/results', (req, res) => {
  const results = buildResultsPayload(Number(req.params.id));
  if (!results) return res.status(404).json({ error: 'Match not found' });
  res.json(results);
});

// Bulk score totals for all completed matches (used by public view)
app.get('/api/results', (_req, res) => {
  const matches = db.prepare("SELECT id FROM matches WHERE state='COMPLETED'").all();
  const out = {};
  for (const m of matches) {
    const red  = getFullScore(db, m.id, 'red');
    const blue = getFullScore(db, m.id, 'blue');
    out[m.id] = { red: red.total, blue: blue.total };
  }
  res.json(out);
});

// Audit log (head ref)
app.get('/api/matches/:id/audit', (req, res) => {
  const rows = db.prepare('SELECT * FROM score_audit WHERE match_id=? ORDER BY created_at').all(Number(req.params.id));
  res.json(rows);
});

// ─── Settings API ─────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(getSettingsMap(db));
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)');
  const trx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      upsert.run(key, String(value));
    }
  });
  trx();
  res.json({ ok: true });
});

// ─── Period config API ────────────────────────────────────────────────────────

app.get('/api/periods', (_req, res) => {
  const rows = db.prepare('SELECT * FROM period_config ORDER BY position').all();
  res.json(rows);
});

app.put('/api/periods', (req, res) => {
  const periods = Array.isArray(req.body) ? req.body : req.body?.periods;
  if (!Array.isArray(periods)) return res.status(400).json({ error: 'Expected array' });

  db.prepare('DELETE FROM period_config').run();
  const insert = db.prepare(`
    INSERT INTO period_config(position, name, duration, type, group_id, group_repeats)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const trx = db.transaction(() => {
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      insert.run(i + 1, p.name, Number(p.duration), p.type, p.group_id ?? null, Number(p.group_repeats) || 1);
    }
  });
  trx();
  res.json({ ok: true });
});

// ─── Network info API ─────────────────────────────────────────────────────────

app.get('/api/network-info', (_req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  res.json({ port: PORT, urls: ips.map((ip) => `http://${ip}:${PORT}`) });
});

// ─── Rankings API ─────────────────────────────────────────────────────────────

app.get('/api/rankings', (_req, res) => {
  res.json(updateRankings(db));
});

// ─── Queue state API ──────────────────────────────────────────────────────────

function getQueueState() {
  const onField = db.prepare("SELECT * FROM matches WHERE state='ON_FIELD' ORDER BY match_number").get();
  const queued  = db.prepare("SELECT * FROM matches WHERE state='QUEUED' ORDER BY match_number").all();
  const upcoming = db.prepare("SELECT * FROM matches WHERE state='UPCOMING' ORDER BY match_number LIMIT 3").all();

  return {
    onField: onField ? matchWithTeams(onField) : null,
    queued: queued.map(matchWithTeams),
    upcoming: upcoming.map(matchWithTeams),
  };
}

app.get('/api/queue', (_req, res) => {
  res.json(getQueueState());
});

// ─── Bracket API ──────────────────────────────────────────────────────────────

app.get('/api/bracket', (_req, res) => {
  res.json(getBracket(db));
});

app.post('/api/bracket/init', (req, res) => {
  const teams = db.prepare('SELECT COUNT(*) as c FROM teams').get();
  const count = getAllianceCount(teams.c);
  initBracket(db, count);
  io.emit('bracket_update', getBracket(db));
  res.json({ ok: true, allianceCount: count });
});

app.post('/api/bracket/matches/:id/winner', (req, res) => {
  const { winnerAlliance } = req.body;
  advanceBracket(db, Number(req.params.id), winnerAlliance);
  io.emit('bracket_update', getBracket(db));
  res.json({ ok: true });
});

// Manually route a recorded winner/loser (or a base seed) into a later
// round's TBD slot. Used by the admin "Bracket Matches" UI since the exact
// winners/losers topology differs by alliance count (4/6/8) and is guided by
// the admin rather than auto-computed (see bracket.js's advanceBracket doc).
app.post('/api/bracket/matches/:id/assign', (req, res) => {
  const bracketMatchId = Number(req.params.id);
  const { side, allianceNumber } = req.body;
  if (!['red', 'blue'].includes(side)) return res.status(400).json({ error: 'side must be red or blue' });
  const field = side === 'red' ? 'red_alliance' : 'blue_alliance';
  db.prepare(`UPDATE bracket_matches SET ${field}=? WHERE id=?`).run(allianceNumber ?? null, bracketMatchId);
  io.emit('bracket_update', getBracket(db));
  res.json({ ok: true, bracket: getBracket(db) });
});

// Create the actual scoreable match for a bracket slot once both alliances
// are known. Idempotent — if the slot already has a linked match, returns it
// instead of creating a duplicate.
app.post('/api/bracket/matches/:id/create-match', (req, res) => {
  const bracketMatchId = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM bracket_matches WHERE id=?').get(bracketMatchId);
  if (!slot) return res.status(404).json({ error: 'Bracket match not found' });
  if (slot.match_id) {
    return res.json({ ok: true, matchId: slot.match_id, alreadyExisted: true });
  }
  if (slot.red_alliance == null || slot.blue_alliance == null) {
    return res.status(400).json({ error: 'Both red and blue alliances must be assigned first' });
  }

  const redRoster = getAllianceRoster(db, slot.red_alliance);
  const blueRoster = getAllianceRoster(db, slot.blue_alliance);
  if (!redRoster || !redRoster.captain_team) return res.status(400).json({ error: `Alliance ${slot.red_alliance} has no captain set` });
  if (!blueRoster || !blueRoster.captain_team) return res.status(400).json({ error: `Alliance ${slot.blue_alliance} has no captain set` });

  const next = db.prepare("SELECT MAX(match_number) as maxNum FROM matches WHERE phase='playoffs'").get();
  const matchNumber = (next.maxNum || 0) + 1;

  const info = db.prepare(`
    INSERT INTO matches(match_number, phase, red1, red2, blue1, blue2, state)
    VALUES (?, 'playoffs', ?, ?, ?, ?, 'UPCOMING')
  `).run(matchNumber, redRoster.captain_team, redRoster.partner_team || null, blueRoster.captain_team, blueRoster.partner_team || null);

  const matchId = info.lastInsertRowid;
  ensureMatchScores(db, matchId);
  db.prepare('UPDATE bracket_matches SET match_id=? WHERE id=?').run(matchId, bracketMatchId);

  io.emit('bracket_update', getBracket(db));
  io.emit('queue_update', getQueueState());
  pushQueueData();
  res.json({ ok: true, matchId, matchNumber });
});

// ─── Alliance selections API ──────────────────────────────────────────────────

app.get('/api/alliances', (_req, res) => {
  const rows = db.prepare(`
    SELECT a.*, t1.number as captain_number, t1.name as captain_name,
           t2.number as partner_number, t2.name as partner_name
    FROM alliance_selections a
    LEFT JOIN teams t1 ON t1.id = a.captain_team
    LEFT JOIN teams t2 ON t2.id = a.partner_team
    ORDER BY a.alliance_number
  `).all();
  res.json(rows);
});

app.post('/api/alliances', (req, res) => {
  const { alliance_number, captainNumber, partnerNumber } = req.body;
  if (!alliance_number) return res.status(400).json({ error: 'alliance_number required' });
  if (!captainNumber) return res.status(400).json({ error: 'captainNumber required' });

  const captain = db.prepare('SELECT id FROM teams WHERE number=?').get(captainNumber);
  if (!captain) return res.status(400).json({ error: 'Unknown captain team number' });

  let partnerId = null;
  if (partnerNumber) {
    const partner = db.prepare('SELECT id FROM teams WHERE number=?').get(partnerNumber);
    if (!partner) return res.status(400).json({ error: 'Unknown partner team number' });
    partnerId = partner.id;
  }

  db.prepare(`
    INSERT INTO alliance_selections(alliance_number, captain_team, partner_team)
    VALUES (?, ?, ?)
    ON CONFLICT(alliance_number) DO UPDATE SET captain_team=excluded.captain_team, partner_team=excluded.partner_team
  `).run(alliance_number, captain.id, partnerId);

  io.emit('bracket_update', getBracket(db));
  res.json({ ok: true });
});

// ─── Timer control API ────────────────────────────────────────────────────────

app.post('/api/timer/start',   (_req, res) => { timer.start();   res.json(timer.getState()); });
app.post('/api/timer/pause',   (_req, res) => { timer.pause();   res.json(timer.getState()); });
app.post('/api/timer/resume',  (_req, res) => { timer.resume();  res.json(timer.getState()); });
app.post('/api/timer/abort',   (_req, res) => { timer.abort();   res.json({ ok: true }); });
app.post('/api/timer/advance', (_req, res) => { timer.manualAdvance(); res.json(timer.getState()); });
app.get('/api/timer',          (_req, res) => { res.json(timer.getState()); });

// ─── Admin reset ──────────────────────────────────────────────────────────────

app.post('/api/admin/reset', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Send { confirm: "RESET" }' });

  timer.abort();

  db.prepare('DELETE FROM score_audit').run();
  db.prepare('DELETE FROM penalties').run();
  db.prepare('DELETE FROM endgame_cycles').run();
  db.prepare('DELETE FROM match_scores').run();
  db.prepare('DELETE FROM bracket_matches').run();
  db.prepare('DELETE FROM alliance_selections').run();
  db.prepare('DELETE FROM notes').run();
  db.prepare('DELETE FROM rp_overrides').run();
  db.prepare('DELETE FROM matches').run();
  db.prepare('DELETE FROM teams').run();

  io.emit('full_reset', {});
  res.json({ ok: true });
});

// ─── Export CSV ───────────────────────────────────────────────────────────────

app.get('/api/export/rankings.csv', (_req, res) => {
  const rankings = updateRankings(db);
  const lines = ['Rank,Team#,Name,RP,AvgScore,W,L,T,HighScore'];
  for (const r of rankings) {
    lines.push(`${r.rank},${r.teamNumber},"${r.teamName}",${r.rp},${r.avgScore},${r.wins},${r.losses},${r.ties},${r.highScore}`);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rankings.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/export/schedule.csv', (_req, res) => {
  const matches = db.prepare("SELECT * FROM matches ORDER BY match_number").all();
  const lines = ['Match#,Phase,Red1,Red2,Blue1,Blue2,State'];
  for (const m of matches) {
    const t = (id) => id ? (db.prepare('SELECT number FROM teams WHERE id=?').get(id)?.number || '') : '';
    lines.push(`${m.match_number},${m.phase},${t(m.red1)},${t(m.red2)},${t(m.blue1)},${t(m.blue2)},${m.state}`);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule.csv"');
  res.send(lines.join('\n'));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildResultsPayload(matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return null;

  const red = getFullScore(db, matchId, 'red');
  const blue = getFullScore(db, matchId, 'blue');
  const redRP = computeLiveRP(db, matchId, 'red');
  const blueRP = computeLiveRP(db, matchId, 'blue');
  const matchCount = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE phase=?').get(match.phase).c;

  // Category points for the results screen rows
  const cat = (s) => {
    const p = s.ptsBreakdown || {};
    return {
      leave:    p.auto_leave || 0,
      artifact: (p.auto_classified || 0) + (p.auto_overflow || 0) + (p.teleop_classified || 0) + (p.teleop_overflow || 0),
      pattern:  (p.auto_pattern || 0) + (p.teleop_pattern || 0),
      base:     p.park || 0,
      foul:     p.penalties || 0,
    };
  };

  // Provisional rank movement: rankings without vs with this (uncommitted) match
  const before = updateRankings(db);
  const after  = updateRankings(db, matchId);
  const rankOf = (list, teamId) => {
    const r = list.find((x) => x.teamId === teamId);
    return r ? r.rank : null;
  };
  const teamEntry = (teamId) => {
    if (!teamId) return null;
    const t = db.prepare('SELECT * FROM teams WHERE id=?').get(teamId);
    if (!t) return null;
    const b = rankOf(before, teamId);
    const a = rankOf(after, teamId);
    return { number: t.number, rank: a, delta: b != null && a != null ? b - a : null };
  };

  const winner = red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : 'tie';

  return {
    matchId,
    match: matchWithTeams(match),
    matchCount,
    red:  { total: red.total,  breakdown: cat(red),  rp: redRP },
    blue: { total: blue.total, breakdown: cat(blue), rp: blueRP },
    winner,
    teams: {
      red:  [teamEntry(match.red1), teamEntry(match.red2)].filter(Boolean),
      blue: [teamEntry(match.blue1), teamEntry(match.blue2)].filter(Boolean),
    },
  };
}

// ── Card sync (match_scores.yellow_cards / red_cards) ─────────────────────────
// Keeps the alliance-level card arrays (used for DQ/RP detection) in sync with
// whichever team a card was issued to or rescinded from via the unified
// 'penalty' / 'remove_penalty' events.

function addCardToMatchScores(matchId, alliance, cardType, teamNumber) {
  if (teamNumber == null) return;
  const field = cardType === 'red' ? 'red_cards' : 'yellow_cards';
  const row = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
  const cards = JSON.parse(row?.[field] || '[]');
  if (!cards.includes(teamNumber)) cards.push(teamNumber);
  db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(JSON.stringify(cards), matchId, alliance);
}

function removeCardFromMatchScores(matchId, alliance, cardType, teamNumber) {
  if (teamNumber == null) return;
  const field = cardType === 'red' ? 'red_cards' : 'yellow_cards';
  const row = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
  const cards = JSON.parse(row?.[field] || '[]').filter(n => n !== teamNumber);
  db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(JSON.stringify(cards), matchId, alliance);
}

function broadcastScores(matchId) {
  const red = getFullScore(db, matchId, 'red');
  const blue = getFullScore(db, matchId, 'blue');
  const redRP = computeLiveRP(db, matchId, 'red');
  const blueRP = computeLiveRP(db, matchId, 'blue');
  // Attach current-cycle park status for scorer UIs
  const cycle = timer.endgameCycle || 0;
  for (const scoreObj of [red, blue]) {
    const cyc = cycle > 0 ? scoreObj.cycles.find(c => c.cycle === cycle) : null;
    scoreObj.park_r1 = cyc ? cyc.r1_park : 'none';
    scoreObj.park_r2 = cyc ? cyc.r2_park : 'none';
  }
  io.emit('score_update', { matchId, red, blue, redRP, blueRP });
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Send current state to newly connected client
  socket.emit('timer_state', timer.getState());
  socket.emit('queue_update', getQueueState());

  // Send current match scores and motif if a match is loaded
  if (timer.matchId) {
    broadcastScores(timer.matchId);
    const loadedMatch = db.prepare('SELECT motif FROM matches WHERE id=?').get(timer.matchId);
    socket.emit('motif_update', { matchId: timer.matchId, motif: (loadedMatch && loadedMatch.motif) || null });
  }

  // ── Score updates from scorers ──────────────────────────────────────────

  socket.on('score_increment', ({ matchId, alliance, field }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!['red', 'blue'].includes(alliance)) return;

    const scoreFields = ['auto_classified','auto_overflow','teleop_classified','teleop_overflow'];
    if (!scoreFields.includes(field)) return;

    // Classified/Overflow stay correctable through every period — including
    // TRANSITION and BUZZER — and during post-match review.
    if (!timer.matchEnded && !timer.running) return;

    db.prepare(`UPDATE match_scores SET ${field}=${field}+1 WHERE match_id=? AND alliance=?`).run(matchId, alliance);
    broadcastScores(matchId);
  });

  // Boolean toggle fields (auto_leave_r1, auto_leave_r2)
  socket.on('score_set', ({ matchId, alliance, field, value }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!['red', 'blue'].includes(alliance)) return;
    if (!timer.matchEnded) {
      if (!timer.running) return;
      const period = timer.currentPeriod;
      // Allow setting auto_leave during TRANSITION so scorers can correct it after AUTO ends
      if (!period || period.type === 'BUZZER') return;
    }

    const setFields = ['auto_leave_r1', 'auto_leave_r2'];
    if (!setFields.includes(field)) return;

    const safeVal = value ? 1 : 0;
    db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(safeVal, matchId, alliance);
    broadcastScores(matchId);
  });

  // ── Pattern ball selection ──────────────────────────────────────────────
  // color: 'green' | 'purple' | 'none'
  // Scoring: count positions where selected color matches the match motif (G/P repeating per gate).
  function computePatternMatches(balls, motif) {
    if (!motif) return 0;
    let count = 0;
    for (let i = 0; i < 9; i++) {
      const sel = balls[i];
      const expected = motif[i % 3]; // 'G' or 'P'
      if ((sel === 'g' && expected === 'G') || (sel === 'p' && expected === 'P')) count++;
    }
    return count;
  }

  socket.on('pattern_ball', ({ matchId, alliance, ballIdx, color }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.running && !timer.matchEnded) return;
    if (typeof ballIdx !== 'number' || ballIdx < 0 || ballIdx > 8) return;
    if (!['red', 'blue'].includes(alliance)) return;
    if (!['green','purple','none'].includes(color)) return;

    const period = timer.currentPeriod;
    const grid = timer.matchEnded
      ? 'teleop'
      : period && ['AUTO','TRANSITION'].includes(period.type) ? 'auto'
      : period && ['TELEOP','ENDGAME','BUZZER'].includes(period.type) ? 'teleop'
      : null;
    if (!grid) return;

    const colorChar = color === 'green' ? 'g' : color === 'purple' ? 'p' : 'n';
    const matchRow = db.prepare('SELECT motif FROM matches WHERE id=?').get(matchId);
    const motif = matchRow?.motif || null;

    if (grid === 'auto') {
      const row = db.prepare('SELECT pattern_balls, auto_pattern FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
      const prevGrid = row?.pattern_balls || 'nnnnnnnnn';
      const base = (row?.auto_pattern || 0) - computePatternMatches(prevGrid.split(''), motif);
      const arr = prevGrid.split('');
      arr[ballIdx] = colorChar;
      const newBalls = arr.join('');
      db.prepare('UPDATE match_scores SET pattern_balls=?, auto_pattern=? WHERE match_id=? AND alliance=?')
        .run(newBalls, base + computePatternMatches(arr, motif), matchId, alliance);
      broadcastScores(matchId);
    } else {
      const row = db.prepare('SELECT teleop_pattern_balls, teleop_pattern FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
      const prevGrid = row?.teleop_pattern_balls || 'nnnnnnnnn';
      const base = (row?.teleop_pattern || 0) - computePatternMatches(prevGrid.split(''), motif);
      const arr = prevGrid.split('');
      arr[ballIdx] = colorChar;
      const newBalls = arr.join('');
      db.prepare('UPDATE match_scores SET teleop_pattern_balls=?, teleop_pattern=? WHERE match_id=? AND alliance=?')
        .run(newBalls, base + computePatternMatches(arr, motif), matchId, alliance);
      broadcastScores(matchId);
    }
  });

  socket.on('score_decrement', ({ matchId, alliance, field }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!['red', 'blue'].includes(alliance)) return;
    // Whitelist before SQL interpolation (field is spliced into the query below)
    const decFields = ['auto_classified','auto_overflow',
      'teleop_classified','teleop_overflow'];
    if (!decFields.includes(field)) return;

    // Classified/Overflow stay correctable through every period — including
    // TRANSITION and BUZZER — and during post-match review.
    if (!timer.matchEnded && !timer.running) return;

    const cur = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
    if (!cur || cur[field] <= 0) return;

    db.prepare(`UPDATE match_scores SET ${field}=${field}-1 WHERE match_id=? AND alliance=?`).run(matchId, alliance);
    broadcastScores(matchId);
  });

  // ── Park status (endgame) ───────────────────────────────────────────────

  socket.on('park_update', ({ matchId, alliance, robot, status }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.matchEnded) {
      const period = timer.currentPeriod;
      // Accepted through TELEOP too so a park call can still be entered/corrected
      // in the following TELEOP, right up until the next ENDGAME starts a new cycle.
      if (!period || !['TELEOP', 'ENDGAME', 'BUZZER'].includes(period.type)) return;
    }

    const cycle = timer.endgameCycle || 1;
    const col = robot === 1 ? 'r1_park' : 'r2_park';
    db.prepare(`
      INSERT INTO endgame_cycles(match_id, alliance, cycle, ${col})
      VALUES (?, ?, ?, ?)
      ON CONFLICT(match_id, alliance, cycle) DO UPDATE SET ${col}=excluded.${col}
    `).run(matchId, alliance, cycle, status);
    broadcastScores(matchId);
  });

  // ── Penalties ───────────────────────────────────────────────────────────

  socket.on('penalty', ({ matchId, alliance, teamNumber, type }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    const period = timer.currentPeriod;
    const matchTime = period ? (period.duration - timer.timeRemaining) : 0;

    db.prepare(`
      INSERT INTO penalties(match_id, period_name, match_time, alliance, team_number, type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(matchId, period?.name || '', matchTime, alliance, teamNumber || null, type);

    if (type === 'yellow' || type === 'red') {
      addCardToMatchScores(matchId, alliance, type, teamNumber);
    }

    const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
    io.emit('penalty_added', { matchId, penalty: penalties[penalties.length - 1], all: penalties });

    broadcastScores(matchId);

    // Per the SEC Game Manual: any confirmed red card ends the match
    // immediately — the opposing alliance is auto-awarded every RP category
    // (see computeRpBreakdown).
    if (type === 'red' && !timer.matchEnded) {
      timer.forceEnd();
    }
  });

  socket.on('remove_penalty', ({ matchId, alliance, type, teamNumber }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!['red', 'blue'].includes(alliance)) return;
    if (!['minor', 'major', 'yellow', 'red'].includes(type)) return;
    const last = teamNumber != null
      ? db.prepare(
          'SELECT id, team_number FROM penalties WHERE match_id=? AND alliance=? AND type=? AND team_number=? ORDER BY created_at DESC LIMIT 1'
        ).get(matchId, alliance, type, teamNumber)
      : db.prepare(
          'SELECT id, team_number FROM penalties WHERE match_id=? AND alliance=? AND type=? ORDER BY created_at DESC LIMIT 1'
        ).get(matchId, alliance, type);
    if (!last) return;
    db.prepare('DELETE FROM penalties WHERE id=?').run(last.id);

    if ((type === 'yellow' || type === 'red') && last.team_number != null) {
      removeCardFromMatchScores(matchId, alliance, type, last.team_number);
    }

    const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
    io.emit('penalty_removed', { matchId, removedId: last.id, all: penalties });
    broadcastScores(matchId);
  });

  // ── Card management ─────────────────────────────────────────────────────
  // (legacy direct-card events — the current UI issues cards via 'penalty' above)

  socket.on('add_yellow_card', ({ matchId, alliance, teamNumber }) => {
    addCardToMatchScores(matchId, alliance, 'yellow', teamNumber);
    broadcastScores(matchId);
  });

  socket.on('add_red_card', ({ matchId, alliance, teamNumber }) => {
    addCardToMatchScores(matchId, alliance, 'red', teamNumber);
    broadcastScores(matchId);
    if (!timer.matchEnded) {
      timer.forceEnd();
    }
  });

  socket.on('remove_card', ({ matchId, alliance, teamNumber, cardType }) => {
    removeCardFromMatchScores(matchId, alliance, cardType, teamNumber);
    broadcastScores(matchId);
  });

  // ── Timer control ───────────────────────────────────────────────────────

  socket.on('timer_start',   () => timer.start());
  socket.on('timer_pause',   () => timer.pause());
  socket.on('timer_resume',  () => timer.resume());
  socket.on('timer_abort',   () => timer.abort());
  socket.on('timer_advance', () => timer.manualAdvance());
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log(`\n=== Score Keeper running on port ${PORT} ===`);
  console.log('Access from this machine: http://localhost:' + PORT);
  for (const ip of ips) {
    console.log('Network access:           http://' + ip + ':' + PORT);
  }
  console.log('');

  // Keep the public site in sync with local state even between match commits
  // (team roster changes, schedule regeneration, bracket updates, etc.) —
  // pushPublicData() itself is fire-and-forget and no-ops if unconfigured.
  pushPublicData();
  setInterval(pushPublicData, 20000);
  pushQueueData();
  setInterval(pushQueueData, 20000);
});
