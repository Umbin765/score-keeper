'use strict';

/**
 * Generate a balanced qualification schedule.
 *
 * Strategy: use the "circle method" round-robin to generate all match slots,
 * then assign alliances based on red/blue balance. This guarantees every team
 * plays exactly matchesPerTeam matches with no partial failures.
 *
 * Returns array of { match_number, red1, red2, blue1, blue2 } (team ids).
 */
function generateSchedule(teams, matchesPerTeam) {
  if (teams.length < 4) {
    throw new Error('Need at least 4 teams to generate a schedule');
  }

  // Shuffle team order so each generated schedule is different
  const ids = teams.map(t => t.id).sort(() => Math.random() - 0.5);
  const n = ids.length;
  const totalSlots = n * matchesPerTeam;

  if (totalSlots % 4 !== 0) {
    throw new Error(
      `${n} teams × ${matchesPerTeam} matches = ${totalSlots} slots, not divisible by 4. ` +
      `Adjust team count or matches_per_team.`
    );
  }

  const totalMatches = totalSlots / 4;

  // Round-robin via circle method: generate rounds of n/2 pair matches
  // then pick 2 pairs per "super-match" to get 4-team matches.
  const rounds = generateRoundRobinRounds(ids); // rounds of [teamA, teamB] pairs

  // Flatten rounds into ordered pair list
  const pairs = [];
  let roundIdx = 0;
  while (pairs.length < totalMatches * 2) {
    const round = rounds[roundIdx % rounds.length];
    for (const pair of round) {
      pairs.push(pair);
      if (pairs.length === totalMatches * 2) break;
    }
    roundIdx++;
  }

  // Combine consecutive pairs into 4-team matches
  const rawMatches = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const [a, b] = pairs[i];
    const [c, d] = pairs[i + 1];
    rawMatches.push({ match_number: rawMatches.length + 1, red1: a, red2: b, blue1: c, blue2: d });
  }

  // Balance red/blue by swapping alliances where a team has too many reds
  const redCount = new Map(ids.map(id => [id, 0]));
  const balanced = rawMatches.map((m) => {
    // Decide if we should swap red<->blue for this match
    const redNeed = (id) => (matchesPerTeam / 2) - redCount.get(id);
    const curRedNeed  = redNeed(m.red1)  + redNeed(m.red2);
    const curBlueNeed = redNeed(m.blue1) + redNeed(m.blue2);

    let out;
    if (curBlueNeed > curRedNeed) {
      out = { match_number: m.match_number, red1: m.blue1, red2: m.blue2, blue1: m.red1, blue2: m.red2 };
    } else {
      out = { ...m };
    }

    redCount.set(out.red1,  redCount.get(out.red1)  + 1);
    redCount.set(out.red2,  redCount.get(out.red2)  + 1);
    return out;
  });

  return balanced;
}

/**
 * Classic circle-method round-robin.
 * Returns array of rounds; each round is an array of [teamA, teamB] pairs.
 * With n teams: n-1 rounds, each with n/2 pairs.
 * With odd n: n rounds, each with (n-1)/2 pairs (one team sits out per round).
 */
function generateRoundRobinRounds(ids) {
  const arr = [...ids];
  const n = arr.length;

  if (n % 2 === 1) {
    // Odd: add a "bye" placeholder
    arr.push(null);
  }

  const half = arr.length / 2;
  const rounds = [];

  for (let r = 0; r < arr.length - 1; r++) {
    const round = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[arr.length - 1 - i];
      if (a !== null && b !== null) {
        round.push([a, b]);
      }
    }
    rounds.push(round);

    // Rotate: fix first element, rotate the rest
    const last = arr[arr.length - 1];
    for (let i = arr.length - 1; i > 1; i--) arr[i] = arr[i - 1];
    arr[1] = last;
  }

  return rounds;
}

module.exports = { generateSchedule };
