import { describe, expect, it } from 'vitest'
import { makeRng } from '../core/rng'
import { loadAirport, type Airport } from '../data/airport'
import raw from '../data/egll.json'
import { FlightGenerator, type FlightIdentity } from './flightgen'

const airport = loadAirport(raw)

function draw(count: number, seed = 4242): FlightIdentity[] {
  const gen = new FlightGenerator(airport)
  const rng = makeRng(seed)
  const taken = new Set<string>()
  const out: FlightIdentity[] = []
  for (let i = 0; i < count; i += 1) {
    const flight = gen.next(rng, taken)
    taken.add(flight.callsign)
    out.push(flight)
  }
  return out
}

const airlineByCode = new Map(airport.traffic.airlines.map((a) => [a.code, a]))
const typeByCode = new Map(airport.aircraftTypes.map((t) => [t.type, t]))

describe('callsigns', () => {
  it('reads as an airline code and a flight number', () => {
    for (const f of draw(500)) {
      expect(f.callsign, f.callsign).toBe(`${f.airline}${f.flightNumber}`)
      expect(f.airline, f.callsign).toMatch(/^[A-Z]{3}$/)
      expect(Number.isInteger(f.flightNumber), f.callsign).toBe(true)
    }
  })

  it('only uses airlines from the config', () => {
    for (const f of draw(500)) {
      expect(airlineByCode.has(f.airline), f.airline).toBe(true)
    }
  })

  it('reaches every airline that has weight', () => {
    const seen = new Set(draw(6000).map((f) => f.airline))
    const expected = airport.traffic.airlines.filter((a) => a.weight > 0).map((a) => a.code)
    for (const code of expected) expect(seen, code).toContain(code)
  })

  it('favours the operators that actually dominate the field', () => {
    // British Airways is about half of Heathrow's movements, so it should
    // be the most common callsign by a clear margin.
    const flights = draw(4000)
    const counts = new Map<string, number>()
    for (const f of flights) counts.set(f.airline, (counts.get(f.airline) ?? 0) + 1)
    const ranked = [...counts].sort((a, b) => b[1] - a[1])
    expect(ranked[0]?.[0]).toBe('BAW')
    expect((ranked[0]?.[1] ?? 0) / flights.length).toBeGreaterThan(0.2)
  })
})

describe('flight numbers', () => {
  it('falls inside one of the operator bands', () => {
    // A session's worth. Draw far more than that and the narrow operator
    // bands legitimately run out, at which point the generator prefers a
    // unique callsign over a plausible number -- the documented trade-off,
    // covered separately below.
    for (const f of draw(300)) {
      const bands = airlineByCode.get(f.airline)?.numbers ?? []
      const inBand = bands.some((b) => f.flightNumber >= b.min && f.flightNumber <= b.max)
      expect(inBand, `${f.callsign} outside ${JSON.stringify(bands)}`).toBe(true)
    }
  })

  it('spreads across a wide band rather than clustering', () => {
    const baw = draw(3000).filter((f) => f.airline === 'BAW')
    expect(baw.length).toBeGreaterThan(200)
    expect(new Set(baw.map((f) => f.flightNumber)).size).toBeGreaterThan(100)
  })

  it('gives easyJet the four-digit numbers it actually uses', () => {
    const ezy = draw(8000).filter((f) => f.airline === 'EZY')
    expect(ezy.length).toBeGreaterThan(10)
    for (const f of ezy) expect(f.flightNumber, f.callsign).toBeGreaterThanOrEqual(8000)
  })
})

describe('aircraft types', () => {
  it('only uses types from the config', () => {
    for (const f of draw(1000)) expect(typeByCode.has(f.type), f.type).toBe(true)
  })

  it('never gives an operator an aircraft it does not fly', () => {
    // The whole point of the module. Drawing airline and type independently
    // produces individually plausible values that are nonsense together.
    for (const f of draw(8000)) {
      const fleet = airlineByCode.get(f.airline)?.fleet ?? []
      expect(fleet, `${f.airline} does not fly the ${f.type}`).toContain(f.type)
    }
  })

  it('rules out the specific pairings that would give the game away', () => {
    const flights = draw(10_000)
    const forbidden: [string, string][] = [
      ['EZY', 'A388'],
      ['EZY', 'B77W'],
      ['UAE', 'A319'],
      ['UAE', 'A20N'],
      ['TOM', 'A359'],
      ['SHT', 'B789'],
    ]
    for (const [airline, type] of forbidden) {
      expect(
        flights.some((f) => f.airline === airline && f.type === type),
        `${airline} should never appear as a ${type}`,
      ).toBe(false)
    }
  })

  it('keeps the common types common inside an operator fleet', () => {
    // British Airways flies everything from an A319 to an A380, so within
    // its own fleet the narrowbodies should still dominate.
    const baw = draw(6000).filter((f) => f.airline === 'BAW')
    const supers = baw.filter((f) => f.wake === 'J').length
    const mediums = baw.filter((f) => f.wake === 'M').length
    expect(mediums).toBeGreaterThan(supers * 3)
  })

  it('carries the performance figures that belong to the type', () => {
    for (const f of draw(500)) {
      const type = typeByCode.get(f.type)
      expect(f.wake, f.type).toBe(type?.wake)
      expect(f.cruiseKts, f.type).toBe(type?.cruiseKts)
      expect(f.approachKts, f.type).toBe(type?.approachKts)
    }
  })

  it('uses real ICAO designators', () => {
    // There is no designator "A350": the A350-900 is A359. A20N and A21N
    // are the neo variants.
    const codes = new Set(airport.aircraftTypes.map((t) => t.type))
    expect(codes).toContain('A359')
    expect(codes).not.toContain('A350')
    expect(codes).toContain('A20N')
    for (const code of codes) expect(code, code).toMatch(/^[A-Z][A-Z0-9]{3}$/)
  })
})

describe('uniqueness', () => {
  it('never issues the same callsign twice in a session', () => {
    // Not just among airborne traffic: a flight number arrives once a day,
    // and anything keyed on callsign would be confused by a repeat.
    const flights = draw(3000)
    expect(new Set(flights.map((f) => f.callsign)).size).toBe(flights.length)
  })

  it('avoids callsigns already in the air that it did not issue', () => {
    const gen = new FlightGenerator(airport)
    const rng = makeRng(8)
    const taken = new Set<string>()
    // Reserve a whole narrow band before generating anything.
    for (let n = 1; n <= 50; n += 1) taken.add(`UAE${n}`)

    for (let i = 0; i < 400; i += 1) {
      const f = gen.next(rng, taken)
      expect(taken.has(f.callsign), f.callsign).toBe(false)
      taken.add(f.callsign)
    }
  })

  it('counts what it has issued', () => {
    const gen = new FlightGenerator(airport)
    const rng = makeRng(3)
    expect(gen.count).toBe(0)
    for (let i = 0; i < 25; i += 1) gen.next(rng, new Set())
    expect(gen.count).toBe(25)
  })
})

describe('reproducibility', () => {
  it('gives the same flights for the same seed', () => {
    const a = draw(300, 555).map((f) => `${f.callsign}/${f.type}`)
    const b = draw(300, 555).map((f) => `${f.callsign}/${f.type}`)
    expect(a).toEqual(b)
  })

  it('gives different flights for a different seed', () => {
    const a = draw(300, 1).map((f) => f.callsign)
    const b = draw(300, 2).map((f) => f.callsign)
    expect(a).not.toEqual(b)
  })
})

describe('degenerate configuration', () => {
  /** A minimal stand-in: the generator only reads these two fields. */
  function fakeAirport(
    airlines: {
      code: string
      weight: number
      fleet: string[]
      numbers: [number, number][]
    }[],
  ): Airport {
    return {
      aircraftTypes: [
        { type: 'A320', wake: 'M', cruiseKts: 250, approachKts: 140, weight: 1 },
        { type: 'B738', wake: 'M', cruiseKts: 250, approachKts: 142, weight: 1 },
      ],
      traffic: {
        airlines: airlines.map((a) => ({
          code: a.code,
          weight: a.weight,
          fleet: a.fleet,
          numbers: a.numbers.map(([min, max]) => ({ min, max })),
        })),
      },
    } as unknown as Airport
  }

  it('leaves the bands behind rather than duplicating when one is exhausted', () => {
    // Two numbers available, four flights asked for.
    const gen = new FlightGenerator(
      fakeAirport([{ code: 'TST', weight: 1, fleet: ['A320'], numbers: [[1, 2]] }]),
    )
    const rng = makeRng(2)
    const taken = new Set<string>()
    const issued: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const f = gen.next(rng, taken)
      taken.add(f.callsign)
      issued.push(f.callsign)
    }
    expect(new Set(issued).size).toBe(4)
    expect(issued).toContain('TST1')
    expect(issued).toContain('TST2')
  })

  it('falls back to the whole type list when a fleet is empty', () => {
    const gen = new FlightGenerator(
      fakeAirport([{ code: 'TST', weight: 1, fleet: [], numbers: [[1, 999]] }]),
    )
    expect(gen.fleetFor('TST').length).toBe(2)
    const f = gen.next(makeRng(1), new Set())
    expect(['A320', 'B738']).toContain(f.type)
  })

  it('copes with no number bands at all', () => {
    const gen = new FlightGenerator(
      fakeAirport([{ code: 'TST', weight: 1, fleet: ['A320'], numbers: [] }]),
    )
    const rng = makeRng(1)
    const a = gen.next(rng, new Set())
    const b = gen.next(rng, new Set())
    expect(a.callsign).not.toBe(b.callsign)
    expect(a.flightNumber).toBeGreaterThan(0)
  })
})

describe('capacity', () => {
  it('stays fully in band for any session length that could actually happen', () => {
    // The config offers 3510 distinct callsigns, and the first operator to
    // run dry is JAL with 21 numbers at a 2 percent share -- around 1000
    // flights, or 25 simulated hours at a realistic arrival rate. Eight
    // hundred is a generous session and comfortably inside that.
    for (const f of draw(800)) {
      const bands = airlineByCode.get(f.airline)?.numbers ?? []
      const inBand = bands.some((b) => f.flightNumber >= b.min && f.flightNumber <= b.max)
      expect(inBand, `${f.callsign} outside ${JSON.stringify(bands)}`).toBe(true)
    }
  })

  it('prefers a unique callsign over a plausible number once a band runs dry', () => {
    // Past that point uniqueness has to win: two aircraft the controller
    // cannot tell apart is worse than a flight number the airline would not
    // really use. Five thousand flights is about 125 simulated hours.
    const flights = draw(5000)
    expect(new Set(flights.map((f) => f.callsign)).size).toBe(flights.length)

    const outOfBand = flights.filter((f) => {
      const bands = airlineByCode.get(f.airline)?.numbers ?? []
      return !bands.some((b) => f.flightNumber >= b.min && f.flightNumber <= b.max)
    })
    expect(outOfBand.length).toBeGreaterThan(0)
    // And every one of them is a fallback number, not a stray in-band draw.
    for (const f of outOfBand) {
      expect(f.flightNumber, f.callsign).toBeGreaterThanOrEqual(9000)
    }
  })
})
