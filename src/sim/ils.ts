import {
  advance,
  angleDelta,
  bearingDeg,
  degToRad,
  distanceNM,
  glidepathRiseFt,
  normalizeHeading,
  type Vec2NM,
} from '../core/geo'
import type { Aircraft, ApproachClearance, NavMode } from './types'

/**
 * Flying an ILS approach.
 *
 * `CLEARED ILS` only **arms** the capture. Every tick the armed test asks
 * all five questions together, and an aircraft that fails any of them
 * simply flies on through on the vector it was given -- which is what
 * really happens, and what makes setting up an intercept a job worth doing:
 *
 *   1. it is on the approach side of the threshold      (not behind it)
 *   2. it is inside localiser coverage
 *   3. it is within half a beam width of the centreline
 *   4. it is within `maxInterceptDeg` of the inbound course
 *   5. it is at or below the intercept altitude
 *
 * plus a sixth that the design doc calls for and the first five do not
 * cover: that the offset is actually **closing**. Without it an aircraft
 * tracking parallel to the localiser a mile out, or drifting away from it
 * at twenty degrees, would capture; with it, only an aircraft pointed at
 * the centreline does.
 *
 * Once captured, the centreline is flown by aiming at a point on it a
 * couple of miles ahead rather than by correcting in proportion to the
 * offset. That is inherently damped -- the intercept angle shrinks as the
 * aircraft converges, with no gain to tune and no oscillation about the
 * beam -- and it costs one line more than the naive version.
 */

/** Published localiser coverage. Beyond this there is no beam to capture. */
export const LOC_RANGE_NM = 25

/** Half a beam width, near enough: how close counts as on the localiser. */
export const LOC_CAPTURE_NM = 1.5

/**
 * Inside this of the centreline an aircraft counts as on it, and the
 * closing test is waived.
 *
 * Roughly half-scale deflection at the final approach fix. It has to be a
 * real distance rather than nothing: an aircraft vectored onto the
 * localiser heading a couple of hundred yards off the centreline is
 * flying exactly parallel to it, which is not closing by any measure, and
 * refusing that capture would be refusing the normal case.
 */
const ON_COURSE_NM = 0.3

/**
 * How far ahead on the centreline the aircraft aims once established.
 * Shorter tracks more tightly and starts to weave; longer is placid and
 * slow to close the last of the offset.
 */
export const AIM_LEAD_NM = 2

/** The glideslope is armed from a little outside the final approach fix. */
export const GS_ARM_NM = 2

/** Where an aircraft is relative to the approach it is flying. */
export interface ApproachGeometry {
  /** Miles to the threshold along the course. Negative once past it. */
  readonly toRunNM: number
  /** Offset from the centreline, positive to the right of the course. */
  readonly offsetNM: number
}

export function approachGeometry(pos: Vec2NM, app: ApproachClearance): ApproachGeometry {
  const away = distanceNM(app.thresholdNM, pos)
  if (away === 0) return { toRunNM: 0, offsetNM: 0 }
  const off = degToRad(bearingDeg(app.thresholdNM, pos) - app.courseTrue)
  return {
    // Negated because the approach side of the threshold is behind it as
    // the course points.
    toRunNM: -away * Math.cos(off),
    offsetNM: away * Math.sin(off),
  }
}

/** Altitude of the glidepath at a distance out, in feet AMSL. */
export function glidepathAltFt(app: ApproachClearance, toRunNM: number): number {
  return app.thresholdElevationFt + glidepathRiseFt(app.glideslopeDeg, Math.max(0, toRunNM))
}

/** Whether the localiser would capture, on this tick, from here. */
export function canCapture(a: Aircraft, app: ApproachClearance): boolean {
  const g = approachGeometry(a.pos, app)

  // On the approach side, and in range of the beam. Checking the side is
  // what stops an aircraft capturing from beyond the runway and flying the
  // approach backwards.
  if (g.toRunNM <= 0 || g.toRunNM > LOC_RANGE_NM) return false
  if (Math.abs(g.offsetNM) > LOC_CAPTURE_NM) return false

  // Angle off the course. Thirty degrees at Heathrow, from the config.
  const toCourse = angleDelta(a.hdg, app.courseTrue)
  if (Math.abs(toCourse) > app.maxInterceptDeg) return false

  // At or below the platform altitude before the fix.
  if (a.altFt > app.interceptAltMaxFt) return false

  // And closing. An aircraft right of the centreline has to be pointing
  // left of the course to be converging on it, and the other way about --
  // so the two signs agree when it is closing and disagree when it is
  // drifting off. Already on the centreline needs neither.
  if (Math.abs(g.offsetNM) <= ON_COURSE_NM) return true
  return g.offsetNM * toCourse > 0
}

/**
 * The heading that flies the centreline: the bearing to a point on it a
 * couple of miles ahead, or to the threshold itself once inside that.
 */
export function trackHeading(a: Aircraft, app: ApproachClearance): number {
  const g = approachGeometry(a.pos, app)
  const aheadNM = Math.max(0, g.toRunNM - AIM_LEAD_NM)
  const aim = advance(app.thresholdNM, app.courseTrue + 180, aheadNM)
  return normalizeHeading(bearingDeg(a.pos, aim))
}

/** What the approach is flying, or null for an aircraft not on one. */
export type Guidance = Pick<Aircraft, 'clearedHdg' | 'clearedAltFt' | 'navMode'>

export function ilsGuidance(a: Aircraft): Guidance | null {
  const app = a.clearedApproach
  if (app === null) return null

  switch (a.navMode) {
    case 'LOC_ARMED':
      // Nothing to fly yet. The vector the controller gave it stands until
      // the beam is actually captured, so an aircraft lined up badly flies
      // straight through and has to be taken round again.
      if (!canCapture(a, app)) return null
      return established(a, app, 'LOC_CAPTURED')

    case 'LOC_CAPTURED': {
      const g = approachGeometry(a.pos, app)
      if (g.toRunNM <= 0) return touchdown(app)
      // The glidepath descends onto a level aircraft rather than the other
      // way about, so it is captured when it comes down to us.
      const path = glidepathAltFt(app, g.toRunNM)
      const armed = g.toRunNM <= app.fafDistNM + GS_ARM_NM
      if (armed && path <= a.altFt) return established(a, app, 'GS_TRACKING')
      return established(a, app, 'LOC_CAPTURED')
    }

    case 'GS_TRACKING': {
      const g = approachGeometry(a.pos, app)
      if (g.toRunNM <= 0) return touchdown(app)
      return {
        navMode: 'GS_TRACKING',
        clearedHdg: trackHeading(a, app),
        clearedAltFt: glidepathAltFt(app, g.toRunNM),
      }
    }

    default:
      return null
  }
}

/** Tracking the localiser, holding whatever level it was given. */
function established(a: Aircraft, app: ApproachClearance, navMode: NavMode): Guidance {
  return {
    navMode,
    clearedHdg: trackHeading(a, app),
    clearedAltFt:
      navMode === 'GS_TRACKING'
        ? glidepathAltFt(app, approachGeometry(a.pos, app).toRunNM)
        : a.clearedAltFt,
  }
}

function touchdown(app: ApproachClearance): Guidance {
  return {
    navMode: 'LANDED',
    clearedHdg: app.courseTrue,
    clearedAltFt: app.thresholdElevationFt,
  }
}

/** True while an aircraft is on an approach, at any stage of it. */
export function onApproach(navMode: NavMode): boolean {
  return navMode === 'LOC_ARMED' || navMode === 'LOC_CAPTURED' || navMode === 'GS_TRACKING'
}
