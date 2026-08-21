import type { TurnDirection } from '../data/airport'
import {
  angleDelta,
  bearingDeg,
  degToRad,
  distanceNM,
  normalizeHeading,
  type Vec2NM,
} from '../core/geo'
import type { Aircraft, HoldClearance } from './types'

/**
 * Flying a holding pattern.
 *
 * The racetrack is not stored anywhere and nothing is timed. Which leg an
 * aircraft is on is read back out of where it is and which way it is
 * pointing, every tick, from the pattern it is carrying:
 *
 *     inbound          heading is inbound-ish, the fix is still ahead
 *     turningOutbound  heading is inbound-ish, the fix is behind
 *     outbound         heading is outbound-ish, less than a leg run off
 *     turningInbound   heading is outbound-ish, a full leg run off
 *
 * That is worth the small amount of trigonometry it costs. A stored leg
 * plus a stored timer is state that has to be initialised on entry,
 * advanced every tick, and thrown away on every command that ends the
 * hold -- and any one of those missed leaves an aircraft circling a leg it
 * finished ten minutes ago. Derived state cannot fall out of step with the
 * aeroplane, and an aircraft dropped into a hold from anywhere, on any
 * heading, joins the pattern without an entry procedure having to be
 * chosen for it.
 *
 * The turns themselves are not drawn: the autopilot's three degrees a
 * second makes them. Aiming the aeroplane at the next track and letting
 * the rate limit do the rest is what produces the two parallel legs and
 * the two half-circles, at the right width, for free -- at 220 kt the
 * pattern comes out 3.7 NM long and 2.3 NM wide, which is what a hold
 * looks like.
 */

/**
 * How far off the current heading a forced turn is ever commanded.
 *
 * A hold turns the published way round, but the autopilot always takes the
 * short way to whatever it is given. Handing it a heading a quarter-turn
 * ahead, and re-aiming as the nose comes round, makes the short way the
 * correct way -- and means a 180 degree reversal, which has no short way,
 * is never ambiguous.
 */
const LEAD_DEG = 90

/** Below this a leg is too short to fly, whatever the aircraft's speed. */
const MIN_LEG_NM = 1

/** Which leg of the racetrack an aircraft is on. */
export type HoldLeg = 'inbound' | 'turningOutbound' | 'outbound' | 'turningInbound'

/**
 * Leg length in miles.
 *
 * Holding legs are published as a time, so their length is whatever the
 * aircraft covers in that time -- a slower aircraft flies a smaller
 * pattern, which is the real behaviour and costs nothing to reproduce.
 */
export function holdLegNM(clearance: HoldClearance, gsKts: number): number {
  return Math.max(MIN_LEG_NM, (clearance.legMins / 60) * Math.max(gsKts, 0))
}

/**
 * Distance along the inbound track, measured from the fix. Negative on the
 * approach side, where the whole pattern lies; positive once the aircraft
 * has crossed the fix.
 */
export function alongTrackNM(pos: Vec2NM, clearance: HoldClearance): number {
  const away = distanceNM(clearance.posNM, pos)
  if (away === 0) return 0
  const off = bearingDeg(clearance.posNM, pos) - clearance.inboundTrue
  return away * Math.cos(degToRad(off))
}

/** A heading that leads the aircraft round the published way. */
export function leadHeading(hdg: number, target: number, turns: TurnDirection): number {
  const rightward = normalizeHeading(target - hdg)
  // Already there is already there, whichever way the pattern turns.
  const signed = turns === 'right' ? rightward : rightward === 0 ? 0 : rightward - 360
  if (Math.abs(signed) <= LEAD_DEG) return normalizeHeading(target)
  return normalizeHeading(hdg + Math.sign(signed) * LEAD_DEG)
}

export function holdLeg(a: Aircraft, clearance: HoldClearance): HoldLeg {
  const inbounding = Math.abs(angleDelta(a.hdg, clearance.inboundTrue)) < 90
  const along = alongTrackNM(a.pos, clearance)

  if (inbounding) return along < 0 ? 'inbound' : 'turningOutbound'
  // Outbound runs the other way down the track, so distance run off the
  // fix is the negative of the along-track figure.
  return -along < holdLegNM(clearance, a.gsKts) ? 'outbound' : 'turningInbound'
}

/**
 * The heading a holding aircraft should be flying, or null if it is not
 * holding -- in which case the controller's own cleared heading stands.
 */
export function holdSteer(a: Aircraft): number | null {
  if (a.navMode !== 'HOLD' || a.hold === null) return null
  const clearance = a.hold
  const outbound = normalizeHeading(clearance.inboundTrue + 180)

  switch (holdLeg(a, clearance)) {
    case 'inbound':
      // Straight at the fix rather than along the inbound track. Coming off
      // the far turn the aircraft is a mile or two to one side, so it cuts
      // the corner in -- which is both simpler and what it looks like on
      // radar.
      return bearingDeg(a.pos, clearance.posNM)

    case 'turningOutbound':
    case 'outbound':
      // One target for both: the lead keeps the reversal going the
      // published way, and once the nose is round it is just the track.
      return leadHeading(a.hdg, outbound, clearance.turns)

    case 'turningInbound':
      return leadHeading(a.hdg, clearance.inboundTrue, clearance.turns)
  }
}
