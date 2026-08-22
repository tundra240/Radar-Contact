// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, type ApplyContext, type Envelope } from '../commands/apply'
import type { Command } from '../commands/types'
import { headingLabel } from '../core/geo'
import type { ControlZone } from '../sim/airspace'
import type { Aircraft, HoldClearance } from '../sim/types'
import {
  TagMenu,
  altitudeChoices,
  altitudeLabel,
  headingChoices,
  relativeTurns,
  speedChoices,
  tagReadout,
  type TagLimits,
} from './tagmenu'

/** EGLL's real sector limits, which the choices are derived from. */
const LIMITS: TagLimits = {
  floorFt: 1500,
  ceilingFt: 15000,
  speedLimitKts: 250,
  speedLimitBelowFt: 10000,
}

const ENVELOPES: Record<string, Envelope> = {
  A320: { minSpeedKts: 140, maxSpeedKts: 250 },
  A359: { minSpeedKts: 148, maxSpeedKts: 280 },
  A319: { minSpeedKts: 135, maxSpeedKts: 250 },
}

const envelopeFor = (type: string): Envelope | null => ENVELOPES[type] ?? null

/** The four real EGLL holds, as the airport config carries them. */
const HOLDS: Record<string, HoldClearance> = {
  LAM: { fix: 'LAM', posNM: { x: 13.1, y: 9.4 }, inboundTrue: 249, turns: 'right', legMins: 1 },
  BIG: { fix: 'BIG', posNM: { x: 12.6, y: -8.9 }, inboundTrue: 302, turns: 'right', legMins: 1 },
  BNN: { fix: 'BNN', posNM: { x: -6.9, y: 14.6 }, inboundTrue: 116, turns: 'right', legMins: 1 },
  OCK: { fix: 'OCK', posNM: { x: -5.6, y: -9.7 }, inboundTrue: 30, turns: 'right', legMins: 1 },
}

const holdFor = (fix: string): HoldClearance | null => HOLDS[fix] ?? null

/** Everything the tag menu tests use sits well inside this. */
const ZONE: ControlZone = [
  {
    polygon: [
      { x: -60, y: -60 },
      { x: 60, y: -60 },
      { x: 60, y: 60 },
      { x: -60, y: 60 },
    ],
    floorFt: 0,
    ceilingFt: 20000,
    label: 'TEST CTA',
  },
]

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW178',
    type: 'A320',
    wake: 'M',
    pos: { x: 10, y: 4 },
    altFt: 7000,
    hdg: 90,
    iasKts: 240,
    gsKts: 240,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 7000,
    clearedSpdKts: 240,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    originFix: 'LAM',
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    ...over,
  }
}

describe('headings', () => {
  it('offers every ten degrees, once', () => {
    const all = headingChoices()
    expect(all).toHaveLength(36)
    expect(new Set(all).size).toBe(36)
    expect(all.every((d) => d % 10 === 0 && d >= 0 && d < 360)).toBe(true)
  })

  it('puts due north last, as the command wants it and a compass reads it', () => {
    const all = headingChoices()
    expect(all[0]).toBe(10)
    expect(all[all.length - 1]).toBe(0)
    expect(headingLabel(0)).toBe('360')
    expect(headingLabel(90)).toBe('090')
  })

  it('resolves a nudge into an absolute heading', () => {
    const turns = relativeTurns(90)
    expect(turns.map((t) => t.label)).toEqual(['L30', 'L20', 'L10', 'R10', 'R20', 'R30'])
    expect(turns.map((t) => t.deg)).toEqual([60, 70, 80, 100, 110, 120])
  })

  it('wraps a nudge through north instead of going negative', () => {
    expect(relativeTurns(10).find((t) => t.label === 'L30')?.deg).toBe(340)
    expect(relativeTurns(350).find((t) => t.label === 'R30')?.deg).toBe(20)
  })
})

describe('levels', () => {
  it('reads like an altitude scale, highest first', () => {
    const levels = altitudeChoices(LIMITS)
    expect(levels[0]).toBe(15000)
    expect(levels[levels.length - 1]).toBe(1500)
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] as number).toBeLessThan(levels[i - 1] as number)
    }
  })

  it('always offers the floor and the ceiling, whatever the step', () => {
    // 1500 is not on a thousand-foot step and 15000 is not on a two, so a
    // naive loop would miss both -- and they are the two most useful.
    expect(altitudeChoices(LIMITS)).toContain(1500)
    expect(altitudeChoices(LIMITS)).toContain(15000)
    expect(altitudeChoices({ floorFt: 2000, ceilingFt: 6000 })).toEqual([6000, 5000, 4000, 3000, 2000])
  })

  it('steps in thousands low down and two thousands high up', () => {
    const levels = altitudeChoices(LIMITS)
    expect(levels).toContain(3000)
    expect(levels).toContain(9000)
    expect(levels).toContain(12000)
    expect(levels).not.toContain(11000)
  })

  it('writes a level the way a clearance says it', () => {
    expect(altitudeLabel(3000)).toBe('3000')
    expect(altitudeLabel(9000)).toBe('9000')
    expect(altitudeLabel(12000)).toBe('FL120')
  })
})

describe('speeds', () => {
  it('offers the reduction first, because that is the instruction', () => {
    const speeds = speedChoices(ac(), LIMITS, envelopeFor('A320'))
    expect(speeds[0]).toBe(250)
    expect(speeds[speeds.length - 1]).toBe(140)
  })

  it('honours the sector speed limit only below its own level', () => {
    const low = speedChoices(ac({ altFt: 7000, clearedAltFt: 7000 }), LIMITS, envelopeFor('A359'))
    const high = speedChoices(ac({ altFt: 12000, clearedAltFt: 12000 }), LIMITS, envelopeFor('A359'))
    // 280 is inside the type's envelope but over the 250 limit below FL100.
    expect(low[0]).toBe(250)
    expect(high[0]).toBe(280)
  })

  it('applies the limit to a descent already cleared below it', () => {
    // apply.ts checks the lower of actual and cleared, so an aircraft high
    // up but cleared down is already bound by the limit.
    const descending = ac({ altFt: 12000, clearedAltFt: 7000, type: 'A359' })
    expect(speedChoices(descending, LIMITS, envelopeFor('A359'))[0]).toBe(250)
  })

  it('rounds the slow end up, so no offer sits under the approach speed', () => {
    // An A319 stops flying at 135, and 130 would be offered by a floor.
    expect(speedChoices(ac({ type: 'A319' }), LIMITS, envelopeFor('A319'))).toContain(140)
    expect(speedChoices(ac({ type: 'A319' }), LIMITS, envelopeFor('A319'))).not.toContain(130)
  })

  it('falls back to the sector limit for a type it does not know', () => {
    const speeds = speedChoices(ac({ type: 'C172' }), LIMITS, envelopeFor('C172'))
    expect(speeds).toEqual([250])
  })
})

describe('readout', () => {
  it('says what the aircraft is doing now', () => {
    expect(tagReadout(ac({ altFt: 12000, vsFpm: -1500, clearedAltFt: 7000, iasKts: 253, hdg: 88 })))
      .toBe('120 v 070   253kt   H088')
  })

  it('marks level flight rather than implying a descent', () => {
    expect(tagReadout(ac())).toContain(' = ')
  })
})

/**
 * The claim the module makes is that it only offers what will be accepted.
 * That is worth pinning down, because the alternative -- a menu that
 * teaches limits the simulation does not have -- is worse than no menu.
 */
describe('every offer is accepted by commands/apply', () => {
  const ctx: ApplyContext = { ...LIMITS, envelopeFor, holdFor, approachFor: () => null, controlZone: ZONE }

  it('accepts every level in the list', () => {
    for (const ft of altitudeChoices(LIMITS)) {
      const out = applyCommand({ kind: 'altitude', callsign: 'BAW178', ft }, ac(), ctx)
      expect(out.ok, `${ft} ft`).toBe(true)
    }
  })

  it('accepts every heading in the grid, and every nudge', () => {
    const a = ac()
    const degs = [...headingChoices(), ...relativeTurns(a.hdg).map((t) => t.deg)]
    for (const deg of degs) {
      expect(applyCommand({ kind: 'heading', callsign: a.callsign, deg }, a, ctx).ok, `${deg}`).toBe(
        true,
      )
    }
  })

  it('accepts every hold the menu lists', () => {
    for (const fix of Object.keys(HOLDS)) {
      const out = applyCommand({ kind: 'hold', callsign: 'BAW178', fix }, ac(), ctx)
      expect(out.ok, fix).toBe(true)
    }
  })

  it('accepts every speed, on both sides of the limit and for a fast type', () => {
    const cases = [
      ac({ type: 'A320', altFt: 7000, clearedAltFt: 7000 }),
      ac({ type: 'A359', altFt: 12000, clearedAltFt: 12000 }),
      ac({ type: 'A359', altFt: 12000, clearedAltFt: 5000 }),
      ac({ type: 'A319', altFt: 3000, clearedAltFt: 3000 }),
    ]
    for (const a of cases) {
      const speeds = speedChoices(a, LIMITS, envelopeFor(a.type))
      expect(speeds.length, a.type).toBeGreaterThan(0)
      for (const kts of speeds) {
        const out = applyCommand({ kind: 'speed', callsign: a.callsign, kts }, a, ctx)
        expect(out.ok, `${a.type} ${kts} kt at ${a.altFt}/${a.clearedAltFt}`).toBe(true)
      }
    }
  })
})

/* ------------------------------------------------------------- the panel */

describe('TagMenu', () => {
  let mount: HTMLElement
  let issued: Command[]
  let menu: TagMenu

  const open = (a = ac(), at = { x: 100, y: 100 }): void => menu.openFor(a, at)
  const rows = (): HTMLButtonElement[] => [
    ...mount.querySelectorAll<HTMLButtonElement>('.tagmenu-row'),
  ]

  beforeEach(() => {
    document.body.innerHTML = ''
    mount = document.createElement('div')
    document.body.appendChild(mount)
    issued = []
    menu = new TagMenu({
      mount,
      onCommand: (c) => issued.push(c),
      limits: LIMITS,
      runways: ['27R', '27L'],
      holdFixes: ['LAM', 'BIG', 'BNN', 'OCK'],
      envelopeFor,
    })
  })

  it('starts closed and holding nothing', () => {
    expect(menu.isOpen).toBe(false)
    expect(menu.callsign).toBe(null)
  })

  it('opens on an aircraft and says which one', () => {
    open()
    expect(menu.isOpen).toBe(true)
    expect(menu.callsign).toBe('BAW178')
    expect(mount.querySelector('.tagmenu-title')?.textContent).toContain('BAW178')
    expect(mount.querySelector('.tagmenu-title')?.textContent).toContain('A320')
  })

  it('marks a heavy in the title, where the wake category matters', () => {
    open(ac({ callsign: 'BAW1', type: 'B77W', wake: 'H' }))
    expect(mount.querySelector('.tagmenu-title')?.textContent).toContain('BAW1 H')
  })

  it('offers every kind of clearance at the top level', () => {
    open()
    expect(rows().map((r) => r.textContent?.replace('>', ''))).toEqual([
      'HEADING',
      'ALTITUDE',
      'SPEED',
      'APPROACH',
      'HOLD',
      'HANDOFF',
    ])
  })
})

describe('TagMenu pages', () => {
  let mount: HTMLElement
  let issued: Command[]
  let menu: TagMenu

  const rows = (): HTMLButtonElement[] => [
    ...mount.querySelectorAll<HTMLButtonElement>('.tagmenu-row'),
  ]
  const keys = (): HTMLButtonElement[] => [
    ...mount.querySelectorAll<HTMLButtonElement>('.tagmenu-key'),
  ]
  const rowNamed = (label: string): HTMLButtonElement => {
    const b = rows().find((r) => r.textContent?.replace('>', '') === label)
    if (!b) throw new Error(`no row ${label}`)
    return b
  }
  const keyNamed = (label: string): HTMLButtonElement => {
    const b = keys().find((k) => k.textContent === label)
    if (!b) throw new Error(`no key ${label} in [${keys().map((k) => k.textContent).join(',')}]`)
    return b
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    mount = document.createElement('div')
    document.body.appendChild(mount)
    issued = []
    menu = new TagMenu({
      mount,
      onCommand: (c) => issued.push(c),
      limits: LIMITS,
      runways: ['27R', '27L'],
      holdFixes: ['LAM', 'BIG'],
      envelopeFor,
    })
    menu.openFor(ac(), { x: 100, y: 100 })
  })

  it('issues a level and closes, because the instruction is complete', () => {
    rowNamed('ALTITUDE').click()
    keyNamed('3000').click()
    expect(issued).toEqual([{ kind: 'altitude', callsign: 'BAW178', ft: 3000 }])
    expect(menu.isOpen).toBe(false)
  })

  it('issues an absolute heading from the grid', () => {
    rowNamed('HEADING').click()
    keyNamed('270').click()
    expect(issued).toEqual([{ kind: 'heading', callsign: 'BAW178', deg: 270 }])
  })

  it('turns due north into zero on the way out', () => {
    rowNamed('HEADING').click()
    keyNamed('360').click()
    expect(issued).toEqual([{ kind: 'heading', callsign: 'BAW178', deg: 0 }])
  })

  it('resolves a nudge against the heading the aircraft is on', () => {
    rowNamed('HEADING').click()
    // Flying 090, so twenty left is 070.
    keyNamed('L20').click()
    expect(issued).toEqual([{ kind: 'heading', callsign: 'BAW178', deg: 70 }])
  })

  it('offers only speeds this aircraft can fly', () => {
    rowNamed('SPEED').click()
    const offered = keys().map((k) => Number(k.textContent))
    expect(offered).toEqual([...speedChoices(ac(), LIMITS, envelopeFor('A320'))])
    keyNamed('180').click()
    expect(issued).toEqual([{ kind: 'speed', callsign: 'BAW178', kts: 180 }])
  })

  it('lists the runways it was given, and clears one', () => {
    rowNamed('APPROACH').click()
    expect(rows().map((r) => r.textContent)).toEqual(['BACK', 'ILS 27R', 'ILS 27L'])
    rowNamed('ILS 27L').click()
    expect(issued).toEqual([{ kind: 'approach', callsign: 'BAW178', runway: '27L' }])
  })

  it('lists the published holds, and issues one', () => {
    rowNamed('HOLD').click()
    expect(rows().map((r) => r.textContent)).toEqual(['BACK', 'LAM', 'BIG'])
    rowNamed('BIG').click()
    expect(issued).toEqual([{ kind: 'hold', callsign: 'BAW178', fix: 'BIG' }])
  })

  it('hands off straight from the top level, with nothing to choose', () => {
    rowNamed('HANDOFF').click()
    expect(issued).toEqual([{ kind: 'handoff', callsign: 'BAW178' }])
    expect(menu.isOpen).toBe(false)
  })

  it('comes back from a page without issuing anything', () => {
    rowNamed('SPEED').click()
    rowNamed('BACK').click()
    expect(rows().map((r) => r.textContent?.replace('>', ''))).toContain('HEADING')
    expect(issued).toEqual([])
    expect(menu.isOpen).toBe(true)
  })

  it('reopens at the top level rather than where it was left', () => {
    // A menu that remembered its last page would be a mode, and the next
    // right-click would land on a grid of numbers with no context.
    rowNamed('HEADING').click()
    menu.close()
    menu.openFor(ac(), { x: 10, y: 10 })
    expect(rows().map((r) => r.textContent?.replace('>', ''))).toContain('ALTITUDE')
  })
})

describe('TagMenu dismissal and placement', () => {
  let mount: HTMLElement
  let issued: Command[]
  let menu: TagMenu

  beforeEach(() => {
    document.body.innerHTML = ''
    mount = document.createElement('div')
    document.body.appendChild(mount)
    issued = []
    menu = new TagMenu({
      mount,
      onCommand: (c) => issued.push(c),
      limits: LIMITS,
      runways: ['27R'],
      holdFixes: ['LAM'],
      envelopeFor,
    })
  })

  /** jsdom measures nothing, so the display's size has to be supplied. */
  const sizeMount = (w: number, h: number): void => {
    mount.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 }) as DOMRect
  }

  it('closes on Escape', () => {
    menu.openFor(ac(), { x: 50, y: 50 })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(menu.isOpen).toBe(false)
    expect(issued).toEqual([])
  })

  it('closes when something else is pressed', () => {
    menu.openFor(ac(), { x: 50, y: 50 })
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(menu.isOpen).toBe(false)
  })

  it('stays open when the press is inside itself', () => {
    // Otherwise choosing a page would dismiss the menu before the click
    // that chose it had been handled.
    menu.openFor(ac(), { x: 50, y: 50 })
    menu.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(menu.isOpen).toBe(true)
  })

  it('ignores keys and presses while closed', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(menu.isOpen).toBe(false)
  })

  it('keeps the readout live while the aircraft keeps flying', () => {
    menu.openFor(ac({ altFt: 7000 }), { x: 50, y: 50 })
    const readout = (): string | null =>
      mount.querySelector('.tagmenu-readout')?.textContent ?? null
    expect(readout()).toContain('070')
    menu.sync([ac({ altFt: 5000, clearedAltFt: 5000 })])
    expect(readout()).toContain('050')
  })

  it('closes itself when its aircraft has left the sector', () => {
    // The alternative is a menu that can still issue clearances to an
    // aircraft that is no longer there.
    menu.openFor(ac(), { x: 50, y: 50 })
    menu.sync([])
    expect(menu.isOpen).toBe(false)
    expect(menu.callsign).toBe(null)
  })

  it('leaves other traffic alone', () => {
    menu.openFor(ac(), { x: 50, y: 50 })
    menu.sync([ac({ callsign: 'VIR22' }), ac()])
    expect(menu.callsign).toBe('BAW178')
  })

  it('opens at the cursor when there is room', () => {
    sizeMount(1000, 700)
    menu.openFor(ac(), { x: 200, y: 150 })
    expect(menu.element.style.left).toBe('200px')
    expect(menu.element.style.top).toBe('150px')
  })

  it('flips rather than hanging off the right-hand edge', () => {
    sizeMount(1000, 700)
    menu.openFor(ac(), { x: 950, y: 150 })
    // 182 wide, so it opens to the left of the cursor instead.
    expect(menu.element.style.left).toBe('768px')
  })

  it('flips upward at the bottom too', () => {
    sizeMount(1000, 700)
    menu.openFor(ac(), { x: 200, y: 690 })
    expect(Number.parseInt(menu.element.style.top, 10)).toBeLessThan(690)
  })

  it('never opens off the top or left, however small the display', () => {
    sizeMount(120, 90)
    menu.openFor(ac(), { x: 100, y: 80 })
    expect(Number.parseInt(menu.element.style.left, 10)).toBeGreaterThanOrEqual(0)
    expect(Number.parseInt(menu.element.style.top, 10)).toBeGreaterThanOrEqual(0)
  })

  it('swallows a right-click on itself, so it cannot open twice', () => {
    menu.openFor(ac(), { x: 50, y: 50 })
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    menu.element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })
})
