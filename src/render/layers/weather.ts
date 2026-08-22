import type { Camera } from '../../core/camera'
import { advance, distanceNM, type Vec2NM } from '../../core/geo'
import {
  cellCentreNM,
  cellRadiusNM,
  contourFraction,
  type Intensity,
  type Weather,
  type WeatherCell,
} from '../../sim/weather'
import { theme } from '../theme'

/**
 * Precipitation on the scope.
 *
 * Three nested contours per cell -- light, moderate, heavy -- drawn from
 * the outside in, so the worst of it ends up on top and the overlaps read
 * as denser rather than as a muddle. A cell that never gets bad enough for
 * a band simply has no contour for it, which is why a shower is a single
 * green blob and a storm is three rings.
 *
 * Drawn under the map symbology and the traffic, the way a real scope
 * underlays it: weather you cannot see the traffic through is weather that
 * has taken the display away from you.
 */

/** Degrees between points on a contour. Five is smooth at any useful zoom. */
const STEP_DEG = 5

/** Outermost first, so heavy is drawn last and reads as the core. */
const BANDS: readonly Intensity[] = ['light', 'moderate', 'heavy']

/** How solid each band is painted. They nest, so these accumulate. */
const FILL_ALPHA: Record<Intensity, number> = {
  light: 0.2,
  moderate: 0.24,
  heavy: 0.3,
}

const colourFor = (band: Intensity): string =>
  band === 'heavy' ? theme.wxHeavy : band === 'moderate' ? theme.wxModerate : theme.wxLight

export function drawWeather(
  g: CanvasRenderingContext2D,
  cam: Camera,
  weather: Weather,
  elapsedSeconds: number,
): void {
  const reach = cam.visibleRadiusNM()

  for (const cell of weather.cells) {
    const centre = cellCentreNM(cell, weather, elapsedSeconds)
    // Nothing to draw for a cell that has drifted off the display. Cheap,
    // and at a low zoom most of them have.
    if (distanceNM(cam.centre, centre) > reach + cell.radiusNM * 2) continue

    for (const band of BANDS) {
      const fraction = contourFraction(cell, band)
      if (fraction === null) continue
      drawContour(g, cam, cell, centre, fraction, band)
    }
  }

  // Set back rather than saved and restored: everything after this is drawn
  // at full strength, and a leaked alpha would wash out the whole picture.
  g.globalAlpha = 1
}

function drawContour(
  g: CanvasRenderingContext2D,
  cam: Camera,
  cell: WeatherCell,
  centre: Vec2NM,
  fraction: number,
  band: Intensity,
): void {
  g.beginPath()
  for (let deg = 0; deg < 360; deg += STEP_DEG) {
    const at = advance(centre, deg, cellRadiusNM(cell, deg) * fraction)
    const p = cam.worldToScreen(at)
    if (deg === 0) g.moveTo(p.x, p.y)
    else g.lineTo(p.x, p.y)
  }
  g.closePath()

  const colour = colourFor(band)
  g.globalAlpha = FILL_ALPHA[band]
  g.fillStyle = colour
  g.fill()

  // A stroked edge as well as a fill: the contour is the thing a controller
  // reads a band off, and a fill alone leaves it vague at the boundary.
  g.globalAlpha = 1
  g.strokeStyle = colour
  g.lineWidth = band === 'heavy' ? 1.3 : 1
  g.stroke()
}
