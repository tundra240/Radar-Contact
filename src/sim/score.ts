import type { Departure } from './aircraft'
import { DIFFICULTIES, scaledPoints, type DifficultySettings } from './difficulty'

/**
 * The score.
 *
 * Two events move it, because two things happen to an arrival: it lands, or
 * it leaves without landing. That is the whole of it until conflicts are
 * detected, and it is deliberately not more -- a score built out of things
 * the simulation does not yet model would be a number that means nothing.
 *
 * Kept as a value rather than a counter object so a session's score is a
 * thing you can hold, compare and replay to, in the same spirit as the
 * seeded traffic.
 */

/** Landing one is the job. */
export const LANDING_POINTS = 100

/**
 * Losing one costs less than landing one earns, so a session where you
 * land most of the traffic still climbs. It is a penalty, not a punishment.
 */
export const LOST_PENALTY = 50

/**
 * A transit crossing the sector is worth nothing, in both directions.
 *
 * Not a reward, because letting an aeroplane fly the route it filed is not
 * an achievement and paying for it would turn the score into a clock. Not
 * a penalty either, for the more important reason: a transit leaving is
 * the whole of what a transit does, and charging the controller for it
 * would make the correct handling of the traffic the losing move.
 *
 * The transits still cost something, but they cost it in the currency they
 * are actually spent in -- the airspace and the attention an arrival would
 * otherwise have had.
 */
export const TRANSIT_POINTS = 0

export interface Score {
  readonly points: number
  readonly landed: number
  readonly lost: number
  /** Transits seen safely across. Counted, not scored. */
  readonly transited: number
}

export const NO_SCORE: Score = { points: 0, landed: 0, lost: 0, transited: 0 }

/**
 * What one departure is worth, positive or negative.
 *
 * Scaled by the difficulty, because the same landing is not the same
 * achievement at nine an hour and at thirty-four. The penalty scales with
 * it: a setting that paid triple for a landing and charged single for a
 * loss would make the hard settings easier to score well on by being
 * careless, which is backwards.
 */
export function pointsFor(
  departure: Departure,
  // Unscaled unless a setting is given. The base figures are what a
  // landing is worth; the multiplier is a property of the session, so a
  // caller that has not said which session it means gets the plain number.
  difficulty: DifficultySettings = DIFFICULTIES.easy,
): number {
  switch (departure) {
    case 'landed':
      return scaledPoints(LANDING_POINTS, difficulty)
    case 'transited':
      return TRANSIT_POINTS
    case 'left':
      return -scaledPoints(LOST_PENALTY, difficulty)
  }
}

/** The score after one more aircraft has finished with the sector. */
export function scoreDeparture(
  score: Score,
  departure: Departure,
  difficulty: DifficultySettings = DIFFICULTIES.easy,
): Score {
  return {
    points: score.points + pointsFor(departure, difficulty),
    landed: score.landed + (departure === 'landed' ? 1 : 0),
    lost: score.lost + (departure === 'left' ? 1 : 0),
    transited: score.transited + (departure === 'transited' ? 1 : 0),
  }
}
