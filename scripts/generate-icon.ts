/**
 * Generates a minimal 256x256 ICO file for the HITL app.
 * Uses raw BMP encoding inside the ICO container — no external dependencies.
 *
 * The icon is a simple purple (Catppuccin Mocha mauve #cba6f7) rounded square
 * with "H" letterform in the center.
 */

import { writeFileSync } from 'fs'
import { join } from 'path'

const SIZE = 64 // 64x64 icon (good for NSIS)
const CHANNELS = 4 // BGRA

// Catppuccin Mocha colors
const BG = { r: 0xcb, g: 0xa6, b: 0xf7 }   // mauve
const FG = { r: 0x1e, g: 0x1e, b: 0x2e }   // base (dark)

function createPixelData(): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * CHANNELS)
  const radius = 10

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const offset = (y * SIZE + x) * CHANNELS
      let alpha = 255

      // Rounded rectangle check
      const inCorner = (
        (x < radius && y < radius && Math.hypot(x - radius, y - radius) > radius) ||
        (x >= SIZE - radius && y < radius && Math.hypot(x - (SIZE - radius - 1), y - radius) > radius) ||
        (x < radius && y >= SIZE - radius && Math.hypot(x - radius, y - (SIZE - radius - 1)) > radius) ||
        (x >= SIZE - radius && y >= SIZE - radius && Math.hypot(x - (SIZE - radius - 1), y - (SIZE - radius - 1)) > radius)
      )

      if (inCorner) {
        alpha = 0
        pixels[offset + 0] = 0 // B
        pixels[offset + 1] = 0 // G
        pixels[offset + 2] = 0 // R
        pixels[offset + 3] = 0 // A
        continue
      }

      // Draw "H" letter in the center
      // H dimensions: roughly centered, 60% of icon height
      const hLeft = Math.floor(SIZE * 0.22)
      const hRight = Math.floor(SIZE * 0.78)
      const hTop = Math.floor(SIZE * 0.18)
      const hBottom = Math.floor(SIZE * 0.82)
      const hStroke = Math.floor(SIZE * 0.14)
      const hMidTop = Math.floor(SIZE * 0.44)
      const hMidBottom = Math.floor(SIZE * 0.56)

      const isH = (
        // Left vertical bar
        (x >= hLeft && x < hLeft + hStroke && y >= hTop && y < hBottom) ||
        // Right vertical bar
        (x >= hRight - hStroke && x < hRight && y >= hTop && y < hBottom) ||
        // Middle horizontal bar
        (x >= hLeft && x < hRight && y >= hMidTop && y < hMidBottom)
      )

      if (isH) {
        pixels[offset + 0] = FG.b
        pixels[offset + 1] = FG.g
        pixels[offset + 2] = FG.r
      } else {
        pixels[offset + 0] = BG.b
        pixels[offset + 1] = BG.g
        pixels[offset + 2] = BG.r
      }
      pixels[offset + 3] = alpha
    }
  }

  return pixels
}

function createIco(size: number, pixels: Buffer): Buffer {
  // ICO format:
  // - ICO header (6 bytes)
  // - 1 directory entry (16 bytes)
  // - PNG or BMP image data

  // We'll use raw 32-bit BGRA BMP (no file header, just DIB header + pixels)
  const dibHeaderSize = 40 // BITMAPINFOHEADER
  const pixelDataSize = size * size * CHANNELS
  const imageSize = dibHeaderSize + pixelDataSize

  // ICO header
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = ICO
  header.writeUInt16LE(1, 4) // count: 1 image

  // Directory entry
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size < 256 ? size : 0, 0)  // width (0 = 256)
  entry.writeUInt8(size < 256 ? size : 0, 1)  // height (0 = 256)
  entry.writeUInt8(0, 2)    // color palette: 0
  entry.writeUInt8(0, 3)    // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(imageSize, 8) // image data size
  entry.writeUInt32LE(6 + 16, 12)   // offset to image data

  // BITMAPINFOHEADER
  const dib = Buffer.alloc(dibHeaderSize)
  dib.writeUInt32LE(dibHeaderSize, 0) // header size
  dib.writeInt32LE(size, 4)           // width
  dib.writeInt32LE(size * 2, 8)       // height (doubled for ICO = image + mask)
  dib.writeUInt16LE(1, 12)            // planes
  dib.writeUInt16LE(32, 14)           // bits per pixel
  dib.writeUInt32LE(0, 16)            // compression: none
  dib.writeUInt32LE(pixelDataSize, 20) // image size
  dib.writeInt32LE(0, 24)             // X ppm
  dib.writeInt32LE(0, 28)             // Y ppm
  dib.writeUInt32LE(0, 32)            // colors used
  dib.writeUInt32LE(0, 36)            // important colors

  // BMP stores pixels bottom-to-top, so flip rows
  const flipped = Buffer.alloc(pixelDataSize)
  for (let row = 0; row < size; row++) {
    const srcOffset = row * size * CHANNELS
    const dstOffset = (size - 1 - row) * size * CHANNELS
    pixels.copy(flipped, dstOffset, srcOffset, srcOffset + size * CHANNELS)
  }

  return Buffer.concat([header, entry, dib, flipped])
}

// Generate and write
const pixels = createPixelData()
const ico = createIco(SIZE, pixels)
const outPath = join(__dirname, '..', 'build', 'icon.ico')
writeFileSync(outPath, ico)
console.log(`Icon written to ${outPath} (${ico.length} bytes)`)
