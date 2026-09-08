/**
 * TEXTO PARA LA CAPACITACIÓN (puro — Lalo 08-sep, caso Haus): "no tenemos
 * endpoint para crear usuarios, solo podemos dejarlo en la implementación en
 * el formato que se solicita… para que en la capacitación se cargue todo lo
 * pendiente: turnos, planificación y empleados".
 *
 * El formato que usan las implementaciones nacidas del wizard (verificado en
 * IMP-11176 Vista Kennedy): una nota "planillas" con los DOS Excel del wizard
 * adjuntos (usuarios-<rut>-<ts>.xlsx y planificaciones-<rut>-<ts>.xlsx) +
 * los campos Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB="Sí",
 * Usuarios_cargados=N, Tipo_de_Planificaci_n y Estado_Planificaci_n_Turnos.
 * Este módulo arma la parte determinista: el detalle legible (por si los
 * Excel aún no existen o el relator prefiere leerlo) y los campos.
 */

import type { Configuracion } from "./configuracion"

const DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]

function colacion(t: Configuracion["turnos"][number]): string {
  if (t.tipoColacion === "fija") return `colación fija ${t.colacionInicio || "?"}-${t.colacionFin || "?"}`
  if (t.tipoColacion === "libre") return `colación libre ${t.colacionMinutos || "?"} min`
  return "sin colación"
}

/**
 * Bloque "PARA CARGAR EN LA CAPACITACIÓN": nómina (cap `maxFilas`), turnos,
 * planificaciones día a día y asignaciones. Vacío si no hay nada levantado.
 */
export function detalleParaCapacitacion(cfg: Configuracion, maxFilas = 60): string {
  const L: string[] = []
  const trab = cfg.trabajadores || []
  const turnos = cfg.turnos || []
  const plans = cfg.planificaciones || []
  const asig = cfg.asignaciones || []
  if (!trab.length && !turnos.length && !plans.length) return ""
  L.push("PARA CARGAR EN LA CAPACITACIÓN (levantado por chat — mismo dato que las planillas)")
  if (trab.length) {
    L.push(`NÓMINA (${trab.length}) · RUT | correo personal | nombres | apellidos | grupo | teléfonos`)
    trab.slice(0, maxFilas).forEach((t, i) => {
      const fonos = [t.telefono1, t.telefono2, t.telefono3].filter(Boolean).join(" ")
      L.push(
        `${i + 1}. ${t.rut || "(sin RUT)"} | ${t.correo || "(SIN CORREO)"} | ${t.nombres || ""} | ${t.apellidos || ""} | ${t.grupo || "General"}${fonos ? ` | ${fonos}` : ""}`,
      )
    })
    if (trab.length > maxFilas) L.push(`… y ${trab.length - maxFilas} más (completos en la planilla de usuarios)`)
  }
  if (turnos.length) {
    L.push(`TURNOS (${turnos.length})`)
    for (const t of turnos) {
      const libre = /^(libre|descanso)$/i.test(String(t.nombre || "").trim())
      L.push(`• ${t.nombre || "(sin nombre)"}: ${libre ? "día libre" : `${t.horaInicio || "?"} a ${t.horaFin || "?"} · ${colacion(t)}`}`)
    }
  }
  if (plans.length) {
    L.push(`PLANIFICACIONES (${plans.length}) · Lun→Dom`)
    for (const p of plans) {
      const dias = (p.diasTurnos || []).slice(0, 7).map((d, i) => `${DIAS[i]} ${d || "Libre"}`)
      L.push(`• ${p.nombre || "(sin nombre)"}: ${dias.join(" · ")}`)
    }
  }
  if (asig.length) {
    L.push(`ASIGNACIONES (${asig.length})`)
    for (const a of asig.slice(0, maxFilas)) {
      const t = trab.find((x) => (x.rut || "").replace(/\D/g, "") === (a.rutTrabajador || "").replace(/\D/g, ""))
      const quien = t ? `${t.nombres || ""} ${t.apellidos || ""}`.trim() || a.rutTrabajador : a.rutTrabajador
      L.push(`• ${quien || "?"} → ${a.planificacion || "?"} desde ${a.desde || "?"}${a.hasta && a.hasta !== "permanente" ? ` hasta ${a.hasta}` : " (permanente)"}`)
    }
  }
  return L.join("\n")
}

export type CamposPlanillasActual = {
  Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB?: string | null
  Usuarios_cargados?: number | null
  Tipo_de_Planificaci_n?: string | null
  Estado_Planificaci_n_Turnos?: string | null
  Se_debe_planificar_turnos_GV?: string | null
}

/**
 * Campos de la Implementación que dejan legible "qué hay para cargar". Solo
 * se PROPONEN cambios que no pisen lo que el implementador ya escribió:
 * Estado "Realizada" jamás retrocede, un Tipo distinto de Desconocido/vacío
 * se respeta, Usuarios_cargados solo sube.
 * Valores de picklist verificados 08-sep contra 200 IMPs: Estado ∈ {Sin datos
 * para planificar, Pendiente, Realizada}; Tipo ∈ {Fijo, Rotativo, Mensual, Desconocido}.
 */
export function camposPlanillasImp(
  cfg: Configuracion,
  planillasAdjuntas: boolean,
  actual: CamposPlanillasActual = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const n = (cfg.trabajadores || []).length
  const hayPlan = (cfg.planificaciones || []).length > 0
  if (planillasAdjuntas && n > 0) {
    if (actual.Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB !== "Sí") out.Confirmo_la_cargo_de_Planilla_de_Ingreso_SMB = "Sí"
    if (!(Number(actual.Usuarios_cargados) >= n)) out.Usuarios_cargados = n
  }
  if (hayPlan) {
    if (!actual.Tipo_de_Planificaci_n || actual.Tipo_de_Planificaci_n === "Desconocido") out.Tipo_de_Planificaci_n = "Fijo"
    if (!actual.Estado_Planificaci_n_Turnos || actual.Estado_Planificaci_n_Turnos === "Sin datos para planificar") {
      out.Estado_Planificaci_n_Turnos = "Pendiente"
    }
    if (actual.Se_debe_planificar_turnos_GV !== "Sí") out.Se_debe_planificar_turnos_GV = "Sí"
  } else if (n > 0 && !actual.Estado_Planificaci_n_Turnos) {
    out.Estado_Planificaci_n_Turnos = "Sin datos para planificar"
  }
  return out
}
