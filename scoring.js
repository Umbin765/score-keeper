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
 * Calculate OPR (Offensive Power Rating) for all teams using
 * least-squares over committed match scores (normal equations,
 * Gauss-Jordan elimination). Returns map of { teamId: opr }.
 * Teams with insufficient data get OPR 0.
 */
function calculateOPR(db) {
  const teams = db.prepare('SELECT id FROM teams ORDER BY id').all();
  const n = teams.length;
  if (n === 0) return {};

  // Map team DB id → matrix column index
  const idxById = {};
  teams.forEach((t, i) => { idxById[t.id] = i; });

  // Collect one entry per committed alliance (quals only, no penalty inflation)
  const committedMatches = db.prepare(`
    SELECT DISTINCT ms.match_id, m.red1, m.red2, m.blue1, m.blue2
    FROM match_scores ms
    JOIN matches m ON m.id = ms.match_id
    WHERE ms.committed = 1 AND m.phase = 'quals'
  `).all();

  const alliances = [];
  for (const match of committedMatches) {
    for (const al of ['red', 'blue']) {
      const t1 = al === 'red' ? match.red1 : match.blue1;
      const t2 = al === 'red' ? match.red2 : match.blue2;
      if (!t1 || !t2) continue;
      // Use offensive score only (exclude opponent penalty points)
      const full = getFullScore(db, match.match_id, al);
      const score = full.total - (full.penalties || 0);
      alliances.push({ t1, t2, score });
    }
  }

  if (alliances.length === 0) return {};

  // Build A^T A (n×n) and A^T b (n×1)
  const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
  const ATb = new Array(n).fill(0);

  for (const { t1, t2, score } of alliances) {
    const i = idxById[t1];
    const j = idxById[t2];
    if (i === undefined || j === undefined) continue;
    // A row has 1s at columns i and j; A^T A += outer product of that row
    ATA[i][i] += 1; ATA[i][j] += 1;
    ATA[j][i] += 1; ATA[j][j] += 1;
    ATb[i] += score;
    ATb[j] += score;
  }

  // Augmented matrix [ATA | ATb], solve via Gauss-Jordan with partial pivoting
  const aug = ATA.map((row, i) => [...row, ATb[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: find row with largest absolute value in this column
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivotRow][col])) pivotRow = row;
    }
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-9) continue; // singular row — skip

    // Normalize pivot row so diagonal becomes 1
    const scale = 1 / pivot;
    for (let k = col; k <= n; k++) aug[col][k] *= scale;

    // Eliminate this column from all other rows
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let k = col; k <= n; k++) aug[row][k] -= factor * aug[col][k];
    }
  }

  // After Gauss-Jordan, aug[i][n] is the solution for team i
  const result = {};
  teams.forEach((t, i) => {
    const val = Math.abs(aug[i][i]) < 1e-9 ? 0 : aug[i][n];
    result[t.id] = Math.round(val * 10) / 10;
  });

  return result;
}

/**
 * Build full rankings from all completed (committed) matches.
 * Pass includeMatchId to also count one uncommitted match (provisional
 * rankings for post-match rank-movement display). Never persisted.
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
  calculateOPR,
  updateRankings,
};
