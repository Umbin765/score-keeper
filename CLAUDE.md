# Score Keeper — CLAUDE.md

## Project Overview

FTC-style robotics competition scorekeeper. Node.js + Express + Socket.io + SQLite (better-sqlite3). Runs offline on a local network.

## Quick Reference

- **Start:** `npm start` (port 3000)
- **Database:** `scorekeeper.db` (SQLite, WAL mode)
- **Frontend:** Vanilla JS, no framework. All pages in `public/`
- **Styles:** Dark theme in `public/css/style.css`, display overlay uses inline styles

## Rules

### Documentation

When a new function is created or an existing function is modified, update the documentation in `README.md` to reflect the change. This includes:
- New server-side functions (db.js, scoring.js, timer.js, scheduler.js, bracket.js, server.js)
- New or changed REST API endpoints
- New or changed Socket.io events
- New client-side utility functions (common.js)
- New pages/routes

The `/docs` page at `public/docs.html` renders README.md live, so keeping the README current is all that's needed.
