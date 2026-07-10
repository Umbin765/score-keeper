# Post-Match Review, Winner Animation & Results Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a review phase after match end (display frozen, refs/scorers stay live), then on "Show Scores" play a pyramid winner animation and show a broadcast-style Match Results screen on `/display`; also add a Match History score editor to `/control`.

**Architecture:** In-memory `scoresRevealed` flag on `MatchTimer` gates a REVIEWING → REVEALED transition. A new `/api/matches/:id/reveal` endpoint emits `scores_reveal` with a complete results payload (scores, category breakdowns, RPs, provisional rank movement). `display.html` gains two full-screen overlays (winner animation, results screen). Server socket guards are relaxed during review so scorers/refs can keep editing. Control gains a "Show Scores" button and a Match History drawer using the extended `/override` endpoint.

**Tech Stack:** Node.js, Express, Socket.io, better-sqlite3, vanilla JS, inline SVG, self-hosted `qrcode-generator`.

**Specs:** `docs/superpowers/specs/2026-07-10-post-match-review-and-score-editing-design.md`, `docs/superpowers/specs/2026-07-10-winner-animation-and-results-screen-design.md`

**DOM safety rule:** never assign `innerHTML` from data. Build nodes with `createElement`/`textContent`, clear containers with the repo's `while (el.firstChild) el.removeChild(el.firstChild)` pattern, reference static SVG via `<symbol>`/`<use>`, and render the QR as a data-URL `<img>`.

**Testing note:** This project has no test framework (verified: `package.json` has only `"start"`). Per repo convention and user's global CLAUDE.md, verification is done by running the server and hitting endpoints with `curl` plus Playwright browser checks. Every task ends with a concrete verification step.

**Useful during verification** — to end a loaded match quickly (17 periods):
```bash
for i in $(seq 1 18); do curl -s -X POST localhost:3000/api/timer/advance > /dev/null; done
curl -s localhost:3000/api/timer   # → "matchEnded":true
```
(Start the timer first: a match must be loaded via control page or `POST /api/matches/:id/load`, then `POST /api/timer/start`.)

---

### Task 1: `scoresRevealed` flag on MatchTimer

**Files:**
- Modify: `timer.js:16-29` (`reset()`), `timer.js:46-58` (`getState()`), `timer.js:151-158` (`_endMatch()`)

- [ ] **Step 1: Add flag to `reset()`**

In `timer.js`, `reset()` — after `this.matchEnded = false;` (line 28) add:

```javascript
    this.scoresRevealed = false;
```

(`load()` calls `reset()` first, so it inherits the flag; no change needed there.)

- [ ] **Step 2: Add flag to `getState()`**

In `getState()`, after `matchEnded: this.matchEnded,` add:

```javascript
      scoresRevealed: this.scoresRevealed,
```

- [ ] **Step 3: Reset flag in `_endMatch()`**

In `_endMatch()`, after `this.matchEnded = true;` add:

```javascript
    this.scoresRevealed = false;
```

- [ ] **Step 4: Verify**

```bash
node -e "const {MatchTimer}=require('./timer'); const t=new MatchTimer({emit(){}}); console.log(t.getState().scoresRevealed)"
```
Expected: `false`

- [ ] **Step 5: Commit**

```bash
git add timer.js
git commit -m "feat: add scoresRevealed flag to match timer state"
```

---

### Task 2: Provisional rankings — `updateRankings(db, includeMatchId)`

**Files:**
- Modify: `scoring.js:120-133`

- [ ] **Step 1: Add optional `includeMatchId` parameter**

In `scoring.js`, change the `updateRankings` signature (line 120) and the `teamMatches` query (lines 126-133) from:

```javascript
function updateRankings(db) {
```
```javascript
    const teamMatches = db.prepare(`
      SELECT m.*
      FROM matches m
      JOIN match_scores ms ON ms.match_id = m.id AND ms.alliance IN ('red','blue') AND ms.committed = 1
      WHERE (m.red1 = ? OR m.red2 = ? OR m.blue1 = ? OR m.blue2 = ?)
        AND m.state = 'COMPLETED'
      GROUP BY m.id
    `).all(team.id, team.id, team.id, team.id);
```

to:

```javascript
function updateRankings(db, includeMatchId = null) {
```
```javascript
    const teamMatches = db.prepare(`
      SELECT m.*
      FROM matches m
      WHERE (m.red1 = ? OR m.red2 = ? OR m.blue1 = ? OR m.blue2 = ?)
        AND (
          (m.state = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM match_scores ms WHERE ms.match_id = m.id AND ms.committed = 1
          ))
          OR m.id = ?
        )
    `).all(team.id, team.id, team.id, team.id, includeMatchId ?? -1);
```

No other change — the per-match RP/score math below already works on uncommitted rows.

- [ ] **Step 2: Verify no regression**

```bash
npm start &   # or restart the running server
sleep 1 && curl -s localhost:3000/api/rankings | head -c 300
```
Expected: same rankings JSON as before (committed matches only; the `-1` sentinel matches nothing).

- [ ] **Step 3: Commit**

```bash
git add scoring.js
git commit -m "feat: updateRankings can include one uncommitted match for provisional ranks"
```

---

### Task 3: Reveal + results endpoints with full payload

**Files:**
- Modify: `server.js` — add `buildResultsPayload()` near `broadcastScores` (line 546), add two routes after the `/replay` route (line 371)

- [ ] **Step 1: Add `buildResultsPayload(matchId)`**

In `server.js`, directly above `function broadcastScores(matchId)` (line 546), add:

```javascript
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
      balls:    p.teleop_balls || 0,
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
```

- [ ] **Step 2: Add the two routes**

After the `/api/matches/:id/replay` route (line 371), add:

```javascript
// Reveal scores → winner animation + results screen on /display
app.post('/api/matches/:id/reveal', (req, res) => {
  const matchId = Number(req.params.id);
  if (timer.matchId !== matchId) return res.status(409).json({ error: 'Match not loaded' });
  if (!timer.matchEnded) return res.status(409).json({ error: 'Match not ended yet' });

  timer.scoresRevealed = true;
  const results = buildResultsPayload(matchId);
  io.emit('scores_reveal', results);
  res.json({ ok: true });
});

// Results payload (page-refresh recovery for /display)
app.get('/api/matches/:id/results', (req, res) => {
  const results = buildResultsPayload(Number(req.params.id));
  if (!results) return res.status(404).json({ error: 'Match not found' });
  res.json(results);
});
```

- [ ] **Step 3: Verify guards and payload**

```bash
# restart server, then with NO match loaded:
curl -s -X POST localhost:3000/api/matches/1/reveal          # → 409 "Match not loaded"
curl -s localhost:3000/api/matches/1/results | head -c 400   # → payload JSON (or 404 if match 1 absent)
```
Then load a match from `/control`, start it, fast-forward with the advance loop (see header), and:
```bash
curl -s -X POST localhost:3000/api/matches/<id>/reveal        # → {"ok":true}
curl -s localhost:3000/api/timer | grep scoresRevealed        # → true
```
Check the `/results` payload contains `winner`, `teams.red[0].rank`, and all 6 breakdown keys.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: reveal endpoint with full results payload and provisional rank movement"
```

---

### Task 4: `/override` — card fields + rankings recalc for committed matches

**Files:**
- Modify: `server.js:342-357` (`/api/matches/:id/override`)

- [ ] **Step 1: Rewrite the override handler**

Replace the whole route (lines 342-357) with:

```javascript
// Override a score field (head ref / match history editor)
app.post('/api/matches/:id/override', (req, res) => {
  const matchId = Number(req.params.id);
  const { alliance, field, value, changedBy } = req.body;

  const numericFields = ['auto_classified','auto_overflow','auto_leave','auto_leave_r1','auto_leave_r2','auto_pattern',
    'teleop_classified','teleop_overflow','teleop_balls','teleop_pattern'];
  const cardFields = ['yellow_cards','red_cards'];
  if (!numericFields.includes(field) && !cardFields.includes(field)) {
    return res.status(400).json({ error: 'Unknown field' });
  }

  const current = db.prepare(`SELECT ${field} FROM match_scores WHERE match_id=? AND alliance=?`).get(matchId, alliance);

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
  const committed = db.prepare('SELECT committed FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (committed && committed.committed === 1) {
    io.emit('rankings_update', updateRankings(db));
  }

  res.json({ ok: true });
});
```

Note: `field` is still whitelist-checked before being interpolated into SQL — no injection surface. `teleop_pattern` is added to the numeric whitelist — it's a real column (`db.js:145`) scored via the teleop pattern grid but previously not overridable.

- [ ] **Step 2: Verify**

```bash
curl -s -X POST localhost:3000/api/matches/1/override -H 'Content-Type: application/json' \
  -d '{"alliance":"red","field":"yellow_cards","value":[1234],"changedBy":"test"}'   # → {"ok":true}
curl -s -X POST localhost:3000/api/matches/1/override -H 'Content-Type: application/json' \
  -d '{"alliance":"red","field":"yellow_cards","value":"bad"}'                        # → 400
curl -s localhost:3000/api/matches/1/scores | grep -o '"yellow_cards":\[[^]]*\]' | head -1
# revert:
curl -s -X POST localhost:3000/api/matches/1/override -H 'Content-Type: application/json' \
  -d '{"alliance":"red","field":"yellow_cards","value":[],"changedBy":"test"}'
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: override endpoint supports cards and re-runs rankings for committed matches"
```

---

### Task 5: Relax socket guards during review phase

During review (`timer.matchEnded === true`, match still loaded) scorers/refs must be able to keep editing. Penalties and cards already work (no running-guard). Score events don't.

**Files:**
- Modify: `server.js:577-668` (socket handlers `score_increment`, `score_set`, `pattern_ball`, `score_decrement`, `park_update`)

- [ ] **Step 1: `score_increment`** — replace the guard block (lines 578-589) with:

```javascript
    if (!timer.matchId || timer.matchId !== matchId) return;

    const autoFields = ['auto_classified','auto_overflow','auto_pattern'];
    const teleopFields = ['teleop_classified','teleop_overflow','teleop_balls'];

    if (timer.matchEnded) {
      // Review phase: any score field may be corrected
      if (![...autoFields, ...teleopFields].includes(field)) return;
    } else {
      if (!timer.running) return;
      const period = timer.currentPeriod;
      if (!period || period.type === 'BUZZER') return;
      if (period.type === 'AUTO'        && !autoFields.includes(field)) return;
      if (period.type === 'TRANSITION'  && field !== 'auto_pattern') return;
      if (period.type === 'TELEOP'      && !teleopFields.includes(field)) return;
      if (!['AUTO','TRANSITION','TELEOP','ENDGAME'].includes(period.type)) return;
    }
```

- [ ] **Step 2: `score_set`** — replace the guard block (lines 597-601) with:

```javascript
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.matchEnded) {
      if (!timer.running) return;
      const period = timer.currentPeriod;
      // Allow setting auto_leave during TRANSITION so scorers can correct it after AUTO ends
      if (!period || period.type === 'BUZZER') return;
    }
```

- [ ] **Step 3: `pattern_ball`** — keep the `matchId`/`ballIdx`/`alliance` checks, change `if (!timer.running) return;` to `if (!timer.running && !timer.matchEnded) return;`, and replace the period-type branching with a grid selector:

```javascript
    const period = timer.currentPeriod;
    const grid = timer.matchEnded
      ? 'teleop'                                          // review-phase edits target the teleop grid
      : period && period.type === 'TRANSITION' ? 'auto'
      : period && ['TELEOP','ENDGAME','BUZZER'].includes(period.type) ? 'teleop'
      : null;
    if (!grid) return;

    if (grid === 'auto') {
      // ...existing pattern_balls / auto_pattern update block unchanged...
    } else {
      // ...existing teleop_pattern_balls / teleop_pattern update block unchanged...
    }
```

- [ ] **Step 4: `score_decrement`** — replace the guard (lines 642-644) with:

```javascript
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.matchEnded) {
      const period = timer.currentPeriod;
      if (!period || ['TRANSITION','BUZZER'].includes(period.type)) return;
    }
```

- [ ] **Step 5: `park_update`** — replace the guard (lines 656-658) with:

```javascript
    if (!timer.matchId || timer.matchId !== matchId) return;
    if (!timer.matchEnded) {
      const period = timer.currentPeriod;
      if (!period || !['ENDGAME', 'BUZZER'].includes(period.type)) return;
    }
```

(`timer.endgameCycle` retains its final value after match end, so the existing `const cycle = timer.endgameCycle || 1;` line targets the last endgame cycle — correct for review corrections.)

- [ ] **Step 6: Verify**

Load + start a match, fast-forward to end (see header). Then from a browser console on `/red` (or via a socket.io client):
```javascript
SK.connectSocket().emit('score_increment', { matchId: <id>, alliance: 'red', field: 'teleop_balls' });
```
Then `curl -s localhost:3000/api/matches/<id>/scores | grep -o '"teleop_balls":[0-9]*' | head -1` shows the incremented value. Also verify a normal running match still rejects out-of-period fields (increment `teleop_balls` during AUTO → no change).

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: allow score corrections during post-match review phase"
```

---

### Task 6: Vendor QR library

**Files:**
- Create: `public/js/qrcode.js` (self-hosted copy of `qrcode-generator`)

- [ ] **Step 1: Download the library**

```bash
curl -sL -o public/js/qrcode.js https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
head -5 public/js/qrcode.js   # sanity: shows the qrcode-generator source banner
```
(One-time build step; at runtime everything stays offline. `public/js/` is already served statically — same pattern as `xlsx.full.min.js`.)

- [ ] **Step 2: Verify it loads**

```bash
node -e "global.window={}; require('./public/js/qrcode.js'); const f=global.qrcode||global.window.qrcode; const qr=f(0,'M'); qr.addData('test'); qr.make(); console.log('ok', qr.getModuleCount())"
```
Expected: `ok <number>`. (If the UMD wrapper doesn't attach in node, verifying in the browser during Task 9 is sufficient — the file just needs to define a global `qrcode` function in a browser.)

- [ ] **Step 3: Commit**

```bash
git add public/js/qrcode.js
git commit -m "chore: vendor qrcode-generator for offline QR rendering"
```

---

### Task 7: Display review mode (`display.html`)

**Files:**
- Modify: `public/display.html` — CSS (~line 68), state flags (~line 414), `goComplete` area (lines 577-596), socket handlers (lines 637-653), `fetchTimerState` (lines 655-666)

- [ ] **Step 1: Add review banner CSS**

After the `.post-sub` rule (line 68) add:

```css
    #post-banner.post-banner--review { border-color: #555; background: rgba(20,20,20,0.95); }
    #post-banner.post-banner--review .post-title { color: #bbb; }
```

- [ ] **Step 2: Add flags and `goReview()`**

Below `var matchActive = false;` (line 414) add:

```javascript
  var reviewing = false;
```

After `goActive()` (line 575) add:

```javascript
  function goReview() {
    matchActive = false;
    reviewing = true;
    periodEl.textContent = 'Review';
    timerEl.textContent = '—';
    timerEl.className = '';
    postBanner.classList.add('post-banner--review');
    postBanner.querySelector('.post-title').textContent = 'Under Review';
    postSub.textContent = 'Scores being finalized';
    postBanner.classList.add('visible');
  }
```

And in `goComplete()` (line 577) add as the first three lines of the body:

```javascript
    reviewing = false;
    postBanner.classList.remove('post-banner--review');
    postBanner.querySelector('.post-title').textContent = 'Match Complete';
```

Also add the same three lines at the top of both `goWaiting()` and `goActive()`.

- [ ] **Step 3: Rewire socket handlers**

Change (lines 637-638):

```javascript
    socket.on('match_end',     function ()      { goComplete(); });
    socket.on('score_update',  function (data)  { applyScore(data); });
```

to:

```javascript
    socket.on('match_end',     function ()      { goReview(); });
    socket.on('score_update',  function (data)  { if (reviewing) return; applyScore(data); });
    socket.on('scores_reveal', function (data)  { reviewing = false; goComplete(); });
```

(`scores_reveal` gets replaced with the animation flow in Task 8 — this intermediate step keeps the page working.)

- [ ] **Step 4: Refresh recovery**

In `fetchTimerState()` change `if (state.matchEnded) { goComplete(); return; }` (line 658) to:

```javascript
      if (state.matchEnded && !state.scoresRevealed) {
        fetch('/api/matches/' + state.matchId + '/scores')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d) applyScore(Object.assign({ matchId: state.matchId }, d)); goReview(); })
          .catch(function () { goReview(); });
        return;
      }
      if (state.matchEnded && state.scoresRevealed) { goComplete(); return; }
```

Note: `/api/matches/:id/scores` returns `{ red, blue, redRP, blueRP }` — same shape `applyScore` consumes.

- [ ] **Step 5: Verify**

Run a match to the end. Display must show "UNDER REVIEW" banner, timer `—`, period `Review`. Add a penalty from `/headref` → display score must NOT change. `POST /reveal` → banner switches to winner text. Refresh mid-review → still "UNDER REVIEW" with frozen scores visible.

- [ ] **Step 6: Commit**

```bash
git add public/display.html
git commit -m "feat: display freezes in review mode until scores are revealed"
```

---

### Task 8: Winner pyramid animation (`display.html`)

**Files:**
- Modify: `public/display.html` — CSS block, HTML before `#overlay`, JS

- [ ] **Step 1: Add fonts + animation CSS**

At the top of the `<style>` block add the display font (self-hosted, offline):

```css
    @font-face { font-family: 'Barlow Condensed'; font-weight: 700; font-style: normal;
      src: url('/fonts/BarlowCondensed-700.woff2') format('woff2'); font-display: swap; }
    @font-face { font-family: 'Barlow Condensed'; font-weight: 800; font-style: normal;
      src: url('/fonts/BarlowCondensed-800.woff2') format('woff2'); font-display: swap; }
```

Then add the animation styles (after the `.goal.rp2` rule):

```css
    /* ── WINNER ANIMATION ── */
    #winner-anim {
      position: fixed; inset: 0; z-index: 90;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(ellipse at 50% 70%, #2a2015 0%, #14100a 55%, #0a0806 100%);
      opacity: 0; pointer-events: none; transition: opacity 0.4s ease;
    }
    #winner-anim.visible { opacity: 1; pointer-events: auto; }
    #pyr { width: min(56vw, 62vh); height: auto; }
    #pyr .tier { fill: none; stroke: var(--win-color, #888); stroke-width: 3;
      filter: drop-shadow(0 0 10px var(--win-color, #888)); }
    #pyr-solid .tier { fill: var(--win-color, #888); fill-opacity: 0.85; stroke: none; filter: none; }
    #pyr-fill-rect { y: 560px; transition: y 2s cubic-bezier(0.25, 0.6, 0.3, 1); }
    #winner-anim.filling #pyr-fill-rect { y: 0px; }
    #win-banner {
      position: absolute; left: 50%; top: 62%;
      transform: translate(-50%, -50%) rotate(-4deg) scale(3);
      background: var(--win-color, #888);
      border: 6px solid rgba(0,0,0,0.35); border-radius: 12px;
      padding: 1.2vh 5vw; opacity: 0;
      box-shadow: 0 18px 60px rgba(0,0,0,0.6);
    }
    #winner-anim.banner-in #win-banner { animation: bannerSlam 0.45s cubic-bezier(0.2, 1.4, 0.4, 1) forwards; }
    @keyframes bannerSlam {
      from { opacity: 0; transform: translate(-50%, -50%) rotate(-4deg) scale(3); }
      to   { opacity: 1; transform: translate(-50%, -50%) rotate(-4deg) scale(1); }
    }
    #win-banner-text {
      font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
      font-size: clamp(48px, 9vw, 130px); line-height: 1.1;
      color: #fff; text-transform: uppercase; letter-spacing: 0.02em; white-space: nowrap;
      text-shadow: 0 4px 0 rgba(0,0,0,0.35), 0 0 2px rgba(0,0,0,0.5);
      -webkit-text-stroke: 2px rgba(0,0,0,0.25);
    }
```

- [ ] **Step 2: Add markup**

Immediately after `<div id="motif-reveal">...</div>` (after line 252) add:

```html
<div id="winner-anim">
  <svg id="pyr" viewBox="0 0 800 560" aria-hidden="true">
    <defs>
      <clipPath id="pyr-fill-clip"><rect id="pyr-fill-rect" x="0" y="560" width="800" height="560"/></clipPath>
    </defs>
    <g id="pyr-solid" clip-path="url(#pyr-fill-clip)">
      <rect class="tier" x="60"  y="460" width="680" height="100"/>
      <rect class="tier" x="140" y="360" width="520" height="100"/>
      <rect class="tier" x="220" y="260" width="360" height="100"/>
      <rect class="tier" x="300" y="160" width="200" height="100"/>
      <rect class="tier" x="352" y="60"  width="96"  height="100"/>
    </g>
    <g id="pyr-outline">
      <rect class="tier" x="60"  y="460" width="680" height="100"/>
      <rect class="tier" x="140" y="360" width="520" height="100"/>
      <rect class="tier" x="220" y="260" width="360" height="100"/>
      <rect class="tier" x="300" y="160" width="200" height="100"/>
      <rect class="tier" x="352" y="60"  width="96"  height="100"/>
    </g>
  </svg>
  <div id="win-banner"><span id="win-banner-text"></span></div>
</div>
```

- [ ] **Step 3: Add the sequencer JS**

In the script, after `goReview()` add:

```javascript
  var winnerAnimEl = document.getElementById('winner-anim');
  var winBannerText = document.getElementById('win-banner-text');
  var winAnimTimers = [];

  var WIN_COLORS = { red: '#ED1C24', blue: '#0066B3', tie: '#FFD700' };

  function hideWinnerAnim() {
    winAnimTimers.forEach(clearTimeout);
    winAnimTimers = [];
    winnerAnimEl.classList.remove('visible', 'filling', 'banner-in');
  }

  function playWinnerAnimation(winner, done) {
    hideWinnerAnim();
    winnerAnimEl.style.setProperty('--win-color', WIN_COLORS[winner] || WIN_COLORS.tie);
    winBannerText.textContent = winner === 'tie' ? 'TIE!' : winner.toUpperCase() + ' WINS!';
    winnerAnimEl.classList.add('visible');
    SK.playBuzzer();
    winAnimTimers.push(setTimeout(function () { winnerAnimEl.classList.add('filling'); }, 150));
    winAnimTimers.push(setTimeout(function () { winnerAnimEl.classList.add('banner-in'); }, 2300));
    winAnimTimers.push(setTimeout(function () {
      if (done) done();                    // results screen fades in underneath (z-index 80 < 90)
      winnerAnimEl.classList.remove('visible');
    }, 4400));
    winAnimTimers.push(setTimeout(hideWinnerAnim, 4900));
  }
```

Update the `scores_reveal` handler from Task 7 to:

```javascript
    socket.on('scores_reveal', function (data) {
      reviewing = false;
      goComplete();
      playWinnerAnimation(data && data.winner ? data.winner : 'tie', function () {
        if (data) showResultsScreen(data);   // implemented in Task 9
      });
    });
```

For this task only, add a temporary stub so the page works before Task 9:

```javascript
  function showResultsScreen(results) { /* Task 9 */ }
```

Also call `hideWinnerAnim()` inside `goWaiting()` and `goActive()`.

- [ ] **Step 4: Verify**

Run a match to end, `POST /reveal`. Open `/display` in Playwright at 1280×720: pyramid fills bottom-to-top in winner color over ~2s, banner slams in at ~2.3s, whole overlay fades at ~4.4s. Screenshot mid-animation. Console: 0 errors. Test tie case by making scores equal (override) before reveal.

- [ ] **Step 5: Commit**

```bash
git add public/display.html
git commit -m "feat: pyramid winner animation on score reveal"
```

---

### Task 9: Match Results screen (`display.html`)

**Files:**
- Modify: `public/display.html` — CSS, HTML, JS (replace Task 8 stub)

- [ ] **Step 1: Add CSS**

```css
    /* ── MATCH RESULTS SCREEN ── */
    #results-screen {
      position: fixed; inset: 0; z-index: 80;
      display: none; flex-direction: column;
      background: #101318;
      font-family: 'Barlow Condensed', sans-serif;
      opacity: 0; transition: opacity 0.4s ease;
    }
    #results-screen.visible { display: flex; opacity: 1; }
    .rs-header {
      display: flex; align-items: center; justify-content: space-between;
      background: #000; color: #fff; padding: 1.2vh 2.5vw;
      font-weight: 800; font-size: clamp(22px, 3.2vh, 42px); text-transform: uppercase;
    }
    .rs-body {
      flex: 1; display: grid;
      grid-template-columns: 1fr 1.4fr 1fr;
      grid-template-rows: auto 1fr auto;
      gap: 1.5vh 1.5vw; padding: 2.5vh 3vw;
      max-width: 1700px; width: 100%; margin: 0 auto;
    }
    .rs-winner {
      background: #FFD400; color: #111; border-radius: 8px;
      display: flex; align-items: center; justify-content: center; gap: 0.8vw;
      font-weight: 800; font-size: clamp(28px, 5vh, 64px); text-transform: uppercase;
      visibility: hidden;
    }
    .rs-winner.tie { background: #999; }
    .rs-winner svg { width: clamp(28px, 4.5vh, 56px); height: clamp(28px, 4.5vh, 56px); fill: #111; }
    .rs-scores { display: flex; gap: 4px; }
    .rs-score-panel { flex: 1; border-radius: 8px; color: #fff; text-align: center; padding: 1vh 0; }
    .rs-score-panel.blue { background: #0066B3; }
    .rs-score-panel.red  { background: #ED1C24; }
    .rs-score-label { font-weight: 700; font-size: clamp(18px, 2.6vh, 34px); opacity: 0.92; }
    .rs-score-total { font-weight: 800; font-size: clamp(44px, 8vh, 104px); line-height: 1; font-variant-numeric: tabular-nums; }
    .rs-rows { display: flex; flex-direction: column; justify-content: center; gap: 0.6vh; }
    .rs-row {
      display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: center;
      background: #1b202a; border-radius: 6px; padding: 0.8vh 1.2vw;
      font-size: clamp(20px, 3.4vh, 44px); font-weight: 700; color: #fff;
    }
    .rs-row:nth-child(even) { background: #171b23; }
    .rs-row .v { text-align: center; font-weight: 800; font-variant-numeric: tabular-nums; }
    .rs-row .l { text-align: center; color: #8b93a8; letter-spacing: 0.08em; text-transform: uppercase; }
    .rs-teams { display: flex; flex-direction: column; gap: 1.2vh; justify-content: flex-start; padding-top: 1vh; }
    .rs-team {
      display: flex; align-items: stretch; border-radius: 6px; overflow: hidden;
      font-size: clamp(20px, 3.2vh, 42px); font-weight: 800; color: #fff;
    }
    .rs-team .num { flex: 1; padding: 1vh 1vw; display: flex; align-items: center; }
    .rs-teams.blue .num { background: #0066B3; }
    .rs-teams.red  .num { background: #ED1C24; }
    .rs-team .rank {
      width: 5.5ch; background: #fff; color: #111;
      display: flex; align-items: center; justify-content: center; gap: 0.2ch;
      font-variant-numeric: tabular-nums;
    }
    .rs-team .rank .arr.up { color: #16c95c; } .rs-team .rank .arr.down { color: #e5233d; }
    .rs-rp { display: flex; flex-direction: column; align-items: center; gap: 1vh; justify-content: flex-end; }
    .rs-rp-title { color: #fff; font-weight: 700; font-size: clamp(16px, 2.4vh, 30px); text-transform: uppercase; letter-spacing: 0.08em; }
    .rs-rp-icons { display: flex; gap: 0.6vw; flex-wrap: wrap; justify-content: center; }
    .rs-rp-icons svg { width: clamp(22px, 3.6vh, 44px); height: clamp(22px, 3.6vh, 44px); fill: #fff; opacity: 0.18; }
    .rs-rp-icons svg.lit { opacity: 1; filter: drop-shadow(0 0 6px rgba(255,255,255,0.35)); }
    .rs-qr { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 0.8vh; }
    .rs-qr .qr-box { background: #fff; padding: 8px; border-radius: 6px; line-height: 0; }
    .rs-qr .qr-box img { width: clamp(70px, 12vh, 140px); height: clamp(70px, 12vh, 140px); image-rendering: pixelated; }
    .rs-qr .qr-cap { color: #8b93a8; font-weight: 700; font-size: clamp(13px, 1.8vh, 22px); text-transform: uppercase; letter-spacing: 0.06em; }
    #rs-symbol-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
```

- [ ] **Step 2: Add markup**

After the `#winner-anim` div add. The `<symbol>` sprite holds all static icon art — JS only ever creates `<use>` references (no HTML string injection):

```html
<svg id="rs-symbol-defs" aria-hidden="true">
  <symbol id="rp-trophy" viewBox="0 0 576 512"><path d="M400 0H176c-26.5 0-48.1 21.8-47.1 48.2c.2 5.3 .4 10.6 .7 15.8H24C10.7 64 0 74.7 0 88c0 92.6 33.5 157 78.5 200.7c44.3 43.1 98.3 64.8 138.1 75.8c23.4 6.5 39.4 26 39.4 45.6c0 20.9-17 37.9-37.9 37.9H192c-17.7 0-32 14.3-32 32s14.3 32 32 32H384c17.7 0 32-14.3 32-32s-14.3-32-32-32H357.9C337 448 320 431 320 410.1c0-19.6 15.9-39.2 39.4-45.6c39.9-11 93.9-32.7 138.2-75.8C542.5 245 576 180.6 576 88c0-13.3-10.7-24-24-24H446.4c.3-5.2 .5-10.4 .7-15.8C448.1 21.8 426.5 0 400 0z"/></symbol>
  <symbol id="rp-base" viewBox="0 0 576 512"><path d="M575.8 255.5c0 18-15 32.1-32 32.1h-32l.7 160.2c0 2.7-.2 5.4-.5 8.1V472c0 22.1-17.9 40-40 40H456c-1.1 0-2.2 0-3.3-.1c-1.4 .1-2.8 .1-4.2 .1H416 392c-22.1 0-40-17.9-40-40V448 384c0-17.7-14.3-32-32-32H256c-17.7 0-32 14.3-32 32v64 24c0 22.1-17.9 40-40 40H160 128.1c-1.5 0-3-.1-4.5-.2c-1.2 .1-2.4 .2-3.6 .2H104c-22.1 0-40-17.9-40-40V360c0-.9 0-1.9 .1-2.8V287.6H32c-18 0-32-14-32-32.1c0-9 3-17 10-24L266.4 8c7-7 15-8 22-8s15 2 21 7L564.8 231.5c8 7 12 15 11 24z"/></symbol>
  <symbol id="rp-pattern" viewBox="0 0 448 512"><path d="M128 32H32C14.3 32 0 46.3 0 64v96c0 17.7 14.3 32 32 32h96c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32zm0 160H32c-17.7 0-32 14.3-32 32v96c0 17.7 14.3 32 32 32h96c17.7 0 32-14.3 32-32V224c0-17.7-14.3-32-32-32zM416 32h-96c-17.7 0-32 14.3-32 32v96c0 17.7 14.3 32 32 32h96c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32zm0 320h-96c-17.7 0-32 14.3-32 32v96c0 17.7 14.3 32 32 32h96c17.7 0 32-14.3 32-32V384c0-17.7-14.3-32-32-32z"/></symbol>
  <symbol id="rp-ball" viewBox="0 0 512 512"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512z"/></symbol>
</svg>

<div id="results-screen">
  <div class="rs-header">
    <div>Match Results</div>
    <div id="rs-match-label">&#x2014;</div>
    <div id="rs-event-label">&#x2014;</div>
  </div>
  <div class="rs-body">
    <div class="rs-winner" id="rs-winner-blue"><svg><use href="#rp-trophy"/></svg><span class="rs-winner-txt">WINNER</span></div>
    <div class="rs-scores">
      <div class="rs-score-panel blue"><div class="rs-score-label">Blue</div><div class="rs-score-total" id="rs-blue-total">0</div></div>
      <div class="rs-score-panel red"><div class="rs-score-label">Red</div><div class="rs-score-total" id="rs-red-total">0</div></div>
    </div>
    <div class="rs-winner" id="rs-winner-red"><svg><use href="#rp-trophy"/></svg><span class="rs-winner-txt">WINNER</span></div>
    <div class="rs-teams blue" id="rs-teams-blue"></div>
    <div class="rs-rows" id="rs-rows"></div>
    <div class="rs-teams red" id="rs-teams-red"></div>
    <div class="rs-rp"><div class="rs-rp-title">Ranking Points</div><div class="rs-rp-icons" id="rs-rp-blue"></div></div>
    <div class="rs-qr"><div class="qr-box" id="rs-qr"></div><div class="qr-cap">Scan for live results</div></div>
    <div class="rs-rp"><div class="rs-rp-title">Ranking Points</div><div class="rs-rp-icons" id="rs-rp-red"></div></div>
  </div>
</div>
```

And before the `common.js` script tag add:

```html
<script src="/js/qrcode.js"></script>
```

- [ ] **Step 3: Add render JS (replaces Task 8 stub)**

All rendering uses safe DOM construction — no `innerHTML`:

```javascript
  // ── Match Results screen ────────────────────────────────────────────────────
  var resultsEl     = document.getElementById('results-screen');
  var rsMatchLabel  = document.getElementById('rs-match-label');
  var rsEventLabel  = document.getElementById('rs-event-label');
  var rsBlueTotal   = document.getElementById('rs-blue-total');
  var rsRedTotal    = document.getElementById('rs-red-total');
  var rsWinnerBlue  = document.getElementById('rs-winner-blue');
  var rsWinnerRed   = document.getElementById('rs-winner-red');
  var rsRows        = document.getElementById('rs-rows');
  var rsTeamsBlue   = document.getElementById('rs-teams-blue');
  var rsTeamsRed    = document.getElementById('rs-teams-red');
  var rsRpBlue      = document.getElementById('rs-rp-blue');
  var rsRpRed       = document.getElementById('rs-rp-red');
  var currentResults = null;
  var qrRendered = false;

  var RS_CATS = [
    ['leave', 'Leave'], ['artifact', 'Artifact'], ['pattern', 'Pattern'],
    ['balls', 'Balls'], ['base', 'Base'], ['foul', 'Foul']
  ];

  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function makeUseIcon(symbolId) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + symbolId);
    svg.appendChild(use);
    return svg;
  }

  function rpIconRow(container, rp) {
    clearEl(container);
    var groups = [
      ['rp-trophy',  4, rp ? rp.winLossRp || 0 : 0],
      ['rp-base',    2, rp ? rp.parkRp    || 0 : 0],
      ['rp-pattern', 2, rp ? rp.patternRp || 0 : 0],
      ['rp-ball',    2, rp ? rp.ballRp    || 0 : 0]
    ];
    groups.forEach(function (g) {
      for (var i = 0; i < g[1]; i++) {
        var icon = makeUseIcon(g[0]);
        if (i < g[2]) icon.classList.add('lit');
        container.appendChild(icon);
      }
    });
  }

  function renderTeamPills(container, teams) {
    clearEl(container);
    (teams || []).forEach(function (t) {
      var pill = document.createElement('div');
      pill.className = 'rs-team';
      var num = document.createElement('div');
      num.className = 'num';
      num.textContent = t.number;
      var rank = document.createElement('div');
      rank.className = 'rank';
      var r = document.createElement('span');
      r.textContent = t.rank != null ? t.rank : '\u2014';
      var arr = document.createElement('span');
      arr.className = 'arr ' + (t.delta != null && t.delta < 0 ? 'down' : t.delta === 0 ? '' : 'up');
      arr.textContent = t.delta == null || t.delta > 0 ? '\u2191' : t.delta < 0 ? '\u2193' : '\u2014';
      rank.appendChild(r);
      rank.appendChild(arr);
      pill.appendChild(num);
      pill.appendChild(rank);
      container.appendChild(pill);
    });
  }

  function renderResultsData(r) {
    rsMatchLabel.textContent = (r.match && r.match.phase === 'playoffs' ? 'Playoff ' : 'Qualification ') +
      (r.match ? r.match.match_number : '') + (r.matchCount ? ' of ' + r.matchCount : '');
    rsEventLabel.textContent = eventNameEl.textContent !== '\u2014' ? eventNameEl.textContent : 'DECODE';
    rsBlueTotal.textContent = r.blue.total;
    rsRedTotal.textContent  = r.red.total;
    rsWinnerBlue.style.visibility = r.winner === 'blue' || r.winner === 'tie' ? 'visible' : 'hidden';
    rsWinnerRed.style.visibility  = r.winner === 'red'  || r.winner === 'tie' ? 'visible' : 'hidden';
    rsWinnerBlue.classList.toggle('tie', r.winner === 'tie');
    rsWinnerRed.classList.toggle('tie', r.winner === 'tie');
    rsWinnerBlue.querySelector('.rs-winner-txt').textContent = r.winner === 'tie' ? 'TIE' : 'WINNER';
    rsWinnerRed.querySelector('.rs-winner-txt').textContent  = r.winner === 'tie' ? 'TIE' : 'WINNER';

    clearEl(rsRows);
    RS_CATS.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'rs-row';
      var vb = document.createElement('div');
      vb.className = 'v';
      vb.textContent = r.blue.breakdown[c[0]] || 0;
      var l = document.createElement('div');
      l.className = 'l';
      l.textContent = c[1];
      var vr = document.createElement('div');
      vr.className = 'v';
      vr.textContent = r.red.breakdown[c[0]] || 0;
      row.appendChild(vb); row.appendChild(l); row.appendChild(vr);
      rsRows.appendChild(row);
    });

    renderTeamPills(rsTeamsBlue, r.teams && r.teams.blue);
    renderTeamPills(rsTeamsRed,  r.teams && r.teams.red);
    rpIconRow(rsRpBlue, r.blue.rp);
    rpIconRow(rsRpRed,  r.red.rp);

    if (!qrRendered && typeof qrcode === 'function') {
      var qr = qrcode(0, 'M');
      qr.addData(location.origin + '/public');
      qr.make();
      var img = document.createElement('img');
      img.src = qr.createDataURL(4, 0);   // GIF data URL — no HTML injection
      img.alt = 'QR: live results';
      var box = document.getElementById('rs-qr');
      clearEl(box);
      box.appendChild(img);
      qrRendered = true;
    }
  }

  function showResultsScreen(results) {
    currentResults = results;
    renderResultsData(results);
    resultsEl.classList.add('visible');
  }

  function hideResultsScreen() {
    currentResults = null;
    resultsEl.classList.remove('visible');
  }

  // Rebuild category points from a broadcastScores payload (live update after reveal)
  function catFromPts(p) {
    p = p || {};
    return {
      leave:    p.auto_leave || 0,
      artifact: (p.auto_classified || 0) + (p.auto_overflow || 0) + (p.teleop_classified || 0) + (p.teleop_overflow || 0),
      pattern:  (p.auto_pattern || 0) + (p.teleop_pattern || 0),
      balls:    p.teleop_balls || 0,
      base:     p.park || 0,
      foul:     p.penalties || 0
    };
  }

  function updateResultsFromScoreUpdate(data) {
    if (!currentResults || !data || data.matchId !== currentResults.matchId) return;
    currentResults.red  = { total: data.red.total,  breakdown: catFromPts(data.red.ptsBreakdown),  rp: data.redRP };
    currentResults.blue = { total: data.blue.total, breakdown: catFromPts(data.blue.ptsBreakdown), rp: data.blueRP };
    currentResults.winner = data.red.total > data.blue.total ? 'red' : data.blue.total > data.red.total ? 'blue' : 'tie';
    renderResultsData(currentResults);
  }

  function updateResultsRanks(rankings) {
    if (!currentResults || !rankings) return;
    ['red', 'blue'].forEach(function (a) {
      (currentResults.teams[a] || []).forEach(function (t) {
        var row = rankings.find(function (x) { return x.teamNumber === t.number; });
        if (row) t.rank = row.rank;
      });
    });
    renderTeamPills(rsTeamsBlue, currentResults.teams.blue);
    renderTeamPills(rsTeamsRed,  currentResults.teams.red);
  }
```

(`SV G_NS` already exists in display.html at line 453 as `var SVG_NS = 'http://www.w3.org/2000/svg';` — reuse it; the results code must be placed after it.)

- [ ] **Step 4: Wire into socket handlers and lifecycle**

- In `scores_reveal` (Task 8) the `showResultsScreen(data)` call now works — remove the stub.
- Change the `score_update` handler to:
```javascript
    socket.on('score_update', function (data) {
      if (currentResults) { updateResultsFromScoreUpdate(data); return; }
      if (reviewing) return;
      applyScore(data);
    });
```
- Add:
```javascript
    socket.on('rankings_update', function (rankings) { updateResultsRanks(rankings); });
```
- Call `hideResultsScreen()` at the top of `goWaiting()` and `goActive()`, and inside the `match_loaded` socket handler.
- In `fetchTimerState()` recovery (Task 7 Step 4), change the revealed branch to:
```javascript
      if (state.matchEnded && state.scoresRevealed) {
        fetch('/api/matches/' + state.matchId + '/results')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { goComplete(); if (d) showResultsScreen(d); })
          .catch(function () { goComplete(); });
        return;
      }
```

- [ ] **Step 5: Verify with Playwright (1280×720 and 1920×1080)**

Full flow: run match → review → reveal. After the animation, results screen shows: header "Qualification N of M", totals, WINNER box on correct side, 6 rows with correct values (cross-check against `/api/matches/:id/results`), team pills with rank+arrow, lit/dim RP icons matching `rp` values, QR image rendered (decodes to `http://<host>/public`). Add a penalty from headref → FOUL row and totals update live. Commit from control → rank pills refresh. Load next match → screen hides. Refresh page while revealed → results screen returns without animation. Console: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add public/display.html
git commit -m "feat: broadcast-style match results screen with RP icons, rank movement and QR"
```

---

### Task 10: Scorers stay live during review (`red.html`, `blue.html`)

**Files:**
- Modify: `public/red.html` (badge CSS+HTML, guards at lines 635/774/780/785, socket handlers at lines 895-903)
- Modify: `public/blue.html` (identical changes; find equivalents with Grep — handlers at lines 891-899)

- [ ] **Step 1: Add review badge (both files)**

CSS (append inside the page `<style>` block):

```css
    #review-badge {
      position: fixed; top: max(8px, env(safe-area-inset-top)); right: 8px; z-index: 300;
      background: var(--yellow); color: #191100;
      font-family: var(--font-display); font-weight: 700; font-size: 0.85rem;
      letter-spacing: 0.08em; text-transform: uppercase;
      padding: 6px 14px; border-radius: 6px; display: none;
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    }
    #review-badge.visible { display: block; }
```

HTML (immediately before the first `<script>` tag):

```html
<div id="review-badge">Review</div>
```

- [ ] **Step 2: Add `reviewing` state + relax send guards (both files)**

In the `state` object (red.html:301 area) add `reviewing: false,`. Then change the four guards:

```javascript
      if (!state.matchId || (!state.timerRunning && !state.reviewing)) return;
```

in `sendPatternBall` (red.html:635), `sendIncrement` (:774), `sendToggle` (:780), `sendParkUpdate` (:785). (blue.html has the same four functions.)

- [ ] **Step 3: Rewire `match_end` / add `scores_reveal` (both files)**

Replace (red.html:895-898):

```javascript
      sock.on('match_end', function () {
        state.timerRunning = false;
        showWait('Match Over');
      });
```

with:

```javascript
      sock.on('match_end', function () {
        state.timerRunning = false;
        state.reviewing = true;
        state.buzzerScoringOpen = false;
        hideWait();
        document.getElementById('review-badge').classList.add('visible');
        renderScoringPanel();   // last period is BUZZER → shows the "Open Scoring" prompt
      });

      sock.on('scores_reveal', function () {
        state.reviewing = false;
        document.getElementById('review-badge').classList.remove('visible');
        showWait('Match Over');
      });
```

And in the existing `match_abort` and `match_loaded` handlers add:

```javascript
        state.reviewing = false;
        document.getElementById('review-badge').classList.remove('visible');
```

- [ ] **Step 4: Refresh recovery (both files)**

In the timer-state fetch (red.html:376 area, where `state.timerRunning` is set from `ts`), after that line add:

```javascript
          state.reviewing = !!(ts.matchEnded && !ts.scoresRevealed);
          document.getElementById('review-badge').classList.toggle('visible', state.reviewing);
          if (ts.matchEnded && ts.scoresRevealed) showWait('Match Over');
```

- [ ] **Step 5: Verify**

Playwright at 375×812 and 768×1024 on `/red`: run match to end → REVIEW badge appears, "Open Scoring" prompt shown, opening it allows +/- on teleop fields and the server accepts (score changes on control). `POST /reveal` → badge gone, "Match Over" overlay. Repeat spot-check on `/blue`. Console: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add public/red.html public/blue.html
git commit -m "feat: scorers stay editable during post-match review"
```

---

### Task 11: Refs stay live during review (`ref.html`, `ref-blue.html`, `headref.html`)

**Files:**
- Modify: `public/ref.html:453-456`, `public/ref-blue.html:400-404`, `public/headref.html:590-593` + badge CSS/HTML in all three

- [ ] **Step 1: Add the same `#review-badge` CSS + HTML from Task 10 Step 1 to all three files.**

- [ ] **Step 2: `ref.html`** — replace lines 453-456:

```javascript
      sock.on('match_end', function () {
        matchRunning = false;
        document.getElementById('review-badge').classList.add('visible');
        // Buttons stay ENABLED — fouls can still be recorded during review
      });

      sock.on('scores_reveal', function () {
        document.getElementById('review-badge').classList.remove('visible');
        setButtonsEnabled(false);
      });
```

In the existing `match_abort` and `match_loaded` handlers add `document.getElementById('review-badge').classList.remove('visible');`.

- [ ] **Step 3: `ref-blue.html`** — replace lines 400-404 with the same pattern (it uses `state.matchRunning` and also sets `periodLbl.textContent = 'Final'` — keep that line but change it to `'Review'`; set `'Final'` in the new `scores_reveal` handler instead).

- [ ] **Step 4: `headref.html`** — replace lines 590-593:

```javascript
      sock.on('match_end', function () {
        matchRunning = false;
        document.getElementById('review-badge').classList.add('visible');
        // Penalty buttons stay ENABLED during review
      });

      sock.on('scores_reveal', function () {
        document.getElementById('review-badge').classList.remove('visible');
        setButtonsEnabled(false);
      });
```

Same badge-clear lines in `match_abort` / `match_loaded`.

**Important:** all three files have a foul-button click guard (`if (!matchRunning)` at ref.html:462 / equivalents). Change each to allow review:

```javascript
      if (!matchRunning && !document.getElementById('review-badge').classList.contains('visible')) {
```

(Keep whatever toast/early-return body follows.)

- [ ] **Step 5: Refresh recovery (all three)** — where each page fetches `/api/timer` on load and sets its running flag, add:

```javascript
          var inReview = !!(ts.matchEnded && !ts.scoresRevealed);
          document.getElementById('review-badge').classList.toggle('visible', inReview);
          if (inReview) setButtonsEnabled(true);
```

- [ ] **Step 6: Verify**

Playwright on `/headref` (768×1024) and `/ref-red` (375×812): after match end, badge visible, tapping Minor Foul records a penalty (appears in log + display FOUL row if revealed). After reveal, foul buttons disabled and badge gone. Console: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add public/ref.html public/ref-blue.html public/headref.html
git commit -m "feat: refs stay live during post-match review"
```

---

### Task 12: Control "Show Scores" button (`control.html`)

**Files:**
- Modify: `public/control.html` — commit card build (lines 657-664), `commitScores` (1140-1155), socket handlers (1191-1197, 1203-1232), `fetchTimerState` (794-815), state object (~387)

- [ ] **Step 1: State + button**

In the `state` object add `scoresRevealed: false,`. In the commit-card build (lines 657-664) change to:

```javascript
      // 4. Post-match commit card
      commitCard = makeCard('Post-Match');
      commitCard.className += ' commit-card hidden';
      revealBtn = document.createElement('button');
      revealBtn.textContent = 'Show Scores on Display';
      revealBtn.className = 'btn-start';
      revealBtn.addEventListener('click', revealScores);
      commitCard.appendChild(revealBtn);
      var commitBtn = document.createElement('button');
      commitBtn.textContent = 'Commit Scores & Save Results';
      commitBtn.addEventListener('click', commitScores);
      commitCard.appendChild(commitBtn);
      layout.appendChild(commitCard);
```

Declare `revealBtn` alongside the other button vars: add it to the `var startBtn, pauseBtn, ...` list (line 407).

- [ ] **Step 2: `revealScores()` + visibility helper**

Next to `commitScores` add:

```javascript
    function updateRevealBtn() {
      if (!revealBtn) return;
      revealBtn.style.display = state.matchEnded && !state.scoresRevealed ? '' : 'none';
    }

    function revealScores() {
      if (!state.loadedMatchId) { showToast('No match loaded', 'error'); return; }
      fetch('/api/matches/' + state.loadedMatchId + '/reveal', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function () { showToast('Scores revealed on display', 'success'); })
        .catch(function () { showToast('Failed to reveal scores', 'error'); });
    }
```

- [ ] **Step 3: Wire state changes**

- `match_end` handler (line 1191): add `state.scoresRevealed = false; updateRevealBtn();`
- Add a new handler:
```javascript
      socket.on('scores_reveal', function () {
        state.scoresRevealed = true;
        updateRevealBtn();
      });
```
- `match_loaded` handler: add `state.scoresRevealed = false; updateRevealBtn();`
- `match_abort` handler: add `state.scoresRevealed = false; updateRevealBtn();`
- `commitScores()` success: add `state.scoresRevealed = false; updateRevealBtn();`
- `fetchTimerState()` (line 799 area): after `if (ts.matchEnded) state.matchEnded = true;` add:
```javascript
          state.scoresRevealed = !!ts.scoresRevealed;
          if (ts.matchEnded) commitCard.classList.remove('hidden');
          updateRevealBtn();
```

- [ ] **Step 4: Verify**

Run match to end on `/control`: Post-Match card shows both "Show Scores on Display" and "Commit". Click reveal → button hides, display animates. Refresh control mid-review → button visible; refresh after reveal → hidden, commit still there. Console: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add public/control.html
git commit -m "feat: Show Scores button on control triggers reveal"
```

---

### Task 13: Control Match History drawer (`control.html`)

**Files:**
- Modify: `public/control.html` — append a card after the commit card in the layout build, plus CSS

- [ ] **Step 1: CSS** (append to control.html's `<style>` block):

```css
    .history-list { display: flex; flex-direction: column; gap: 0.4rem; }
    .history-row {
      display: flex; justify-content: space-between; align-items: center;
      background: var(--bg3); border-radius: 8px; padding: 0.6rem 0.9rem;
      cursor: pointer; font-variant-numeric: tabular-nums;
    }
    .history-row:hover { background: var(--bg4); }
    .history-edit { background: var(--bg3); border-radius: 8px; padding: 0.9rem; margin-top: 0.4rem; }
    .history-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; }
    .history-grid label { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
      font-size: 0.85rem; color: var(--text2); margin-bottom: 0.35rem; }
    .history-grid input[type=number] { width: 70px; min-height: 34px; background: var(--bg4);
      color: var(--text); border: 1px solid var(--bg4); border-radius: 6px; text-align: center; }
    .history-cards label { font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.3rem; margin-right: 0.8rem; }
    .history-save { margin-top: 0.8rem; min-height: var(--tap); }
```

- [ ] **Step 2: Build the drawer**

After `layout.appendChild(commitCard);` add:

```javascript
      // 5. Match History (edit committed scores)
      historyCard = makeCard('Match History');
      var historyToggle = document.createElement('button');
      historyToggle.textContent = 'Show Completed Matches';
      historyToggle.addEventListener('click', toggleHistory);
      historyList = document.createElement('div');
      historyList.className = 'history-list';
      historyList.style.display = 'none';
      historyCard.appendChild(historyToggle);
      historyCard.appendChild(historyList);
      layout.appendChild(historyCard);
```

Declare `historyCard, historyList` in the top-level `var` list.

- [ ] **Step 3: Drawer logic (no innerHTML — DOM construction only)**

Add near `commitScores`:

```javascript
    // ── Match History ──────────────────────────────────────────────────────────
    var HISTORY_FIELDS = [
      ['auto_classified','Auto Classified'], ['auto_overflow','Auto Overflow'],
      ['auto_leave_r1','R1 Left Zone'], ['auto_leave_r2','R2 Left Zone'],
      ['auto_pattern','Auto Pattern'], ['teleop_classified','Teleop Classified'],
      ['teleop_overflow','Teleop Overflow'], ['teleop_balls','Teleop Balls'],
      ['teleop_pattern','Teleop Pattern']
    ];

    function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function teamNum(t) { return t && t.number ? String(t.number) : '\u2014'; }

    function toggleHistory() {
      var open = historyList.style.display === 'none';
      historyList.style.display = open ? '' : 'none';
      if (open) loadHistory();
    }

    function loadHistory() {
      fetch('/api/matches')
        .then(function (r) { return r.json(); })
        .then(function (matches) {
          clearEl(historyList);
          matches.filter(function (m) { return m.state === 'COMPLETED'; }).forEach(function (m) {
            var row = document.createElement('div');
            row.className = 'history-row';
            var lbl = document.createElement('span');
            lbl.textContent = (m.phase === 'playoffs' ? 'P' : 'Q') + m.match_number;
            var teams = document.createElement('span');
            teams.textContent = teamNum(m.red1_team) + ' & ' + teamNum(m.red2_team) +
              ' vs ' + teamNum(m.blue1_team) + ' & ' + teamNum(m.blue2_team);
            row.appendChild(lbl);
            row.appendChild(teams);
            row.addEventListener('click', function () { openHistoryEditor(m, row); });
            historyList.appendChild(row);
          });
          if (!historyList.firstChild) historyList.textContent = 'No completed matches yet.';
        })
        .catch(function () { showToast('Failed to load matches', 'error'); });
    }

    function openHistoryEditor(m, row) {
      var existing = row.nextSibling;
      if (existing && existing.className === 'history-edit') { existing.remove(); return; }
      document.querySelectorAll('.history-edit').forEach(function (e) { e.remove(); });

      fetch('/api/matches/' + m.id + '/scores')
        .then(function (r) { return r.json(); })
        .then(function (scores) {
          var panel = document.createElement('div');
          panel.className = 'history-edit';
          var grid = document.createElement('div');
          grid.className = 'history-grid';
          var teamsByAlliance = {
            red:  [m.red1_team, m.red2_team].filter(Boolean),
            blue: [m.blue1_team, m.blue2_team].filter(Boolean)
          };

          ['red', 'blue'].forEach(function (a) {
            var col = document.createElement('div');
            var h = document.createElement('h3');
            h.textContent = a.toUpperCase();
            h.className = a + '-text';
            col.appendChild(h);
            HISTORY_FIELDS.forEach(function (f) {
              var lab = document.createElement('label');
              lab.textContent = f[1];
              var inp = document.createElement('input');
              inp.type = 'number'; inp.min = '0';
              inp.value = scores[a] && scores[a].raw ? (scores[a].raw[f[0]] || 0) : 0;
              inp.setAttribute('data-alliance', a);
              inp.setAttribute('data-field', f[0]);
              lab.appendChild(inp);
              col.appendChild(lab);
            });
            // card checkboxes per team
            ['yellow_cards', 'red_cards'].forEach(function (cf) {
              var wrap = document.createElement('div');
              wrap.className = 'history-cards';
              var title = document.createElement('div');
              title.textContent = cf === 'yellow_cards' ? 'Yellow cards:' : 'Red cards:';
              title.style.cssText = 'font-size:0.8rem;color:var(--text2);margin:0.4rem 0 0.2rem;';
              wrap.appendChild(title);
              var current = (scores[a] && scores[a][cf]) || [];
              teamsByAlliance[a].forEach(function (t) {
                var lab = document.createElement('label');
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = current.indexOf(t.number) !== -1;
                cb.setAttribute('data-alliance', a);
                cb.setAttribute('data-card', cf);
                cb.setAttribute('data-team', t.number);
                lab.appendChild(cb);
                lab.appendChild(document.createTextNode(' ' + t.number));
                wrap.appendChild(lab);
              });
              col.appendChild(wrap);
            });
            grid.appendChild(col);
          });

          panel.appendChild(grid);
          var save = document.createElement('button');
          save.className = 'history-save';
          save.textContent = 'Save Changes';
          save.addEventListener('click', function () { saveHistoryEdits(m.id, panel, scores); });
          panel.appendChild(save);
          row.parentNode.insertBefore(panel, row.nextSibling);
        })
        .catch(function () { showToast('Failed to load scores', 'error'); });
    }

    function saveHistoryEdits(matchId, panel, original) {
      var requests = [];
      panel.querySelectorAll('input[type=number]').forEach(function (inp) {
        var a = inp.getAttribute('data-alliance');
        var f = inp.getAttribute('data-field');
        var oldVal = original[a] && original[a].raw ? (original[a].raw[f] || 0) : 0;
        var newVal = Number(inp.value) || 0;
        if (newVal !== oldVal) {
          requests.push(fetch('/api/matches/' + matchId + '/override', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alliance: a, field: f, value: newVal, changedBy: 'control-history' })
          }));
        }
      });
      ['red', 'blue'].forEach(function (a) {
        ['yellow_cards', 'red_cards'].forEach(function (cf) {
          var boxes = panel.querySelectorAll('input[data-alliance="' + a + '"][data-card="' + cf + '"]');
          if (!boxes.length) return;
          var newCards = [];
          boxes.forEach(function (cb) { if (cb.checked) newCards.push(Number(cb.getAttribute('data-team'))); });
          var oldCards = (original[a] && original[a][cf]) || [];
          if (JSON.stringify(newCards.slice().sort()) !== JSON.stringify(oldCards.slice().sort())) {
            requests.push(fetch('/api/matches/' + matchId + '/override', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ alliance: a, field: cf, value: newCards, changedBy: 'control-history' })
            }));
          }
        });
      });
      if (!requests.length) { showToast('No changes', 'error'); return; }
      Promise.all(requests)
        .then(function (rs) {
          if (rs.some(function (r) { return !r.ok; })) throw new Error();
          showToast('Saved — rankings updated', 'success');
          panel.remove();
        })
        .catch(function () { showToast('Some changes failed to save', 'error'); });
    }
```

Note: `scores[a].raw` is the raw `match_scores` row (see `getFullScore` return, `db.js:370`) — it has every field including `teleop_pattern` and the boolean leave columns. If control.html already defines a `clearEl` helper, reuse it instead of redeclaring.

- [ ] **Step 4: Verify**

On `/control` (1280 wide): expand Match History → completed matches listed. Open one, change Teleop Balls, save → toast; `/api/rankings` reflects new totals; `rankings_update` reaches `/rankings` page live. Toggle a yellow card, save → visible in `/api/matches/:id/scores`. Editing a field back restores original rankings. Console: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add public/control.html
git commit -m "feat: match history drawer for editing committed scores from control"
```

---

### Task 14: Documentation + full E2E verification

**Files:**
- Modify: `README.md` (API tables, socket events, page summaries, match lifecycle)

- [ ] **Step 1: Update README**

- **Scoring API table:** add rows `POST /api/matches/:id/reveal` (`{ ok }` or 409; reveals scores, emits `scores_reveal`) and `GET /api/matches/:id/results` (full results payload). Update `/override` row: allowed fields now include `teleop_pattern`, `yellow_cards`, `red_cards` (arrays); note rankings re-run when the match is committed.
- **Socket events table (server→client):** add `scores_reveal` — full results payload — "Show Scores clicked on control".
- **Match Lifecycle:** insert a review step between "Match ends" and "Head referee commits": "Match ends → REVIEW phase (display frozen, refs/scorers can still correct) → controller clicks Show Scores → winner animation + results screen on /display → commit".
- **Page summaries:** `display.html` — add winner pyramid animation + Match Results screen paragraph (6 category rows, rank movement, RP icon rows, QR to `/public`). `control.html` — add Show Scores button + Match History drawer. Scorer/ref pages — note review-mode badge.
- **`timer.js` properties table:** add `scoresRevealed`.
- **`scoring.js`:** document `updateRankings(db, includeMatchId?)`.
- **Architecture:** add `public/js/qrcode.js` (vendored, offline QR).

- [ ] **Step 2: Full E2E run (Playwright)**

1. Fresh match: load → randomize motif → start → score a bit from `/red`, `/blue`, foul from `/ref-red`.
2. Fast-forward to end. Display shows UNDER REVIEW; headref adds a major foul (log updates, display frozen).
3. Control → Show Scores. Verify animation then results screen; FOUL row includes the review-phase foul; rank arrows present.
4. Commit from control → rankings update; results screen rank pills refresh.
5. History drawer: edit the committed match's Teleop Balls → results screen totals update live (via `score_update`), rankings change.
6. Load the next match → results screen dismissed, all views reset, badges cleared.
7. `curl -s localhost:3000/api/docs/readme > /dev/null` and open `/docs` — renders updated README.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: post-match review flow, reveal API, results screen"
```

---

## Self-Review Notes

- **Spec coverage:** review phase (T1, T7), reveal endpoint (T3), display freeze + recovery (T7, T9), scorer/ref live review (T5, T10, T11), Show Scores (T12), history drawer + card overrides (T4, T13), winner animation (T8), results screen with categories/ranks/RP icons/QR (T3, T6, T9), README (T14). Spec's `teleop_pattern` reference resolved: it IS a real column; added to override whitelist and history editor.
- **Type consistency:** results payload shape defined in T3 is consumed verbatim in T9 (`r.blue.breakdown.leave`, `r.teams.red[].rank/delta`, `r.blue.rp.winLossRp`). `scores[a].raw` usage in T13 matches `getFullScore` return shape.
- **DOM safety:** all dynamic rendering uses `createElement`/`textContent`/`createElementNS` + `<use>`; QR rendered via `createDataURL` into an `<img>`; zero `innerHTML` assignments.
- **Ordering:** T1–T6 are server/foundation, T7–T9 display, T10–T13 clients, T14 docs+E2E. Each task leaves the app working.
