'use strict';

const { getPointValues, getSettingsMap, getFullScore, isAllianceRedCarded } = require('./db');

/**
 * Calculate the total score for one alliance in one match.
 * Penalty points from OPPONENT fouls are already included via getFullScore.
 */
function calculateScore(db, matchId, alliance) {
  return getFullScore(db, matchId, alliance).total;
}

/** Park (BASE) score for Movement RP threshold checking. */
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

/** AUTO LEAVE points for Movement RP threshold checking (SEC: LEAVE + BASE combined). */
function calculateLeaveScore(db, matchId, alliance) {
  const pv = getPointValues(db);
  const row = db.prepare('SELECT auto_leave_r1, auto_leave_r2 FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (!row) return 0;
  return ((row.auto_leave_r1 || 0) + (row.auto_leave_r2 || 0)) * pv.auto_leave;
}

/** PATTERN points (auto + teleop matched artifacts, at pts_auto_pattern each) for Pattern RP threshold checking. */
function calculatePatternPoints(db, matchId, alliance) {
  const pv = getPointValues(db);
  const row = db.prepare('SELECT auto_pattern, teleop_pattern FROM match_scores WHERE match_id=? AND alliance=?').get(matchId, alliance);
  if (!row) return 0;
  return ((row.auto_pattern || 0) + (row.teleop_pattern || 0)) * pv.auto_pattern;
}

/** Number of ARTIFACTS scored through the goal (classified + overflow, auto + teleop) for Goal RP threshold checking. */
function calculateGoalArtifacts(db, matchId, alliance) {
  const row = db.prepare(`
    SELECT auto_classified, auto_overflow, teleop_classified, teleop_overflow
    FROM match_scores WHERE match_id=? AND alliance=?
  `).get(matchId, alliance);
  if (!row) return 0;
  return (row.auto_classified || 0) + (row.auto_overflow || 0) + (row.teleop_classified || 0) + (row.teleop_overflow || 0);
}

/** Active RP overrides for one alliance in one match, keyed by category. */
function getRpOverrides(db, matchId, alliance) {
  const rows = db.prepare('SELECT * FROM rp_overrides WHERE match_id=? AND alliance=?').all(matchId, alliance);
  const map = {};
  for (const row of rows) map[row.category] = row;
  return map;
}

/** Grant = max for the category; exclude = 0; override = the referee's exact value. */
function applyRpOverride(override, computedValue, maxValue) {
  if (!override) return computedValue;
  if (override.mode === 'grant') return maxValue;
  if (override.mode === 'exclude') return 0;
  if (override.mode === 'override') return override.value;
  return computedValue;
}

/**
 * Compute the RP breakdown for one alliance in one match, applying any
 * Head Referee RP overrides (grant/exclude/override) on top of the
 * auto-calculated per-category values. A red card (DQ) zeroes every
 * category before overrides are applied, so an "override" can still
 * restore RP for a DQ'd alliance if the Head Referee sets one.
 */
function computeRpBreakdown(db, matchId, alliance) {
  const settings = getSettingsMap(db);
  const opp = alliance === 'red' ? 'blue' : 'red';

  const isDQ = isAllianceRedCarded(db, matchId, alliance);

  let winLossRp = 0, parkRp = 0, patternRp = 0, ballRp = 0;

  if (!isDQ) {
    // Per the SEC Game Manual: any confirmed red card ends the match
    // immediately and the opposing alliance is awarded every RP category
    // (see timer.forceEnd() call in server.js's 'penalty' handler).
    if (isAllianceRedCarded(db, matchId, opp)) {
      winLossRp = parseFloat(settings.rp_win);
      parkRp = 2;
      patternRp = 2;
      ballRp = 2;
    } else {
      const myScore = calculateScore(db, matchId, alliance);
      const oppScore = calculateScore(db, matchId, opp);

      if (myScore > oppScore) winLossRp = parseFloat(settings.rp_win);
      else if (myScore === oppScore) winLossRp = parseFloat(settings.rp_tie);
      else winLossRp = parseFloat(settings.rp_loss);

      // Movement RP: combined LEAVE + BASE points.
      const movementScore = calculateLeaveScore(db, matchId, alliance) + calculateParkScore(db, matchId, alliance);
      if (movementScore >= parseFloat(settings.rp_park_threshold_2)) parkRp = 2;
      else if (movementScore >= parseFloat(settings.rp_park_threshold_1)) parkRp = 1;

      // Pattern RP: PATTERN points (matched-artifact count × pts_auto_pattern).
      const patternPts = calculatePatternPoints(db, matchId, alliance);
      if (patternPts >= parseFloat(settings.rp_pattern_threshold_2)) patternRp = 2;
      else if (patternPts >= parseFloat(settings.rp_pattern_threshold_1)) patternRp = 1;

      // Goal RP: number of ARTIFACTS scored through the goal (classified + overflow).
      const goalArtifacts = calculateGoalArtifacts(db, matchId, alliance);
      if (goalArtifacts >= parseFloat(settings.rp_ball_threshold_2)) ballRp = 2;
      else if (goalArtifacts >= parseFloat(settings.rp_ball_threshold_1)) ballRp = 1;
    }
  }

  const overrides = getRpOverrides(db, matchId, alliance);
  winLossRp = applyRpOverride(overrides.win,     winLossRp, parseFloat(settings.rp_win));
  parkRp    = applyRpOverride(overrides.park,    parkRp,    2);
  patternRp = applyRpOverride(overrides.pattern, patternRp, 2);
  ballRp    = applyRpOverride(overrides.ball,    ballRp,    2);

  return { winLossRp, parkRp, patternRp, ballRp, total: winLossRp + parkRp + patternRp + ballRp, overrides };
}

/**
 * Calculate RP earned by one alliance in one match, including any
 * Head Referee overrides.
 */
function calculateRP(db, matchId, alliance) {
  return computeRpBreakdown(db, matchId, alliance).total;
}

/**
 * Compute current RP bonuses for a live (uncommitted) match.
 * Used to show live RP on /display.
 */
function computeLiveRP(db, matchId, alliance) {
  return computeRpBreakdown(db, matchId, alliance);
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

      const isDQ = isAllianceRedCarded(db, match.id, alliance);

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

  // Calculate OPR for all teams
  const oprMap = calculateOPR(db);

  // Persist OPR to DB only on committed-rankings path (not provisional preview)
  if (includeMatchId === null) {
    const updateOpr = db.prepare('UPDATE teams SET opr=? WHERE id=?');
    db.transaction(() => {
      for (const [teamId, oprVal] of Object.entries(oprMap)) {
        updateOpr.run(oprVal, Number(teamId));
      }
    })();
  }

  // Attach opr to each ranking entry (useful on both paths)
  rankings.forEach(r => {
    r.opr = oprMap[r.teamId] ?? 0;
  });

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
  calculateLeaveScore,
  calculatePatternPoints,
  calculateGoalArtifacts,
  calculateRP,
  computeLiveRP,
  computeRpBreakdown,
  getRpOverrides,
  calculateOPR,
  updateRankings,
};
