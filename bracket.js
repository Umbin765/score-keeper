'use strict';

/**
 * Double-elimination bracket logic.
 *
 * Alliance count is determined from team count:
 *   >= 24 teams → 8 alliances
 *   >= 18 teams → 6 alliances
 *   <  18 teams → 4 alliances
 *
 * The bracket is stored as a list of matches in bracket_matches table.
 * Each match has: bracket_round (string label), bracket_slot (integer),
 * red_alliance, blue_alliance, winner_alliance.
 *
 * We use a standard double-elimination structure:
 *   Winners Bracket (WB) and Losers Bracket (LB) with a Grand Final.
 *
 * For simplicity, we pre-generate all bracket slots at the start of playoffs
 * and fill in participants as winners/losers advance.
 */

function getAllianceCount(teamCount) {
  if (teamCount >= 24) return 8;
  if (teamCount >= 18) return 6;
  return 4;
}

/**
 * Initialize the bracket for a given number of alliances.
 * Returns the initial bracket_matches rows (without match_ids).
 * This supports 4, 6, or 8 alliances.
 */
function initBracket(db, allianceCount) {
  // Clear existing bracket
  db.prepare('DELETE FROM bracket_matches').run();

  const slots = buildBracketSlots(allianceCount);
  const insert = db.prepare(`
    INSERT INTO bracket_matches(bracket_round, bracket_slot, red_alliance, blue_alliance)
    VALUES (?, ?, ?, ?)
  `);
  for (const s of slots) {
    insert.run(s.round, s.slot, s.red || null, s.blue || null);
  }
}

/**
 * Pre-seeded bracket slot definitions for 4, 6, 8 alliances.
 * Seeds are 1-based alliance numbers from alliance_selections.
 */
function buildBracketSlots(n) {
  if (n === 4) return bracket4();
  if (n === 6) return bracket6();
  return bracket8();
}

// 4-alliance double elimination: WB has 2 matches in R1, final 1, LB has 2 + 1 matches.
// WB-R1: 1v4, 2v3 | WB-Final: winners | LB-R1: losers cross | LB-Final: LB-R1 winners | Grand Final
function bracket4() {
  return [
    { round: 'WB-R1', slot: 1, red: 1, blue: 4 },
    { round: 'WB-R1', slot: 2, red: 2, blue: 3 },
    { round: 'WB-Final', slot: 1, red: null, blue: null },
    { round: 'LB-R1', slot: 1, red: null, blue: null },
    { round: 'LB-Final', slot: 1, red: null, blue: null },
    { round: 'Grand-Final', slot: 1, red: null, blue: null },
  ];
}

// 6-alliance: byes for top 2 seeds in WB-R1
function bracket6() {
  return [
    { round: 'WB-R1', slot: 1, red: 3, blue: 6 },
    { round: 'WB-R1', slot: 2, red: 4, blue: 5 },
    { round: 'WB-R2', slot: 1, red: 1, blue: null }, // 1 vs winner of WB-R1-1
    { round: 'WB-R2', slot: 2, red: 2, blue: null }, // 2 vs winner of WB-R1-2
    { round: 'WB-Final', slot: 1, red: null, blue: null },
    { round: 'LB-R1', slot: 1, red: null, blue: null }, // losers of WB-R1
    { round: 'LB-R2', slot: 1, red: null, blue: null }, // WB-R2 losers vs LB-R1 winner
    { round: 'LB-R2', slot: 2, red: null, blue: null },
    { round: 'LB-SF',  slot: 1, red: null, blue: null },
    { round: 'LB-Final', slot: 1, red: null, blue: null },
    { round: 'Grand-Final', slot: 1, red: null, blue: null },
  ];
}

// 8-alliance double elimination: standard seeding
function bracket8() {
  return [
    { round: 'WB-R1', slot: 1, red: 1, blue: 8 },
    { round: 'WB-R1', slot: 2, red: 4, blue: 5 },
    { round: 'WB-R1', slot: 3, red: 2, blue: 7 },
    { round: 'WB-R1', slot: 4, red: 3, blue: 6 },
    { round: 'WB-SF',  slot: 1, red: null, blue: null },
    { round: 'WB-SF',  slot: 2, red: null, blue: null },
    { round: 'WB-Final', slot: 1, red: null, blue: null },
    { round: 'LB-R1', slot: 1, red: null, blue: null },
    { round: 'LB-R1', slot: 2, red: null, blue: null },
    { round: 'LB-R2', slot: 1, red: null, blue: null },
    { round: 'LB-R2', slot: 2, red: null, blue: null },
    { round: 'LB-SF',  slot: 1, red: null, blue: null },
    { round: 'LB-SF',  slot: 2, red: null, blue: null },
    { round: 'LB-Final', slot: 1, red: null, blue: null },
    { round: 'Grand-Final', slot: 1, red: null, blue: null },
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
