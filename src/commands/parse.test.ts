import { describe, expect, it } from 'vitest'
import { altitudeFrom, parseCommandLine, resolveCallsign } from './parse'
import type { Command } from './types'

const ON_FREQUENCY = ['BAW178', 'BAW912', 'VIR45', 'EZY6301']

const parse = (line: string, selected: string | null = null) =>
  parseCommandLine(line, { callsigns: ON_FREQUENCY, selected })

/** The commands from a line that is expected to parse. */
function commands(line: string, selected: string | null = null): readonly Command[] {
  const r = parse(line, selected)
  if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`)
  return r.commands
}

/** The error from a line that is expected not to. */
function error(line: string, selected: string | null = null): string {
  const r = parse(line, selected)
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.commands)}`)
  return r.error
}

describe('the form from the design doc', () => {
  it('parses a callsign and three instructions in one line', () => {
    expect(commands('BAW178 H270 A30 S180')).toEqual([
      { kind: 'heading', callsign: 'BAW178', deg: 270 },
      { kind: 'altitude', callsign: 'BAW178', ft: 3000 },
      { kind: 'speed', callsign: 'BAW178', kts: 180 },
    ])
  })

  it('does not care about case', () => {
    expect(commands('baw178 h270')).toEqual([
      { kind: 'heading', callsign: 'BAW178', deg: 270 },
    ])
  })

  it('takes the verb glued to its value or apart from it', () => {
    expect(commands('BAW178 H 270')).toEqual(commands('BAW178 H270'))
    expect(commands('BAW178 HDG270')).toEqual(commands('BAW178 H270'))
    expect(commands('BAW178 HEADING 270')).toEqual(commands('BAW178 H270'))
  })

  it('accepts commas between instructions', () => {
    expect(commands('BAW178, H270, S180')).toHaveLength(2)
  })

  it('accepts climb and descend as ways of saying altitude', () => {
    // They read better than A when the intent is one direction, and the
    // aircraft record has one field either way.
    const target = { kind: 'altitude', callsign: 'BAW178', ft: 5000 }
    expect(commands('BAW178 D50')[0]).toEqual(target)
    expect(commands('BAW178 C50')[0]).toEqual(target)
    expect(commands('BAW178 DES 50')[0]).toEqual(target)
    expect(commands('BAW178 CLIMB 5000')[0]).toEqual(target)
  })
})

describe('altitudes', () => {
  it('reads three digits or fewer as hundreds of feet', () => {
    expect(altitudeFrom('30')).toBe(3000)
    expect(altitudeFrom('150')).toBe(15000)
    expect(altitudeFrom('070')).toBe(7000)
  })

  it('reads four or more as feet', () => {
    expect(altitudeFrom('3000')).toBe(3000)
    expect(altitudeFrom('15000')).toBe(15000)
  })

  it('means the same thing written either way', () => {
    // The rule is length rather than magnitude on purpose: a threshold
    // nobody could guess is worse than a rule you can state in a sentence.
    expect(commands('BAW178 A30')).toEqual(commands('BAW178 A3000'))
  })
})

describe('headings', () => {
  it('takes a leading zero', () => {
    expect(commands('BAW178 H070')[0]).toEqual({
      kind: 'heading',
      callsign: 'BAW178',
      deg: 70,
    })
  })

  it('treats 360 as north', () => {
    // The record keeps headings in [0, 360), and both mean the same
    // direction, so refusing 360 would be pedantry.
    expect(commands('BAW178 H360')[0]).toEqual({
      kind: 'heading',
      callsign: 'BAW178',
      deg: 0,
    })
  })

  it('refuses a heading past the compass', () => {
    expect(error('BAW178 H400')).toMatch(/beyond 360/)
  })

  it('refuses something that is not a number', () => {
    expect(error('BAW178 HDG LEFT')).toMatch(/not a heading/)
  })
})

describe('finding the aircraft', () => {
  it('takes an exact callsign', () => {
    expect(resolveCallsign('VIR45', ON_FREQUENCY)).toEqual({ ok: true, callsign: 'VIR45' })
  })

  it('takes a unique prefix', () => {
    expect(resolveCallsign('VIR', ON_FREQUENCY)).toEqual({ ok: true, callsign: 'VIR45' })
  })

  it('takes a flight number on its own', () => {
    // Typing the last three digits is how a controller would shorten it.
    expect(resolveCallsign('178', ON_FREQUENCY)).toEqual({ ok: true, callsign: 'BAW178' })
  })

  it('refuses to guess between two matches', () => {
    const r = resolveCallsign('BAW', ON_FREQUENCY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/BAW178 or BAW912/)
  })

  it('says so when there is no such aircraft', () => {
    expect(error('ZZZ999 H270')).toMatch(/no aircraft ZZZ999/)
  })
})

describe('the selected aircraft', () => {
  it('takes the instruction when the line names no aircraft', () => {
    // Select a strip once, then type just the clearance.
    expect(commands('H270 A30', 'VIR45')).toEqual([
      { kind: 'heading', callsign: 'VIR45', deg: 270 },
      { kind: 'altitude', callsign: 'VIR45', ft: 3000 },
    ])
  })

  it('is overridden by a callsign in the line', () => {
    expect(commands('BAW178 H270', 'VIR45')[0]).toMatchObject({ callsign: 'BAW178' })
  })

  it('says what is missing when nothing is selected', () => {
    expect(error('H270')).toMatch(/no aircraft selected/)
  })
})

describe('refusals are specific', () => {
  it('rejects an empty line', () => {
    expect(error('')).toMatch(/nothing to do/)
    expect(error('   ')).toMatch(/nothing to do/)
  })

  it('rejects a callsign with no instruction', () => {
    expect(error('BAW178')).toMatch(/no instruction/)
  })

  it('rejects a verb with nothing after it', () => {
    expect(error('BAW178 H')).toMatch(/needs a value/)
  })

  it('rejects a token that is not an instruction', () => {
    expect(error('BAW178 FASTER')).toMatch(/not an instruction/)
  })

  it('names the aircraft in the complaint', () => {
    // So a refusal is readable in a log next to other traffic.
    expect(error('BAW178 H999')).toMatch(/^BAW178:/)
  })
})

describe('the instructions that are not flyable yet', () => {
  // Parsed, so the console and the strip buttons speak the same language;
  // refused by commands/apply.ts, which is where "not yet" belongs.
  it('parses an approach clearance', () => {
    expect(commands('BAW178 ILS 27R')[0]).toEqual({
      kind: 'approach',
      callsign: 'BAW178',
      runway: '27R',
    })
  })

  it('parses a hold', () => {
    expect(commands('BAW178 HOLD LAM')[0]).toEqual({
      kind: 'hold',
      callsign: 'BAW178',
      fix: 'LAM',
    })
  })

  it('parses a handoff, which takes no value', () => {
    expect(commands('BAW178 HANDOFF')).toEqual([{ kind: 'handoff', callsign: 'BAW178' }])
  })

  it('does not mistake HOLD for a heading', () => {
    // Both begin with H, so the verb table has to match the whole word.
    expect(commands('BAW178 HOLD BIG')[0]?.kind).toBe('hold')
  })
})
