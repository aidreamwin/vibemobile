/**
 * Generates the PWA icons.
 *
 * Hand-rolled rather than pulled from a library: the shape is three primitives
 * (a rounded square, a chevron, a cursor bar), and a build-time image
 * dependency would cost more than it saves. Rerun with:
 *
 *   node apps/web/scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [9, 9, 11] // #09090b, matches the app's surface colour
const FG = [129, 140, 248] // indigo-400
const SS = 4 // supersampling factor for anti-aliasing

// ------------------------------------------------------------- geometry

/** Signed distance to a rounded rectangle centred in a `size` box. */
function roundedRectDistance(x, y, size, radius, inset) {
  const half = size / 2 - inset
  const cx = Math.abs(x - size / 2) - (half - radius)
  const cy = Math.abs(y - size / 2) - (half - radius)
  const dx = Math.max(cx, 0)
  const dy = Math.max(cy, 0)
  return Math.hypot(dx, dy) + Math.min(Math.max(cx, cy), 0) - radius
}

/** Distance from a point to a line segment. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/**
 * Coverage of the foreground glyph at a point, 0..1.
 * The mark is a terminal prompt: `>` plus a cursor bar.
 */
function glyphAlpha(x, y, size) {
  const stroke = size * 0.075
  const left = size * 0.28
  const mid = size * 0.5
  const top = size * 0.32
  const bottom = size * 0.68
  const tipX = size * 0.52

  const chevronTop = segmentDistance(x, y, left, top, tipX, mid)
  const chevronBottom = segmentDistance(x, y, left, bottom, tipX, mid)
  const chevronD = Math.min(chevronTop, chevronBottom)

  // Cursor bar to the right of the chevron.
  const barLeft = size * 0.6
  const barRight = size * 0.78
  const barTop = mid - stroke
  const barBottom = mid + stroke
  const insideBar = x >= barLeft && x <= barRight && y >= barTop && y <= barBottom

  return Math.min(1, Math.max(0, 1 - (chevronD - stroke) / (size * 0.01))) || (insideBar ? 1 : 0)
}

function render(size, { rounded }) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = rounded ? size * 0.22 : 0
  const inset = rounded ? 0 : 0

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0
      let fgHits = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const insideShape = roundedRectDistance(px, py, size, radius, inset) <= 0
          if (!insideShape) continue
          bgHits++
          if (glyphAlpha(px, py, size) > 0.5) fgHits++
        }
      }

      const total = SS * SS
      const alpha = bgHits / total
      const fg = fgHits / total
      const index = (y * size + x) * 4
      // Blend foreground over background, then apply the shape's own alpha so
      // the rounded corners stay transparent.
      for (let c = 0; c < 3; c++) {
        pixels[index + c] = Math.round(BG[c] * (1 - fg) + FG[c] * fg)
      }
      pixels[index + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, pixels)
}

// -------------------------------------------------------------- encoding

function encodePng(width, height, rgba) {
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

// ---------------------------------------------------------------- output

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  // iOS masks the touch icon itself, so this one is drawn square.
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
  { file: 'favicon.png', size: 64, rounded: true },
]

for (const target of targets) {
  const png = render(target.size, { rounded: target.rounded })
  writeFileSync(path.join(OUT_DIR, target.file), png)
  console.log(`${target.file.padEnd(24)} ${target.size}x${target.size}  ${png.length} bytes`)
}
