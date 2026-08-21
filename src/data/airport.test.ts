import { describe, expect, it } from 'vitest'
import raw from './egll.json'
import {
  centrelinePoint,
  glideslopeAltFt,
  loadAirport,
  type Airport,
  type Navaid,
  type Runway,
} from './airport'
import { angleDelta, bearingDeg, distanceNM } from '../core/geo'

const egll: Airport = loadAirport(raw)

function runway(id: string): Runway {
  const r = egll.runways.find((x) => x.id === id)
  if (!r) throw new Error(`no runway ${id} in config`)
  return r
}

function fix(name: string): Navaid {
  const f = egll.navaids.find((x) => x.name === name)
  if (!f) throw new Error(`no fix ${name} in config`)
  return f
}

describe('EGLL config loads', () => {
  it('identifies the airport', () => {
    expect(egll.icao).toBe('EGLL')
    expect(egll.name).toBe('London Heathrow')
    expect(egll.elevationFt).toBe(83)
  })

  it('anchors world space on the airport reference point', () => {
    const o = egll.projection.toWorld(egll.arp)
    expect(o.x).toBeCloseTo(0, 12)
    expect(o.y).toBeCloseTo(0, 12)
  })

  it('resolves the active arrival runways', () => {
    expect(egll.arrivalRunways.map((r) => r.id)).toEqual(['27R', '27L'])
  })
})

describe('runway geometry', () => {
  it('matches the published parallel centreline separation', () => {
    // Heathrow's 27R and 27L centrelines are 1415 m apart. Deriving that
    // from the raw threshold coordinates is the strongest single check
    // that the config data is real and correctly projected.
    const sep = distanceNM(runway('27R').thresholdNM, runway('27L').thresholdNM)
    expect(sep).toBeCloseTo(0.764, 2)
    expect(sep * 1852).toBeGreaterThan(1400)
    expect(sep * 1852).toBeLessThan(1430)
  })

  it('puts 27R north of 27L', () => {
    expect(runway('27R').thresholdNM.y).toBeGreaterThan(runway('27L').thresholdNM.y)
  })

  it('agrees between the configured bearing and the threshold geometry', () => {
    // Guards against a transposed or mistyped threshold in any airport
    // file: the bearing implied by the two opposing thresholds must match
    // the published bearing to within half a degree. For EGLL the geometry
    // says 269.7 and the config rounds to 270.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['09L', '27R'],
      ['09R', '27L'],
    ]
    for (const [from, to] of pairs) {
      const geometric = bearingDeg(runway(from).thresholdNM, runway(to).thresholdNM)
      const configured = runway(from).bearingTrue
      expect(Math.abs(angleDelta(configured, geometric)), `${from} -> ${to}`).toBeLessThan(0.5)

      // And the opposing end must be the reciprocal.
      expect(Math.abs(angleDelta(runway(to).bearingTrue, runway(from).bearingTrue + 180)))
        .toBeLessThan(0.5)
    }
  })

  it('derives the far end down the runway, not behind it', () => {
    const r27 = runway('27R')
    // Landing on 27R heads west, so the far end is west of the threshold.
    expect(r27.farEndNM.x).toBeLessThan(r27.thresholdNM.x)
    expect(distanceNM(r27.thresholdNM, r27.farEndNM)).toBeCloseTo(r27.lengthNM, 9)
    // 12799 ft is a little over 2.1 NM.
    expect(r27.lengthNM).toBeCloseTo(2.106, 2)
  })
})

describe('approach geometry', () => {
  const r27R = runway('27R')

  it('extends the centreline onto the approach side', () => {
    // Aircraft landing westbound approach from the east, so the extended
    // centreline must run east of the threshold.
    const p = centrelinePoint(r27R, 10)
    expect(p.x).toBeGreaterThan(r27R.thresholdNM.x)
    expect(distanceNM(p, r27R.thresholdNM)).toBeCloseTo(10, 6)
    expect(p.y).toBeCloseTo(r27R.thresholdNM.y, 6)
  })

  it('climbs a 3 degree glideslope at about 318 ft per NM', () => {
    const perNM = glideslopeAltFt(r27R, 1) - r27R.thresholdElevationFt
    expect(perNM).toBeCloseTo(318.4, 1)
  })

  it('reaches the FAF above the configured intercept altitude', () => {
    // A real consequence of the numbers in the design doc: at the 10 NM
    // FAF a 3 degree glideslope sits at about 3262 ft, so an aircraft
    // levelled at the 3000 ft intercept altitude is BELOW the glideslope
    // there and captures it from underneath, at about 9.2 NM. That is
    // correct procedure, but it means 3000 ft and a 10 NM FAF are not the
    // same point and the ILS module must not assume they are.
    const atFaf = glideslopeAltFt(r27R, r27R.ils.fafDistNM)
    expect(atFaf).toBeGreaterThan(egll.sector.interceptAltMaxFt)
    expect(atFaf).toBeCloseTo(3262, 0)
  })
})

describe('feeder fixes', () => {
  it('loads all four Heathrow holds with their navaids', () => {
    expect(egll.holdingFixes.map((f) => f.name)).toEqual(['LAM', 'BIG', 'BNN', 'OCK'])
    expect(fix('LAM').fullName).toBe('Lambourne')
    expect(fix('BNN').station?.freqMHz).toBe(113.75)
  })

  it('places every fix inside the sector', () => {
    for (const f of egll.holdingFixes) {
      expect(f.distanceFromArpNM, f.name).toBeLessThan(egll.sector.radiusNM)
      expect(f.distanceFromArpNM, f.name).toBeGreaterThan(5)
    }
  })

  it('positions the fixes where the real navaids are', () => {
    // Worth pinning, because the design doc describes these as four neat
    // NE/SE/NW/SW corners and they are nothing of the sort: BNN is almost
    // due north and OCK almost due south, while LAM and BIG are both well
    // to the east. Anything that assumes diagonal symmetry -- spawn
    // placement, hold rendering, sequencing hints -- has to cope.
    const expected: Record<string, { brg: number; dist: number }> = {
      LAM: { brg: 65.2, dist: 25.1 },
      BIG: { brg: 114.4, dist: 20.3 },
      BNN: { brg: 347.7, dist: 15.7 },
      OCK: { brg: 177.3, dist: 10.0 },
    }
    for (const [name, e] of Object.entries(expected)) {
      const f = fix(name)
      expect(Math.abs(angleDelta(e.brg, f.bearingFromArpTrue)), `${name} bearing`)
        .toBeLessThan(0.5)
      expect(f.distanceFromArpNM, `${name} distance`).toBeCloseTo(e.dist, 0)
    }
  })

  it('derives hold inbound legs pointing at the airport', () => {
    for (const f of egll.holdingFixes) {
      expect(f.hold, f.name).not.toBeNull()
      if (!f.hold) continue
      expect(f.hold.inboundIsDerived, f.name).toBe(true)
      // Inbound leg is the reciprocal of the fix's bearing from the field.
      const towardField = bearingDeg(f.posNM, { x: 0, y: 0 })
      expect(Math.abs(angleDelta(f.hold.inboundTrue, towardField)), f.name)
        .toBeLessThan(1e-6)
      expect(f.hold.turns).toBe('right')
    }
  })

  it('honours an explicit inbound track when one is supplied', () => {
    const cfg = structuredClone(raw) as Record<string, unknown>
    const fixes = cfg['navaids'] as Array<Record<string, unknown>>
    const first = fixes[0]
    if (!first) throw new Error('fixture has no fixes')
    first['hold'] = { turns: 'left', legMins: 1, inboundTrue: 233 }

    const loaded = loadAirport(cfg)
    const lam = loaded.navaids[0]
    expect(lam?.hold?.inboundTrue).toBe(233)
    expect(lam?.hold?.inboundIsDerived).toBe(false)
    expect(lam?.hold?.turns).toBe('left')
  })
})

describe('config validation', () => {
  function mutate(fn: (cfg: Record<string, unknown>) => void): () => Airport {
    return () => {
      const cfg = structuredClone(raw) as Record<string, unknown>
      fn(cfg)
      return loadAirport(cfg)
    }
  }

  it('rejects a missing airport reference point', () => {
    expect(mutate((c) => delete c['arp'])).toThrow(/arp must be an object/)
  })

  it('rejects an out-of-range latitude', () => {
    expect(
      mutate((c) => {
        c['arp'] = { lat: 130, lon: 0 }
      }),
    ).toThrow(/arp.lat must be within/)
  })

  it('rejects an unknown wake category', () => {
    expect(
      mutate((c) => {
        const types = c['aircraftTypes'] as Array<Record<string, unknown>>
        const t = types[0]
        if (t) t['wake'] = 'X'
      }),
    ).toThrow(/must be one of L, M, H, J/)
  })

  it('rejects duplicate runway identifiers', () => {
    expect(
      mutate((c) => {
        const rwys = c['runways'] as Array<Record<string, unknown>>
        const second = rwys[1]
        const first = rwys[0]
        if (second && first) second['id'] = first['id']
      }),
    ).toThrow(/duplicate/)
  })

  it('rejects an active runway that does not exist', () => {
    expect(
      mutate((c) => {
        const s = c['sector'] as Record<string, unknown>
        s['activeArrivalRunways'] = ['27R', '18C']
      }),
    ).toThrow(/unknown runway "18C"/)
  })

  it('rejects a sector floor at or above its ceiling', () => {
    expect(
      mutate((c) => {
        const s = c['sector'] as Record<string, unknown>
        s['floorFt'] = 20000
      }),
    ).toThrow(/floorFt must be below/)
  })

  it('rejects a non-positive runway length', () => {
    expect(
      mutate((c) => {
        const rwys = c['runways'] as Array<Record<string, unknown>>
        const r = rwys[0]
        if (r) r['lengthFt'] = 0
      }),
    ).toThrow(/lengthFt must be positive/)
  })

  it('names the offending path in the error message', () => {
    // Config errors have to be actionable: a malformed airport file should
    // say which field, not just fail to render a scope.
    expect(
      mutate((c) => {
        const rwys = c['runways'] as Array<Record<string, unknown>>
        const r = rwys[2]
        if (r) delete r['bearingTrue']
      }),
    ).toThrow(/runways\[2\].bearingTrue must be a finite number/)
  })
})

describe('surrounding aerodromes', () => {
  function neighbour(icao: string) {
    const a = egll.airports.find((x) => x.icao === icao)
    if (!a) throw new Error(`no aerodrome ${icao}`)
    return a
  }

  it('loads the aerodromes in the vicinity', () => {
    expect(egll.airports.length).toBeGreaterThanOrEqual(12)
    for (const icao of ['EGWU', 'EGLC', 'EGKB', 'EGKK', 'EGGW', 'EGSS', 'EGLF']) {
      expect(egll.airports.map((a) => a.icao), icao).toContain(icao)
    }
  })

  it('places them at their real range and bearing', () => {
    // Cross-checked against the source dataset.
    const expected: Record<string, { d: number; b: number }> = {
      EGWU: { d: 5.2, b: 18 },
      EGLC: { d: 19.4, b: 84 },
      EGKB: { d: 20.3, b: 114 },
      EGKK: { d: 21.9, b: 152 },
      EGGW: { d: 24.5, b: 8 },
    }
    for (const [icao, e] of Object.entries(expected)) {
      const a = neighbour(icao)
      expect(a.distanceFromArpNM, `${icao} distance`).toBeCloseTo(e.d, 0)
      expect(Math.abs(angleDelta(e.b, a.bearingFromArpTrue)), `${icao} bearing`).toBeLessThan(1)
    }
  })

  it('carries a primary runway for drawing', () => {
    const kk = neighbour('EGKK')
    expect(kk.primaryRunway).not.toBeNull()
    // Gatwick's main runway is a little over 1.7 NM.
    expect(kk.primaryRunway?.lengthNM).toBeGreaterThan(1.4)
    expect(kk.iata).toBe('LGW')
  })

  it('has the BIG navaid co-located with Biggin Hill aerodrome', () => {
    // Not a coincidence and not a data error: the Biggin VOR-DME sits on
    // Biggin Hill itself, about 160 m from the aerodrome reference point.
    // Worth pinning, because it means the BIG hold symbol and the EGKB
    // aerodrome symbol land on top of each other and the renderer has to
    // cope rather than assume navaids and aerodromes never collide.
    const kb = neighbour('EGKB')
    const big = fix('BIG')
    const sep = distanceNM(kb.posNM, big.posNM)
    expect(sep).toBeLessThan(0.2)
    expect(sep * 1852).toBeGreaterThan(100)
  })
})

describe('navaids', () => {
  it('loads the surrounding VORs as well as the holds', () => {
    expect(egll.navaids.length).toBeGreaterThanOrEqual(12)
    expect(egll.holdingFixes.length).toBe(4)
    for (const n of ['LON', 'BPK', 'MID', 'CPT', 'MAY']) {
      expect(egll.navaids.map((x) => x.name), n).toContain(n)
    }
  })

  it('puts the London VOR essentially on the field', () => {
    expect(fix('LON').distanceFromArpNM).toBeLessThan(2)
    expect(fix('LON').station?.freqMHz).toBe(113.6)
  })

  it('gives holds a pattern and plain navaids none', () => {
    expect(fix('LAM').hold).not.toBeNull()
    expect(fix('CPT').hold).toBeNull()
  })
})

describe('airspace', () => {
  function volume(id: string) {
    const v = egll.airspace.find((x) => x.id === id)
    if (!v) throw new Error(`no airspace ${id}`)
    return v
  }

  it('loads the TMA, the control zones and the traffic zones', () => {
    expect(egll.airspace.length).toBeGreaterThanOrEqual(15)
    for (const id of ['LONDON TMA', 'LONDON CTR', 'GATWICK CTR', 'EGWU ATZ']) {
      expect(egll.airspace.map((v) => v.id), id).toContain(id)
    }
  })

  it('describes the TMA as a class A volume above the zones', () => {
    const tma = volume('LONDON TMA')
    expect(tma.airspaceClass).toBe('A')
    expect(tma.floorFt).toBe(2500)
    expect(tma.ceilingFt).toBe(19500)
    expect(tma.shape.kind).toBe('circle')
  })

  it('anchors a zone on the aerodrome it names', () => {
    const ctr = volume('GATWICK CTR')
    const kk = egll.airports.find((a) => a.icao === 'EGKK')
    expect(kk).toBeDefined()
    if (!kk || ctr.shape.kind !== 'circle') return
    expect(distanceNM(ctr.shape.centreNM, kk.posNM)).toBeCloseTo(0, 9)
  })

  it('derives traffic zones from the UK rule rather than guessing', () => {
    // Radius 2 NM where the longest runway is 1850 m or less, otherwise
    // 2.5 NM, up to 2000 ft above aerodrome level. Because that is a rule
    // and not an estimate, these are NOT flagged approximate.
    const atzs = egll.airspace.filter((v) => v.id.endsWith(' ATZ'))
    expect(atzs.length).toBeGreaterThanOrEqual(8)

    for (const atz of atzs) {
      expect(atz.derivation, atz.id).toBe('rule')
      expect(atz.approximate, atz.id).toBe(false)
      expect(atz.airspaceClass, atz.id).toBe('G')
      if (atz.shape.kind !== 'circle') throw new Error('ATZ must be a circle')
      expect([2, 2.5], atz.id).toContain(atz.shape.radiusNM)

      const icao = atz.id.slice(0, 4)
      const field = egll.airports.find((a) => a.icao === icao)
      expect(field, icao).toBeDefined()
      if (!field) continue
      expect(atz.ceilingFt, atz.id).toBe(field.elevationFt + 2000)
      // And the radius must match the rule for that field's runway.
      const m = (field.primaryRunway?.lengthNM ?? 0) * 1852
      expect(atz.shape.radiusNM, `${atz.id} radius for ${Math.round(m)} m`).toBe(
        m <= 1850 ? 2 : 2.5,
      )
    }
  })

  it('flags the control zones as approximations', () => {
    // They are irregular polygons in the AIP; circles are stand-ins and the
    // display dashes them so that is visible rather than implied.
    for (const id of ['LONDON CTR', 'GATWICK CTR', 'LONDON TMA']) {
      expect(volume(id).approximate, id).toBe(true)
      expect(volume(id).derivation, id).toBe('approx')
    }
  })
})

describe('airspace validation', () => {
  function mutateAirspace(fn: (v: Record<string, unknown>[]) => void): () => Airport {
    return () => {
      const cfg = structuredClone(raw) as Record<string, unknown>
      fn(cfg['airspace'] as Record<string, unknown>[])
      return loadAirport(cfg)
    }
  }

  it('rejects a zone anchored on an unknown aerodrome', () => {
    expect(
      mutateAirspace((v) => {
        const first = v[0]
        if (first) {
          delete first['centre']
          first['centreAirport'] = 'ZZZZ'
        }
      }),
    ).toThrow(/unknown aerodrome "ZZZZ"/)
  })

  it('rejects an airspace class outside A-G', () => {
    expect(
      mutateAirspace((v) => {
        const first = v[0]
        if (first) first['class'] = 'Q'
      }),
    ).toThrow(/single letter A-G/)
  })

  it('rejects a ceiling at or below the floor', () => {
    expect(
      mutateAirspace((v) => {
        const first = v[0]
        if (first) first['ceilingFt'] = 0
      }),
    ).toThrow(/ceilingFt must be above floorFt/)
  })

  it('rejects an unknown shape kind', () => {
    expect(
      mutateAirspace((v) => {
        const first = v[0]
        if (first) first['kind'] = 'blob'
      }),
    ).toThrow(/must be "circle" or "polygon"/)
  })

  it('rejects a degenerate polygon', () => {
    expect(
      mutateAirspace((v) => {
        const first = v[0]
        if (first) {
          first['kind'] = 'polygon'
          first['vertices'] = [{ lat: 51.5, lon: -0.4 }, { lat: 51.6, lon: -0.3 }]
        }
      }),
    ).toThrow(/at least 3 points/)
  })

  it('accepts a real polygon boundary', () => {
    // The path an authoritative AIP boundary takes when it replaces one of
    // the circular stand-ins: no code change, just different config.
    const loaded = mutateAirspace((v) => {
      const first = v[0]
      if (first) {
        first['kind'] = 'polygon'
        first['approximate'] = false
        first['derivation'] = 'aip'
        first['vertices'] = [
          { lat: 51.7, lon: -0.7 },
          { lat: 51.7, lon: -0.2 },
          { lat: 51.3, lon: -0.2 },
          { lat: 51.3, lon: -0.7 },
        ]
      }
    })()

    const v = loaded.airspace[0]
    expect(v?.shape.kind).toBe('polygon')
    expect(v?.approximate).toBe(false)
    expect(v?.derivation).toBe('aip')
    if (v?.shape.kind !== 'polygon') return
    expect(v.shape.verticesNM.length).toBe(4)
    // Projected, so the northern edge really is north of the southern one.
    expect(v.shape.verticesNM[0]?.y).toBeGreaterThan(v.shape.verticesNM[2]?.y ?? 0)
  })
})
