/*
 * Turning raw geographic line work into paths a scope can draw.
 *
 * Clip to a box, simplify, break into spatially compact chunks. Every
 * source of map line work needs exactly this and needs it done the same
 * way, so it lives once rather than once per field.
 *
 * Everything here is parameterised on the field: the projection is flat and
 * centred on the aerodrome reference point, which is fine over a few
 * hundred miles and wrong over a continent, so the same coastline prepared
 * for Nice and for Barcelona is not the same numbers.
 *
 * The numbers in DEFAULTS are the ones the Heathrow map was built with.
 * tools/build-geography.mjs and tools/build-field-map.mjs both run through
 * here, and the Heathrow coastline committed in egll.json is reproduced
 * exactly by the current code -- there is a test that says so.
 */
import fs from 'node:fs'

export const DEFAULTS = {
  /** How far a simplified line may sit from the real one. */
  toleranceNM: 0.1,
  /** Below this, a fragment is a speck and is dropped. */
  minPathNM: 1.5,
  /** Decimal places kept in the emitted coordinates. */
  decimals: 4,
  /** Longest straight run before colinear points are added, for chunking. */
  maxSegmentNM: 8,
  /** Biggest span a chunk's bounding box may have. */
  maxChunkNM: 12,
  maxChunkPoints: 80,
}

/**
 * A set of line tools bound to one field.
 *
 * @param arp {{lat: number, lon: number}} aerodrome reference point
 * @param box {{minLat,maxLat,minLon,maxLon}} what to keep
 */
export function lineWorks({ arp, box, ...opts }) {
  const o = { ...DEFAULTS, ...opts }
  const D2R = Math.PI / 180
  const kx = 60 * Math.cos(arp.lat * D2R) // NM per degree of longitude
  const ky = 60 // NM per degree of latitude

  const toNM = ([lon, lat]) => [(lon - arp.lon) * kx, (lat - arp.lat) * ky]

  /* ----------------------------------------------------------- clipping */

  /** Liang-Barsky: the portion of a-b inside the box, or null. */
  function clipSegment(a, b) {
    let t0 = 0
    let t1 = 1
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]

    const edges = [
      [-dx, a[0] - box.minLon],
      [dx, box.maxLon - a[0]],
      [-dy, a[1] - box.minLat],
      [dy, box.maxLat - a[1]],
    ]

    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return null
        continue
      }
      const r = q / p
      if (p < 0) {
        if (r > t1) return null
        if (r > t0) t0 = r
      } else {
        if (r < t0) return null
        if (r < t1) t1 = r
      }
    }

    return [
      [a[0] + t0 * dx, a[1] + t0 * dy],
      [a[0] + t1 * dx, a[1] + t1 * dy],
    ]
  }

  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

  /** Splits a polyline into the contiguous runs that fall inside the box. */
  function clipPath(points) {
    const runs = []
    let current = null

    for (let i = 0; i < points.length - 1; i += 1) {
      const seg = clipSegment(points[i], points[i + 1])
      if (!seg) {
        current = null
        continue
      }
      const [s, e] = seg
      if (current && near(current[current.length - 1], s)) {
        current.push(e)
      } else {
        current = [s, e]
        runs.push(current)
      }
    }
    return runs
  }

  /* -------------------------------------------------------- simplifying */

  function perpNM(p, a, b) {
    const [px, py] = toNM(p)
    const [ax, ay] = toNM(a)
    const [bx, by] = toNM(b)
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    if (len2 === 0) return Math.hypot(px - ax, py - ay)
    let t = ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }

  /** Douglas-Peucker, iterative so a long coastline cannot blow the stack. */
  function simplify(points, tolNM) {
    if (points.length < 3) return points
    const keep = new Array(points.length).fill(false)
    keep[0] = true
    keep[points.length - 1] = true
    const stack = [[0, points.length - 1]]

    while (stack.length > 0) {
      const [lo, hi] = stack.pop()
      let worst = 0
      let at = -1
      for (let i = lo + 1; i < hi; i += 1) {
        const d = perpNM(points[i], points[lo], points[hi])
        if (d > worst) {
          worst = d
          at = i
        }
      }
      if (at >= 0 && worst > tolNM) {
        keep[at] = true
        stack.push([lo, at], [at, hi])
      }
    }
    return points.filter((_, i) => keep[i])
  }

  function lengthNM(points) {
    let total = 0
    for (let i = 0; i < points.length - 1; i += 1) {
      const [ax, ay] = toNM(points[i])
      const [bx, by] = toNM(points[i + 1])
      total += Math.hypot(bx - ax, by - ay)
    }
    return total
  }

  /*
   * Adds colinear points along any segment longer than maxSegNM.
   *
   * Purely so chunking has somewhere to cut: a FIR boundary is published as
   * a handful of very long straight legs, and a two-point chunk spanning
   * 136 NM has a bounding box that contains the field, which defeats the
   * renderer's cull. The drawn line is identical -- the extra points are on
   * it.
   */
  function densify(points, maxSegNM) {
    const out = [points[0]]
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]
      const b = points[i]
      const [ax, ay] = toNM(a)
      const [bx, by] = toNM(b)
      const d = Math.hypot(bx - ax, by - ay)
      const steps = Math.ceil(d / maxSegNM)
      for (let k = 1; k < steps; k += 1) {
        out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps])
      }
      out.push(b)
    }
    return out
  }

  /*
   * Splits a long polyline into spatially compact chunks.
   *
   * The renderer culls a whole path on its bounding box, and one path
   * running from the Bristol Channel round the south coast to East Anglia
   * has a box that contains Heathrow -- so it would never be culled,
   * however far the scope is zoomed in. Chunking keeps the boxes tight
   * enough for the test to mean something. Chunks share their joining point
   * so the line stays continuous across the split.
   */
  function chunk(points) {
    if (points.length <= 2) return [points]
    const out = []
    let current = [points[0]]
    let minX = points[0][0]
    let maxX = points[0][0]
    let minY = points[0][1]
    let maxY = points[0][1]

    for (let i = 1; i < points.length; i += 1) {
      const p = points[i]
      const nx0 = Math.min(minX, p[0])
      const nx1 = Math.max(maxX, p[0])
      const ny0 = Math.min(minY, p[1])
      const ny1 = Math.max(maxY, p[1])
      const wouldSpan = Math.max((nx1 - nx0) * kx, (ny1 - ny0) * ky)

      if (
        current.length >= 2 &&
        (wouldSpan > o.maxChunkNM || current.length >= o.maxChunkPoints)
      ) {
        out.push(current)
        // Start the next chunk at the last point of this one, so no gap.
        const last = current[current.length - 1]
        current = [last, p]
        minX = Math.min(last[0], p[0])
        maxX = Math.max(last[0], p[0])
        minY = Math.min(last[1], p[1])
        maxY = Math.max(last[1], p[1])
        continue
      }

      current.push(p)
      minX = nx0
      maxX = nx1
      minY = ny0
      maxY = ny1
    }
    if (current.length >= 2) out.push(current)
    return out
  }

  /* -------------------------------------------------------------- output */

  const round = (v) => Number(v.toFixed(o.decimals))
  const asObjects = (points) =>
    points.map(([lon, lat, w]) =>
      w === undefined
        ? { lat: round(lat), lon: round(lon) }
        : { lat: round(lat), lon: round(lon), w: Math.round(w) },
    )

  /** Clip, simplify, drop the specks, chunk. */
  function prepare(rawPaths) {
    const out = []
    for (const path of rawPaths) {
      for (const run of clipPath(path)) {
        const simplified = simplify(run, o.toleranceNM)
        if (simplified.length < 2) continue
        if (lengthNM(simplified) < o.minPathNM) continue
        out.push(...chunk(densify(simplified, o.maxSegmentNM)))
      }
    }
    return out
  }

  /** Every line in a GeoJSON of line work, prepared for this field. */
  function coastline(file) {
    const gj = JSON.parse(fs.readFileSync(file, 'utf8'))
    const raw = []
    for (const f of gj.features) {
      const geom = f.geometry
      if (!geom) continue
      if (geom.type === 'LineString') raw.push(geom.coordinates)
      else if (geom.type === 'MultiLineString') raw.push(...geom.coordinates)
    }
    return prepare(raw)
  }

  return {
    toNM,
    kx,
    ky,
    clipPath,
    simplify,
    lengthNM,
    densify,
    chunk,
    round,
    asObjects,
    prepare,
    coastline,
  }
}
