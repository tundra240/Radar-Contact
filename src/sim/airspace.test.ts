import { describe, expect, it } from 'vitest'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import {
  exitRangeNM,
  footprint,
  inPolygon,
  inVolume,
  isControlled,
  isWithinFootprint,
  reachNM,
  volumeAt,
  type ControlVolume,
  type ControlZone,
} from './airspace'

/** A 20 NM square from 2,500 up: a TMA with nothing under it. */
const TMA: ControlVolume = {
  polygon: [
    { x: -20, y: -20 },
    { x: 20, y: -20 },
    { x: 20, y: 20 },
    { x: -20, y: 20 },
  ],
  floorFt: 2500,
  ceilingFt: 19500,
  label: 'TEST TMA',
}

/** A 5 NM square from the surface: the zone under it. */
const CTR: ControlVolume = {
  polygon: [
    { x: -5, y: -5 },
    { x: 5, y: -5 },
    { x: 5, y: 5 },
    { x: -5, y: 5 },
  ],
  floorFt: 0,
  ceilingFt: 2500,
  label: 'TEST CTR',
}

const ZONE: ControlZone = [TMA, CTR]

describe('inPolygon', () => {
  it('knows inside from outside', () => {
    expect(inPolygon(TMA.polygon, { x: 0, y: 0 })).toBe(true)
    expect(inPolygon(TMA.polygon, { x: 19.9, y: 0 })).toBe(true)
    expect(inPolygon(TMA.polygon, { x: 20.1, y: 0 })).toBe(false)
    expect(inPolygon(TMA.polygon, { x: 0, y: -25 })).toBe(false)
  })

  it('handles a concave ring, which published airspace is full of', () => {
    // An L: the bite out of the corner must read as outside, even though it
    // is well inside the bounding box of the whole thing.
    const ell = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(inPolygon(ell, { x: 2, y: 2 })).toBe(true)
    expect(inPolygon(ell, { x: 8, y: 2 })).toBe(true)
    expect(inPolygon(ell, { x: 2, y: 8 })).toBe(true)
    expect(inPolygon(ell, { x: 8, y: 8 })).toBe(false)
  })

  it('does not need the ring to repeat its first point', () => {
    const open = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(inPolygon(open, { x: 5, y: 5 })).toBe(true)
    expect(inPolygon(open, { x: 15, y: 5 })).toBe(false)
  })
})

describe('inVolume', () => {
  it('takes the vertical limits as seriously as the lateral ones', () => {
    expect(inVolume(TMA, { x: 0, y: 0 }, 8000)).toBe(true)
    expect(inVolume(TMA, { x: 0, y: 0 }, 2000)).toBe(false)
    expect(inVolume(TMA, { x: 0, y: 0 }, 20000)).toBe(false)
  })

  it('includes its own floor and ceiling', () => {
    expect(inVolume(TMA, { x: 0, y: 0 }, TMA.floorFt)).toBe(true)
    expect(inVolume(TMA, { x: 0, y: 0 }, TMA.ceilingFt)).toBe(true)
  })
})

describe('isControlled', () => {
  it('stacks the volumes, so the zone under the TMA fills the gap', () => {
    expect(isControlled(ZONE, { x: 0, y: 0 }, 500)).toBe(true)
    expect(isControlled(ZONE, { x: 0, y: 0 }, 8000)).toBe(true)
  })

  it('leaves a hole where the real airspace has one', () => {
    // Ten miles out and below the base of the TMA: inside the footprint,
    // outside the airspace. That is the shape of the real thing.
    expect(isWithinFootprint(ZONE, { x: 10, y: 0 })).toBe(true)
    expect(isControlled(ZONE, { x: 10, y: 0 }, 2000)).toBe(false)
    expect(isControlled(ZONE, { x: 10, y: 0 }, 3000)).toBe(true)
  })

  it('says which piece of airspace a point is in', () => {
    expect(volumeAt(ZONE, { x: 0, y: 0 }, 1000)?.label).toBe('TEST CTR')
    expect(volumeAt(ZONE, { x: 0, y: 0 }, 8000)?.label).toBe('TEST TMA')
    expect(volumeAt(ZONE, { x: 30, y: 0 }, 8000)).toBeNull()
  })
})

describe('footprint', () => {
  it('drops a ring that sits inside another', () => {
    // The CTR is inside the TMA laterally, so it adds nothing to the
    // outline -- which is what lets the boundary be drawn as one path.
    const rings = footprint(ZONE)
    expect(rings).toHaveLength(1)
    expect(rings[0]).toBe(TMA.polygon)
  })

  it('keeps a ring that sticks out', () => {
    const outlier: ControlVolume = {
      polygon: [
        { x: 25, y: 0 },
        { x: 35, y: 0 },
        { x: 35, y: 10 },
      ],
      floorFt: 0,
      ceilingFt: 5000,
      label: 'OUTLIER',
    }
    expect(footprint([...ZONE, outlier])).toHaveLength(2)
  })
})

describe('reachNM and exitRangeNM', () => {
  it('reports how far the airspace gets from a point', () => {
    expect(reachNM(ZONE, { x: 0, y: 0 })).toBeCloseTo(Math.hypot(20, 20), 6)
  })

  it('finds where the boundary is along a bearing', () => {
    // Walked in tenth-of-a-mile steps, so the answer is the last step that
    // was still inside rather than the exact crossing.
    const east = exitRangeNM(ZONE, { x: 0, y: 0 }, 90)
    expect(east).toBeGreaterThan(19.8)
    expect(east).toBeLessThanOrEqual(20)
    // North-east is the corner of the square, so further out.
    expect(exitRangeNM(ZONE, { x: 0, y: 0 }, 45)).toBeGreaterThan(20)
  })

  it('takes the last crossing rather than the first', () => {
    // A ring the line leaves and re-enters. Taking the first crossing would
    // put the boundary in the middle of the airspace.
    // A slot cut in from the top, down past the line being walked, so due
    // east is inside out to 4 miles, outside from 4 to 6, and inside again
    // from 6 to 10. Taking the first crossing would report 4.
    const notched: ControlZone = [
      {
        polygon: [
          { x: 0, y: -10 },
          { x: 10, y: -10 },
          { x: 10, y: 10 },
          { x: 6, y: 10 },
          { x: 6, y: -1 },
          { x: 4, y: -1 },
          { x: 4, y: 10 },
          { x: 0, y: 10 },
        ],
        floorFt: 0,
        ceilingFt: 10000,
        label: 'NOTCHED',
      },
    ]
    // Sanity: the walk really does pass through a gap.
    expect(isWithinFootprint(notched, { x: 5, y: 0 })).toBe(false)
    expect(isWithinFootprint(notched, { x: 8, y: 0 })).toBe(true)
    expect(exitRangeNM(notched, { x: 0, y: 0 }, 90)).toBeGreaterThan(9)
  })
})

describe('the real EGLL airspace', () => {
  const airport = loadAirport(raw)
  const FIELD = { x: 0, y: 0 }

  it('is two published rings, both containing the field', () => {
    expect(airport.controlZone).toHaveLength(2)
    expect(airport.controlZone.map((v) => v.label).sort()).toEqual(['LONDON CTR', 'LONDON TMA'])
    for (const v of airport.controlZone) {
      expect(inPolygon(v.polygon, FIELD), v.label).toBe(true)
    }
  })

  it('covers the field from the ground to the top of the TMA', () => {
    for (const alt of [0, 1000, 2500, 8000, 19500]) {
      expect(isControlled(airport.controlZone, FIELD, alt), String(alt)).toBe(true)
    }
  })

  it('covers every hold at every level it hands traffic over at', () => {
    for (const n of airport.navaids.filter((x) => x.hold !== null && x.entry !== null)) {
      for (const alt of [n.entry?.minAltFt ?? 0, n.entry?.maxAltFt ?? 0]) {
        expect(isControlled(airport.controlZone, n.posNM, alt), `${n.name} at ${alt}`).toBe(true)
      }
    }
  })

  it('covers every runway threshold down to the ground', () => {
    for (const r of airport.runways) {
      expect(isControlled(airport.controlZone, r.thresholdNM, r.thresholdElevationFt), r.id)
        .toBe(true)
    }
  })

  it('has one outline, because the CTR sits inside the TMA', () => {
    expect(airport.controlFootprint).toHaveLength(1)
    expect(airport.controlFootprint[0]?.length).toBeGreaterThan(20)
  })

  it('is not a circle, which is the whole point', () => {
    // How far it is to the boundary varies by half again depending on which
    // way you look, which a radius cannot express.
    const ranges = [0, 45, 90, 135, 180, 225, 270, 315].map((b) =>
      exitRangeNM(airport.controlZone, FIELD, b),
    )
    expect(Math.max(...ranges) / Math.min(...ranges)).toBeGreaterThan(1.5)
  })

  it('reaches about as far as the radius it replaced', () => {
    // A sanity check on the substitution as a whole: the shape changed, the
    // scale did not.
    const reach = reachNM(airport.controlZone, FIELD)
    expect(reach).toBeGreaterThan(airport.sector.radiusNM * 0.8)
    expect(reach).toBeLessThan(airport.sector.radiusNM * 1.2)
  })

  it('leaves no controlled airspace below the TMA away from the zone', () => {
    // Twenty-five miles out at 2,000 ft is under the base of the TMA and
    // well outside the CTR, so it is nobody's airspace -- and that is not a
    // gap in the data, it is the real thing.
    expect(isWithinFootprint(airport.controlZone, { x: 25, y: 0 })).toBe(true)
    expect(isControlled(airport.controlZone, { x: 25, y: 0 }, 2000)).toBe(false)
    expect(isControlled(airport.controlZone, { x: 25, y: 0 }, 4000)).toBe(true)
  })
})
