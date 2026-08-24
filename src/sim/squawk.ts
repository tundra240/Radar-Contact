/**
 * The transponder code, and the three codes that mean something.
 *
 * A squawk is four octal digits -- 0 to 7 in each place, so 4096 of them --
 * and almost all of them are just a label. The controller assigns one, the
 * crew sets it, and from then on it is how the radar knows which return is
 * which flight. It is on the data block because a code that does not match
 * the callsign is the first sign that something is wrong.
 *
 * Three of them are not labels. They are what an aeroplane says when it can
 * no longer say it any other way, and they are the same three everywhere in
 * the world:
 *
 *   7500  unlawful interference
 *   7600  radio failure
 *   7700  general emergency
 *
 * Only two of those are modelled here. 7600 and 7700 are flying problems
 * with flying answers -- clear a path, give it the field -- and they are
 * what this simulation is about. 7500 is not a flying problem and the
 * response to it is not a controller's; it is reserved so that nothing can
 * ever be assigned it by accident, and nothing generates it.
 */

import type { Rng } from '../core/rng'

export const SQUAWK_HIJACK = '7500'
export const SQUAWK_RADIO_FAILURE = '7600'
export const SQUAWK_EMERGENCY = '7700'

/** What an aircraft is telling you by the code it is squawking. */
export type EmergencyKind = 'radio' | 'general'

/**
 * Codes that are never assigned to a flight.
 *
 * The three emergency codes, and the conspicuity codes that mean "nobody
 * has given me one" -- 7000 in Europe, 1200 in the States, 2000 for an
 * aircraft that has left a surveillance area, 0000 for a transponder that
 * has not been set. Assigning any of them to a flight would put a code on
 * the display that already means something else.
 */
export const RESERVED_SQUAWKS: ReadonlySet<string> = new Set([
  '0000',
  '1200',
  '2000',
  '7000',
  '7777',
  SQUAWK_HIJACK,
  SQUAWK_RADIO_FAILURE,
  SQUAWK_EMERGENCY,
])

/** Four digits, none of them 8 or 9. */
export function isSquawk(code: string): boolean {
  return /^[0-7]{4}$/.test(code)
}

/**
 * What the code means, or null if it is an ordinary discrete code.
 *
 * The emergency IS the squawk rather than a flag beside it, which is worth
 * being deliberate about: an aeroplane declares by turning a knob, and
 * modelling that as two pieces of state would allow the display to say one
 * thing and the simulation another.
 */
export function emergencyOf(code: string): EmergencyKind | null {
  if (code === SQUAWK_RADIO_FAILURE) return 'radio'
  if (code === SQUAWK_EMERGENCY) return 'general'
  return null
}

/** The code for a kind of emergency. */
export function squawkFor(kind: EmergencyKind): string {
  return kind === 'radio' ? SQUAWK_RADIO_FAILURE : SQUAWK_EMERGENCY
}

/**
 * The block codes are drawn from.
 *
 * A real unit is allocated ranges by the state and hands out discrete codes
 * within them; there is no useful way to reproduce that from open data, so
 * this is one block chosen to avoid every code that means something. It
 * stops below 7500 so no emergency code can ever come out of it, starts
 * above the low block that tends to be reserved for local use, and skips
 * anything ending in two zeros because those read as a block heading rather
 * than as a flight.
 */
const FIRST = 0o0201
const LAST = 0o7477

/** Whether a code may be handed to a flight. */
export function isAssignable(code: string): boolean {
  if (!isSquawk(code)) return false
  if (RESERVED_SQUAWKS.has(code)) return false
  if (code.endsWith('00')) return false
  const n = Number.parseInt(code, 8)
  return n >= FIRST && n <= LAST
}

/**
 * A code nobody airborne is already using.
 *
 * Two aircraft on one code is a genuine operational problem -- the radar
 * cannot tell which return is which flight -- so uniqueness among the
 * traffic on frequency is the one hard requirement. Codes are reused once
 * an aircraft has gone, the way they are in reality: there are only four
 * thousand of them and a busy day would exhaust them by lunchtime.
 */
export function allocateSquawk(rng: Rng, taken: ReadonlySet<string> = new Set()): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = format(rng.range(FIRST, LAST))
    if (isAssignable(code) && !taken.has(code)) return code
  }
  // Exhausted the random attempts, which needs the sector to be improbably
  // full. Walk the block, which finds a free code if the block holds one.
  for (let n = FIRST; n <= LAST; n += 1) {
    const code = format(n)
    if (isAssignable(code) && !taken.has(code)) return code
  }
  // Every code in the block is in use. Not reachable with any sane traffic
  // level, and returning the conspicuity code is what a real unit would
  // fall back to rather than inventing one that means something else.
  return '7000'
}

function format(n: number): string {
  return n.toString(8).padStart(4, '0')
}
