import {
  advance,
  angleDelta,
  distanceNM,
  normalizeHeading,
  type Vec2NM,
} from '../core/geo'
import { autopilot, STANDARD_RATES, type Rates } from './autopilot'
import { isControlled, type ControlZone } from './airspace'
import { holdSteer } from './hold'
import { ilsGuidance } from './ils'
import type { Aircraft } from './types'

/**
 * Flight physics: where an aircraft goes, and the trail it leaves behind.
 *
 * The step is always passed in rather than measured, because the loop runs
 * a fixed 50 ms tick and the whole point of that is a simulation that does
 * not depend on frame rate. Everything here is pure: given the same
 * aircraft and the same step it produces the same result, which is what
 * makes a session replayable.
 */

/** Points kept in the history trail. */
export const TRAIL_POINTS = 5

/**
 * Simulated seconds between trail points, standing in for the sweep of the
 * antenna. Real returns arrive once per rotation, and drawing one per
 * simulation step would be both wrong and a thousand points a minute.
 */
export const TRAIL_INTERVAL_SECONDS = 4

const SECONDS_PER_HOUR = 3600

/** The airport reference point, which world space is anchored on. */
const ORIGIN_NM: Vec2NM = { x: 0, y: 0 }

/**
 * Advance a position along the track flown during the step.
 *
 * The heading used is the midpoint between where the turn started and
 * where it ended, so a turning aircraft traces the arc instead of cutting
 * the chord. At a fifty-millisecond step the difference is a fraction of a
 * metre, but it costs one line and it stops error accumulating through a
 * long turn.
 */
export function advancePosition(
  pos: Vec2NM,
  hdgFrom: number,
  hdgTo: number,
  gsKts: number,
  dtSeconds: number,
): Vec2NM {
  if (dtSeconds <= 0 || gsKts <= 0) return pos
  const distNM = (gsKts / SECONDS_PER_HOUR) * dtSeconds
  const mid = normalizeHeading(hdgFrom + angleDelta(hdgFrom, hdgTo) / 2)
  return advance(pos, mid, distNM)
}

/**
 * Lay down a trail point if the sweep is due.
 *
 * The point recorded is where the aircraft was, not where it now is, so the
 * trail sits behind the target rather than under it.
 */
export function stepTrail(
  a: Aircraft,
  previousPos: Vec2NM,
  elapsedSeconds: number,
): { readonly trail: readonly Vec2NM[]; readonly trailAt: number } {
  // A hair of tolerance: simulated time is a tick count times a step that
  // has no exact binary form, so a sweep boundary can land just short of
  // the interval. Without this a trail point is silently skipped.
  const EPSILON = 1e-9
  if (elapsedSeconds - a.trailAt < TRAIL_INTERVAL_SECONDS - EPSILON) {
    return { trail: a.trail, trailAt: a.trailAt }
  }
  return {
    // Newest first, so a renderer can fade by index without counting.
    trail: [previousPos, ...a.trail].slice(0, TRAIL_POINTS),
    trailAt: elapsedSeconds,
  }
}

/**
 * One simulation step for one aircraft: fly the autopilot, move, then
 * record the trail.
 *
 * That order matters. The autopilot decides the heading for this step, the
 * move uses it, and the trail records where the aircraft was before it.
 */
export function stepAircraft(
  a: Aircraft,
  dtSeconds: number,
  elapsedSeconds: number,
  rates: Rates = STANDARD_RATES,
): Aircraft {
  // An aircraft on an approach is flown by the approach, one in a hold by
  // the pattern, and anything else by whatever the controller last said.
  // The approach comes first because it is the one that ends the flight.
  const guided = ilsGuidance(a)

  // Down and stopped. It keeps its last position for the tick it takes the
  // world to notice, rather than rolling on through the airfield.
  if (guided !== null && guided.navMode === 'LANDED') {
    return { ...a, ...guided, altFt: guided.clearedAltFt, vsFpm: 0 }
  }

  // A holding aircraft navigates itself: the pattern picks the heading and
  // the controller's cleared heading is set aside until a vector ends the
  // hold. Level and speed are untouched, because a hold is a track and not
  // a different aeroplane.
  const steer = guided === null ? holdSteer(a) : null
  const flying =
    guided !== null ? { ...a, ...guided } : steer === null ? a : { ...a, clearedHdg: steer }
  const flown = autopilot(flying, dtSeconds, rates)
  const pos = advancePosition(a.pos, a.hdg, flown.hdg, flown.gsKts, dtSeconds)
  const trail = stepTrail(a, a.pos, elapsedSeconds)

  return {
    ...a,
    // Whatever the approach decided about mode, track and level stands on
    // the record, or the next tick would start it over from armed.
    ...(guided ?? {}),
    hdg: flown.hdg,
    altFt: flown.altFt,
    vsFpm: flown.vsFpm,
    gsKts: flown.gsKts,
    pos,
    trail: trail.trail,
    trailAt: trail.trailAt,
  }
}

/** Distance flown over a step, in nautical miles. */
/** Why an aircraft has come off the scope, or null while it is still on it. */
export type Departure = 'landed' | 'left'

/**
 * Inside the area of responsibility, and therefore the controller's to
 * work. Traffic outside it can be seen and not touched.
 *
 * The area of responsibility is the published controlled airspace, so this
 * is a three-dimensional question: an aircraft below the base of the TMA
 * and outside the CTR is in nobody's airspace, however close to the field
 * it is. See sim/airspace.ts.
 */
export function isInSector(a: Aircraft, zone: ControlZone): boolean {
  return isControlled(zone, a.pos, a.altFt)
}

/**
 * Whether this aircraft is finished with the sector, and why.
 *
 * One rule, in one place, so that both reasons are accounted for. The
 * boundary used is the sector radius itself -- the circle the scope
 * actually draws -- because a target that vanishes five miles outside the
 * only line on the display looks exactly like a bug, and for a while it
 * was indistinguishable from one.
 *
 * `entered` is what separates the two opposite meanings of being outside
 * the boundary. Arrivals are released beyond it and fly in, so position
 * alone cannot tell an aircraft that has not arrived from one that has
 * gone.
 */
export function departureOf(
  a: Aircraft,
  zone: ControlZone,
  outerLimitNM = Number.POSITIVE_INFINITY,
): Departure | null {
  if (a.navMode === 'LANDED') return 'landed'
  if (a.entered && !isInSector(a, zone)) return 'left'
  // A backstop for the other direction. Inbound traffic that turns away
  // never enters, so the rule above can never fire for it and it would fly
  // outward for ever, counted in the cap and drawn on a zoomed-out scope.
  // Nothing exists beyond the ring arrivals are released on.
  if (distanceNM(ORIGIN_NM, a.pos) > outerLimitNM) return 'left'
  return null
}

/** Marks an inbound aircraft as the controller's, the first time it is. */
export function enterSector(a: Aircraft, zone: ControlZone): Aircraft {
  return !a.entered && isInSector(a, zone) ? { ...a, entered: true } : a
}

export function distanceFlownNM(gsKts: number, dtSeconds: number): number {
  return (gsKts / SECONDS_PER_HOUR) * Math.max(0, dtSeconds)
}
