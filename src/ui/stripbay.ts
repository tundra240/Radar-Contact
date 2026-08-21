import { isHeavy, modeC, statusText, trendOf, type Aircraft } from '../sim/types'
import {
  buildSequence,
  isTight,
  sequenceOrder,
  type SequencedFlight,
  type StackedFlight,
} from '../sim/sequence'

/**
 * The flight progress strip bay.
 *
 * One strip per aircraft under control, kept in step with the simulation by
 * `update()`. A strip is a view and nothing more: it holds no state of its
 * own, because the world is the single source of truth, and it issues no
 * clearances of its own either. Right-clicking a strip opens the same tag
 * menu as right-clicking the target on the scope, which is where every
 * instruction now comes from -- three fixed quick-buttons per strip could
 * only ever offer three of the clearances a controller needs, at values
 * somebody had to guess in advance.
 *
 * What a strip shows is deliberately **not** what the data block on the
 * scope shows. The radar picture already says where an aircraft is, what
 * level it is passing and how fast; repeating that on a strip is why the
 * bay used to be worth nothing. A strip carries what the scope cannot: the
 * order the traffic is going to land in, how far each one still has to run,
 * and whether the gap to the aircraft in front is legal for that pair of
 * wake categories. See sim/sequence.ts.
 *
 * The other thing it deliberately does not do is rebuild itself on every
 * tick. Rows are keyed by callsign and each field is compared
 * before it is written, because at a 5 Hz refresh a naive rebuild would
 * throw away focus, selection and scroll position several times a second.
 */

export interface StripBayOptions {
  readonly mount: HTMLElement
  readonly onSelect: (callsign: string | null) => void
  /** Right-click: opens the tag menu for this strip's aircraft. */
  readonly onContextMenu: (callsign: string, at: { readonly x: number; readonly y: number }) => void
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
  seq: string
  head: string
  alt: string
  spd: string
  hdg: string
  fld: string
  gap: string
  tight: boolean
  status: string
  mode: string
}

interface Row {
  readonly el: HTMLLIElement
  readonly seq: HTMLElement
  readonly head: HTMLElement
  readonly alt: HTMLElement
  readonly spd: HTMLElement
  readonly hdg: HTMLElement
  readonly fld: HTMLElement
  readonly gap: HTMLElement
  readonly status: HTMLElement
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
    // Says why it is empty rather than looking broken.
    this.empty.textContent = 'Nothing on frequency. The first arrival is on its way.'
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

    // The bay's order IS the sequence: nearest the field first, then the
    // stack underneath it. Ordering strips by anything else is what made
    // them a second copy of the scope.
    const built = buildSequence(aircraft)
    const ordered = sequenceOrder(built)
    const entries = new Map<string, SequencedFlight | StackedFlight>()
    for (const f of built.sequence) entries.set(f.aircraft.callsign, f)
    for (const f of built.stack) entries.set(f.aircraft.callsign, f)
    for (const f of built.inbound) entries.set(f.aircraft.callsign, f)

    const present = new Set<string>()
    for (const a of ordered) {
      present.add(a.callsign)
      const row = this.rows.get(a.callsign) ?? this.buildRow(a.callsign)
      this.renderRow(row, a, entries.get(a.callsign))
    }

    for (const [callsign, row] of [...this.rows]) {
      if (!present.has(callsign)) {
        row.el.remove()
        this.rows.delete(callsign)
      }
    }

    this.reorder(ordered)

    const count = ordered.length
    // All three, because what is parked and what is on its way are as much
    // of the picture as what is being worked.
    const label =
      `${built.sequence.length} SEQ / ${built.stack.length} HOLD` +
      `${built.inbound.length > 0 ? ` / ${built.inbound.length} IN` : ''}`
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

    // The sequence number, in the margin where a controller would write it.
    const seq = document.createElement('span')
    seq.className = 'strip-seq'

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

    // What the scope cannot tell you: distance still to run, and the gap
    // to the aircraft in front against what that pair needs.
    const spacing = document.createElement('div')
    spacing.className = 'strip-spacing'
    const fld = document.createElement('span')
    fld.className = 'strip-fld'
    const gap = document.createElement('span')
    gap.className = 'strip-gap'
    spacing.append(fld, gap)

    const status = document.createElement('div')
    status.className = 'strip-status'

    el.append(seq, head, body, spacing, status)

    // Selecting a strip is how the corresponding radar target gets picked
    // up, so the handler is on the row rather than a dedicated control.
    el.addEventListener('click', () => this.opts.onSelect(callsign))
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.opts.onSelect(callsign)
        return
      }
      // The platform's own keyboard route to a context menu, so the strips
      // stay usable without a mouse.
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        const box = el.getBoundingClientRect()
        this.opts.onContextMenu(callsign, { x: box.left + 12, y: box.top + 12 })
      }
    })

    // Right-click: the clearances for this aircraft, at the cursor. The
    // browser's own menu would otherwise open on top of them.
    el.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault()
      this.opts.onContextMenu(callsign, { x: e.clientX, y: e.clientY })
    })

    const row: Row = {
      el,
      seq,
      head,
      alt,
      spd,
      hdg,
      fld,
      gap,
      status,
      rendered: {
        seq: '',
        head: '',
        alt: '',
        spd: '',
        hdg: '',
        fld: '',
        gap: '',
        tight: false,
        status: '',
        mode: '',
      },
      selected: false,
    }
    this.rows.set(callsign, row)
    this.list.appendChild(el)
    return row
  }

  private renderRow(
    row: Row,
    a: Aircraft,
    entry: SequencedFlight | StackedFlight | undefined,
  ): void {
    const inSequence = entry !== undefined && 'position' in entry
    const heavy = isHeavy(a.wake) ? ` ${a.wake}` : ''
    const trend = TREND_MARK[trendOf(a.vsFpm)] ?? '='
    const hdgNow = String(Math.round(a.hdg)).padStart(3, '0')
    const flight = inSequence ? (entry as SequencedFlight) : null
    const next: Rendered = {
      // The sequence number, or a dash for traffic that is not in the
      // sequence yet because it is still in the stack.
      seq: flight === null ? '--' : String(flight.position),
      head: `${a.callsign}${heavy}  ${a.type}`,
      alt: `${modeC(a.altFt)} ${trend} ${modeC(a.clearedAltFt)}`,
      spd: `SPD ${Math.round(a.gsKts)}/${Math.round(a.clearedSpdKts)}`,
      hdg:
        a.clearedHdg === null
          ? `HDG ${hdgNow}`
          : `HDG ${hdgNow}/${String(Math.round(a.clearedHdg)).padStart(3, '0')}`,
      fld: entry === undefined ? 'FLD --' : `FLD ${entry.toFieldNM.toFixed(1)}`,
      gap:
        flight === null
          ? // Not the controller's yet, so it is neither sequenced nor
            // parked: it is on its way.
            a.entered
            ? 'IN STACK'
            : 'INBOUND'
          : flight.gapNM === null || flight.requiredNM === null
            ? // Nobody to follow. Said outright rather than left blank, so an
              // empty gap never reads as a gap of zero.
              'NO 1'
            : `GAP ${flight.gapNM.toFixed(1)}/${flight.requiredNM}`,
      tight: flight !== null && isTight(flight),
      status: statusText(a),
      mode: a.navMode,
    }

    // Field by field: at 5 Hz a wholesale rewrite would be visible work for
    // no reason, and would fight text selection.
    if (next.seq !== row.rendered.seq) row.seq.textContent = next.seq
    if (next.head !== row.rendered.head) row.head.textContent = next.head
    if (next.alt !== row.rendered.alt) row.alt.textContent = next.alt
    if (next.spd !== row.rendered.spd) row.spd.textContent = next.spd
    if (next.hdg !== row.rendered.hdg) row.hdg.textContent = next.hdg
    if (next.fld !== row.rendered.fld) row.fld.textContent = next.fld
    if (next.gap !== row.rendered.gap) row.gap.textContent = next.gap
    if (next.tight !== row.rendered.tight) row.gap.classList.toggle('is-tight', next.tight)
    if (next.status !== row.rendered.status) row.status.textContent = next.status
    if (next.mode !== row.rendered.mode) {
      row.el.dataset['mode'] = next.mode
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
