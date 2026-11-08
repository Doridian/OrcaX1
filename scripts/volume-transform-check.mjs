#!/usr/bin/env node
// Headless check of the volume transform math (web/src/state/volumes.ts):
// rotating, moving and scaling a support volume inside a non-uniformly scaled,
// rotated object must give exactly the world transform the gizmo asked for.
// Needs Node 23.6+ (TypeScript type stripping).
// Usage: node scripts/volume-transform-check.mjs
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) {
      if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(spec + '.ts', ctx)
      throw e
    }
  },
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vols = await import(join(ROOT, 'web/src/state/volumes.ts'))
const model = await import(join(ROOT, 'web/src/model/volumes.ts'))
const { Matrix4, Quaternion, Vector3 } = await import(join(ROOT, 'web/node_modules/three/build/three.module.js'))

let failed = 0
const check = (name, err, tol = 1e-9) => {
  const ok = err <= tol
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (max error ${err.toExponential(2)})`)
  if (!ok) failed++
}
const maxDiff = (a, b) => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])))

// A box object, rotated 30° about Z and scaled 1 × 3 × 0.5.
const box = new Float32Array([-5, -5, 0, 5, -5, 0, 5, 5, 10, -5, 5, 10, -5, -5, 10, 5, 5, 0])
const q30 = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6)
const obj = { id: 'o', name: 'o', positions: box, x: 100, y: 120, rot: [q30.x, q30.y, q30.z, q30.w], scale: [1, 3, 0.5], filament: 0, plate: 0, rev: 0 }
const vol = {
  id: 'v', name: 'v', role: 'support-enforcer', shape: 'box', positions: model.primitive('box'),
  matrix: model.composeVolume([1, 2, 3], [0, 0, 0, 1], [4, 5, 6]),
}
const world = (v) => vols.volumeWorldMatrix(obj, v)

// 1. Rotate 40° about world X through the volume's center: world matrix must be R · old.
const before = world(vol)
const c = new Vector3().setFromMatrixPosition(before)
const w = new Matrix4().makeTranslation(c.x, c.y, c.z)
  .multiply(new Matrix4().makeRotationAxis(new Vector3(1, 0, 0), (40 * Math.PI) / 180))
  .multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z))
const rotated = { ...vol, ...vols.transformedVolume(obj, vol, w) }
check('world rotation of a volume in a non-uniformly scaled object is exact', maxDiff(world(rotated), w.clone().multiply(before)), 1e-9)
check('the rotated volume is sheared in object space (cannot be pos/rot/scale)', model.isSheared(rotated) ? 0 : 1, 0)

// What the old pos/rot/scale storage gave (decompose + recompose):
const p = new Vector3(), q = new Quaternion(), s = new Vector3()
model.volumeMatrix(rotated).decompose(p, q, s)
const lossy = { ...vol, matrix: new Matrix4().compose(p, q, s).toArray() }
console.log(`     (the previous decompose-based storage was off by ${maxDiff(world(lossy), w.clone().multiply(before)).toFixed(3)} mm)`)

// 2. Rotating back gives the original volume.
const back = { ...rotated, ...vols.transformedVolume(obj, rotated, w.clone().invert()) }
check('rotating back restores the original matrix', maxDiff(model.volumeMatrix(back), model.volumeMatrix(vol)), 1e-9)

// 3. Move in world space.
const t = new Matrix4().makeTranslation(3, -4, 5)
const moved = { ...rotated, ...vols.transformedVolume(obj, rotated, t) }
check('world move of a sheared volume is exact', maxDiff(world(moved), t.clone().multiply(world(rotated))), 1e-9)

// 4. Numeric edits keep the shear: position, rotation and size round-trip through volumeTRS.
const pos = { ...rotated, ...vols.positionedVolume(rotated, [7, 8, 9]) }
const trsPos = model.volumeTRS(pos)
check('numeric position edit', Math.max(...trsPos.pos.map((x, i) => Math.abs(x - [7, 8, 9][i]))), 1e-12)
const qWant = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0).normalize(), 0.7)
const rot = { ...rotated, ...vols.rotatedVolume(rotated, [qWant.x, qWant.y, qWant.z, qWant.w]) }
const trsRot = model.volumeTRS(rot)
check('numeric rotation edit sets the displayed rotation', 1 - Math.abs(new Quaternion(...trsRot.rot).dot(qWant)), 1e-12)
check('numeric rotation edit keeps the axis lengths', Math.max(...trsRot.scale.map((x, i) => Math.abs(x - model.volumeTRS(rotated).scale[i]))), 1e-9)
const scaled = { ...rotated, ...vols.scaledVolume(rotated, [1, 2, 1]) }
check('scaling a volume axis doubles its length', Math.abs(model.volumeTRS(scaled).scale[1] - 2 * model.volumeTRS(rotated).scale[1]), 1e-9)

// 5. Unsheared volumes still decompose exactly.
const plain = model.volumeTRS(vol)
check('volumeTRS of an unsheared volume', Math.max(...plain.pos.map((x, i) => Math.abs(x - [1, 2, 3][i])), ...plain.scale.map((x, i) => Math.abs(x - [4, 5, 6][i]))), 1e-12)

console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
