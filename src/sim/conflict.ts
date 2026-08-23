import { distanceNM } from '../core/geo'
import { RADAR_MINIMUM_NM } from './separation'
import type { Aircraft } from './types'

/**
 * Whether two aircraft are too close, right now.
 *
 * The sector has always known how far apart aircraft are *supposed* to be
 * -- sim/separation.ts carries the wake minima, and the strip bay marks a
 * pair as tight -- but only along the approach, and only as advice. This
 * answers the other question: are any two of these actually inside the
 * minimum, this instant, anywhere on the display.
 *
 * That is a different rule and it is worth being precise about. Separation
 * is three-dimensional and it takes BOTH to be lost: two aircraft a mile
 * apart laterally are perfectly separated if one is a thousand feet above
 * the other, which is the whole principle a holding stack is built on. A
 * check that looked only at the plan view would report every stack at
 * every fix as a breach.
 */

/** The lateral minimum. Radar separation, from the wake table's floor. */
export const SEPARATION_NM = RADAR_MINIMUM_NM

/**
 * And the vertical one. A thousand feet is what a stack is built in, so
 * this is the figure that makes four aircraft over one fix legal.
 *
 * At or above it is separated: a pair exactly a thousand feet apart is the
 * normal, correct state of two aircraft in a stack, not a near miss.
 */
export const SEPARATION_FT = 1000

export interface Conflict {
  /** The two callsigns, in a stable order so a pair reads the same twice. */
  readonly a: string
  readonly b: string
  readonly distanceNM: number
  readonly verticalFt: number
}

/**
 * Whether this aircraft counts for separation at all.
 *
 * Three exclusions, each for a different reason. One on the ground has
 * landed and is no longer traffic. One that has not entered the airspace is
 * not the controller's to separate. And one already on the runway
 * centreline behind another is still subject to the minimum, so there is
 * deliberately no exclusion for being on an approach -- the whole point of
 * sequencing is that the gap survives all the way to the threshold.
 */
function counts(a: Aircraft): boolean {
  return a.navMode !== 'LANDED' && a.entered
}

/** True when this pair is inside both minima at once. */
export function isConflict(a: Aircraft, b: Aircraft): boolean {
  if (!counts(a) || !counts(b)) return false
  if (Math.abs(a.altFt - b.altFt) >= SEPARATION_FT) return false
  return distanceNM(a.pos, b.pos) < SEPARATION_NM
}

/**
 * Every pair currently inside the minima.
 *
 * Each pair once, not twice: the inner loop starts past the outer one, so
 * a breach is one entry rather than one from each aircraft's point of view.
 */
export function conflictsIn(traffic: readonly Aircraft[]): Conflict[] {
  const out: Conflict[] = []
  for (let i = 0; i < traffic.length; i += 1) {
    const a = traffic[i]
    if (a === undefined || !counts(a)) continue
    for (let j = i + 1; j < traffic.length; j += 1) {
      const b = traffic[j]
      if (b === undefined || !counts(b)) continue
      if (!isConflict(a, b)) continue
      // Sorted, so the same pair produces the same record however the
      // traffic list happens to be ordered this tick.
      const [first, second] = a.callsign <= b.callsign ? [a, b] : [b, a]
      out.push({
        a: first.callsign,
        b: second.callsign,
        distanceNM: distanceNM(a.pos, b.pos),
        verticalFt: Math.abs(a.altFt - b.altFt),
      })
    }
  }
  return out
}

/** Every callsign involved in a breach, for marking them on the scope. */
export function inConflict(traffic: readonly Aircraft[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const c of conflictsIn(traffic)) {
    out.add(c.a)
    out.add(c.b)
  }
  return out
}
