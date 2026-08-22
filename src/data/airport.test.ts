import { describe, expect, it } from 'vitest'
import { isWithinFootprint } from '../sim/airspace'
import raw from './egll.json'
import {
  centrelinePoint,
  glideslopeAltFt,
  holdRacetrack,
  loadAirport,
  type Airport,
  type Navaid,
  type Runway,
} from './airport'
import { advance, angleDelta, bearingDeg, distanceNM, type Vec2NM } from '../core/geo'

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

  it('derives hold inbound legs pointing at the airport where it can', () => {
    for (const f of egll.holdingFixes) {
      expect(f.hold, f.name).not.toBeNull()
      if (!f.hold) continue
      expect(f.hold.inboundIsDerived, f.name).toBe(true)
      expect(f.hold.turns).toBe('right')
    }
    // Three of the four stacks have room to face the field exactly.
    for (const name of ['BIG', 'OCK']) {
      const fix = egll.holdingFixes.find((x) => x.name === name)
      const towardField = bearingDeg(fix?.posNM ?? { x: 0, y: 0 }, { x: 0, y: 0 })
      expect(Math.abs(angleDelta(fix?.hold?.inboundTrue ?? 0, towardField)), name)
        .toBeLessThan(1e-6)
    }
  })

  it('turns a hold that would not fit in the airspace', () => {
    // Bovingdon sits under two miles inside the edge of the TMA, so a
    // pattern laid radially outward from it spends half of every circuit
    // outside controlled airspace. That is the case this exists for.
    const bnn = egll.holdingFixes.find((x) => x.name === 'BNN')
    expect(bnn?.hold).toBeDefined()
    const towardField = bearingDeg(bnn?.posNM ?? { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(Math.abs(angleDelta(bnn?.hold?.inboundTrue ?? 0, towardField))).toBeGreaterThan(30)
  })

  it('keeps every hold pattern inside the airspace', () => {
    // The regression that matters: an aircraft holding where it was sent
    // must not drift out of controlled airspace and be lost for nothing.
    const NOMINAL_LEG_NM = 4.2
    const NOMINAL_WIDTH_NM = 2.6
    for (const fix of egll.holdingFixes) {
      const hold = fix.hold
      if (!hold) continue
      const outbound = (hold.inboundTrue + 180) % 360
      const across = (hold.inboundTrue + (hold.turns === 'right' ? 90 : -90) + 360) % 360
      for (const along of [0, NOMINAL_LEG_NM, NOMINAL_LEG_NM + 1]) {
        for (const side of [0, NOMINAL_WIDTH_NM]) {
          const at = advance(advance(fix.posNM, outbound, along), across, side)
          expect(isWithinFootprint(egll.controlZone, at), `${fix.name} at ${along}/${side}`)
            .toBe(true)
        }
      }
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
describe('airspace from the sector file', () => {
  const published = egll.airspace.filter((v) => v.derivation === 'aip')
  const ruled = egll.airspace.filter((v) => v.derivation === 'rule')

  function byId(id: string) {
    const v = egll.airspace.find((x) => x.id === id)
    if (!v) throw new Error(`no airspace ${id}`)
    return v
  }

  it('loads published boundaries for the London airspace', () => {
    expect(published.length).toBeGreaterThanOrEqual(50)
    const labels = new Set(egll.airspace.map((v) => v.label))
    for (const l of [
      'LONDON TMA',
      'LONDON CTR',
      'GATWICK CTR',
      'LUTON CTR',
      'STANSTED CTA',
      'FARNBOROUGH CTR',
      'CITY CTA',
    ]) {
      expect(labels, l).toContain(l)
    }
  })

  it('describes the TMA as class A above the control zones', () => {
    const tma = byId('London TMA 1')
    expect(tma.airspaceClass).toBe('A')
    expect(tma.floorFt).toBe(2500)
    expect(tma.ceilingFt).toBe(19500)
    expect(tma.verticalSource).toBe('file')
  })

  it('stores boundaries as open line work, never closed rings', () => {
    // The source is a set of independent boundary lines: only two of sixty
    // regions chained into a closed ring. Storing them as polygons would
    // draw invented edges of up to 30 NM, so they are polylines and the
    // renderer never closes them.
    const lines = egll.airspace.filter((v) => v.shape.kind === 'lines')
    expect(lines.length).toBeGreaterThanOrEqual(45)

    for (const v of lines) {
      if (v.shape.kind !== 'lines') continue
      expect(v.shape.pathsNM.length, v.id).toBeGreaterThan(0)
      for (const path of v.shape.pathsNM) {
        expect(path.length, v.id).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('projects the line work into plausible world positions', () => {
    const ctr = byId('London CTR')
    if (ctr.shape.kind !== 'lines') throw new Error('expected line work')
    const pts = ctr.shape.pathsNM.flat()
    expect(pts.length).toBeGreaterThan(10)
    // The Heathrow CTR is a local zone: every vertex within 30 NM of the
    // field, which would fail loudly on a hemisphere or DMS parsing slip.
    for (const p of pts) {
      expect(distanceNM({ x: 0, y: 0 }, p), `${p.x},${p.y}`).toBeLessThan(30)
    }
  })

  it('prefers the published traffic zone over the runway-length rule', () => {
    // Biggin Hill is notified as 2.5 NM. The UK rule applied to its 1806 m
    // runway would have given 2 NM, so this is a case where the published
    // data corrects the derivation -- the reason for using the source.
    const kb = byId('EGKB Biggin Hill ATZ')
    expect(kb.derivation).toBe('aip')
    expect(kb.shape.kind).toBe('circle')
    if (kb.shape.kind !== 'circle') return
    expect(kb.shape.radiusNM).toBe(2.5)
  })

  it('keeps rule-derived zones only where the source is silent', () => {
    expect(ruled.length).toBeGreaterThan(0)
    for (const v of ruled) {
      expect(v.approximate, v.id).toBe(true)
      expect(v.shape.kind, v.id).toBe('circle')
      // No aerodrome should have both a published and a derived zone.
      const icao = v.id.slice(0, 4)
      const alsoPublished = published.some((p) => p.label.startsWith(icao))
      expect(alsoPublished, `${icao} has both`).toBe(false)
    }
  })

  it('marks published boundaries as not approximate', () => {
    for (const v of published) expect(v.approximate, v.id).toBe(false)
  })

  it('records where each vertical extent came from', () => {
    for (const v of egll.airspace) {
      expect(['file', 'rule', 'assumed'], v.id).toContain(v.verticalSource)
    }
    // The sector file omits limits for these, so they are flagged rather
    // than presented as published.
    expect(byId('Gatwick CTR').verticalSource).toBe('assumed')
    expect(byId('London CTR').verticalSource).toBe('file')
  })

  it('still anchors rule-derived zones on their aerodrome', () => {
    const atz = ruled.find((v) => v.id.startsWith('EGWU'))
    expect(atz).toBeDefined()
    const wu = egll.airports.find((a) => a.icao === 'EGWU')
    if (!atz || !wu || atz.shape.kind !== 'circle') return
    expect(distanceNM(atz.shape.centreNM, wu.posNM)).toBeCloseTo(0, 9)
  })
})

describe('airspace validation', () => {
  function load(fn: (v: Record<string, unknown>[]) => void): () => Airport {
    return () => {
      const cfg = structuredClone(raw) as Record<string, unknown>
      fn(cfg['airspace'] as Record<string, unknown>[])
      return loadAirport(cfg)
    }
  }
  const firstCircle = (v: Record<string, unknown>[]): Record<string, unknown> => {
    const c = v.find((x) => x['kind'] === 'circle')
    if (!c) throw new Error('fixture has no circle volume')
    return c
  }

  it('rejects a zone anchored on an unknown aerodrome', () => {
    expect(
      load((v) => {
        const c = firstCircle(v)
        delete c['centre']
        c['centreAirport'] = 'ZZZZ'
      }),
    ).toThrow(/unknown aerodrome "ZZZZ"/)
  })

  it('rejects an airspace class outside A-G', () => {
    expect(
      load((v) => {
        if (v[0]) v[0]['class'] = 'Q'
      }),
    ).toThrow(/single letter A-G/)
  })

  it('rejects a ceiling at or below the floor', () => {
    expect(
      load((v) => {
        if (v[0]) v[0]['ceilingFt'] = 0
      }),
    ).toThrow(/ceilingFt must be above floorFt/)
  })

  it('rejects an unknown shape kind', () => {
    expect(
      load((v) => {
        if (v[0]) v[0]['kind'] = 'blob'
      }),
    ).toThrow(/must be "circle", "polygon" or "lines"/)
  })

  it('rejects a degenerate polyline', () => {
    expect(
      load((v) => {
        if (v[0]) {
          v[0]['kind'] = 'lines'
          v[0]['paths'] = [[{ lat: 51.5, lon: -0.4 }]]
        }
      }),
    ).toThrow(/paths\[0\] must have at least 2 points/)
  })

  it('rejects an unknown derivation or vertical source', () => {
    expect(
      load((v) => {
        if (v[0]) v[0]['derivation'] = 'vibes'
      }),
    ).toThrow(/must be aip, rule or approx/)
    expect(
      load((v) => {
        if (v[0]) v[0]['verticalSource'] = 'vibes'
      }),
    ).toThrow(/must be file, rule or assumed/)
  })

  it('still accepts a closed polygon boundary', () => {
    // Kept in the schema: if ordered closed rings are ever transcribed from
    // the AIP, they load with no code change and can be filled or tested
    // for containment, which line work cannot.
    const loaded = load((v) => {
      if (v[0]) {
        v[0]['kind'] = 'polygon'
        v[0]['derivation'] = 'aip'
        v[0]['vertices'] = [
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
    if (v?.shape.kind !== 'polygon') return
    expect(v.shape.verticesNM.length).toBe(4)
    expect(v.shape.verticesNM[0]?.y).toBeGreaterThan(v.shape.verticesNM[2]?.y ?? 0)
  })
})

describe('the wider aerodrome picture', () => {
  const field = (icao: string) => {
    const a = egll.airports.find((x) => x.icao === icao)
    if (!a) throw new Error()
    return a
  }

  it('reaches well beyond the sector', () => {
    // The original list stopped at about 40 NM, which is the sector edge;
    // the scope can be zoomed to twice that.
    const furthest = Math.max(...egll.airports.map((a) => a.distanceFromArpNM))
    expect(furthest).toBeGreaterThan(80)
  })

  it('includes Southend and the other regional fields', () => {
    for (const icao of ['EGMC', 'EGHI', 'EGHH', 'EGSC', 'EGBB', 'EGGD']) {
      expect(egll.airports.map((a) => a.icao), icao).toContain(icao)
    }
    expect(field('EGMC').name).toMatch(/Southend/)
  })

  it('puts them on their real bearings and distances', () => {
    // Southend east-north-east down the estuary, Southampton south-west.
    expect(field('EGMC').distanceFromArpNM).toBeCloseTo(43.5, 0)
    expect(field('EGMC').bearingFromArpTrue).toBeGreaterThan(75)
    expect(field('EGMC').bearingFromArpTrue).toBeLessThan(95)
    expect(field('EGHI').bearingFromArpTrue).toBeGreaterThan(200)
    expect(field('EGHI').bearingFromArpTrue).toBeLessThan(240)
  })

  it('carries a real runway bearing for each one', () => {
    // Computed from the two threshold coordinates, so 05/23 has to come out
    // at about 050 rather than at whatever the heading column said.
    expect(field('EGMC').primaryRunway?.bearingTrue).toBeCloseTo(54, 0)
    expect(field('EGBB').primaryRunway?.bearingTrue).toBeCloseTo(146, 0)
    for (const a of egll.airports) {
      expect(a.primaryRunway, a.icao).not.toBeNull()
      expect(a.primaryRunway?.lengthNM ?? 0, a.icao).toBeGreaterThan(0)
    }
  })

  it('does not list the field being worked as its own neighbour', () => {
    expect(egll.airports.map((a) => a.icao)).not.toContain(egll.icao)
  })
})

describe('geography', () => {
  const feature = (id: string) => {
    const f = egll.geography.find((x) => x.id === id)
    if (!f) throw new Error(`no geography feature ${id}`)
    return f
  }

  it('loads a coastline, the Thames and a FIR boundary', () => {
    expect(egll.geography.map((f) => f.id)).toEqual(['coastline', 'thames', 'fir-boundary'])
    expect(feature('coastline').kind).toBe('coastline')
    expect(feature('thames').kind).toBe('river')
    expect(feature('fir-boundary').kind).toBe('fir')
  })

  it('keeps the two provenances apart', () => {
    // A surveyed shoreline is not published in an AIP, and saying it was
    // would be a small lie in the data.
    expect(feature('coastline').derivation).toBe('survey')
    expect(feature('coastline').source).toMatch(/Natural Earth/)
    expect(feature('fir-boundary').derivation).toBe('aip')
    expect(feature('fir-boundary').source).toMatch(/VATSIM UK/)
    expect(feature('thames').derivation).toBe('survey')
    expect(feature('thames').source).toMatch(/VATSIM UK/)
  })

  it('projects every path into world space with at least two points', () => {
    for (const f of egll.geography) {
      expect(f.paths.length).toBeGreaterThan(0)
      for (const p of f.paths) {
        expect(p.pointsNM.length).toBeGreaterThanOrEqual(2)
        for (const v of p.pointsNM) {
          expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
        }
      }
    }
  })

  it('precomputes bounds that actually enclose the path', () => {
    for (const f of egll.geography) {
      for (const p of f.paths) {
        for (const v of p.pointsNM) {
          expect(v.x).toBeGreaterThanOrEqual(p.minNM.x)
          expect(v.x).toBeLessThanOrEqual(p.maxNM.x)
          expect(v.y).toBeGreaterThanOrEqual(p.minNM.y)
          expect(v.y).toBeLessThanOrEqual(p.maxNM.y)
        }
      }
    }
  })

  it('keeps every chunk small enough for the cull to be worth doing', () => {
    // A single path from the Bristol Channel to East Anglia would have a
    // bounding box containing Heathrow, and would therefore never be
    // rejected however far the scope is zoomed in.
    for (const f of egll.geography) {
      for (const p of f.paths) {
        const span = Math.max(p.maxNM.x - p.minNM.x, p.maxNM.y - p.minNM.y)
        expect(span, f.id).toBeLessThanOrEqual(12.5)
      }
    }
  })

  it('puts the shoreline where the shoreline is', () => {
    // Distance from a handful of real coastal points to the nearest drawn
    // segment. The residual is town-centre position, not line error.
    const nearestNM = (lat: number, lon: number): number => {
      const t = egll.projection.toWorld({ lat, lon })
      let best = Infinity
      for (const p of feature('coastline').paths) {
        for (let i = 0; i < p.pointsNM.length - 1; i += 1) {
          const a = p.pointsNM[i]
          const b = p.pointsNM[i + 1]
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len2 = dx * dx + dy * dy
          let u = len2 === 0 ? 0 : ((t.x - a.x) * dx + (t.y - a.y) * dy) / len2
          u = Math.max(0, Math.min(1, u))
          best = Math.min(best, Math.hypot(t.x - (a.x + u * dx), t.y - (a.y + u * dy)))
        }
      }
      return best
    }

    expect(nearestNM(50.821, -0.137), 'Brighton').toBeLessThan(0.5)
    expect(nearestNM(51.535, 0.712), 'Southend').toBeLessThan(0.5)
    expect(nearestNM(51.126, 1.318), 'Dover').toBeLessThan(0.5)
    expect(nearestNM(51.944, 1.288), 'Harwich').toBeLessThan(0.5)
    expect(nearestNM(50.737, 0.246), 'Beachy Head').toBeLessThan(1)
  })

  it('follows the Thames through London', () => {
    // The source file is unlabelled -- nothing in it says which watercourse
    // a segment belongs to -- so the identification is geometric and this
    // is the check on it: the line has to pass through the places the
    // Thames passes through, in the right order, west to east.
    const nearest = (lat: number, lon: number): number => {
      const t = egll.projection.toWorld({ lat, lon })
      let best = Infinity
      for (const p of feature('thames').paths) {
        for (let i = 0; i < p.pointsNM.length - 1; i += 1) {
          const a = p.pointsNM[i]
          const b = p.pointsNM[i + 1]
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len2 = dx * dx + dy * dy
          let u = len2 === 0 ? 0 : ((t.x - a.x) * dx + (t.y - a.y) * dy) / len2
          u = Math.max(0, Math.min(1, u))
          best = Math.min(best, Math.hypot(t.x - (a.x + u * dx), t.y - (a.y + u * dy)))
        }
      }
      return best
    }

    expect(nearest(51.4839, -0.6094), 'Windsor').toBeLessThan(1)
    expect(nearest(51.4612, -0.3084), 'Richmond').toBeLessThan(1)
    expect(nearest(51.5007, -0.1246), 'Westminster').toBeLessThan(1)
    expect(nearest(51.5055, -0.0754), 'Tower Bridge').toBeLessThan(1)
    expect(nearest(51.4934, 0.0684), 'Woolwich').toBeLessThan(1)
    expect(nearest(51.4415, 0.3685), 'Gravesend').toBeLessThan(1)
    // And nowhere near somewhere it does not go.
    expect(nearest(51.15, -0.18), 'Gatwick').toBeGreaterThan(10)
  })

  it('brings the Thames close enough to the field to orient by', () => {
    // Which is the whole reason it earns a layer: it passes within a few
    // miles of Heathrow, so it is on screen even at close range.
    const closest = Math.min(
      ...feature('thames').paths.flatMap((p) =>
        p.pointsNM.map((v) => Math.hypot(v.x, v.y)),
      ),
    )
    expect(closest).toBeLessThan(6)
  })

  it('reaches the coast in every direction the scope can see', () => {
    const xs = feature('coastline').paths.flatMap((p) => [p.minNM.x, p.maxNM.x])
    const ys = feature('coastline').paths.flatMap((p) => [p.minNM.y, p.maxNM.y])
    // Comfortably past the 80 NM zoom ceiling on every side, so zooming out
    // never runs off the end of the map.
    expect(Math.min(...xs)).toBeLessThan(-100)
    expect(Math.max(...xs)).toBeGreaterThan(100)
    expect(Math.min(...ys)).toBeLessThan(-100)
    expect(Math.max(...ys)).toBeGreaterThan(100)
  })

  it('stays out of the extent used for the initial camera fit', () => {
    // Otherwise opening the app would frame 200 NM of coastline and the
    // airport would be a dot in the middle of it. Counted exactly rather
    // than bounded by a radius, because the aerodrome list legitimately
    // reaches further out than the sector does.
    expect(egll.extentNM).toHaveLength(
      egll.runways.length * 2 + egll.navaids.length + egll.airports.length,
    )
  })
})

describe('the edge of the map', () => {
  it('reports the outer extent of everything drawn', () => {
    const b = egll.mapBoundsNM
    expect(b).not.toBeNull()
    if (!b) return
    // Roughly 230 NM west to 190 NM east, 180 south to 190 north.
    expect(b.min.x).toBeLessThan(-200)
    expect(b.max.x).toBeGreaterThan(180)
    expect(b.min.y).toBeLessThan(-170)
    expect(b.max.y).toBeGreaterThan(180)
  })

  it('encloses every drawn path', () => {
    const b = egll.mapBoundsNM
    if (!b) throw new Error('no map bounds')
    for (const f of egll.geography) {
      for (const p of f.paths) {
        expect(p.minNM.x).toBeGreaterThanOrEqual(b.min.x)
        expect(p.maxNM.x).toBeLessThanOrEqual(b.max.x)
        expect(p.minNM.y).toBeGreaterThanOrEqual(b.min.y)
        expect(p.maxNM.y).toBeLessThanOrEqual(b.max.y)
      }
    }
  })

  it('reaches well past the zoom ceiling on every side', () => {
    // The fence must not bite before the scope has zoomed out fully, or
    // the display would refuse to pan while there is still map to see.
    const b = egll.mapBoundsNM
    if (!b) throw new Error('no map bounds')
    const ceiling = egll.sector.radiusNM * 2
    expect(Math.min(-b.min.x, b.max.x, -b.min.y, b.max.y)).toBeGreaterThan(ceiling * 2)
  })

  it('is null for a config with no map, so that camera is not fenced', () => {
    const cfg = structuredClone(raw) as Record<string, unknown>
    delete cfg['geography']
    expect(loadAirport(cfg).mapBoundsNM).toBeNull()
  })
})

describe('geography validation', () => {
  function load(fn: (g: Record<string, unknown>[]) => void): () => Airport {
    return () => {
      const cfg = structuredClone(raw) as Record<string, unknown>
      fn(cfg['geography'] as Record<string, unknown>[])
      return loadAirport(cfg)
    }
  }

  it('accepts a config with no map at all', () => {
    const cfg = structuredClone(raw) as Record<string, unknown>
    delete cfg['geography']
    expect(loadAirport(cfg).geography).toEqual([])
  })

  it('rejects an unknown feature kind', () => {
    expect(load((g) => { g[0]!['kind'] = 'contours' })).toThrow(/must be "coastline", "river" or "fir"/)
  })

  it('rejects a provenance it does not have a vocabulary for', () => {
    expect(load((g) => { g[0]!['derivation'] = 'guessed' })).toThrow(/must be survey or aip/)
  })

  it('rejects a path that cannot be a line', () => {
    expect(load((g) => { g[0]!['paths'] = [[{ lat: 51, lon: 0 }]] })).toThrow(
      /must have at least 2 points/,
    )
  })

  it('rejects two features sharing an id', () => {
    expect(load((g) => { g[1]!['id'] = 'coastline' })).toThrow(/duplicate "coastline"/)
  })
})

describe('hold racetracks', () => {
  const fixAt: Vec2NM = { x: 0, y: 0 }
  const pattern = (
    over: Partial<{ turns: 'left' | 'right'; legMins: number; inboundTrue: number }> = {},
    speedKts = 220,
  ) =>
    holdRacetrack(
      fixAt,
      { turns: 'right', legMins: 1, inboundTrue: 270, inboundIsDerived: true, ...over },
      { speedKts },
    )

  const span = (ring: readonly Vec2NM[]) => {
    const xs = ring.map((p) => p.x)
    const ys = ring.map((p) => p.y)
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    }
  }

  it('starts at the beginning of the inbound leg and reaches the fix', () => {
    // The fix is at the downstream END of the inbound leg, which is why the
    // symbol sits at one end of the pattern and not in the middle.
    const ring = pattern()
    expect(ring[1]).toEqual(fixAt)
    // Inbound 270 is flown westwards, so the leg begins to the east.
    expect(ring[0]?.x).toBeCloseTo(3.667, 2)
    expect(ring[0]?.y).toBeCloseTo(0, 6)
    expect(bearingDeg(ring[0] as Vec2NM, fixAt)).toBeCloseTo(270, 6)
  })

  it('makes the legs a minute of flying', () => {
    // 220 kt for one minute is 3.67 NM.
    expect(distanceNM(pattern()[0] as Vec2NM, fixAt)).toBeCloseTo(3.667, 2)
    // And two minutes is twice that.
    expect(distanceNM(pattern({ legMins: 2 })[0] as Vec2NM, fixAt)).toBeCloseTo(7.333, 2)
  })

  it('makes the turns a rate-one turn at that speed', () => {
    // 3 deg/sec at 220 kt is a 1.167 NM radius, so the pattern is 2.33 NM
    // across. That it is a thin sliver rather than the fat oval on a chart
    // is the point: charts are not to scale.
    const s = span(pattern())
    expect(s.maxY - s.minY).toBeCloseTo(2.334, 2)
    expect(s.maxX - s.minX).toBeCloseTo(3.667 + 2.334, 2)
  })

  it('scales both dimensions with the speed', () => {
    const slow = span(pattern({}, 110))
    const fast = span(pattern({}, 220))
    expect(fast.maxY - fast.minY).toBeCloseTo((slow.maxY - slow.minY) * 2, 2)
  })

  it('puts a right-hand pattern on the right of the inbound track', () => {
    // Flying west, a right turn goes north, so the outbound leg is north of
    // the inbound one and nothing is south of it.
    const s = span(pattern({ turns: 'right' }))
    expect(s.minY).toBeCloseTo(0, 6)
    expect(s.maxY).toBeGreaterThan(2)
  })

  it('and a left-hand pattern on the left', () => {
    const s = span(pattern({ turns: 'left' }))
    expect(s.maxY).toBeCloseTo(0, 6)
    expect(s.minY).toBeLessThan(-2)
  })

  it('follows the inbound track round the compass', () => {
    // Inbound 000 is flown northwards, so the leg begins to the south and a
    // right-hand pattern lies to the east.
    const s = span(pattern({ inboundTrue: 0 }))
    expect(s.minY).toBeLessThan(-3)
    expect(s.maxY).toBeGreaterThan(1)
    expect(s.minX).toBeCloseTo(0, 6)
    expect(s.maxX).toBeGreaterThan(2)
  })

  it('closes: the last point leads back to the first', () => {
    // The ring is closed by the renderer, so the geometry must not repeat
    // its first point -- and the gap it leaves has to be one short chord.
    const ring = pattern()
    const first = ring[0] as Vec2NM
    const last = ring[ring.length - 1] as Vec2NM
    expect(last).not.toEqual(first)
    const chord = distanceNM(ring[3] as Vec2NM, ring[4] as Vec2NM)
    expect(distanceNM(last, first)).toBeCloseTo(chord, 3)
  })

  it('keeps every point within the pattern it should occupy', () => {
    // Nothing wanders: every point is inside the bounding box a leg plus
    // two radii allows, which catches an arc swept the wrong way.
    const ring = pattern()
    for (const p of ring) {
      expect(distanceNM(fixAt, p)).toBeLessThanOrEqual(3.667 + 2.334 + 1e-9)
    }
  })

  it('takes the arc resolution as an option', () => {
    expect(pattern().length).toBe(26)
    const coarse = holdRacetrack(
      fixAt,
      { turns: 'right', legMins: 1, inboundTrue: 270, inboundIsDerived: true },
      { speedKts: 220, arcSteps: 4 },
    )
    expect(coarse.length).toBe(10)
  })

  it('draws a real pattern for every hold in the config', () => {
    for (const fix of egll.holdingFixes) {
      if (fix.hold === null) continue
      const ring = holdRacetrack(fix.posNM, fix.hold, {
        speedKts: egll.render.holdSpeedKts,
      })
      expect(ring.length, fix.name).toBeGreaterThan(20)
      // The pattern hangs off the fix, so the fix is one of its points.
      expect(ring.some((p) => distanceNM(p, fix.posNM) < 1e-9), fix.name).toBe(true)
      // And it is small enough to sit inside the sector alongside the fix.
      for (const p of ring) {
        expect(distanceNM(fix.posNM, p), fix.name).toBeLessThan(7)
      }
    }
  })
})

describe('inbound routing tables', () => {
  const withAirlines = (
    change: (airlines: Array<Record<string, unknown>>) => void,
  ): Record<string, unknown> => {
    const cfg = structuredClone(raw) as Record<string, unknown>
    const traffic = cfg['traffic'] as Record<string, unknown>
    change(traffic['airlines'] as Array<Record<string, unknown>>)
    return cfg
  }

  it('gives every operator a corridor to arrive down', () => {
    for (const airline of egll.traffic.airlines) {
      expect(airline.preferredFixes, airline.code).toBeDefined()
      expect(Object.keys(airline.preferredFixes).length, airline.code).toBeGreaterThan(0)
    }
  })

  it('names only fixes that arrivals can actually be released over', () => {
    const usable = new Set(
      egll.navaids.filter((n) => n.hold !== null && n.entry !== null).map((n) => n.name),
    )
    for (const airline of egll.traffic.airlines) {
      for (const fix of Object.keys(airline.preferredFixes)) {
        expect(usable.has(fix), `${airline.code} -> ${fix}`).toBe(true)
      }
    }
  })

  it('refuses a corridor that names a fix which does not exist', () => {
    // A typo here would be an operator that quietly arrives from
    // everywhere, which is the failure this catches at load instead.
    const cfg = withAirlines((airlines) => {
      airlines[0]!['preferredFixes'] = { BNN: 50, BOVINGDON: 50 }
    })
    expect(() => loadAirport(cfg)).toThrow(/preferredFixes.*BOVINGDON/)
  })

  it('refuses a fix that exists but is not a holding fix', () => {
    // A navaid on the chart is not somewhere traffic can be released.
    const plain = egll.navaids.find((n) => n.hold === null)
    expect(plain).toBeDefined()
    const cfg = withAirlines((airlines) => {
      airlines[0]!['preferredFixes'] = { [plain?.name ?? 'DET']: 100 }
    })
    expect(() => loadAirport(cfg)).toThrow(/preferredFixes/)
  })

  it('refuses a negative share', () => {
    const cfg = withAirlines((airlines) => {
      airlines[0]!['preferredFixes'] = { BNN: 80, OCK: -20 }
    })
    expect(() => loadAirport(cfg)).toThrow(/preferredFixes\.OCK/)
  })

  it('refuses an operator with no routing table at all', () => {
    const cfg = withAirlines((airlines) => {
      delete airlines[0]!['preferredFixes']
    })
    expect(() => loadAirport(cfg)).toThrow(/preferredFixes/)
  })

  it('accepts an empty table, which means no preference', () => {
    // Documented behaviour rather than an oversight: the spawner falls back
    // to any fix with room.
    const cfg = withAirlines((airlines) => {
      airlines[0]!['preferredFixes'] = {}
    })
    expect(() => loadAirport(cfg)).not.toThrow()
  })
})
