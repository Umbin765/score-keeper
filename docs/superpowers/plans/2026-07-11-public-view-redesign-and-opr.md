# Public View Redesign & OPR Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-page public view with a mobile-first bottom-tab SPA (Rankings / Matches / Bracket), and add OPR as a per-team metric computed after each commit and stored in the DB.

**Architecture:** OPR is calculated via Gaussian elimination (normal equations) in `scoring.js`, stored on `teams.opr`, and returned by existing `/api/rankings` and `/api/teams` endpoints. The public page is a full rewrite — one HTML file, three panels, a fixed bottom tab bar, no new routes.

**Tech Stack:** Node.js, better-sqlite3, vanilla JS — no new dependencies.

---

### Task 1: DB migration — add `opr` column to `teams`

**Files:**
- Modify: `db.js` (around line 143, after the `teleop_pattern` migration block)

- [ ] **Step 1: Add the migration try/catch in `initSchema`**

In `db.js`, after the last `try { db.prepare("ALTER TABLE match_scores ADD COLUMN teleop_pattern ...") }` block (around line 146), add:

```js
  // OPR — computed after each commit, stored per team
  try {
    db.prepare("ALTER TABLE teams ADD COLUMN opr REAL NOT NULL DEFAULT 0").run();
  } catch (_) { /* column already exists */ }
```

- [ ] **Step 2: Verify migration runs cleanly**

```bash
node -e "const { getDb } = require('./db'); const db = getDb(); console.log(db.prepare('PRAGMA table_info(teams)').all().map(c => c.name));"
```

Expected output includes `"opr"` in the array: `[ 'id', 'number', 'name', 'opr' ]`

- [ ] **Step 3: Commit**

```bash
git add db.js
git commit -m "feat: add opr column to teams table"
```

---

### Task 2: `calculateOPR(db)` in scoring.js

**Files:**
- Modify: `scoring.js` (add new function before `updateRankings`, around line 120)

OPR uses least-squares via the normal equations: `A^T A · x = A^T b`, solved with Gauss-Jordan elimination. Each committed alliance provides one equation: `OPR(t1) + OPR(t2) = alliance_total`.

- [ ] **Step 1: Add `calculateOPR` function**

Insert the following function in `scoring.js` immediately before the `updateRankings` function:

```js
/**
 * Calculate OPR (Offensive Power Rating) for all teams using
 * least-squares over committed match scores (normal equations,
 * Gauss-Jordan elimination). Returns map of { teamId: opr }.
 * Teams with insufficient data get OPR 0.
 */
function calculateOPR(db) {
  const teams = db.prepare('SELECT id FROM teams ORDER BY id').all();
  const n = teams.length;
  if (n === 0) return {};

  // Map team DB id → matrix column index
  const idxById = {};
  teams.forEach((t, i) => { idxById[t.id] = i; });

  // Collect one entry per committed alliance
  const committed = db.prepare(
    'SELECT DISTINCT match_id FROM match_scores WHERE committed = 1'
  ).all();

  const alliances = [];
  for (const { match_id } of committed) {
    const match = db.prepare('SELECT * FROM matches WHERE id=?').get(match_id);
    if (!match) continue;
    for (const al of ['red', 'blue']) {
      const t1 = al === 'red' ? match.red1 : match.blue1;
      const t2 = al === 'red' ? match.red2 : match.blue2;
      if (!t1 || !t2) continue;
      const score = calculateScore(db, match_id, al);
      alliances.push({ t1, t2, score });
    }
  }

  if (alliances.length === 0) return {};

  // Build A^T A (n×n) and A^T b (n×1)
  const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
  const ATb = new Array(n).fill(0);

  for (const { t1, t2, score } of alliances) {
    const i = idxById[t1];
    const j = idxById[t2];
    if (i === undefined || j === undefined) continue;
    // A row has 1s at columns i and j; A^T A += outer product of that row
    ATA[i][i] += 1; ATA[i][j] += 1;
    ATA[j][i] += 1; ATA[j][j] += 1;
    ATb[i] += score;
    ATb[j] += score;
  }

  // Augmented matrix [ATA | ATb], solve via Gauss-Jordan with partial pivoting
  const aug = ATA.map((row, i) => [...row, ATb[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: find row with largest absolute value in this column
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivotRow][col])) pivotRow = row;
    }
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-9) continue; // singular row — skip

    // Normalize pivot row so diagonal becomes 1
    const scale = 1 / pivot;
    for (let k = col; k <= n; k++) aug[col][k] *= scale;

    // Eliminate this column from all other rows
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let k = col; k <= n; k++) aug[row][k] -= factor * aug[col][k];
    }
  }

  // After Gauss-Jordan, aug[i][n] is the solution for team i
  const result = {};
  teams.forEach((t, i) => {
    const val = Math.abs(aug[i][i]) < 1e-9 ? 0 : aug[i][n];
    result[t.id] = Math.round(val * 10) / 10;
  });

  return result;
}
```

- [ ] **Step 2: Add `calculateOPR` to `module.exports`**

In `scoring.js`, update the `module.exports` block to include `calculateOPR`:

```js
module.exports = {
  calculateScore,
  calculateParkScore,
  calculateArtifactsSorted,
  calculateBallsScored,
  calculateRP,
  computeLiveRP,
  calculateOPR,
  updateRankings,
};
```

- [ ] **Step 3: Smoke-test the function**

```bash
node -e "
const { getDb } = require('./db');
const { calculateOPR } = require('./scoring');
const db = getDb();
console.log(calculateOPR(db));
"
```

Expected: `{}` if no committed matches, or an object like `{ '1': 42.3, '2': 38.1, ... }` if matches exist.

- [ ] **Step 4: Commit**

```bash
git add scoring.js
git commit -m "feat: add calculateOPR using Gauss-Jordan least-squares"
```

---

### Task 3: Wire OPR into `updateRankings`

**Files:**
- Modify: `scoring.js` — `updateRankings` function (around line 122)

- [ ] **Step 1: Call `calculateOPR` inside `updateRankings` and write to DB**

In `updateRankings`, add OPR computation **after** the `rankings` array is fully populated (after the `for (const team of teams)` loop), and **before** the sort. Replace the sort+return block:

```js
  // Calculate OPR for all teams and persist to DB
  const oprMap = calculateOPR(db);
  const updateOpr = db.prepare('UPDATE teams SET opr=? WHERE id=?');
  for (const [teamId, oprVal] of Object.entries(oprMap)) {
    updateOpr.run(oprVal, Number(teamId));
  }

  // Attach opr to each ranking entry
  rankings.forEach(r => {
    r.opr = oprMap[r.teamId] ?? 0;
  });

  rankings.sort((a, b) => {
    if (b.rp !== a.rp) return b.rp - a.rp;
    if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
    return b.highScore - a.highScore;
  });

  rankings.forEach((r, i) => { r.rank = i + 1; });
  return rankings;
```

The full end of `updateRankings` (replace from the `rankings.sort` line to the closing `}`) should look exactly like the above.

- [ ] **Step 2: Verify `updateRankings` returns `opr` field**

```bash
node -e "
const { getDb } = require('./db');
const { updateRankings } = require('./scoring');
const db = getDb();
const r = updateRankings(db);
console.log(r.length > 0 ? r[0] : 'no teams');
"
```

Expected: each entry has an `opr` field (0 if no committed matches).

- [ ] **Step 3: Commit**

```bash
git add scoring.js
git commit -m "feat: compute and persist OPR in updateRankings"
```

---

### Task 4: Admin teams table — add OPR column

**Files:**
- Modify: `public/admin.html`

Two changes: (1) add 'OPR' to the table header, (2) add an OPR cell in `renderTeamsTable`.

- [ ] **Step 1: Update table header**

In `admin.html`, find this line (around line 224):
```js
      ['#', 'Name', 'Delete'].forEach(function (h) {
```

Replace with:
```js
      ['#', 'Name', 'OPR', 'Delete'].forEach(function (h) {
```

- [ ] **Step 2: Add OPR cell in `renderTeamsTable`**

In `admin.html`, find `renderTeamsTable` (around line 238). The row-building section currently is:

```js
        var numTd = document.createElement('td');
        numTd.textContent = team.number || team.team_number;
        var nameTd = document.createElement('td');
        nameTd.textContent = team.name;
        var delTd = document.createElement('td');
```

Replace with:

```js
        var numTd = document.createElement('td');
        numTd.textContent = team.number || team.team_number;
        var nameTd = document.createElement('td');
        nameTd.textContent = team.name;
        var oprTd = document.createElement('td');
        oprTd.textContent = team.opr != null ? Number(team.opr).toFixed(1) : '—';
        oprTd.style.color = 'var(--text2)';
        var delTd = document.createElement('td');
```

- [ ] **Step 3: Insert `oprTd` into the row**

Find the row.appendChild sequence just below (currently):
```js
        row.appendChild(numTd);
        row.appendChild(nameTd);
        row.appendChild(delTd);
```

Replace with:
```js
        row.appendChild(numTd);
        row.appendChild(nameTd);
        row.appendChild(oprTd);
        row.appendChild(delTd);
```

- [ ] **Step 4: Verify in browser**

Start the server: `npm start`

Open `http://localhost:3000/admin` → Teams tab. The table should show columns: `# | Name | OPR | Delete`. OPR will show `0.0` for all teams until matches are committed.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html
git commit -m "feat: show OPR column in admin teams table"
```

---

### Task 5: Public view rewrite — bottom-tab SPA

**Files:**
- Overwrite: `public/public.html`

Full rewrite. Three panels (Rankings, Matches, Bracket) with a fixed bottom tab bar. Bracket tab is hidden until bracket data exists.

- [ ] **Step 1: Replace `public/public.html` with the new file**

Write the following as the complete content of `public/public.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Score Keeper</title>
  <link rel="stylesheet" href="/css/style.css">
  <style>
    html, body { height: 100%; }
    body { padding-bottom: 56px; }

    /* ── Panels ── */
    .panel { display: none; padding: 1rem; }
    .panel.active { display: block; }

    /* ── Bottom tab bar ── */
    .bottom-tab-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      display: flex;
      background: var(--bg2);
      border-top: 1px solid var(--border);
      z-index: 100;
      height: 56px;
    }
    .bottom-tab-bar .tab-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--text2);
      background: transparent;
      border: none;
      border-top: 2px solid transparent;
      border-radius: 0;
      cursor: pointer;
      padding: 0.5rem;
      text-transform: uppercase;
    }
    .bottom-tab-bar .tab-btn.active {
      color: var(--blue-light);
      border-top-color: var(--blue-light);
    }
    .bottom-tab-bar .tab-btn:hover:not(.active) { color: var(--text); }

    /* ── Rankings ── */
    .rank-num { color: var(--yellow); font-weight: 700; }

    /* ── On Deck ── */
    .section-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text2);
      margin-bottom: 0.5rem;
    }
    .on-deck-card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .on-deck-match-num {
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--text2);
      min-width: 5ch;
    }
    .on-deck-chips { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
    .team-chip {
      font-size: 0.9rem;
      font-weight: 700;
      padding: 0.2rem 0.6rem;
      border-radius: 5px;
    }
    .team-chip.red  { color: var(--red-light);  background: var(--red-bg); }
    .team-chip.blue { color: var(--blue-light); background: var(--blue-bg); }
    .vs-sep { font-size: 0.75rem; color: var(--border); }
    .schedule-wrap { margin-top: 1.25rem; overflow-x: auto; }

    /* ── State chips ── */
    .match-state-chip {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.1rem 0.45rem;
      border-radius: 4px;
      background: var(--bg3);
      color: var(--text2);
    }
    .match-state-chip.complete { background: #002a00; color: var(--green); }
    .match-state-chip.live     { background: var(--blue-bg); color: var(--blue-light); }

    /* ── Bracket ── */
    .bracket-round-wrap {
      display: flex;
      gap: 0.75rem;
      overflow-x: auto;
      padding-bottom: 0.5rem;
    }
    .bracket-col { min-width: 160px; flex-shrink: 0; }
    .bracket-col h3 {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text2);
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    .bracket-card {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.5rem 0.6rem;
      margin-bottom: 0.5rem;
      font-size: 0.85rem;
    }
    .bracket-card .bc-red  { color: var(--red-light);  font-weight: 700; }
    .bracket-card .bc-blue { color: var(--blue-light); font-weight: 700; }
    .bracket-card .bc-win  { color: var(--green); font-size: 0.7rem; margin-top: 0.2rem; }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      color: var(--text2);
      padding: 2rem 0;
      font-size: 0.95rem;
    }
  </style>
</head>
<body>

  <!-- Rankings panel (default) -->
  <div id="panel-rankings" class="panel active">
    <div style="overflow-x:auto;">
      <table class="data-table">
        <thead>
          <tr>
            <th>Rank</th><th>Team #</th><th>Name</th>
            <th>RP</th><th>OPR</th><th>Avg</th>
            <th>W</th><th>L</th><th>T</th>
          </tr>
        </thead>
        <tbody id="rankings-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Matches panel -->
  <div id="panel-matches" class="panel">
    <div class="section-label">On Deck</div>
    <div id="on-deck-content"></div>
    <div class="schedule-wrap">
      <div class="section-label">Full Schedule</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Match</th><th>Red</th><th>Blue</th><th>Result</th>
          </tr>
        </thead>
        <tbody id="schedule-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Bracket panel -->
  <div id="panel-bracket" class="panel">
    <div class="bracket-round-wrap" id="bracket-content"></div>
  </div>

  <!-- Bottom tab bar -->
  <nav class="bottom-tab-bar">
    <button class="tab-btn active" data-panel="panel-rankings">Rankings</button>
    <button class="tab-btn"        data-panel="panel-matches">Matches</button>
    <button class="tab-btn hidden" data-panel="panel-bracket" id="tab-bracket">Bracket</button>
  </nav>

  <script src="/socket.io/socket.io.js"></script>
  <script src="/js/common.js"></script>
  <script>
  (function () {
    'use strict';

    // ── Tab switching ──────────────────────────────────────────────────────────
    var allTabBtns = document.querySelectorAll('.bottom-tab-bar .tab-btn');
    allTabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        allTabBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        document.getElementById(btn.dataset.panel).classList.add('active');
      });
    });

    var tabBracketBtn = document.getElementById('tab-bracket');

    // ── Helpers ────────────────────────────────────────────────────────────────
    function teamChip(num, color) {
      var el = document.createElement('span');
      el.className = 'team-chip ' + color;
      el.textContent = num || '?';
      return el;
    }

    function adaptMatch(m) {
      return {
        matchNumber: m.match_number,
        state: m.state,
        winner: m.winner || null,
        red:  [m.red1_team  && m.red1_team.number,  m.red2_team  && m.red2_team.number ].filter(Boolean),
        blue: [m.blue1_team && m.blue1_team.number, m.blue2_team && m.blue2_team.number].filter(Boolean),
      };
    }

    // ── Rankings ───────────────────────────────────────────────────────────────
    var rankingsBody = document.getElementById('rankings-body');

    function renderRankings(rankings) {
      while (rankingsBody.firstChild) rankingsBody.removeChild(rankingsBody.firstChild);
      if (!rankings || rankings.length === 0) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = 9; td.className = 'empty-state';
        td.textContent = 'No rankings yet';
        tr.appendChild(td); rankingsBody.appendChild(tr);
        return;
      }
      rankings.forEach(function (r, i) {
        var tr = document.createElement('tr');
        function cell(val, cls) {
          var td = document.createElement('td');
          if (cls) td.className = cls;
          td.textContent = val != null ? val : '—';
          return td;
        }
        tr.appendChild(cell(i + 1, 'rank-num'));
        tr.appendChild(cell(r.teamNumber || r.team));
        tr.appendChild(cell(r.teamName || r.name || ''));
        tr.appendChild(cell(r.rp != null ? r.rp : '—'));
        tr.appendChild(cell(r.opr != null ? Number(r.opr).toFixed(1) : '—'));
        tr.appendChild(cell(r.avgScore != null ? Number(r.avgScore).toFixed(1) : '—'));
        tr.appendChild(cell(r.wins != null ? r.wins : '—'));
        tr.appendChild(cell(r.losses != null ? r.losses : '—'));
        tr.appendChild(cell(r.ties != null ? r.ties : '—'));
        rankingsBody.appendChild(tr);
      });
    }

    // ── Matches ────────────────────────────────────────────────────────────────
    var onDeckContent = document.getElementById('on-deck-content');
    var scheduleBody  = document.getElementById('schedule-body');

    function renderOnDeck(matches) {
      while (onDeckContent.firstChild) onDeckContent.removeChild(onDeckContent.firstChild);
      var upcoming = (matches || []).filter(function (m) {
        return m.state === 'UPCOMING' || m.state === 'QUEUED';
      }).slice(0, 3);
      if (upcoming.length === 0) {
        var el = document.createElement('div');
        el.className = 'empty-state';
        el.textContent = 'No upcoming matches';
        onDeckContent.appendChild(el);
        return;
      }
      upcoming.forEach(function (m) {
        var card = document.createElement('div');
        card.className = 'on-deck-card';
        var num = document.createElement('div');
        num.className = 'on-deck-match-num';
        num.textContent = 'M' + (m.matchNumber || '?');
        var chips = document.createElement('div');
        chips.className = 'on-deck-chips';
        (m.red || []).forEach(function (t) { chips.appendChild(teamChip(t, 'red')); });
        var vs = document.createElement('span');
        vs.className = 'vs-sep'; vs.textContent = 'vs';
        chips.appendChild(vs);
        (m.blue || []).forEach(function (t) { chips.appendChild(teamChip(t, 'blue')); });
        card.appendChild(num);
        card.appendChild(chips);
        onDeckContent.appendChild(card);
      });
    }

    function stateChip(state, winner) {
      var chip = document.createElement('span');
      if (state === 'COMPLETED') {
        chip.className = 'match-state-chip complete';
        chip.textContent = winner ? winner.toUpperCase() + ' WINS' : 'Complete';
      } else if (state === 'ON_FIELD' || state === 'QUEUED') {
        chip.className = 'match-state-chip live';
        chip.textContent = 'Live';
      } else {
        chip.className = 'match-state-chip';
        chip.textContent = '—';
      }
      return chip;
    }

    function renderSchedule(matches) {
      while (scheduleBody.firstChild) scheduleBody.removeChild(scheduleBody.firstChild);
      if (!matches || matches.length === 0) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = 4; td.className = 'empty-state';
        td.textContent = 'No matches scheduled';
        tr.appendChild(td); scheduleBody.appendChild(tr);
        return;
      }
      matches.forEach(function (m) {
        var tr = document.createElement('tr');
        var numTd = document.createElement('td');
        numTd.textContent = 'M' + (m.matchNumber || '?');
        var redTd = document.createElement('td');
        (m.red || []).forEach(function (t) {
          var c = teamChip(t, 'red'); c.style.marginRight = '4px'; redTd.appendChild(c);
        });
        var blueTd = document.createElement('td');
        (m.blue || []).forEach(function (t) {
          var c = teamChip(t, 'blue'); c.style.marginRight = '4px'; blueTd.appendChild(c);
        });
        var resTd = document.createElement('td');
        resTd.appendChild(stateChip(m.state, m.winner));
        tr.appendChild(numTd); tr.appendChild(redTd);
        tr.appendChild(blueTd); tr.appendChild(resTd);
        scheduleBody.appendChild(tr);
      });
    }

    function renderMatches(matches) {
      var adapted = (matches || []).map(adaptMatch);
      renderOnDeck(adapted);
      renderSchedule(adapted);
    }

    // ── Bracket ────────────────────────────────────────────────────────────────
    var bracketContent = document.getElementById('bracket-content');

    function renderBracket(data) {
      while (bracketContent.firstChild) bracketContent.removeChild(bracketContent.firstChild);
      if (!data || !data.matches || data.matches.length === 0) {
        tabBracketBtn.classList.add('hidden');
        return;
      }
      tabBracketBtn.classList.remove('hidden');

      var byRound = {};
      data.matches.forEach(function (m) {
        var r = m.bracketRound || m.bracket_round || 'Round 1';
        if (!byRound[r]) byRound[r] = [];
        byRound[r].push(m);
      });

      Object.keys(byRound).forEach(function (round) {
        var col = document.createElement('div');
        col.className = 'bracket-col';
        var h3 = document.createElement('h3');
        h3.textContent = round;
        col.appendChild(h3);
        byRound[round].forEach(function (m) {
          var card = document.createElement('div');
          card.className = 'bracket-card';
          var redEl = document.createElement('div');
          redEl.className = 'bc-red';
          redEl.textContent = 'Red: ' + (m.redAlliance || m.red || '?');
          var blueEl = document.createElement('div');
          blueEl.className = 'bc-blue';
          blueEl.textContent = 'Blue: ' + (m.blueAlliance || m.blue || '?');
          card.appendChild(redEl);
          card.appendChild(blueEl);
          if (m.winner) {
            var winEl = document.createElement('div');
            winEl.className = 'bc-win';
            winEl.textContent = 'Winner: ' + m.winner;
            card.appendChild(winEl);
          }
          col.appendChild(card);
        });
        bracketContent.appendChild(col);
      });
    }

    // ── Fetch ──────────────────────────────────────────────────────────────────
    function fetchAll() {
      fetch('/api/rankings')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(renderRankings)
        .catch(function () {});

      fetch('/api/matches')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(renderMatches)
        .catch(function () {});

      fetch('/api/bracket')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(renderBracket)
        .catch(function () { tabBracketBtn.classList.add('hidden'); });
    }

    // ── Socket ─────────────────────────────────────────────────────────────────
    var socket = SK.connectSocket();
    if (socket) {
      socket.on('rankings_update', function (data) {
        if (data) renderRankings(data);
        else fetch('/api/rankings').then(function (r) { return r.ok ? r.json() : []; }).then(renderRankings).catch(function () {});
      });

      socket.on('queue_update', function () {
        fetch('/api/matches').then(function (r) { return r.ok ? r.json() : []; }).then(renderMatches).catch(function () {});
      });

      socket.on('match_state_change', function () {
        fetch('/api/matches').then(function (r) { return r.ok ? r.json() : []; }).then(renderMatches).catch(function () {});
      });

      socket.on('bracket_update', function (data) {
        renderBracket(data);
      });
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    fetchAll();
  })();
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify in browser — Rankings tab**

```bash
npm start
```

Open `http://localhost:3000/public` on a phone or browser. Rankings tab should be active by default showing the table with columns: Rank, Team #, Name, RP, OPR, Avg, W, L, T.

- [ ] **Step 3: Verify in browser — Matches tab**

Click the Matches tab. "On Deck" section shows up to 3 upcoming matches as cards. "Full Schedule" section shows all matches in a table. Verify no horizontal scroll needed on a 375px wide viewport.

- [ ] **Step 4: Verify in browser — Bracket tab**

Bracket tab should be hidden if no bracket exists. If a bracket has been generated in admin, the Bracket tab should appear and show the rounds.

- [ ] **Step 5: Verify bottom tab bar on mobile viewport**

In browser DevTools, set viewport to 375×667. Confirm:
- Bottom tab bar is fully visible and not covered by browser chrome
- All tab labels are readable
- Tapping between tabs switches panels with no page reload

- [ ] **Step 6: Commit**

```bash
git add public/public.html
git commit -m "feat: rewrite public view as bottom-tab SPA with OPR column"
```

---

## Self-Review

**Spec coverage:**
- ✅ Bottom tab bar with Rankings / Matches / Bracket — Task 5
- ✅ Rankings tab default active — Task 5 (`panel active` on panel-rankings)
- ✅ OPR column in rankings table — Tasks 2, 3, 5
- ✅ On Deck (3 upcoming) + Full Schedule in Matches tab — Task 5
- ✅ Bracket tab conditional on bracket data — Task 5 (`tabBracketBtn.classList.add/remove('hidden')`)
- ✅ `bracket_update` socket shows/hides Bracket tab — Task 5
- ✅ OPR stored to DB via `teams.opr` — Tasks 1, 3
- ✅ OPR in admin teams table — Task 4
- ✅ Live updates via socket (rankings_update, queue_update, match_state_change, bracket_update) — Task 5

**Placeholder scan:** None found.

**Type consistency:** `calculateOPR` returns `{ [teamId: number]: number }`. `updateRankings` reads it with `oprMap[r.teamId]` — `teamId` is set as `team.id` (integer) in the loop, and `calculateOPR` keys on `t.id` (integer) converted to string by `Object.entries`. Fixed: use `oprMap[r.teamId] ?? 0` which handles both number and string key lookup correctly since JS object keys are always strings. This is correct — `r.teamId` is a number, `Object.entries(oprMap)` keys are strings, but `oprMap[r.teamId]` coerces the number to a string key automatically. No bug.
