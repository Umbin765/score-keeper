# Score Keeper

A local-network FTC-style robotics competition scorekeeper built with Node.js, Express, Socket.io, and SQLite. Runs entirely offline on a local network. All match state is managed server-side; browser views are thin clients synced via real-time WebSocket broadcasts.

## Quick Start

```bash
npm install
npm start
```

Server starts on port 3000 (or `PORT` env var), bound to `0.0.0.0`.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.18.2 | HTTP server and routing |
| `socket.io` | ^4.7.2 | Real-time WebSocket communication |
| `better-sqlite3` | ^11.0.0 | SQLite database (WAL mode, foreign keys) |
| `cookie-parser` | ^1.4.6 | Cookie parsing |
| `express-session` | ^1.17.3 | Session-based authentication |

---

## Architecture

```
server.js          Express HTTP + Socket.io server (single process)
db.js              SQLite schema, migrations, query helpers
timer.js           Server-side match timer state machine
scoring.js         Score calculation, RP computation, rankings engine
scheduler.js       Round-robin schedule generator (circle method)
bracket.js         Double-elimination bracket templates (4/6/8 alliances)
public/js/common.js  Shared client utilities (PIN pad, timer, toasts, buzzer)
public/css/style.css Global dark-theme design system (tokens, fonts, components)
public/fonts/        Self-hosted Barlow / Barlow Condensed woff2 (works offline)
public/*.html      Thin browser clients (vanilla JS, no framework)
```

The UI uses self-hosted fonts served from `/fonts` (`Barlow` for UI text, `Barlow Condensed` for timers, scores and headings) so the system works fully offline. Design tokens (colors, fonts, shadows, touch-target size) are CSS variables defined in `style.css` under `:root`.

---

## Design System

### Fonts

Six woff2 files (~92 KB total) are bundled in `public/fonts/` and served via the Express static route `app.use('/fonts', ...)`. No external CDN requests are made at runtime.

| File | Weight | Use |
|------|--------|-----|
| `Barlow-400.woff2` | Regular | Body text, labels |
| `Barlow-600.woff2` | SemiBold | UI emphasis |
| `Barlow-700.woff2` | Bold | Headings |
| `BarlowCondensed-600.woff2` | SemiBold | Compact numeric displays |
| `BarlowCondensed-700.woff2` | Bold | Period labels, section headers |
| `BarlowCondensed-800.woff2` | ExtraBold | Timers, scores, primary display |

### CSS Custom Properties (`:root`)

| Token | Value | Purpose |
|-------|-------|---------|
| `--font-main` | `'Barlow'` | Body / UI text |
| `--font-display` | `'Barlow Condensed'` | Timers, scores, headings |
| `--tap` | `48px` | Minimum touch-target size |
| `--bg` | `#0a0c10` | Page background |
| `--bg2` | `#12151c` | Card background |
| `--bg3` | `#1b1f28` | Elevated surface |
| `--bg4` | `#262b36` | Input / inactive state |
| `--text` | `#e8ecf4` | Primary text |
| `--text2` | `#8b93a8` | Secondary / muted text |
| `--red` | `#e5233d` | Red alliance accent |
| `--red-light` | `#ff4d5e` | Red hover / border |
| `--blue` | `#1567e0` | Blue alliance accent |
| `--blue-light` | `#4d94ff` | Blue hover / border |
| `--green` | `#16c95c` | Success / positive |
| `--yellow` | `#ffc233` | Warning / minor foul |
| `--radius` | `10px` | Default border radius |
| `--shadow-1` | `0 2px 8px rgba(0,0,0,.45)` | Card shadow |
| `--shadow-2` | `0 4px 20px rgba(0,0,0,.6)` | Elevated shadow |

### Responsive Design Breakpoints

Ref and scorer views (`ref.html`, `ref-blue.html`, `red.html`, `blue.html`, `headref.html`) are designed mobile-first. The match controller (`control.html`) is desktop-only.

| Breakpoint | Applied to | Effect |
|------------|-----------|--------|
| `min-width: 900px` | `headref.html` | 2-column grid (penalty buttons left, log + actions right) |
| `min-width: 1000px` | `control.html` | 2-column grid (pipeline/timer/scores left, motif right) |

Ref and scorer views use `clamp()` for fluid type scaling and `env(safe-area-inset-top/bottom)` for notch-safe layout on tablets.

---

## Pages & Access

| Route | Page | Auth | Description |
|-------|------|------|-------------|
| `/` | index.html | None | Landing page with links to all views |
| `/display` | display.html | None | 1920x1080 broadcast overlay (transparent bg, TV output) |
| `/public` | public.html | None | Mobile-friendly live scores, rankings, schedule |
| `/rankings` | rankings.html | None | Detailed rankings with per-match RP breakdown |
| `/bracket` | bracket.html | None | Playoff bracket visualization |
| `/control` | control.html | PIN | Match controller (pipeline, timer, motif, scores) |
| `/red` | red.html | PIN | Red alliance scorer (touch-optimized tablet) |
| `/blue` | blue.html | PIN | Blue alliance scorer (touch-optimized tablet) |
| `/ref-red` | ref.html | PIN | Red field referee (minor/major fouls) |
| `/ref-blue` | ref-blue.html | PIN | Blue field referee (minor/major fouls) |
| `/headref` | headref.html | PIN | Head referee (all penalties, cards, commit/replay) |
| `/queue` | queue.html | PIN | Queue display (large-font, on-field/queued/upcoming) |
| `/admin` | admin.html | Password | Admin panel (teams, settings, schedule, reset) |
| `/docs` | docs.html | None | Project documentation (renders README.md live) |

### Default Credentials

| Role | PIN |
|------|-----|
| Red Scorer | 1001 |
| Blue Scorer | 1002 |
| Referee | 2001 |
| Queue | 2002 |
| Head Referee | 3001 |
| Match Controller | 3002 |
| Admin Password | ftcadmin |

---

## Database Schema

SQLite database stored at `scorekeeper.db` in project root. WAL journal mode, foreign keys enabled.

### `teams`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `number` | INTEGER | NOT NULL, UNIQUE |
| `name` | TEXT | NOT NULL, DEFAULT '' |

### `matches`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_number` | INTEGER | NOT NULL |
| `phase` | TEXT | NOT NULL, DEFAULT 'quals', CHECK IN ('quals','playoffs') |
| `red1` | INTEGER | REFERENCES teams(id) |
| `red2` | INTEGER | REFERENCES teams(id) |
| `blue1` | INTEGER | REFERENCES teams(id) |
| `blue2` | INTEGER | REFERENCES teams(id) |
| `state` | TEXT | NOT NULL, DEFAULT 'UPCOMING', CHECK IN ('UPCOMING','QUEUED','ON_FIELD','COMPLETED') |
| `motif` | TEXT | CHECK IN ('GPP','PGP','PPG'), nullable |

### `match_scores`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL, REFERENCES matches(id) |
| `alliance` | TEXT | NOT NULL, CHECK IN ('red','blue') |
| `auto_classified` | INTEGER | NOT NULL, DEFAULT 0 |
| `auto_overflow` | INTEGER | NOT NULL, DEFAULT 0 |
| `auto_leave` | INTEGER | NOT NULL, DEFAULT 0 |
| `auto_leave_r1` | INTEGER | NOT NULL, DEFAULT 0 |
| `auto_leave_r2` | INTEGER | NOT NULL, DEFAULT 0 |
| `auto_pattern` | INTEGER | NOT NULL, DEFAULT 0 |
| `pattern_balls` | TEXT | NOT NULL, DEFAULT '000000000' (9-char binary string) |
| `teleop_classified` | INTEGER | NOT NULL, DEFAULT 0 |
| `teleop_overflow` | INTEGER | NOT NULL, DEFAULT 0 |
| `teleop_balls` | INTEGER | NOT NULL, DEFAULT 0 |
| `yellow_cards` | TEXT | NOT NULL, DEFAULT '[]' (JSON array of team numbers) |
| `red_cards` | TEXT | NOT NULL, DEFAULT '[]' (JSON array of team numbers) |
| `committed` | INTEGER | NOT NULL, DEFAULT 0 |
| | | UNIQUE(match_id, alliance) |

### `endgame_cycles`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL, REFERENCES matches(id) |
| `alliance` | TEXT | NOT NULL, CHECK IN ('red','blue') |
| `cycle` | INTEGER | NOT NULL |
| `r1_park` | TEXT | NOT NULL, DEFAULT 'none', CHECK IN ('none','partial','full') |
| `r2_park` | TEXT | NOT NULL, DEFAULT 'none', CHECK IN ('none','partial','full') |
| | | UNIQUE(match_id, alliance, cycle) |

### `penalties`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL, REFERENCES matches(id) |
| `period_name` | TEXT | nullable |
| `match_time` | INTEGER | nullable |
| `alliance` | TEXT | NOT NULL, CHECK IN ('red','blue') |
| `team_number` | INTEGER | nullable |
| `type` | TEXT | NOT NULL, CHECK IN ('minor','major','yellow','red') |
| `created_at` | INTEGER | NOT NULL, DEFAULT unixepoch() |

### `score_audit`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL |
| `alliance` | TEXT | NOT NULL |
| `field` | TEXT | NOT NULL |
| `old_value` | TEXT | nullable |
| `new_value` | TEXT | nullable |
| `changed_by` | TEXT | nullable |
| `created_at` | INTEGER | NOT NULL, DEFAULT unixepoch() |

### `period_config`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `position` | INTEGER | NOT NULL |
| `name` | TEXT | NOT NULL |
| `duration` | INTEGER | NOT NULL (seconds) |
| `type` | TEXT | NOT NULL, CHECK IN ('AUTO','TRANSITION','TELEOP','ENDGAME','BUZZER','CUSTOM') |
| `group_id` | INTEGER | nullable |
| `group_repeats` | INTEGER | NOT NULL, DEFAULT 1 |

### `settings`

| Column | Type | Constraints |
|--------|------|-------------|
| `key` | TEXT | PRIMARY KEY |
| `value` | TEXT | NOT NULL |

### `alliance_selections`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `alliance_number` | INTEGER | NOT NULL, UNIQUE |
| `captain_team` | INTEGER | REFERENCES teams(id) |
| `partner_team` | INTEGER | REFERENCES teams(id) |

### `bracket_matches`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `bracket_round` | TEXT | NOT NULL |
| `bracket_slot` | INTEGER | NOT NULL |
| `red_alliance` | INTEGER | nullable |
| `blue_alliance` | INTEGER | nullable |
| `winner_alliance` | INTEGER | nullable |
| `match_id` | INTEGER | REFERENCES matches(id) |
| | | UNIQUE(bracket_round, bracket_slot) |

---

## Default Settings

### Point Values

| Setting | Default | Description |
|---------|---------|-------------|
| `pts_auto_classified` | 3 | Points per classified artifact in auto |
| `pts_auto_overflow` | 1 | Points per overflow artifact in auto |
| `pts_auto_leave` | 5 | Points per robot leaving start zone |
| `pts_auto_pattern` | 2 | Points for pattern completion |
| `pts_teleop_classified` | 3 | Points per classified artifact in teleop |
| `pts_teleop_overflow` | 1 | Points per overflow artifact in teleop |
| `pts_teleop_balls` | 1 | Points per ball scored in teleop |
| `pts_park_partial` | 5 | Points for partial park |
| `pts_park_full` | 10 | Points for full park |
| `pts_park_bonus` | 10 | Bonus when both robots full park |
| `pts_foul_minor` | 5 | Points awarded to opponent per minor foul |
| `pts_foul_major` | 15 | Points awarded to opponent per major foul |

### Ranking Point Thresholds

| Setting | Default | Description |
|---------|---------|-------------|
| `rp_win` | 4 | RP for winning a match |
| `rp_tie` | 2 | RP for a tied match |
| `rp_loss` | 0 | RP for losing a match |
| `rp_park_threshold_1` | 63 | Park score for 1 bonus RP |
| `rp_park_threshold_2` | 90 | Park score for 2 bonus RP |
| `rp_pattern_threshold_1` | 23 | Artifacts sorted for 1 bonus RP |
| `rp_pattern_threshold_2` | 33 | Artifacts sorted for 2 bonus RP |
| `rp_ball_threshold_1` | 210 | Balls scored for 1 bonus RP |
| `rp_ball_threshold_2` | 300 | Balls scored for 2 bonus RP |

### Default Period Structure

| Position | Name | Duration | Type | Group | Repeats |
|----------|------|----------|------|-------|---------|
| 1 | AUTO | 60s | AUTO | - | 1 |
| 2 | TRANSITION | 8s | TRANSITION | - | 1 |
| 3 | TELEOP | 110s | TELEOP | 1 | 5 |
| 4 | ENDGAME | 10s | ENDGAME | 1 | 5 |
| 5 | BUZZER | 10s | BUZZER | 1 | 5 |

Grouped periods (group_id=1) repeat together 5 times, producing: AUTO -> TRANSITION -> (TELEOP -> ENDGAME -> BUZZER) x5 = 17 periods, ~718 seconds total.

---

## Server-Side Functions

### `db.js` — Database & Helpers

#### `getDb() -> Database`
Returns a singleton better-sqlite3 database instance. On first call, opens `scorekeeper.db`, enables WAL mode and foreign keys, runs schema creation and seeds default settings/periods.

#### `getSettingsMap(db) -> Object`
Returns all settings as a `{ key: value }` map.

#### `getPointValues(db) -> Object`
Returns all `pts_*` settings with the prefix stripped and values parsed as floats. Example: `{ auto_classified: 3, auto_overflow: 1, ... }`.

#### `expandPeriods(rows) -> Object[]`
Expands `period_config` rows into a flat period sequence. Ungrouped periods appear once. Grouped periods (same `group_id`) repeat together `group_repeats` times. Returns `[{ name, duration, type, cycle }]` where `cycle` is `null` for ungrouped or `1..N` for grouped.

#### `ensureMatchScores(db, matchId) -> void`
Inserts (or ignores if existing) `match_scores` rows for both `'red'` and `'blue'` alliances.

#### `getFullScore(db, matchId, alliance) -> Object`
Computes the complete score for one alliance. Reads `match_scores`, `endgame_cycles`, and opponent penalties. Returns:

```javascript
{
  total,              // final score
  autoTotal,          // auto-period subtotal
  teleopTotal,        // teleop-period subtotal
  auto_classified,    // raw field values
  auto_overflow,
  auto_leave_r1,
  auto_leave_r2,
  auto_pattern,
  teleop_classified,
  teleop_overflow,
  teleop_balls,
  penalties,          // points from opponent fouls
  breakdown: {
    auto_classified, auto_overflow, auto_leave, auto_pattern,
    teleop_classified, teleop_overflow, teleop_balls,
    park_score, penalty_pts
  },
  raw,                // raw match_scores row
  cycles,             // endgame_cycles rows
  yellow_cards,       // parsed JSON array of team numbers
  red_cards           // parsed JSON array of team numbers
}
```

---

### `timer.js` — Match Timer State Machine

#### `class MatchTimer`

Owns a `setInterval` ticking once per second. Emits Socket.io events to all connected clients.

**Constructor:** `new MatchTimer(io: SocketIO.Server)`

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `matchId` | number\|null | Currently loaded match ID |
| `periods` | Object[] | Expanded flat period sequence |
| `periodIndex` | number | Current index into `periods` |
| `timeRemaining` | number | Seconds left in current period |
| `running` | boolean | True when timer is actively counting |
| `paused` | boolean | True when paused |
| `endgameCycle` | number | Current endgame cycle number |
| `matchEnded` | boolean | True after all periods complete |

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `load` | `(matchId, periods) -> void` | Resets state, stores match/periods, emits `match_loaded`. Does NOT start. |
| `currentPeriod` | `getter -> Object\|null` | Returns `periods[periodIndex]` |
| `getState` | `() -> Object` | Returns full timer state snapshot |
| `start` | `() -> boolean` | Starts interval, emits `match_start`. Returns false if invalid state. |
| `pause` | `() -> void` | Clears interval, emits `match_paused` |
| `resume` | `() -> void` | Restarts interval, emits `match_resumed` |
| `abort` | `() -> void` | Resets all state, emits `match_abort` |
| `manualAdvance` | `() -> void` | Force-advances to next period |

**Internal Methods:**

| Method | Description |
|--------|-------------|
| `_tick()` | Decrements `timeRemaining`, emits `timer_tick`. At 0, calls `_advancePeriod()` |
| `_advancePeriod()` | Moves to next period, updates `endgameCycle` for ENDGAME periods, emits `period_change` |
| `_endMatch()` | Sets `matchEnded=true`, emits `match_end`. Guarded against double-fire |

---

### `scoring.js` — Score Calculation & Rankings

#### `calculateScore(db, matchId, alliance) -> number`
Returns the total score for one alliance via `getFullScore().total`. Includes opponent penalty points.

#### `calculateParkScore(db, matchId, alliance) -> number`
Computes park-only score from `endgame_cycles` for RP threshold checking. Awards partial/full park points per robot per cycle, plus bonus when both robots achieve full park in the same cycle.

#### `calculateArtifactsSorted(db, matchId, alliance) -> number`
Returns `auto_classified + teleop_classified` for pattern RP threshold checking.

#### `calculateBallsScored(db, matchId, alliance) -> number`
Returns `teleop_balls` for ball RP threshold checking.

#### `calculateRP(db, matchId, alliance) -> number`
Calculates total ranking points earned by one alliance. Returns 0 if alliance has a red card (DQ). Otherwise sums:
- Win/Tie/Loss RP (4/2/0 default)
- Park RP (0/1/2 based on park score vs thresholds 63/90)
- Pattern RP (0/1/2 based on artifacts sorted vs thresholds 23/33)
- Ball RP (0/1/2 based on balls scored vs thresholds 210/300)

#### `computeLiveRP(db, matchId, alliance) -> Object`
Returns live RP breakdown for display overlay:
```javascript
{ winLossRp, parkRp, patternRp, ballRp, total }
```

#### `calculateOPR(db) -> Object`
Computes OPR (Offensive Power Rating) for all teams using least-squares over committed qualification matches. Builds the normal equations `A^T A · x = A^T b` where each alliance gives one equation `OPR(t1) + OPR(t2) = offensive_score` (penalty points excluded). Solves via Gauss-Jordan elimination with partial pivoting. Returns `{ teamId: opr }` map rounded to 1 decimal. Teams with insufficient data return 0.

#### `updateRankings(db, includeMatchId?) -> Object[]`
Builds full rankings from all completed (committed) matches. Calls `calculateOPR` and persists OPR values to `teams.opr` (only on the committed path, not when `includeMatchId` is provided). Sorts by RP descending, then average score, then high score. Returns:
```javascript
[{
  rank, teamId, teamNumber, teamName,
  rp, opr, avgScore, wins, losses, ties,
  highScore, matchesPlayed, rpBreakdown
}]
```

---

### `scheduler.js` — Schedule Generator

#### `generateSchedule(teams, matchesPerTeam) -> Object[]`
Generates a randomized balanced qualification schedule using the circle-method round-robin. Teams are shuffled before scheduling so each call produces a different result. Requires >= 4 teams. Total slots (`teams.length * matchesPerTeam`) must be divisible by 4. Balances red/blue alliance assignments.

Returns `[{ match_number, red1, red2, blue1, blue2 }]` where values are team IDs.

**Throws:** Error if fewer than 4 teams or total slots not divisible by 4.

---

### `bracket.js` — Playoff Bracket

#### `getAllianceCount(teamCount) -> 4|6|8`
Determines alliance count: >= 24 teams returns 8, >= 18 returns 6, otherwise 4.

#### `initBracket(db, allianceCount) -> void`
Clears existing `bracket_matches` and inserts pre-seeded double-elimination bracket slots.

**Bracket sizes:**
- **4 alliances:** 6 matches (WB-R1 x2, WB-Final, LB-R1, LB-Final, Grand-Final)
- **6 alliances:** 11 matches (includes WB-R2 byes)
- **8 alliances:** 15 matches (WB-R1 x4, WB-SF x2, WB-Final, LB-R1 x2, LB-R2 x2, LB-SF x2, LB-Final, Grand-Final)

Standard seedings: 1v8, 4v5, 2v7, 3v6 for 8-alliance.

#### `getBracket(db) -> Object[]`
Returns all `bracket_matches` rows joined with match state, ordered by ID.

#### `advanceBracket(db, bracketMatchId, winnerAlliance) -> void`
Records the winner of a bracket match.

---

## REST API Reference

### Authentication

| Method | Path | Body | Response | Description |
|--------|------|------|----------|-------------|
| POST | `/api/auth/pin` | `{ role, pin }` | `{ ok, role }` or 401 | Authenticate with role PIN |
| POST | `/api/auth/admin` | `{ password }` | `{ ok }` or 401 | Authenticate as admin |
| GET | `/api/auth/check?role=X` | — | `{ ok }` or 401 | Check current auth |
| POST | `/api/auth/logout` | — | `{ ok }` | Destroy session |

Roles: `red`, `blue`, `ref`, `headref`, `control`, `queue`. The `headref` role also satisfies `ref` checks.

### Teams

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/teams` | — | `Team[]` (ordered by number) |
| POST | `/api/teams` | `{ number, name }` | `{ id, number, name }` or 400 |
| PUT | `/api/teams/:id` | `{ number, name }` | `{ ok }` |
| DELETE | `/api/teams/:id` | — | `{ ok }` |
| POST | `/api/teams/import` | `[{ number, name }]` | `{ ok, count }` |

### Matches

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/matches` | query: `?phase=quals\|playoffs` | `Match[]` with team details |
| GET | `/api/matches/:id` | — | `Match` with team details |
| POST | `/api/matches/generate` | — | `{ ok, count }` |
| PUT | `/api/matches/:id/state` | `{ state }` | `{ ok }` |
| POST | `/api/matches/:id/load` | — | `{ ok, periods }` |
| POST | `/api/matches/:id/motif/randomize` | — | `{ ok, motif }` |
| PUT | `/api/matches/:id/motif` | `{ motif }` | `{ ok, motif }` |

### Scoring

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/matches/:id/scores` | — | `{ red: ScoreObj, blue: ScoreObj }` |
| GET | `/api/matches/:id/penalties` | — | `Penalty[]` |
| POST | `/api/matches/:id/commit` | — | `{ ok, rankings }` |
| POST | `/api/matches/:id/override` | `{ alliance, field, value, changedBy }` | `{ ok }` |
| POST | `/api/matches/:id/replay` | — | `{ ok }` |
| GET | `/api/matches/:id/audit` | — | `AuditEntry[]` |

**Override allowed fields:** `auto_classified`, `auto_overflow`, `auto_leave`, `auto_leave_r1`, `auto_leave_r2`, `auto_pattern`, `teleop_classified`, `teleop_overflow`, `teleop_balls`

### Settings & Periods

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/settings` | — | `{ key: value }` |
| PUT | `/api/settings` | `{ key: value, ... }` | `{ ok }` |
| GET | `/api/periods` | — | `PeriodConfig[]` |
| PUT | `/api/periods` | `[{ name, duration, type, group_id, group_repeats }]` | `{ ok }` |

### Rankings & Queue

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/rankings` | `Ranking[]` (sorted) |
| GET | `/api/queue` | `{ onField, queued, upcoming }` |

### Bracket & Alliances

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/bracket` | — | `BracketMatch[]` |
| POST | `/api/bracket/init` | — | `{ ok, allianceCount }` |
| POST | `/api/bracket/matches/:id/winner` | `{ winnerAlliance }` | `{ ok }` |
| GET | `/api/alliances` | — | Alliance rows with team details |
| POST | `/api/alliances` | `{ alliance_number, captain_team, partner_team }` | `{ ok }` |

### Timer Control

| Method | Path | Response |
|--------|------|----------|
| POST | `/api/timer/start` | Timer state |
| POST | `/api/timer/pause` | Timer state |
| POST | `/api/timer/resume` | Timer state |
| POST | `/api/timer/abort` | `{ ok }` |
| POST | `/api/timer/advance` | Timer state |
| GET | `/api/timer` | Timer state |

### Admin & Export

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/admin/reset` | `{ confirm: "RESET" }` | `{ ok }` |
| GET | `/api/export/rankings.csv` | — | CSV download |
| GET | `/api/export/schedule.csv` | — | CSV download |

---

## Socket.io Events

### Server -> Client

| Event | Payload | Trigger |
|-------|---------|---------|
| `timer_state` | `TimerState` | New client connection |
| `timer_tick` | `TimerState` | Every second while timer running |
| `period_change` | `TimerState` | Period advances |
| `match_start` | `TimerState` | Timer started |
| `match_paused` | `TimerState` | Timer paused |
| `match_resumed` | `TimerState` | Timer resumed |
| `match_end` | `{ matchId, state }` | All periods complete |
| `match_abort` | `{ matchId }` | Timer aborted |
| `match_loaded` | `{ matchId, period, timeRemaining }` | Match loaded into timer |
| `match_state_change` | `{ matchId, state, match }` | Match state updated via API |
| `score_update` | `{ matchId, red, blue, redRP, blueRP }` | Any score change |
| `penalty_added` | `{ matchId, penalty, all }` | Penalty recorded |
| `motif_update` | `{ matchId, motif }` | Motif set/randomized |
| `match_replay` | `{ matchId }` | Match reset for replay |
| `rankings_update` | `Ranking[]` | After score commit |
| `bracket_update` | `BracketMatch[]` | Bracket initialized or winner recorded |
| `queue_update` | `QueueState` | On connection, match state changes |
| `full_reset` | `{}` | Admin reset |

### Client -> Server

| Event | Payload | Description |
|-------|---------|-------------|
| `score_increment` | `{ matchId, alliance, field }` | +1 to a score field (validates period type) |
| `score_decrement` | `{ matchId, alliance, field }` | -1 to a score field (min 0, blocked during TRANSITION/BUZZER) |
| `score_set` | `{ matchId, alliance, field, value }` | Set boolean field (auto_leave_r1/r2, during AUTO/TRANSITION) |
| `pattern_ball` | `{ matchId, alliance, ballIdx, selected }` | Toggle pattern ball (index 0-8, TRANSITION only) |
| `park_update` | `{ matchId, alliance, robot, status }` | Set park status (none/partial/full, ENDGAME only) |
| `penalty` | `{ matchId, alliance, teamNumber, type }` | Record penalty (minor/major/yellow/red) |
| `add_yellow_card` | `{ matchId, alliance, teamNumber }` | Add yellow card |
| `add_red_card` | `{ matchId, alliance, teamNumber }` | Add red card |
| `remove_card` | `{ matchId, alliance, teamNumber, cardType }` | Remove a card |
| `timer_start` | — | Start timer |
| `timer_pause` | — | Pause timer |
| `timer_resume` | — | Resume timer |
| `timer_abort` | — | Abort timer |
| `timer_advance` | — | Force advance period |

---

## Client-Side Utilities (`common.js`)

All exposed on `window.SK`:

| Function | Signature | Description |
|----------|-----------|-------------|
| `SK.formatTime` | `(seconds) -> string` | Formats seconds as `M:SS` |
| `SK.mountPinPad` | `(role, label) -> Promise<boolean>` | Full-screen PIN pad overlay. Numeric 4-digit for roles, text input for admin. Checks existing auth first. |
| `SK.addLogoutButton` | `(container) -> void` | Adds logout button that POSTs to `/api/auth/logout` |
| `SK.connectSocket` | `() -> Socket\|null` | Returns Socket.io client or null |
| `SK.applyTimerState` | `(state, timerEl, periodEl) -> void` | Updates timer/period DOM elements from state. Adds `.endgame` class during ENDGAME periods and `.final` class after match end — both used by CSS to change timer color. |
| `SK.playBuzzer` | `() -> void` | Web Audio API buzzer (square wave, 440Hz -> 300Hz, 0.6s) |
| `window.showToast` | `(msg, type?, ms?) -> void` | Transient toast notification. Types: `'error'`, `'success'` |

---

## Internal Helper Functions (`server.js`)

#### `broadcastScores(matchId)`
Computes full scores for both alliances via `getFullScore`, computes live RP via `computeLiveRP`, attaches current-cycle park status (`park_r1`, `park_r2`) for scorer UIs, and emits `score_update` to all clients.

#### `matchWithTeams(match)`
Enriches a match row with team details (`red1_team`, `red2_team`, `blue1_team`, `blue2_team`) by looking up team IDs.

---

## Match Lifecycle

1. **Create teams** via admin panel or CSV import
2. **Generate schedule** — creates qualification matches with balanced alliances
3. **Queue matches** — advance through UPCOMING -> QUEUED -> ON_FIELD states
4. **Load match** into timer — creates score rows, sets motif
5. **Randomize motif** — assigns GPP/PGP/PPG pattern
6. **Start timer** — begins AUTO period, scorers can input scores
7. **Score in real-time** — scorers increment/decrement fields, referees log fouls
8. **Timer progresses** — AUTO -> TRANSITION -> (TELEOP -> ENDGAME -> BUZZER) x5
9. **Match ends** — timer completes all periods, display shows winner
10. **Head referee commits** — finalizes scores, updates rankings
11. **Playoffs** — alliance selection, bracket initialization, playoff matches

---

## Display Overlay (`display.html`)

Designed for 1920x1080 broadcast output with transparent background (chroma-key). Scales to viewport width via JS transform.

**Components:**
- Title bar (75px) — event name, match info, sponsor logos
- Score bar (180px) — alliance backgrounds with bright accent polygons, robot/foul pills, auto/teleop sub-pills with `/36` goal cell (changes color on RP threshold), team number cards, alliance label + total score, timer panel with motif artifact dots
- Motif reveal overlay — 6-second full-screen popup showing colored artifact images when motif is randomized
- Post-match banner — shows winner and final score

**RP Goal Cell:** The `/36` goal cell on each sub-pill changes color based on pattern RP progress:
- Default: alliance accent color (red/blue)
- Threshold 1 reached (23 artifacts sorted): green
- Threshold 2 reached (33 artifacts sorted): gold with dark text

---

## Page Summaries

### `index.html` — Landing Page
Styled grid of all available URLs organized into sections: Audience, Queue, Operators, Admin. Each card shows the URL path, title, description, and auth badge.

### `control.html` — Match Controller
Match pipeline showing up to 5 non-completed matches with state badges and action buttons. Motif card with randomize and manual pickers. Timer controls (Start/Pause/Resume/Advance/Abort) — button states are driven by the live timer state machine and update automatically on every socket event so operators always see which actions are valid. Live scores with pattern balls grid and per-category breakdowns. Post-match commit card. At viewports ≥ 1000 px, the layout switches to a 2-column grid (pipeline + timer + scores on the left, motif card spanning the right). Desktop-only; no mobile optimization applied.

### `red.html` / `blue.html` — Alliance Scorers
Full-screen touch-optimized tablet interface. Context-sensitive scoring controls based on current period: AUTO (Classified, Overflow, Leave Zone toggles), TRANSITION (9-ball pattern grid), TELEOP (Classified, Overflow, Balls), ENDGAME (Park status per robot), BUZZER (wait overlay). Score cards use `min-height: var(--tap)` (48 px) to ensure reliable tap targets under pressure. Timer and scores use `font-family: var(--font-display)` with `clamp()` sizing for legibility at all viewport widths. Alliance-colored headers use a dark gradient with `env(safe-area-inset-top)` padding for notch-safe layout on tablets.

### `ref.html` / `ref-blue.html` — Field Referees
Two large solid-filled foul buttons: Minor Foul (yellow fill, `var(--yellow)`) and Major Foul (red fill, `var(--red)`). Solid fills replace the previous outlined style so buttons are unambiguous under arena lighting. Shows compact timer and both alliance scores in the header. Foul buttons have `min-height: 110px` and use `var(--font-display)` for maximum legibility on handheld devices. Timer in header uses `clamp()` for fluid sizing. Alliance-specific gradient headers with `env(safe-area-inset-top)` for notch safety.

### `headref.html` — Head Referee
Full penalty grid with both alliances side by side. Minor Foul, Major Foul, Yellow Card, Red Card per alliance. Team picker modal for cards. Penalty log table. Post-match: Commit Scores and Mark for Replay. At viewports ≥ 900 px (tablet landscape and desktop), the layout switches to a 2-column grid: penalty buttons on the left spanning both rows, penalty log and post-match actions stacked on the right. Penalty buttons use `min-height: 68px` and display font for fast, accurate tapping. Safe-area insets applied at the bottom for tablet home-bar clearance.

### `queue.html` — Queue Display
Large-font display for queueing area. Three sections: On Field Now, Report to Queue Now (pulsing border), Upcoming (next 2 matches). Real-time Socket.io updates.

### `public.html` — Public/Student View
Mobile-first bottom-tab SPA. Three tabs: **Rankings** (default) shows a 9-column table with Rank, Team #, Name, RP, OPR, Avg Score, W/L/T. **Matches** shows On Deck (next 3 upcoming matches as cards) and Full Schedule (all matches with state chips). **Bracket** tab is hidden until playoff bracket data exists, then reveals automatically. All real-time via Socket.io (`rankings_update`, `queue_update`, `match_state_change`, `bracket_update`).

### `rankings.html` — Full Rankings
Detailed rankings with expandable per-match RP breakdown. Top 3 with gold/silver/bronze coloring. CSV export button. Live updates.

### `bracket.html` — Playoff Bracket
Horizontal scrolling bracket grouped by round. Match cards show alliance numbers, scores, winner badge. Live updates.

### `admin.html` — Admin Panel
8-tab interface: Teams (add/import/delete), Scoring Values (12 point values), Ranking Points (RP thresholds), Periods (CRUD with reorder), Schedule (generate/export), PINs (edit all credentials), Playoffs (bracket init, alliance selection), Reset (full wipe with confirmation).
