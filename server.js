'use strict';

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

const { getDb, getSettingsMap, getPointValues, expandPeriods, ensureMatchScores, getFullScore } = require('./db');
const { MatchTimer } = require('./timer');
const { calculateScore, computeLiveRP, updateRankings } = require('./scoring');
const { generateSchedule } = require('./scheduler');
const { getAllianceCount, initBracket, getBracket, advanceBracket } = require('./bracket');

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
    db.prepare("UPDATE match_scores SET pattern_balls='000000000' WHERE match_id=?").run(timer.matchId);
    broadcastScores(timer.matchId);
  }
  if (type === 'TELEOP' && cycle > 1) {
    db.prepare("UPDATE match_scores SET teleop_pattern_balls='000000000' WHERE match_id=?").run(timer.matchId);
    broadcastScores(timer.matchId);
  }
};

app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: 'scorekeeper-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: null }, // session cookie — clears on browser close
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
app.get('/ref-red',    servePage('ref.html'));
app.get('/ref-blue',   servePage('ref-blue.html'));
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

  // Broadcast current motif so display and other clients sync immediately
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

app.get('/api/matches/:id/penalties', (req, res) => {
  const matchId = Number(req.params.id);
  const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
  res.json(penalties);
});

// Commit final scores → update rankings
app.post('/api/matches/:id/commit', (req, res) => {
  const matchId = Number(req.params.id);
  db.prepare("UPDATE match_scores SET committed=1 WHERE match_id=?").run(matchId);
  db.prepare("UPDATE matches SET state='COMPLETED' WHERE id=?").run(matchId);

  const rankings = updateRankings(db);
  io.emit('rankings_update', rankings);
  io.emit('queue_update', getQueueState());
  io.emit('match_state_change', { matchId, state: 'COMPLETED' });

  res.json({ ok: true, rankings });
});

// Override a score field (head ref)
app.post('/api/matches/:id/override', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, field, value, changedBy } = req.body;

  const allowed = ['auto_classified','auto_overflow','auto_leave','auto_leave_r1','auto_leave_r2','auto_pattern',
    'teleop_classified','teleop_overflow','teleop_balls'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'Unknown field' });

  const current = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
  db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(Number(value), matchId, alliance);
  db.prepare('INSERT INTO score_audit(match_id, alliance, field, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?)')
    .run(matchId, alliance, field, String(current ? current[field] : 0), String(value), changedBy || 'headref');

  broadcastScores(matchId);
  res.json({ ok: true });
});

// Replay: reset scores for a match
app.post('/api/matches/:id/replay', (req, res) => {
  const matchId = Number(req.params.id);
  db.prepare("UPDATE match_scores SET auto_classified=0,auto_overflow=0,auto_leave=0,auto_leave_r1=0,auto_leave_r2=0,auto_pattern=0,pattern_balls='000000000',teleop_classified=0,teleop_overflow=0,teleop_balls=0,teleop_pattern=0,teleop_pattern_balls='000000000',yellow_cards=?,red_cards=?,committed=0 WHERE match_id=?")
    .run('[]', '[]', matchId);
  db.prepare('DELETE FROM endgame_cycles WHERE match_id=?').run(matchId);
  db.prepare('DELETE FROM penalties WHERE match_id=?').run(matchId);
  db.prepare("UPDATE matches SET state='ON_FIELD' WHERE id=?").run(matchId);

  broadcastScores(matchId);
  io.emit('match_replay', { matchId });
  res.json({ ok: true });
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

// ─── Rankings API ─────────────────────────────────────────────────────────────

app.get('/api/rankings', (_req, res) => {
  res.json(updateRankings(db));
});

// ─── Queue state API ──────────────────────────────────────────────────────────

function getQueueState() {
  const onField = db.prepare("SELECT * FROM matches WHERE state='ON_FIELD' ORDER BY match_number").get();
  const queued  = db.prepare("SELECT * FROM matches WHERE state='QUEUED' ORDER BY match_number").get();
  const upcoming = db.prepare("SELECT * FROM matches WHERE state='UPCOMING' ORDER BY match_number LIMIT 3").all();

  return {
    onField: onField ? matchWithTeams(onField) : null,
    queued: queued ? matchWithTeams(queued) : null,
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
  const { alliance_number, captain_team, partner_team } = req.body;
  db.prepare(`INSERT OR REPLACE INTO alliance_selections(alliance_number, captain_team, partner_team) VALUES (?,?,?)`)
    .run(alliance_number, captain_team, partner_team || null);
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
    if (!timer.running) return;
    const period = timer.currentPeriod;
    if (!period || period.type === 'BUZZER') return;

    // Validate field belongs to current period type
    const autoFields = ['auto_classified','auto_overflow','auto_pattern'];
    const teleopFields = ['teleop_classified','teleop_overflow','teleop_balls'];
    if (period.type === 'AUTO'        && !autoFields.includes(field)) return;
    if (period.type === 'TRANSITION'  && field !== 'auto_pattern') return;
    if (period.type === 'TELEOP'      && !teleopFields.includes(field)) return;
    if (!['AUTO','TRANSITION','TELEOP','ENDGAME'].includes(period.type)) return;

    db.prepare(`UPDATE match_scores SET ${field}=${field}+1 WHERE match_id=? AND alliance=?`).run(matchId, alliance);
    broadcastScores(matchId);
  });

  // Boolean toggle fields (auto_leave_r1, auto_leave_r2)
  socket.on('score_set', ({ matchId, alliance, field, value }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.running) return;
    const period = timer.currentPeriod;
    // Allow setting auto_leave during TRANSITION so scorers can correct it after AUTO ends
    if (!period || period.type === 'BUZZER') return;

    const setFields = ['auto_leave_r1', 'auto_leave_r2'];
    if (!setFields.includes(field)) return;

    const safeVal = value ? 1 : 0;
    db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(safeVal, matchId, alliance);
    broadcastScores(matchId);
  });

  // ── Pattern ball toggle ─────────────────────────────────────────────────
  socket.on('pattern_ball', ({ matchId, alliance, ballIdx, selected }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.running) return;
    const period = timer.currentPeriod;
    if (!period) return;
    if (typeof ballIdx !== 'number' || ballIdx < 0 || ballIdx > 8) return;
    if (!['red', 'blue'].includes(alliance)) return;

    if (period.type === 'TRANSITION') {
      const row = db.prepare('SELECT pattern_balls FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
      const arr = (row?.pattern_balls || '000000000').split('');
      arr[ballIdx] = selected ? '1' : '0';
      const newBalls = arr.join('');
      const count    = arr.filter(b => b === '1').length;
      db.prepare('UPDATE match_scores SET pattern_balls=?, auto_pattern=? WHERE match_id=? AND alliance=?')
        .run(newBalls, count, matchId, alliance);
      broadcastScores(matchId);
    } else if (period.type === 'TELEOP' || period.type === 'ENDGAME' || period.type === 'BUZZER') {
      const row = db.prepare('SELECT teleop_pattern_balls FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
      const arr = (row?.teleop_pattern_balls || '000000000').split('');
      arr[ballIdx] = selected ? '1' : '0';
      const newBalls = arr.join('');
      const count    = arr.filter(b => b === '1').length;
      db.prepare('UPDATE match_scores SET teleop_pattern_balls=?, teleop_pattern=? WHERE match_id=? AND alliance=?')
        .run(newBalls, count, matchId, alliance);
      broadcastScores(matchId);
    }
  });

  socket.on('score_decrement', ({ matchId, alliance, field }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    const period = timer.currentPeriod;
    if (!period || ['TRANSITION','BUZZER'].includes(period.type)) return;

    const cur = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
    if (!cur || cur[field] <= 0) return;

    db.prepare(`UPDATE match_scores SET ${field}=${field}-1 WHERE match_id=? AND alliance=?`).run(matchId, alliance);
    broadcastScores(matchId);
  });

  // ── Park status (endgame) ───────────────────────────────────────────────

  socket.on('park_update', ({ matchId, alliance, robot, status }) => {
    if (!timer.matchId || timer.matchId !== matchId) return;
    const period = timer.currentPeriod;
    if (!period || !['ENDGAME', 'BUZZER'].includes(period.type)) return;

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

    const penalties = db.prepare('SELECT * FROM penalties WHERE match_id=? ORDER BY created_at').all(matchId);
    io.emit('penalty_added', { matchId, penalty: penalties[penalties.length - 1], all: penalties });

    broadcastScores(matchId);
  });

  // ── Card management ─────────────────────────────────────────────────────

  socket.on('add_yellow_card', ({ matchId, alliance, teamNumber }) => {
    const row = db.prepare('SELECT yellow_cards FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
    const cards = JSON.parse(row?.yellow_cards || '[]');
    if (!cards.includes(teamNumber)) cards.push(teamNumber);
    db.prepare('UPDATE match_scores SET yellow_cards=? WHERE match_id=? AND alliance=?').run(JSON.stringify(cards), matchId, alliance);
    broadcastScores(matchId);
  });

  socket.on('add_red_card', ({ matchId, alliance, teamNumber }) => {
    const row = db.prepare('SELECT red_cards FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
    const cards = JSON.parse(row?.red_cards || '[]');
    if (!cards.includes(teamNumber)) cards.push(teamNumber);
    db.prepare('UPDATE match_scores SET red_cards=? WHERE match_id=? AND alliance=?').run(JSON.stringify(cards), matchId, alliance);
    broadcastScores(matchId);
  });

  socket.on('remove_card', ({ matchId, alliance, teamNumber, cardType }) => {
    const field = cardType === 'red' ? 'red_cards' : 'yellow_cards';
    const row = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);
    const cards = JSON.parse(row?.[field] || '[]').filter(n => n !== teamNumber);
    db.prepare(`UPDATE match_scores SET ${field}=? WHERE match_id=? AND alliance=?`).run(JSON.stringify(cards), matchId, alliance);
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
});
