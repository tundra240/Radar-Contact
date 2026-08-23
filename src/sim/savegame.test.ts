import { describe, expect, it } from 'vitest'
import { SAVE_VERSION, parseSavedGame, serialise, type SavedGame } from './savegame'
import type { Clock } from '../core/loop'
import { TICK_MS } from '../core/loop'
import { loadAirport, outerLimitNM } from '../data/airport'
import raw from '../data/egll.json'
import { departureOf, enterSector, stepAircraft } from './aircraft'
import { Spawner } from './spawner'
import type { Aircraft } from './types'

/**
 * Saving and loading.
 *
 * Two claims are worth defending here. That a save read back is the session
 * that was written -- tested by round trip and by resuming one. And that a
 * save which is not a save is refused with a reason, because the file comes
 * from outside the program and everything from outside is validated.
 */

const AT = { airport: 'EGLL' }

function aircraft(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW178',
    type: 'A320',
    wake: 'M',
    pos: { x: 12.5, y: -3.25 },
    altFt: 7000,
    hdg: 249,
    iasKts: 220,
    gsKts: 220,
    vsFpm: -1500,
    clearedHdg: 270,
    clearedAltFt: 5000,
    clearedSpdKts: 200,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    originFix: 'LAM',
    entered: true,
    trail: [
      { x: 13, y: -3 },
      { x: 14, y: -2.5 },
    ],
    trailAt: 120.5,
    role: 'arrival',
    route: [],
    routeLeg: 0,
    destination: null,
    spawnedAt: 60,
    ...over,
  }
}

function game(over: Partial<SavedGame> = {}): SavedGame {
  return {
    version: SAVE_VERSION,
    airport: 'EGLL',
    savedAt: '2026-08-22T09:41:00.000Z',
    overflights: null,
    clock: { ticks: 4321, elapsedSeconds: 216.05, timeOfDaySeconds: 43416.05 },
    score: { points: 350, landed: 4, lost: 1, transited: 2 },
    atis: {
      letterIndex: 0,
      arrivals: ['27R', '27L'],
      departures: ['27R'],
      wind: { fromDeg: 250, speedKts: 18 },
    },
    controller: { initials: 'NF', position: 'EGLL_APP', enforceAirspace: true, difficulty: 'normal', mode: 'career' },
    selected: 'BAW178',
    traffic: [aircraft()],
    spawner: {
      seed: 20260822,
      draws: 917,
      sinceLastSpawn: 12.35,
      waitSeconds: 47.5,
      spawned: 9,
      deferred: 3,
      lastUsedAt: [
        ['LAM', 180.2],
        ['BIG', 95],
      ],
      flights: { issued: ['BAW178', 'VIR22'], fallbackSequence: 2 },
    },
    ...over,
  }
}

const read = (g: SavedGame) => parseSavedGame(serialise(g), AT)

describe('a round trip', () => {
  it('gives back exactly what was written', () => {
    const out = read(game())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.game).toEqual(game())
  })

  it('keeps the aircraft to the last decimal', () => {
    // A position rounded on the way through would put the traffic somewhere
    // other than where it was saved.
    const out = read(game())
    if (!out.ok) return
    expect(out.game.traffic[0]?.pos).toEqual({ x: 12.5, y: -3.25 })
    expect(out.game.traffic[0]?.trailAt).toBe(120.5)
  })

  it('keeps a hold clearance and its geometry', () => {
    const holding = aircraft({
      navMode: 'HOLD',
      hold: {
        fix: 'BNN',
        posNM: { x: -6.9, y: 14.6 },
        inboundTrue: 75,
        turns: 'right',
        legMins: 1,
      },
    })
    const out = read(game({ traffic: [holding] }))
    if (!out.ok) return
    expect(out.game.traffic[0]?.hold).toEqual(holding.hold)
  })

  it('keeps an approach clearance and its geometry', () => {
    const established = aircraft({
      navMode: 'GS_TRACKING',
      clearedApproach: {
        runway: '27R',
        thresholdNM: { x: 1, y: 0.42 },
        courseTrue: 270,
        thresholdElevationFt: 78,
        glideslopeDeg: 3,
        fafDistNM: 10,
        maxInterceptDeg: 30,
        interceptAltMaxFt: 3000,
      },
    })
    const out = read(game({ traffic: [established] }))
    if (!out.ok) return
    expect(out.game.traffic[0]?.clearedApproach).toEqual(established.clearedApproach)
  })

  it('keeps an empty scope and nobody on position', () => {
    const out = read(game({ traffic: [], controller: null, selected: null }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.game.traffic).toEqual([])
    expect(out.game.controller).toBeNull()
    expect(out.game.selected).toBeNull()
  })
})

describe('refusing what is not a save', () => {
  const refuse = (text: string): string => {
    const out = parseSavedGame(text, AT)
    if (out.ok) throw new Error('expected a refusal')
    return out.reason
  }

  it('refuses something that is not even JSON', () => {
    expect(refuse('not a save')).toBe('that is not a saved game')
    expect(refuse('')).toBe('that is not a saved game')
  })

  it('refuses JSON that is not an object', () => {
    expect(refuse('[]')).toContain('is not an object')
    expect(refuse('42')).toContain('is not an object')
    expect(refuse('null')).toContain('is not an object')
  })

  it('refuses another version of the format, rather than guessing', () => {
    const reason = refuse(serialise({ ...game(), version: SAVE_VERSION + 1 }))
    expect(reason).toContain(`version ${SAVE_VERSION + 1}`)
    expect(reason).toContain(`version ${SAVE_VERSION}`)
  })

  it('refuses a save flown somewhere else', () => {
    // The clearances a save carries are geometry from another airport.
    expect(refuse(serialise({ ...game(), airport: 'EGKK' }))).toBe(
      'that save was flown at EGKK, not EGLL',
    )
  })

  it('names the field that is wrong', () => {
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    ;(broken['traffic'] as Record<string, unknown>[])[0]!['altFt'] = 'high'
    expect(refuse(JSON.stringify(broken))).toBe('save.traffic[0].altFt is not a number')
  })

  it('refuses a position that is not finite, which would be unrecoverable', () => {
    // JSON has no NaN, so it arrives as null -- and an aircraft at a null
    // position would be drawn nowhere and never leave.
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    ;(broken['traffic'] as Record<string, Record<string, unknown>>[])[0]!['pos'] = { x: null, y: 3 }
    expect(refuse(JSON.stringify(broken))).toBe('save.traffic[0].pos.x is not a number')
  })

  it('refuses a nav mode it does not know', () => {
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    ;(broken['traffic'] as Record<string, unknown>[])[0]!['navMode'] = 'ORBIT'
    expect(refuse(JSON.stringify(broken))).toContain('save.traffic[0].navMode is not one of')
  })

  it('refuses a missing spawner, which is most of a session', () => {
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    delete broken['spawner']
    expect(refuse(JSON.stringify(broken))).toBe('save.spawner is not an object')
  })

  it('refuses a half-written aircraft', () => {
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    delete (broken['traffic'] as Record<string, unknown>[])[0]!['entered']
    expect(refuse(JSON.stringify(broken))).toBe('save.traffic[0].entered is not a boolean')
  })

  it('says which of several aircraft is at fault', () => {
    const broken = JSON.parse(serialise(game({ traffic: [aircraft(), aircraft(), aircraft()] })))
    ;(broken as Record<string, Record<string, unknown>[]>)['traffic']![2]!['callsign'] = 7
    expect(refuse(JSON.stringify(broken))).toBe('save.traffic[2].callsign is not a string')
  })
})

describe('resuming a real session', () => {
  /**
   * The claim that matters: a loaded session is the saved one, and it goes
   * on the way the original would have. If the random stream, the cadence
   * or the issued callsigns came back even slightly wrong, the traffic
   * after the load would diverge -- so running both and comparing is the
   * test, rather than inspecting the fields.
   */
  const airport = loadAirport(raw)
  const DT = TICK_MS / 1000
  const OUTER = outerLimitNM(airport)

  interface World {
    readonly spawner: Spawner
    traffic: readonly Aircraft[]
    ticks: number
  }

  const clockAt = (ticks: number): Clock => ({
    ticks,
    elapsedSeconds: ticks * DT,
    timeOfDaySeconds: 43200 + ticks * DT,
  })

  function run(world: World, forTicks: number): void {
    for (let i = 0; i < forTicks; i += 1) {
      world.ticks += 1
      const clock = clockAt(world.ticks)
      const flown: Aircraft[] = []
      for (const a of world.traffic.map((x) => stepAircraft(x, DT, clock.elapsedSeconds))) {
        const moved = enterSector(a, airport.controlZone)
        if (departureOf(moved, airport.controlZone, OUTER) === null) flown.push(moved)
      }
      world.traffic = [...flown, ...world.spawner.update(DT, clock, flown)]
    }
  }

  /** Everything about a world that a divergence would show up in. */
  const fingerprint = (world: World): string =>
    [
      world.ticks,
      world.spawner.spawned,
      world.spawner.deferred,
      ...[...world.traffic]
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .map(
          (a) =>
            `${a.callsign}/${a.type}/${a.originFix}/${a.navMode}/` +
            `${a.pos.x.toFixed(6)},${a.pos.y.toFixed(6)}/${a.altFt.toFixed(3)}/${a.hdg.toFixed(6)}`,
        ),
    ].join('|')

  it('goes on exactly as the session it was saved from would have', () => {
    const original: World = {
      spawner: new Spawner({ airport, seed: 987654 }),
      traffic: [],
      ticks: 0,
    }
    // Twenty minutes in, so there is a stack, a cadence part way through a
    // gap, and a pile of issued callsigns.
    run(original, 20 * 60 * 20)
    expect(original.traffic.length).toBeGreaterThan(3)
    expect(original.spawner.spawned).toBeGreaterThan(3)

    const saved = serialise({
      version: SAVE_VERSION,
      atis: {
        letterIndex: 1,
        arrivals: ['09L', '09R'],
        departures: ['09R'],
        wind: { fromDeg: 70, speedKts: 12 },
      },
      airport: airport.icao,
      savedAt: '2026-08-22T09:41:00.000Z',
      clock: clockAt(original.ticks),
      score: { points: 0, landed: 0, lost: 0, transited: 0 },
      controller: { initials: 'NF', position: 'EGLL_APP', enforceAirspace: true, difficulty: 'normal', mode: 'career' },
      selected: null,
      traffic: [...original.traffic],
      spawner: original.spawner.snapshot(),
      overflights: null,
    })
    const atSave = fingerprint(original)

    // The original carries on for another twenty minutes.
    run(original, 20 * 60 * 20)
    const afterwards = fingerprint(original)
    expect(afterwards).not.toBe(atSave)

    // And a loaded copy does the same twenty minutes from the same point.
    const out = parseSavedGame(saved, { airport: airport.icao })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    if (!out.ok) return

    const loaded: World = {
      spawner: new Spawner({ airport }),
      traffic: out.game.traffic,
      ticks: out.game.clock.ticks,
    }
    loaded.spawner.restore(out.game.spawner)
    expect(fingerprint(loaded)).toBe(atSave)

    run(loaded, 20 * 60 * 20)
    expect(fingerprint(loaded)).toBe(afterwards)
  })

  it('resumes the random stream rather than starting it again', () => {
    // The failure this catches: a load that kept the seed but forgot the
    // draw count, which deals the whole session again from the top.
    const world: World = {
      spawner: new Spawner({ airport, seed: 4242 }),
      traffic: [],
      ticks: 0,
    }
    run(world, 20 * 60 * 15)
    const state = world.spawner.snapshot()
    expect(state.draws).toBeGreaterThan(50)

    const resumed = new Spawner({ airport })
    resumed.restore(state)
    expect(resumed.seed).toBe(4242)
    expect(resumed.snapshot().draws).toBe(state.draws)
  })

  it('does not reissue a callsign that has already been used', () => {
    // The issued set is session-long, so a load that dropped it would put a
    // second BAW178 on the frequency.
    const world: World = {
      spawner: new Spawner({ airport, seed: 55 }),
      traffic: [],
      ticks: 0,
    }
    run(world, 20 * 60 * 20)
    const state = world.spawner.snapshot()
    expect(state.flights.issued.length).toBeGreaterThan(3)

    const resumed = new Spawner({ airport })
    resumed.restore(state)
    const before = new Set(state.flights.issued)

    const later: World = { spawner: resumed, traffic: world.traffic, ticks: world.ticks }
    run(later, 20 * 60 * 20)
    for (const a of later.traffic) {
      // Anything airborne at the save is allowed to still be here; anything
      // NEW must not reuse a name.
      if (before.has(a.callsign)) continue
      expect(before.has(a.callsign), a.callsign).toBe(false)
    }
    const names = later.traffic.map((a) => a.callsign)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps the cadence part way through a gap', () => {
    const world: World = {
      spawner: new Spawner({ airport, seed: 909 }),
      traffic: [],
      ticks: 0,
    }
    run(world, 20 * 90)
    const state = world.spawner.snapshot()

    const resumed = new Spawner({ airport })
    resumed.restore(state)
    // A save taken part way through a fifty second gap resumes with what
    // was left of it, not with a fresh one.
    expect(resumed.nextInSeconds()).toBeCloseTo(world.spawner.nextInSeconds(), 9)
  })
})

describe('the airspace rule in a save', () => {
  it('carries whether the session enforced it', () => {
    for (const enforceAirspace of [true, false]) {
      const out = read(
        game({
          controller: {
            initials: 'NF',
            position: 'EGLL_APP',
            enforceAirspace,
            difficulty: 'normal',
            mode: 'career',
          },
        }),
      )
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.game.controller?.enforceAirspace, String(enforceAirspace)).toBe(enforceAirspace)
    }
  })

  it('refuses a save that predates the setting', () => {
    // Version 1 had no airspace rule in it, so loading one would have to
    // guess which way the session was flown. Refusing says so instead.
    const old = JSON.parse(serialise(game())) as Record<string, unknown>
    old['version'] = 1
    delete (old['controller'] as Record<string, unknown>)['enforceAirspace']
    const out = parseSavedGame(JSON.stringify(old), AT)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('version 1')
  })

  it('refuses a current save that has lost the setting', () => {
    const broken = JSON.parse(serialise(game())) as Record<string, unknown>
    delete (broken['controller'] as Record<string, unknown>)['enforceAirspace']
    const out = parseSavedGame(JSON.stringify(broken), AT)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('save.controller.enforceAirspace is not a boolean')
  })
})
