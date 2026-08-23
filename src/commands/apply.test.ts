import { describe, expect, it } from 'vitest'
import { autopilot } from '../sim/autopilot'
import type { ControlZone } from '../sim/airspace'
import type { Aircraft, ApproachClearance, HoldClearance, NavMode } from '../sim/types'
import { parseCommandLine } from './parse'
import { applyAll, applyCommand, type ApplyContext } from './apply'
import type { Command } from './types'

/**
 * The gate every clearance goes through. What is worth defending here is
 * that it refuses rather than clamps: a display that silently turns
 * "descend 200" into 1500 teaches the controller that the number they typed
 * was accepted.
 */

const base: Aircraft = {
  callsign: 'BAW178',
  type: 'A320',
  wake: 'M',
  pos: { x: 14, y: 6 },
  altFt: 7000,
  hdg: 250,
  iasKts: 240,
  gsKts: 240,
  vsFpm: 0,
  clearedHdg: 250,
  clearedAltFt: 7000,
  clearedSpdKts: 240,
  navMode: 'VECTOR',
  clearedApproach: null,
  hold: null,
  originFix: 'LAM',
  entered: true,
  trail: [],
  trailAt: 0,
  role: 'arrival',
  route: [],
  routeLeg: 0,
  destination: null,
  spawnedAt: 0,
}

const ac = (over: Partial<Aircraft> = {}): Aircraft => ({ ...base, ...over })

// EGLL's sector, an A320's envelope, and two of the four real holds.
const HOLDS: Record<string, HoldClearance> = {
  LAM: {
    fix: 'LAM',
    posNM: { x: 13.1, y: 9.4 },
    inboundTrue: 249,
    turns: 'right',
    legMins: 1,
  },
  BIG: {
    fix: 'BIG',
    posNM: { x: 12.6, y: -8.9 },
    inboundTrue: 302,
    turns: 'right',
    legMins: 1,
  },
}

/** 27R, near enough: threshold west of the field, landing westbound. */
const ILS_27R: ApproachClearance = {
  runway: '27R',
  thresholdNM: { x: 1.4, y: -0.3 },
  courseTrue: 270,
  thresholdElevationFt: 83,
  glideslopeDeg: 3,
  fafDistNM: 10,
  maxInterceptDeg: 30,
  interceptAltMaxFt: 3000,
}

/**
 * A square of controlled airspace, for tests that only care whether a
 * position is inside the area of responsibility or outside it. The real
 * shape is two published rings; a square makes the arithmetic obvious.
 */
const square = (halfNM: number): ControlZone => [
  {
    polygon: [
      { x: -halfNM, y: -halfNM },
      { x: halfNM, y: -halfNM },
      { x: halfNM, y: halfNM },
      { x: -halfNM, y: halfNM },
    ],
    floorFt: 0,
    ceilingFt: 20000,
    label: 'TEST CTA',
  },
]

const ZONE = square(40)
const WIDE_ZONE = square(60)

const ctx: ApplyContext = {
  controlZone: ZONE,
  floorFt: 1500,
  ceilingFt: 15000,
  speedLimitKts: 250,
  speedLimitBelowFt: 10000,
  envelopeFor: (type) =>
    type === 'A320' ? { minSpeedKts: 140, maxSpeedKts: 250 } : null,
  holdFor: (fix) => HOLDS[fix] ?? null,
  approachFor: (runway) => (runway === '27R' ? ILS_27R : null),
}

function accept(command: Command, aircraft = base) {
  const r = applyCommand(command, aircraft, ctx)
  if (!r.ok) throw new Error(`expected acceptance, got: ${r.reason}`)
  return r
}

function refuse(command: Command, aircraft = base): string {
  const r = applyCommand(command, aircraft, ctx)
  if (r.ok) throw new Error('expected a refusal')
  return r.reason
}

describe('heading', () => {
  it('sets the cleared heading and reads it back', () => {
    const r = accept({ kind: 'heading', callsign: 'BAW178', deg: 270 })
    expect(r.aircraft.clearedHdg).toBe(270)
    expect(r.readback).toBe('BAW178 HEADING 270')
  })

  it('pads the readback to three digits, as it is spoken', () => {
    expect(accept({ kind: 'heading', callsign: 'BAW178', deg: 70 }).readback).toBe(
      'BAW178 HEADING 070',
    )
  })

  it('leaves the actual heading alone -- the autopilot flies the turn', () => {
    // The whole reason the record keeps actual and cleared side by side.
    const r = accept({ kind: 'heading', callsign: 'BAW178', deg: 270 })
    expect(r.aircraft.hdg).toBe(base.hdg)
  })

  it('takes an aircraft out of the hold', () => {
    const r = accept({ kind: 'heading', callsign: 'BAW178', deg: 270 }, ac({ navMode: 'HOLD' }))
    expect(r.aircraft.navMode).toBe('VECTOR')
  })

  it('breaks an aircraft off an approach, at any stage of it', () => {
    // Vectoring somebody off the approach is exactly what a heading is for
    // once they are on one, and the clearance has to go with it or the next
    // tick steers them straight back onto the localiser.
    for (const navMode of ['LOC_ARMED', 'LOC_CAPTURED', 'GS_TRACKING'] as NavMode[]) {
      const r = accept(
        { kind: 'heading', callsign: 'BAW178', deg: 270 },
        ac({ navMode, clearedApproach: ILS_27R }),
      )
      expect(r.aircraft.navMode, navMode).toBe('VECTOR')
      expect(r.aircraft.clearedApproach, navMode).toBeNull()
    }
  })

  it('leaves a phase of flight it has nothing to do with alone', () => {
    const r = accept({ kind: 'heading', callsign: 'BAW178', deg: 270 }, ac({ navMode: 'GO_AROUND' }))
    expect(r.aircraft.navMode).toBe('GO_AROUND')
  })

  it('normalises a heading that came from another input path', () => {
    // The console will not produce this, but a rubber-band drag could.
    expect(accept({ kind: 'heading', callsign: 'BAW178', deg: 730 }).aircraft.clearedHdg).toBe(10)
    expect(accept({ kind: 'heading', callsign: 'BAW178', deg: -20 }).aircraft.clearedHdg).toBe(340)
  })
})

describe('altitude', () => {
  it('sets the cleared level and says which way that is', () => {
    const down = accept({ kind: 'altitude', callsign: 'BAW178', ft: 3000 })
    expect(down.aircraft.clearedAltFt).toBe(3000)
    expect(down.readback).toBe('BAW178 DESCEND 3000 FT')

    const up = accept({ kind: 'altitude', callsign: 'BAW178', ft: 9000 })
    expect(up.readback).toBe('BAW178 CLIMB 9000 FT')
  })

  it('says maintain when it is already there', () => {
    expect(accept({ kind: 'altitude', callsign: 'BAW178', ft: 7000 }).readback).toBe(
      'BAW178 MAINTAIN 7000 FT',
    )
  })

  it('rounds to the hundred, because that is how levels are cleared', () => {
    expect(accept({ kind: 'altitude', callsign: 'BAW178', ft: 3040 }).aircraft.clearedAltFt).toBe(
      3000,
    )
    expect(accept({ kind: 'altitude', callsign: 'BAW178', ft: 3060 }).aircraft.clearedAltFt).toBe(
      3100,
    )
  })

  it('refuses a level below the sector floor, with the range', () => {
    const reason = refuse({ kind: 'altitude', callsign: 'BAW178', ft: 200 })
    expect(reason).toMatch(/1500 to 15000/)
    expect(reason).toMatch(/BAW178/)
  })

  it('refuses a level above the sector ceiling', () => {
    expect(refuse({ kind: 'altitude', callsign: 'BAW178', ft: 24000 })).toMatch(/15000/)
  })

  it('accepts the floor and the ceiling themselves', () => {
    expect(accept({ kind: 'altitude', callsign: 'BAW178', ft: 1500 }).aircraft.clearedAltFt).toBe(
      1500,
    )
    expect(accept({ kind: 'altitude', callsign: 'BAW178', ft: 15000 }).aircraft.clearedAltFt).toBe(
      15000,
    )
  })
})

describe('speed', () => {
  it('sets the cleared speed', () => {
    const r = accept({ kind: 'speed', callsign: 'BAW178', kts: 180 })
    expect(r.aircraft.clearedSpdKts).toBe(180)
    expect(r.readback).toBe('BAW178 SPEED 180 KT')
  })

  it('refuses a speed the type will not fly', () => {
    // An A320 does not fly at 90 kt, and the refusal says why rather than
    // just saying no.
    const slow = refuse({ kind: 'speed', callsign: 'BAW178', kts: 90 })
    expect(slow).toMatch(/A320/)
    expect(slow).toMatch(/140 kt/)
  })

  it('refuses a speed the type has not got', () => {
    expect(refuse({ kind: 'speed', callsign: 'BAW178', kts: 400 })).toMatch(/250 kt is all/)
  })

  it('enforces the terminal area speed limit', () => {
    // 250 kt below 10,000 ft. A heavy could otherwise be cleared 280 at
    // 7000 ft, which its envelope allows and the sector does not.
    const heavy = ac({ type: 'B77W', altFt: 7000 })
    const ctxHeavy: ApplyContext = {
      ...ctx,
      envelopeFor: () => ({ minSpeedKts: 150, maxSpeedKts: 280 }),
    }
    const r = applyCommand({ kind: 'speed', callsign: 'BAW178', kts: 280 }, heavy, ctxHeavy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/250 kt is the limit below 10000/)
  })

  it('applies the limit to where the aircraft is going, not just where it is', () => {
    // Cleared down to 5000 while still at 12000: the high speed would
    // otherwise be legal at the moment it was issued and illegal a minute
    // later.
    const descending = ac({ type: 'B77W', altFt: 12000, clearedAltFt: 5000 })
    const ctxHeavy: ApplyContext = {
      ...ctx,
      envelopeFor: () => ({ minSpeedKts: 150, maxSpeedKts: 280 }),
    }
    const r = applyCommand({ kind: 'speed', callsign: 'BAW178', kts: 280 }, descending, ctxHeavy)
    expect(r.ok).toBe(false)
  })

  it('allows the high speed above the limit altitude', () => {
    const high = ac({ type: 'B77W', altFt: 14000, clearedAltFt: 14000 })
    const ctxHeavy: ApplyContext = {
      ...ctx,
      envelopeFor: () => ({ minSpeedKts: 150, maxSpeedKts: 280 }),
    }
    const r = applyCommand({ kind: 'speed', callsign: 'BAW178', kts: 280 }, high, ctxHeavy)
    expect(r.ok).toBe(true)
  })

  it('skips the envelope check for a type the config does not carry', () => {
    // Better than refusing every clearance to an aircraft whose type was
    // added to the generator but not to the fleet table.
    const unknown = ac({ type: 'C172' })
    const r = applyCommand({ kind: 'speed', callsign: 'BAW178', kts: 200 }, unknown, ctx)
    expect(r.ok).toBe(true)
  })
})

describe('holding', () => {
  it('puts the aircraft in the hold and carries the pattern with it', () => {
    const r = accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' })
    expect(r.aircraft.navMode).toBe('HOLD')
    expect(r.aircraft.hold).toEqual(HOLDS['LAM'])
    expect(r.readback).toBe('BAW178 HOLD AT LAM')
  })

  it('drops the cleared heading, which nothing is flying any more', () => {
    const vectored = ac({ clearedHdg: 270 })
    expect(accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' }, vectored).aircraft.clearedHdg)
      .toBe(null)
  })

  it('refuses a fix with no published hold, rather than inventing one', () => {
    expect(refuse({ kind: 'hold', callsign: 'BAW178', fix: 'DET' })).toBe('DET has no published hold')
  })

  it('moves an aircraft from one hold to the other', () => {
    const holding = accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' }).aircraft
    const moved = accept({ kind: 'hold', callsign: 'BAW178', fix: 'BIG' }, holding).aircraft
    expect(moved.hold?.fix).toBe('BIG')
  })

  it('lets a vector take it out of the hold, pattern and all', () => {
    const holding = accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' }).aircraft
    const out = accept({ kind: 'heading', callsign: 'BAW178', deg: 270 }, holding).aircraft
    expect(out.navMode).toBe('VECTOR')
    // Leaving the pattern on the record would steer it straight back round.
    expect(out.hold).toBe(null)
    expect(out.clearedHdg).toBe(270)
  })

  it('leaves the hold alone for a level or a speed', () => {
    // Descending an aircraft in the hold is routine and must not take it
    // out of the pattern.
    const holding = accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' }).aircraft
    const lower = accept({ kind: 'altitude', callsign: 'BAW178', ft: 7000 }, holding).aircraft
    expect(lower.navMode).toBe('HOLD')
    expect(lower.hold?.fix).toBe('LAM')

    const slower = accept({ kind: 'speed', callsign: 'BAW178', kts: 200 }, holding).aircraft
    expect(slower.navMode).toBe('HOLD')
    expect(slower.hold?.fix).toBe('LAM')
  })
})

describe('approach clearances', () => {
  it('arms the approach and carries the geometry with it', () => {
    const r = accept({ kind: 'approach', callsign: 'BAW178', runway: '27R' })
    // Armed, not established: sim/ils.ts decides whether the geometry
    // actually allows a capture, tick by tick.
    expect(r.aircraft.navMode).toBe('LOC_ARMED')
    expect(r.aircraft.clearedApproach).toEqual(ILS_27R)
    expect(r.readback).toBe('BAW178 CLEARED ILS 27R')
  })

  it('takes it out of the hold, because it cannot be doing both', () => {
    const holding = accept({ kind: 'hold', callsign: 'BAW178', fix: 'LAM' }).aircraft
    const cleared = accept({ kind: 'approach', callsign: 'BAW178', runway: '27R' }, holding).aircraft
    expect(cleared.navMode).toBe('LOC_ARMED')
    expect(cleared.hold).toBeNull()
  })

  it('refuses a runway with no ILS rather than inventing one', () => {
    expect(refuse({ kind: 'approach', callsign: 'BAW178', runway: '09L' }))
      .toBe('no ILS approach available for 09L')
  })

  it('accepts a level while the approach is only armed', () => {
    // Descending traffic onto the platform altitude is most of setting an
    // intercept up.
    const armed = accept({ kind: 'approach', callsign: 'BAW178', runway: '27R' }).aircraft
    expect(applyCommand({ kind: 'altitude', callsign: 'BAW178', ft: 3000 }, armed, ctx).ok).toBe(true)
  })

  it('refuses a level once established on the glidepath', () => {
    // The path owns the level from there. Accepting one and having the
    // approach overwrite it next tick is the thing this module exists not
    // to do.
    const established = ac({ navMode: 'GS_TRACKING', clearedApproach: ILS_27R })
    expect(refuse({ kind: 'altitude', callsign: 'BAW178', ft: 5000 }, established))
      .toMatch(/established on the glidepath/)
  })

  it('still takes a speed on the glidepath, which is how you space traffic', () => {
    const established = ac({ navMode: 'GS_TRACKING', clearedApproach: ILS_27R })
    expect(applyCommand({ kind: 'speed', callsign: 'BAW178', kts: 160 }, established, ctx).ok)
      .toBe(true)
  })
})

describe('the instructions that are not flyable yet', () => {
  it('says so plainly rather than accepting and doing nothing', () => {
    expect(refuse({ kind: 'handoff', callsign: 'BAW178' })).toMatch(/nobody to hand off to/)
  })
})

describe('a whole line', () => {
  it('applies every instruction in order', () => {
    const r = applyAll(
      [
        { kind: 'heading', callsign: 'BAW178', deg: 270 },
        { kind: 'altitude', callsign: 'BAW178', ft: 3000 },
        { kind: 'speed', callsign: 'BAW178', kts: 180 },
      ],
      base,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.aircraft.clearedHdg).toBe(270)
    expect(r.aircraft.clearedAltFt).toBe(3000)
    expect(r.aircraft.clearedSpdKts).toBe(180)
    expect(r.readbacks).toHaveLength(3)
  })

  it('is all or nothing', () => {
    // A refused speed must not leave the aircraft already turned and
    // descending: the controller would have to work out which half of what
    // they typed had taken effect.
    const r = applyAll(
      [
        { kind: 'heading', callsign: 'BAW178', deg: 270 },
        { kind: 'speed', callsign: 'BAW178', kts: 400 },
      ],
      base,
      ctx,
    )
    expect(r.ok).toBe(false)
  })

  it('judges each instruction against the ones before it', () => {
    // The descent below 10,000 ft is what makes 280 kt illegal, and it is
    // in the same line.
    const ctxHeavy: ApplyContext = {
      ...ctx,
      envelopeFor: () => ({ minSpeedKts: 150, maxSpeedKts: 280 }),
    }
    const high = ac({ type: 'B77W', altFt: 14000, clearedAltFt: 14000 })
    const r = applyAll(
      [
        { kind: 'altitude', callsign: 'BAW178', ft: 5000 },
        { kind: 'speed', callsign: 'BAW178', kts: 280 },
      ],
      high,
      ctxHeavy,
    )
    expect(r.ok).toBe(false)
  })

  it('leaves the aircraft untouched when there is nothing to do', () => {
    const r = applyAll([], base, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.aircraft).toEqual(base)
  })
})

describe('from a typed line to a turning aircraft', () => {
  // The whole chain in one place: what the controller types, through the
  // parser and the gate, into the autopilot that flies it. Each part is
  // tested on its own above; this is the seam between them.

  it('turns, descends and slows an aircraft that was told to', () => {
    const parsed = parseCommandLine('178 H270 A30 S180', {
      callsigns: ['BAW178', 'VIR45'],
      selected: null,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const issued = applyAll(parsed.commands, base, ctx)
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    // Cleared, but not yet flown: the radar still sees the old numbers.
    expect(issued.aircraft.clearedHdg).toBe(270)
    expect(issued.aircraft.hdg).toBe(250)

    // Ten seconds of autopilot at 3 deg/sec is 30 degrees of turn, and the
    // aircraft was 20 degrees off.
    const after = autopilot(issued.aircraft, 10)
    expect(after.hdg).toBe(270)
    expect(after.altFt).toBeLessThan(7000)
    expect(after.vsFpm).toBeLessThan(0)
    expect(after.iasKts).toBeLessThan(240)
  })

  it('leaves an aircraft alone when the line is refused', () => {
    const parsed = parseCommandLine('BAW178 H270 S400', {
      callsigns: ['BAW178'],
      selected: null,
    })
    if (!parsed.ok) throw new Error(parsed.error)
    const issued = applyAll(parsed.commands, base, ctx)
    expect(issued.ok).toBe(false)

    // And a minute of flying changes nothing about its clearance.
    const after = autopilot(base, 60)
    expect(after.hdg).toBe(base.hdg)
    expect(after.altFt).toBe(base.altFt)
  })

  it('sends an instruction to the selected aircraft when none is named', () => {
    const parsed = parseCommandLine('A50', { callsigns: ['BAW178'], selected: 'BAW178' })
    if (!parsed.ok) throw new Error(parsed.error)
    const issued = applyAll(parsed.commands, base, ctx)
    expect(issued.ok).toBe(true)
    if (issued.ok) expect(issued.aircraft.clearedAltFt).toBe(5000)
  })
})

describe('traffic outside the area of responsibility', () => {
  /**
   * The rule that makes the boundary mean something rather than being a
   * circle on a display: an aircraft that is not yours takes no
   * instructions, whatever the instruction is.
   */
  const coming = ac({ pos: { x: 48, y: 0 }, entered: false })

  it('refuses every kind of clearance, by name', () => {
    const commands: Command[] = [
      { kind: 'heading', callsign: 'BAW178', deg: 270 },
      { kind: 'altitude', callsign: 'BAW178', ft: 5000 },
      { kind: 'speed', callsign: 'BAW178', kts: 200 },
      { kind: 'approach', callsign: 'BAW178', runway: '27R' },
      { kind: 'hold', callsign: 'BAW178', fix: 'LAM' },
      { kind: 'handoff', callsign: 'BAW178' },
    ]
    for (const command of commands) {
      expect(refuse(command, coming), command.kind).toBe('BAW178 is not in your airspace yet')
    }
  })

  it('accepts the same clearance the moment it is inside', () => {
    const inside = ac({ pos: { x: 30, y: 0 }, entered: true })
    expect(applyCommand({ kind: 'heading', callsign: 'BAW178', deg: 270 }, inside, ctx).ok)
      .toBe(true)
  })

  it('judges it on where it is, not on whether it has been in before', () => {
    // An aircraft that entered and has drifted back out is equally
    // untouchable, and the world is about to remove it anyway.
    const gone = ac({ pos: { x: 48, y: 0 }, entered: true })
    expect(refuse({ kind: 'heading', callsign: 'BAW178', deg: 270 }, gone))
      .toBe('BAW178 is not in your airspace yet')
  })

  it('takes the boundary from the context rather than assuming one', () => {
    const wide: ApplyContext = { ...ctx, controlZone: WIDE_ZONE }
    expect(applyCommand({ kind: 'heading', callsign: 'BAW178', deg: 270 }, coming, wide).ok)
      .toBe(true)
  })
})

describe('a session with the airspace rule switched off', () => {
  /**
   * The toggle in the logon window arrives here as a null zone. What has to
   * be true is that the gate stops gating -- everything on the display
   * takes a clearance, wherever it is and whatever level it is at.
   */
  const open: ApplyContext = { ...ctx, controlZone: null }
  const anywhere = ac({ pos: { x: 300, y: -200 }, altFt: 400, entered: true })

  it('accepts a clearance for traffic that would be outside', () => {
    expect(applyCommand({ kind: 'heading', callsign: 'BAW178', deg: 270 }, anywhere, open).ok)
      .toBe(true)
  })

  it('accepts a level that would be below controlled airspace', () => {
    // With no airspace there is no below it.
    expect(applyCommand({ kind: 'altitude', callsign: 'BAW178', ft: 2000 }, anywhere, open).ok)
      .toBe(true)
  })

  it('still enforces everything that is not about the boundary', () => {
    // The sector limits, the envelope and the speed limit are the aircraft
    // and the procedure, not the airspace, so they all still apply.
    const why = (c: Command): string => {
      const r = applyCommand(c, anywhere, open)
      if (r.ok) throw new Error('expected a refusal')
      return r.reason
    }
    expect(why({ kind: 'altitude', callsign: 'BAW178', ft: 99000 })).toContain('cannot be cleared')
    expect(why({ kind: 'speed', callsign: 'BAW178', kts: 40 })).toContain('will not fly below')
  })
})

describe('resuming own navigation', () => {
  /** A transit on a route running east, currently being vectored off it. */
  const transit: Aircraft = {
    ...base,
    callsign: 'EZY42',
    role: 'overflight',
    destination: 'EGKK',
    navMode: 'VECTOR',
    clearedHdg: 360,
    route: [
      { fix: 'ALPHA', posNM: { x: 0, y: 0 } },
      { fix: 'BRAVO', posNM: { x: 10, y: 0 } },
    ],
    routeLeg: 0,
    pos: { x: -8, y: 4 },
  }

  const nav = (a: Aircraft) =>
    applyCommand({ kind: 'resumeNav', callsign: a.callsign }, a, ctx)

  it('hands the aeroplane back to its flight plan', () => {
    const out = nav(transit)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.aircraft.navMode).toBe('LNAV')
    // The vector is over, so nothing on the strip should still show one.
    expect(out.aircraft.clearedHdg).toBeNull()
    expect(out.readback).toContain('OWN NAVIGATION')
    expect(out.readback).toContain('ALPHA')
  })

  it('rejoins forwards when the vector took it past a fix', () => {
    // The one thing it must never do is turn the aeroplane round.
    const past = { ...transit, pos: { x: 8, y: 2 } }
    const out = nav(past)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.aircraft.routeLeg).toBe(1)
    expect(out.readback).toContain('BRAVO')
  })

  it('refuses an aircraft with no route, and says why', () => {
    // An arrival is being vectored to a runway. That is the job, not a
    // detour from a plan it could be given back.
    const out = nav({ ...base, route: [] })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('no route')
  })

  it('refuses one established on an approach', () => {
    // Taking it off the beam as a side effect would be exactly the sort of
    // surprise a refusal exists to prevent. Vector it off first.
    const out = nav({ ...transit, navMode: 'GS_TRACKING' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('approach')
  })

  it('is refused outside the area of responsibility like anything else', () => {
    const out = nav({ ...transit, entered: false, pos: { x: 200, y: 200 } })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('not in your airspace')
  })

  it('can be typed as well as clicked', () => {
    for (const line of ['EZY42 NAV', 'EZY42 RESUME', 'EZY42 OWNNAV']) {
      const parsed = parseCommandLine(line, {
        callsigns: ['EZY42'],
        selected: null,
      })
      expect(parsed.ok, line).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.commands[0]?.kind, line).toBe('resumeNav')
    }
  })
})
