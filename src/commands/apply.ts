import { normalizeHeading } from '../core/geo'
import { isInSector } from '../sim/aircraft'
import { isControlled, type ControlZone } from '../sim/airspace'
import { isNordo } from '../sim/emergency'
import { onApproach } from '../sim/ils'
import { rejoinLeg } from '../sim/route'
import type { Aircraft, ApproachClearance, HoldClearance } from '../sim/types'
import type { Command } from './types'

/**
 * Validates a command against the flight envelope and the sector, and
 * returns the aircraft it produces.
 *
 * This is the single gate every input path goes through -- typed console,
 * strip quick-button, and the mouse rubber-band when it arrives -- so there
 * is one place a clearance can be refused and one readback format. See
 * ARCHITECTURE.md section 3, decision 5.
 *
 * Pure: it returns a new aircraft rather than mutating one, and takes
 * everything it needs to judge the command in `ApplyContext`. Nothing here
 * knows about the DOM, the clock or the render loop.
 *
 * A refusal is not a failure of the interface. Refusing "descend 200" with a
 * reason is the display doing its job; silently clamping it to the sector
 * floor would teach the controller that the number they typed was accepted.
 */

/** What an aircraft type can actually fly. */
export interface Envelope {
  /** Approach speed: the slowest it will go while still flying. */
  readonly minSpeedKts: number
  readonly maxSpeedKts: number
}

export interface ApplyContext {
  readonly floorFt: number
  readonly ceilingFt: number
  /** Speed limit below `speedLimitBelowFt`, e.g. 250 kt below FL100. */
  readonly speedLimitKts: number
  readonly speedLimitBelowFt: number
  /** Null for a type the config does not carry, which skips the check. */
  readonly envelopeFor: (type: string) => Envelope | null
  /** Null for a fix with no published hold, which refuses the clearance. */
  readonly holdFor: (fix: string) => HoldClearance | null
  /** Null for a runway with no ILS available, which refuses the clearance. */
  readonly approachFor: (runway: string) => ApproachClearance | null
  /**
   * The area of responsibility: the published controlled airspace. Nothing
   * outside it takes a clearance, at any level.
   *
   * Null for a session flown with the boundary switched off, where the
   * whole picture is the controller's.
   */
  readonly controlZone: ControlZone | null
}

export type Outcome =
  | { readonly ok: true; readonly aircraft: Aircraft; readonly readback: string }
  | { readonly ok: false; readonly reason: string }

/** Levels are cleared in hundreds of feet, so anything else is rounded. */
const STEP_FT = 100

export function applyCommand(
  command: Command,
  aircraft: Aircraft,
  ctx: ApplyContext,
): Outcome {
  // Before anything else: an aircraft outside the area of responsibility is
  // somebody else's. It can be seen, identified and planned around, and it
  // takes no instructions -- which is the one rule that makes the boundary
  // mean something rather than being a circle on a display.
  if (!isInSector(aircraft, ctx.controlZone)) {
    return {
      ok: false,
      reason: `${aircraft.callsign} is not in your airspace yet`,
    }
  }

  // And an aircraft squawking 7600 cannot hear a word of it. Refused here
  // rather than per verb, because the radio is not a property of the
  // clearance: there is no instruction that gets through, including the
  // ones that would help. The aeroplane is flying the procedure it is
  // expected to fly and the job is to move everybody else.
  if (isNordo(aircraft)) {
    return {
      ok: false,
      reason: `${aircraft.callsign} is squawking 7600 -- no radio, no reply`,
    }
  }

  switch (command.kind) {
    case 'heading':
      return heading(command.deg, aircraft)
    case 'altitude':
      return altitude(command.ft, aircraft, ctx)
    case 'speed':
      return speed(command.kts, aircraft, ctx)
    case 'hold':
      return hold(command.fix, aircraft, ctx)
    case 'resumeNav':
      return resumeNav(aircraft)
    case 'approach':
      return approach(command.runway, aircraft, ctx)
    // The handoff still needs somewhere to hand off to. Saying so is better
    // than accepting a clearance and quietly doing nothing with it.
    case 'handoff':
      return { ok: false, reason: `there is nobody to hand off to yet` }
  }
}

function heading(deg: number, a: Aircraft): Outcome {
  if (!Number.isFinite(deg)) return { ok: false, reason: 'that is not a heading' }
  const to = normalizeHeading(Math.round(deg))
  return {
    ok: true,
    aircraft: {
      ...a,
      clearedHdg: to,
      // A vector takes an aircraft out of the hold and off an approach --
      // breaking somebody off is exactly what a heading is for at that
      // point. Nothing else about a heading changes the phase of flight.
      navMode: a.navMode === 'HOLD' || onApproach(a.navMode) ? 'VECTOR' : a.navMode,
      // And the clearance goes with it, or the next tick would steer the
      // aircraft straight back onto what it was just taken off.
      hold: a.navMode === 'HOLD' ? null : a.hold,
      clearedApproach: onApproach(a.navMode) ? null : a.clearedApproach,
    },
    readback: `${a.callsign} HEADING ${pad3(to)}`,
  }
}

function altitude(ft: number, a: Aircraft, ctx: ApplyContext): Outcome {
  if (!Number.isFinite(ft)) return { ok: false, reason: 'that is not an altitude' }

  // On the glidepath the path owns the level. Accepting a level here and
  // having the approach overwrite it on the next tick would be the exact
  // thing this module exists not to do.
  if (a.navMode === 'GS_TRACKING') {
    return {
      ok: false,
      reason: `${a.callsign} is established on the glidepath -- vector it off first`,
    }
  }
  const to = Math.round(ft / STEP_FT) * STEP_FT

  if (to < ctx.floorFt || to > ctx.ceilingFt) {
    return {
      ok: false,
      reason: `${a.callsign} cannot be cleared ${to} ft -- the sector is ${ctx.floorFt} to ${ctx.ceilingFt}`,
    }
  }

  // Below the airspace is outside the airspace, and the world removes what
  // is outside. Refusing here rather than accepting and losing the aircraft
  // two minutes later is the same principle as every other refusal in this
  // module: say no rather than do something surprising.
  if (ctx.controlZone !== null && !isControlled(ctx.controlZone, a.pos, to)) {
    return {
      ok: false,
      reason: `${to} ft is below controlled airspace where ${a.callsign} is`,
    }
  }

  // Said the way it is said on the radio: which way the aircraft is going
  // is information the controller wants read back to them.
  const verb = to > a.altFt ? 'CLIMB' : to < a.altFt ? 'DESCEND' : 'MAINTAIN'
  return {
    ok: true,
    aircraft: { ...a, clearedAltFt: to },
    readback: `${a.callsign} ${verb} ${to} FT`,
  }
}

function speed(kts: number, a: Aircraft, ctx: ApplyContext): Outcome {
  if (!Number.isFinite(kts)) return { ok: false, reason: 'that is not a speed' }
  const to = Math.round(kts)

  const envelope = ctx.envelopeFor(a.type)
  if (envelope !== null) {
    if (to < envelope.minSpeedKts) {
      return {
        ok: false,
        reason: `${a.callsign} is a ${a.type} -- it will not fly below ${envelope.minSpeedKts} kt`,
      }
    }
    if (to > envelope.maxSpeedKts) {
      return {
        ok: false,
        reason: `${a.callsign} is a ${a.type} -- ${envelope.maxSpeedKts} kt is all it has`,
      }
    }
  }

  // The terminal area speed limit applies where the aircraft is now and
  // where it has been cleared to, so a descent does not sneak under it.
  const lowest = Math.min(a.altFt, a.clearedAltFt)
  if (lowest < ctx.speedLimitBelowFt && to > ctx.speedLimitKts) {
    return {
      ok: false,
      reason: `${ctx.speedLimitKts} kt is the limit below ${ctx.speedLimitBelowFt} ft`,
    }
  }

  return {
    ok: true,
    aircraft: { ...a, clearedSpdKts: to },
    readback: `${a.callsign} SPEED ${to} KT`,
  }
}

function hold(fix: string, a: Aircraft, ctx: ApplyContext): Outcome {
  const clearance = ctx.holdFor(fix)
  if (clearance === null) {
    return { ok: false, reason: `${fix} has no published hold` }
  }

  return {
    ok: true,
    aircraft: {
      ...a,
      navMode: 'HOLD',
      hold: clearance,
      // The controller has stopped vectoring. Leaving a cleared heading on
      // the record would show a vector on the strip that nothing is flying.
      clearedHdg: null,
    },
    readback: `${a.callsign} HOLD AT ${clearance.fix}`,
  }
}

/**
 * Hands an aircraft back to its own flight plan.
 *
 * The counterpart to a vector, and the reason a transit can be vectored at
 * all: without a way to give the route back, taking an aeroplane off it
 * would mean owning it for the rest of its time in the sector.
 *
 * Refused for anything with no route to resume, and said plainly rather
 * than accepted and quietly ignored. An arrival has no flight plan here --
 * it is being vectored to a runway, which is the whole job.
 */
function resumeNav(a: Aircraft): Outcome {
  if (a.route.length === 0) {
    return {
      ok: false,
      reason: `${a.callsign} has no route to resume -- it is being vectored`,
    }
  }
  if (onApproach(a.navMode)) {
    // Not while it is on a beam. Breaking one off is what a vector is for,
    // and doing it silently as a side effect of RESUME NAV would be the
    // kind of surprise this module exists to prevent.
    return {
      ok: false,
      reason: `${a.callsign} is on the approach -- vector it off first`,
    }
  }

  // Forwards only. The aircraft has been vectored, so the leg it was on may
  // be behind it now, and rejoining that one would turn it round.
  const routeLeg = rejoinLeg(a)
  const next = a.route[routeLeg]
  return {
    ok: true,
    aircraft: {
      ...a,
      navMode: 'LNAV',
      routeLeg,
      // The vector is over. Leaving it on the record would show a heading
      // on the strip that nothing is flying.
      clearedHdg: null,
      hold: null,
    },
    readback:
      next === undefined
        ? `${a.callsign} OWN NAVIGATION`
        : `${a.callsign} OWN NAVIGATION DIRECT ${next.fix}`,
  }
}

function approach(runway: string, a: Aircraft, ctx: ApplyContext): Outcome {
  const clearance = ctx.approachFor(runway)
  if (clearance === null) {
    return { ok: false, reason: `no ILS approach available for ${runway}` }
  }

  return {
    ok: true,
    aircraft: {
      ...a,
      // Armed, not established: sim/ils.ts decides tick by tick whether the
      // geometry actually allows a capture, and an aircraft lined up badly
      // flies straight through.
      navMode: 'LOC_ARMED',
      clearedApproach: clearance,
      // You cannot be holding and on an approach.
      hold: null,
    },
    readback: `${a.callsign} CLEARED ILS ${clearance.runway}`,
  }
}

const pad3 = (n: number): string => String(n).padStart(3, '0')

/**
 * Applies a whole line's worth of commands to one aircraft, in order.
 *
 * All or nothing: if any command is refused the aircraft is left exactly as
 * it was. A line like `BAW178 H270 A30 S400` should not turn the aircraft
 * 90 degrees and descend it before complaining about the speed, because the
 * controller would then have to work out which half of what they typed had
 * taken effect.
 */
export function applyAll(
  commands: readonly Command[],
  aircraft: Aircraft,
  ctx: ApplyContext,
):
  | { readonly ok: true; readonly aircraft: Aircraft; readonly readbacks: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  let next = aircraft
  const readbacks: string[] = []

  for (const command of commands) {
    const outcome = applyCommand(command, next, ctx)
    if (!outcome.ok) return outcome
    next = outcome.aircraft
    readbacks.push(outcome.readback)
  }

  return { ok: true, aircraft: next, readbacks }
}
