import { normalizeHeading } from '../core/geo'
import type { Aircraft } from '../sim/types'
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
  switch (command.kind) {
    case 'heading':
      return heading(command.deg, aircraft)
    case 'altitude':
      return altitude(command.ft, aircraft, ctx)
    case 'speed':
      return speed(command.kts, aircraft, ctx)
    // The approach and hold logic is Day 2 work, and the handoff needs
    // somewhere to hand off to. Saying so is better than accepting a
    // clearance and quietly doing nothing with it.
    case 'approach':
      return { ok: false, reason: `approach clearances are not flyable yet` }
    case 'hold':
      return { ok: false, reason: `holding instructions are not flyable yet` }
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
      // A vector takes an aircraft out of the hold. Nothing else about a
      // heading changes the phase of flight.
      navMode: a.navMode === 'HOLD' ? 'VECTOR' : a.navMode,
    },
    readback: `${a.callsign} HEADING ${pad3(to)}`,
  }
}

function altitude(ft: number, a: Aircraft, ctx: ApplyContext): Outcome {
  if (!Number.isFinite(ft)) return { ok: false, reason: 'that is not an altitude' }
  const to = Math.round(ft / STEP_FT) * STEP_FT

  if (to < ctx.floorFt || to > ctx.ceilingFt) {
    return {
      ok: false,
      reason: `${a.callsign} cannot be cleared ${to} ft -- the sector is ${ctx.floorFt} to ${ctx.ceilingFt}`,
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
