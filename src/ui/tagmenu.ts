import type { Envelope } from '../commands/apply'
import type { Command, CommandSink } from '../commands/types'
import { headingLabel, normalizeHeading } from '../core/geo'
import { isHeavy, modeC, trendOf, type Aircraft } from '../sim/types'

/**
 * The tag menu: right-click an aircraft, get its clearances.
 *
 * This is how the job is actually done. A controller does not hunt for a
 * fixed button that issues one preset descent -- they point at the target
 * and pick the level they want. So every instruction lives behind the
 * target itself, on the scope or on its strip, and the three quick-buttons
 * that used to sit on every strip are gone.
 *
 * Two rules it keeps:
 *
 * - **Only offer what will be accepted.** The levels come from the
 *   sector's own floor and ceiling and the speeds from the aircraft type's
 *   envelope and the sector speed limit -- the same numbers commands/apply
 *   validates against. A menu that offers a level the sector will refuse
 *   is a menu that teaches the wrong limits.
 * - **Do not decide what is flyable.** Every kind in the Command union is
 *   offered. `applyCommand` is the one authority on what the simulation
 *   can currently fly, and it answers honestly in the console. Greying
 *   items out here would put that knowledge in two places, and the second
 *   copy would go stale the moment approaches start working.
 */

/** Which panel the menu is showing. */
export type TagPage = 'root' | 'heading' | 'altitude' | 'speed' | 'approach' | 'hold'

/** The sector limits the choices are derived from. */
export interface TagLimits {
  readonly floorFt: number
  readonly ceilingFt: number
  readonly speedLimitKts: number
  readonly speedLimitBelowFt: number
}

export interface TagMenuOptions {
  readonly mount: HTMLElement
  readonly onCommand: CommandSink
  readonly limits: TagLimits
  /** Runways an approach can be cleared for. */
  readonly runways: readonly string[]
  /** Fixes with a published hold. */
  readonly holdFixes: readonly string[]
  /** Null for a type the config does not carry, which widens the choices. */
  readonly envelopeFor: (type: string) => Envelope | null
}

/* ------------------------------------------------------------- choices */

/** Assigned headings, every ten degrees. */
export const HEADING_STEP = 10

/**
 * Headings as the command wants them, so nothing has to be translated on
 * the way out: due north is zero, and it sits at the end of the list
 * because on a compass it reads as three-six-zero.
 */
export function headingChoices(step: number = HEADING_STEP): readonly number[] {
  const out: number[] = []
  for (let deg = step; deg < 360; deg += step) out.push(deg)
  out.push(0)
  return out
}

/**
 * The turns that get used most: a nudge either side of where the aircraft
 * is already pointing, resolved to an absolute heading so the Command
 * union does not need a relative form.
 */
export function relativeTurns(hdg: number): readonly { label: string; deg: number }[] {
  const out: { label: string; deg: number }[] = []
  for (const by of [30, 20, 10]) out.push({ label: `L${by}`, deg: normalizeHeading(hdg - by) })
  for (const by of [10, 20, 30]) out.push({ label: `R${by}`, deg: normalizeHeading(hdg + by) })
  return out
}

/**
 * Levels between the sector floor and ceiling, highest first so the list
 * reads like an altitude scale rather than a row of numbers.
 *
 * Thousand-foot steps where the vectoring happens and two-thousand above
 * ten, because nobody hands out intermediate levels at fifteen thousand.
 * The floor and the ceiling are always offered even when the step would
 * miss them: they are the two levels most worth being able to reach.
 */
export function altitudeChoices(limits: Pick<TagLimits, 'floorFt' | 'ceilingFt'>): readonly number[] {
  const out: number[] = []
  const first = Math.ceil(limits.floorFt / 1000) * 1000
  if (limits.floorFt < first) out.push(limits.floorFt)
  for (let ft = first; ft <= limits.ceilingFt; ft += ft < 10000 ? 1000 : 2000) out.push(ft)
  if (out[out.length - 1] !== limits.ceilingFt) out.push(limits.ceilingFt)
  return out.reverse()
}

/** A level as a clearance reads it: feet low down, a flight level high up. */
export function altitudeLabel(ft: number): string {
  return ft >= 10000 ? `FL${Math.round(ft / 100)}` : String(ft)
}

/**
 * Speeds the aircraft can actually fly and the sector will actually
 * accept, fastest first because the instruction is nearly always a
 * reduction.
 *
 * The lower end is the type's approach speed rounded up to the next ten,
 * so every offered speed clears the envelope check rather than sitting one
 * knot under it.
 */
export function speedChoices(
  a: Aircraft,
  limits: Pick<TagLimits, 'speedLimitKts' | 'speedLimitBelowFt'>,
  envelope: Envelope | null,
  step = 10,
): readonly number[] {
  const fastest = envelope?.maxSpeedKts ?? limits.speedLimitKts
  // The sector speed limit bites on the LOWER of where the aircraft is and
  // where it has been cleared to, exactly as commands/apply checks it -- an
  // aircraft at twelve thousand descending to seven is already bound by it,
  // and offering it 280 kt would be offering a refusal.
  const lowest = Math.min(a.altFt, a.clearedAltFt)
  const capped = lowest < limits.speedLimitBelowFt ? Math.min(fastest, limits.speedLimitKts) : fastest
  const top = Math.floor(capped / step) * step
  const bottom = Math.ceil((envelope?.minSpeedKts ?? limits.speedLimitKts) / step) * step

  const out: number[] = []
  for (let kts = top; kts >= bottom; kts -= step) out.push(kts)
  return out
}

/** The readout under the title: what the aircraft is doing right now. */
export function tagReadout(a: Aircraft): string {
  const trend = trendOf(a.vsFpm)
  const glyph = trend === 'climb' ? '^' : trend === 'descend' ? 'v' : '='
  const hdg = String(Math.round(a.hdg)).padStart(3, '0')
  return `${modeC(a.altFt)} ${glyph} ${modeC(a.clearedAltFt)}   ${Math.round(a.gsKts)}kt   H${hdg}`
}

/* ---------------------------------------------------------------- panel */

const ROOT_ITEMS: readonly { readonly page: TagPage; readonly label: string }[] = [
  { page: 'heading', label: 'HEADING' },
  { page: 'altitude', label: 'ALTITUDE' },
  { page: 'speed', label: 'SPEED' },
  { page: 'approach', label: 'APPROACH' },
  { page: 'hold', label: 'HOLD' },
]

/**
 * Panel width, kept in step with `.tagmenu` in style.css. The menu has to
 * be clamped inside the display at the moment it opens, which is before
 * the browser has laid it out and measured anything.
 */
const WIDTH_PX = 182
const HEIGHT_FALLBACK_PX = 210
const EDGE_PX = 4

export class TagMenu {
  private readonly opts: TagMenuOptions
  private readonly root: HTMLDivElement
  private readonly titleEl: HTMLDivElement
  private readonly readoutEl: HTMLDivElement
  private readonly bodyEl: HTMLDivElement
  private aircraft: Aircraft | null = null
  private page: TagPage = 'root'

  constructor(opts: TagMenuOptions) {
    this.opts = opts

    this.root = document.createElement('div')
    this.root.className = 'tagmenu'
    this.root.hidden = true
    // Right-clicking inside the menu must not open a second one.
    this.root.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault())

    this.titleEl = document.createElement('div')
    this.titleEl.className = 'tagmenu-title'

    this.readoutEl = document.createElement('div')
    this.readoutEl.className = 'tagmenu-readout'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'tagmenu-body'

    this.root.append(this.titleEl, this.readoutEl, this.bodyEl)
    opts.mount.appendChild(this.root)

    // Capture, so a click that lands on a control behind the menu closes
    // the menu before that control acts on it.
    document.addEventListener(
      'pointerdown',
      (e: Event) => {
        if (!this.isOpen) return
        if (e.target instanceof Node && this.root.contains(e.target)) return
        this.close()
      },
      true,
    )
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.isOpen) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Which aircraft the menu is showing, or null while it is closed. */
  get callsign(): string | null {
    return this.isOpen ? (this.aircraft?.callsign ?? null) : null
  }

  /** Visible for tests and for main.ts to reposition on a resize. */
  get element(): HTMLElement {
    return this.root
  }

  openFor(a: Aircraft, at: { readonly x: number; readonly y: number }): void {
    // A different aircraft starts at the top level; the same one re-opened
    // does too, because the menu is a menu and not a mode.
    this.aircraft = a
    this.page = 'root'
    this.root.hidden = false
    this.paint()
    this.place(at)
  }

  /**
   * Keeps the menu honest while it is open: the aircraft is still flying,
   * so the readout moves with it, and if it has left the sector there is
   * nothing left to instruct.
   */
  sync(traffic: readonly Aircraft[]): void {
    if (!this.isOpen || this.aircraft === null) return
    const still = traffic.find((t) => t.callsign === this.aircraft?.callsign)
    if (!still) {
      this.close()
      return
    }
    this.aircraft = still
    const readout = tagReadout(still)
    if (this.readoutEl.textContent !== readout) this.readoutEl.textContent = readout
  }

  close(): void {
    this.root.hidden = true
    this.aircraft = null
  }

  /**
   * Opens away from an edge rather than off it. Flipping about the cursor
   * rather than sliding along the edge keeps the pointer at a corner of
   * the panel, so it is never already resting on a button when the menu
   * appears -- which is how a right-click turns into an accidental
   * clearance.
   */
  private place(at: { readonly x: number; readonly y: number }): void {
    const box = this.opts.mount.getBoundingClientRect()
    const w = this.root.offsetWidth || WIDTH_PX
    const h = this.root.offsetHeight || HEIGHT_FALLBACK_PX
    let x = at.x - box.left
    let y = at.y - box.top
    if (x + w > box.width - EDGE_PX) x = Math.max(EDGE_PX, x - w)
    if (y + h > box.height - EDGE_PX) y = Math.max(EDGE_PX, y - h)
    this.root.style.left = `${Math.round(x)}px`
    this.root.style.top = `${Math.round(y)}px`
  }

  private paint(): void {
    const a = this.aircraft
    if (a === null) return
    this.titleEl.textContent = `${a.callsign}${isHeavy(a.wake) ? ` ${a.wake}` : ''}  ${a.type}`
    this.readoutEl.textContent = tagReadout(a)
    this.bodyEl.replaceChildren(...this.content(a))
  }

  private content(a: Aircraft): readonly HTMLElement[] {
    switch (this.page) {
      case 'root':
        return [
          ...ROOT_ITEMS.map((item) => this.row(item.label, () => this.go(item.page), true)),
          this.row('HANDOFF', () => this.issue({ kind: 'handoff', callsign: a.callsign })),
        ]

      case 'heading':
        return [
          this.back(),
          // The nudges first: they are the instruction that gets used.
          this.grid(
            6,
            relativeTurns(a.hdg).map((t) =>
              this.key(t.label, () => this.issue({ kind: 'heading', callsign: a.callsign, deg: t.deg })),
            ),
          ),
          this.rule(),
          this.grid(
            6,
            headingChoices().map((deg) =>
              this.key(headingLabel(deg), () =>
                this.issue({ kind: 'heading', callsign: a.callsign, deg }),
              ),
            ),
          ),
        ]

      case 'altitude':
        return [
          this.back(),
          this.grid(
            3,
            altitudeChoices(this.opts.limits).map((ft) =>
              this.key(altitudeLabel(ft), () =>
                this.issue({ kind: 'altitude', callsign: a.callsign, ft }),
              ),
            ),
          ),
        ]

      case 'speed':
        return [
          this.back(),
          this.grid(
            3,
            speedChoices(a, this.opts.limits, this.opts.envelopeFor(a.type)).map((kts) =>
              this.key(String(kts), () =>
                this.issue({ kind: 'speed', callsign: a.callsign, kts }),
              ),
            ),
          ),
        ]

      case 'approach':
        return [
          this.back(),
          ...this.opts.runways.map((runway) =>
            this.row(`ILS ${runway}`, () =>
              this.issue({ kind: 'approach', callsign: a.callsign, runway }),
            ),
          ),
        ]

      case 'hold':
        return [
          this.back(),
          ...this.opts.holdFixes.map((fix) =>
            this.row(fix, () => this.issue({ kind: 'hold', callsign: a.callsign, fix })),
          ),
        ]
    }
  }

  private go(page: TagPage): void {
    this.page = page
    this.paint()
  }

  private issue(command: Command): void {
    this.opts.onCommand(command)
    this.close()
  }

  private back(): HTMLButtonElement {
    const b = this.row('BACK', () => this.go('root'))
    b.classList.add('tagmenu-back')
    return b
  }

  private rule(): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'tagmenu-rule'
    return el
  }

  private row(label: string, onClick: () => void, more = false): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'tagmenu-row'
    const text = document.createElement('span')
    text.textContent = label
    b.appendChild(text)
    if (more) {
      const chevron = document.createElement('span')
      chevron.className = 'tagmenu-more'
      chevron.textContent = '>'
      b.appendChild(chevron)
    }
    b.addEventListener('click', onClick)
    return b
  }

  private key(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'tagmenu-key'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  private grid(cols: number, keys: readonly HTMLElement[]): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'tagmenu-grid'
    el.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    el.append(...keys)
    return el
  }
}
