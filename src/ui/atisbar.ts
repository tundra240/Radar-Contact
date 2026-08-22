import {
  TAILWIND_LIMIT_KTS,
  bestDirection,
  broadcast,
  crosswindKts,
  directionsOf,
  headwindKts,
  shouldFlip,
  type Atis,
  type RunwayFace,
} from '../sim/atis'

/**
 * The ATIS: a ticker on the toolbar, and the runway selection behind it.
 *
 * The readout is the control. A separate button to change the runways would
 * put the thing you read and the thing you press in two places, when they
 * are the same subject -- so the broadcast string itself opens the panel.
 *
 * A view, in the same sense as the options menu: it holds no ATIS state,
 * reports a chosen configuration through `onChange`, and is told what to
 * display by `paint`. `main.ts` owns the broadcast.
 */

export interface AtisBarState {
  readonly atis: Atis
  /** Every runway the field has, not only the ones in use. */
  readonly runways: readonly RunwayFace[]
}

export interface AtisBarOptions {
  readonly mount: HTMLElement
  readonly onChange: (next: {
    readonly arrivals: readonly string[]
    readonly departures: readonly string[]
  }) => void
}

/** A direction, as the panel offers it. */
interface Choice {
  readonly ids: readonly string[]
  readonly label: string
  readonly bearingTrue: number
}

export class AtisBar {
  private readonly opts: AtisBarOptions
  private readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly panel: HTMLDivElement
  private readonly arrivalRow: HTMLDivElement
  private readonly departureRow: HTMLDivElement
  private readonly advice: HTMLParagraphElement

  private isOpen = false
  private state: AtisBarState | null = null

  private readonly onDocumentPointerDown: (e: PointerEvent) => void
  private readonly onDocumentKeyDown: (e: KeyboardEvent) => void

  constructor(opts: AtisBarOptions) {
    this.opts = opts

    this.root = document.createElement('div')
    this.root.className = 'atis'

    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'mode-toggle atis-button'
    this.button.title = 'Active runways, wind and information letter'
    this.button.setAttribute('aria-haspopup', 'true')
    this.button.addEventListener('click', () => this.setOpen(!this.isOpen))
    this.root.appendChild(this.button)

    this.panel = document.createElement('div')
    this.panel.className = 'menu-panel atis-panel'
    this.panel.hidden = true
    this.panel.setAttribute('role', 'group')
    this.panel.setAttribute('aria-label', 'ATIS')

    const caption = document.createElement('div')
    caption.className = 'menu-title'
    caption.textContent = 'ATIS'
    this.panel.appendChild(caption)

    this.arrivalRow = this.section('Landing')
    this.departureRow = this.section('Departing')

    this.advice = document.createElement('p')
    this.advice.className = 'atis-advice'
    this.panel.appendChild(this.advice)

    this.root.appendChild(this.panel)
    opts.mount.appendChild(this.root)

    // Same dismissal rules as the options menu: a click anywhere else, or
    // Escape. A panel that only closes by pressing the button again is a
    // panel people leave open over the radar picture.
    this.onDocumentPointerDown = (e) => {
      if (!this.isOpen) return
      if (e.target instanceof Node && this.root.contains(e.target)) return
      this.setOpen(false)
    }
    this.onDocumentKeyDown = (e) => {
      if (this.isOpen && e.key === 'Escape') this.setOpen(false)
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown)
    document.addEventListener('keydown', this.onDocumentKeyDown)
  }

  private section(title: string): HTMLDivElement {
    const label = document.createElement('div')
    label.className = 'menu-section'
    label.textContent = title
    this.panel.appendChild(label)
    const row = document.createElement('div')
    row.className = 'atis-row'
    this.panel.appendChild(row)
    return row
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown)
    document.removeEventListener('keydown', this.onDocumentKeyDown)
    this.root.remove()
  }

  private setOpen(open: boolean): void {
    this.isOpen = open
    this.panel.hidden = !open
    this.button.setAttribute('aria-expanded', String(open))
  }

  paint(state: AtisBarState): void {
    this.state = state
    this.button.textContent = broadcast(state.atis)

    const choices: Choice[] = directionsOf(state.runways).map((group) => ({
      ids: group.map((r) => r.id),
      label: group.map((r) => r.id).join('/'),
      bearingTrue: group[0]!.bearingTrue,
    }))

    this.fill(this.arrivalRow, choices, state.atis.arrivals, (ids) =>
      this.opts.onChange({ arrivals: ids, departures: state.atis.departures }),
    )
    this.fill(this.departureRow, choices, state.atis.departures, (ids) =>
      this.opts.onChange({ arrivals: state.atis.arrivals, departures: ids }),
    )

    this.paintAdvice(state, choices)
  }

  private fill(
    row: HTMLDivElement,
    choices: readonly Choice[],
    active: readonly string[],
    choose: (ids: readonly string[]) => void,
  ): void {
    row.replaceChildren()
    for (const choice of choices) {
      const wind = this.state?.atis.wind
      const head = wind ? headwindKts(choice.bearingTrue, wind) : 0
      const cross = wind ? crosswindKts(choice.bearingTrue, wind) : 0

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'atis-choice'
      // The wind on each face, so the choice is informed rather than a
      // guess at which way is into wind today.
      button.innerHTML = ''
      const name = document.createElement('span')
      name.className = 'atis-choice-name'
      name.textContent = choice.label
      const detail = document.createElement('span')
      detail.className = 'atis-choice-wind'
      detail.textContent =
        `${head >= 0 ? 'head' : 'TAIL'} ${Math.abs(head).toFixed(0)}` +
        `  cross ${cross.toFixed(0)}`
      button.append(name, detail)

      const on = choice.ids.every((id) => active.includes(id)) && active.length > 0
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
      if (head < 0) button.classList.add('is-tailwind')
      button.addEventListener('click', () => choose(choice.ids))
      row.appendChild(button)
    }
  }

  private paintAdvice(state: AtisBarState, choices: readonly Choice[]): void {
    const active = state.runways.filter((r) => state.atis.arrivals.includes(r.id))
    if (active.length === 0) {
      this.advice.textContent = 'Nothing is landing. No approach can be cleared.'
      this.advice.classList.add('is-warning')
      return
    }
    if (shouldFlip(state.atis, state.runways)) {
      const better = bestDirection(state.runways, state.atis.wind).join('/')
      const tail = -headwindKts(active[0]!.bearingTrue, state.atis.wind)
      this.advice.textContent =
        `Tailwind ${tail.toFixed(0)} kt on ${state.atis.arrivals.join('/')}` +
        ` -- over the ${TAILWIND_LIMIT_KTS} kt limit. Consider ${better}.`
      this.advice.classList.add('is-warning')
      return
    }
    const worst = Math.max(...active.map((r) => crosswindKts(r.bearingTrue, state.atis.wind)))
    this.advice.classList.remove('is-warning')
    this.advice.textContent =
      choices.length < 2
        ? `One direction available. Crosswind ${worst.toFixed(0)} kt.`
        : `Landing into wind. Crosswind ${worst.toFixed(0)} kt.`
  }
}
