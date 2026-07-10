# Post-Match Review & Score Editing — Design Spec

**Goal:** Let refs finalize cards and penalties after time hits zero without the audience seeing live updates, then reveal the final score on demand; also allow editing of already-committed match scores from the control dashboard.

**Architecture:** A new in-memory `scoresRevealed` flag on the `MatchTimer` object drives a review phase between `match_end` and score reveal. The display freezes during review; all scorer/ref screens stay live. A history drawer in the control panel provides full score override for past matches.

**Tech Stack:** Node.js, Express, Socket.io, SQLite (better-sqlite3), vanilla JS

---

## 1. Match Lifecycle — Review Phase

The match lifecycle gains a review phase:

```
RUNNING → [match_end] → REVIEWING → [Show Scores] → REVEALED → [Commit] → COMPLETED
```

### Server-side (`timer.js`)
- Add `this.scoresRevealed = false` in `reset()` and `load()`.
- `_endMatch()` sets `this.running = false`, `this.matchEnded = true`, `this.scoresRevealed = false`, then emits `match_end` as today.
- `getState()` includes `scoresRevealed` in its return object.

### New endpoint (`server.js`)
```
POST /api/matches/:id/reveal
```
- Guards: match must be loaded and `timer.matchEnded === true`.
- Sets `timer.scoresRevealed = true`.
- Emits `scores_reveal` socket event with `{ matchId }`.
- Returns `{ ok: true }`.

### `/api/timer` endpoint
Already returns `timer.getState()` — picks up `scoresRevealed` automatically once added to `getState()`.

---

## 2. Display Behavior (`public/display.html`)

### New state: review mode
- On `match_end`: call new `goReview()` instead of `goComplete()`.
  - Sets `matchActive = false` (stops reacting to `timer_tick`).
  - Sets `reviewing = true` (new flag — blocks `score_update` from updating the DOM).
  - Shows the existing `postBanner` element with text "Under Review" (instead of winner text).
  - Does NOT apply winner class to panels yet.
- On `score_update`: if `reviewing === true`, ignore the event entirely.
- On `scores_reveal`: call `goComplete()` as today (winner highlight, "Final" period label). Sets `reviewing = false`.

### Page refresh recovery (`fetchTimerState`)
```
if (state.matchEnded && !state.scoresRevealed) → goReview()
if (state.matchEnded && state.scoresRevealed)  → goComplete()  (fetch latest scores first)
```
When recovering into `goReview()`, also fetch `/api/matches/:id/scores` to show the frozen score from when time hit zero.

### "Under Review" banner
Reuse the existing `postBanner` element. Add a CSS class `.post-banner--review` that styles it differently from the winner banner (neutral color, e.g. `#444`, centered text "UNDER REVIEW").

---

## 3. Scorer and Ref Screens Stay Live During Review

**Files:** `public/red.html`, `public/blue.html`, `public/ref.html`, `public/ref-blue.html`, `public/headref.html`

### Change
- Remove (or gate) the `match_end` handler logic that currently disables buttons / shows waiting overlay.
- Screens only disable/reset on `match_loaded` or `match_abort`.
- On `match_end`: show a subtle non-blocking label "Review Mode" (e.g. a small badge in the header) so refs know the match clock has ended. All scoring inputs remain enabled.
- On `scores_reveal` or `match_loaded`: clear the "Review Mode" label and proceed with normal reset flow.

---

## 4. Control Panel Additions (`public/control.html`)

### 4a. "Show Scores" button
- After `match_end` fires, a **"Show Scores"** button appears in the timer controls area (alongside the existing Commit button).
- Clicking it calls `POST /api/matches/:id/reveal`.
- On success (or on receiving `scores_reveal` socket event): button disappears. Commit button remains.
- If the page is refreshed while `matchEnded && !scoresRevealed`: "Show Scores" button is visible. If `scoresRevealed`: only Commit is visible.

### 4b. Match History drawer
- A collapsible **"Match History"** section at the bottom of the control panel.
- On expand: fetches `GET /api/matches?phase=qualification` (or all phases) and lists COMPLETED matches.
- Clicking a match row expands an edit form:
  - **Red alliance fields:** `auto_classified`, `auto_overflow`, `auto_leave`, `auto_pattern`, `teleop_classified`, `teleop_overflow`, `teleop_pattern`, yellow cards, red cards
  - **Blue alliance fields:** same set
  - Each field is a number input (cards are checkboxes per team number)
- **Save** button calls `POST /api/matches/:id/override` for each changed field (existing endpoint, takes `{ alliance, field, value, changedBy: 'admin' }`).
- After all overrides saved: re-fetches rankings via `GET /api/rankings` and emits a `rankings_update` — the existing override endpoint already calls `broadcastScores`, so rankings re-run automatically.
- **No new API endpoints needed** for score editing — the existing `/override` endpoint handles all fields.

---

## 5. What Does NOT Change

- The `commit` flow is unchanged — refs still commit after revealing scores to lock in rankings.
- The `replay` endpoint is unchanged — still available for full score reset.
- No DB schema changes — `scoresRevealed` lives only in memory on the timer object (it resets on server restart, which is fine since a restarted server starts a fresh match anyway).
- Rankings are only recalculated from committed scores — editing a committed match via the history drawer immediately re-runs `updateRankings`.

---

## 6. Socket Event Summary

| Event | Direction | When |
|---|---|---|
| `match_end` | server → clients | Timer reaches zero (unchanged) |
| `scores_reveal` | server → clients | Ref clicks "Show Scores" |
| `score_update` | server → clients | Any score change (unchanged; display ignores during review) |

