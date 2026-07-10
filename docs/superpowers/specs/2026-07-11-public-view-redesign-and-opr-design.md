# Public View Redesign & OPR Integration — Design Spec

**Goal:** Replace the single-page public view with a tabbed mobile-first layout (Rankings / Matches / Bracket), and add OPR as a computed, stored metric surfaced in the rankings and admin teams table.

**Architecture:** Single HTML file with a fixed bottom tab bar; panels swap visibility via CSS class. OPR computed via Gaussian elimination least-squares after each match commit, stored on the `teams` table, and exposed through existing API endpoints.

**Tech Stack:** Node.js, Express, Socket.io, SQLite (better-sqlite3), vanilla JS — no new dependencies.

---

## 1. Layout & Navigation

`public/public.html` is rewritten as a single-page app with a bottom tab bar fixed to the viewport bottom.

- **Default tab on load:** Rankings
- **Tab count:** 2 always visible (Rankings, Matches); Bracket tab appears only when `GET /api/bracket` returns at least one match
- Tab switching swaps a CSS `active` class between content panels — no page reload, no fetch on every tab switch (data is loaded once and kept live via socket events)
- On `bracket_update` socket event: re-check bracket existence and show/hide the Bracket tab accordingly

### Tab bar structure
```
[ Rankings ]  [ Matches ]  [ Bracket* ]
     *only when bracket exists
```

### What is removed
- Live match section (timer + live scores) — dropped entirely
- Standalone "Upcoming" section — folded into the Matches tab

---

## 2. Rankings Tab

- Default active tab
- Full-width rankings table, columns: **Rank, Team #, Name, RP, OPR, Avg Score, W, L, T**
- Stays live via `rankings_update` socket events (re-renders table on each event)
- Empty state: "No rankings yet"

---

## 3. Matches Tab

Two sub-sections in vertical flow (no accordion, no separator):

### On Deck
- Shows next 3 UPCOMING or QUEUED matches
- Each displayed as a card: match number + red team chips + "vs" + blue team chips
- Large enough to scan at a glance on a phone
- Updates on `queue_update` socket event

### Full Schedule
- All matches in order
- Compact rows: match number, red teams, blue teams, result chip (Complete / Live / —)
- Completed matches show winner if available
- Updates on `queue_update` and `match_state_change` socket events

---

## 4. Bracket Tab (Conditional)

- Hidden by default; appears when `GET /api/bracket` returns ≥1 match
- Horizontal-scroll layout of bracket rounds (same as current implementation)
- Updates on `bracket_update` socket event
- If bracket is cleared, tab hides itself again

---

## 5. OPR Calculation

### Algorithm
OPR uses a least-squares solve over all committed match scores.

For each match, two equations:
```
OPR(red1) + OPR(red2) = red_total_score
OPR(blue1) + OPR(blue2) = blue_total_score
```

This builds the system `Ax = b` where:
- `A` — alliance membership matrix (rows = alliances played, cols = teams)
- `b` — vector of alliance scores
- `x` — per-team OPR values

Solved via: `x = (AᵀA)⁻¹Aᵀb` (normal equations, Gaussian elimination)

Teams with fewer than 2 matches get OPR = 0 (insufficient data).

### Implementation (`scoring.js`)
New function `calculateOPR(db)`:
1. Fetch all committed match scores (both alliances per match)
2. Build `A` (sparse, indexed by team ID) and `b`
3. Solve using Gaussian elimination — matrix size ≤ 60×60 for typical FTC events, trivially fast
4. Return map of `teamId → opr`

`updateRankings(db)` calls `calculateOPR(db)` and writes results back to the `teams` table, then includes `opr` in each rankings entry.

### DB change
```sql
ALTER TABLE teams ADD COLUMN opr REAL DEFAULT 0;
```
Applied via migration in `db.js` `initDb()` using `IF NOT EXISTS` column check pattern already used in the project.

---

## 6. OPR Surfaces

### Rankings tab (public view)
OPR column added between Avg Score and W/L/T in the rankings table. Displayed to 1 decimal place. Comes from the `opr` field already present in each rankings entry returned by `/api/rankings`.

### Admin teams table (`public/admin.html`)
Read-only "OPR" column added to the teams table display. Populated from `GET /api/teams` response (which returns team rows from the DB — `opr` field available once the column exists). Not editable; resets after each commit.

---

## 7. API Changes

| Endpoint | Change |
|---|---|
| `GET /api/rankings` | Each entry gains `opr` field |
| `GET /api/teams` | Each row gains `opr` field (from DB column) |
| All others | Unchanged |

No new endpoints required.

---

## 8. Socket Events Used

| Event | Tab affected |
|---|---|
| `rankings_update` | Rankings |
| `queue_update` | Matches |
| `match_state_change` | Matches |
| `bracket_update` | Bracket (show/hide + re-render) |

