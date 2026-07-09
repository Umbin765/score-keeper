'use strict';

/**
 * Server-side match timer state machine.
 * Owns a single setInterval that ticks once per second.
 * Emits Socket.io events to all connected clients.
 */
class MatchTimer {
  constructor(io) {
    this.io = io;
    this._interval = null;
    this.onPeriodChange = null; // callback(state) fired after every period advance
    this.reset();
  }

  reset() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.matchId = null;
    this.periods = [];        // expanded flat sequence
    this.periodIndex = 0;
    this.timeRemaining = 0;
    this.running = false;
    this.paused = false;
    this.endgameCycle = 0;
    this.matchEnded = false;
  }

  /** Load a match and its period sequence. Does NOT start the timer. */
  load(matchId, periods) {
    this.reset();
    this.matchId = matchId;
    this.periods = periods;
    this.periodIndex = 0;
    this.timeRemaining = periods.length > 0 ? periods[0].duration : 0;
    this.matchEnded = false;
    this.io.emit('match_loaded', { matchId, period: this.currentPeriod, timeRemaining: this.timeRemaining });
  }

  get currentPeriod() {
    return this.periods[this.periodIndex] || null;
  }

  getState() {
    return {
      matchId: this.matchId,
      running: this.running,
      paused: this.paused,
      periodIndex: this.periodIndex,
      period: this.currentPeriod,
      timeRemaining: this.timeRemaining,
      endgameCycle: this.endgameCycle,
      totalPeriods: this.periods.length,
      matchEnded: this.matchEnded,
    };
  }

  start() {
    if (this.running || !this.matchId || this.matchEnded) return false;
    this.running = true;
    this.paused = false;
    this._interval = setInterval(() => this._tick(), 1000);
    this.io.emit('match_start', this.getState());
    return true;
  }

  pause() {
    if (!this.running || this.paused) return false;
    this.paused = true;
    clearInterval(this._interval);
    this._interval = null;
    this.io.emit('match_paused', this.getState());
    return true;
  }

  resume() {
    if (!this.running || !this.paused) return false;
    this.paused = false;
    this._interval = setInterval(() => this._tick(), 1000);
    this.io.emit('match_resumed', this.getState());
    return true;
  }

  abort() {
    const mid = this.matchId;
    this.reset();
    this.io.emit('match_abort', { matchId: mid });
  }

  /** Manually advance to the next period (override). */
  manualAdvance() {
    if (!this.matchId || this.matchEnded) return false;
    // Clear existing interval before advancing — _advancePeriod() will start
    // a fresh one if the timer is still running. Do NOT start another one here
    // or two intervals will race and chain match_end events.
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._advancePeriod();
    return true;
  }

  _tick() {
    // Guard: bail out if this interval was orphaned by reset() or abort()
    if (!this.running || !this.matchId || this.matchEnded) return;

    this.timeRemaining = Math.max(0, this.timeRemaining - 1);
    this.io.emit('timer_tick', this.getState());

    if (this.timeRemaining === 0) {
      this._advancePeriod();
    }
  }

  _advancePeriod() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    // Guard: bail out if reset/abort was called while we were mid-tick
    if (!this.matchId || this.matchEnded) return;

    this.periodIndex++;

    if (this.periodIndex >= this.periods.length) {
      this._endMatch();
      return;
    }

    const next = this.currentPeriod;
    this.timeRemaining = next.duration;

    if (next.type === 'ENDGAME') {
      this.endgameCycle = next.cycle || 1;
    }

    this.io.emit('period_change', this.getState());

    if (this.onPeriodChange) this.onPeriodChange(this.getState());

    // Auto-resume interval after period change
    if (this.running && !this.paused) {
      this._interval = setInterval(() => this._tick(), 1000);
    }
  }

  _endMatch() {
    // Guard: prevent double-fire if called from an orphaned interval
    if (this.matchEnded) return;

    this.running = false;
    this.matchEnded = true;
    this.io.emit('match_end', { matchId: this.matchId, state: this.getState() });
  }
}

/**
 * Expand period_config rows into a flat period sequence.
 * Re-exported here for convenience (also in db.js).
 */
function expandPeriods(rows) {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  const result = [];
  const seenGroups = new Set();

  for (const row of sorted) {
    if (row.group_id === null || row.group_id === undefined) {
      result.push({ name: row.name, duration: row.duration, type: row.type, cycle: null });
    } else if (!seenGroups.has(row.group_id)) {
      seenGroups.add(row.group_id);
      const groupRows = sorted.filter(r => r.group_id === row.group_id);
      const repeats = row.group_repeats || 1;
      for (let i = 1; i <= repeats; i++) {
        for (const gr of groupRows) {
          result.push({ name: gr.name, duration: gr.duration, type: gr.type, cycle: i });
        }
      }
    }
  }
  return result;
}

module.exports = { MatchTimer, expandPeriods };
