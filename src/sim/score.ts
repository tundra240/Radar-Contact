import type { Departure } from './aircraft'

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

/** What one departure is worth, positive or negative. */
export function pointsFor(departure: Departure): number {
  switch (departure) {
    case 'landed':
      return LANDING_POINTS
    case 'transited':
      return TRANSIT_POINTS
    case 'left':
      return -LOST_PENALTY
  }
}

/** The score after one more aircraft has finished with the sector. */
export function scoreDeparture(score: Score, departure: Departure): Score {
  return {
    points: score.points + pointsFor(departure),
    landed: score.landed + (departure === 'landed' ? 1 : 0),
    lost: score.lost + (departure === 'left' ? 1 : 0),
    transited: score.transited + (departure === 'transited' ? 1 : 0),
  }
}
