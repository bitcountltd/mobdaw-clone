#!/usr/bin/env node
// Render the app icons in client/public/icons/ from the favicon's design (client/public/favicon.svg), with Chromium.
// Re-run after changing the favicon. Needs playwright, resolved from the current directory:
//
//   (cd <a folder with playwright installed> && node /path/to/client/scripts/make-icons.mjs [chromium executable])
//
//   icon-192.png, icon-512.png   the favicon as is (rounded tile on transparent): manifest purpose "any"
//   icon-maskable-512.png        full-bleed tile, the mark inside the 80% safe circle: purpose "maskable"
//   apple-touch-icon.png (180)   full-bleed tile (iOS rounds the corners itself)
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pub = join(here, '../public')
const { chromium } = createRequire(join(process.cwd(), 'x.js'))('playwright')

const svg = await readFile(join(pub, 'favicon.svg'), 'utf8')
const tile = svg.match(/<rect[^>]*fill="([^"]+)"/)[1]
const mark = svg.match(/<path[^>]*\/>/)[0]
/** The mark alone on a full square of the tile colour, scaled by `k` around the centre. */
const fullBleed = (k) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="${tile}"/>` +
  `<g transform="translate(128 128) scale(${k}) translate(-128 -128)">${mark}</g></svg>`

const icons = [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['icon-maskable-512.png', 512, fullBleed(0.72)],
  ['apple-touch-icon.png', 180, fullBleed(0.86)],
]

const browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {})
for (const [name, size, src] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
  await page.screenshot({ path: join(pub, 'icons', name), omitBackground: true })
  await page.close()
  console.log('wrote', join('client/public/icons', name))
}
await browser.close()
