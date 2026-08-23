/*
 * Builds the airspace for Faro, Barcelona and Nice.
 *
 * CONSTRUCTED, NOT PUBLISHED. Heathrow's sixty-one volumes come from the
 * VATSIM UK sector file and there is no equivalent open source for
 * Portugal, Spain or France, so this is the one part of those three fields'
 * maps that cannot be taken from data. Every volume it adds carries
 * derivation "approx" or "rule", which the loader turns into
 * approximate: true, and the provenance note in each file says so plainly.
 *
 * TWO THINGS ARE NOT TOUCHED. The control zone and the terminal area
 * outline are reproduced exactly as they already stood: same shape, same
 * levels, same identifiers. sim/airspace.ts derives the area of
 * responsibility from whichever controlled volumes enclose the field, so
 * redrawing those two -- even more accurately -- would move the boundary a
 * controller is working to and change where arrivals are released.
 * Everything added here is deliberately shaped so that it does NOT enclose
 * the field: annulus sectors with a hole in the middle, corridors along the
 * approach, circles round other aerodromes. Detail is worth having. It is
 * not worth quietly moving the sector under somebody.
 *
 * What the added areas say is not arbitrary either. A terminal area is not
 * a cylinder: it is a set of sub-areas whose bases sit low where traffic
 * descends and high where the ground rises. The bases follow two things
 * that are real -- the arrival direction, and the terrain contours already
 * in the same file:
 *
 *   Nice       the sea to the south is where every arrival is vectored, so
 *              the southern sectors have the lowest bases on the field; the
 *              northern ones sit above the Maritime Alps contours.
 *   Barcelona  low over the water to the south-east, stepping up over
 *              Collserola and higher again over Montserrat and Montseny.
 *   Faro       low over the bay, higher over the Algarve hinterland.
 *
 * Usage:
 *   node tools/build-airspace.mjs
 */
import fs from 'node:fs'

const D2R = Math.PI / 180

/* --------------------------------------------------------------- shapes */

// Six places, which is what the published outlines were already written
// with. At five they differ by a few centimetres, which is nothing on the
// glass and is still not "reproduced exactly".
const round = (n) => Number(n.toFixed(6))

/** A point that distance and bearing from another, in degrees. */
function offset(origin, bearingDeg, distNM) {
  const r = bearingDeg * D2R
  return {
    lat: round(origin.lat + (distNM * Math.cos(r)) / 60),
    lon: round(origin.lon + (distNM * Math.sin(r)) / (60 * Math.cos(origin.lat * D2R))),
  }
}

/** Bearings from one to another, walking clockwise. */
function arcBearings(from, to, stepDeg) {
  const span = (to - from + 360) % 360 || 360
  const steps = Math.max(2, Math.ceil(span / stepDeg))
  return Array.from({ length: steps + 1 }, (_, i) => from + (span * i) / steps)
}

/** The published outline: radials at a fixed distance, every fifteen degrees. */
function published(arp, radiusNM) {
  return arcBearings(0, 360, 15).map((b) => offset(arp, b, radiusNM))
}

/**
 * A wedge of an annulus: two radials joined by two arcs.
 *
 * The shape a terminal sub-area is actually published as -- radials from a
 * navigation aid, joined by arcs at a distance from it -- so it comes out
 * looking like a chart rather than like a range ring. It also, by
 * construction, has a hole in the middle where the field is, which is what
 * keeps it out of the area of responsibility.
 */
function wedge(arp, { from, to, inner, outer }) {
  const bearings = arcBearings(from, to, 5)
  return [
    ...bearings.map((b) => offset(arp, b, inner)),
    ...[...bearings].reverse().map((b) => offset(arp, b, outer)),
  ]
}

/**
 * A corridor along an extended centreline, widening as it goes out.
 *
 * The one added area that changes what a level means rather than only where
 * a line is: it brings the base of controlled airspace down to fifteen
 * hundred feet along the final, outside the control zone, which is what a
 * chart calls an approach CTA and what makes a long final legal.
 */
function corridor(arp, { inboundTrue, fromNM, toNM, nearHalfNM, farHalfNM }) {
  const near = offset(arp, inboundTrue, fromNM)
  const far = offset(arp, inboundTrue, toNM)
  return [
    offset(near, inboundTrue - 90, nearHalfNM),
    offset(far, inboundTrue - 90, farHalfNM),
    offset(far, inboundTrue + 90, farHalfNM),
    offset(near, inboundTrue + 90, nearHalfNM),
  ]
}

/* --------------------------------------------------------------- fields */

/**
 * `base` reproduces what was already in each file and must not be edited
 * without understanding that it moves the area of responsibility.
 *
 * In the sectors, `from`/`to` are true bearings from the field, and a
 * sector runs clockwise from one to the other.
 */
const FIELDS = {
  lpfr: {
    name: 'FARO',
    base: { tmaRadiusNM: 33, tmaFloorFt: 2500, tmaCeilingFt: 16500, ctrRadiusNM: 8 },
    corridors: [
      { id: '28', inboundTrue: 100 },
      { id: '10', inboundTrue: 280 },
    ],
    rings: [
      {
        inner: 8,
        outer: 20,
        sectors: [
          { id: 1, from: 90, to: 180, floorFt: 2500 },
          { id: 2, from: 180, to: 270, floorFt: 2500 },
          { id: 3, from: 270, to: 360, floorFt: 3500 },
          { id: 4, from: 0, to: 90, floorFt: 3500 },
        ],
      },
      {
        inner: 20,
        outer: 32,
        sectors: [
          { id: 5, from: 90, to: 270, floorFt: 4500 },
          { id: 6, from: 270, to: 90, floorFt: 5500 },
        ],
      },
    ],
  },

  lebl: {
    name: 'BARCELONA',
    base: { tmaRadiusNM: 38, tmaFloorFt: 3000, tmaCeilingFt: 19000, ctrRadiusNM: 8 },
    corridors: [
      { id: '24R', inboundTrue: 70 },
      { id: '06L', inboundTrue: 250 },
    ],
    rings: [
      {
        inner: 9,
        outer: 22,
        sectors: [
          { id: 1, from: 90, to: 180, floorFt: 3000 },
          { id: 2, from: 180, to: 270, floorFt: 3000 },
          { id: 3, from: 270, to: 360, floorFt: 4500 },
          { id: 4, from: 0, to: 90, floorFt: 3500 },
        ],
      },
      {
        inner: 22,
        outer: 37,
        sectors: [
          { id: 5, from: 90, to: 180, floorFt: 4500 },
          { id: 6, from: 180, to: 270, floorFt: 5500 },
          { id: 7, from: 270, to: 360, floorFt: 7500 },
          { id: 8, from: 0, to: 90, floorFt: 8500 },
        ],
      },
    ],
  },

  lfmn: {
    name: 'NICE',
    base: { tmaRadiusNM: 30, tmaFloorFt: 3000, tmaCeilingFt: 17500, ctrRadiusNM: 8 },
    corridors: [
      { id: '04L', inboundTrue: 223 },
      { id: '22R', inboundTrue: 43 },
    ],
    rings: [
      {
        inner: 8,
        outer: 18,
        sectors: [
          { id: 1, from: 135, to: 225, floorFt: 3000 },
          { id: 2, from: 225, to: 290, floorFt: 3000 },
          { id: 3, from: 70, to: 135, floorFt: 3000 },
          { id: 4, from: 290, to: 70, floorFt: 5500 },
        ],
      },
      {
        inner: 18,
        outer: 29,
        sectors: [
          { id: 5, from: 135, to: 225, floorFt: 4500 },
          { id: 6, from: 225, to: 290, floorFt: 5500 },
          { id: 7, from: 70, to: 135, floorFt: 5500 },
          { id: 8, from: 290, to: 70, floorFt: 9500 },
        ],
      },
    ],
  },
}

/** Every corridor drops the base to here, outside the control zone. */
const CORRIDOR_FLOOR_FT = 1500

/* ---------------------------------------------------------- gate levels */

/**
 * No sub-area may have its base above a holding fix inside it.
 *
 * The bases are chosen from the terrain and the arrival direction, which is
 * the right way to choose them and is blind to one thing: an arrival is
 * released at a gate, at a level the traffic configuration picks, and a
 * sub-area based above that gate says on the display that the aeroplane is
 * beneath controlled airspace at the moment it is handed over.
 *
 * The area is pulled down to the gate rather than the gate pushed up to the
 * area: the entry bands are tuned for the descent that follows them, and
 * the bases are not.
 */
function clampToGates(arp, volumes, navaids) {
  const kx = 60 * Math.cos(arp.lat * D2R)
  const at = (p) => [(p.lon - arp.lon) * kx, (p.lat - arp.lat) * 60]

  for (const fix of navaids) {
    if (fix.hold === undefined) continue
    const level = fix.entry?.minAltFt ?? 5000
    const p = at(fix)
    for (const v of volumes) {
      if (v.kind !== 'polygon' || v.floorFt <= level) continue
      if (!inPolygon(v.vertices.map(at), p)) continue
      console.log(`  ${v.id}: base ${v.floorFt} -> ${level}, to stay under ${fix.name}`)
      v.floorFt = level
    }
  }
}

function inPolygon(ring, [x, y]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[j]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/* -------------------------------------------------------- traffic zones */

/**
 * How big a traffic zone is.
 *
 * One rule for every neighbour rather than a guess per field: two and a
 * half miles where the longest runway is over 1850 m and two otherwise, to
 * two thousand feet above the aerodrome. That is the UK rule. It is used
 * here because it is a written rule that gives sensible numbers over three
 * other countries, and it is flagged in the data as a rule rather than
 * passed off as published.
 */
const ATZ_REACH_NM = 50
const M_PER_FT = 0.3048

function trafficZones(field) {
  const kx = 60 * Math.cos(field.arp.lat * D2R)
  const out = []
  for (const a of field.airports) {
    const d = Math.hypot((a.lon - field.arp.lon) * kx, (a.lat - field.arp.lat) * 60)
    if (d > ATZ_REACH_NM) continue
    if (a.primaryRunway === null) continue
    out.push({
      id: `${a.icao} ${a.name} ATZ`,
      label: `${a.icao} ATZ`,
      class: 'G',
      kind: 'circle',
      centreAirport: a.icao,
      radiusNM: a.primaryRunway.lengthFt * M_PER_FT > 1850 ? 2.5 : 2,
      floorFt: 0,
      ceilingFt: a.elevationFt + 2000,
      derivation: 'rule',
      verticalSource: 'rule',
    })
  }
  return out
}

/* ---------------------------------------------------------------- build */

const NOTE =
  ' The control zone and the terminal area outline are unchanged and still rule-derived. ' +
  'Everything else in the airspace block is CONSTRUCTED and comes from no AIP or sector ' +
  'file: approach corridors along the extended centrelines, which bring the base of ' +
  'controlled airspace down to 1500 ft outside the zone, and terminal sub-areas whose ' +
  'bases step up away from the arrival direction and over the high ground in this file. ' +
  'They carry derivation "approx". None of them encloses the aerodrome, so none of them ' +
  'joins the area of responsibility: that is still the control zone and the terminal ' +
  'area, exactly as before. Aerodrome traffic zones are computed from a rule -- 2.5 NM ' +
  'where the longest runway is over 1850 m and 2 NM otherwise, to 2000 ft above the ' +
  'aerodrome -- and carry derivation "rule".'

for (const [key, spec] of Object.entries(FIELDS)) {
  const path = `src/data/${key}.json`
  const field = JSON.parse(fs.readFileSync(path, 'utf8'))
  const arp = field.arp
  const { name, base } = spec

  // Reproduced, not redesigned. See the note at the top of this file.
  const structural = [
    {
      id: `${field.icao} TMA`,
      label: `${name} TMA`,
      class: 'A',
      kind: 'lines',
      paths: [published(arp, base.tmaRadiusNM)],
      floorFt: base.tmaFloorFt,
      ceilingFt: base.tmaCeilingFt,
      derivation: 'rule',
      verticalSource: 'rule',
    },
    {
      id: `${field.icao} CTR`,
      label: `${name} CTR`,
      class: 'D',
      kind: 'circle',
      centre: { lat: arp.lat, lon: arp.lon },
      radiusNM: base.ctrRadiusNM,
      floorFt: 0,
      ceilingFt: base.tmaFloorFt,
      derivation: 'rule',
      verticalSource: 'rule',
    },
  ]

  const detail = []

  for (const c of spec.corridors) {
    detail.push({
      id: `${field.icao} ${c.id} approach CTA`,
      label: `${c.id} APPROACH`,
      class: 'D',
      kind: 'polygon',
      vertices: corridor(arp, {
        inboundTrue: c.inboundTrue,
        fromNM: base.ctrRadiusNM,
        toNM: 20,
        nearHalfNM: 3,
        farHalfNM: 7,
      }),
      floorFt: CORRIDOR_FLOOR_FT,
      ceilingFt: base.tmaFloorFt,
      derivation: 'approx',
      verticalSource: 'assumed',
    })
  }

  for (const r of spec.rings) {
    for (const s of r.sectors) {
      detail.push({
        id: `${name} CTA ${s.id}`,
        label: `${name} CTA ${s.id}`,
        class: 'C',
        kind: 'polygon',
        vertices: wedge(arp, { from: s.from, to: s.to, inner: r.inner, outer: r.outer }),
        floorFt: s.floorFt,
        ceilingFt: base.tmaCeilingFt,
        derivation: 'approx',
        verticalSource: 'assumed',
      })
    }
  }

  clampToGates(arp, detail, field.navaids)
  field.airspace = [...structural, ...detail, ...trafficZones(field)]

  if (!field.provenance.notes.includes('joins the area of responsibility')) {
    field.provenance.notes += NOTE
  }
  fs.writeFileSync(path, JSON.stringify(field, null, 2) + '\n')

  const byClass = {}
  for (const v of field.airspace) byClass[v.class] = (byClass[v.class] ?? 0) + 1
  console.log(
    `${field.icao}: ${field.airspace.length} volumes -- ` +
      Object.entries(byClass)
        .sort()
        .map(([c, n]) => `${n} class ${c}`)
        .join(', '),
  )
}
