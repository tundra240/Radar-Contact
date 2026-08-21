import type { Command } from './types'

/**
 * Turns a typed line into commands.
 *
 * The form is the one in the design doc -- `BAW178 H270 A30 S180` -- a
 * callsign followed by any number of instructions, which is how a controller
 * would actually type it: everything for one aircraft in one go.
 *
 * Deliberately forgiving in three ways, because the alternative is retyping
 * a line because of a space:
 *
 * - The verb may be glued to its value or separated: `H270` and `H 270`.
 * - The verb may be abbreviated or spelled out: `H`, `HDG`, `HEADING`.
 * - The callsign may be omitted entirely, in which case the instruction goes
 *   to whichever strip is selected. Select once, then type `A30`.
 *
 * Deliberately strict in one: an altitude has to be unambiguous. See
 * `altitudeFrom`.
 */

export interface ParseContext {
  /** Callsigns currently on frequency, for resolving what was typed. */
  readonly callsigns: readonly string[]
  /** Where an instruction goes when the line names no aircraft. */
  readonly selected: string | null
}

export type ParseResult =
  | { readonly ok: true; readonly commands: readonly Command[] }
  | { readonly ok: false; readonly error: string }

/** Every spelling of every instruction, longest checked first. */
const VERBS = {
  HEADING: ['HEADING', 'HDG', 'H'],
  ALTITUDE: ['ALTITUDE', 'ALT', 'A'],
  CLIMB: ['CLIMB', 'CLB', 'C'],
  DESCEND: ['DESCEND', 'DES', 'D'],
  SPEED: ['SPEED', 'SPD', 'S'],
  APPROACH: ['APPROACH', 'ILS'],
  HOLD: ['HOLD'],
  HANDOFF: ['HANDOFF', 'HO'],
} as const

type Verb = keyof typeof VERBS

const VERB_OF = new Map<string, Verb>()
for (const [verb, spellings] of Object.entries(VERBS)) {
  for (const spelling of spellings) VERB_OF.set(spelling, verb as Verb)
}

/** The instructions that take no argument. */
const NULLARY = new Set<Verb>(['HANDOFF'])

/**
 * Altitudes are written either as hundreds of feet or as feet, which is how
 * they are said and how they are typed, so both are accepted and told apart
 * by length: three digits or fewer is hundreds (`A30` is 3000 ft, `A150` is
 * FL150), four or more is feet (`A3000` is 3000 ft).
 *
 * The rule is length rather than magnitude on purpose. Going by magnitude
 * would make `A400` mean either 400 ft or FL400 depending on a threshold
 * nobody could guess, and a mistyped altitude is the most expensive kind.
 */
export function altitudeFrom(digits: string): number {
  const n = Number(digits)
  return digits.length <= 3 ? n * 100 : n
}

/**
 * Finds which aircraft was meant.
 *
 * Exact first, then a unique prefix, then a unique ending -- so `BAW178`,
 * `BAW1` and `178` all reach BAW178, and anything matching two aircraft is
 * refused rather than guessed at.
 */
export function resolveCallsign(
  token: string,
  callsigns: readonly string[],
): { readonly ok: true; readonly callsign: string } | { readonly ok: false; readonly error: string } {
  const want = token.toUpperCase()

  const exact = callsigns.find((c) => c.toUpperCase() === want)
  if (exact !== undefined) return { ok: true, callsign: exact }

  for (const match of [
    callsigns.filter((c) => c.toUpperCase().startsWith(want)),
    callsigns.filter((c) => c.toUpperCase().endsWith(want)),
  ]) {
    if (match.length === 1 && match[0] !== undefined) return { ok: true, callsign: match[0] }
    if (match.length > 1) {
      return { ok: false, error: `${want} could be ${match.join(' or ')}` }
    }
  }

  return { ok: false, error: `no aircraft ${want} on frequency` }
}

/** Splits a token into its leading letters and trailing digits. */
function split(token: string): { letters: string; digits: string } | null {
  const m = /^([A-Z]+)(\d*)$/.exec(token)
  if (!m) return null
  return { letters: m[1] ?? '', digits: m[2] ?? '' }
}

export function parseCommandLine(line: string, ctx: ParseContext): ParseResult {
  const tokens = line
    .toUpperCase()
    .split(/[\s,]+/)
    .filter((t) => t !== '')

  if (tokens.length === 0) return { ok: false, error: 'nothing to do' }

  let at = 0
  let callsign: string

  // A leading token that is not an instruction is the callsign. Checking it
  // this way round means a callsign that happens to look like a verb still
  // works as long as it is spelled in full.
  const first = tokens[0] ?? ''
  const asVerb = split(first)
  const looksLikeVerb = asVerb !== null && VERB_OF.has(asVerb.letters)

  if (!looksLikeVerb) {
    const resolved = resolveCallsign(first, ctx.callsigns)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    callsign = resolved.callsign
    at = 1
  } else if (ctx.selected !== null) {
    callsign = ctx.selected
  } else {
    return { ok: false, error: 'no aircraft selected -- start the line with a callsign' }
  }

  if (at >= tokens.length) {
    return { ok: false, error: `${callsign}: no instruction given` }
  }

  const commands: Command[] = []

  while (at < tokens.length) {
    const token = tokens[at] ?? ''
    const parts = split(token)
    const verb = parts === null ? undefined : VERB_OF.get(parts.letters)
    if (parts === null || verb === undefined) {
      return { ok: false, error: `${callsign}: ${token} is not an instruction` }
    }
    at += 1

    if (NULLARY.has(verb)) {
      commands.push({ kind: 'handoff', callsign })
      continue
    }

    // The value is glued to the verb, or it is the next token.
    let value = parts.digits
    if (value === '') {
      const next = tokens[at]
      if (next === undefined) {
        return { ok: false, error: `${callsign}: ${parts.letters} needs a value` }
      }
      value = next
      at += 1
    }

    const built = build(verb, value, callsign)
    if (!built.ok) return built
    commands.push(built.command)
  }

  return { ok: true, commands }
}

function build(
  verb: Verb,
  value: string,
  callsign: string,
): { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly error: string } {
  const digits = /^\d+$/.test(value)

  switch (verb) {
    case 'HEADING': {
      if (!digits || value.length > 3) {
        return { ok: false, error: `${callsign}: ${value} is not a heading` }
      }
      const deg = Number(value)
      if (deg > 360) return { ok: false, error: `${callsign}: heading ${value} is beyond 360` }
      // 360 and 0 are the same direction, and the record keeps [0, 360).
      return { ok: true, command: { kind: 'heading', callsign, deg: deg === 360 ? 0 : deg } }
    }

    case 'ALTITUDE':
    case 'CLIMB':
    case 'DESCEND': {
      if (!digits) return { ok: false, error: `${callsign}: ${value} is not an altitude` }
      return { ok: true, command: { kind: 'altitude', callsign, ft: altitudeFrom(value) } }
    }

    case 'SPEED': {
      if (!digits || value.length > 3) {
        return { ok: false, error: `${callsign}: ${value} is not a speed` }
      }
      return { ok: true, command: { kind: 'speed', callsign, kts: Number(value) } }
    }

    case 'APPROACH':
      return { ok: true, command: { kind: 'approach', callsign, runway: value } }

    case 'HOLD':
      return { ok: true, command: { kind: 'hold', callsign, fix: value } }

    case 'HANDOFF':
      // Handled by the caller, which knows it takes no value.
      return { ok: true, command: { kind: 'handoff', callsign } }
  }
}
