import {
  TAILWIND_LIMIT_KTS,
  bestDirection,
  configurationsFor,
  crosswindKts,
  directionsOf,
  flipTo,
  headwindKts,
  letterOf,
  shouldFlip,
  windString,
  type Atis,
  type Configuration,
  type RunwayFace,
} from '../sim/atis'
import { setToolLabel } from './icons'

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
  private readonly directionRow: HTMLDivElement
  private readonly configRow: HTMLDivElement
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
    setToolLabel(this.button, 'atis', 'ATIS and runways')
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

    this.directionRow = this.section('Direction')
    this.configRow = this.section('Operation')

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

    const groups = directionsOf(state.runways)
    const choices: Choice[] = groups.map((group) => ({
      ids: group.map((r) => r.id),
      label: group.map((r) => r.id).join('/'),
      bearingTrue: group[0]!.bearingTrue,
    }))

    // Which way the field faces. Turning it round keeps the operation --
    // the same strips landing and departing, under the names they have from
    // the other end -- rather than quietly reverting to everything landing.
    this.fillDirections(choices, groups, state)

    // And what it is doing in that direction: which runway lands, or both.
    const inUse = groups.find((g) => g.some((r) => atis.arrivals.includes(r.id))) ?? []
    this.fillConfigurations(configurationsFor(inUse), atis)

    this.paintAdvice(state, choices)
  }

  /** A button per band of the panel, sharing the bevelled look. */
  private choiceButton(label: string, note: string, on: boolean): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'atis-choice'

    const name = document.createElement('span')
    name.className = 'atis-choice-name'
    name.textContent = label
    const detail = document.createElement('span')
    detail.className = 'atis-choice-wind'
    detail.textContent = note
    button.append(name, detail)

    button.classList.toggle('is-on', on)
    button.setAttribute('aria-pressed', String(on))
    return button
  }

  private fillConfigurations(configs: readonly Configuration[], atis: Atis): void {
    this.configRow.replaceChildren()
    for (const config of configs) {
      const on =
        config.arrivals.length === atis.arrivals.length &&
        config.arrivals.every((id) => atis.arrivals.includes(id)) &&
        config.departures.every((id) => atis.departures.includes(id))
      const button = this.choiceButton(config.label, config.note, on)
      button.addEventListener('click', () =>
        this.opts.onChange({ arrivals: config.arrivals, departures: config.departures }),
      )
      this.configRow.appendChild(button)
    }
  }

  private fillDirections(
    choices: readonly Choice[],
    groups: readonly (readonly RunwayFace[])[],
    state: AtisBarState,
  ): void {
    this.fill(this.directionRow, choices, state.atis.arrivals, (ids) => {
      const group = groups.find((g) => g.every((r) => ids.includes(r.id)))
      if (group === undefined) return
      this.opts.onChange(flipTo(state.atis, group, state.runways))
    })
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

      const on = choice.ids.some((id) => active.includes(id)) && active.length > 0
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
