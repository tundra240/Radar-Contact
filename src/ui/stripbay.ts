import type { Command, CommandSink } from '../commands/types'
import {
  isHeavy,
  modeC,
  statusText,
  stripOrder,
  trendOf,
  type Aircraft,
} from '../sim/types'

/**
 * The flight progress strip bay.
 *
 * One strip per aircraft under control, kept in step with the simulation by
 * `update()`. The simulation does not exist yet, which is the point: the
 * bay reads a snapshot of `Aircraft` records and emits `Command` objects,
 * so Day 1 supplies real aircraft and Day 2 points the sink at
 * commands/apply.ts without this file changing.
 *
 * Two things it deliberately does not do: hold state of its own (the world
 * is the single source of truth, so a strip is a view), and rebuild itself
 * on every tick. Rows are keyed by callsign and each field is compared
 * before it is written, because at a 5 Hz refresh a naive rebuild would
 * throw away focus, selection and scroll position several times a second.
 */

export interface StripBayOptions {
  readonly mount: HTMLElement
  readonly onCommand: CommandSink
  readonly onSelect: (callsign: string | null) => void
  /** Quick-button target altitude, from the sector's intercept altitude. */
  readonly quickDescendFt: number
  /** Quick-button target speed, for the closing stages of an approach. */
  readonly quickSpeedKts: number
  /** Runway offered by CLEARED ILS when the aircraft has none assigned. */
  readonly defaultRunway: string
  /** Called after the bay changes width, so the scope can be re-measured. */
  readonly onLayoutChange?: () => void
  /**
   * Marks the bay as showing placeholder traffic. Set while the roster is
   * static, so a frozen picture is never mistaken for a running sim.
   */
  readonly demo?: boolean
}

/** Trend arrows, written as escapes so this file stays ASCII. */
const TREND_MARK: Record<string, string> = {
  climb: String.fromCharCode(0x2191),
  descend: String.fromCharCode(0x2193),
  level: '=',
}

interface Rendered {
  head: string
  alt: string
  spd: string
  hdg: string
  status: string
  mode: string
}

interface Row {
  readonly el: HTMLLIElement
  readonly head: HTMLElement
  readonly alt: HTMLElement
  readonly spd: HTMLElement
  readonly hdg: HTMLElement
  readonly status: HTMLElement
  readonly approachBtn: HTMLButtonElement
  rendered: Rendered
  selected: boolean
}

export class StripBay {
  private readonly opts: StripBayOptions
  private readonly root: HTMLElement
  private readonly list: HTMLUListElement
  private readonly counter: HTMLElement
  private readonly empty: HTMLElement
  private readonly collapseButton: HTMLButtonElement

  private readonly rows = new Map<string, Row>()
  /** Last known approach clearance per callsign, for the quick button. */
  private readonly approachByCallsign = new Map<string, string>()
  private isCollapsed = false
  private selectedCallsign: string | null = null

  constructor(opts: StripBayOptions) {
    this.opts = opts

    this.root = document.createElement('aside')
    this.root.className = 'strip-bay'

    const title = document.createElement('div')
    title.className = 'strip-bay-title'

    const caption = document.createElement('span')
    caption.textContent = 'Flight progress strips'
    title.appendChild(caption)

    if (opts.demo === true) {
      const badge = document.createElement('span')
      badge.className = 'strip-badge'
      badge.textContent = 'DEMO'
      badge.title = 'Static placeholder traffic. No simulation is running yet.'
      title.appendChild(badge)
    }

    this.collapseButton = document.createElement('button')
    this.collapseButton.type = 'button'
    this.collapseButton.className = 'strip-collapse'
    this.collapseButton.addEventListener('click', () => {
      this.setCollapsed(!this.isCollapsed)
    })
    title.appendChild(this.collapseButton)
    this.root.appendChild(title)

    this.counter = document.createElement('div')
    this.counter.className = 'strip-count'
    this.root.appendChild(this.counter)

    this.list = document.createElement('ul')
    this.list.className = 'strip-list'
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', 'Flight progress strips')
    this.root.appendChild(this.list)

    this.empty = document.createElement('p')
    this.empty.className = 'strip-empty'
    // Says why it is empty rather than looking broken. The wording goes
    // away on its own once the spawner exists.
    this.empty.textContent = 'No active traffic. Awaiting the arrival spawner.'
    this.root.appendChild(this.empty)

    opts.mount.appendChild(this.root)
    this.paintCollapse()
    this.update([], null)
  }

  get element(): HTMLElement {
    return this.root
  }

  get collapsed(): boolean {
    return this.isCollapsed
  }

  setCollapsed(collapsed: boolean): void {
    this.isCollapsed = collapsed
    this.paintCollapse()
    this.opts.onLayoutChange?.()
  }

  private paintCollapse(): void {
    this.root.classList.toggle('is-collapsed', this.isCollapsed)
    this.collapseButton.textContent = this.isCollapsed ? '>>' : '<<'
    this.collapseButton.title = this.isCollapsed ? 'Show the strip bay' : 'Hide the strip bay'
    this.collapseButton.setAttribute('aria-expanded', String(!this.isCollapsed))
  }

  /**
   * Bring the bay into line with a snapshot of the world.
   *
   * Called at a low rate rather than every simulation tick: 5 Hz is far
   * beyond what a controller can read and far below what would make the
   * DOM work noticeable. Rows are keyed by callsign, fields are compared
   * before they are written, and rows are only moved when the running
   * order has actually changed.
   */
  update(aircraft: readonly Aircraft[], selected: string | null): void {
    this.selectedCallsign = selected

    const ordered = [...aircraft].sort(
      (a, b) => stripOrder(a) - stripOrder(b) || a.callsign.localeCompare(b.callsign),
    )

    const present = new Set<string>()
    for (const a of ordered) {
      present.add(a.callsign)
      const row = this.rows.get(a.callsign) ?? this.buildRow(a.callsign)
      this.renderRow(row, a)
    }

    for (const [callsign, row] of [...this.rows]) {
      if (!present.has(callsign)) {
        row.el.remove()
        this.rows.delete(callsign)
        this.approachByCallsign.delete(callsign)
      }
    }

    this.reorder(ordered)

    const count = ordered.length
    const label = `${count} ACTIVE`
    if (this.counter.textContent !== label) this.counter.textContent = label
    // Guarded rather than assigned: setting an attribute to the value it
    // already has still counts as a DOM mutation, and an idle tick should
    // touch nothing at all.
    const showList = count > 0
    if (this.empty.hidden !== showList) this.empty.hidden = showList
    if (this.list.hidden === showList) this.list.hidden = !showList
  }

  /** Moves only the rows that are out of place. */
  private reorder(ordered: readonly Aircraft[]): void {
    let expected: Element | null = this.list.firstElementChild
    for (const a of ordered) {
      const row = this.rows.get(a.callsign)
      if (!row) continue
      if (row.el === expected) {
        expected = expected.nextElementSibling
      } else {
        this.list.insertBefore(row.el, expected)
      }
    }
  }

  private buildRow(callsign: string): Row {
    const el = document.createElement('li')
    el.className = 'strip'
    el.dataset['callsign'] = callsign
    el.setAttribute('role', 'option')
    el.tabIndex = 0

    const head = document.createElement('div')
    head.className = 'strip-head'

    const body = document.createElement('div')
    body.className = 'strip-body'
    const alt = document.createElement('span')
    alt.className = 'strip-alt'
    const spd = document.createElement('span')
    spd.className = 'strip-spd'
    const hdg = document.createElement('span')
    hdg.className = 'strip-hdg'
    body.append(alt, hdg, spd)

    const status = document.createElement('div')
    status.className = 'strip-status'

    const actions = document.createElement('div')
    actions.className = 'strip-actions'
    const descend = this.quickButton(`DES ${this.opts.quickDescendFt}`, () => ({
      kind: 'altitude',
      callsign,
      ft: this.opts.quickDescendFt,
    }))
    const slow = this.quickButton(`SPD ${this.opts.quickSpeedKts}`, () => ({
      kind: 'speed',
      callsign,
      kts: this.opts.quickSpeedKts,
    }))
    const approachBtn = this.quickButton('CLEARED ILS', () => ({
      kind: 'approach',
      callsign,
      runway: this.runwayFor(callsign),
    }))
    actions.append(descend, slow, approachBtn)

    el.append(head, body, status, actions)

    // Selecting a strip is how the corresponding radar target gets picked
    // up, so the handler is on the row rather than a dedicated control.
    el.addEventListener('click', () => this.opts.onSelect(callsign))
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.opts.onSelect(callsign)
      }
    })

    const row: Row = {
      el,
      head,
      alt,
      spd,
      hdg,
      status,
      approachBtn,
      rendered: { head: '', alt: '', spd: '', hdg: '', status: '', mode: '' },
      selected: false,
    }
    this.rows.set(callsign, row)
    this.list.appendChild(el)
    return row
  }

  private quickButton(label: string, build: () => Command): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'strip-action'
    b.textContent = label
    b.addEventListener('click', (e: MouseEvent) => {
      // Otherwise issuing a clearance would also re-select the strip.
      e.stopPropagation()
      this.opts.onCommand(build())
    })
    return b
  }

  /** An assigned approach wins; otherwise offer the active runway. */
  private runwayFor(callsign: string): string {
    return this.approachByCallsign.get(callsign) ?? this.opts.defaultRunway
  }

  private renderRow(row: Row, a: Aircraft): void {
    this.approachByCallsign.set(a.callsign, a.clearedApproach ?? this.opts.defaultRunway)

    const heavy = isHeavy(a.wake) ? ` ${a.wake}` : ''
    const trend = TREND_MARK[trendOf(a.vsFpm)] ?? '='
    const hdgNow = String(Math.round(a.hdg)).padStart(3, '0')
    const next: Rendered = {
      head: `${a.callsign}${heavy}  ${a.type}`,
      alt: `${modeC(a.altFt)} ${trend} ${modeC(a.clearedAltFt)}`,
      spd: `SPD ${Math.round(a.gsKts)}/${Math.round(a.clearedSpdKts)}`,
      hdg:
        a.clearedHdg === null
          ? `HDG ${hdgNow}`
          : `HDG ${hdgNow}/${String(Math.round(a.clearedHdg)).padStart(3, '0')}`,
      status: statusText(a),
      mode: a.navMode,
    }

    // Field by field: at 5 Hz a wholesale rewrite would be visible work for
    // no reason, and would fight text selection.
    if (next.head !== row.rendered.head) row.head.textContent = next.head
    if (next.alt !== row.rendered.alt) row.alt.textContent = next.alt
    if (next.spd !== row.rendered.spd) row.spd.textContent = next.spd
    if (next.hdg !== row.rendered.hdg) row.hdg.textContent = next.hdg
    if (next.status !== row.rendered.status) row.status.textContent = next.status
    if (next.mode !== row.rendered.mode) {
      row.el.dataset['mode'] = next.mode
      // Once an approach clearance is out there is nothing left to clear.
      row.approachBtn.disabled =
        a.navMode === 'LOC_ARMED' ||
        a.navMode === 'LOC_CAPTURED' ||
        a.navMode === 'GS_TRACKING' ||
        a.navMode === 'LANDED' ||
        a.navMode === 'HANDOFF'
    }
    row.rendered = next

    const selected = this.selectedCallsign === a.callsign
    if (selected !== row.selected) {
      row.selected = selected
      row.el.classList.toggle('is-selected', selected)
      row.el.setAttribute('aria-selected', String(selected))
    }
  }
}
