/**
 * Lado CANAL del agente de onboarding: todo lo que toca vic_kv, Botmaker o al
 * equipo interno. El cerebro (lib/onboarding/) es puro y no sabe que esto
 * existe — este archivo es el único puente, y por eso vive FUERA de la
 * frontera que vigila tests/onboarding-frontera.test.ts.
 *
 * Alta AUTOMÁTICA (02-ago, endpoints de Nicolás vía lib/alta-empresa.ts):
 * confirmar_alta_empresa consulta exists ANTES de crear (candado) y crea la
 * empresa + admin por API. La plataforma le manda el correo de acceso al
 * admin. Tres salidas: ya existe → activación al equipo (posible cliente
 * actual, caso Cofradía); creada → confirmación al cliente; API caída o sin
 * env → aviso manual de siempre (un alta jamás se pierde).
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { altaApiConfigurada, existeEmpresa, crearEmpresaConAdmin } from "./alta-empresa"

// URL de inicio de sesión de la plataforma para el instructivo post-alta.
// Sin env, el copy dice "la plataforma GeoVictoria" sin link (jamás inventar).
const LOGIN_URL = (process.env.VICKY_PLATAFORMA_LOGIN_URL || "").trim()

/** "Martes 8 de septiembre" — como lo lee una persona, nunca 2026-09-08. */
function etiquetaFecha(fechaISO: string): string {
  const d = new Date(`${fechaISO}T12:00:00-04:00`)
  const t = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Santiago" }).format(d)
  return t.charAt(0).toUpperCase() + t.slice(1)
}
export { entregarKickoffOnboarding } from "./onboarding-envio"
import { dispatchTool } from "./tools"
import { consultarAgenteSoporteSchema } from "./tools/consultar-agente-soporte"
import { esContactoPiloto } from "./onboarding-piloto"
import {
  onboardingEnabled,
  faseEfectiva,
  esFase,
  claveFase,
  claveBorrador,
  claveAltaSolicitada,
  claveCapacitacion,
  claveConfiguracion,
  claveEsquema,
  claveEsquemaOfrecido,
  type FaseVicky,
} from "./onboarding/fase"
import {
  configuracionVacia,
  parsearNominaPegada,
  pendientesConfiguracion,
  resumenConfiguracion,
  type Configuracion,
  type TurnoCfg,
} from "./onboarding/configuracion"
import { promptConfiguracionCL } from "./onboarding/prompt"
import {
  type EsquemaOperacion,
  bloquePromptEsquema,
  fusionarEsquema,
  mensajeInvitacionEsquema,
  pendientesEsquema,
  respondidasEsquema,
  resumenEsquema,
} from "./onboarding/esquema"
import { TOOL_REGISTRAR_ESQUEMA_OPERACION } from "./onboarding/tools"
import {
  parsearBorrador,
  borradorVacio,
  aplicarDatos,
  problemas,
  camposPendientes,
  borradorCompleto,
  resumenParaConfirmar,
  normalizarIdentificador,
  type DatosParciales,
  type Borrador,
} from "./onboarding/borrador"
import { promptOnboardingCL } from "./onboarding/prompt"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
  TOOL_GUARDAR_NOMINA,
  TOOL_DEFINIR_TURNO,
  TOOL_ARMAR_PLANIFICACION,
  TOOL_ASIGNAR_PLANIFICACION,
  TOOL_ELIMINAR_TRABAJADOR,
  TOOL_CONFIRMAR_CONFIGURACION,
  TOOL_VER_CUPOS_CAPACITACION,
  TOOL_AGENDAR_CAPACITACION,
  TOOL_REAGENDAR_CAPACITACION,
  TOOL_CANCELAR_CAPACITACION,
} from "./onboarding/tools"

/**
 * PILOTO POR CONTACTO (24-ago, "partimos probando directamente por
 * WhatsApp"): con el flag global apagado, los contactos listados en vic_kv
 * `onboarding_piloto` (teléfonos separados por coma) SÍ entran a la fase de
 * onboarding. Los enrola vic-onboarding-invocar al invocarlos — así el
 * piloto se maneja sin deploy y sin exponer a ningún cliente real.
 */
// esContactoPiloto vive en lib/onboarding-piloto.ts (definición única, 05-sep).

/**
 * Fase del contacto para el gate del webhook. Con el flag apagado devuelve
 * "venta" SIN tocar el kv (cero latencia al camino de venta) — salvo que el
 * contacto esté en el piloto.
 */
export async function faseDelContacto(contact: string): Promise<FaseVicky> {
  if (!onboardingEnabled()) {
    if (!(await esContactoPiloto(contact))) return "venta"
    const crudoPiloto = await getKvValue(claveFase(contact)).catch((e) => {
      console.warn(`[onboarding-gate] lectura de fase FALLÓ para ${contact}:`, e instanceof Error ? e.message : e)
      return null
    })
    const fase = esFase(crudoPiloto) ? crudoPiloto : "venta"
    // Piloto: la decisión del gate SIEMPRE deja huella (cazador del flip 25-ago).
    console.log(`[onboarding-gate] contact=${contact} piloto=si kv=${JSON.stringify(crudoPiloto)} → fase=${fase}`)
    return fase
  }
  const crudo = await getKvValue(claveFase(contact)).catch(() => null)
  return faseEfectiva(crudo)
}

async function cargarBorrador(contact: string): Promise<Borrador> {
  const json = await getKvValue(claveBorrador(contact)).catch(() => null)
  return parsearBorrador(json) ?? borradorVacio("cl")
}

/**
 * Prompt + toolset de la fase onboarding para runAgentLoop (mismo enganche
 * que usa MX). El dispatch relee el borrador de vic_kv en cada llamada: el
 * estado que manda es el persistido, nunca el de la memoria del turno.
 */
export async function armarOnboarding(contact: string): Promise<{
  systemPrompt: string
  tools: { schemas: unknown[]; dispatch: (name: string, input: unknown) => Promise<unknown> }
}> {
  const borrador = await cargarBorrador(contact)
  const altaSolicitada = !!(await getKvValue(claveAltaSolicitada(contact)).catch(() => null))

  // ── F2: estado de la CONFIGURACIÓN (nómina/turnos/planificaciones) ──
  const cargarConfig = async (): Promise<Configuracion> => {
    try {
      const raw = await getKvValue(claveConfiguracion(contact))
      if (raw) return { ...configuracionVacia(), ...(JSON.parse(raw) as Partial<Configuracion>) }
    } catch {}
    return configuracionVacia()
  }
  const guardarConfig = async (cfg: Configuracion) =>
    setKvValue(claveConfiguracion(contact), JSON.stringify(cfg)).catch(() => {})
  /** Respuesta estándar de las tools F2: estado + faltas en cotidiano. */
  const estadoConfig = (cfg: Configuracion) => {
    const faltas = pendientesConfiguracion(cfg)
    return {
      resumen: resumenConfiguracion(cfg),
      pendientes: faltas.map((f) => f.mensaje),
      listoParaCerrar: faltas.length === 0 && cfg.trabajadores.length > 0,
    }
  }

  /** Insight de la conversación → Implementación (segundo plano, con debounce). */
  const sincronizarInsight = (force = false) => {
    import("./implementacion-insight")
      .then((m) => m.sincronizarInsightEnSegundoPlano(contact, { force }))
      .catch(() => null)
  }

  const dispatch = async (name: string, input: unknown): Promise<unknown> => {
    // ── CAPACITACIÓN (Curso 1) ────────────────────────────────────────────
    // Vicky cierra sola (decisión de Lalo 04-sep). Los candados están acá, no
    // en el prompt: el horario tiene que venir de la disponibilidad REAL, y un
    // cliente que ya tiene su cita no puede tomar otra.
    if (
      name === TOOL_VER_CUPOS_CAPACITACION.name ||
      name === TOOL_AGENDAR_CAPACITACION.name ||
      name === TOOL_REAGENDAR_CAPACITACION.name ||
      name === TOOL_CANCELAR_CAPACITACION.name
    ) {
      const crudo = await getKvValue(claveCapacitacion(contact)).catch(() => null)
      const cap = crudo
        ? (JSON.parse(crudo) as {
            implementacionId?: string
            numero?: string
            empresa?: string
            relator?: { nombre: string; email: string }
            bookingId?: string
            cuando?: string
          })
        : null
      if (!cap?.relator?.email) {
        return {
          ok: false,
          error:
            "Todavía no hay implementación creada para este cliente, así que no sé qué relator le toca. " +
            "No ofrezcas capacitación: primero tiene que quedar creada su cuenta.",
        }
      }
      const {
        servicioCurso1De, staffDe, fechasAgendables, aFormatoBookings, momentoBookings, mismaHora,
      } = await import("./onboarding/agenda-capacitacion")
      const servicioId = servicioCurso1De(cap.relator.email)
      const staffId = staffDe(cap.relator.email)
      if (!servicioId || !staffId) {
        return { ok: false, error: `No tengo el calendario de ${cap.relator.nombre}. Avisa al equipo; no prometas una hora.` }
      }
      const { fetchDisponibilidad } = await import("./zoho-bookings")
      const cuposDe = async (fechaISO: string): Promise<string[]> => {
        const r = (await fetchDisponibilidad(servicioId, aFormatoBookings(fechaISO), staffId).catch(() => null)) as
          | { response?: { returnvalue?: { data?: unknown } } }
          | null
        const d = r?.response?.returnvalue?.data
        const lista = Array.isArray(d) ? d : d ? [d] : []
        return lista.flat().map((x) => String(x)).filter(Boolean)
      }

      if (name === TOOL_VER_CUPOS_CAPACITACION.name) {
        if (cap.bookingId) {
          return {
            ok: true,
            yaAgendada: true,
            cuando: cap.cuando,
            relator: cap.relator.nombre,
            nota: "Este cliente YA tiene su capacitación agendada. Recuérdasela en vez de ofrecer otra.",
          }
        }
        const dias: Array<{ fecha: string; etiqueta: string; horas: string[] }> = []
        const etiquetaDe = etiquetaFecha
        for (const f of fechasAgendables(new Date(), 4)) {
          const horas = await cuposDe(f)
          if (horas.length) dias.push({ fecha: f, etiqueta: etiquetaDe(f), horas })
        }
        return {
          ok: true,
          relator: cap.relator.nombre,
          duracionMin: 120,
          dias,
          nota: dias.length
            ? "Ofrece SOLO estos horarios. Son de la agenda real del relator. Nombra cada día con su `etiqueta` TAL CUAL (ej. \"Lunes 8 de septiembre\"): nunca digas \"mañana\" ni \"pasado mañana\" — el primer día disponible casi nunca es mañana."
            : "Sin cupos en los próximos días. Dile que le confirmas la hora por este chat y avisa al equipo.",
        }
      }

      // ── CANCELAR ──
      if (name === TOOL_CANCELAR_CAPACITACION.name) {
        if (!cap.bookingId) return { ok: false, error: "Este cliente no tiene capacitación agendada; no hay nada que cancelar." }
        const { cancelarCupo } = await import("./zoho-bookings")
        const motivo = String((input as { motivo?: string } | null)?.motivo || "").trim()
        const ok = await cancelarCupo(cap.bookingId, `Cancelada por el cliente desde el chat de Vicky${motivo ? `: ${motivo}` : ""}`).catch(() => false)
        if (!ok) {
          await avisarEquipoInterno(`⚠️ No se pudo cancelar en Bookings la capacitación ${cap.bookingId} de +${contact} (${cap.empresa}). Cancelarla a mano.`).catch(() => {})
          return { ok: false, error: "La cancelación no entró. Dile que la gestionas por este chat — NO afirmes que quedó cancelada." }
        }
        const anterior = cap.cuando
        const { bookingId: _b, cuando: _c, ...resto } = cap
        await setKvValue(claveCapacitacion(contact), JSON.stringify(resto)).catch(() => {})
        if (cap.implementacionId) {
          const { limpiarCurso1Agendado } = await import("./implementacion-vicky")
          await limpiarCurso1Agendado(cap.implementacionId).catch(() => false)
        }
        await avisarEquipoInterno(`ℹ️ Capacitación ${cap.bookingId} de ${cap.empresa} (+${contact}) cancelada por el cliente (${anterior}). Relator: ${cap.relator.nombre}.`).catch(() => {})
        return {
          ok: true,
          mensajeParaProspecto:
            `Listo, quedó cancelada la capacitación del ${anterior} con ${cap.relator.nombre}. ` +
            `Cuando quieras retomarla me dices y te muestro los horarios disponibles 😊`,
        }
      }

      // ── AGENDAR / REAGENDAR ──
      const esReagenda = name === TOOL_REAGENDAR_CAPACITACION.name
      if (!esReagenda && cap.bookingId) {
        return {
          ok: false,
          yaAgendada: true,
          cuando: cap.cuando,
          error: `Este cliente ya tiene su capacitación agendada (${cap.cuando}). No se agenda otra: si quiere cambiarla, usa reagendar_capacitacion.`,
        }
      }
      if (esReagenda && !cap.bookingId) {
        return { ok: false, error: "Este cliente no tiene capacitación agendada; usa agendar_capacitacion." }
      }
      const inp = (input || {}) as { fecha?: string; hora?: string }
      const fecha = String(inp.fecha || "").trim()
      const hora = String(inp.hora || "").trim()
      const libres = await cuposDe(fecha)
      if (!libres.some((h) => mismaHora(h, hora))) {
        return {
          ok: false,
          error: `El ${fecha} a las ${hora} no está disponible. Vuelve a mirar los cupos y ofrécele uno de los que salgan.`,
          disponibles: libres,
        }
      }
      const desde = momentoBookings(fecha, hora)
      if (!desde) return { ok: false, error: "No entendí la fecha o la hora. Pídeselas de nuevo con un horario de la lista." }

      const b = await cargarBorrador(contact)
      const { reservarCupo, cancelarCupo } = await import("./zoho-bookings")
      const nombreCliente = `${b.admin.nombre || ""} ${b.admin.apellido || ""}`.trim() || cap.empresa || "Cliente"
      let anteriorLiberada = ""
      if (esReagenda && cap.bookingId) {
        const okCancel = await cancelarCupo(cap.bookingId, "Reagendada por el cliente desde el chat de Vicky").catch(() => false)
        if (!okCancel) {
          return { ok: false, error: "No pude liberar la hora anterior en Bookings. Dile que el cambio lo confirmas por este chat — NO afirmes que quedó reagendada." }
        }
        anteriorLiberada = cap.cuando || ""
        // Se borra la reserva vieja del estado ANTES de intentar la nueva: si
        // la nueva falla, el estado dice la verdad (sin cita) y no una hora
        // que ya fue liberada en Bookings.
        const { bookingId: _b, cuando: _c, ...resto } = cap
        await setKvValue(claveCapacitacion(contact), JSON.stringify(resto)).catch(() => {})
      }
      const r = await reservarCupo({
        servicioId,
        staffId,
        desde,
        nombre: nombreCliente,
        email: b.admin.email || "",
        telefono: `+${contact.replace(/\D/g, "")}`,
        // El formulario de Diego llama al campo "Numero de implementacion" y
        // el de Ignacio "Numero de Implementacion" (05-sep, E1: la reserva con
        // Ignacio murió por "fields are mandatory"). Se mandan las dos
        // grafías; Bookings ignora la que no exista en ese formulario.
        camposPropios: {
          Empresa: cap.empresa || b.empresa.nombre || "",
          "Numero de implementacion": cap.numero || "",
          "Numero de Implementacion": cap.numero || "",
        },
        notas: "Agendada por Vicky desde el chat de onboarding.",
      })
      if (!r.ok) {
        await avisarEquipoInterno(
          `⚠️ No se pudo ${esReagenda ? `REAGENDAR (la anterior ${anteriorLiberada} YA quedó liberada)` : "agendar"} la capacitación de +${contact} (${cap.empresa}) con ${cap.relator.nombre}: ${JSON.stringify(r.detalle).slice(0, 300)}`,
        ).catch(() => {})
        return {
          ok: false,
          error: esReagenda
            ? "La hora anterior quedó liberada pero la nueva NO entró. Dile con honestidad que le confirmas la nueva hora por este chat — NO afirmes que quedó reagendada."
            : "La reserva no entró. Dile que le confirmas la hora por este chat — NO afirmes que quedó agendada.",
        }
      }
      // Fecha legible (E8 05-sep: "quedó agendada para el 2026-09-08" — ISO al cliente).
      const cuandoLegible = `${etiquetaFecha(fecha).replace(/^./, (c) => c.toLowerCase())} a las ${hora}`
      await setKvValue(
        claveCapacitacion(contact),
        JSON.stringify({ ...cap, bookingId: r.bookingId, cuando: cuandoLegible }),
      ).catch(() => {})
      // Queda escrita en la implementación con la MISMA convención que usa el
      // auto-onboarding ("Autoagendamiento"), para que el equipo vea nuestras
      // capacitaciones igual que las suyas.
      let bienvenidaEnCamino = false
      if (cap.implementacionId) {
        const { registrarCurso1Agendado, pasarAEnPlanificacion } = await import("./implementacion-vicky")
        await registrarCurso1Agendado(cap.implementacionId, {
          desdeBookings: desde,
          relator: cap.relator.nombre,
        }).catch(() => {})
        // Curso planificado ⇒ etapa 2 ⇒ Zoho manda al cliente el "Bienvenido"
        // del jefe de proyectos (acceso + manual), igual que a un humano.
        bienvenidaEnCamino = await pasarAEnPlanificacion(cap.implementacionId).catch(() => false)
      }
      const detalle = (r.detalle as { response?: { returnvalue?: { meeting_info?: { join_link?: string } } } })?.response
        ?.returnvalue?.meeting_info?.join_link
      sincronizarInsight(true)
      return {
        ok: true,
        bookingId: r.bookingId,
        mensajeParaProspecto:
          `¡Listo! Tu capacitación quedó ${esReagenda ? "reagendada" : "agendada"} para el ${cuandoLegible} con ${cap.relator.nombre} 🎉\n\n` +
          `Dura 2 horas y es por videollamada.` +
          (detalle ? `\n\nAcá te conectas el día de la sesión:\n${detalle}` : "") +
          (bienvenidaEnCamino
            ? `\n\nTe va a llegar la invitación al correo, y además un correo de ${cap.relator.nombre} con tu acceso a la plataforma y el manual del administrador. Cualquier cosa me escribes por acá 😊`
            : `\n\nTe va a llegar la invitación al correo también. Cualquier cosa me escribes por acá 😊`),
      }
    }

    // ── Definiciones de operación para la capacitación (Ignacio, 07-sep) ──
    if (name === TOOL_REGISTRAR_ESQUEMA_OPERACION.name) {
      const inp = (input || {}) as EsquemaOperacion & { ofrecer?: boolean }
      const capRaw = await getKvValue(claveCapacitacion(contact)).catch(() => null)
      const relator = capRaw ? (JSON.parse(capRaw) as { relator?: { nombre?: string } }).relator?.nombre : undefined
      if (inp.ofrecer === true) {
        const ya = await getKvValue(claveEsquemaOfrecido(contact)).catch(() => null)
        if (ya) {
          return { ok: true, yaOfrecido: true, instruccion: "Ya se le ofrecieron antes: no repitas la lista completa. Si responde algo, guárdalo." }
        }
        await setKvValue(claveEsquemaOfrecido(contact), new Date().toISOString()).catch(() => {})
        return { ok: true, mensajeParaProspecto: mensajeInvitacionEsquema(relator) }
      }
      const previo = (await getKvValue(claveEsquema(contact))
        .then((v) => (v ? (JSON.parse(v) as EsquemaOperacion) : {}))
        .catch(() => ({}))) as EsquemaOperacion
      const { ofrecer: _o, ...nuevo } = inp
      const fusion = { ...fusionarEsquema(previo, nuevo), actualizadoAt: new Date().toISOString() }
      await setKvValue(claveEsquema(contact), JSON.stringify(fusion)).catch(() => {})
      sincronizarInsight()
      return {
        ok: true,
        respondidas: respondidasEsquema(fusion).map((p) => p.corta),
        pendientes: pendientesEsquema(fusion).map((p) => p.corta),
        resumen: resumenEsquema(fusion),
        instruccion:
          "Agradece en una línea y sigue con lo que estaban. No insistas por las pendientes: las ve con el relator.",
      }
    }

    // ── Tools F2 (fase configuración) ──
    if (name === TOOL_GUARDAR_NOMINA.name) {
      const inp = (input || {}) as { filas?: string; reemplazar?: boolean }
      const nuevas = parsearNominaPegada(String(inp.filas || ""))
      if (!nuevas.length) return { ok: false, error: "No llegó ninguna fila legible." }
      const cfg = await cargarConfig()
      if (inp.reemplazar) {
        cfg.trabajadores = nuevas
      } else {
        // UPSERT por RUT (caso 25-ago: el mismo trabajador puede venir en la
        // foto Y en el excel — no se duplica; y un dato ya completado por
        // chat no se pierde porque la planilla re-enviada lo traiga vacío).
        const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
        for (const n of nuevas) {
          const rut = compacto(n.rut)
          const idx = rut ? cfg.trabajadores.findIndex((t) => compacto(t.rut) === rut) : -1
          if (idx >= 0) {
            const prev = cfg.trabajadores[idx]
            cfg.trabajadores[idx] = {
              rut: n.rut || prev.rut,
              correo: n.correo || prev.correo,
              nombres: n.nombres || prev.nombres,
              apellidos: n.apellidos || prev.apellidos,
              grupo: n.grupo || prev.grupo,
              telefono1: n.telefono1 || prev.telefono1,
              telefono2: n.telefono2 || prev.telefono2,
              telefono3: n.telefono3 || prev.telefono3,
            }
          } else {
            cfg.trabajadores.push(n)
          }
        }
      }
      await guardarConfig(cfg)
      sincronizarInsight()
      return {
        ok: true,
        agregados: nuevas.length,
        totalNomina: cfg.trabajadores.length,
        ...estadoConfig(cfg),
        instruccion:
          "Si hay pendientes de la nómina, pídelos de a pocos (los correos personales primero). " +
          "Con la nómina sana, ofrece turnos/planificaciones como OPCIONALES o cerrar.",
      }
    }
    if (name === TOOL_ELIMINAR_TRABAJADOR.name) {
      const rut = String((input as { rut?: string })?.rut || "")
      const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
      const clave = compacto(rut)
      if (!clave) return { ok: false, error: "Falta el RUT del trabajador a eliminar." }
      const cfg = await cargarConfig()
      const idx = cfg.trabajadores.findIndex((t) => compacto(t.rut) === clave)
      if (idx < 0) return { ok: false, error: `No hay ningún trabajador con RUT ${rut} en la nómina.` }
      const [fuera] = cfg.trabajadores.splice(idx, 1)
      cfg.asignaciones = cfg.asignaciones.filter((a) => compacto(a.rutTrabajador) !== clave)
      await guardarConfig(cfg)
      return {
        ok: true,
        eliminado: `${fuera.nombres || ""} ${fuera.apellidos || ""}`.trim() || fuera.rut,
        ...estadoConfig(cfg),
      }
    }
    if (name === TOOL_DEFINIR_TURNO.name) {
      const t = (input || {}) as TurnoCfg
      if (!String(t.nombre || "").trim()) return { ok: false, error: "El turno necesita nombre." }
      const cfg = await cargarConfig()
      const clave = String(t.nombre).trim().toLowerCase()
      const idx = cfg.turnos.findIndex((x) => String(x.nombre || "").trim().toLowerCase() === clave)
      if (idx >= 0) cfg.turnos[idx] = { ...cfg.turnos[idx], ...t }
      else cfg.turnos.push(t)
      await guardarConfig(cfg)
      return { ok: true, ...estadoConfig(cfg) }
    }
    if (name === TOOL_ARMAR_PLANIFICACION.name) {
      const p = (input || {}) as { nombre?: string; diasTurnos?: string[] }
      if (!String(p.nombre || "").trim()) return { ok: false, error: "La planificación necesita nombre." }
      const dias = Array.from({ length: 7 }, (_, i) => String((p.diasTurnos || [])[i] || "").trim())
      const cfg = await cargarConfig()
      const clave = String(p.nombre).trim().toLowerCase()
      const idx = cfg.planificaciones.findIndex((x) => String(x.nombre || "").trim().toLowerCase() === clave)
      if (idx >= 0) cfg.planificaciones[idx] = { nombre: p.nombre, diasTurnos: dias }
      else cfg.planificaciones.push({ nombre: p.nombre, diasTurnos: dias })
      await guardarConfig(cfg)
      return { ok: true, ...estadoConfig(cfg) }
    }
    if (name === TOOL_ASIGNAR_PLANIFICACION.name) {
      const a = (input || {}) as {
        planificacion?: string
        rutsTrabajadores?: string[]
        todos?: boolean
        desde?: string
        hasta?: string
      }
      const cfg = await cargarConfig()
      const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
      const ruts = a.todos
        ? cfg.trabajadores.map((t) => t.rut).filter(Boolean)
        : (a.rutsTrabajadores || []).filter(Boolean)
      if (!ruts.length) return { ok: false, error: "Sin trabajadores a asignar (¿todos=true o lista de RUTs?)." }
      for (const rut of ruts) {
        const idx = cfg.asignaciones.findIndex((x) => compacto(x.rutTrabajador) === compacto(rut))
        const fila = { rutTrabajador: rut, planificacion: a.planificacion, desde: a.desde, hasta: a.hasta }
        if (idx >= 0) cfg.asignaciones[idx] = fila
        else cfg.asignaciones.push(fila)
      }
      await guardarConfig(cfg)
      return { ok: true, asignados: ruts.length, ...estadoConfig(cfg) }
    }
    if (name === TOOL_CONFIRMAR_CONFIGURACION.name) {
      const confirmado = (input as { confirmacion_explicita?: boolean })?.confirmacion_explicita
      if (confirmado !== true) {
        return { ok: false, error: "Falta la confirmación explícita del cliente al resumen." }
      }
      const cfg = await cargarConfig()
      const faltas = pendientesConfiguracion(cfg)
      if (faltas.length) {
        // EL CANDADO (Lalo 25-ago): lo compartido se completa entero.
        return { ok: false, pendientes: faltas.map((f) => f.mensaje), instruccion: "Conversa estos puntos de a uno; recién con la lista vacía se puede cerrar." }
      }
      if (!cfg.trabajadores.length) {
        return { ok: false, error: "No hay nómina cargada — sin trabajadores no hay nada que cerrar." }
      }
      // Sesión del wizard: crear/reusar → escribir → cerrar (planillas + Flow).
      const { asegurarSesionWizard, escribirConfiguracionWizard, cerrarWizard } = await import("./wizard-sesion")
      const extras = await getKvValue(`onboarding_flow_extras_${contact}`)
        .then((v) => (v ? (JSON.parse(v) as { giro?: string; direccion?: string; comuna?: string }) : {}))
        .catch(() => ({}))
      let dealId = ""
      try {
        const { getQuotePointer } = await import("./supabase-persistence-v3")
        dealId = (await getQuotePointer(contact))?.dealId || ""
      } catch {}
      const b = await cargarBorrador(contact)
      const fallaOperativa = async (detalle: string) => {
        await avisarEquipoInterno(
          `⚠️ CONFIGURACIÓN ONBOARDING de +${contact} NO pudo cerrarse sola (${detalle}). ` +
            `La configuración conversada está íntegra en vic_kv ${claveConfiguracion(contact)} — cerrar a mano en el wizard.`,
        ).catch(() => {})
        return {
          ok: true,
          cerradoEnProceso: true,
          mensajeParaProspecto:
            "¡Quedó todo registrado! 🙌 Estoy dejando tu configuración cargada en la plataforma — te confirmo por este chat apenas esté lista (dentro del día hábil).",
        }
      }
      const ses = await asegurarSesionWizard(contact, b, { dealId, extras })
      if ("error" in ses) return await fallaOperativa(`sesión: ${ses.error}`)
      const w = await escribirConfiguracionWizard(ses.token, cfg)
      if ("error" in w) return await fallaOperativa(`escritura: ${w.error}`)
      const cierre = await cerrarWizard(ses.token, { idZoho: dealId || undefined })
      if ("error" in cierre) return await fallaOperativa(`cierre: ${cierre.error}`)
      await setKvValue(claveFase(contact), "completado").catch(() => {})
      sincronizarInsight(true)
      await avisarEquipoInterno(
        `✅ CONFIGURACIÓN ONBOARDING de +${contact} cerrada por chat: ${cfg.trabajadores.length} trabajadores, ` +
          `${cfg.turnos.length} turnos, ${cfg.planificaciones.length} planificaciones. Sesión wizard ${ses.token}.`,
      ).catch(() => {})
      return {
        ok: true,
        mensajeParaProspecto:
          `¡Listo! Tu configuración quedó andando: ${cfg.trabajadores.length} trabajador${cfg.trabajadores.length === 1 ? "" : "es"}` +
          (cfg.planificaciones.length ? " con sus turnos y planificaciones" : "") +
          ". El equipo de implementación toma el relevo desde aquí — te llegará un correo con los próximos pasos y tu capacitación. Cualquier duda, este chat sigue abierto 😊",
      }
    }
    if (name === TOOL_GUARDAR_DATOS_ONBOARDING.name) {
      const datos = (input || {}) as DatosParciales
      const actualizado = aplicarDatos(await cargarBorrador(contact), datos)
      await setKvValue(claveBorrador(contact), JSON.stringify(actualizado))
      const completo = borradorCompleto(actualizado)
      return {
        ok: true,
        completo,
        pendientes: camposPendientes(actualizado),
        problemas: problemas(actualizado).filter((p) => p.detalle !== "falta"),
        ...(completo
          ? {
              resumenParaConfirmar: resumenParaConfirmar(actualizado),
              instruccion:
                "Muestra este resumen tal cual y pide confirmación explícita. NO llames confirmar_alta_empresa hasta el sí claro del cliente.",
            }
          : {
              instruccion:
                "Pide lo pendiente agrupado (2-3 datos por mensaje); si hay problemas, re-pide SOLO esos campos.",
            }),
      }
    }

    if (name === TOOL_CONFIRMAR_ALTA_EMPRESA.name) {
      const confirmado = (input as { confirmacion_explicita?: boolean })?.confirmacion_explicita
      if (confirmado !== true) {
        return {
          ok: false,
          error:
            "Falta la confirmación explícita del cliente al resumen. Muéstralo y espera un sí claro.",
        }
      }
      const b = await cargarBorrador(contact)
      if (!borradorCompleto(b)) {
        return { ok: false, error: "El borrador no está completo.", pendientes: camposPendientes(b) }
      }
      const ya = await getKvValue(claveAltaSolicitada(contact)).catch(() => null)
      if (ya) {
        return {
          ok: true,
          yaSolicitada: true,
          mensajeParaProspecto:
            "Tu alta ya está en proceso 🙌 La cuenta queda activa dentro de 24 horas hábiles y te aviso por acá.",
        }
      }
      // ── Alta AUTOMÁTICA por API (Nicolás), con candado consultar-antes-de-crear ──
      const fichaAlta =
        `Empresa: ${b.empresa.nombre}\n` +
        `RUT empresa: ${normalizarIdentificador(b.empresa.identificador!, "cl")}\n` +
        `Admin: ${b.admin.nombre} ${b.admin.apellido}\n` +
        `RUT admin: ${normalizarIdentificador(b.admin.identificador!, "cl")}\n` +
        `Correo admin: ${b.admin.email}` +
        (b.admin.idInterno ? `\nCódigo interno: ${b.admin.idInterno}` : "")

      // Empresa YA registrada en la plataforma: no se crea encima (caso
      // Cofradía — cliente actual que compra un upgrade). La activación del
      // plan nuevo la hace el equipo sobre la cuenta existente. Se usa tanto
      // cuando lo dice exists como cuando lo atrapa el 409 del propio
      // servicio (carrera entre el exists y el create).
      const responderYaExiste = async (nombreExistente: string | null) => {
        // CREATE NO ATÓMICO DE LA PLATAFORMA (visto en vivo 05-sep, E12): un
        // create que falla con 409 user_already_exists deja la EMPRESA creada
        // y sin administrador; el reintento con otro correo ve exists=true y
        // caía acá como "cliente actual con plan nuevo" — y nadie creaba el
        // usuario. Si este mismo contacto acaba de recibir un 409 de correo,
        // el aviso lo dice derecho: hay que crear el usuario admin a mano.
        const marca409 = await getKvValue(`alta_409_${contact}`).catch(() => null)
        if (marca409) {
          await avisarEquipoInterno(
            `⚠️ ALTA ONBOARDING CL: la empresa ${nombreExistente || b.empresa.nombre || ""} quedó CREADA SIN ADMINISTRADOR en la plataforma ` +
              `(el primer create falló por correo ocupado ${marca409} y la plataforma igual creó la empresa). ` +
              `Crear a mano el usuario administrador con ${b.admin.email} y avisarle. Contacto +${contact}.\n${fichaAlta}`,
          )
          await setKvValue(claveAltaSolicitada(contact), new Date().toISOString()).catch(() => {})
          return {
            ok: true,
            mensajeParaProspecto:
              "Tu empresa quedó creada en GeoVictoria 🙌 El acceso del administrador con " +
              `${b.admin.email} te lo termina de habilitar nuestro equipo — te confirmo por este chat ` +
              "dentro de 24 horas hábiles. Cualquier duda mientras tanto, aquí estoy.",
          }
        }
        await avisarEquipoInterno(
          `🏢 ALTA ONBOARDING CL: la empresa YA EXISTE en la plataforma (${nombreExistente || "sin nombre"}). ` +
            `Posible cliente actual con plan nuevo — activar sobre la cuenta existente, NO crear otra. ` +
            `Contacto +${contact}.\n${fichaAlta}`,
        )
        await setKvValue(claveAltaSolicitada(contact), new Date().toISOString()).catch(() => {})
        return {
          ok: true,
          mensajeParaProspecto:
            "¡Buenas noticias! Tu empresa ya tiene una cuenta creada en GeoVictoria 🙌 Para dejar tu " +
            "nuevo plan activo sobre esa misma cuenta, nuestro equipo lo habilita directamente — te " +
            "confirmo por este chat dentro de 24 horas hábiles. Cualquier duda mientras tanto, aquí estoy.",
        }
      }

      // SIMULACIÓN DEL ALTA (Lalo 25-ago): con la API de Nicolás caída, el
      // piloto ve la experiencia completa del alta exitosa — cuenta "creada".
      // Doble candado: vic_kv alta_simulada=on Y contacto en el piloto.
      // La réplica del correo de bienvenida (contraseña temporal falsa) se
      // RETIRÓ el 05-sep por orden de Lalo: ese correo lo manda la plataforma
      // real y simularlo solo confunde. La simulación ya no envía nada.
      const simulada =
        (await getKvValue("alta_simulada").catch(() => null)) === "on" && (await esContactoPiloto(contact))
      if (altaApiConfigurada()) {
        const existe = simulada ? { exists: false, name: null } : await existeEmpresa(b.empresa.identificador!, "cl")
        if (existe?.exists) return await responderYaExiste(existe.name)
        if (existe && !existe.exists) {
          const alta = simulada
            ? {
                ok: true as const,
                companyId: `SIM-${Date.now()}`,
                loginUserCreated: true,
                workEmail: b.admin.email!,
              }
            : await crearEmpresaConAdmin({
            pais: "cl",
            empresa: { nombre: b.empresa.nombre!, identificador: b.empresa.identificador! },
            admin: {
              nombre: b.admin.nombre!,
              apellido: b.admin.apellido!,
              identificador: b.admin.identificador!,
              email: b.admin.email!,
              idInterno: b.admin.idInterno,
            },
          })
          // CORREO OCUPADO (28-ago): el correo del admin ya tiene un usuario
          // en la plataforma (409 user_already_exists). NO es "empresa ya
          // existe": el alta queda ABIERTA (sin marcar solicitada) y se le
          // pide otro correo de acceso — con el nuevo, confirmar_alta_empresa
          // se reintenta completo.
          if (!alta.ok && alta.correoOcupado) {
            // Marca para el reintento: si después exists=true, fue este 409.
            await setKvValue(`alta_409_${contact}`, `${b.admin.email} (${new Date().toISOString()})`).catch(() => {})
            await avisarEquipoInterno(
              `📧 ALTA ONBOARDING CL: el correo del admin (${b.admin.email}) YA tiene usuario en la plataforma — se le pidió otro correo. Contacto +${contact}.\n${fichaAlta}`,
            ).catch(() => {})
            return {
              ok: true,
              mensajeParaProspecto:
                `El correo ${b.admin.email} ya tiene un usuario en GeoVictoria, así que no puedo usarlo ` +
                "como acceso nuevo. ¿Me das otro correo para el administrador? Con ese te dejo la cuenta creada al tiro.",
            }
          }
          // Carrera entre el exists y el create: el 409 del propio servicio
          // (company_already_exists, verificado 02-ago) la atrapa — mismo
          // camino que exists=true, jamás alta manual duplicada.
          if (!alta.ok && alta.yaExiste) return await responderYaExiste(null)
          if (alta.ok) {
            await setKvValue(
              claveAltaSolicitada(contact),
              JSON.stringify({ at: new Date().toISOString(), companyId: alta.companyId, via: simulada ? "simulada" : "api" }),
            ).catch(() => {})
            await avisarEquipoInterno(
              `✅ ALTA ONBOARDING CL ${simulada ? "SIMULADA (piloto, sin API real)" : "creada POR API"} (companyId ${alta.companyId}) — contacto +${contact}.\n${fichaAlta}`,
            ).catch(() => {})
            // IMPLEMENTACIÓN GV AVANZADO (Lalo 03-sep): "la empresa se crea
            // automáticamente y además se desprende una implementación —
            // creémosla nosotros, no por Zoho Flow; no habrá duplicidad
            // porque en este caso no hay wizard de auto-onboarding". Las
            // ventas que SÍ pasan por el wizard las crea el Flow como
            // GV Portal con su propio equipo; el alta por chat no pasaba por
            // ahí y no generaba ninguna. Best-effort: si Zoho falla, el alta
            // NO se cae —el cliente ya pagó y ya tiene su cuenta— y queda
            // aviso para crearla a mano.
            // NDV PRIMERO, IMPLEMENTACIÓN DESPUÉS (Lalo 07-sep): la nota de
            // venta se convierte y confirma con la empresa recién creada y la
            // implementación nace con su id (lib/ndv-alta). Es un JOB: una
            // pasada en línea acá y el cron vic-onboarding-ndv-imp lo empuja
            // cada ~2' hasta terminar (la confirmación espera el PDF que
            // Creator genera en background — no cabe en este turno). Si la
            // NDV no se logra en el tope, la implementación nace igual con
            // aviso: el cliente ya pagó y ya tiene su cuenta.
            void import("./ndv-alta")
              .then(async (m) => {
                await m.encolarNdvImp(contact, {
                  companyId: String(alta.companyId || ""),
                  empresa: b.empresa.nombre || "",
                  // El identificador del borrador ES el RUT (así lo pide la
                  // API de alta: sin puntos ni guión).
                  rut: b.empresa.identificador || undefined,
                })
                await m.procesarNdvImp(contact)
              })
              .catch((e) => console.warn("[onboarding] job NDV/implementación no arrancó:", e instanceof Error ? e.message : e))
            // Correo de INSTRUCCIONES de ingreso (Lalo 25-ago, referencia
            // plantillas GeoAvanzado): viaja junto al de la contraseña,
            // best-effort — jamás bloquea el alta.
            import("./onboarding-correos")
              .then((m) =>
                m.enviarCorreoInstruccionesOnboarding({
                  adminNombre: `${b.admin.nombre} ${b.admin.apellido}`.trim(),
                  adminEmail: b.admin.email!,
                  empresa: b.empresa.nombre!,
                }),
              )
              .catch(() => {})
            // Copy en TERCERA persona sobre el admin (Lalo 02-ago): quien
            // chatea puede ser el admin o el comprador que nombró a otra
            // persona — hablar del admin por nombre y correo sirve en ambos
            // casos. La contraseña temporal viaja SOLO por el correo de la
            // plataforma: Vicky nunca la conoce ni la menciona.
            // DOS MENSAJES SEPARADOS (Lalo 25-ago, prueba de Rodrigo): el del
            // acceso corto y sin instructivo (los pasos viajan por correo y el
            // prompt los re-entrega si preguntan cómo entrar), y el
            // ofrecimiento de nómina aparte. El primero se EMPUJA desde acá
            // (llega antes) y el segundo lo entrega Vicky como su respuesta.
            const msgAcceso =
              `El acceso quedó a nombre de ${b.admin.nombre} ${b.admin.apellido}. ` +
              `Le enviamos un correo a ${alta.workEmail} con su contraseña temporal.`
            // Nómina Y capacitación en la misma oferta (Lalo 05-sep, caso
            // Maquinarias Santa Sara: el cliente aceptó cargar la nómina, no la
            // mandó y nadie le ofreció el curso). La capacitación no depende de
            // la nómina.
            const msgNomina =
              "Y por aquí mismo seguimos con dos cosas: cargar a tus trabajadores para que puedan marcar, y agendar tu capacitación " +
              "(2 horas por videollamada con tu relator). ¿Partimos por la nómina o te muestro los horarios de la capacitación?"
            // Antes el del acceso se EMPUJABA aparte y Vicky entregaba solo el
            // de la nómina — pero el modelo volvía a contar el acceso en su
            // respuesta y el cliente recibía dos veces lo mismo (E8 05-sep:
            // "El acceso quedó a nombre de…" + "A egomez@ salió el acceso…").
            // Ahora van los dos en UN mensajeParaProspecto separados por [---]:
            // el webhook los parte en dos burbujas, en orden, y nada se repite.
            return {
              ok: true,
              accesoInformado: true,
              mensajeParaProspecto: `${msgAcceso}\n[---]\n${msgNomina}`,
              instruccionObligatoria:
                "Entrega el mensajeParaProspecto TAL CUAL (incluido el marcador [---]). NO agregues tu propio anuncio del acceso, del correo ni de la contraseña: ya viene ahí y repetirlo es doble mensaje.",
            }
          }
          // Creación falló → cae al alta manual (jamás perder un alta).
          console.warn(`[onboarding] alta por API falló (${alta.error}) — cae a alta manual`)
        }
        // existe === null (servicio caído): cae al alta manual.
      }

      // Alta MANUAL: sin API configurada o con el servicio caído, el aviso
      // lleva los datos ya normalizados, listos para pegar en la plataforma.
      await avisarEquipoInterno(`🆕 ALTA ONBOARDING CL (crear a mano) de +${contact}:\n${fichaAlta}`)
      await setKvValue(claveAltaSolicitada(contact), new Date().toISOString()).catch(() => {})
      return {
        ok: true,
        mensajeParaProspecto:
          "Listo, quedó solicitada la creación de tu cuenta 🎉 Queda activa dentro de 24 horas " +
          "hábiles y te aviso por este mismo chat con tu acceso. Cualquier duda mientras tanto, aquí estoy.",
      }
    }

    // Dudas de uso de la plataforma: el oráculo de soporte de siempre.
    if (name === consultarAgenteSoporteSchema.name)
      return dispatchTool(name, (input || {}) as Record<string, unknown>)

    return { ok: false, error: `Tool desconocida en fase onboarding: ${name}` }
  }

  return {
    // Con el alta ya solicitada, el agente pasa a la fase de CONFIGURACIÓN
    // (F2): nómina + turnos/planificaciones opcionales, con el candado
    // determinista. Antes del alta, el prompt y las tools son los del alta.
    systemPrompt: altaSolicitada
      ? await (async () => {
          const cfg = await cargarConfig()
          const faltas = pendientesConfiguracion(cfg)
          const altaVia = await getKvValue(claveAltaSolicitada(contact)).catch(() => null)
          const esquema = (await getKvValue(claveEsquema(contact))
            .then((v) => (v ? (JSON.parse(v) as EsquemaOperacion) : {}))
            .catch(() => ({}))) as EsquemaOperacion
          const yaOfrecido = !!(await getKvValue(claveEsquemaOfrecido(contact)).catch(() => null))
          const capRaw = await getKvValue(claveCapacitacion(contact)).catch(() => null)
          const nombreRelator = capRaw ? (JSON.parse(capRaw) as { relator?: { nombre?: string } }).relator?.nombre : undefined
          return promptConfiguracionCL({
            resumen: resumenConfiguracion(cfg),
            pendientes: faltas.map((f) => f.mensaje),
            nTrabajadores: cfg.trabajadores.length,
            altaCreada: /companyId/.test(String(altaVia || "")),
            bloqueEsquema: bloquePromptEsquema(esquema, { yaOfrecido, nombreRelator }),
          })
        })()
      : promptOnboardingCL(borrador, { altaSolicitada }),
    tools: {
      schemas: (altaSolicitada
        ? [
            TOOL_GUARDAR_NOMINA,
            TOOL_DEFINIR_TURNO,
            TOOL_ARMAR_PLANIFICACION,
            TOOL_ASIGNAR_PLANIFICACION,
            TOOL_ELIMINAR_TRABAJADOR,
            TOOL_CONFIRMAR_CONFIGURACION,
            TOOL_REGISTRAR_ESQUEMA_OPERACION,
            // La capacitación vive en la fase de CONFIGURACIÓN: recién ahí el
            // cliente ya tiene su cuenta y su implementación, que es de donde
            // sale el relator que le toca.
            TOOL_VER_CUPOS_CAPACITACION,
            TOOL_AGENDAR_CAPACITACION,
            TOOL_REAGENDAR_CAPACITACION,
            TOOL_CANCELAR_CAPACITACION,
            consultarAgenteSoporteSchema,
          ]
        : [
            TOOL_GUARDAR_DATOS_ONBOARDING,
            TOOL_CONFIRMAR_ALTA_EMPRESA,
            consultarAgenteSoporteSchema,
          ]) as unknown as unknown[],
      dispatch,
    },
  }
}
