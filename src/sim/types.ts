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
 * Where an aircraft is in its arrival, as a state machine rather than a
 * pile of booleans.
 *
 *   SPAWN -> HOLD <-> VECTOR -> LOC_ARMED -> LOC_CAPTURED
 *                                                |
 *                                                v
 *              GO_AROUND <----------- GS_TRACKING -> LANDED -> HANDOFF
 */
export type NavMode =
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

  /* ACTUAL state -- what the radar sees */
  readonly pos: Vec2NM
  readonly altFt: number
  readonly hdg: number
  readonly gsKts: number
  readonly vsFpm: number

  /* CLEARED state -- what the controller has instructed */
  readonly clearedHdg: number | null
  readonly clearedAltFt: number
  readonly clearedSpdKts: number
  readonly navMode: NavMode
  /** Runway identifier once an approach clearance has been issued. */
  readonly clearedApproach: string | null
  /** The pattern being flown while `navMode` is HOLD, and null otherwise. */
  readonly hold: HoldClearance | null

  /* bookkeeping */
  /** The feeder fix this arrival entered on. */
  readonly originFix: string | null
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
      return a.clearedApproach ? `CLEARED ILS ${a.clearedApproach}` : 'APPROACH ARMED'
    case 'LOC_CAPTURED':
      return a.clearedApproach ? `LOC ${a.clearedApproach}` : 'LOCALIZER'
    case 'GS_TRACKING':
      return a.clearedApproach ? `ESTABLISHED ${a.clearedApproach}` : 'ESTABLISHED'
    case 'GO_AROUND':
      return 'GO AROUND'
    case 'LANDED':
      return 'LANDED'
    case 'HANDOFF':
      return 'HANDOFF'
  }
}

