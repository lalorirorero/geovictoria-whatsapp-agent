import { test } from "node:test"
import assert from "node:assert/strict"
import { camposPlanillasImp, detalleParaCapacitacion } from "../lib/onboarding/planillas-texto.ts"

const cfg = {
  trabajadores: [
    { rut: "11.865.299-1", correo: "r@gmail.com", nombres: "Cristian", apellidos: "Cabrera", grupo: "General", telefono1: "" },
    { rut: "12.345.678-5", correo: "", nombres: "Ana", apellidos: "Pérez" },
  ],
  turnos: [
    { nombre: "Día", horaInicio: "08:30", horaFin: "18:30", tipoColacion: "fija" as const, colacionInicio: "13:00", colacionFin: "14:00" },
    { nombre: "Libre", tipoColacion: "sin" as const },
  ],
  planificaciones: [{ nombre: "General", diasTurnos: ["Día", "Día", "Día", "Día", "Día", "Libre", "Libre"] }],
  asignaciones: [{ rutTrabajador: "11865299-1", planificacion: "General", desde: "2026-09-07", hasta: "permanente" }],
}

test("detalle para capacitación: nómina, turnos, planificación día a día y asignaciones legibles", () => {
  const t = detalleParaCapacitacion(cfg)
  assert.match(t, /NÓMINA \(2\)/)
  assert.match(t, /1\. 11\.865\.299-1 \| r@gmail\.com \| Cristian \| Cabrera \| General/)
  assert.match(t, /\(SIN CORREO\)/)
  assert.match(t, /• Día: 08:30 a 18:30 · colación fija 13:00-14:00/)
  assert.match(t, /• Libre: día libre/)
  assert.match(t, /Lun Día · Mar Día .* Sáb Libre · Dom Libre/)
  assert.match(t, /• Cristian Cabrera → General desde 2026-09-07 \(permanente\)/)
})

test("sin nada levantado el detalle es vacío", () => {
  assert.equal(detalleParaCapacitacion({ trabajadores: [], turnos: [], planificaciones: [], asignaciones: [] }), "")
})

test("campos IMP con planillas adjuntas: Confirmo Sí, Usuarios_cargados, Fijo + Pendiente", () => {
  const c = camposPlanillasImp(cfg, true, { Tipo_de_Planificaci_n: "Desconocido" })
  assert.deepEqual(c, {
    Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB: "Sí",
    Usuarios_cargados: 2,
    Tipo_de_Planificaci_n: "Fijo",
    Estado_Planificaci_n_Turnos: "Pendiente",
    Se_debe_planificar_turnos_GV: "Sí",
  })
})

test("campos IMP no pisan lo del implementador (Realizada, Rotativo, más usuarios cargados)", () => {
  const c = camposPlanillasImp(cfg, true, {
    Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB: "Sí",
    Usuarios_cargados: 5,
    Tipo_de_Planificaci_n: "Rotativo",
    Estado_Planificaci_n_Turnos: "Realizada",
    Se_debe_planificar_turnos_GV: "Sí",
  })
  assert.deepEqual(c, {})
})

test("sin planillas adjuntas no se declara la planilla cargada; sin planificaciones queda 'Sin datos para planificar'", () => {
  const c = camposPlanillasImp({ ...cfg, planificaciones: [], asignaciones: [] }, false, {})
  assert.deepEqual(c, { Estado_Planificaci_n_Turnos: "Sin datos para planificar" })
})
