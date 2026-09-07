import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  PREGUNTAS_ESQUEMA,
  fusionarEsquema,
  pendientesEsquema,
  respondidasEsquema,
  resumenEsquema,
  mensajeInvitacionEsquema,
  bloquePromptEsquema,
} from "../lib/onboarding/esquema.ts"

describe("esquema de operación (definiciones para la capacitación)", () => {
  test("son 10 preguntas con ids únicos", () => {
    assert.equal(PREGUNTAS_ESQUEMA.length, 10)
    assert.equal(new Set(PREGUNTAS_ESQUEMA.map((p) => p.id)).size, 10)
  })
  test("fusionar no pisa respuestas con vacíos y acumula notas", () => {
    const a = fusionarEsquema({}, { periodoPago: "mensual, cierra el 25", nota: "tienen part time" })
    const b = fusionarEsquema(a, { periodoPago: "", colacion: "45 min libre", nota: "dos locales" })
    assert.equal(b.periodoPago, "mensual, cierra el 25")
    assert.equal(b.colacion, "45 min libre")
    assert.equal(b.nota, "tienen part time\ndos locales")
    assert.equal(respondidasEsquema(b).length, 2)
    assert.equal(pendientesEsquema(b).length, 8)
  })
  test("resumen dice cuántas y cuáles quedan para la capacitación", () => {
    const r = resumenEsquema({ trabajanFeriados: "sí, se pagan al 100%", loVeEnCapacitacion: true })
    assert.match(r, /1\/10 respondidas/)
    assert.match(r, /Feriados: sí, se pagan al 100%/)
    assert.match(r, /prefirió verlo ahí/)
    assert.match(r, /Período de pago/)
  })
  test("invitación: informativa, numerada, no obligatoria, sin 'Oye'", () => {
    const m = mensajeInvitacionEsquema("Ignacio Salinas")
    assert.match(m, /con Ignacio Salinas/)
    assert.match(m, /10\. /)
    assert.match(m, /No es obligatorio/)
    assert.doesNotMatch(m, /\bOye\b/)
  })
  test("bloque del prompt cambia según si ya se ofreció", () => {
    const antes = bloquePromptEsquema({}, { yaOfrecido: false })
    const despues = bloquePromptEsquema({ colacion: "30 min" }, { yaOfrecido: true })
    assert.match(antes, /Ofrécelas UNA sola vez/)
    assert.match(despues, /no vuelvas a mandarlas completas/)
    assert.match(despues, /Respondidas: Colación/)
  })
})
