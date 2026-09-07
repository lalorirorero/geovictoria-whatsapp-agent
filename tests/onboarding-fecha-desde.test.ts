/** "desde hoy" es HOY (caso Haus 07-sep-2026: quedó 2025-01-07). */
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizarFechaDesde } from "../lib/onboarding/configuracion.ts"

const HOY = "2026-09-07"
test("vacío, 'hoy' o basura → hoy", () => {
  assert.deepEqual(normalizarFechaDesde(undefined, HOY), { fecha: HOY, ajustada: false })
  assert.deepEqual(normalizarFechaDesde("hoy", HOY), { fecha: HOY, ajustada: true })
  assert.deepEqual(normalizarFechaDesde("7 de septiembre", HOY), { fecha: HOY, ajustada: true })
})
test("mismo día-mes con otro año (el error del modelo) → hoy", () => {
  assert.deepEqual(normalizarFechaDesde("2025-09-07", HOY), { fecha: HOY, ajustada: true })
  assert.deepEqual(normalizarFechaDesde("2027-09-07", HOY), { fecha: HOY, ajustada: true })
})
test("más de 90 días atrás → hoy; reciente o futura se respeta", () => {
  assert.deepEqual(normalizarFechaDesde("2025-01-07", HOY), { fecha: HOY, ajustada: true })
  assert.deepEqual(normalizarFechaDesde("2026-09-01", HOY), { fecha: "2026-09-01", ajustada: false })
  assert.deepEqual(normalizarFechaDesde("2026-10-01", HOY), { fecha: "2026-10-01", ajustada: false })
})
