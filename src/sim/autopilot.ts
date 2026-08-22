import { angleDelta, normalizeHeading } from '../core/geo'
import type { Aircraft } from './types'

/**
 * The autopilot: moves an aircraft's ACTUAL state towards the state it has
 * been CLEARED to, at standard rates.
 *
 * This is the whole reason the aircraft record keeps the two side by side.
 * A clearance sets the target and this closes the gap over time, which is
 * what makes an instruction feel like an instruction rather than a
 * teleport, and what makes the ILS just another target rather than a
 * special case.
 *
 * Every function here is pure and takes the step explicitly, so the result
 * depends on simulated time alone and never on when it was called.
 */

export interface Rates {
  /** Standard rate turn. */
  readonly turnDegPerSec: number
  readonly verticalFpm: number
  readonly accelKtsPerSec: number
}

export const STANDARD_RATES: Rates = {
  turnDegPerSec: 3,
  verticalFpm: 1500,
  accelKtsPerSec: 1.5,
}

/**
 * Turn towards the cleared heading, the short way round, never past it.
 *
 * A null clearance means no instruction is outstanding, so the aircraft
 * holds what it has rather than drifting.
 */
export function stepHeading(
  hdg: number,
  clearedHdg: number | null,
  dtSeconds: number,
  rates: Rates = STANDARD_RATES,
): number {
  if (clearedHdg === null || dtSeconds <= 0) return normalizeHeading(hdg)

  const delta = angleDelta(hdg, clearedHdg)
  const most = rates.turnDegPerSec * dtSeconds
  // Snapping when the remainder is smaller than a full step is what stops
  // an aircraft oscillating either side of its clearance forever.
  if (Math.abs(delta) <= most) return normalizeHeading(clearedHdg)
  return normalizeHeading(hdg + Math.sign(delta) * most)
}

/**
 * Climb or descend towards the cleared level, never past it.
 *
 * Returns the vertical speed actually achieved over the step, not the
 * nominal rate: on the last step before levelling off it is whatever was
 * left, and once level it is zero. The trend arrow on the data block reads
 * this, so an aircraft that has finished its descent must stop showing one.
 */
export function stepAltitude(
  altFt: number,
  clearedAltFt: number,
  dtSeconds: number,
  rates: Rates = STANDARD_RATES,
): { readonly altFt: number; readonly vsFpm: number } {
  if (dtSeconds <= 0) return { altFt, vsFpm: 0 }

  const remaining = clearedAltFt - altFt
  const most = (rates.verticalFpm / 60) * dtSeconds

  const next = Math.abs(remaining) <= most ? clearedAltFt : altFt + Math.sign(remaining) * most
  return { altFt: next, vsFpm: ((next - altFt) / dtSeconds) * 60 }
}

/** Accelerate or decelerate towards the cleared speed, never past it. */
export function stepSpeed(
  iasKts: number,
  clearedSpdKts: number,
  dtSeconds: number,
  rates: Rates = STANDARD_RATES,
): number {
  if (dtSeconds <= 0) return iasKts

  const remaining = clearedSpdKts - iasKts
  const most = rates.accelKtsPerSec * dtSeconds
  if (Math.abs(remaining) <= most) return clearedSpdKts
  return iasKts + Math.sign(remaining) * most
}

/**
 * One step of all three. Returns only the fields the autopilot owns, so
 * the caller stays in charge of position and everything else.
 */
export function autopilot(
  a: Aircraft,
  dtSeconds: number,
  rates: Rates = STANDARD_RATES,
): Pick<Aircraft, 'hdg' | 'altFt' | 'vsFpm' | 'iasKts'> {
  const vertical = stepAltitude(a.altFt, a.clearedAltFt, dtSeconds, rates)
  return {
    hdg: stepHeading(a.hdg, a.clearedHdg, dtSeconds, rates),
    altFt: vertical.altFt,
    vsFpm: vertical.vsFpm,
    iasKts: stepSpeed(a.iasKts, a.clearedSpdKts, dtSeconds, rates),
  }
}
