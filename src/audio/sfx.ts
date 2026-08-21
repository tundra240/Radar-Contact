/**
 * Interface sound.
 *
 * One short sample, played on every control press. Three things matter more
 * than the sound itself:
 *
 * - **It can never break the interface.** No Web Audio, a blocked context,
 *   a failed fetch, a sample that will not decode: every one of those ends
 *   in silence, not an exception.
 * - **It must start inside a user gesture.** Browsers create audio contexts
 *   suspended until the user has interacted, so the context is built lazily
 *   on the first press and resumed if it is found suspended.
 * - **Presses overlap.** Each play gets its own source node, because a
 *   shared one would cut the previous press short.
 */

export interface SfxOptions {
  readonly url: string
  /** Modest by default: a click on every press gets loud quickly. */
  readonly volume?: number
  /** Injected so tests can run without Web Audio or a real network. */
  readonly createContext?: () => AudioContext | null
  readonly fetchAudio?: (url: string) => Promise<ArrayBuffer>
  /** Presses closer together than this are ignored. */
  readonly minIntervalMs?: number
  readonly now?: () => number
}

export class Sfx {
  private readonly url: string
  private readonly volume: number
  private readonly createContext: () => AudioContext | null
  private readonly fetchAudio: (url: string) => Promise<ArrayBuffer>
  private readonly minIntervalMs: number
  private readonly nowMs: () => number

  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private buffer: AudioBuffer | null = null
  private loading: Promise<void> | null = null
  private isMuted = false
  private unavailable = false
  private lastPlayMs = Number.NEGATIVE_INFINITY
  private playCount = 0

  constructor(opts: SfxOptions) {
    this.url = opts.url
    this.volume = opts.volume ?? 0.35
    this.createContext =
      opts.createContext ??
      ((): AudioContext | null => {
        const Ctor: typeof AudioContext | undefined =
          typeof AudioContext !== 'undefined' ? AudioContext : undefined
        return Ctor ? new Ctor() : null
      })
    this.fetchAudio =
      opts.fetchAudio ??
      (async (url: string): Promise<ArrayBuffer> => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`sfx: ${response.status} for ${url}`)
        return response.arrayBuffer()
      })
    this.minIntervalMs = opts.minIntervalMs ?? 25
    this.nowMs = opts.now ?? ((): number => Date.now())
  }

  get muted(): boolean {
    return this.isMuted
  }

  /** True once the sample has decoded and a press would be audible. */
  get ready(): boolean {
    return this.buffer !== null
  }

  /** True when audio turned out to be impossible; presses are silent. */
  get failed(): boolean {
    return this.unavailable
  }

  /** How many sounds have actually been started. For tests. */
  get plays(): number {
    return this.playCount
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted
  }

  toggleMuted(): boolean {
    this.isMuted = !this.isMuted
    return this.isMuted
  }

  /**
   * Play the click. Safe to call from any event handler and safe to call
   * before the sample has loaded, in which case it starts the load and
   * stays silent -- a click that arrives late is worse than one that never
   * arrives.
   */
  play(): void {
    if (this.isMuted || this.unavailable) return

    const now = this.nowMs()
    if (now - this.lastPlayMs < this.minIntervalMs) return

    const ctx = this.ensureContext()
    if (!ctx) return

    // Contexts start suspended until the user has interacted. This is
    // called from a press, so resuming here is allowed.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)

    if (!this.buffer) {
      void this.load()
      return
    }

    this.lastPlayMs = now
    try {
      const source = ctx.createBufferSource()
      source.buffer = this.buffer
      source.connect(this.gain ?? ctx.destination)
      source.start()
      this.playCount += 1
    } catch {
      // A failure here means the context died under us. Go quiet rather
      // than throwing out of an event handler.
      this.unavailable = true
    }
  }

  /** Fetch and decode ahead of the first press. */
  async prime(): Promise<void> {
    this.ensureContext()
    await this.load()
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (this.unavailable) return null
    try {
      const ctx = this.createContext()
      if (!ctx) {
        this.unavailable = true
        return null
      }
      this.ctx = ctx
      const gain = ctx.createGain()
      gain.gain.value = this.volume
      gain.connect(ctx.destination)
      this.gain = gain
      return ctx
    } catch {
      this.unavailable = true
      return null
    }
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading
    const ctx = this.ensureContext()
    if (!ctx) return Promise.resolve()

    this.loading = (async (): Promise<void> => {
      try {
        const data = await this.fetchAudio(this.url)
        this.buffer = await ctx.decodeAudioData(data)
      } catch {
        // Missing or undecodable sample: silence, not a broken interface.
        this.unavailable = true
      }
    })()
    return this.loading
  }
}

/**
 * Whether a click on this element should sound.
 *
 * Buttons and checkboxes -- the things that are pressed. Deliberately not
 * the scope itself: a click sound on every pan would be maddening, and
 * dragging the map is not pressing a control. Disabled controls stay silent
 * too, since nothing happened.
 */
export function isClickable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target.closest('button, input[type="checkbox"]')
  if (!el) return false
  if (el instanceof HTMLButtonElement && el.disabled) return false
  if (el instanceof HTMLInputElement && el.disabled) return false
  return true
}
