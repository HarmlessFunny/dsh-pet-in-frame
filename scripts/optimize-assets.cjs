/**
 * Asset optimizer for dsh-pet-in-frame.
 *
 * Downscales every raster in the assets directory to a display-friendly size
 * (512px longest edge, enough for the 100–320px pet at 1.6x retina) and
 * re-encodes it as a compressed WebP in place (WebP ~10x smaller than PNG for
 * illustration art; the pet serves webp natively). The source raster is
 * removed — keep full-resolution originals elsewhere (e.g. the .psd files).
 *
 * Usage:
 *   node scripts/optimize-assets.cjs [dir] [maxPx] [quality]
 *     dir     default: assets
 *     maxPx   default: 512
 *     quality default: 82
 *
 * Requires `sharp`. If it is not installed in this repo, point NODE_PATH at a
 * deployment that ships it (the web profile store has it):
 *   NODE_PATH=~/.dsh/profiles/node_modules node scripts/optimize-assets.cjs
 *
 * After running, update assets/manifest.json to reference the .webp names.
 */
const { readdir, rename, stat, unlink } = require('node:fs/promises')
const { join, parse } = require('node:path')
const sharp = require('sharp')

async function main() {
  const dir = process.argv[2] || 'assets'
  const max = Number(process.argv[3] || 512)
  const quality = Number(process.argv[4] || 82)
  const RASTER = /\.(png|jpe?g|webp)$/i

  const files = (await readdir(dir)).filter((f) => RASTER.test(f))
  if (files.length === 0) {
    console.log(`no raster files in ${dir}`)
    return
  }

  for (const f of files) {
    const input = join(dir, f)
    const base = parse(f).name
    const output = join(dir, `${base}.webp`)
    const meta = await sharp(input).metadata()
    const longest = Math.max(meta.width || 0, meta.height || 0)
    if (longest > max || !f.toLowerCase().endsWith('.webp')) {
      await sharp(input)
        .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toFile(output + '.tmp')
      await rename(output + '.tmp', output)
    }
    if (output !== input) await unlink(input).catch(() => {})
    const size = (await stat(output)).size
    console.log(`ok    ${f} -> ${base}.webp (${Math.min(longest, max)}px, ${(size / 1024).toFixed(1)} KiB)`)
  }
  console.log('done')
}

main().catch((e) => { console.error(e); process.exit(1) })
