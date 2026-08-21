// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Sfx, isClickable } from './sfx'

interface Fake {
  ctx: {
    state: string
    resumed: number
    decoded: number
    gains: { gain: { value: number } }[]
  }
  started: unknown[]
  asContext: () => AudioContext
}

function fakeContext(over?: { state?: string; decodeFails?: boolean }): Fake {
  const started: unknown[] = []
  const gains: { gain: { value: number } }[] = []

  const ctx = {
    state: over?.state ?? 'running',
    currentTime: 0,
    resumed: 0,
    decoded: 0,
    gains,
    destination: { name: 'destination' },
    async resume(): Promise<void> {
      ctx.resumed += 1
      ctx.state = 'running'
    },
    async decodeAudioData(): Promise<unknown> {
      ctx.decoded += 1
      if (over?.decodeFails) throw new Error('undecodable')
      return { duration: 0.15 }
    },
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        connect(destination: unknown): unknown {
          return destination
        },
        start(): void {
          started.push(source)
        },
      }
      return source
    },
    createGain() {
      const gain = {
        gain: { value: 0 },
        connect(destination: unknown): unknown {
          return destination
        },
      }
      gains.push(gain)
      return gain
    },
  }

  return { ctx, started, asContext: () => ctx as unknown as AudioContext }
}

function makeSfx(
  fake: Fake,
  extra?: {
    volume?: number
    minIntervalMs?: number
    now?: () => number
    fetchFails?: boolean
  },
): Sfx {
  return new Sfx({
    url: '/click.wav',
    createContext: () => fake.asContext(),
    fetchAudio: async () => {
      if (extra?.fetchFails) throw new Error('404')
      return new ArrayBuffer(16)
    },
    ...(extra?.volume !== undefined ? { volume: extra.volume } : {}),
    ...(extra?.minIntervalMs !== undefined ? { minIntervalMs: extra.minIntervalMs } : {}),
    ...(extra?.now !== undefined ? { now: extra.now } : {}),
  })
}

describe('playing', () => {
  it('plays once the sample has loaded', async () => {
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    await sfx.prime()
    expect(sfx.ready).toBe(true)

    sfx.play()
    expect(fake.started).toHaveLength(1)
    expect(sfx.plays).toBe(1)
  })

  it('gives each press its own source so presses overlap', async () => {
    // A single shared source would cut the previous press short.
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    await sfx.prime()

    sfx.play()
    sfx.play()
    sfx.play()
    expect(fake.started).toHaveLength(3)
    expect(new Set(fake.started).size).toBe(3)
  })

  it('stays silent before the sample has loaded, and starts loading', async () => {
    // A click that arrives late is worse than one that never arrives.
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    sfx.play()
    expect(fake.started).toHaveLength(0)

    await sfx.prime()
    sfx.play()
    expect(fake.started).toHaveLength(1)
  })

  it('decodes only once however many times it is played', async () => {
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    await sfx.prime()
    for (let i = 0; i < 10; i += 1) sfx.play()
    await sfx.prime()
    expect(fake.ctx.decoded).toBe(1)
  })

  it('applies the configured volume', async () => {
    const fake = fakeContext()
    const sfx = makeSfx(fake, { volume: 0.2 })
    await sfx.prime()
    expect(fake.ctx.gains[0]?.gain.value).toBeCloseTo(0.2, 9)
  })

  it('defaults to a modest volume', async () => {
    // A click on every press gets loud quickly.
    const fake = fakeContext()
    const sfx = makeSfx(fake)
    await sfx.prime()
    const v = fake.ctx.gains[0]?.gain.value ?? 1
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(0.6)
  })
})

describe('the autoplay policy', () => {
  it('resumes a context the browser left suspended', async () => {
    // Contexts are created suspended until the user has interacted, so a
    // press has to resume before it can be heard.
    const fake = fakeContext({ state: 'suspended' })
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    await sfx.prime()

    sfx.play()
    expect(fake.ctx.resumed).toBeGreaterThan(0)
    expect(fake.started).toHaveLength(1)
  })
})

describe('muting', () => {
  it('plays nothing while muted', async () => {
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 0 })
    await sfx.prime()

    sfx.setMuted(true)
    sfx.play()
    expect(fake.started).toHaveLength(0)

    sfx.setMuted(false)
    sfx.play()
    expect(fake.started).toHaveLength(1)
  })

  it('toggles and reports its state', () => {
    const sfx = makeSfx(fakeContext())
    expect(sfx.muted).toBe(false)
    expect(sfx.toggleMuted()).toBe(true)
    expect(sfx.muted).toBe(true)
    expect(sfx.toggleMuted()).toBe(false)
  })
})

describe('rate limiting', () => {
  it('ignores presses closer together than the minimum interval', async () => {
    // A held key or an impatient double-click would otherwise stack sounds.
    let now = 1000
    const fake = fakeContext()
    const sfx = makeSfx(fake, { minIntervalMs: 25, now: () => now })
    await sfx.prime()

    sfx.play()
    now += 5
    sfx.play()
    now += 5
    sfx.play()
    expect(fake.started).toHaveLength(1)

    now += 30
    sfx.play()
    expect(fake.started).toHaveLength(2)
  })
})

describe('failing quietly', () => {
  it('goes silent when there is no audio support at all', () => {
    const sfx = new Sfx({ url: '/click.wav', createContext: () => null })
    expect(() => sfx.play()).not.toThrow()
    expect(sfx.failed).toBe(true)
    expect(sfx.plays).toBe(0)
  })

  it('goes silent when constructing the context throws', () => {
    const sfx = new Sfx({
      url: '/click.wav',
      createContext: () => {
        throw new Error('blocked')
      },
    })
    expect(() => sfx.play()).not.toThrow()
    expect(sfx.failed).toBe(true)
  })

  it('goes silent when the sample cannot be fetched', async () => {
    const fake = fakeContext()
    const sfx = makeSfx(fake, { fetchFails: true })
    await sfx.prime()
    expect(sfx.failed).toBe(true)
    expect(sfx.ready).toBe(false)
    expect(() => sfx.play()).not.toThrow()
    expect(fake.started).toHaveLength(0)
  })

  it('goes silent when the sample cannot be decoded', async () => {
    const fake = fakeContext({ decodeFails: true })
    const sfx = makeSfx(fake)
    await sfx.prime()
    expect(sfx.failed).toBe(true)
    expect(() => sfx.play()).not.toThrow()
  })
})

describe('isClickable', () => {
  function make(html: string): Element {
    document.body.innerHTML = html
    const el = document.body.firstElementChild
    if (!el) throw new Error('no element')
    return el
  }

  it('sounds for buttons and checkboxes', () => {
    expect(isClickable(make('<button>Press</button>'))).toBe(true)
    expect(isClickable(make('<input type="checkbox">'))).toBe(true)
  })

  it('sounds when the press lands on something inside a button', () => {
    const button = make('<button><span>Inner</span></button>')
    expect(isClickable(button.querySelector('span'))).toBe(true)
  })

  it('stays silent for a disabled control, because nothing happened', () => {
    expect(isClickable(make('<button disabled>Press</button>'))).toBe(false)
    expect(isClickable(make('<input type="checkbox" disabled>'))).toBe(false)
  })

  it('stays silent for the scope and for plain layout', () => {
    // A click on every pan would be maddening, and dragging the map is not
    // pressing a control.
    expect(isClickable(make('<canvas></canvas>'))).toBe(false)
    expect(isClickable(make('<div class="scope"></div>'))).toBe(false)
    expect(isClickable(make('<input type="text">'))).toBe(false)
    expect(isClickable(null)).toBe(false)
  })
})
