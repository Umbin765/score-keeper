'use strict';

/**
 * Single-elimination, fixed 4-alliance playoff bracket.
 *
 * Always exactly 4 alliances: Semifinal 1 (A1 v A4), Semifinal 2 (A2 v A3),
 * then Final (winner of SF1 v winner of SF2). No losers bracket.
 *
 * The bracket is stored as a list of matches in bracket_matches table.
 * Each match has: bracket_round (string label), bracket_slot (integer),
 * red_alliance, blue_alliance, winner_alliance.
 */

function getAllianceCount(_teamCount) {
  return 4;
}

/**
 * Initialize the bracket. Returns the initial bracket_matches rows
 * (without match_ids). Always builds the fixed 4-alliance semifinal+final
 * bracket regardless of team count.
 */
function initBracket(db, _allianceCount) {
  // Clear existing bracket
  db.prepare('DELETE FROM bracket_matches').run();

  const slots = buildBracketSlots();
  const insert = db.prepare(`
    INSERT INTO bracket_matches(bracket_round, bracket_slot, red_alliance, blue_alliance)
    VALUES (?, ?, ?, ?)
  `);
  for (const s of slots) {
    insert.run(s.round, s.slot, s.red || null, s.blue || null);
  }
}

// Fixed 4-alliance single elimination: SF1 (1v4), SF2 (2v3), Final (winners
// of SF1/SF2, assigned manually via /api/bracket/matches/:id/assign once
// each semifinal is decided).
function buildBracketSlots() {
  return [
    { round: 'Semifinal', slot: 1, red: 1, blue: 4 },
    { round: 'Semifinal', slot: 2, red: 2, blue: 3 },
    { round: 'Final', slot: 1, red: null, blue: null },
  ];
}

/**
 * Resolve an alliance number to its captain/partner team ids + numbers via
 * alliance_selections. Returns null if the alliance has no selection saved yet.
 */
function getAllianceRoster(db, allianceNumber) {
  if (allianceNumber == null) return null;
  const row = db.prepare(`
    SELECT a.captain_team, a.partner_team,
           t1.number as captain_number, t2.number as partner_number
    FROM alliance_selections a
    LEFT JOIN teams t1 ON t1.id = a.captain_team
    LEFT JOIN teams t2 ON t2.id = a.partner_team
    WHERE a.alliance_number = ?
  `).get(allianceNumber);
  return row || null;
}

function formatAllianceLabel(allianceNumber, roster) {
  if (allianceNumber == null) return null;
  const teamNumbers = roster ? [roster.captain_number, roster.partner_number].filter(Boolean) : [];
  return teamNumbers.length ? ('A' + allianceNumber + ' (' + teamNumbers.join(', ') + ')') : ('Alliance ' + allianceNumber);
}

/**
 * Get full bracket state for API. Rows are ordered by insertion order
 * (bm.id), which already matches the chronological round sequence each
 * bracketN() slot list was built in — callers should preserve this order
 * rather than re-sorting by round-name text.
 *
 * Includes both the raw fields (red_alliance, blue_alliance, winner_alliance,
 * bracket_round — used by the admin bracket-management UI and public.html)
 * and display-ready camelCase fields (redAlliance, blueAlliance, matchNumber,
 * redScore, blueScore, winner — used by bracket.html).
 */
function getBracket(db) {
  const rows = db.prepare(`
    SELECT bm.*, m.state as match_state, m.match_number as match_number
    FROM bracket_matches bm
    LEFT JOIN matches m ON m.id = bm.match_id
    ORDER BY bm.id
  `).all();

  // Lazily required to avoid a require cycle at module-load time (db.js does
  // not require bracket.js, so this is safe, but keeping it function-local
  // makes that invariant obvious).
  const { getFullScore } = require('./db');

  return rows.map((row) => {
    const redRoster = getAllianceRoster(db, row.red_alliance);
    const blueRoster = getAllianceRoster(db, row.blue_alliance);

    let redScore = null, blueScore = null;
    if (row.match_id) {
      redScore = getFullScore(db, row.match_id, 'red').total;
      blueScore = getFullScore(db, row.match_id, 'blue').total;
    }

    let winner = null;
    if (row.winner_alliance != null) {
      if (row.winner_alliance === row.red_alliance) winner = 'red';
      else if (row.winner_alliance === row.blue_alliance) winner = 'blue';
    }

    return {
      ...row,
      redAlliance: formatAllianceLabel(row.red_alliance, redRoster),
      blueAlliance: formatAllianceLabel(row.blue_alliance, blueRoster),
      matchNumber: row.match_number,
      redScore,
      blueScore,
      winner,
    };
  });
}

/** Record the winner of a bracket match. Does not auto-advance participants
 * into later rounds — see /api/bracket/matches/:id/assign, which the admin
 * "Bracket Matches" UI uses to route a recorded winner/loser into the next
 * round's red/blue slot. This is a deliberate choice: the exact winners/losers
 * bracket topology differs across 4/6/8-alliance formats and is guided by the
 * admin (following the printed bracket) rather than a hard-coded graph, to
 * avoid silently mis-routing a live elimination bracket. */
function advanceBracket(db, bracketMatchId, winnerAlliance) {
  db.prepare('UPDATE bracket_matches SET winner_alliance=? WHERE id=?').run(winnerAlliance, bracketMatchId);
}

module.exports = {
  getAllianceCount,
  initBracket,
  getBracket,
  advanceBracket,
  getAllianceRoster,
};
