/**
 * CONFIGURACIÓN por chat: trabajadores, grupos, turnos, planificaciones y
 * asignaciones — el riel OPCIONAL del onboarding (Lalo 24-ago: "muy consultiva
 * pero determinista: se comprueba que está todo antes de confirmar, con las
 * validaciones del wizard traducidas a lenguaje cotidiano").
 *
 * PATRÓN (el de la Cotizadora de Ejecutivos, PRINCIPIO 3): este módulo expone
 * `pendientesConfiguracion()` → lista de faltas en lenguaje de persona común,
 * y la tool de confirmación del canal SE NIEGA en código mientras la lista no
 * esté vacía. El agente conversa hasta vaciarla; el candado es de acá.
 *
 * Las reglas son TRANSCRIPCIÓN de las del wizard (onboarding-geovictoria,
 * components/onboarding-turnos.tsx): misma carga masiva de 8 columnas, mismas
 * validaciones por fila (correo personal OBLIGATORIO — regla Lalo 24-ago),
 * mismos requisitos de turno (horas salvo Libre/Descanso, colación resuelta),
 * de planificación (7 días cubiertos con turnos existentes y válidos) y de
 * asignación (planificación + desde + hasta/permanente). Si el wizard cambia
 * sus reglas, este archivo se actualiza a mano — el test de paridad avisa de
 * las formas, no del drift semántico.
 *
 * Módulo PURO (frontera vigilada por tests/onboarding-frontera.test.ts):
 * nada de red, Supabase ni Botmaker. El estado vive en vic_kv vía el canal.
 */

import { rutValido, formatearRut } from "../rut.ts"

// ── Tipos (espejo de las formas del wizard) ─────────────────────────────────

export type TrabajadorCfg = {
  /** RUT del trabajador (CL). */
  rut?: string
  /** Correo PERSONAL — obligatorio por fila: la plataforma rechaza sin correo. */
  correo?: string
  nombres?: string
  apellidos?: string
  /** Nombre del grupo; si no existe se crea (mismo comportamiento del wizard). */
  grupo?: string
  telefono1?: string
  telefono2?: string
  telefono3?: string
}

export type TurnoCfg = {
  nombre?: string
  /** "HH:MM" 24h. No exigidas si el turno se llama Libre o Descanso. */
  horaInicio?: string
  horaFin?: string
  /** sin = sin colación · libre = N minutos donde quieran · fija = bloque horario. */
  tipoColacion?: "sin" | "libre" | "fija"
  colacionMinutos?: number
  colacionInicio?: string
  colacionFin?: string
}

export const DIAS_SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const

export type PlanificacionCfg = {
  nombre?: string
  /** Turno por día, lunes→domingo, referenciado por NOMBRE de turno. Los días
   * de descanso van con el turno "Libre" — vacío significa "falta decidir". */
  diasTurnos?: Array<string | null | undefined>
}

export type AsignacionCfg = {
  /** RUT del trabajador (la referencia estable; el nombre es ambiguo). */
  rutTrabajador?: string
  /** Nombre de la planificación asignada. */
  planificacion?: string
  /** "YYYY-MM-DD". */
  desde?: string
  /** "YYYY-MM-DD" o "permanente". */
  hasta?: string
}

export type Configuracion = {
  trabajadores: TrabajadorCfg[]
  turnos: TurnoCfg[]
  planificaciones: PlanificacionCfg[]
  asignaciones: AsignacionCfg[]
}

export function configuracionVacia(): Configuracion {
  return { trabajadores: [], turnos: [], planificaciones: [], asignaciones: [] }
}

export type PendienteCfg = {
  /** Dónde está la falta, para que el agente agrupe la conversación. */
  ambito: "trabajadores" | "turnos" | "planificaciones" | "asignaciones"
  /** A quién/qué se refiere (nombre del trabajador, turno o planificación). */
  referencia: string
  /** La falta EN LENGUAJE COTIDIANO — se puede decir tal cual al cliente. */
  mensaje: string
}

// ── Helpers (mismas reglas que el wizard) ───────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function correoValido(correo: string): boolean {
  return EMAIL_RE.test(correo.trim())
}

/** El wizard acepta teléfonos con +, espacios y guiones; 8-15 dígitos. */
function telefonoValido(fono: string): boolean {
  const digitos = fono.replace(/\D/g, "")
  return digitos.length >= 8 && digitos.length <= 15
}

/** "9:00", "09.00", "0900" → "09:00"; inválido → null (regla normalizeTimeValue). */
export function normalizarHora(valor: string | undefined): string | null {
  const v = String(valor || "").trim().replace(/\./g, ":")
  if (!v) return null
  const m = v.match(/^(\d{1,2}):?(\d{2})$/)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
}

function normalizarTexto(s: string | undefined): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
}

/** Libre/Descanso no exigen horas (regla literal del wizard). */
export function esTurnoLibre(nombre: string | undefined): boolean {
  const n = normalizarTexto(nombre)
  return n === "libre" || n === "descanso"
}

function nombreDe(t: TrabajadorCfg, indice: number): string {
  const nombre = `${t.nombres || ""} ${t.apellidos || ""}`.trim()
  if (nombre) return nombre
  if (t.rut) return formatearRut(t.rut)
  return `trabajador ${indice + 1}`
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/

// ── Carga pegada / dictada (las 8 columnas del wizard) ──────────────────────

/**
 * Parsea la nómina en el formato de la carga masiva del wizard: una fila por
 * línea, columnas separadas por TAB, ";" o "|":
 *   Rut | Correo | Nombres | Apellidos | Grupo | Tel1 | Tel2 | Tel3
 * Devuelve trabajadores TAL CUAL vinieron (la validación es aparte — acá no
 * se rechaza nada, para poder reportarle al cliente fila por fila).
 */
export function parsearNominaPegada(texto: string): TrabajadorCfg[] {
  return String(texto || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((linea) => {
      const cols = linea.split(/\t|;|\|/).map((c) => c.trim())
      return {
        rut: cols[0] || "",
        correo: cols[1] || "",
        nombres: cols[2] || "",
        apellidos: cols[3] || "",
        grupo: cols[4] || "",
        telefono1: cols[5] || "",
        telefono2: cols[6] || "",
        telefono3: cols[7] || "",
      }
    })
}

// ── Validaciones (transcripción wizard → lenguaje cotidiano) ────────────────

export function pendientesTrabajador(t: TrabajadorCfg, indice: number): PendienteCfg[] {
  const faltas: PendienteCfg[] = []
  const quien = nombreDe(t, indice)
  const p = (mensaje: string) => faltas.push({ ambito: "trabajadores", referencia: quien, mensaje })

  if (!String(t.nombres || "").trim() || !String(t.apellidos || "").trim()) {
    p(`a ${quien} le falta el nombre o el apellido`)
  }
  const rut = String(t.rut || "").trim()
  if (!rut) p(`a ${quien} le falta el RUT`)
  else if (!rutValido(rut)) p(`el RUT de ${quien} no cuadra (${rut}) — revisa el dígito verificador`)

  const correo = String(t.correo || "").trim()
  if (!correo) {
    p(`a ${quien} le falta su correo personal — sin correo la plataforma no puede crearle el acceso`)
  } else if (!correoValido(correo)) {
    p(`el correo de ${quien} viene mal escrito (${correo})`)
  }

  if (!String(t.grupo || "").trim()) {
    p(`falta saber en qué grupo o área va ${quien} (si no manejan grupos, uno general como "Equipo" basta)`)
  }

  for (const campo of ["telefono1", "telefono2", "telefono3"] as const) {
    const fono = String(t[campo] || "").trim()
    if (fono && !telefonoValido(fono)) p(`el teléfono de ${quien} no parece válido (${fono})`)
  }
  return faltas
}

export function pendientesTurno(turno: TurnoCfg): PendienteCfg[] {
  const faltas: PendienteCfg[] = []
  const nombre = String(turno.nombre || "").trim()
  if (!nombre) {
    return [{ ambito: "turnos", referencia: "turno sin nombre", mensaje: "hay un turno sin nombre — ponle uno (Mañana, Noche, Administrativo…)" }]
  }
  const p = (mensaje: string) => faltas.push({ ambito: "turnos", referencia: nombre, mensaje })

  if (!esTurnoLibre(nombre)) {
    const inicio = String(turno.horaInicio || "").trim()
    const fin = String(turno.horaFin || "").trim()
    if (!inicio) p(`falta la hora de entrada del turno ${nombre}`)
    else if (!normalizarHora(inicio)) p(`la hora de entrada del turno ${nombre} no se entiende (${inicio}) — formato tipo 09:00`)
    if (!fin) p(`falta la hora de salida del turno ${nombre}`)
    else if (!normalizarHora(fin)) p(`la hora de salida del turno ${nombre} no se entiende (${fin}) — formato tipo 18:30`)
  }

  const tipo = turno.tipoColacion || "sin"
  if (!["sin", "libre", "fija"].includes(tipo)) {
    p(`en el turno ${nombre} falta definir la colación: sin colación, libre (X minutos) o fija (con horario)`)
  }
  if (tipo === "libre" && !(Number(turno.colacionMinutos) > 0)) {
    p(`el turno ${nombre} tiene colación libre pero falta cuántos minutos dura`)
  }
  if (tipo === "fija" && (!normalizarHora(turno.colacionInicio) || !normalizarHora(turno.colacionFin))) {
    p(`el turno ${nombre} tiene colación fija pero falta su horario (inicio y fin)`)
  }
  return faltas
}

export function pendientesPlanificacion(plan: PlanificacionCfg, turnos: TurnoCfg[]): PendienteCfg[] {
  const faltas: PendienteCfg[] = []
  const nombre = String(plan.nombre || "").trim() || "sin nombre"
  const p = (mensaje: string) => faltas.push({ ambito: "planificaciones", referencia: nombre, mensaje })
  if (!String(plan.nombre || "").trim()) p("hay una planificación sin nombre — ponle uno (Semana Normal, Rotativo A…)")

  const dias = Array.isArray(plan.diasTurnos) ? plan.diasTurnos : []
  const nombresTurno = new Set(turnos.map((t) => normalizarTexto(t.nombre)).filter(Boolean))
  // Libre/Descanso siempre se aceptan como día de descanso, exista o no como turno.
  const sinAsignar: string[] = []
  const inexistentes = new Set<string>()
  for (let i = 0; i < DIAS_SEMANA.length; i++) {
    const turnoDia = String(dias[i] || "").trim()
    if (!turnoDia) {
      sinAsignar.push(DIAS_SEMANA[i])
      continue
    }
    if (!esTurnoLibre(turnoDia) && !nombresTurno.has(normalizarTexto(turnoDia))) inexistentes.add(turnoDia)
  }
  if (sinAsignar.length) {
    p(
      `en la planificación ${nombre} falta definir qué pasa el ${sinAsignar.join(", ")} — si esos días descansan, se marcan Libre`,
    )
  }
  for (const t of inexistentes) {
    p(`la planificación ${nombre} usa el turno "${t}" pero ese turno no está creado — creémoslo o corrige el nombre`)
  }
  return faltas
}

export function pendientesAsignaciones(cfg: Configuracion): PendienteCfg[] {
  const faltas: PendienteCfg[] = []
  // Sin trabajadores o sin planificaciones no hay qué asignar — esas faltas ya
  // salen por su propio ámbito; acá no se duplican.
  if (!cfg.trabajadores.length || !cfg.planificaciones.length) return faltas

  const planesValidos = new Set(cfg.planificaciones.map((p) => normalizarTexto(p.nombre)).filter(Boolean))
  const porRut = new Map<string, AsignacionCfg>()
  for (const a of cfg.asignaciones) {
    const rut = String(a.rutTrabajador || "").replace(/[^0-9kK]/g, "").toUpperCase()
    if (rut) porRut.set(rut, a)
  }

  const sinPlan: string[] = []
  for (let i = 0; i < cfg.trabajadores.length; i++) {
    const t = cfg.trabajadores[i]
    const quien = nombreDe(t, i)
    const rut = String(t.rut || "").replace(/[^0-9kK]/g, "").toUpperCase()
    const asig = rut ? porRut.get(rut) : undefined
    if (!asig || !String(asig.planificacion || "").trim()) {
      sinPlan.push(quien)
      continue
    }
    const p = (mensaje: string) => faltas.push({ ambito: "asignaciones", referencia: quien, mensaje })
    if (!planesValidos.has(normalizarTexto(asig.planificacion))) {
      p(`${quien} quedó con la planificación "${asig.planificacion}" pero esa planificación no existe`)
    }
    const desde = String(asig.desde || "").trim()
    if (!desde) p(`falta desde cuándo parte ${quien} con su planificación (una fecha, ej. 2026-09-01)`)
    else if (!FECHA_RE.test(desde)) p(`la fecha de inicio de ${quien} no se entiende (${desde}) — formato 2026-09-01`)
    const hasta = String(asig.hasta || "").trim()
    if (!hasta) p(`falta hasta cuándo va la planificación de ${quien} — una fecha o "permanente"`)
    else if (normalizarTexto(hasta) !== "permanente" && !FECHA_RE.test(hasta)) {
      p(`la fecha de término de ${quien} no se entiende (${hasta}) — una fecha o "permanente"`)
    }
  }
  if (sinPlan.length) {
    const lista = sinPlan.length > 4 ? `${sinPlan.slice(0, 4).join(", ")} y ${sinPlan.length - 4} más` : sinPlan.join(", ")
    faltas.push({
      ambito: "asignaciones",
      referencia: "sin planificación",
      mensaje: `falta asignarle planificación a: ${lista}`,
    })
  }
  return faltas
}

/**
 * EL CANDADO: todo lo que falta para poder confirmar turnos y planificaciones,
 * en lenguaje cotidiano. Lista vacía = se puede confirmar. La tool de
 * confirmación del canal DEBE negarse mientras esto devuelva algo.
 */
export function pendientesConfiguracion(cfg: Configuracion): PendienteCfg[] {
  const faltas: PendienteCfg[] = []
  cfg.trabajadores.forEach((t, i) => faltas.push(...pendientesTrabajador(t, i)))
  for (const turno of cfg.turnos) faltas.push(...pendientesTurno(turno))
  for (const plan of cfg.planificaciones) faltas.push(...pendientesPlanificacion(plan, cfg.turnos))
  faltas.push(...pendientesAsignaciones(cfg))

  // Coherencia de conjunto (Lalo 25-ago: turnos y planificaciones son
  // OPCIONALES — la nómina sola basta y lo demás puede quedar para el wizard
  // o la capacitación — pero si el cliente PARTE compartiéndolos, se
  // completan enteros): planificación compartida exige turnos con horario.
  if (cfg.planificaciones.length && !cfg.turnos.some((t) => !esTurnoLibre(t.nombre))) {
    faltas.push({
      ambito: "turnos",
      referencia: "sin turnos",
      mensaje: "hay planificaciones pero ningún turno con horario creado — partamos por los horarios",
    })
  }
  return faltas
}

/** Resumen para que el agente muestre ANTES de confirmar (espejo del wizard). */
export function resumenConfiguracion(cfg: Configuracion): string {
  const lineas: string[] = []
  if (cfg.trabajadores.length) {
    const grupos = new Set(cfg.trabajadores.map((t) => normalizarTexto(t.grupo)).filter(Boolean))
    lineas.push(`Trabajadores: ${cfg.trabajadores.length} (${grupos.size || 1} grupo${grupos.size === 1 ? "" : "s"})`)
    // Nómina NOMINADA (caso 25-ago: sin los nombres a la vista, el modelo no
    // puede cotejar un archivo entrante contra lo realmente guardado y
    // "recuerda" trabajadores que ya no están). Cap defensivo de 60.
    for (const t of cfg.trabajadores.slice(0, 60)) {
      const nombre = `${t.nombres || ""} ${t.apellidos || ""}`.trim() || t.rut || "(sin nombre)"
      lineas.push(`  · ${nombre} — ${t.rut || "sin RUT"} (${t.grupo || "sin grupo"})${t.correo ? "" : " [SIN CORREO]"}`)
    }
    if (cfg.trabajadores.length > 60) lineas.push(`  · … y ${cfg.trabajadores.length - 60} más`)
  }
  for (const t of cfg.turnos) {
    if (esTurnoLibre(t.nombre)) continue
    const colacion =
      t.tipoColacion === "libre"
        ? `, colación libre ${t.colacionMinutos} min`
        : t.tipoColacion === "fija"
          ? `, colación ${normalizarHora(t.colacionInicio)}–${normalizarHora(t.colacionFin)}`
          : ""
    lineas.push(`Turno ${t.nombre}: ${normalizarHora(t.horaInicio)}–${normalizarHora(t.horaFin)}${colacion}`)
  }
  for (const p of cfg.planificaciones) {
    const dias = (p.diasTurnos || []).map((d, i) => `${DIAS_SEMANA[i].slice(0, 3)} ${d || "?"}`).join(" · ")
    lineas.push(`Planificación ${p.nombre}: ${dias}`)
  }
  if (cfg.asignaciones.length) lineas.push(`Asignaciones: ${cfg.asignaciones.length}`)
  return lineas.join("\n")
}

/**
 * Normaliza el "desde" de una asignación contra la fecha de HOY (caso Haus
 * 07-sep-2026: el cliente dijo "desde hoy 7 de septiembre" y el modelo guardó
 * 2025-01-07 porque no sabía en qué día estaba). Reglas, en orden:
 *   1. vacío, "hoy", "ahora", "desde ya" o algo que no es YYYY-MM-DD → hoy.
 *   2. mismo mes-día que hoy pero OTRO año → hoy (el error típico del modelo).
 *   3. más de 90 días en el pasado → hoy (nadie planifica retroactivo tan atrás).
 *   4. si no, se respeta tal cual (una fecha futura o reciente es legítima).
 * Devuelve la fecha final y si hubo ajuste, para que la tool lo declare.
 */
export function normalizarFechaDesde(desde: string | undefined, hoyISO: string): { fecha: string; ajustada: boolean } {
  const crudo = String(desde || "").trim().toLowerCase()
  if (!crudo || /^(hoy|ahora|desde ya|de inmediato|inmediato)$/.test(crudo)) return { fecha: hoyISO, ajustada: crudo !== "" }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(crudo)
  if (!m) return { fecha: hoyISO, ajustada: true }
  const [hy, hm, hd] = hoyISO.split("-").map(Number)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y !== hy && mo === hm && d === hd) return { fecha: hoyISO, ajustada: true }
  const dias = (Date.UTC(hy, hm - 1, hd) - Date.UTC(y, mo - 1, d)) / 86_400_000
  if (dias > 90) return { fecha: hoyISO, ajustada: true }
  return { fecha: crudo, ajustada: false }
}

/** YYYY-MM-DD de hoy en Chile (la única zona que le importa al onboarding CL). */
export function hoyChileISO(ahora: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" })
  return f.format(ahora)
}
