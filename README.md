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
public/js/qrcode.js  Vendored qrcode-generator (offline QR on results screen)
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

Ref and scorer views (`referee.html`, `red.html`, `blue.html`, `headref.html`) are designed mobile-first. The match controller (`control.html`) is desktop-only.

| Breakpoint | Applied to | Effect |
|------------|-----------|--------|
| `min-width: 900px` | `headref.html` | 2-column grid (penalty buttons left, log + actions right) |
| `min-width: 900px` | `referee.html` | 2-column grid (penalty buttons left, log right) |
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
| `/referee` | referee.html | PIN | Field referee — fouls and cards for both alliances |
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

### `sessions`

| Column | Type | Constraints |
|--------|------|-------------|
| `sid` | TEXT | PRIMARY KEY |
| `sess` | TEXT | NOT NULL — JSON-serialized session data |
| `expires` | INTEGER | NOT NULL — epoch ms |

Backs the login session store (see `session-store.js`) so PIN logins survive server restarts, not just page refreshes.

### `notes`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL, REFERENCES matches(id) |
| `alliance` | TEXT | CHECK IN ('red','blue'), nullable — null for a general (non-team-tagged) note |
| `team_number` | INTEGER | nullable — null for a general note |
| `note` | TEXT | NOT NULL |
| `author` | TEXT | NOT NULL, DEFAULT 'headref' — 'headref' or 'admin' |
| `created_at` | INTEGER | NOT NULL, DEFAULT unixepoch() |
| `updated_at` | INTEGER | NOT NULL, DEFAULT unixepoch() — bumped on edit |

Head Referee / Admin notes system (see `headref.html`'s Notes tab and `admin.html`'s Notes tab). Each note is tied to a match and optionally tagged to one team + alliance; untagged notes are "general" match notes. Searchable by team number or match number.

### `rp_overrides`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `match_id` | INTEGER | NOT NULL, REFERENCES matches(id) |
| `alliance` | TEXT | NOT NULL, CHECK IN ('red','blue') |
| `category` | TEXT | NOT NULL, CHECK IN ('win','park','pattern','ball') |
| `mode` | TEXT | NOT NULL, CHECK IN ('grant','exclude','override') |
| `value` | REAL | nullable — only used when `mode='override'` |
| `created_at` | INTEGER | NOT NULL, DEFAULT unixepoch() — bumped when the override is changed |
| | | UNIQUE(match_id, alliance, category) |

Head Referee RP Violations system (see `headref.html`'s "RP Violations" tab). At most one override per alliance/category/match — setting a new mode for the same category replaces it in place (same row `id`, upserted via `ON CONFLICT`). Three modes: **grant** (forces the category to its max — 2 for park/pattern/ball, `rp_win` for win/loss), **exclude** (forces it to 0, and the alliance cannot earn it back by playing better), **override** (forces it to an exact referee-supplied value, taking precedence over everything including a red-card DQ). Deleting the row (`DELETE /api/matches/:id/rp-overrides/:alliance/:category`) reverts that category to normal auto-calculation. See `scoring.js`'s `computeRpBreakdown()`.

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
| `rp_park_threshold_1` | 60 | Movement score (LEAVE + BASE points) for 1 bonus RP |
| `rp_park_threshold_2` | 85 | Movement score (LEAVE + BASE points) for 2 bonus RP |
| `rp_pattern_threshold_1` | 50 | Pattern points (matched artifacts × `pts_auto_pattern`) for 1 bonus RP |
| `rp_pattern_threshold_2` | 72 | Pattern points for 2 bonus RP |
| `rp_ball_threshold_1` | 210 | Goal artifacts (classified + overflow, auto + teleop) for 1 bonus RP |
| `rp_ball_threshold_2` | 300 | Goal artifacts for 2 bonus RP |

Thresholds and formulas above match the SEC Game Manual's Movement RP / Pattern RP / Goal RP definitions. On upgrade, `db.js` migrates any database still holding the old defaults (63/90/23/33) to the new ones (60/85/50/72) — a value an admin deliberately customized to something else is left untouched.

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

#### `isAllianceRedCarded(db, matchId, alliance) -> boolean`
True when an alliance has **any** red card recorded in `match_scores.red_cards` for this match (any one team is enough — per the SEC Game Manual, a single confirmed red card ends the match immediately, unlike the earlier full-alliance-DQ rule). Used by `server.js` to force an early match end and by `computeRpBreakdown` to auto-grant the opposing alliance's full RP.

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
| `scoresRevealed` | boolean | True once scores have been revealed after match end |

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
| `forceEnd` | `() -> boolean` | Ends the match immediately, the same way a normal period runout would (`matchEnded=true`, emits `match_end`, scores stand as-is for review/commit) — unlike `abort()`, does not discard state. Used when any team receives a red card (per the SEC Game Manual). Returns false if no match loaded or already ended. |
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
Computes park-only (BASE) score from `endgame_cycles`. Awards partial/full park points per robot per cycle, plus bonus when both robots achieve full park in the same cycle. Used as half of Movement RP (see `calculateLeaveScore` below).

#### `calculateLeaveScore(db, matchId, alliance) -> number`
Returns AUTO LEAVE points (`auto_leave_r1 + auto_leave_r2` count × `pts_auto_leave`). Added to `calculateParkScore` to form the "Movement RP" threshold quantity — the SEC Game Manual defines Movement RP as **combined LEAVE + BASE points**, not BASE alone.

#### `calculatePatternPoints(db, matchId, alliance) -> number`
Returns PATTERN points: `(auto_pattern + teleop_pattern)` matched-artifact count × `pts_auto_pattern` (2 by default). Used for Pattern RP threshold checking (50/72 points, per the SEC Game Manual).

#### `calculateGoalArtifacts(db, matchId, alliance) -> number`
Returns the number of ARTIFACTS scored through the goal: `auto_classified + auto_overflow + teleop_classified + teleop_overflow`. Used for Goal RP threshold checking (210/300 artifacts, per the SEC Game Manual).

#### `getRpOverrides(db, matchId, alliance) -> Object`
Returns active Head Referee RP overrides for one alliance, keyed by category (`win`/`park`/`pattern`/`ball`) — each value is the raw `rp_overrides` row, or absent if no override is set for that category. Backs the RP Violations tab in `headref.html` and the `/api/matches/:id/rp-overrides` endpoints.

#### `applyRpOverride(override, computedValue, maxValue) -> number`
Resolves one category's effective RP: no override → `computedValue` unchanged; `grant` → `maxValue`; `exclude` → 0; `override` → the referee's exact `value`.

#### `computeRpBreakdown(db, matchId, alliance) -> Object`
Shared implementation behind `calculateRP` and `computeLiveRP`. Computes each RP category from game state (all four categories zeroed if the alliance has a red card / DQ), then applies any `rp_overrides` on top — so an `override` can restore RP even for a DQ'd alliance, since overrides are resolved after the DQ zeroing. Per the SEC Game Manual, if the *opponent* has any red card (`isAllianceRedCarded`), this alliance is awarded the maximum of every RP category (Win RP = `rp_win`, Park/Pattern/Ball RP = 2 each) regardless of the raw score comparison — a single confirmed red card ends the match for everyone, not just a full-alliance DQ. Returns:
```javascript
{ winLossRp, parkRp, patternRp, ballRp, total, overrides }
```

#### `calculateRP(db, matchId, alliance) -> number`
Calculates total ranking points earned by one alliance — `computeRpBreakdown(...).total`. Auto-calculated categories (absent any override or opponent red card):
- Win/Tie/Loss RP (4/2/0 default)
- Movement RP — "park" category (0/1/2 based on LEAVE + BASE points vs thresholds 60/85)
- Pattern RP (0/1/2 based on PATTERN points vs thresholds 50/72)
- Goal RP — "ball" category (0/1/2 based on goal artifact count vs thresholds 210/300)

#### `computeLiveRP(db, matchId, alliance) -> Object`
Returns live RP breakdown for display overlay and the RP Violations tab — same shape as `computeRpBreakdown`.

#### `calculateOPR(db) -> Object`
Computes OPR (Offensive Power Rating) for all teams using least-squares over committed qualification matches. Builds the normal equations `A^T A · x = A^T b` where each alliance gives one equation `OPR(t1) + OPR(t2) = offensive_score` (penalty points excluded). Solves via Gauss-Jordan elimination with partial pivoting. Returns `{ teamId: opr }` map rounded to 1 decimal. Teams with insufficient data return 0.

#### `updateRankings(db, includeMatchId?) -> Object[]`
Builds full rankings from committed matches. When `includeMatchId` is provided, that match's current (potentially uncommitted) scores are included in the calculation, producing **provisional rankings** — this is used to show rank movement on the Match Results screen before the head referee commits. OPR is only persisted to `teams.opr` on the committed path (i.e. when `includeMatchId` is not provided). Sorts by RP descending, then average score, then high score. Returns:
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

#### `getAllianceRoster(db, allianceNumber) -> Object|null`
Resolves an alliance number to its captain/partner team ids and numbers via `alliance_selections` (joined with `teams`). Returns `null` if the alliance has no selection saved yet.

#### `formatAllianceLabel(allianceNumber, roster) -> string|null`
Formats a display label for an alliance, e.g. `"A3 (500, 600)"` if a roster is known, or `"Alliance 3"` if not. Returns `null` if `allianceNumber` is `null` (slot not yet filled).

#### `getBracket(db) -> Object[]`
Returns all `bracket_matches` rows (ordered by `bm.id`, which already matches the chronological round sequence each `bracketN()` slot list was built in — callers should preserve this order rather than re-sorting by round-name text, since names like `WB-Final`/`LB-SF`/`Grand-Final` have no digits to sort by) joined with match state. Each row includes both the raw snake_case fields (`red_alliance`, `blue_alliance`, `winner_alliance`, `bracket_round` — used by the admin bracket-management UI and `public.html`) and display-ready camelCase fields (`redAlliance`, `blueAlliance`, `matchNumber`, `redScore`, `blueScore`, `winner` — used by `bracket.html`), the latter built from `getAllianceRoster`/`formatAllianceLabel` and `getFullScore`.

#### `advanceBracket(db, bracketMatchId, winnerAlliance) -> void`
Records the winner of a bracket match (`winner_alliance` column only). **Does not auto-advance** the winner/loser into the next round's slot — see `POST /api/bracket/matches/:id/assign` below, which the admin "Bracket Matches" UI uses to route a recorded winner/loser into the next round's red/blue slot. This is deliberate: the exact winners/losers-bracket topology differs across 4/6/8-alliance formats, and is guided by the admin (following the printed bracket) rather than a hard-coded graph, to avoid silently mis-routing a live elimination bracket.

---

### `session-store.js` — Persistent Login Sessions

#### `class SqliteSessionStore extends express-session.Store`
Backs `express-session` with the `sessions` table instead of the default in-memory store, so logged-in PIN sessions survive a server restart (not just page refreshes/backgrounding, which the cookie's `maxAge` + `rolling` already handle). Expired rows are swept on startup.

- `get(sid, cb)` — loads and JSON-parses the session, treating expired rows as missing.
- `set(sid, sess, cb)` — upserts the session row, deriving `expires` from `sess.cookie.expires`.
- `destroy(sid, cb)` — deletes the row (used on logout).
- `touch(sid, sess, cb)` — same as `set`, used by `rolling: true` to extend expiry on activity.

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
| POST | `/api/matches/:id/commit` | — | `{ ok, rankings }` — if this match is linked to a `bracket_matches` row (a playoff match), also auto-records the bracket winner (`recordBracketWinnerIfLinked`, comparing `getFullScore` totals; ties are left unrecorded for manual resolution via `/winner`) and broadcasts `bracket_update` |
| POST | `/api/matches/:id/override` | `{ alliance, field, value, changedBy }` | `{ ok }` or 400 |
| POST | `/api/matches/:id/replay` | — | `{ ok }` |
| GET | `/api/matches/:id/audit` | — | `AuditEntry[]` |
| POST | `/api/matches/:id/reveal` | — | `{ ok }` or 409 | Reveals final scores: triggers winner animation + Match Results screen on `/display`. Returns 409 if no match is loaded, match has not ended, or scores were already revealed. |
| GET | `/api/matches/:id/results` | — | Results payload or 404 | Returns the full post-match results payload (scores, category breakdown, RPs, provisional rank movement). 404 if the match does not exist. |

**Override allowed fields:** `auto_classified`, `auto_overflow`, `auto_leave`, `auto_leave_r1`, `auto_leave_r2`, `auto_pattern`, `teleop_classified`, `teleop_overflow`, `teleop_balls`, `teleop_pattern`, `yellow_cards`, `red_cards`

The `value` field is a number for all numeric fields, or a JSON array of team numbers for `yellow_cards` / `red_cards` (400 returned otherwise). When overriding a committed match, rankings are automatically re-calculated and a `rankings_update` event is emitted.

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
| GET | `/api/network-info` | `{ port, urls: string[] }` — this machine's LAN IPv4 addresses (from `os.networkInterfaces()`), formatted as full `http://ip:port` URLs. Backs the "Access" tab's QR code in `admin.html`; empty `urls` means no non-internal IPv4 interface was found (e.g. offline machine). |

### Bracket & Alliances

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/bracket` | — | `BracketMatch[]` (see `getBracket` — enriched with resolved alliance rosters/labels and scores) |
| POST | `/api/bracket/init` | — | `{ ok, allianceCount }` |
| POST | `/api/bracket/matches/:id/winner` | `{ winnerAlliance }` | `{ ok }` — manual winner fallback for a tied/edge-case match; broadcasts `bracket_update` |
| POST | `/api/bracket/matches/:id/assign` | `{ side: 'red'\|'blue', allianceNumber }` | `{ ok }` — sets that bracket slot's red/blue alliance (used to route a recorded winner/loser into the next round); broadcasts `bracket_update` |
| POST | `/api/bracket/matches/:id/create-match` | — | `{ ok, matchId }` — creates a playoff `matches` row (phase `'playoffs'`) for a bracket slot once both red/blue alliances are assigned; idempotent (returns the existing `match_id` if already linked); resolves team ids via `getAllianceRoster`; match number is `MAX(match_number WHERE phase='playoffs') + 1`; broadcasts `bracket_update` and `queue_update` so the new match appears in `control.html`'s pipeline like any other match |
| GET | `/api/alliances` | — | Alliance rows with team details |
| POST | `/api/alliances` | `{ alliance_number, captainNumber, partnerNumber }` | `{ ok }` — `captainNumber`/`partnerNumber` are team **numbers** (not internal ids); resolved to `teams.id` server-side and upserted via `ON CONFLICT(alliance_number)` |

### Timer Control

| Method | Path | Response |
|--------|------|----------|
| POST | `/api/timer/start` | Timer state |
| POST | `/api/timer/pause` | Timer state |
| POST | `/api/timer/resume` | Timer state |
| POST | `/api/timer/abort` | `{ ok }` |
| POST | `/api/timer/advance` | Timer state |
| GET | `/api/timer` | Timer state |

### Notes

| Method | Path | Body / Query | Response |
|--------|------|------|----------|
| GET | `/api/notes` | `?team=<number>` or `?match=<match_number>` (optional filters) | `Note[]`, newest first, each joined with `match_number`/`phase` |
| POST | `/api/notes` | `{ matchId, alliance?, teamNumber?, note, author? }` | `{ ok, note }` — broadcasts `note_added` |
| PUT | `/api/notes/:id` | `{ note?, alliance?, teamNumber? }` | `{ ok, note }` — broadcasts `note_updated` |
| DELETE | `/api/notes/:id` | — | `{ ok }` — broadcasts `note_removed` |

`alliance`/`teamNumber` are omitted (null) for a general, non-team-tagged note.

### RP Overrides

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/matches/:id/rp-overrides` | — | `{ red: {...}, blue: {...} }`, each keyed by category |
| PUT | `/api/matches/:id/rp-overrides` | `{ alliance, category, mode, value? }` | `{ ok, overrides }` — broadcasts `rp_override_changed` and re-broadcasts `score_update` |
| DELETE | `/api/matches/:id/rp-overrides/:alliance/:category` | — | `{ ok, overrides }` — broadcasts `rp_override_changed` and re-broadcasts `score_update` |

`category` is one of `win`/`park`/`pattern`/`ball`. `mode` is one of `grant`/`exclude`/`override`; `value` is required (and only used) when `mode='override'`.

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
| `match_end` | `{ matchId, state }` | All periods complete, or the match was force-ended early (`timer.forceEnd()`) because a team received a red card |
| `match_abort` | `{ matchId }` | Timer aborted |
| `match_loaded` | `{ matchId, period, timeRemaining }` | Match loaded into timer |
| `match_state_change` | `{ matchId, state, match }` | Match state updated via API |
| `score_update` | `{ matchId, red, blue, redRP, blueRP }` | Any score change |
| `scores_reveal` | Full results payload (scores, category breakdown, RPs, provisional rank movement) | Controller clicks "Show Scores on Display" |
| `penalty_added` | `{ matchId, penalty, all }` | Penalty recorded |
| `penalty_removed` | `{ matchId, removedId, all }` | Penalty removed |
| `note_added` | Note row (with `match_number`, `phase` joined in) | Note created via `POST /api/notes` |
| `note_updated` | Note row | Note edited via `PUT /api/notes/:id` |
| `note_removed` | `{ id }` | Note deleted via `DELETE /api/notes/:id` |
| `rp_override_changed` | `{ matchId, overrides: { red, blue } }` | RP override set or cleared |
| `motif_update` | `{ matchId, motif }` | Motif set/randomized |
| `match_replay` | `{ matchId }` | Match reset for replay |
| `rankings_update` | `Ranking[]` | After score commit |
| `bracket_update` | `BracketMatch[]` | Bracket initialized or winner recorded |
| `queue_update` | `QueueState` | On connection, match state changes |
| `full_reset` | `{}` | Admin reset |

### Client -> Server

| Event | Payload | Description |
|-------|---------|-------------|
| `score_increment` | `{ matchId, alliance, field }` | +1 to a score field. Classified/Overflow (`auto_classified`, `auto_overflow`, `teleop_classified`, `teleop_overflow`) work in any period — including TRANSITION/BUZZER — as long as the match is running or in post-match review; other fields still validate period type |
| `score_decrement` | `{ matchId, alliance, field }` | -1 to a score field (min 0). Same always-on behavior as `score_increment` for Classified/Overflow |
| `score_set` | `{ matchId, alliance, field, value }` | Set boolean field (auto_leave_r1/r2, during AUTO/TRANSITION) |
| `pattern_ball` | `{ matchId, alliance, ballIdx, selected }` | Toggle pattern ball (index 0-8, TRANSITION only) |
| `park_update` | `{ matchId, alliance, robot, status }` | Set park status (none/partial/full) for the current endgame cycle (`timer.endgameCycle`). Accepted during TELEOP, ENDGAME, or BUZZER (or after match end, for review corrections) — so a park call can still be entered/corrected in the TELEOP period that follows a BUZZER, right up until the next ENDGAME starts a new cycle. Not gated on pause/running state either (a paused timer used to silently block Park View taps; the server still enforces valid game periods) |
| `penalty` | `{ matchId, alliance, teamNumber, type }` | Record penalty (minor/major/yellow/red). For yellow/red, also syncs `match_scores.yellow_cards`/`red_cards` for that team (via `addCardToMatchScores`) — this is what `isAllianceRedCarded`/RP-DQ logic actually reads. Per the SEC Game Manual, any red card force-ends the match immediately (`timer.forceEnd()`) and the opponent is auto-awarded every RP category. |
| `remove_penalty` | `{ matchId, alliance, type, teamNumber }` | Remove the most recent matching penalty; `teamNumber` targets a specific team's card (yellow/red), omitted for fouls. For yellow/red, also removes that team from `match_scores.yellow_cards`/`red_cards` (via `removeCardFromMatchScores`). Does not un-end an already force-ended match. |
| `add_yellow_card` | `{ matchId, alliance, teamNumber }` | Legacy direct-card event (current UI issues cards via `penalty` above) — adds yellow card to `match_scores` |
| `add_red_card` | `{ matchId, alliance, teamNumber }` | Legacy direct-card event — adds red card to `match_scores`; also triggers a full-alliance-DQ force-end check like `penalty` does |
| `remove_card` | `{ matchId, alliance, teamNumber, cardType }` | Legacy direct-card event — removes a card from `match_scores` |
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
4. **Load match** into timer — creates score rows
5. **Randomize motif** — assigns GPP/PGP/PPG pattern
5. **Start timer** — begins AUTO period, scorers can input scores
7. **Score in real-time** — scorers increment/decrement fields, referees log fouls
8. **Timer progresses** — AUTO -> TRANSITION -> (TELEOP -> ENDGAME -> BUZZER) x5
9. **Match ends** — timer completes all periods (or ends early — see below); display shows "UNDER REVIEW" banner with frozen scores; scorer and referee pages stay fully editable so corrections can be made
10. **Review phase** — refs and scorers may still adjust scores, fouls, and cards; display does not update
11. **Controller reveals scores** — clicks "Show Scores on Display" in the Post-Match card; display plays a pyramid winner animation (~4.4 s) then transitions to the broadcast-style Match Results screen
12. **Head referee commits** — finalizes scores, updates official rankings; results screen rank pills refresh live
13. **Playoffs** — alliance selection (admin's Playoffs tab, `POST /api/alliances`), bracket initialization (`POST /api/bracket/init`), then per bracket slot: assign red/blue alliances (`.../assign`) once both are known (either seeded or a routed prior winner/loser), create the playoff match (`.../create-match`, which drops it into the normal match pipeline — queue/load/score/commit like any qualification match), and on commit the winner is automatically recorded onto the bracket slot and can be manually routed into the next round's slot via `.../assign` again. Bracket auto-advancement graphs are **not** hard-coded for 6/8-alliance formats — the admin routes winners/losers manually via the "Winner of X"/"Loser of X" dropdown options (see `admin.html`'s Bracket Matches UI above), since the exact topology varies and a wrong hard-coded graph risks silently mis-routing a live elimination bracket.

**Early match end (red card):** per the SEC Game Manual, if any team receives a red card mid-match, the match ends immediately (`timer.forceEnd()`) the same way a normal period runout would — it does not discard state like Abort does. The carded alliance's RP is entirely zeroed; the opposing alliance automatically receives the maximum of every RP category (Win/Movement/Pattern/Goal) regardless of the raw score comparison. See `isAllianceRedCarded` in `db.js` and `computeRpBreakdown` in `scoring.js`.

---

## Display Overlay (`display.html`)

Designed for 1920x1080 broadcast output with transparent background (chroma-key). Scales to viewport width via JS transform.

**Components:**
- Title bar (75px) — event name, match info, sponsor logos
- Score bar (180px) — alliance backgrounds with bright accent polygons, robot/foul pills, auto/teleop sub-pills with `/36` goal cell (changes color on RP threshold), team number cards, alliance label + total score, timer panel with motif artifact dots
- Motif reveal overlay — 6-second full-screen popup showing colored artifact images when motif is randomized
- Post-match banner — shows winner and final score
- **Review freeze** — after `match_end`, the display enters a "UNDER REVIEW" state: scores are frozen and the banner is replaced by a review indicator. Score updates from scorer/ref edits are not reflected on the display during this phase.
- **Winner animation** — triggered by `scores_reveal`; a pyramid graphic rises from the bottom (~4.4 s) identifying the winning alliance before transitioning to the results screen.
- **Match Results screen** — broadcast-style overlay showing: match header (Qualification N of M, winning alliance), six category rows (LEAVE, ARTIFACT, PATTERN, BALLS, BASE, FOUL) with red and blue values side by side, team rank pills with provisional rank-movement arrows (up/down/neutral), RP icon rows (win, park, pattern, ball), and a QR code linking to `/public`. The screen live-updates on `score_update` and `rankings_update` events after commit, allowing corrections to be reflected immediately. It dismisses automatically when a new match is loaded (`match_loaded`) or the timer is aborted. On page reload while scores are revealed, the screen is restored from `GET /api/matches/:id/results`.

**RP Goal Cell:** The `/36` goal cell on each sub-pill changes color based on pattern RP progress:
- Default: alliance accent color (red/blue)
- Threshold 1 reached (23 artifacts sorted): green
- Threshold 2 reached (33 artifacts sorted): gold with dark text

---

## Page Summaries

### `index.html` — Landing Page
Styled grid of all available URLs organized into sections: Audience, Queue, Operators, Admin. Each card shows the URL path, title, description, and auth badge.

### `control.html` — Match Controller
Match pipeline showing up to 5 non-completed matches with state badges and action buttons. Motif card with randomize and manual pickers. Timer controls (Start/Pause/Resume/Advance/Abort) — button states are driven by the live timer state machine and update automatically on every socket event so operators always see which actions are valid. Live scores with pattern balls grid and per-category breakdowns. Post-match card with **Show Scores on Display** (triggers `POST /reveal` — winner animation + results screen on `/display`; button hides once revealed, refresh-safe) and **Commit Scores**. A collapsible **Match History** drawer lists completed matches and opens an inline editor for every score field plus yellow/red cards — saves go through `/override` and rankings recalculate automatically. At viewports ≥ 1000 px, the layout switches to a 2-column grid (pipeline + timer + scores on the left, motif card spanning the right). Desktop-only; no mobile optimization applied.

### `red.html` / `blue.html` — Alliance Scorers
Full-screen touch-optimized tablet interface. Context-sensitive scoring controls based on current period: AUTO (Classified, Overflow, Leave Zone toggles), TRANSITION (9-ball pattern grid), TELEOP (Classified, Overflow, Balls), ENDGAME (Park status per robot), BUZZER (wait overlay). Score cards use `min-height: var(--tap)` (48 px) to ensure reliable tap targets under pressure. Timer and scores use `font-family: var(--font-display)` with `clamp()` sizing for legibility at all viewport widths. Alliance-colored headers use a dark gradient with `env(safe-area-inset-top)` padding for notch-safe layout on tablets. After match end the page enters **review mode**: a yellow REVIEW badge appears and scoring stays fully editable (server accepts corrections) until the controller reveals the scores, at which point the "Match Over" overlay locks the page.

### `referee.html` — Field Referee
Single field-referee view covering both alliances (replaces the old separate Red/Blue field referee pages). Same penalty grid as `headref.html` — Minor Foul, Major Foul, Yellow Card, Red Card per alliance, each paired 50/50 with a "−" button to remove the most recent matching entry (cards reopen the team picker in "remove" mode so a specific team's card can be revoked). Team picker modal for cards. Penalty log table (Time, Logged, Type, Team, Alliance — "Logged" shows the local wall-clock time-of-day the penalty was recorded, alongside the existing in-match elapsed time), no post-match actions (those stay head-referee-only). At viewports ≥ 900 px the layout switches to a 2-column grid: penalty buttons on the left, penalty log on the right. Logs in under the `ref` PIN role.

### `headref.html` — Head Referee
Full penalty grid with both alliances side by side. Minor Foul, Major Foul, Yellow Card, Red Card per alliance. Team picker modal for cards. Penalty log table (Time, Logged, Type, Team, Alliance — "Logged" shows the local wall-clock time-of-day the penalty was recorded, alongside the existing in-match elapsed time). Post-match: Commit Scores and Mark for Replay. At viewports ≥ 900 px (tablet landscape and desktop), the layout switches to a 2-column grid: penalty buttons on the left spanning both rows, penalty log and post-match actions stacked on the right. Penalty buttons use `min-height: 68px` and display font for fast, accurate tapping. Safe-area insets applied at the bottom for tablet home-bar clearance. During post-match review a REVIEW badge shows and all penalty/card buttons remain active until scores are revealed.

A **Penalties / Notes / RP Violations** tab bar switches the whole view between the penalty grid, a Notes panel, and an RP Violations panel (no page navigation, socket connection stays alive). The Notes panel has: an Add Note form showing the currently-loaded match's teams, a team picker (General + one button per team on each alliance) to tag the note, a text area, and an Add button (disabled until a match is loaded); a search box filtering by team number or match number; and an **All Notes** browser that lists every match (Q1, Q2, … / P1, P2, …) with its note count — tapping a match drills into a detail view showing only that match's notes (newest first) with inline Edit/Delete and a "← All matches" back button. **The match detail view also has its own mini add-note form** (team picker + text area, scoped to that match's own teams), so the head referee can add a note to a prior match or a team that played in it, not just the currently active match. Notes are shared in real time with `admin.html`'s Notes tab and any other open Head Referee tablet via `note_added`/`note_updated`/`note_removed` socket events. See the `notes` table and `/api/notes` endpoints above.

**RP Violations tab:** shows all four RP categories (Win/Loss, Park, Pattern, Ball) for both alliances against the currently-loaded match, each with its live-calculated current value and three actions — **Grant** (forces the category to its max), **Exclude** (forces it to 0 for the rest of the match, can't be earned back), and **Override** (opens an inline numeric input to force an exact value, taking precedence over everything, including a red-card DQ). An active override shows a colored badge (green GRANT / red EXCLUDE / yellow OVERRIDE: n) and a Clear button to revert to normal auto-calculation. Changes take effect immediately in the live score (`score_update`) and are synced across every open Head Referee tablet via `rp_override_changed`. See the `rp_overrides` table, `/api/matches/:id/rp-overrides` endpoints, and `scoring.js`'s `computeRpBreakdown()` above.

### `queue.html` — Queue Display
Large-font display for queueing area. Three sections: On Field Now, Report to Queue Now (pulsing border), Upcoming (next 2 matches). Real-time Socket.io updates.

### `public.html` — Public/Student View
Mobile-first bottom-tab SPA. Three tabs: **Rankings** (default) shows a 9-column table with Rank, Team #, Name, RP, OPR, Avg Score, W/L/T. **Matches** shows On Deck (next 3 upcoming matches as cards) and Full Schedule (all matches with state chips). **Bracket** tab is hidden until playoff bracket data exists, then reveals automatically. All real-time via Socket.io (`rankings_update`, `queue_update`, `match_state_change`, `bracket_update`).

### `rankings.html` — Full Rankings
Detailed rankings with expandable per-match RP breakdown. Top 3 with gold/silver/bronze coloring. CSV export button. Live updates.

### `bracket.html` — Playoff Bracket
Horizontal scrolling bracket grouped by round, in chronological slot order (rounds appear in first-seen order from `getBracket()`'s row order, not re-sorted by round-name text — round labels like `WB-Final`/`Grand-Final` have no digits to sort by). Match cards show resolved alliance labels (e.g. `A3 (500, 600)`) once a roster is known, scores, and a winner badge. Live updates via `bracket_update`.

### `admin.html` — Admin Panel
10-tab interface: Teams (add/import/delete), Scoring Values (12 point values), Ranking Points (RP thresholds), Periods (CRUD with reorder), Schedule (generate/export), Matches (score/penalty overrides), PINs (edit all credentials), Playoffs, Notes, Access, Reset (full wipe with confirmation).

**Access tab:** a "Scan to Join" QR code, generated client-side with the same `/js/qrcode.js` library `display.html` uses (no external service — works fully offline on the local network). Fetches `GET /api/network-info` and encodes the first detected LAN URL, so refs/organizers can scan it with a phone to land on `/` and pick their role. Falls back to `location.origin` if no LAN interface is detected, and lists every detected URL as text below the code.

**Playoffs tab:** Alliance Selection — one row per alliance (row count follows `getAllianceCount(teamCount)`, refreshed whenever team data loads), each with captain/partner team-number inputs saved via `POST /api/alliances`. **Bracket Matches** — one row per `bracket_matches` slot, showing its round/slot label; red/blue `<select>` dropdowns offer the base seed numbers plus a "Winner of X" / "Loser of X" option for every bracket match that already has a recorded winner (so a slot can be filled without the admin needing to know the official topology by heart) — selecting one calls `POST /api/bracket/matches/:id/assign` and then locks (the select is disabled once the slot's match has been created). Once both sides are assigned, a **Create Match** button calls `POST /api/bracket/matches/:id/create-match`, after which the row shows the match info and a winner badge once committed (or, if the match is `COMPLETED` with no recorded winner — a tie — manual **Set RED/BLUE winner** buttons calling `/winner` as a fallback). Live updates via `bracket_update`.

**Notes tab:** full add/search/edit/delete access to the same notes system as `headref.html`'s Notes tab (same match-list-then-detail browser), kept live-synced via Socket.io. Unlike the head-ref view (which always targets the currently-loaded match), admin has a match picker dropdown (any qualification/playoff match) since there's no "current match" context here — selecting a match repopulates the team picker (General + that match's 4 teams) for the Add Note form.
