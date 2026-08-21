import type { WakeCategory } from '../data/airport'

/**
 * How far apart two arrivals have to be.
 *
 * This lives in code rather than in egll.json because it is not a property
 * of Heathrow: the wake turbulence minima are the same at every airport,
 * and a per-airport copy is a per-airport chance to get them wrong.
 *
 * Source: ICAO Doc 4444, distance-based wake turbulence radar separation
 * minima for arriving aircraft, expressed as the gap required BEHIND a
 * leader of each category.
 */

/**
 * The plain radar minimum on final, with no wake requirement in play. UK
 * practice, and the floor under every pair.
 */
export const RADAR_MINIMUM_NM = 3

/**
 * Minima behind each leader, in nautical miles. A pair not listed has no
 * wake requirement and falls back to the radar minimum.
 *
 * Super behind super is not in the published table -- it is a pairing that
 * barely happens -- so it is **assumed** to be the heavy-behind-heavy
 * figure. That is flagged rather than quietly invented, in the same spirit
 * as the assumed vertical limits in the airspace data.
 */
const BEHIND: Record<WakeCategory, Partial<Record<WakeCategory, number>>> = {
  J: { J: 4, H: 6, M: 7, L: 8 },
  H: { H: 4, M: 5, L: 6 },
  M: { L: 5 },
  L: {},
}

/** The gap a follower needs behind a given leader. */
export function requiredGapNM(leader: WakeCategory, follower: WakeCategory): number {
  return Math.max(RADAR_MINIMUM_NM, BEHIND[leader][follower] ?? 0)
}

/**
 * Whether a wake category pair needs more than the radar minimum. Useful
 * for saying *why* a gap is what it is.
 */
export function isWakePair(leader: WakeCategory, follower: WakeCategory): boolean {
  return requiredGapNM(leader, follower) > RADAR_MINIMUM_NM
}
