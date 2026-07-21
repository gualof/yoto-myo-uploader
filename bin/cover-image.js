// cover-image.js
// Prepares a cover image for Yoto MYO upload.
//
// Yoto resizes cover art (coverType 'default') to a fixed 638x1011 portrait
// frame, preserving aspect ratio and center-cropping the overflow — so square
// or oddly-sized covers lose their edges. We pre-fit the image onto a 638x1011
// canvas so Yoto's resize becomes a no-op (nothing cropped). Off-ratio images
// get a blurred copy of themselves as the background fill instead of hard bars.
// (Note: coverType 'myo' is a 520x400 LANDSCAPE box — wrong for book covers.)

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, basename } from 'path'

const execFileAsync = promisify(execFile)

// 2x Yoto's 'myo' cover dimensions (638x1011, see yoto-nodejs-client media.js).
// Using 2x keeps the exact 638:1011 ratio, uses even dimensions (JPEG-friendly),
// and gives Yoto a crisp source to downscale from.
export const COVER_W = 1276
export const COVER_H = 2022

export async function ffmpegAvailable () {
  try { await execFileAsync('ffmpeg', ['-version']); return true } catch { return false }
}

// Fit `src` onto a COVER_W x COVER_H canvas with a blurred-fill background.
// Returns { buffer, filename } ready for uploadCoverImage. Falls back to the
// original bytes if ffmpeg is unavailable or conversion fails, so uploads never
// break because of image processing.
export async function prepareCover (srcPath) {
  const original = async () => ({ buffer: await readFile(srcPath), filename: basename(srcPath) })
  if (!(await ffmpegAvailable())) return original()

  const out = join(tmpdir(), `yoto-cover-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
  // bg: scale to COVER, crop to fill, blur. fg: scale to fit inside COVER.
  // overlay fg centered over bg -> full cover visible, no crop, blurred sides.
  const filter =
    `[0:v]scale=${COVER_W}:${COVER_H}:force_original_aspect_ratio=increase,` +
    `crop=${COVER_W}:${COVER_H},boxblur=20:2[bg];` +
    `[0:v]scale=${COVER_W}:${COVER_H}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', srcPath,
      '-filter_complex', filter,
      '-frames:v', '1', '-q:v', '3',
      '-y', out
    ])
    const buffer = await readFile(out)
    await unlink(out).catch(() => {})
    return { buffer, filename: 'cover.jpg' }
  } catch {
    await unlink(out).catch(() => {})
    return original()
  }
}
