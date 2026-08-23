import { bearingDeg, degToRad, distanceNM, type Vec2NM } from '../core/geo'
import { turnRadiusNM } from './hold'
import type { Aircraft, Route } from './types'

/**
 * Flying a route: an aircraft navigating itself from fix to fix.
 *
 * The sector had two kinds of guidance before this -- an approach, which
 * flies the aeroplane down a beam, and a hold, which flies it round a
 * racetrack -- and both are things the controller hands out. This is the
 * third kind and the odd one: it is what an aircraft does when the
 * controller is not talking to it. Overflights spend almost their whole
 * time in the sector under it.
 *
 * Written to the same rule as the other two: the whole route is copied onto
 * the aircraft, so the flight model still knows nothing about the world. A
 * route, like a hold, is a clearance the aeroplane is carrying rather than
 * a lookup into a table of fixes.
 *
 * Pure throughout. Given the same aircraft it returns the same guidance,
 * which is what keeps a session replayable.
 */

/**
 * The widest course change the anticipation formula is allowed to see.
 *
 * A fly-by turn starts `r * tan(delta / 2)` before the fix, which runs away
 * to infinity as the turn approaches a reversal. Real navigation databases
 * cap it and so does this: past 120 degrees the aircraft simply overflies
 * the fix and turns after it, which is what actually happens.
 */
const MAX_ANTICIPATED_TURN_DEG = 120

/**
 * How close counts as passing a fix when there is no turn to anticipate.
 *
 * Without a floor, a leg continuing dead straight ahead would need to be
 * crossed exactly, and a fix missed by a tenth of a mile would never
 * sequence -- the aircraft would fly to it for ever, turning back on
 * itself as it went by.
 */
const MIN_SEQUENCE_NM = 0.6

/**
 * Where the turn onto the next leg begins.
 *
 * This is the standard fly-by geometry -- the tangent distance for a turn
 * of `courseChangeDeg` at this speed -- and it is why an aircraft on a
 * route cuts the corner instead of overflying every fix and then turning.
 * At 250 kt a 90 degree turn starts about two miles out.
 */
export function anticipationNM(gsKts: number, courseChangeDeg: number): number {
  const change = Math.min(Math.abs(courseChangeDeg), MAX_ANTICIPATED_TURN_DEG)
  const tangent = turnRadiusNM(gsKts) * Math.tan(degToRad(change / 2))
  return Math.max(MIN_SEQUENCE_NM, tangent)
}

/** The leg being flown to, or null once the route is finished. */
export function activeLeg(a: Aircraft): Vec2NM | null {
  const leg = a.route[a.routeLeg]
  return leg === undefined ? null : leg.posNM
}

/** The name of the fix being flown to, or null once the route is finished. */
export function activeFix(a: Aircraft): string | null {
  return a.route[a.routeLeg]?.fix ?? null
}

/** Everything still to be flown, including the leg currently active. */
export function legsRemaining(a: Aircraft): Route {
  return a.route.slice(a.routeLeg)
}

/** True once every fix on the route has been passed. */
export function routeComplete(a: Aircraft): boolean {
  return a.routeLeg >= a.route.length
}

/**
 * The course change waiting at the active fix, in degrees.
 *
 * Zero on the last leg: there is nothing after it to turn onto, so the
 * aircraft flies over the fix rather than cutting a corner that is not
 * there.
 */
function turnAtActiveFix(a: Aircraft): number {
  const here = a.route[a.routeLeg]
  const next = a.route[a.routeLeg + 1]
  if (here === undefined || next === undefined) return 0
  const inbound = bearingDeg(a.pos, here.posNM)
  const outbound = bearingDeg(here.posNM, next.posNM)
  return Math.abs(((outbound - inbound + 540) % 360) - 180)
}

/**
 * How far along the route the aircraft has got, after this step.
 *
 * Sequencing is by distance rather than by crossing a line: an aircraft
 * blown off track by the wind, or one rejoining after a vector, still has
 * to be able to get past a fix it will never fly exactly over.
 *
 * More than one fix can fall in a single call. A short leg taken fast can
 * be swallowed whole by the anticipation distance of the one after it, and
 * stopping at the first would leave the aircraft turning back to a fix it
 * had already gone by.
 */
export function sequenceRoute(a: Aircraft): number {
  let leg = a.routeLeg
  // Bounded by the length of the route, so a degenerate case cannot spin.
  while (leg < a.route.length) {
    const at = a.route[leg]
    if (at === undefined) break
    const stepped = { ...a, routeLeg: leg }
    if (distanceNM(a.pos, at.posNM) > anticipationNM(a.gsKts, turnAtActiveFix(stepped))) {
      break
    }
    leg += 1
  }
  return leg
}

/**
 * The heading to fly to make good the active leg, or null when there is no
 * leg to fly.
 *
 * Straight at the fix. No wind correction: the aircraft is blown off track
 * exactly as an aircraft is, and steering at the fix every tick is itself
 * the correction -- which is both simpler than solving the triangle and a
 * better picture of what a real track looks like in a crosswind.
 */
export function routeSteer(a: Aircraft): number | null {
  const to = activeLeg(a)
  if (to === null) return null
  // Standing on the fix, the bearing to it is meaningless. Hold the
  // current heading for the tick it takes to sequence past it.
  if (distanceNM(a.pos, to) < 1e-6) return a.hdg
  return bearingDeg(a.pos, to)
}

/** What the route wants of the aircraft this step, or null if it wants nothing. */
export interface RouteGuidance {
  readonly routeLeg: number
  readonly clearedHdg: number
}

/**
 * One step of self-navigation: sequence first, then steer.
 *
 * That order matters, and it is the same reason the approach steps its
 * state before it steers: an aircraft that has just passed a fix should
 * turn onto the next leg on this tick, not spend one more tick flying at
 * a fix behind it.
 *
 * Returns null for an aircraft not flying a route, and for one that has
 * run out of route -- which leaves the last cleared heading standing, so a
 * transit that has crossed its final fix carries on out of the sector on
 * the track it was making good rather than stopping dead or turning.
 */
export function routeGuidance(a: Aircraft): RouteGuidance | null {
  if (a.navMode !== 'LNAV') return null
  const routeLeg = sequenceRoute(a)
  const steer = routeSteer({ ...a, routeLeg })
  if (steer === null) {
    // Out of legs. Keep the leg count honest so the readouts can say the
    // route is finished, and let the heading stand.
    return a.routeLeg === routeLeg ? null : { routeLeg, clearedHdg: a.clearedHdg ?? a.hdg }
  }
  return { routeLeg, clearedHdg: steer }
}

/**
 * Which leg to pick up on when the controller hands navigation back.
 *
 * The aircraft has been vectored, so it is somewhere its route did not
 * send it, and the leg it was on when the vector started may well be
 * behind it now. Rejoining that one would turn it round.
 *
 * The rule is to go forwards only: advance while the following fix is the
 * closer of the two. That takes an aircraft vectored past a fix on to the
 * next one, leaves an aircraft vectored off to the side rejoining the leg
 * it was already flying, and can never send one back to a fix it has
 * already crossed.
 */
export function rejoinLeg(a: Aircraft): number {
  let leg = Math.max(0, Math.min(a.routeLeg, a.route.length))
  while (leg + 1 < a.route.length) {
    const here = a.route[leg]
    const next = a.route[leg + 1]
    if (here === undefined || next === undefined) break
    if (distanceNM(a.pos, here.posNM) <= distanceNM(a.pos, next.posNM)) break
    leg += 1
  }
  return leg
}

/**
 * The route as it would be read on a strip: the fixes still to come.
 *
 * Truncated, because a strip has one line for this and a transit can be
 * carrying half a dozen fixes. The ones nearest are the ones being flown.
 */
export function routeText(a: Aircraft, limit = 3): string {
  const ahead = legsRemaining(a)
  if (ahead.length === 0) return ''
  const shown = ahead.slice(0, limit).map((l) => l.fix)
  return ahead.length > limit ? `${shown.join(' ')}..` : shown.join(' ')
}
