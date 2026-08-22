import { describe, expect, it } from 'vitest'
import raw from '../data/egll.json'
import { loadAirport } from '../data/airport'
import {
  PHONETIC,
  TAILWIND_LIMIT_KTS,
  amend,
  bestDirection,
  broadcast,
  codeOf,
  configurationsFor,
  crossTrackNM,
  crosswindKts,
  directionsOf,
  feedPlan,
  feedRunway,
  flipTo,
  headwindKts,
  letterOf,
  makeAtis,
  reciprocalOf,
  shouldFlip,
  windString,
  type RunwayFace,
} from './atis'

const airport = loadAirport(raw)
const FACES: RunwayFace[] = airport.runways.map((r) => ({
  id: r.id,
  bearingTrue: r.bearingTrue,
  thresholdNM: r.thresholdNM,
}))
const facesFor = (ids: readonly string[]) => FACES.filter((f) => ids.includes(f.id))

const WESTERLY = { fromDeg: 250, speedKts: 18 }
const EASTERLY = { fromDeg: 70, speedKts: 18 }

const START = makeAtis({ arrivals: ['27R', '27L'], departures: ['27R'], wind: WESTERLY })

describe('the letter', () => {
  it('starts at Alpha and reads out in full', () => {
    expect(letterOf(START)).toBe('Alpha')
    expect(codeOf(START)).toBe('A')
  })

  it('advances to Bravo when the runways change', () => {
    const next = amend(START, { arrivals: ['09L', '09R'] })
    expect(letterOf(next)).toBe('Bravo')
    expect(codeOf(next)).toBe('B')
  })

  it('does not advance for an amendment that changed nothing', () => {
    // The letter exists to tell a pilot their information is stale. Moving
    // it for a change that was not a change would be a lie -- and the same
    // object back means a caller can tell by reference whether it moved.
    const same = amend(START, { arrivals: ['27R', '27L'], wind: WESTERLY })
    expect(same).toBe(START)
    expect(letterOf(same)).toBe('Alpha')
  })

  it('advances for a change of wind alone', () => {
    expect(letterOf(amend(START, { wind: { fromDeg: 250, speedKts: 24 } }))).toBe('Bravo')
  })

  it('advances for a change of departure runway alone', () => {
    expect(letterOf(amend(START, { departures: ['27L'] }))).toBe('Bravo')
  })

  it('wraps round from Zulu to Alpha', () => {
    const zulu = makeAtis({ ...START, letterIndex: PHONETIC.length - 1 })
    expect(letterOf(zulu)).toBe('Zulu')
    expect(letterOf(amend(zulu, { departures: ['09L'] }))).toBe('Alpha')
  })

  it('keeps the previous broadcast intact when amended', () => {
    // A value, not a mutable controller: the old one is still readable.
    const next = amend(START, { arrivals: ['09L'] })
    expect(START.arrivals).toEqual(['27R', '27L'])
    expect(next.arrivals).toEqual(['09L'])
  })
})

describe('the broadcast', () => {
  it('reads out the letter, both runway sets and the wind', () => {
    expect(broadcast(START)).toBe('INFO A  ARR 27R/27L  DEP 27R  250/18')
  })

  it('pads the wind direction to three digits, as it is spoken', () => {
    expect(windString({ fromDeg: 70, speedKts: 8 })).toBe('070/8')
    expect(windString({ fromDeg: 5, speedKts: 12 })).toBe('005/12')
  })

  it('says CALM rather than a direction with no wind behind it', () => {
    expect(windString({ fromDeg: 250, speedKts: 0 })).toBe('CALM')
  })

  it('survives a field with nothing in use', () => {
    const shut = makeAtis({ arrivals: [], departures: [], wind: WESTERLY })
    expect(broadcast(shut)).toBe('INFO A  ARR --  DEP --  250/18')
  })
})

describe('wind on a runway', () => {
  it('is a headwind landing into it and a tailwind landing away', () => {
    // 27 lands westbound, so a wind from the west is on the nose.
    expect(headwindKts(270, { fromDeg: 270, speedKts: 20 })).toBeCloseTo(20, 6)
    expect(headwindKts(90, { fromDeg: 270, speedKts: 20 })).toBeCloseTo(-20, 6)
  })

  it('is all crosswind at right angles, and no headwind', () => {
    expect(headwindKts(270, { fromDeg: 180, speedKts: 20 })).toBeCloseTo(0, 6)
    expect(crosswindKts(270, { fromDeg: 180, speedKts: 20 })).toBeCloseTo(20, 6)
  })

  it('splits an angled wind between the two', () => {
    const head = headwindKts(270, { fromDeg: 225, speedKts: 20 })
    const cross = crosswindKts(270, { fromDeg: 225, speedKts: 20 })
    expect(head).toBeCloseTo(20 * Math.SQRT1_2, 4)
    expect(cross).toBeCloseTo(20 * Math.SQRT1_2, 4)
  })
})

describe('choosing a direction', () => {
  it('groups the parallels into the two directions the field has', () => {
    const groups = directionsOf(FACES)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.map((r) => r.id).sort())).toEqual(
      expect.arrayContaining([
        ['27L', '27R'],
        ['09L', '09R'],
      ]),
    )
  })

  it('lands into the wind, both ways round', () => {
    expect([...bestDirection(FACES, WESTERLY)].sort()).toEqual(['27L', '27R'])
    expect([...bestDirection(FACES, EASTERLY)].sort()).toEqual(['09L', '09R'])
  })

  it('takes the whole direction, not one runway of it', () => {
    expect(bestDirection(FACES, WESTERLY)).toHaveLength(2)
  })
})

describe('when to flip', () => {
  it('leaves a correct configuration alone', () => {
    expect(shouldFlip(START, FACES, WESTERLY)).toBe(false)
  })

  it('does not flip for a wind across the runway', () => {
    // The case the limit exists for. A beam wind has no tailwind component
    // worth acting on, and a field that flipped on it would flip all day.
    expect(shouldFlip(START, FACES, { fromDeg: 180, speedKts: 25 })).toBe(false)
    expect(shouldFlip(START, FACES, { fromDeg: 0, speedKts: 25 })).toBe(false)
  })

  it('tolerates a tailwind up to the limit and not past it', () => {
    const under = { fromDeg: 90, speedKts: TAILWIND_LIMIT_KTS - 1 }
    const over = { fromDeg: 90, speedKts: TAILWIND_LIMIT_KTS + 1 }
    expect(shouldFlip(START, FACES, under)).toBe(false)
    expect(shouldFlip(START, FACES, over)).toBe(true)
  })

  it('does not flap when the wind sits just around the limit', () => {
    // Walk the wind up through the limit and back down; it should change
    // its mind exactly once each way, not oscillate.
    const answers = [3, 4, 5, 6, 7, 6, 5, 4, 3].map((speed) =>
      shouldFlip(START, FACES, { fromDeg: 90, speedKts: speed }),
    )
    const changes = answers.filter((a, i) => i > 0 && a !== answers[i - 1]).length
    expect(changes).toBeLessThanOrEqual(2)
  })

  it('wants a direction when nothing is in use at all', () => {
    const shut = makeAtis({ arrivals: [], departures: [], wind: WESTERLY })
    expect(shouldFlip(shut, FACES, WESTERLY)).toBe(true)
  })
})

describe('which runway a fix feeds', () => {
  const west = facesFor(['27R', '27L'])
  const east = facesFor(['09L', '09R'])
  const holds = airport.holdingFixes.map((n) => ({ name: n.name, posNM: n.posNM }))

  it('sends the northern fixes to the northern runway', () => {
    // 27R is the northern strip; BNN and LAM are north of the field.
    expect(feedRunway(fixAt('BNN'), west)).toBe('27R')
    expect(feedRunway(fixAt('LAM'), west)).toBe('27R')
  })

  it('sends the southern fixes to the southern runway', () => {
    expect(feedRunway(fixAt('BIG'), west)).toBe('27L')
    expect(feedRunway(fixAt('OCK'), west)).toBe('27L')
  })

  it('turns the whole plan over when the field flips', () => {
    // The same strips from the other end: 27R and 09L are one runway, 27L
    // and 09R the other. So a fix keeps its side of the field and changes
    // the name it is given, which is what actually happens.
    expect(feedRunway(fixAt('BNN'), east)).toBe('09L')
    expect(feedRunway(fixAt('LAM'), east)).toBe('09L')
    expect(feedRunway(fixAt('BIG'), east)).toBe('09R')
    expect(feedRunway(fixAt('OCK'), east)).toBe('09R')
  })

  it('plans every holding fix at once', () => {
    const plan = feedPlan(holds, west)
    expect([...plan.keys()].sort()).toEqual(['BIG', 'BNN', 'LAM', 'OCK'])
    expect(plan.get('BNN')).toBe('27R')
    expect(plan.get('OCK')).toBe('27L')
  })

  it('has nothing to feed when nothing is landing', () => {
    expect(feedRunway(fixAt('BNN'), [])).toBeNull()
    expect(feedPlan(holds, []).size).toBe(0)
  })

  it('measures the offset from the extended centreline, not the threshold', () => {
    // BNN is 15 NM out but only 15 NM off the 27R centreline in the across
    // direction; the along-track distance must not enter into it.
    const rwy = facesFor(['27R'])[0]!
    expect(crossTrackNM(fixAt('BNN'), rwy)).toBeCloseTo(
      Math.abs(fixAt('BNN').y - rwy.thresholdNM.y),
      1,
    )
  })
})

function fixAt(name: string) {
  const fix = airport.holdingFixes.find((n) => n.name === name)
  if (fix === undefined) throw new Error(`no holding fix ${name}`)
  return fix.posNM
}

describe('how the field is run', () => {
  const west = facesFor(['27R', '27L'])

  it('offers a segregated operation each way round, and mixed as well', () => {
    const configs = configurationsFor(west)
    expect(configs.map((c) => c.label)).toEqual(['27R lands', '27L lands', 'Both land'])
  })

  it('puts the departures on the other runway when segregated', () => {
    // The point of segregation: an arrival and a departure off the same
    // strip have to be separated in time, and splitting them is most of
    // where the capacity comes from.
    const [first, second] = configurationsFor(west)
    expect(first!.arrivals).toEqual(['27R'])
    expect(first!.departures).toEqual(['27L'])
    expect(second!.arrivals).toEqual(['27L'])
    expect(second!.departures).toEqual(['27R'])
    expect(first!.segregated).toBe(true)
  })

  it('lands and departs everything in mixed mode', () => {
    const mixed = configurationsFor(west).at(-1)!
    expect(mixed.arrivals).toEqual(['27R', '27L'])
    expect(mixed.departures).toEqual(['27R', '27L'])
    expect(mixed.segregated).toBe(false)
  })

  it('offers a single runway no choice it does not have', () => {
    const configs = configurationsFor(facesFor(['27R']))
    expect(configs).toHaveLength(1)
    expect(configs[0]!.arrivals).toEqual(['27R'])
    expect(configs[0]!.departures).toEqual(['27R'])
    expect(configs[0]!.segregated).toBe(false)
  })

  it('has nothing to offer for a direction with no runways', () => {
    expect(configurationsFor([])).toEqual([])
  })
})

describe('the same strip from the other end', () => {
  it('pairs each face with its reciprocal', () => {
    // 27R and 09L are one piece of concrete; 27L and 09R the other.
    const rwy = (id: string) => FACES.find((f) => f.id === id)!
    expect(reciprocalOf(rwy('27R'), FACES)?.id).toBe('09L')
    expect(reciprocalOf(rwy('09L'), FACES)?.id).toBe('27R')
    expect(reciprocalOf(rwy('27L'), FACES)?.id).toBe('09R')
    expect(reciprocalOf(rwy('09R'), FACES)?.id).toBe('27L')
  })

  it('finds nothing when the other end is not there', () => {
    const only = FACES.filter((f) => f.id === '27R')
    expect(reciprocalOf(only[0]!, only)).toBeNull()
  })

  it('does not pair a runway with its own parallel', () => {
    const rwy = FACES.find((f) => f.id === '27R')!
    expect(reciprocalOf(rwy, FACES)?.id).not.toBe('27L')
  })
})

describe('turning the field round', () => {
  const west = facesFor(['27R', '27L'])
  const east = facesFor(['09L', '09R'])

  it('keeps a segregated operation segregated', () => {
    // Landing on the northern strip goes on landing on the northern strip,
    // under its other name. Reverting to everything landing would change
    // the operation, not just the direction.
    const segregated = makeAtis({
      arrivals: ['27R'],
      departures: ['27L'],
      wind: WESTERLY,
    })
    expect(flipTo(segregated, east, FACES)).toEqual({
      arrivals: ['09L'],
      departures: ['09R'],
    })
  })

  it('keeps a mixed operation mixed', () => {
    const mixed = makeAtis({
      arrivals: ['27R', '27L'],
      departures: ['27R', '27L'],
      wind: WESTERLY,
    })
    expect(flipTo(mixed, east, FACES)).toEqual({
      arrivals: ['09L', '09R'],
      departures: ['09L', '09R'],
    })
  })

  it('is its own inverse', () => {
    const start = makeAtis({ arrivals: ['27L'], departures: ['27R'], wind: WESTERLY })
    const there = flipTo(start, east, FACES)
    const back = flipTo(makeAtis({ ...start, ...there }), west, FACES)
    expect(back).toEqual({ arrivals: ['27L'], departures: ['27R'] })
  })

  it('leaves a direction it is already facing alone', () => {
    const start = makeAtis({ arrivals: ['27R'], departures: ['27L'], wind: WESTERLY })
    expect(flipTo(start, west, FACES)).toEqual({ arrivals: ['27R'], departures: ['27L'] })
  })

  it('falls back to the whole direction landing when it cannot map', () => {
    // Safe rather than clever: an operation that cannot be carried across
    // becomes a plain one rather than a wrong one.
    const odd = makeAtis({ arrivals: ['XXX'], departures: ['XXX'], wind: WESTERLY })
    expect(flipTo(odd, east, FACES)).toEqual({
      arrivals: ['09L', '09R'],
      departures: ['09L', '09R'],
    })
  })
})

describe('the feed in a segregated operation', () => {
  it('sends every fix to the one runway that is landing', () => {
    // With a single arrival runway there is no pairing left to do -- which
    // is correct, and is why the pairing is computed rather than configured.
    const one = facesFor(['27R'])
    for (const name of ['BNN', 'LAM', 'BIG', 'OCK']) {
      expect(feedRunway(fixAt(name), one)).toBe('27R')
    }
  })
})
