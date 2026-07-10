# Winner Animation & Match Results Screen — Design Spec

**Goal:** On score reveal, the display plays a DECODE-style winner animation (stepped pyramid filling with alliance color + "X WINS!" banner), then shows a 1:1 recreation of the official FTC Match Results screen with our custom scoring categories and ranking points.

**Builds on:** `2026-07-10-post-match-review-and-score-editing-design.md` (review phase, `scores_reveal` event, Show Scores button, history drawer). This spec replaces that spec's "goComplete()" reveal behavior (winner highlight + simple banner) with the animation + results screen.

**Tech Stack:** Node.js, Express, Socket.io, SQLite, vanilla JS, inline SVG, self-hosted QR library.

---

## 1. Flow

```
match_end → REVIEWING (display: "UNDER REVIEW", frozen scores)
         → control clicks "Show Scores" → POST /api/matches/:id/reveal
         → scores_reveal { matchId, results }
         → display: pyramid animation (~4s) → results screen
         → results screen persists until match_loaded / match_abort / full_reset
```

Commit remains a separate step after reveal. If commit (or a later override) changes scores/rankings while the results screen is visible, the screen live-updates from `score_update` / `rankings_update`.

---

## 2. Server

### 2a. `timer.js`
Per the post-match-review spec: `scoresRevealed` flag set false in `reset()` and `load()` and `_endMatch()`, included in `getState()`.

### 2b. `scoring.js` — provisional rankings
`updateRankings(db, includeMatchId?)` gains an optional second parameter. When provided, that match's scores are counted as if committed (both alliances) even though `committed = 0`. Used only for computing provisional rank movement at reveal time; never persisted.

### 2c. `POST /api/matches/:id/reveal` (`server.js`)
- **Guards:** match loaded in timer (`timer.matchId === id`) and `timer.matchEnded === true`. 409 otherwise.
- Sets `timer.scoresRevealed = true`.
- Builds a **results payload**:

```javascript
{
  matchId,
  match,               // matchWithTeams(match) — teams, match_number, phase
  matchCount,          // total matches in this phase (for "Qualification N of M")
  red:  { total, breakdown: { leave, artifact, pattern, balls, base, foul }, rp: { winLossRp, parkRp, patternRp, ballRp, total } },
  blue: { ...same },
  winner,              // 'red' | 'blue' | 'tie'
  teams: {             // rank movement, provisional
    red:  [{ number, rank, delta }, { number, rank, delta }],
    blue: [{ number, rank, delta }, { number, rank, delta }]
  }
}
```

- **Breakdown mapping** (from `getFullScore` breakdown):
  - `leave`    = `auto_leave`
  - `artifact` = `auto_classified + auto_overflow + teleop_classified + teleop_overflow`
  - `pattern`  = `auto_pattern`
  - `balls`    = `teleop_balls`
  - `base`     = `park_score`
  - `foul`     = `penalty_pts`
- **Rank movement:** `before = updateRankings(db)`, `after = updateRankings(db, matchId)`. For each of the 4 teams: `rank` = position in `after`, `delta` = beforeRank − afterRank (positive = moved up, negative = down, 0 = no change; team unranked before → delta null, arrow shown as ↑).
- Emits `scores_reveal` with the payload to all clients. Returns `{ ok: true }`.
- `GET /api/timer` already returns `scoresRevealed` via `getState()`. For refresh recovery, the display re-fetches the payload via a new **`GET /api/matches/:id/results`** endpoint (same payload builder, no state change, allowed once `matchEnded`).

### 2d. `/api/matches/:id/override` — card editing
Extend allowed fields with `yellow_cards` and `red_cards`. Values must be JSON arrays of team numbers (validated: array of integers, teams must be in the match). Audit-logged like other overrides. (Spec correction: the review spec listed `teleop_pattern`; the real field is `teleop_balls`.)

---

## 3. Display — Winner Animation (`display.html`)

Full-screen opaque overlay (`#winner-anim`), z-index above everything, dark desert-dusk gradient background.

- **Pyramid:** inline SVG stepped ziggurat (5 tiers + top temple block), drawn as a glowing wireframe (alliance-colored stroke, `drop-shadow` glow). A `clipPath` rect animates height bottom-to-top over ~2s (CSS transition), filling the pyramid with the alliance color at ~85% opacity — mirrors the official "pyramid builds up" reveal.
- **Banner:** angled ribbon (rotated ~-4°, alliance-color fill, darker border, white extruded/outlined text in Barlow Condensed 800): `RED WINS!` / `BLUE WINS!` / `TIE!` (tie: gold `--yellow` fill, pyramid fills gold). Slams in with a scale-overshoot keyframe after the fill completes (~2.2s mark).
- **Timing:** total ~4s hold, then the overlay crossfades out (0.4s) as the results screen fades in.
- **Sound:** none (display already has buzzer via common.js; not triggered here).

---

## 4. Display — Match Results Screen

Full-screen opaque overlay (`#results-screen`) recreating the official layout:

```
┌────────────────────────────────────────────────────────┐
│ Match Results        Qualification 101 of 104   [logo] │  header bar (dark)
├────────────┬──────────────────┬────────────────────────┤
│ 🏆 WINNER  │  Blue     Red    │                        │  yellow banner on
│ (yellow)   │  202      144    │                        │  winner's side
├────────────┼──────────────────┼────────────────────────┤
│ 18984 50↑  │   6  LEAVE    0  │  25482 45↓             │  team pills w/ rank
│ 28366 14↑  │  82  ARTIFACT 99 │  30317 49↓             │  + movement arrows
│            │  14  PATTERN  10 │                        │
│            │  30  BALLS    10 │                        │
│            │  25  BASE     12 │                        │
│            │  70  FOUL     25 │                        │
├────────────┼──────────────────┼────────────────────────┤
│ Ranking    │   [QR → /public] │  Ranking Points        │  RP icon rows
│ Points     │  "Scan for live  │                        │
│ 🏆🏆🏆🏆⚑⚑◈◈●● │   results"      │  🏆🏆🏆🏆⚑⚑◈◈●●          │
└────────────┴──────────────────┴────────────────────────┘
```

- **Header:** "Match Results" left, "Qualification N of M" (or "Playoff — <round>") center, DECODE-style wordmark right. Dark bar.
- **Score panels:** blue panel left, red panel right (matching screenshot), Barlow Condensed 800 totals.
- **WINNER banner:** yellow box + trophy glyph on the winning side; hidden on tie (both panels get a "TIE" chip instead).
- **Category rows (6):** LEAVE, ARTIFACT, PATTERN, BALLS, BASE, FOUL — blue value left, label center, red value right, alternating row tint.
- **Team pills:** alliance-colored pill with team number + white square showing `rank ↑/↓/—`. Data from `results.teams`.
- **Ranking Points rows:** one icon per RP earned, per category, lit in white/alliance tint when earned, dimmed (20% opacity) when not:
  - Win/Tie: up to 4 trophy icons
  - Park: up to 2 base/park icons
  - Pattern: up to 2 pattern (diamond grid) icons
  - Ball: up to 2 ball icons
  - Icons are inline SVG glyphs (no image assets).
- **QR code:** center-bottom, generated client-side from `location.origin + '/public'` using self-hosted `qrcode-generator` (single-file MIT lib, saved to `public/js/vendor/qrcode.js`). Caption: "Scan for live results".
- **Live updates:** while visible, `score_update` for this match re-renders totals/rows; `rankings_update` (post-commit) re-renders team ranks using real (non-provisional) rankings.
- **Dismissal:** hidden on `match_loaded`, `match_abort`, `full_reset` — display returns to the normal overlay layout.
- **Refresh recovery:** if `timer state = matchEnded && scoresRevealed`, fetch `GET /api/matches/:id/results` and show the results screen directly (skip animation). If `matchEnded && !scoresRevealed` → review mode per the review spec.

---

## 5. Refs / Scorers / Control

Per the post-match-review spec, unchanged:
- **red/blue/ref/ref-blue/headref:** stay live after `match_end`; show a small "REVIEW" badge; reset only on `match_loaded` / `match_abort`.
- **control:** "Show Scores" button appears in timer controls once `matchEnded && !scoresRevealed`; calls `/reveal`; hides on `scores_reveal`. Refresh-safe via `getState().scoresRevealed`.
- **control history drawer:** collapsible "Match History" section listing COMPLETED matches; per-field edit form (all 9 score fields + yellow/red cards) saving via `/override`; rankings re-run automatically via existing override → broadcast path.

---

## 6. Socket Event Summary

| Event | Payload | When |
|---|---|---|
| `scores_reveal` | full results payload (§2c) | Show Scores clicked |
| `score_update` | unchanged | display ignores during review; results screen consumes if visible |
| `rankings_update` | unchanged | results screen refreshes rank pills post-commit |

## 7. Out of Scope
- No video assets — animation is pure SVG/CSS.
- No DB schema changes.
- Public pages unchanged (results screen lives only on `/display`).
