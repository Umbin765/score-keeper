# Score Keeper

Local-network FTC-style custom robotics scorekeeper. Node.js + Express + Socket.io + SQLite.
No internet required — runs entirely on your local network.

---

## Setup

### Prerequisites
- Node.js 18+ installed

### Install & Start

```bash
cd score-keeper
npm install
npm start
```

The server prints its local IP addresses on startup:
```
=== Score Keeper running on port 3000 ===
Access from this machine: http://localhost:3000
Network access:           http://192.168.1.42:3000
```

Open the printed network URL on **all devices** (tablets, phones, TVs, laptops) connected to the same Wi-Fi or wired network.

---

## Finding Your Server IP

### Windows
```
ipconfig
```
Look for **IPv4 Address** under your active adapter (Wi-Fi or Ethernet).

### Linux / macOS
```
ip addr show
# or
ifconfig
```
Look for `inet` under your active adapter (`wlan0` for Wi-Fi, `eth0` for Ethernet).

The server also prints all found IPs when it starts — easiest option.

---

## All URLs

| URL | Purpose | Auth |
|-----|---------|------|
| `/` | Landing page — links to all views | None |
| `/display` | Audience / TV scoreboard | None |
| `/queue` | Queue display for pit/field area | PIN 2002 |
| `/public` | Student & guest view (live scores, rankings, schedule) | None |
| `/rankings` | Full rankings with CSV export | None |
| `/bracket` | Playoff bracket display | None |
| `/control` | Match controller (load, start, advance timer) | PIN 3002 |
| `/red` | Red alliance scorer tablet | PIN 1001 |
| `/blue` | Blue alliance scorer tablet | PIN 1002 |
| `/ref` | Field referee (fouls, yellow cards) | PIN 2001 |
| `/headref` | Head referee (all ref + overrides + commit) | PIN 3001 |
| `/admin` | Admin panel (teams, settings, schedule, playoffs) | Password (see below) |

---

## Default PINs

| Role | PIN |
|------|-----|
| Red Scorer (`/red`) | `1001` |
| Blue Scorer (`/blue`) | `1002` |
| Field Referee (`/ref`) | `2001` |
| Queue Display (`/queue`) | `2002` |
| Head Referee (`/headref`) | `3001` |
| Match Controller (`/control`) | `3002` |

**Admin password:** `ftcadmin`

All PINs and the admin password are changeable in `/admin` → Manage PINs.

---

## Quick Start Workflow

1. **Setup teams**: Go to `/admin` → Team Management → add teams or import from CSV.
2. **Configure (optional)**: Adjust scoring values, RP thresholds, and period structure in `/admin`.
3. **Generate schedule**: `/admin` → Schedule → Generate Schedule.
4. **Run a match**:
   - `/control` — load the next match, advance its state to QUEUED then ON FIELD
   - `/red` and `/blue` — scorers enter scores on their tablets
   - `/ref` — referee issues fouls
   - `/display` — shown on the audience TV
   - `/queue` — shown near the field entrance
5. **Commit scores**: After the match ends, head ref or controller clicks "Commit Scores".
6. **Playoffs**: After quals, go to `/admin` → Alliance Selection → Initialize Bracket, then select captain/partner for each alliance.

---

## Match Structure (default)

| Period | Duration | Type |
|--------|----------|------|
| AUTO | 60 s | Scoring |
| TRANSITION | 8 s | No scoring |
| TELEOP × 5 | 110 s each | Scoring |
| ENDGAME × 5 | 10 s each | Park scoring |
| BUZZER × 5 | 10 s each | No scoring |

**Total: ~718 seconds (~12 minutes)**

The period sequence is fully configurable in `/admin` → Period Configuration.

---

## Data Persistence

All data is stored in `scorekeeper.db` (SQLite) in the project folder. Back up this file to preserve match data.

To fully reset the competition (erase all teams, matches, and scores): `/admin` → Reset → type `RESET` and confirm.

---

## Architecture Notes

- All match state is managed **server-side**. Browser views are thin clients.
- Real-time sync via Socket.io broadcasts to all connected clients simultaneously.
- Sessions use browser cookies (cleared when browser closes).
- Audio cues are generated via the Web Audio API in the browser — no audio files needed.
