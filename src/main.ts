import './style.css'

/**
 * Scaffold entry point.
 *
 * This does the one thing the scaffold needs to prove: a DPR-aware canvas
 * that fills the viewport and survives resize. Everything else -- the
 * camera transform, the fixed-timestep loop, the world model, the render
 * layers -- arrives in Day 0 and Day 1 per ARCHITECTURE.md. Deliberately
 * no game logic here yet.
 */

/**
 * Everything past the null checks lives in here, so the non-null types
 * arrive as parameters rather than as assertions at each use site.
 */
function start(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
): void {
  /**
   * Size the backing store to device pixels while keeping the CSS box in
   * layout pixels, so lines stay crisp on high-DPI displays. Day 0 moves
   * this into core/camera.ts, which will own the world->screen transform.
   */
  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = host.clientWidth
    const h = host.clientHeight

    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)

    // setTransform rather than scale: assigning width/height above already
    // reset the context state, so scale would compound across resizes.
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(w, h)
  }

  function draw(w: number, h: number): void {
    // Placeholder only. Real drawing is render/radar.ts plus the layer
    // modules; colours will come from render/theme.ts.
    g.fillStyle = '#0a0e14'
    g.fillRect(0, 0, w, h)

    g.font = '14px ui-monospace, Consolas, monospace'
    g.textAlign = 'center'

    g.fillStyle = '#00e5ff'
    g.fillText('RADAR CONTACT -- EGLL APPROACH', w / 2, h / 2 - 10)

    g.fillStyle = '#5a6b7c'
    g.fillText(`scaffold ready -- ${w} x ${h}`, w / 2, h / 2 + 14)
  }

  window.addEventListener('resize', resize)
  resize()
}

const host = document.querySelector<HTMLDivElement>('#app')
if (!host) throw new Error('#app not found in index.html')

const canvas = document.createElement('canvas')
host.appendChild(canvas)

const g = canvas.getContext('2d')
if (!g) throw new Error('2D canvas context unavailable')

start(host, canvas, g)
