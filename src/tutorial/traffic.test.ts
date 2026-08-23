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

/** A spotlight, with any group taken apart. */
function flatten(light: Spotlight): readonly Spotlight[] {
  return light.kind === 'group' ? light.of.flatMap((one) => flatten(one)) : [light]
}

/** Every ref a goal or a spotlight mentions, with the step it is in. */
function refsMentioned(module: TutorialModule): { step: string; ref: string }[] {
  const out: { step: string; ref: string }[] = []
  for (const step of module.steps) {
    for (const leaf of leavesOf(step.goal)) {
      const ref = (leaf as Goal & { ref?: string }).ref
      if (ref !== undefined) out.push({ step: step.id, ref })
    }
    for (const light of flatten(step.spotlight)) {
      if (light.kind === 'aircraft') out.push({ step: step.id, ref: light.ref })
    }
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
      for (const light of flatten(step.spotlight)) {
        if (light.kind === 'fix') expect(fixes).toContain(light.name)
      }
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
      const selectors = flatten(step.spotlight).flatMap((light) =>
        light.kind === 'element'
          ? [light.selector]
          : light.kind === 'elements'
            ? light.selectors
            : [],
      )
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

describe('the instructions match the interface', () => {
  /**
   * The failure this exists to catch, which happened: the descent step told
   * the player they could type the clearance, and the command line had been
   * taken out of the interface some time before. The step was reachable, the
   * menu worked, and anyone who followed the sentence rather than guessing
   * was stuck on it with nothing to press.
   *
   * So an instruction may only name a way of doing something that exists.
   */
  const stepsOf = BASICS.steps

  it('never tells the player to type a clearance', () => {
    // There is no command line. Clearances are the tag menu and the drag.
    for (const step of stepsOf) {
      // The verb, followed by something callsign-shaped. The noun is fine:
      // a strip legitimately shows an aircraft type.
      expect(step.text, step.id).not.toMatch(/\btype\s+(?:in\s+)?[A-Z]{2,3}\d/)
      expect(step.text.toLowerCase(), step.id).not.toMatch(/keyboard/)
      expect(step.text.toLowerCase(), step.id).not.toMatch(/command line/)
    }
  })

  it('says to right-click for anything that comes off the menu', () => {
    // Altitude, speed, the approach and RESUME NAV are all menu items and
    // nothing else reaches them, so a step wanting one has to say so.
    const fromMenu = new Set(['altitude', 'airspeed', 'approach', 'resumeNav'])
    for (const step of stepsOf) {
      const wants = leavesOf(step.goal).filter((g) => fromMenu.has(g.kind))
      if (wants.length === 0) continue
      expect(step.text.toLowerCase(), `${step.id} needs the menu`).toMatch(
        /right-click|menu/,
      )
    }
  })

  it('says to drag for anything that is a heading', () => {
    // A heading is not in the menu's root as a value -- it is pulled out of
    // the target -- so a step asking for one has to describe the drag.
    for (const step of stepsOf) {
      const wants = leavesOf(step.goal).filter(
        (g) => g.kind === 'heading' || g.kind === 'vector',
      )
      if (wants.length === 0) continue
      expect(step.text.toLowerCase(), `${step.id} needs a drag`).toMatch(/drag|pull/)
    }
  })

  it('names the exact value it is asking for', () => {
    // "Descend it" is not an instruction. "Pick 3000" is.
    for (const step of stepsOf) {
      for (const goal of leavesOf(step.goal)) {
        if (goal.kind === 'altitude') {
          expect(step.text, `${step.id} should name ${goal.ft}`).toContain(String(goal.ft))
        }
        if (goal.kind === 'airspeed') {
          expect(step.text, `${step.id} should name ${goal.kts}`).toContain(String(goal.kts))
        }
        if (goal.kind === 'heading') {
          // Headings are spoken as three digits, and 360 reads as itself.
          const spoken = String(goal.deg).padStart(3, '0')
          expect(step.text, `${step.id} should name ${spoken}`).toContain(spoken)
        }
        if (goal.kind === 'speed') {
          expect(step.text, `${step.id} should name x${goal.to}`).toContain(`x${goal.to}`)
        }
      }
    }
  })

  it('names the aircraft each step is about', () => {
    // The scope can hold several. "The target" is ambiguous the moment it
    // does, and the checkride names all three by naming none.
    const named = new Map()
    for (const step of stepsOf) {
      for (const spec of step.scene?.traffic ?? []) {
        if (spec.callsign !== undefined) named.set(spec.ref, spec.callsign)
      }
      const refs = leavesOf(step.goal)
        .map((g) => (g as { ref?: string }).ref)
        .filter((r) => r !== undefined)
      // One aircraft in play and a step that acts on it: the callsign should
      // be in the text, so the player knows which strip to look at.
      if (new Set(refs).size !== 1) continue
      const callsign = named.get(refs[0])
      if (callsign === undefined) continue
      expect(step.text, `${step.id} should name ${callsign}`).toContain(callsign)
    }
  })
})
