/**
 * When somebody declares.
 *
 * The other two generators put an aeroplane on the display. This one does
 * not: it reaches into the traffic already there and gives one of them a
 * bad day, which is the only honest way to model it. An emergency is not a
 * kind of aircraft, it is something that happens to an ordinary one --
 * usually the one you had just finished sequencing.
 *
 * That is also what makes it worth having. A scripted emergency that
 * arrived already squawking would be a puzzle handed over at the boundary.
 * One that starts on an aeroplane you are halfway through vectoring is the
 * actual job: everything you had planned is now wrong.
 *
 * Seeded like everything else, so a session can be replayed. It picks from
 * the traffic on frequency and it will not pick the same aircraft twice,
 * because it cannot -- an aeroplane already in trouble is not eligible.
 */

import type { Clock } from '../core/loop'
import { makeRng, makeRngAt, type Rng } from '../core/rng'
import { canDeclare, declareEmergency } from './emergency'
import { DIFFICULTIES, intervalSecondsFor, type DifficultySettings } from './difficulty'
import type { EmergencyKind } from './squawk'
import type { Aircraft, ApproachClearance } from './types'

/** How the run is resumed after a save. */
export interface EmergencyFlowState {
  readonly seed: number
  readonly draws: number
  readonly sinceLast: number
  readonly waitSeconds: number
  readonly declared: number
}

export interface EmergencyFlowOptions {
  readonly difficulty?: DifficultySettings
  readonly seed?: number
  readonly rng?: Rng
}

/**
 * How long after the session starts before one can happen.
 *
 * Nothing declares in the first few minutes. The sector is empty then, and
 * an emergency with no traffic around it is a straight-in approach with a
 * red border -- all of the interruption and none of the problem.
 */
const GRACE_SECONDS = 8 * 60

/**
 * How far either side of the mean the interval wanders.
 *
 * Wider than the arrival jitter on purpose. Arrivals are a flow and should
 * feel like one; an emergency should never feel due.
 */
const JITTER = 0.6

/** Two in three are a general emergency, the rest lose the radio. */
const RADIO_SHARE = 1 / 3

export class Emergencies {
  private rng: Rng
  private readonly difficulty: DifficultySettings
  private sinceLast = 0
  private waitSeconds: number
  private declaredCount = 0

  constructor(opts: EmergencyFlowOptions = {}) {
    this.difficulty = opts.difficulty ?? DIFFICULTIES.normal
    this.rng = opts.rng ?? makeRng(opts.seed ?? 20260101)
    this.waitSeconds = GRACE_SECONDS + this.nextInterval()
  }

  get declared(): number {
    return this.declaredCount
  }

  snapshot(): EmergencyFlowState {
    return {
      seed: this.rng.seed,
      draws: this.rng.draws,
      sinceLast: this.sinceLast,
      waitSeconds: this.waitSeconds,
      declared: this.declaredCount,
    }
  }

  restore(state: EmergencyFlowState): void {
    // Closed form, like the other generators: resuming must not replay an
    // hour of draws.
    this.rng = makeRngAt(state.seed, state.draws)
    this.sinceLast = state.sinceLast
    this.waitSeconds = state.waitSeconds
    this.declaredCount = state.declared
  }

  /**
   * One step. Returns the whole traffic list, with at most one aircraft
   * newly in trouble.
   *
   * The list rather than the one that changed, because the caller holds the
   * traffic as a value and swapping one member of it is the caller's job
   * everywhere else too. `approachFor` supplies the approach a radio
   * failure will fly itself onto; it takes the aircraft so the runway in
   * use can be chosen for it.
   */
  update(
    dtSeconds: number,
    clock: Clock,
    traffic: readonly Aircraft[],
    approachFor: (a: Aircraft) => ApproachClearance | null,
  ): readonly Aircraft[] {
    if (this.difficulty.emergenciesPerHour <= 0) return traffic

    this.sinceLast += Math.max(0, dtSeconds)
    if (this.sinceLast < this.waitSeconds) return traffic

    const eligible = traffic.filter(canDeclare)
    if (eligible.length === 0) {
      // Nothing to happen to. Look again shortly rather than banking the
      // time, or an empty sector would store up an emergency and hand it
      // over the moment the first arrival appeared.
      this.sinceLast = 0
      this.waitSeconds = 30
      return traffic
    }

    const victim = this.rng.pick(eligible)
    const kind: EmergencyKind = this.rng.next() < RADIO_SHARE ? 'radio' : 'general'
    this.sinceLast = 0
    this.waitSeconds = this.nextInterval()
    this.declaredCount += 1

    const declared = declareEmergency(victim, kind, clock.elapsedSeconds, approachFor(victim))
    return traffic.map((a) => (a.callsign === victim.callsign ? declared : a))
  }

  private nextInterval(): number {
    const mean = intervalSecondsFor(this.difficulty.emergenciesPerHour)
    const spread = mean * JITTER
    return Math.max(120, mean - spread + this.rng.next() * spread * 2)
  }
}
