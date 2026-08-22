import {
  TAILWIND_LIMIT_KTS,
  bestDirection,
  crosswindKts,
  directionsOf,
  headwindKts,
  letterOf,
  shouldFlip,
  windString,
  type Atis,
  type RunwayFace,
} from '../sim/atis'

/**
 * The ATIS box.
 *
 * A button on the toolbar that shows and hides a small board on the scope,
 * the way the real thing sits in the corner of a controller's position:
 * what the field is doing, always readable without opening anything, and
 * out of the way when you would rather have the picture.
 *
 * It is a box rather than a menu, so it does not dismiss itself when you
 * click on the radar. A readout that vanished the moment you touched an
 * aircraft would be a readout you could never use while working.
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
  /** Called when the box is shown or hidden, so the caller can remember it. */
  readonly onToggle?: (open: boolean) => void
  /** Whether the box starts shown. Defaults to shown. */
  readonly open?: boolean
}

/** A direction, as the box offers it. */
interface Choice {
  readonly ids: readonly string[]
  readonly label: string
  readonly bearingTrue: number
}

export class AtisBar {
  private readonly opts: AtisBarOptions
  private readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly box: HTMLDivElement
  private readonly letterLine: HTMLDivElement
  private readonly values = new Map<string, HTMLSpanElement>()
  private readonly arrivalRow: HTMLDivElement
  private readonly departureRow: HTMLDivElement
  private readonly advice: HTMLParagraphElement

  private isOpen: boolean
  private state: AtisBarState | null = null

  constructor(opts: AtisBarOptions) {
    this.opts = opts
    this.isOpen = opts.open ?? true

    this.root = document.createElement('div')
    this.root.className = 'atis'

    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'mode-toggle atis-button'
    this.button.textContent = 'ATIS'
    this.button.title = 'Show or hide the ATIS board'
    this.button.addEventListener('click', () => {
      this.setOpen(!this.isOpen)
      this.opts.onToggle?.(this.isOpen)
    })
    this.root.appendChild(this.button)

    this.box = document.createElement('div')
    this.box.className = 'atis-box'
    this.box.setAttribute('role', 'group')
    this.box.setAttribute('aria-label', 'ATIS')

    this.letterLine = document.createElement('div')
    this.letterLine.className = 'atis-letter'
    this.box.appendChild(this.letterLine)

    const readout = document.createElement('dl')
    readout.className = 'atis-readout'
    for (const key of ['ARR', 'DEP', 'WIND']) {
      const term = document.createElement('dt')
      term.textContent = key
      const value = document.createElement('dd')
      this.values.set(key, value)
      readout.append(term, value)
    }
    this.box.appendChild(readout)

    this.arrivalRow = this.section('Landing')
    this.departureRow = this.section('Departing')

    this.advice = document.createElement('p')
    this.advice.className = 'atis-advice'
    this.box.appendChild(this.advice)

    this.root.appendChild(this.box)
    opts.mount.appendChild(this.root)
    this.setOpen(this.isOpen)
  }

  private section(title: string): HTMLDivElement {
    const label = document.createElement('div')
    label.className = 'menu-section'
    label.textContent = title
    this.box.appendChild(label)
    const row = document.createElement('div')
    row.className = 'atis-row'
    this.box.appendChild(row)
    return row
  }

  destroy(): void {
    this.root.remove()
  }

  get open(): boolean {
    return this.isOpen
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.box.hidden = !open
    // Pressed in while the board is up, the same affordance as WX.
    this.button.classList.toggle('is-on', open)
    this.button.setAttribute('aria-pressed', String(open))
  }

  paint(state: AtisBarState): void {
    this.state = state
    const atis = state.atis

    this.letterLine.textContent = `INFORMATION ${letterOf(atis).toUpperCase()}`
    this.values.get('ARR')!.textContent = atis.arrivals.join(' / ') || '--'
    this.values.get('DEP')!.textContent = atis.departures.join(' / ') || '--'
    this.values.get('WIND')!.textContent = windString(atis.wind)

    const choices: Choice[] = directionsOf(state.runways).map((group) => ({
      ids: group.map((r) => r.id),
      label: group.map((r) => r.id).join('/'),
      bearingTrue: group[0]!.bearingTrue,
    }))

    this.fill(this.arrivalRow, choices, atis.arrivals, (ids) =>
      this.opts.onChange({ arrivals: ids, departures: atis.departures }),
    )
    this.fill(this.departureRow, choices, atis.departures, (ids) =>
      this.opts.onChange({ arrivals: atis.arrivals, departures: ids }),
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

      const name = document.createElement('span')
      name.className = 'atis-choice-name'
      name.textContent = choice.label
      // The wind on each face, so the choice is informed rather than a
      // guess at which way is into wind today.
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
