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

/**
 * Landing one that had declared an emergency is worth double.
 *
 * Not because it is twice the work -- it is often less, since everything
 * else gets pushed out of the way -- but because it is the whole of the
 * exercise while it lasts. A controller who breaks a good sequence to get
 * one down has done the right thing and lost the spacing they spent ten
 * minutes building, and the score has to say that was right or it teaches
 * the opposite.
 */
export const EMERGENCY_LANDING_POINTS = 200

/**
 * And losing one costs four times an ordinary loss.
 *
 * An arrival that leaves without landing is a mistake. An emergency that
 * leaves without landing is the one outcome this simulation has that is
 * meant to feel bad.
 */
export const EMERGENCY_LOST_PENALTY = 200

export interface Score {
  readonly points: number
  readonly landed: number
  readonly lost: number
  /** Transits seen safely across. Counted, not scored. */
  readonly transited: number
  /** Emergencies landed. Counted separately: it is the headline of a shift. */
  readonly emergencies: number
}

export const NO_SCORE: Score = {
  points: 0,
  landed: 0,
  lost: 0,
  transited: 0,
  emergencies: 0,
}

/** What was true of the aircraft, where that changes what it is worth. */
export interface DepartureFacts {
  /** It was squawking 7600 or 7700 when it finished with the sector. */
  readonly emergency: boolean
}

const ORDINARY: DepartureFacts = { emergency: false }

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
  facts: DepartureFacts = ORDINARY,
): number {
  switch (departure) {
    case 'landed':
      return scaledPoints(
        facts.emergency ? EMERGENCY_LANDING_POINTS : LANDING_POINTS,
        difficulty,
      )
    case 'transited':
      // A transit that declared an emergency and then left the sector did
      // not divert here, which is its own kind of relief and nobody's
      // achievement. Still nothing, the way an ordinary crossing is.
      return TRANSIT_POINTS
    case 'left':
      return -scaledPoints(
        facts.emergency ? EMERGENCY_LOST_PENALTY : LOST_PENALTY,
        difficulty,
      )
  }
}

/** The score after one more aircraft has finished with the sector. */
export function scoreDeparture(
  score: Score,
  departure: Departure,
  difficulty: DifficultySettings = DIFFICULTIES.easy,
  facts: DepartureFacts = ORDINARY,
): Score {
  return {
    points: score.points + pointsFor(departure, difficulty, facts),
    landed: score.landed + (departure === 'landed' ? 1 : 0),
    lost: score.lost + (departure === 'left' ? 1 : 0),
    transited: score.transited + (departure === 'transited' ? 1 : 0),
    emergencies:
      score.emergencies + (departure === 'landed' && facts.emergency ? 1 : 0),
  }
}
