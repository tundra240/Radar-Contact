import { describe, expect, it } from 'vitest'
import {
  advance,
  angleDelta,
  bearingDeg,
  distanceNM,
  haversineNM,
  headingToUnitVector,
  makeProjection,
  normalizeHeading,
  type LatLon,
} from './geo'

const EGLL_ARP: LatLon = { lat: 51.470748, lon: -0.459909 }

// The four Heathrow holds, from the OurAirports navaid dataset.
const HOLDS: Record<string, LatLon> = {
  LAM: { lat: 51.646099, lon: 0.151667 },
  BIG: { lat: 51.330898, lon: 0.034811 },
  BNN: { lat: 51.726101, lon: -0.549722 },
  OCK: { lat: 51.305, lon: -0.447222 },
}

describe('normalizeHeading', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeHeading(0)).toBe(0)
    expect(normalizeHeading(360)).toBe(0)
    expect(normalizeHeading(-10)).toBe(350)
    expect(normalizeHeading(370)).toBe(10)
    expect(normalizeHeading(-730)).toBe(350)
  })
})

describe('angleDelta', () => {
  it('takes the short way round north', () => {
    // The bug this exists to prevent: 350 -> 010 is a 20 degree right
    // turn, not a 340 degree left turn.
    expect(angleDelta(350, 10)).toBe(20)
    expect(angleDelta(10, 350)).toBe(-20)
  })

  it('is zero for identical headings', () => {
    expect(angleDelta(270, 270)).toBe(0)
  })

  it('resolves a reciprocal to a right turn', () => {
    expect(angleDelta(90, 270)).toBe(180)
    expect(angleDelta(270, 90)).toBe(180)
  })

  it('never exceeds 180 degrees in magnitude', () => {
    for (let from = 0; from < 360; from += 7) {
      for (let to = 0; to < 360; to += 11) {
        const d = angleDelta(from, to)
        expect(Math.abs(d)).toBeLessThanOrEqual(180)
        // Applying the delta must land on the target heading.
        expect(normalizeHeading(from + d)).toBeCloseTo(normalizeHeading(to), 9)
      }
    }
  })
})

describe('projection', () => {
  const proj = makeProjection(EGLL_ARP)

  it('places the origin at zero', () => {
    const o = proj.toWorld(EGLL_ARP)
    expect(o.x).toBeCloseTo(0, 12)
    expect(o.y).toBeCloseTo(0, 12)
  })

  it('round-trips exactly', () => {
    for (const p of Object.values(HOLDS)) {
      const back = proj.toLatLon(proj.toWorld(p))
      expect(back.lat).toBeCloseTo(p.lat, 10)
      expect(back.lon).toBeCloseTo(p.lon, 10)
    }
  })

  it('orients +y north and +x east', () => {
    const north = proj.toWorld({ lat: EGLL_ARP.lat + 0.1, lon: EGLL_ARP.lon })
    expect(north.y).toBeGreaterThan(0)
    expect(north.x).toBeCloseTo(0, 9)

    const east = proj.toWorld({ lat: EGLL_ARP.lat, lon: EGLL_ARP.lon + 0.1 })
    expect(east.x).toBeGreaterThan(0)
    expect(east.y).toBeCloseTo(0, 9)
  })

  it('scales latitude at exactly 60 NM per degree', () => {
    const p = proj.toWorld({ lat: EGLL_ARP.lat + 1, lon: EGLL_ARP.lon })
    expect(p.y).toBeCloseTo(60, 9)
  })

  it('agrees with great-circle distance across the terminal area', () => {
    // The planar projection is an approximation. This pins how much it
    // distorts over the ~25 NM the sector actually spans, using haversine
    // as an independent oracle. Tolerance is 0.1 percent.
    for (const [name, p] of Object.entries(HOLDS)) {
      const planar = distanceNM({ x: 0, y: 0 }, proj.toWorld(p))
      const great = haversineNM(EGLL_ARP, p)
      const relError = Math.abs(planar - great) / great
      expect(relError, `${name} relative error`).toBeLessThan(0.001)
    }
  })
})

describe('bearingDeg', () => {
  const o = { x: 0, y: 0 }

  it('reads cardinal directions as compass degrees', () => {
    expect(bearingDeg(o, { x: 0, y: 1 })).toBeCloseTo(0, 9)
    expect(bearingDeg(o, { x: 1, y: 0 })).toBeCloseTo(90, 9)
    expect(bearingDeg(o, { x: 0, y: -1 })).toBeCloseTo(180, 9)
    expect(bearingDeg(o, { x: -1, y: 0 })).toBeCloseTo(270, 9)
  })

  it('is the inverse of advance', () => {
    for (const hdg of [0, 45, 137, 270, 359]) {
      const p = advance(o, hdg, 12)
      expect(bearingDeg(o, p)).toBeCloseTo(hdg, 6)
      expect(distanceNM(o, p)).toBeCloseTo(12, 9)
    }
  })
})

describe('headingToUnitVector', () => {
  it('returns unit length', () => {
    for (const hdg of [0, 33, 90, 181, 305]) {
      const u = headingToUnitVector(hdg)
      expect(Math.hypot(u.x, u.y)).toBeCloseTo(1, 12)
    }
  })
})
