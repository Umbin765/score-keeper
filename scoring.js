'use strict';

const { getPointValues, getSettingsMap, getFullScore } = require('./db');

/**
 * Calculate the total score for one alliance in one match.
 * Penalty points from OPPONENT fouls are already included via getFullScore.
 */
function calculateScore(db, matchId, alliance) {
  return getFullScore(db, matchId, alliance).total;
}

/** Park score for RP threshold checking. */
function calculateParkScore(db, matchId, alliance) {
  const pv = getPointValues(db);
  const cycles = db.prepare('SELECT * FROM endgame_cycles WHERE match_id=? AND alliance=?').all(matchId, alliance);
  let parkScore = 0;
  for (const c of cycles) {
    if (c.r1_park === 'partial') parkScore += pv.park_partial;
    else if (c.r1_park === 'full') parkScore += pv.park_full;
    if (c.r2_park === 'partial') parkScore += pv.park_partial;
    else if (c.r2_park === 'full') parkScore += pv.park_full;
    if (c.r1_park === 'full' && c.r2_park === 'full') parkScore += pv.park_bonus;
  }
  return parkScore;
}

/** Total pattern balls (auto + teleop) for RP threshold checking. */
function calculateArtifactsSorted(db, matchId, alliance) {
  const row = db.prepare('SELECT auto_pattern, teleop_pattern FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (!row) return 0;
  return ((row.auto_pattern || 0) + (row.teleop_pattern || 0)) / 2;
}

/** Total balls scored for RP threshold checking. */
function calculateBallsScored(db, matchId, alliance) {
  const row = db.prepare('SELECT auto_classified, auto_overflow, teleop_classified, teleop_overflow FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (!row) return 0;
  return (row.auto_classified || 0) / 3 + (row.auto_overflow || 0) + (row.teleop_classified || 0) / 3 + (row.teleop_overflow || 0);
}

/**
 * Calculate RP earned by one alliance in one match.
 * Returns 0 if the alliance has a red card (DQ).
 */
function calculateRP(db, matchId, alliance) {
  const settings = getSettingsMap(db);
  const opp = alliance === 'red' ? 'blue' : 'red';

  // Check DQ
  const scoreRow = db.prepare('SELECT red_cards FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  const redCards = JSON.parse(scoreRow?.red_cards || '[]');
  if (redCards.length > 0) return 0;

  const myScore = calculateScore(db, matchId, alliance);
  const oppScore = calculateScore(db, matchId, opp);

  let rp = 0;

  // Win / Tie / Loss
  if (myScore > oppScore) rp += parseFloat(settings.rp_win);
  else if (myScore === oppScore) rp += parseFloat(settings.rp_tie);
  else rp += parseFloat(settings.rp_loss);

  // PARK RP
  const parkScore = calculateParkScore(db, matchId, alliance);
  if (parkScore >= parseFloat(settings.rp_park_threshold_2)) rp += 2;
  else if (parkScore >= parseFloat(settings.rp_park_threshold_1)) rp += 1;

  // PATTERN RP (artifacts sorted)
  const artifacts = calculateArtifactsSorted(db, matchId, alliance);
  if (artifacts >= parseFloat(settings.rp_pattern_threshold_2)) rp += 2;
  else if (artifacts >= parseFloat(settings.rp_pattern_threshold_1)) rp += 1;

  // BALL RP
  const balls = calculateBallsScored(db, matchId, alliance);
  if (balls >= parseFloat(settings.rp_ball_threshold_2)) rp += 2;
  else if (balls >= parseFloat(settings.rp_ball_threshold_1)) rp += 1;

  return rp;
}

/**
 * Compute current RP bonuses for a live (uncommitted) match.
 * Used to show live RP on /display.
 */
function computeLiveRP(db, matchId, alliance) {
  const settings = getSettingsMap(db);
  const opp = alliance === 'red' ? 'blue' : 'red';
  const myScore = calculateScore(db, matchId, alliance);
  const oppScore = calculateScore(db, matchId, opp);

  let winLossRp = 0;
  if (myScore > oppScore) winLossRp = parseFloat(settings.rp_win);
  else if (myScore === oppScore) winLossRp = parseFloat(settings.rp_tie);
  else winLossRp = parseFloat(settings.rp_loss);

  const parkScore = calculateParkScore(db, matchId, alliance);
  let parkRp = 0;
  if (parkScore >= parseFloat(settings.rp_park_threshold_2)) parkRp = 2;
  else if (parkScore >= parseFloat(settings.rp_park_threshold_1)) parkRp = 1;

  const artifacts = calculateArtifactsSorted(db, matchId, alliance);
  let patternRp = 0;
  if (artifacts >= parseFloat(settings.rp_pattern_threshold_2)) patternRp = 2;
  else if (artifacts >= parseFloat(settings.rp_pattern_threshold_1)) patternRp = 1;

  const balls = calculateBallsScored(db, matchId, alliance);
  let ballRp = 0;
  if (balls >= parseFloat(settings.rp_ball_threshold_2)) ballRp = 2;
  else if (balls >= parseFloat(settings.rp_ball_threshold_1)) ballRp = 1;

  return { winLossRp, parkRp, patternRp, ballRp, total: winLossRp + parkRp + patternRp + ballRp };
}

/**
 * Build full rankings from all completed (committed) matches.
 * Returns sorted array with rank assigned.
 */
function updateRankings(db, includeMatchId = null) {
  const teams = db.prepare('SELECT * FROM teams ORDER BY number').all();
  const settings = getSettingsMap(db);
  const rankings = [];

  for (const team of teams) {
    const teamMatches = db.prepare(`
      SELECT m.*
      FROM matches m
      WHERE (m.red1 = ? OR m.red2 = ? OR m.blue1 = ? OR m.blue2 = ?)
        AND (
          (m.state = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM match_scores ms WHERE ms.match_id = m.id AND ms.committed = 1
          ))
          OR m.id = ?
        )
    `).all(team.id, team.id, team.id, team.id, includeMatchId ?? -1);

    let totalRp = 0, wins = 0, losses = 0, ties = 0, scoreList = [], highScore = 0;
    const rpBreakdown = [];

    for (const match of teamMatches) {
      const alliance = (match.red1 === team.id || match.red2 === team.id) ? 'red' : 'blue';
      const opp = alliance === 'red' ? 'blue' : 'red';

      const scoreRow = db.prepare('SELECT red_cards FROM match_scores WHERE match_id=? AND alliance=?').get(match.id, alliance);
      const isDQ = JSON.parse(scoreRow?.red_cards || '[]').length > 0;

      const rp = calculateRP(db, match.id, alliance);
      totalRp += rp;

      if (!isDQ) {
        const myScore = calculateScore(db, match.id, alliance);
        const oppScore = calculateScore(db, match.id, opp);
        scoreList.push(myScore);
        if (myScore > highScore) highScore = myScore;
        if (myScore > oppScore) wins++;
        else if (myScore === oppScore) ties++;
        else losses++;
      }

      const { parkRp, patternRp, ballRp, winLossRp } = computeLiveRP(db, match.id, alliance);
      rpBreakdown.push({ matchId: match.id, matchNumber: match.match_number, rp, parkRp, patternRp, ballRp, winLossRp });
    }

    const avgScore = scoreList.length > 0
      ? Math.round((scoreList.reduce((a, b) => a + b, 0) / scoreList.length) * 10) / 10
      : 0;

    rankings.push({
      teamId: team.id,
      teamNumber: team.number,
      teamName: team.name,
      rp: totalRp,
      avgScore,
      wins,
      losses,
      ties,
      highScore,
      matchesPlayed: teamMatches.length,
      rpBreakdown,
    });
  }

  rankings.sort((a, b) => {
    if (b.rp !== a.rp) return b.rp - a.rp;
    if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
    return b.highScore - a.highScore;
  });

  rankings.forEach((r, i) => { r.rank = i + 1; });
  return rankings;
}

module.exports = {
  calculateScore,
  calculateParkScore,
  calculateArtifactsSorted,
  calculateBallsScored,
  calculateRP,
  computeLiveRP,
  updateRankings,
};
