import type { Vec2NM } from '../core/geo'
import type { WakeCategory } from '../data/airport'

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
    case 'HOLD':
      return a.originFix ? `HOLDING ${a.originFix}` : 'HOLDING'
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

/**
 * Display priority for the strip bay: what the controller needs to act on
 * soonest sits at the top. Aircraft on approach are nearly resolved but
 * must not be lost track of, holding traffic is parked, and anything
 * finished sinks to the bottom.
 */
export function stripOrder(a: Aircraft): number {
  switch (a.navMode) {
    case 'GO_AROUND':
      return 0
    case 'GS_TRACKING':
      return 1
    case 'LOC_CAPTURED':
      return 2
    case 'LOC_ARMED':
      return 3
    case 'VECTOR':
      return 4
    case 'HOLD':
      return 5
    case 'LANDED':
      return 6
    case 'HANDOFF':
      return 7
  }
}
