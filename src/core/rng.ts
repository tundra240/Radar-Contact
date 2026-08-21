/**
 * Seeded pseudo-random numbers.
 *
 * Deliberately not `Math.random`. Traffic generation is the one part of the
 * simulation that invents things, so it is the part that has to be
 * reproducible: a seed plus a tick count identifies a session exactly,
 * which makes a scenario repeatable, a bug report actionable and a replay
 * possible. `Math.random` would forfeit all three.
 *
 * mulberry32: small, fast, and good enough for choosing aircraft types and
 * spawn intervals. Not for anything cryptographic.
 */
export interface Rng {
  readonly seed: number
  /** How many numbers have been drawn. Two runs agreeing here agree fully. */
  readonly draws: number
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** Uniform integer in [min, max], inclusive at both ends. */
  range(min: number, max: number): number
  /** Uniform choice. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T
  /**
   * Choice weighted by `weight`. Non-positive weights are skipped, so an
   * item can be excluded by weighting it zero.
   */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T
  /** True with the given probability. */
  chance(probability: number): boolean
}

/** The step mulberry32 adds to its state on every draw. */
const STEP = 0x6d2b79f5

export function makeRng(seed: number): Rng {
  return makeRngAt(seed, 0)
}

/**
 * An Rng resumed part way through, at a given number of draws.
 *
 * mulberry32 advances its state by a fixed constant every draw, so the
 * state after n of them is the seed plus n times that constant, modulo
 * 2^32. Which means a saved session can be resumed exactly without
 * replaying the draws that got it there -- and an hour of traffic is tens
 * of thousands of them.
 */
export function makeRngAt(seed: number, atDraw: number): Rng {
  // Keep the seed in 32 bits, and avoid a zero state.
  const base = (Math.floor(seed) >>> 0) || 0x9e3779b9
  let draws = Math.max(0, Math.floor(atDraw))
  // imul multiplies modulo 2^32, which is exactly the arithmetic wanted.
  let state = (base + Math.imul(draws, STEP)) >>> 0

  const next = (): number => {
    draws += 1
    state = (state + STEP) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rng: Rng = {
    seed: Math.floor(seed) >>> 0,
    get draws() {
      return draws
    },
    next,
    int(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0
      return Math.floor(next() * maxExclusive)
    },
    range(min: number, max: number): number {
      if (max < min) return min
      return min + Math.floor(next() * (max - min + 1))
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty list')
      const item = items[Math.floor(next() * items.length)]
      // Index is in range by construction; this satisfies the compiler
      // without an assertion that could hide a real bug later.
      if (item === undefined) throw new Error('rng.pick: index out of range')
      return item
    },
    weighted<T>(items: readonly T[], weight: (item: T) => number): T {
      if (items.length === 0) throw new Error('rng.weighted: empty list')
      let total = 0
      for (const item of items) {
        const w = weight(item)
        if (w > 0) total += w
      }
      // Every weight zero or negative: fall back to a uniform choice rather
      // than failing, so a misconfigured table still produces traffic.
      if (total <= 0) return rng.pick(items)

      let roll = next() * total
      for (const item of items) {
        const w = weight(item)
        if (w <= 0) continue
        roll -= w
        if (roll < 0) return item
      }
      // Floating point can leave a hair of the total unclaimed.
      const last = items[items.length - 1]
      if (last === undefined) throw new Error('rng.weighted: empty list')
      return last
    },
    chance(probability: number): boolean {
      return next() < probability
    },
  }

  return rng
}
