# Score Keeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-network FTC-style custom scorekeeper web app with real-time scoring, multi-role views, and full admin configuration.

**Architecture:** Node.js + Express serves all HTML pages directly (route-level auth check) and a REST API. Socket.io broadcasts all live state changes to every connected client. All match state lives server-side; browsers are thin views.

**Tech Stack:** Node.js, Express, Socket.io, better-sqlite3, express-session, cookie-parser — Vanilla HTML/CSS/JS frontend, no build step.

---

## File Structure

```
score-keeper/
├── package.json
├── server.js           # Express + Socket.io entrypoint, all routes + socket handlers
├── db.js               # Schema creation, seed data, query helpers
├── timer.js            # MatchTimer class — server-side period state machine
├── scoring.js          # calculateScore(), calculateRP(), updateRankings()
├── scheduler.js        # generateSchedule() — balanced round-robin
├── bracket.js          # Double-elimination bracket logic
├── public/
│   ├── css/style.css   # Dark theme, alliance colors, responsive
│   ├── js/common.js    # PIN pad overlay, socket.io client helpers, shared utils
│   ├── index.html      # Landing / URL directory
│   ├── display.html    # /display — audience TV
│   ├── queue.html      # /queue — PIN-protected queueing display
│   ├── public.html     # /public — student phone view
│   ├── rankings.html   # /rankings
│   ├── bracket.html    # /bracket
│   ├── control.html    # /control — match controller
│   ├── red.html        # /red — red scorer
│   ├── blue.html       # /blue — blue scorer
│   ├── ref.html        # /ref — field referee
│   ├── headref.html    # /headref — head referee
│   └── admin.html      # /admin — admin panel
└── README.md
```

## Tasks

### Task 1: package.json + dependencies

- [ ] Write package.json with scripts and dependencies
- [ ] Run `npm install`
- [ ] Verify node_modules created

### Task 2: Database layer (db.js)

- [ ] Write schema for all tables
- [ ] Write seed data (default settings, period config, PINs)
- [ ] Write and export query helpers

### Task 3: Timer (timer.js)

- [ ] Write MatchTimer class with start/pause/resume/abort/tick/advancePeriod
- [ ] Export expandPeriods() helper

### Task 4: Scoring (scoring.js)

- [ ] Write calculateScore(), calculateParkScore(), calculateArtifactsSorted(), calculateBallsScored()
- [ ] Write calculateRP()
- [ ] Write updateRankings()

### Task 5: Scheduler (scheduler.js)

- [ ] Write generateSchedule() — balanced round-robin

### Task 6: Bracket (bracket.js)

- [ ] Write double-elimination bracket logic
- [ ] Write advanceBracket()

### Task 7: Main server (server.js)

- [ ] Express setup, session middleware, static files
- [ ] Auth middleware + PIN API
- [ ] All REST routes
- [ ] Socket.io setup + event handlers
- [ ] Timer integration

### Task 8: CSS (public/css/style.css)

- [ ] Dark theme base
- [ ] Alliance color utilities
- [ ] Timer display styles
- [ ] PIN pad styles
- [ ] Responsive utilities

### Task 9: Shared JS (public/js/common.js)

- [ ] PIN pad overlay component
- [ ] Auth check helper
- [ ] Socket.io client setup helper

### Task 10: Public/display views

- [ ] index.html
- [ ] display.html
- [ ] queue.html
- [ ] public.html
- [ ] rankings.html
- [ ] bracket.html

### Task 11: Operational views

- [ ] control.html
- [ ] red.html
- [ ] blue.html
- [ ] ref.html
- [ ] headref.html
- [ ] admin.html

### Task 12: README

- [ ] Setup instructions
- [ ] How to find server IP (Windows + Linux)
- [ ] All URLs + purposes
- [ ] Default PINs
