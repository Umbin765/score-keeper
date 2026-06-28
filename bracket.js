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

/** Get full bracket state for API. */
function getBracket(db) {
  return db.prepare(`
    SELECT bm.*, m.state as match_state
    FROM bracket_matches bm
    LEFT JOIN matches m ON m.id = bm.match_id
    ORDER BY bm.id
  `).all();
}

/** After a bracket match result is recorded, advance winner/loser. */
function advanceBracket(db, bracketMatchId, winnerAlliance) {
  db.prepare('UPDATE bracket_matches SET winner_alliance=? WHERE id=?').run(winnerAlliance, bracketMatchId);
  // Bracket advancement logic is complex and match-structure-dependent.
  // For now, the admin manually sets participants for subsequent bracket matches
  // via the admin UI — this function just records the winner.
  // Full auto-advancement would require a hard-coded bracket graph for each alliance count.
}

module.exports = { getAllianceCount, initBracket, getBracket, advanceBracket };
