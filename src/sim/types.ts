import { distanceNM, type Vec2NM } from '../core/geo'
import type { TurnDirection, WakeCategory } from '../data/airport'

/**
 * The aircraft model.
 *
 * Defined ahead of the simulation itself so that everything downstream --
 * the flight strips first -- is written against the real shape rather than
 * a placeholder that has to be unpicked later. Day 1 fills these in and
 * makes them move; nothing here depends on that having happened.
 *
 * The record deliberately holds two parallel sets of fields: what the
 * radar sees, and what the controller has instructed. See ARCHITECTURE.md
 * section 3.
 */

/**
 * Where an aircraft is in its flight, as a state machine rather than a
 * pile of booleans.
 *
 *   SPAWN -> HOLD <-> VECTOR -> LOC_ARMED -> LOC_CAPTURED
 *                                                |
 *                                                v
 *              GO_AROUND <----------- GS_TRACKING -> LANDED -> HANDOFF
 *
 * LNAV sits outside that chain, because it is the one state the controller
 * does not put an aircraft into by talking to it. An aircraft crossing the
 * sector on its own flight plan is in LNAV from the moment it appears; a
 * vector takes it out, and RESUME NAV puts it back. See sim/route.ts.
 */
export type NavMode =
  | 'LNAV'
  | 'HOLD'
  | 'VECTOR'
  | 'LOC_ARMED'
  | 'LOC_CAPTURED'
  | 'GS_TRACKING'
  | 'GO_AROUND'
  | 'LANDED'
  | 'HANDOFF'

/**
 * A holding pattern as it was cleared.
 *
 * The whole racetrack is copied onto the aircraft rather than looked up
 * from the airport every tick, which is what lets the flight model know
 * nothing about the world: a hold, like a heading, is just a clearance the
 * aeroplane is carrying.
 */
export interface HoldClearance {
  readonly fix: string
  readonly posNM: Vec2NM
  /** The inbound leg: the track flown TOWARD the fix, degrees true. */
  readonly inboundTrue: number
  readonly turns: TurnDirection
  readonly legMins: number
}

/**
 * An approach as it was cleared.
 *
 * Carries the whole geometry, like a hold does, so the flight model still
 * knows nothing about the airport: an approach clearance is something the
 * aeroplane is holding, not a lookup into a runway table.
 */
export interface ApproachClearance {
  readonly runway: string
  readonly thresholdNM: Vec2NM
  /** The inbound course: direction of travel on landing, degrees true. */
  readonly courseTrue: number
  readonly thresholdElevationFt: number
  readonly glideslopeDeg: number
  /** Final approach fix, in miles before the threshold. */
  readonly fafDistNM: number
  /**
   * Widest angle off the inbound course the localiser will capture from.
   * This is `ils.minInterceptDeg` in the config, which is 30 -- a maximum
   * intercept angle despite the name it is published under there.
   */
  readonly maxInterceptDeg: number
  /** At or below this before the FAF, or the capture will not arm. */
  readonly interceptAltMaxFt: number
}

/**
 * One point on a route, with its position carried alongside its name.
 *
 * The position travels with the clearance for the same reason the hold's
 * and the approach's do: it is what lets the flight model fly a route
 * without knowing that a chart exists.
 */
export interface RouteLeg {
  readonly fix: string
  readonly posNM: Vec2NM
}

/** A flight plan, as far as this sector is concerned: fixes in order. */
export type Route = readonly RouteLeg[]

/**
 * What an aircraft is here to do.
 *
 * The sector had one kind of traffic and therefore did not need this. It
 * now has two, and almost every rule that matters differs between them: an
 * arrival is sequenced, spaced and landed, and a transit is none of those
 * things -- it crosses and leaves, and leaving is a success rather than
 * the way you lose one.
 */
export type FlightRole = 'arrival' | 'overflight'

/** Every role, for the save file's validator. */
export const ROLES = ['arrival', 'overflight'] as const

/**
 * Beyond this from its fix, an aircraft carrying a hold is still on its way
 * there rather than established in the pattern.
 *
 * A racetrack is about five miles across at holding speed and six and a
 * half at the fastest an arrival enters, so this clears the widest pattern
 * without needing the geometry -- and an arrival appears a good deal
 * further out than that, so the two states are never confused.
 */
const JOINING_NM = 7

/** Which way the Mode C readout is moving. */
export type AltitudeTrend = 'climb' | 'descend' | 'level'

export interface Aircraft {
  /* identity */
  readonly callsign: string
  readonly type: string
  readonly wake: WakeCategory
  /** Arrival or transit. See FlightRole. */
  readonly role: FlightRole

  /* ACTUAL state -- what the radar sees */
  readonly pos: Vec2NM
  readonly altFt: number
  readonly hdg: number
  /** Airspeed: what it is flying through the air, and what a speed
   * clearance assigns. */
  readonly iasKts: number
  /**
   * Groundspeed: what it is actually making good.
   *
   * Derived every step from the distance covered rather than commanded --
   * the controller assigns an airspeed and the wind decides the rest, so an
   * aircraft downwind reads faster than the same aircraft upwind. Stored
   * rather than worked out on demand for the same reason `vsFpm` is: it is
   * a readout, and the data block and the strip both want it.
   */
  readonly gsKts: number
  readonly vsFpm: number

  /* CLEARED state -- what the controller has instructed */
  readonly clearedHdg: number | null
  readonly clearedAltFt: number
  readonly clearedSpdKts: number
  readonly navMode: NavMode
  /** The approach being flown once one has been cleared, and null before. */
  readonly clearedApproach: ApproachClearance | null
  /** The pattern being flown while `navMode` is HOLD, and null otherwise. */
  readonly hold: HoldClearance | null
  /**
   * The filed route. Empty for an arrival, which is vectored rather than
   * self-navigating, and the whole crossing for a transit.
   *
   * Kept whole rather than consumed as it is flown, so the fixes already
   * passed are still there to be read back -- and so RESUME NAV after a
   * long vector has something to rejoin.
   */
  readonly route: Route
  /** How far down `route` the aircraft has got. Its length once finished. */
  readonly routeLeg: number

  /* bookkeeping */
  /** The feeder fix this arrival entered on. */
  readonly originFix: string | null
  /**
   * Where a transit is going, as an ICAO code, and null for an arrival --
   * which is going here.
   *
   * On the strip and in the data block it is the whole reason the aircraft
   * is not the controller's problem: "EGKK" says at a glance that this one
   * is somebody else's arrival passing through.
   */
  readonly destination: string | null
  /**
   * Whether this aircraft has been inside the area of responsibility yet.
   *
   * Arrivals are released outside it and fly in, so being outside the
   * boundary means one of two opposite things -- not yours yet, or gone --
   * and nothing about the position distinguishes them. This does. It also
   * answers the only question the interface asks about an aircraft before
   * it will accept a clearance for it.
   */
  readonly entered: boolean
  /**
   * Past positions, newest first. One point per radar sweep rather than one
   * per simulation step, or a twenty-hertz simulation would bank a thousand
   * points a minute for a trail six long.
   */
  readonly trail: readonly Vec2NM[]
  /** Simulated time the last trail point was laid down. */
  readonly trailAt: number
  readonly spawnedAt: number
}

/** Heavy and super both get an indicator on the strip and the data block. */
export function isHeavy(wake: WakeCategory): boolean {
  return wake === 'H' || wake === 'J'
}

/** Vertical trend, with a deadband so a level aircraft does not flicker. */
export function trendOf(vsFpm: number, deadbandFpm = 100): AltitudeTrend {
  if (vsFpm > deadbandFpm) return 'climb'
  if (vsFpm < -deadbandFpm) return 'descend'
  return 'level'
}

/** Mode C style: altitude in hundreds of feet, three digits. */
export function modeC(altFt: number): string {
  return String(Math.round(altFt / 100)).padStart(3, '0')
}

/**
 * A single line of plain language for the strip's status row. Kept here
 * rather than in the DOM so the wording has one home and the strip bay
 * needs no knowledge of the state machine.
 */
export function statusText(a: Aircraft): string {
  switch (a.navMode) {
    case 'LNAV': {
      // The fix it is going to, because that is the question asked of a
      // transit: not what it was told, but where it will be.
      const next = a.route[a.routeLeg]
      if (next === undefined) return a.destination === null ? 'OWN NAV' : `OWN NAV ${a.destination}`
      return `VIA ${next.fix}`
    }
    case 'HOLD': {
      // The hold it was sent to, not the one it arrived over -- they are
      // usually the same fix and occasionally are not.
      const fix = a.hold?.fix ?? a.originFix
      if (fix === null || fix === undefined) return 'HOLDING'
      // Arrivals route to their fix before they get there, and "HOLDING"
      // for something twelve miles away would be a lie about the one thing
      // the controller is deciding: whether it needs dealing with yet.
      if (a.hold !== null && distanceNM(a.pos, a.hold.posNM) > JOINING_NM) {
        return `TO ${fix}`
      }
      return `HOLDING ${fix}`
    }
    case 'VECTOR':
      return 'VECTORING'
    case 'LOC_ARMED':
      return a.clearedApproach ? `CLEARED ILS ${a.clearedApproach.runway}` : 'APPROACH ARMED'
    case 'LOC_CAPTURED':
      return a.clearedApproach ? `LOC ${a.clearedApproach.runway}` : 'LOCALIZER'
    case 'GS_TRACKING':
      return a.clearedApproach ? `ESTABLISHED ${a.clearedApproach.runway}` : 'ESTABLISHED'
    case 'GO_AROUND':
      return 'GO AROUND'
    case 'LANDED':
      return 'LANDED'
    case 'HANDOFF':
      return 'HANDOFF'
  }
}

