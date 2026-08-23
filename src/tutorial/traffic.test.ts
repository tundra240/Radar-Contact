import { describe, expect, it } from 'vitest'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { makeRng } from '../core/rng'
import { isInSector, stepAircraft } from '../sim/aircraft'
import { conflictsIn } from '../sim/conflict'
import { bandOf, intensityAt, makeWeather, withScriptedCells } from '../sim/weather'
import { leavesOf } from './engine'
import { BASICS } from './lessons/basics'
import { buildTraffic, buildWeather, refsOf } from './traffic'
import type { Goal, ScriptedAircraft, Spotlight, TutorialModule } from './types'

const airport = loadAirport(raw)

describe('building a step traffic', () => {
  it('places an arrival exactly where the spawner would', () => {
    // Out along the radial through its fix and clear of the airspace, so it
    // flies in rather than appearing inside. Same as every other arrival.
    const built = buildTraffic(
      airport,
      [{ ref: 'a', kind: 'arrival', fix: 'BIG', altFt: 10000, iasKts: 250, callsign: 'BAW214' }],
      0,
    )
    expect(built).toHaveLength(1)
    const a = built[0]
    expect(a?.callsign).toBe('BAW214')
    expect(a?.altFt).toBe(10000)
    expect(a?.iasKts).toBe(250)
    expect(a?.entered).toBe(false)
    expect(isInSector(a as never, airport.controlZone)).toBe(false)
  })

  it('gives it the hold it will enter on arrival', () => {
    // The lesson teaches that an arrival with no further clearance holds.
    // It only teaches that if the aeroplane is actually carrying one.
    const [a] = buildTraffic(
      airport,
      [{ ref: 'a', kind: 'arrival', fix: 'BIG', altFt: 10000, iasKts: 250 }],
      0,
    )
    expect(a?.navMode).toBe('HOLD')
    expect(a?.hold?.fix).toBe('BIG')
    expect(a?.originFix).toBe('BIG')
    // Nobody has vectored it, so nothing on the strip should say otherwise.
    expect(a?.clearedHdg).toBeNull()
  })

  it('actually reaches its fix when flown', () => {
    // The step that waits for the hold would otherwise wait for ever.
    // Flown for real, through the same step function the session uses.
    const [start] = buildTraffic(
      airport,
      [{ ref: 'a', kind: 'arrival', fix: 'BIG', altFt: 10000, iasKts: 250 }],
      0,
    )
    const big = airport.navaids.find((n) => n.name === 'BIG')
    let a = start as never as ReturnType<typeof stepAircraft>
    let established = false
    for (let i = 0; i < 25 * 60 * 20 && !established; i += 1) {
      a = stepAircraft(a, 0.05, i * 0.05)
      established =
        a.navMode === 'HOLD' &&
        Math.hypot(a.pos.x - (big?.posNM.x ?? 0), a.pos.y - (big?.posNM.y ?? 0)) < 8
    }
    expect(established).toBe(true)
  })

  it('places a transit on the corridor it names', () => {
    const [a] = buildTraffic(
      airport,
      [
        {
          ref: 't',
          kind: 'overflight',
          corridor: 'KK-EAST',
          altFt: 14000,
          iasKts: 280,
          callsign: 'EZY63',
        },
      ],
      0,
    )
    expect(a?.role).toBe('overflight')
    expect(a?.navMode).toBe('LNAV')
    expect(a?.destination).toBe('EGKK')
    expect(a?.route.map((l) => l.fix)).toEqual(['DET', 'MAY', 'EGKK'])
    expect(a?.altFt).toBe(14000)
  })

  it('is the same lesson every time it is taken', () => {
    // The one property a lesson must have and a session deliberately must
    // not: nothing here is drawn from a seed.
    const spec: readonly ScriptedAircraft[] = [
      { ref: 'a', kind: 'arrival', fix: 'BIG', altFt: 10000, iasKts: 250, callsign: 'BAW214' },
      {
        ref: 't',
        kind: 'overflight',
        corridor: 'KK-EAST',
        altFt: 14000,
        iasKts: 280,
        callsign: 'EZY63',
      },
    ]
    expect(JSON.stringify(buildTraffic(airport, spec, 0))).toBe(
      JSON.stringify(buildTraffic(airport, spec, 0)),
    )
  })

  it('drops a spec this airport cannot place rather than throwing', () => {
    // A lesson written against another field should degrade to a shorter
    // lesson, not to a blank screen.
    const built = buildTraffic(
      airport,
      [
        { ref: 'a', kind: 'arrival', fix: 'NOPE', altFt: 9000, iasKts: 250 },
        { ref: 'b', kind: 'arrival', fix: 'BIG', altFt: 9000, iasKts: 250, callsign: 'OK1' },
      ],
      0,
    )
    expect(built.map((a) => a.callsign)).toEqual(['OK1'])
  })

  it('names each aircraft so goals can refer to it', () => {
    const spec: readonly ScriptedAircraft[] = [
      { ref: 'one', kind: 'arrival', fix: 'BIG', altFt: 9000, iasKts: 250, callsign: 'BAW51' },
      { ref: 'two', kind: 'arrival', fix: 'OCK', altFt: 10000, iasKts: 250, callsign: 'EIN802' },
    ]
    expect(refsOf(spec, buildTraffic(airport, spec, 0))).toEqual({
      one: 'BAW51',
      two: 'EIN802',
    })
  })

  it('starts the checkride traffic already separated', () => {
    // A step that resets on a breach must not open with one. Three aircraft
    // and no conflict between any pair, before the player touches anything.
    const checkride = BASICS.steps.find((s) => s.id === 'checkride')
    const built = buildTraffic(airport, checkride?.scene?.traffic ?? [], 0)
    expect(built).toHaveLength(3)
    // Marked as the controller's, since the scan ignores what is not.
    expect(conflictsIn(built.map((a) => ({ ...a, entered: true })))).toEqual([])
  })
})

describe('building a step weather', () => {
  const STORM = { overFix: 'OCK', radiusNM: 7, peak: 0.95, lifeMinutes: 45 }

  it('puts a storm over the fix the lesson names', () => {
    const [cell] = buildWeather(airport, [STORM], 0)
    const ock = airport.navaids.find((n) => n.name === 'OCK')
    expect(cell?.originNM).toEqual(ock?.posNM)
  })

  it('is at full strength the moment the step arrives', () => {
    // Born half a life ago, so it is at its peak now rather than growing
    // from nothing while the instruction is being read.
    const cells = buildWeather(airport, [STORM], 600)
    const weather = withScriptedCells(makeWeather(makeRng(1), airport.weather), cells)
    const ock = airport.navaids.find((n) => n.name === 'OCK')
    expect(bandOf(intensityAt(weather, ock?.posNM ?? { x: 0, y: 0 }, 600))).toBe('heavy')
  })

  it('stays where it was put', () => {
    // A storm the lesson says is over OCK should still be over OCK when the
    // player looks up from the instruction.
    expect(buildWeather(airport, [STORM], 0)[0]?.driftFactor).toBe(0)
  })

  it('leaves the session own weather alone', () => {
    // One seed, two schedules. Adding a lesson's storm must not change what
    // the session would have produced on its own.
    const plain = makeWeather(makeRng(4242), airport.weather)
    const withStorm = withScriptedCells(plain, buildWeather(airport, [STORM], 0))
    expect(withStorm.seed).toBe(plain.seed)
    expect(withStorm.config).toBe(plain.config)
    expect(plain.scripted).toEqual([])
  })

  it('clears them again', () => {
    const some = withScriptedCells(
      makeWeather(makeRng(1), airport.weather),
      buildWeather(airport, [STORM], 0),
    )
    expect(withScriptedCells(some, []).scripted).toEqual([])
  })
})

/* --------------------------------------------------------- the lesson data */

/** Every ref a goal or a spotlight mentions, with the step it is in. */
function refsMentioned(module: TutorialModule): { step: string; ref: string }[] {
  const out: { step: string; ref: string }[] = []
  for (const step of module.steps) {
    for (const leaf of leavesOf(step.goal)) {
      const ref = (leaf as Goal & { ref?: string }).ref
      if (ref !== undefined) out.push({ step: step.id, ref })
    }
    const light: Spotlight = step.spotlight
    if (light.kind === 'aircraft') out.push({ step: step.id, ref: light.ref })
  }
  return out
}

describe('the basics lesson', () => {
  it('covers every phase the brief asks for', () => {
    const ids = BASICS.steps.map((s) => s.id)
    for (const id of [
      'welcome',
      'time',
      'inbound',
      'hold',
      'select',
      'descend',
      'downwind',
      'atis',
      'base',
      'clear-ils',
      'transit',
      'resume-nav',
      'weather',
      'checkride',
    ]) {
      expect(ids, id).toContain(id)
    }
  })

  it('has a unique id on every step', () => {
    const ids = BASICS.steps.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every step something to say and a way out of it', () => {
    for (const step of BASICS.steps) {
      expect(step.title.length, step.id).toBeGreaterThan(0)
      expect(step.text.length, step.id).toBeGreaterThan(20)
      const hasButton = (step.button ?? null) !== null
      const waitsForAction = step.goal.kind !== 'continue'
      // Either a button or an action, never neither -- a step with no way
      // out is a lesson that stops.
      expect(hasButton || waitsForAction, step.id).toBe(true)
      // And never a button on a step that advances on an action, or the
      // player could press past the thing being taught.
      if (waitsForAction) expect(step.button ?? null, step.id).toBeNull()
    }
  })

  it('only refers to aircraft it has put on the scope', () => {
    // The failure this catches is a lesson that waits for ever: a goal
    // naming a ref no step ever spawned can never be satisfied.
    const spawned = new Set<string>()
    for (const step of BASICS.steps) {
      for (const spec of step.scene?.traffic ?? []) spawned.add(spec.ref)
      for (const { ref } of refsMentioned({ ...BASICS, steps: [step] })) {
        expect(spawned, `${step.id} refers to "${ref}"`).toContain(ref)
      }
    }
  })

  it('names only fixes and corridors this airport has', () => {
    const fixes = new Set(airport.navaids.map((n) => n.name))
    const corridors = new Set((airport.overflights?.corridors ?? []).map((c) => c.id))
    for (const step of BASICS.steps) {
      if (step.spotlight.kind === 'fix') expect(fixes).toContain(step.spotlight.name)
      for (const spec of step.scene?.traffic ?? []) {
        if (spec.kind === 'arrival') expect(fixes, step.id).toContain(spec.fix)
        else expect(corridors, step.id).toContain(spec.corridor)
      }
      for (const storm of step.scene?.weather ?? []) {
        expect(fixes, step.id).toContain(storm.overFix)
      }
    }
  })

  it('spotlights controls that exist in the interface', () => {
    // A selector matching nothing leaves the mask with no hole in it, which
    // reads as the lesson pointing at nothing at all.
    const known = new Set([
      'canvas',
      '.rate-button',
      '.pause-button',
      '.atis-button',
      '.atis-box',
      '.tagmenu',
      '.strip-bay',
    ])
    for (const step of BASICS.steps) {
      const light = step.spotlight
      const selectors =
        light.kind === 'element'
          ? [light.selector]
          : light.kind === 'elements'
            ? light.selectors
            : []
      for (const selector of selectors) {
        expect(known, `${step.id} points at ${selector}`).toContain(selector)
      }
    }
  })

  it('starts paused with a clear scope', () => {
    // A lesson dropped into whatever traffic the session had accumulated
    // would be a different lesson every time it was taken.
    const first = BASICS.steps[0]
    expect(first?.scene?.paused).toBe(true)
    expect(first?.scene?.traffic).toEqual([])
    expect(first?.scene?.weather).toEqual([])
  })

  it('only watches for a breach on a step that could have one', () => {
    for (const step of BASICS.steps) {
      if (!(step.resetOn ?? []).includes('conflict')) continue
      // A breach needs two aeroplanes. A step resetting on one it cannot
      // reach would never reset, which is a quieter bug than one that does.
      expect((step.scene?.traffic ?? []).length, step.id).toBeGreaterThan(1)
    }
  })
})
