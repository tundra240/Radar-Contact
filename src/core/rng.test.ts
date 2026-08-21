import { describe, expect, it } from 'vitest'
import { makeRng, makeRngAt } from './rng'

describe('makeRng', () => {
  it('produces the same sequence for the same seed', () => {
    // The entire reason this exists rather than Math.random.
    const a = makeRng(12345)
    const b = makeRng(12345)
    const seqA = Array.from({ length: 200 }, () => a.next())
    const seqB = Array.from({ length: 200 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('produces different sequences for different seeds', () => {
    const one = makeRng(1)
    const two = makeRng(2)
    const a = Array.from({ length: 50 }, () => one.next())
    const b = Array.from({ length: 50 }, () => two.next())
    expect(a).not.toEqual(b)
  })

  it('stays inside the unit interval', () => {
    const r = makeRng(7)
    for (let i = 0; i < 5000; i += 1) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('counts its draws, so two runs can be compared', () => {
    const r = makeRng(3)
    expect(r.draws).toBe(0)
    r.next()
    r.int(10)
    r.range(1, 6)
    expect(r.draws).toBe(3)
  })

  it('survives a zero seed rather than sticking', () => {
    const r = makeRng(0)
    const values = new Set(Array.from({ length: 20 }, () => r.next()))
    expect(values.size).toBeGreaterThan(15)
  })

  it('is roughly uniform', () => {
    const r = makeRng(99)
    const buckets = new Array<number>(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i += 1) {
      const b = Math.floor(r.next() * 10)
      buckets[b] = (buckets[b] ?? 0) + 1
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan((n / 10) * 0.9)
      expect(count).toBeLessThan((n / 10) * 1.1)
    }
  })
})

describe('int and range', () => {
  it('stays within bounds', () => {
    const r = makeRng(5)
    for (let i = 0; i < 2000; i += 1) {
      const v = r.int(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
      const w = r.range(3, 9)
      expect(w).toBeGreaterThanOrEqual(3)
      expect(w).toBeLessThanOrEqual(9)
    }
  })

  it('reaches both ends of an inclusive range', () => {
    const r = makeRng(11)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i += 1) seen.add(r.range(1, 6))
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('copes with degenerate bounds instead of looping or throwing', () => {
    const r = makeRng(13)
    expect(r.int(0)).toBe(0)
    expect(r.int(-5)).toBe(0)
    expect(r.range(5, 5)).toBe(5)
    expect(r.range(9, 2)).toBe(9)
  })
})

describe('pick and weighted', () => {
  it('picks every item eventually', () => {
    const r = makeRng(17)
    const items = ['a', 'b', 'c', 'd']
    const seen = new Set(Array.from({ length: 400 }, () => r.pick(items)))
    expect(seen.size).toBe(4)
  })

  it('refuses an empty list rather than returning undefined', () => {
    const r = makeRng(19)
    expect(() => r.pick([])).toThrow(/empty/)
    expect(() => r.weighted([], () => 1)).toThrow(/empty/)
  })

  it('respects the weights', () => {
    const r = makeRng(23)
    const items = [
      { name: 'common', w: 90 },
      { name: 'rare', w: 10 },
    ]
    let common = 0
    const n = 20_000
    for (let i = 0; i < n; i += 1) {
      if (r.weighted(items, (x) => x.w).name === 'common') common += 1
    }
    expect(common / n).toBeGreaterThan(0.87)
    expect(common / n).toBeLessThan(0.93)
  })

  it('never returns a zero-weighted item, so a table can exclude one', () => {
    const r = makeRng(29)
    const items = [
      { name: 'yes', w: 1 },
      { name: 'never', w: 0 },
    ]
    for (let i = 0; i < 500; i += 1) {
      expect(r.weighted(items, (x) => x.w).name).toBe('yes')
    }
  })

  it('falls back to uniform when every weight is zero', () => {
    // A misconfigured table should still produce traffic.
    const r = makeRng(31)
    const items = ['a', 'b']
    const seen = new Set(Array.from({ length: 200 }, () => r.weighted(items, () => 0)))
    expect(seen.size).toBe(2)
  })
})

describe('chance', () => {
  it('is about as likely as it says', () => {
    const r = makeRng(37)
    let hits = 0
    const n = 20_000
    for (let i = 0; i < n; i += 1) if (r.chance(0.25)) hits += 1
    expect(hits / n).toBeGreaterThan(0.235)
    expect(hits / n).toBeLessThan(0.265)
  })

  it('is never true at zero and always true at one', () => {
    const r = makeRng(41)
    for (let i = 0; i < 100; i += 1) {
      expect(r.chance(0)).toBe(false)
      expect(r.chance(1)).toBe(true)
    }
  })
})

describe('makeRngAt', () => {
  /**
   * Resuming a saved session. The state has to land exactly where replaying
   * would have left it, or a loaded game deals different traffic from the
   * one that was saved.
   */
  it('lands exactly where replaying the draws would have', () => {
    for (const seed of [1, 42, 20260821, 0xffffffff]) {
      const replayed = makeRng(seed)
      for (let i = 0; i < 5000; i += 1) replayed.next()

      const resumed = makeRngAt(seed, 5000)
      expect(resumed.draws, String(seed)).toBe(replayed.draws)
      expect(resumed.seed, String(seed)).toBe(replayed.seed)
      // Twenty more from each, which is a stronger claim than one.
      const next20 = (r: typeof resumed): number[] =>
        Array.from({ length: 20 }, () => r.next())
      expect(next20(resumed), String(seed)).toEqual(next20(replayed))
    }
  })

  it('is the plain generator at zero draws', () => {
    const fresh = makeRng(7)
    const at0 = makeRngAt(7, 0)
    expect(at0.draws).toBe(0)
    expect(at0.next()).toBe(fresh.next())
  })

  it('keeps counting from where it resumed', () => {
    const r = makeRngAt(7, 1234)
    r.next()
    expect(r.draws).toBe(1235)
  })

  it('treats a negative or fractional draw count as a whole one', () => {
    expect(makeRngAt(7, -5).draws).toBe(0)
    expect(makeRngAt(7, 3.7).draws).toBe(3)
  })

  it('survives a very large draw count without losing precision', () => {
    // The multiply is modulo 2^32 by construction, so a long session cannot
    // drift the way a floating-point product would.
    const big = 5_000_000
    const replayed = makeRng(99)
    for (let i = 0; i < big; i += 1) replayed.next()
    expect(makeRngAt(99, big).next()).toBe(replayed.next())
  })
})
