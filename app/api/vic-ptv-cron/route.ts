/**
 * CRON — PTV: traspaso a vendedor por TTV + chequeo de calidad (doc "Vicky
 * paso a paso", 30-jul). Corre cada 10 min; con TTV mínimo de 15 el error
 * máximo de disparo es aceptable (doc no exige precisión al minuto).
 *
 * Cada tick:
 *  1. Barre conversaciones con actividad reciente cuyo ÚLTIMO mensaje es de
 *     Vicky, y les aplica debeTraspasar() (TTV 120/15 según precio, horario
 *     hábil del país, pausa anunciada suspende, sin traspaso activo previo).
 *  2. Ejecuta el PTV: vendedor por tómbola del país (round-robin persistido
 *     en vic_kv), presentación al prospecto por WhatsApp, asignación del
 *     lead/deal en Zoho, alerta interna "llamar en <5 min", y registro en
 *     vic_ptv con el chequeo agendado a 9 horas hábiles.
 *  3. Barre los chequeos vencidos y pregunta cómo le fue (solo con ventana
 *     de 24 h abierta; si está cerrada queda 'sin_respuesta').
 *
 * DETRÁS DE VICKY_PTV_ENABLED (apagado): responde skipped sin tocar nada.
 * Auth: misma del resto de los crons del repo.
 */

import { NextResponse } from "next/server"
import { extraerDatosLeadDeChat } from "@/lib/extraer-datos-chat"
import {
  ptvHabilitado,
  debeTraspasar,
  debeTraspasarEtapa,
  traspasoV2Habilitado,
  CALIFICACION_24H_MIN,
  minutosHabilesEntre,
  vendedoresDePais,
  mensajePresentacion,
  mensajeChequeo,
  sumarHorasHabiles,
} from "@/lib/ptv"
import { sendBotmakerMessage, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { contactosAtendidosPorVendedor, pagoRegistradoReciente, enFaseOnboarding } from "@/lib/loop-v2"
import { appendAssistantV3, getFollowupCronSecret, getKvValue, getQuotePointers, setKvValue } from "@/lib/supabase-persistence-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { paisDeContacto } from "@/lib/botmaker-tags"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { despacharHuerfanos } from "@/lib/despachador-huerfanos"
import { fichaEmpresaSii, rutEnTexto } from "@/lib/empresas-sii"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// 7 días, no 48 h (caso Fundación Amigos de Jesús / Residencia San Sebastián,
// 10-ago): sus relojes vencieron el viernes 08-ago — día en que el PTV no
// traspasó a NADIE — y el fin de semana las sacó de la ventana de 48 h, así
// que el lunes el motor sano ya no las veía. Un reloj vencido no puede
// prescribir por un feriado largo o una caída: 7 días cubre cualquier hoyo
// de viernes a lunes con margen. El candado UNIQUE de vic_ptv hace inocuo
// re-mirar conversaciones viejas ya traspasadas.
const VENTANA_BARRIDO_MS = 7 * 24 * 3600_000
const VENTANA_META_MS = 24 * 3600_000
const MAX_TRASPASOS_POR_TICK = 15

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

async function supa<T>(path: string, init: RequestInit = {}): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
  if (!res.ok) return []
  return ((await res.json().catch(() => [])) as T[]) || []
}

/** Feriados vigentes desde vic_holidays (best-effort, formato defensivo). */
async function feriadosDePais(pais: string): Promise<Set<string>> {
  const filas = await supa<Record<string, unknown>>(`vic_holidays?select=*&limit=500`)
  const set = new Set<string>()
  for (const f of filas) {
    // La columna real de vic_holidays es `d` (hallazgo 04-ago: con los otros
    // nombres el set salía vacío y los feriados JAMÁS se aplicaban).
    const fecha = String(f.d || f.date || f.fecha || f.holiday_date || "").slice(0, 10)
    const p = String(f.country || f.pais || "").toLowerCase()
    if (fecha && (!p || p === pais)) set.add(fecha)
  }
  return set
}

/**
 * NOTA DE TRASPASO CON LA CONVERSACIÓN (Lalo 13-ago, para los SDR Inbound MX):
 * al entregar un lead, se le pega como nota de Zoho la URL directa al chat en
 * Botmaker + el transcript reciente, para que el SDR llegue con TODO el
 * contexto sin pedir accesos. Best-effort: jamás frena el traspaso.
 */
async function notaTraspasoConversacion(leadId: string, fono: string): Promise<void> {
  if (!leadId || !fono) return
  try {
    // URL directa al chat en Botmaker (mismo lookup O(1) de crm/zoho-lead).
    let chatUrl = ""
    const bmToken = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
    if (bmToken) {
      const res = await fetch(
        `https://api.botmaker.com/v2.0/chats?contactId=${fono.replace(/\D/g, "")}&limit=1`,
        { headers: { "access-token": bmToken, Accept: "application/json" }, cache: "no-store" },
      ).catch(() => null)
      if (res?.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          items?: Array<{ chat?: { chatId?: string } }>
        }
        const chatId = data?.items?.[0]?.chat?.chatId
        if (chatId) chatUrl = `https://go.botmaker.com/#/chats/${chatId}`
      }
    }
    // Transcript reciente (últimos 25 mensajes, orden cronológico).
    const conv = await supa<{ id: string }>(
      `vic_v3_conversations?contact=eq.${fono}&select=id&limit=1`,
    )
    let transcript = ""
    if (conv[0]?.id) {
      const msgs = await supa<{ role: string; content: string; at: string }>(
        `vic_v3_messages?conversation_id=eq.${conv[0].id}&select=role,content,at&order=at.desc&limit=25`,
      )
      transcript = msgs
        .reverse()
        .filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
        .map((m) => `${String(m.at || "").slice(11, 16)} ${m.role === "user" ? "CLIENTE" : "Vicky"}: ${String(m.content || "").slice(0, 500)}`)
        .join("\n")
    }
    const contenido =
      (chatUrl
        ? `👉 Habla directo con el prospecto en Botmaker: ${chatUrl}\n\n`
        : "👉 Chat en Botmaker: busca el contacto +" + fono + " en go.botmaker.com\n\n") +
      (transcript
        ? `CONVERSACIÓN RECIENTE CON VICKY:\n${transcript}`
        : "SIN CONVERSACIÓN: este contacto no ha escrito por WhatsApp (típico: llenó el formulario de la landing y no siguió al chat). No hay transcript que buscar en el bot — llamar directo.")
    const { agregarNotaLead } = await import("@/lib/zoho-leads")
    await agregarNotaLead(leadId, "Traspaso de Vicky — conversación y chat directo", contenido)
  } catch (e) {
    console.warn(`[ptv] nota de traspaso no creada para lead ${leadId}:`, e instanceof Error ? e.message : e)
  }
}

/**
 * ENRIQUECIMIENTO DE LEADS DESDE EL CHAT (Lalo 13-ago: "es muy confuso que
 * sigan apareciendo leads con nombre Prospecto WhatsApp"). Cada tick toma
 * hasta 6 leads placeholder recientes (Prospecto WhatsApp / Por identificar),
 * lee su conversación, extrae con Haiku los datos que el CLIENTE dio
 * (nombre, empresa, email, dotación) y completa SOLO los campos placeholder o
 * vacíos del lead — jamás pisa datos reales ni gestión. Candado de intento de
 * 6h por lead en vic_kv (`enrq_<leadId>`) para no martillar. Best-effort.
 */
// El lead placeholder nace con nombre "Prospecto WhatsApp", y Zoho lo PARTE
// en First_Name="Prospecto" + Last_Name="WhatsApp". Mirar solo el apellido
// (bug hasta el 14-ago) hacía que la condición no calzara NUNCA: el nombre
// jamás se completaba, y por eso Lalo seguía viendo "Prospecto WhatsApp" en
// leads donde el cliente sí se había presentado.
const RE_NOMBRE_PLACEHOLDER = /^(prospecto|whatsapp|prospecto whatsapp)$/i
const RE_EMPRESA_PLACEHOLDER = /^(por identificar|prospecto whatsapp)/i

/** ¿El nombre del registro sigue siendo el placeholder? Se evalúa el nombre
 * COMPLETO, no una de sus mitades. */
function nombreEsPlaceholder(first?: string, last?: string): boolean {
  const f = String(first || "").trim()
  const l = String(last || "").trim()
  const completo = `${f} ${l}`.trim()
  if (!completo) return true
  if (RE_NOMBRE_PLACEHOLDER.test(completo)) return true
  return (!f || RE_NOMBRE_PLACEHOLDER.test(f)) && (!l || RE_NOMBRE_PLACEHOLDER.test(l))
}

/** PUT genérico a Zoho para los registros que NACIERON del lead. Los updates
 * que no pasan por una assignment rule llevan skip (regla Lalo 31-jul). */
async function putZoho(
  api: string,
  H: Record<string, string>,
  modulo: string,
  id: string,
  campos: Record<string, unknown>,
): Promise<boolean> {
  try {
    const r = await fetch(`${api}/crm/v3/${modulo}/${id}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id, ...campos }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

// extraerDatosLeadDeChat vive en lib/extraer-datos-chat (compartido con el
// traspaso y el hito por chat desde el 07-sep).

/**
 * CONCILIACIÓN DE ESTADO DEL LEAD CONTRA LA CONVERSACIÓN (Eduardo 14-ago).
 *
 * Diagnóstico del 14-ago: "3. Contactado" solo se estampaba en el camino
 * OUTBOUND (la primera respuesta a un toque 0). El lead INBOUND —el que nace
 * porque el cliente escribió— quedaba en "1. No contactado" hasta que
 * ocurriera un HITO, que lo salta directo a "4. Calificado". Sin hito, el
 * status no se movía nunca: 20 leads con el cliente conversando (uno con 26
 * mensajes) seguían figurando como no contactados.
 *
 * Reglas, todas conservadoras:
 *  - El status SOLO SUBE. Cliente que escribió → "3. Contactado"; precio
 *    mostrado o cotización formal → "4. Calificado".
 *  - "No Calificado" NO se toca: es una decisión humana del SDR y tiene su
 *    propia regla de reactivación en el proceso de marketing.
 *  - Los PROPIETARIOS no se tocan en ningún caso.
 *  - "Fecha/Hora Primer Cambio Estado Lead" (Fecha_de_Primera_revision_Lead)
 *    se corrige al momento REAL del hito, y solo si está vacía o es POSTERIOR:
 *    la primera vez es la primera, jamás se atrasa una fecha ya registrada.
 *    Hoy se estampa al crear el lead, así que un lead creado por el reloj de
 *    calificación en agosto para una conversación de julio declara un cambio
 *    de estado que ocurrió semanas antes.
 */
const ORDEN_STATUS_LEAD: Record<string, number> = {
  "1. No contactado": 1,
  "2. Intento de contacto": 2,
  "3. Contactado": 3,
  "4. Calificado": 4,
}

/** Zoho quiere ISO con offset; Supabase entrega "2026-08-12 11:23:17.12+00". */
function isoZoho(v: string): string {
  const t = Date.parse(String(v || "").replace(" ", "T"))
  if (!Number.isFinite(t)) return ""
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

async function conciliarStatusLeads(): Promise<number> {
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const desde = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10)
    // Solo los estados que pueden estar atrasados. "No Calificado" queda fuera
    // a propósito. Se suman los que no tienen fecha de primer cambio, aunque
    // ya estén calificados: ese campo también hay que dejarlo cuadrado.
    const q =
      `select id, Phone, Lead_Status, Fecha_de_Primera_revision_Lead from Leads ` +
      `where (((Created_Time >= '${desde}T00:00:00-04:00') and (Canal = 'WhatsApp')) and ` +
      `((((Lead_Status = '1. No contactado') or (Lead_Status = '2. Intento de contacto')) ` +
      `or (Lead_Status = '3. Contactado')) or (Fecha_de_Primera_revision_Lead is null))) ` +
      `order by Created_Time desc limit 40`
    const res = await fetch(`${api}/crm/v3/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ select_query: q }),
    })
    if (!res.ok) {
      console.warn(`[ptv] status-leads: COQL ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
      return 0
    }
    const filas = (((await res.json().catch(() => ({}))) as {
      data?: Array<{
        id: string
        Phone?: string
        Lead_Status?: string
        Fecha_de_Primera_revision_Lead?: string | null
      }>
    }).data || [])
    let hechos = 0
    for (const ld of filas) {
      if (hechos >= 10) break
      const fono = String(ld.Phone || "").replace(/\D/g, "")
      if (!fono) continue
      const kvKey = `stsq_${ld.id}`
      const vivo = await supa<{ key: string; expires_at?: string }>(
        `vic_kv?key=eq.${kvKey}&select=key,expires_at&limit=1`,
      )
      if (vivo[0] && (!vivo[0].expires_at || new Date(vivo[0].expires_at).getTime() > Date.now())) continue
      await supa(`vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: kvKey,
          value: new Date().toISOString(),
          expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
        }),
      }).catch(() => [])

      const conv = await supa<{
        first_user_at?: string | null
        user_msg_count?: number
        pref_escalon_at?: string | null
        formal_quote_at?: string | null
        formal_quote_id?: string | null
      }>(
        `vic_v3_conversations?contact=eq.${fono}` +
          `&select=first_user_at,user_msg_count,pref_escalon_at,formal_quote_at,formal_quote_id&limit=1`,
      )
      const c = conv[0]
      if (!c) continue

      // Hito más alto que respalde la conversación, con SU fecha real.
      let objetivo = ""
      let momento = ""
      const precioAt = c.pref_escalon_at || ""
      const formalAt = c.formal_quote_at || (c.formal_quote_id ? c.first_user_at || "" : "")
      if (precioAt || formalAt) {
        objetivo = "4. Calificado"
        const cand = [precioAt, formalAt].filter(Boolean).map((x) => Date.parse(String(x).replace(" ", "T")))
        momento = new Date(Math.min(...cand)).toISOString().replace(/\.\d{3}Z$/, "+00:00")
      } else if ((c.user_msg_count || 0) >= 1 && c.first_user_at) {
        objetivo = "3. Contactado"
        momento = isoZoho(c.first_user_at)
      }
      if (!objetivo || !momento) continue

      const actual = ORDEN_STATUS_LEAD[String(ld.Lead_Status || "").trim()] || 0
      const meta = ORDEN_STATUS_LEAD[objetivo] || 0
      let tocado = false

      if (meta > actual) {
        // ESCALÓN POR ESCALÓN: el Lead_Status vive bajo Blueprint y solo
        // existen transiciones entre estados CONSECUTIVOS. Pedir el salto de
        // "2. Intento de contacto" a "4. Calificado" de una vez devolvía
        // éxito sin mover nada (dos leads CO con precio dado se quedaron en
        // 2). Se sube de a un peldaño hasta llegar al objetivo.
        const { updateZohoLeadStatus } = await import("@/lib/zoho-leads")
        const escalera = Object.entries(ORDEN_STATUS_LEAD)
          .filter(([, n]) => n > actual && n <= meta)
          .sort((a2, b2) => a2[1] - b2[1])
          .map(([nombre]) => nombre)
        for (const paso of escalera) {
          const r = await updateZohoLeadStatus(ld.id, paso).catch(() => ({ success: false }))
          if (!r.success) {
            console.warn(`[ptv] lead ${ld.id} no pudo subir a "${paso}" — se detiene la escalera`)
            break
          }
          tocado = true
          console.log(`[ptv] lead ${ld.id} status → "${paso}" (conversación, objetivo "${objetivo}")`)
        }
      }

      // La fecha del PRIMER cambio de estado: vacía o posterior al hito real.
      const fechaActual = Date.parse(String(ld.Fecha_de_Primera_revision_Lead || "").replace(" ", "T"))
      const fechaHito = Date.parse(momento)
      if (!Number.isFinite(fechaActual) || fechaActual > fechaHito) {
        const ok = await putZoho(api, H, "Leads", ld.id, {
          Fecha_de_Primera_revision_Lead: momento,
        })
        if (ok) {
          tocado = true
          console.log(
            `[ptv] lead ${ld.id} fecha primer cambio ${ld.Fecha_de_Primera_revision_Lead || "vacía"} → ${momento}`,
          )
        }
      }
      if (tocado) hechos++
    }
    return hechos
  } catch (e) {
    console.warn("[ptv] conciliarStatusLeads falló:", e instanceof Error ? e.message : e)
    return 0
  }
}

/**
 * CONCILIACIÓN DE ASIGNACIÓN EN BOTMAKER (Lalo 14-ago: "la fuente de la
 * verdad es Zoho"). Recorre las conversaciones con cursor propio y deja cada
 * chat asignado al dueño VIGENTE de su registro. Sirve de barrido retroactivo
 * y, pasada la primera vuelta, de reconciliador permanente: si la tómbola
 * cambia al dueño, la conversación lo sigue.
 *
 * Conservadora: solo asigna si el chat NO tiene ya a esa persona, si el
 * correo existe como agente y si el dueño no es un usuario-bot. Best-effort.
 */
async function conciliarAsignacionBotmaker(): Promise<{
  asignadas: number
  revisadas: number
  notas: number
}> {
  try {
    // SIN CURSOR DE OFFSET (corregido 15-ago). Estaba paginando por offset
    // sobre `order=updated_at.desc`, y ese orden CAMBIA entre ticks: cada
    // conversación que recibe un mensaje salta al tope y corre la ventana, así
    // que había conversaciones que el barrido nunca alcanzaba a visitar — un
    // hoyo invisible, porque el contador seguía avanzando igual.
    //
    // Ahora manda la marca de sincronía: primero las que NUNCA se revisaron
    // (zoho_link_at nulo) y después las más antiguas. Es auto-reparable — no
    // hay estado que se desincronice — y cuando la primera vuelta termina, el
    // barrido sigue solo, refrescando lo más viejo.
    const lote = 12
    const convs = await supa<{ contact: string }>(
      `vic_v3_conversations?select=contact,zoho_link_at&order=zoho_link_at.asc.nullsfirst&limit=${lote}`,
    )
    if (!convs.length) return { asignadas: 0, revisadas: 0, notas: 0 }
    const fonos = convs.map((c) => String(c.contact || "").replace(/\D/g, "")).filter(Boolean)
    const fichas = await duenosEnZohoPorTelefono(fonos)
    // Hitos comerciales del lote, para decidir si vale crear lo que falta.
    const listaFonos = fonos.join(",")
    const punterosLote = await supa<{ contact: string }>(
      `vic_v3_quote_pointers?select=contact&contact=in.(${listaFonos})`,
    )
    const reunionesLote = await supa<{ contact: string }>(
      `vic_v3_meetings?select=contact&contact=in.(${listaFonos})`,
    )
    const conCotizacion = new Set(punterosLote.map((p) => String(p.contact || "").replace(/\D/g, "")))
    const conReunionSet = new Set(reunionesLote.map((m) => String(m.contact || "").replace(/\D/g, "")))
    const { asignarConversacionAlDueno, leerChat, chatRefDeContacto } = await import("@/lib/botmaker-agentes")
    let asignadas = 0
    let notasRefrescadas = 0
    for (const fono of fonos) {
      const ficha = fichas.get(fono)
      if (!ficha) {
        // NADA en el CRM y la conversación TIENE hito comercial: se dispara el
        // hito para que nazca el registro (Lalo 15-ago). La conciliación
        // anotaba lo existente pero no creaba lo faltante, así que un fallo
        // puntual de la creación en vivo quedaba como hueco para siempre.
        // Guardas: país reconocible y cotización o reunión de verdad — nunca
        // por una conversación suelta ni por un id de Instagram.
        const tieneHito =
          conCotizacion.has(fono) || conReunionSet.has(fono)
        if (!tieneHito || !chatRefDeContacto(fono)) continue
        const { sincronizarHitoCrm } = await import("@/lib/crm-hitos")
        await sincronizarHitoCrm(fono, "intencion", {}).catch(() => undefined)
        console.log(`[ptv] +${fono}: hito comercial sin registro — lead disparado por la conciliación`)
        continue
      }
      const chat = await leerChat(chatRefDeContacto(fono)).catch(() => null)

      // 1) El LINK a la conversación, en el lead y en su trato. Va siempre,
      //    tenga o no agente: es trazabilidad, no asignación.
      const punterosLink = await getQuotePointers(fono).catch(() => [])
      const dealDelPuntero = punterosLink.find((p) => p.dealId)?.dealId
      if (chat?.chatId) {
        const url = `https://go.botmaker.com/#/chats/${chat.chatId}`
        if (ficha.leadId) {
          const ok = await guardarLinkChat("Leads", ficha.leadId, url, ficha.linkChat)
          if (ok) console.log(`[ptv] +${fono}: link de conversación guardado en el lead`)
        }
        if (dealDelPuntero) await guardarLinkChat("Deals", String(dealDelPuntero), url)
      }
      // Y el vínculo al revés: la conversación guarda los ids de Zoho, para
      // que el cruce no dependa de re-buscar por teléfono (que en Zoho está
      // escrito de cuatro formas distintas).
      if (ficha.leadId || dealDelPuntero) {
        const { vincularZohoAConversacion } = await import("@/lib/supabase-persistence-v3")
        await vincularZohoAConversacion(fono, {
          leadId: ficha.leadId,
          dealId: dealDelPuntero ? String(dealDelPuntero) : null,
        }).catch(() => undefined)
        // Y al registro único de ids: lo viejo también queda anotado, con la
        // cotización que ya vivía en el puntero.
        const { registrarEnZoho } = await import("@/lib/registro-zoho")
        await registrarEnZoho(
          fono,
          [
            { modulo: "Leads", id: ficha.leadId },
            { modulo: "Deals", id: dealDelPuntero ? String(dealDelPuntero) : null },
            ...punterosLink
              .filter((p) => p.quoteId)
              .map((p) => ({ modulo: "Cotizaciones_GeoVictoria" as const, id: p.quoteId })),
          ],
          { origen: "conciliacion" },
        ).catch(() => 0)
      }

      // 2) UNA nota de transcripción por registro, siempre al día: se
      //    actualiza la que exista, y si no hay ninguna y hay conversación,
      //    nace la que de ahora en adelante se irá refrescando.
      const registros: Array<{ modulo: string; id: string }> = []
      if (ficha.leadId) registros.push({ modulo: "Leads", id: ficha.leadId })
      if (dealDelPuntero) registros.push({ modulo: "Deals", id: String(dealDelPuntero) })
      if (registros.length) {
        const { sincronizarNotaTranscripcion } = await import("@/lib/crm-hitos")
        const n = await sincronizarNotaTranscripcion(fono, registros).catch(() => 0)
        if (n) {
          notasRefrescadas += n
          console.log(`[ptv] +${fono}: ${n} nota(s) de transcripción al día`)
        }
      }

      // 3) La ASIGNACIÓN. Zoho es la fuente de la verdad (Lalo 15-ago), así
      //    que además de asignar el chat sin dueño, se REASIGNA cuando el
      //    agente actual ya no es el dueño del registro: si la tómbola movió
      //    el trato, la conversación lo sigue. Antes solo se tocaba el chat
      //    vacío y una reasignación en el CRM dejaba la conversación con el
      //    ejecutivo anterior para siempre.
      //    Rollback sin deploy: VICKY_BM_NO_REASIGNAR=1.
      if (!ficha.owner) continue
      if (chat?.agentId) {
        if ((process.env.VICKY_BM_NO_REASIGNAR || "") === "1") continue
        const { listarAgentes } = await import("@/lib/botmaker-agentes")
        const agentes = await listarAgentes().catch(() => [])
        const idDelDueno = agentes.find(
          (a) => String(a.email || "").toLowerCase() === ficha.owner.toLowerCase(),
        )?.id
        // Sin id del dueño no se toca nada: mejor dejarlo con quien está que
        // mandarlo a la cola y que le caiga a cualquiera.
        if (!idDelDueno || idDelDueno === chat.agentId) continue
      }
      const r = await asignarConversacionAlDueno(fono, ficha.owner)
      if (r.asignado) {
        asignadas++
        console.log(
          `[ptv] +${fono}: conversación ${chat?.agentId ? "REasignada" : "asignada"} a ${ficha.owner}`,
        )
      }
    }
    // Se marcan como revisadas SIEMPRE, aunque no hubiera nada que hacer:
    // sin eso el barrido volvería a tomar las mismas 12 en cada tick.
    const { marcarConversacionesRevisadas } = await import("@/lib/supabase-persistence-v3")
    await marcarConversacionesRevisadas(fonos).catch(() => undefined)
    return { asignadas, revisadas: convs.length, notas: notasRefrescadas }
  } catch (e) {
    console.warn("[ptv] conciliarAsignacionBotmaker falló:", e instanceof Error ? e.message : e)
    return { asignadas: 0, revisadas: 0, notas: 0 }
  }
}

type FichaZoho = { owner: string; leadId?: string; linkChat?: string | null }

/** Dueño vigente en Zoho por teléfono + el id del lead y su link de chat
 * actual. El CONTACTO (lead ya convertido) manda sobre el lead como dueño,
 * porque es el registro vivo de la relación. */
async function duenosEnZohoPorTelefono(fonos: string[]): Promise<Map<string, FichaZoho>> {
  const out = new Map<string, FichaZoho>()
  if (!fonos.length) return out
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const lista = fonos.map((f) => `'+${f}'`).join(",")
    const coql = async (q: string) => {
      const r = await fetch(`${api}/crm/v3/coql`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ select_query: q }),
      })
      if (!r.ok) return []
      return (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || [])
    }
    for (const f of await coql(
      `select id, Phone, Owner.email, ${CAMPO_LINK_CHAT} from Leads where ((Phone in (${lista}))) limit 200`,
    )) {
      const fono = String(f.Phone || "").replace(/\D/g, "")
      const correo = String(f["Owner.email"] || "")
      if (!fono) continue
      out.set(fono, {
        owner: correo,
        leadId: String(f.id || ""),
        linkChat: (f[CAMPO_LINK_CHAT] as string) || null,
      })
    }
    for (const f of await coql(
      `select Phone, Owner.email from Contacts where ((Phone in (${lista}))) limit 200`,
    )) {
      const fono = String(f.Phone || "").replace(/\D/g, "")
      const correo = String(f["Owner.email"] || "")
      if (fono && correo) out.set(fono, { ...(out.get(fono) || {}), owner: correo })
    }
  } catch (e) {
    console.warn("[ptv] duenosEnZohoPorTelefono falló:", e instanceof Error ? e.message : e)
  }
  return out
}

/**
 * Campo del CRM con el link a la conversación. Hay dos con nombre parecido en
 * Leads; se verificó el 15-ago cuál está POBLADO: `Conversaci_n_Botmaker`
 * (textarea) lo está y trae `https://go.botmaker.com/#/chats/<chatId>`;
 * `Conversaci_n_en_Botmaker` está vacío en el 100% de los registros y queda
 * para borrar en la consola. El mismo API name existe en Deals.
 */
const CAMPO_LINK_CHAT = (process.env.ZOHO_CAMPO_LINK_CHAT || "Conversaci_n_Botmaker").trim()

/** Escribe el link de la conversación en el registro si falta o cambió. */
async function guardarLinkChat(
  modulo: string,
  registroId: string,
  url: string,
  actual?: string | null,
): Promise<boolean> {
  if (!registroId || !url || (actual || "").trim() === url) return false
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(`${api}/crm/v3/${modulo}/${registroId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: registroId, [CAMPO_LINK_CHAT]: url }],
        // Escribir el link no puede re-sortear al dueño.
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

/** Reintenta los correos internos de PAGADA por transferencia que quedaron
 * pendientes (marcas notify_pagada_pend_<quoteId> en vic_kv, dejadas por
 * notificarPagadaAlCotizador cuando el cotizador no confirmó). Entregado →
 * se borra la marca; más de 48h → se descarta con grito en el log. */
async function reintentarNotifyPagadaPendientes(): Promise<number> {
  const filas = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.notify_pagada_pend_*&select=key,value&limit=5`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  ).then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ key: string; value: string }>
  if (!filas.length) return 0
  const base = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
  const secret = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
  if (!secret) return 0
  const borrar = (key: string) =>
    fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    }).catch(() => undefined)
  // La marca puede ser el ISO pelado (formato viejo) o {at, intentos}.
  const leerMarca = (v: string): { at: string; intentos: number } => {
    try {
      const j = JSON.parse(v) as { at?: string; intentos?: number }
      if (j && typeof j === "object" && j.at) return { at: String(j.at), intentos: Number(j.intentos || 0) }
    } catch {}
    return { at: String(v || ""), intentos: 0 }
  }
  const anotarIntento = (key: string, at: string, intentos: number) =>
    fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify({ at, intentos }) }),
      cache: "no-store",
    }).catch(() => undefined)
  // TOPE DE INTENTOS (02-sep, incidente COT1142: SIETE avisos idénticos en 11
  // minutos). El endpoint puede MANDAR el correo y aun así no confirmarlo a
  // tiempo; sin tope, la marca vive 48h y el cron reenvía cada ~2 min. Tres
  // intentos y se descarta: un aviso interno perdido se recupera mirando la
  // cotización, una lluvia de correos quema al equipo.
  const MAX_INTENTOS = 3
  let entregados = 0
  for (const fila of filas) {
    const quoteId = fila.key.replace(/^notify_pagada_pend_/, "")
    const marca = leerMarca(fila.value)
    const edadMs = Date.now() - new Date(marca.at || 0).getTime()
    if (!quoteId || !Number.isFinite(edadMs) || edadMs > 48 * 3600 * 1000) {
      console.warn(`[ptv-cron] notify-paid pendiente DESCARTADO (48h) quote=${quoteId}`)
      await borrar(fila.key)
      continue
    }
    if (marca.intentos >= MAX_INTENTOS) {
      console.warn(`[ptv-cron] notify-paid pendiente DESCARTADO (${marca.intentos} intentos) quote=${quoteId}`)
      await borrar(fila.key)
      continue
    }
    await anotarIntento(fila.key, marca.at, marca.intentos + 1)
    const r = await fetch(`${base}/api/payments/notify-paid?quoteId=${encodeURIComponent(quoteId)}`, {
      method: "POST",
      headers: { "x-vicky-secret": secret },
      cache: "no-store",
    }).catch(() => null)
    if (r?.ok) {
      entregados += 1
      await borrar(fila.key)
      console.log(`[ptv-cron] correo PAGADA reintentado OK quote=${quoteId}`)
    }
  }
  return entregados
}

async function enriquecerLeadsDeChat(): Promise<number> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return 0
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    // Ventana de 60 días: con 14 quedaban fuera las 51 fichas del lote del
    // 29-jul, que es justo donde se concentra el "Prospecto WhatsApp" que se
    // ve en el CRM. La ventana existe para no barrer el histórico completo en
    // cada tick, no para dejar cohortes sin conciliar.
    const desde = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10)
    // COQL exige que CADA comparación vaya entre paréntesis y que las
    // combinaciones se aniden de a dos. Sin eso responde SYNTAX_ERROR — y
    // como el error se traga con `return 0`, este conciliador llevaba desde
    // el 13-ago sin ejecutarse una sola vez (0 leads tocados en 38 casos).
    // Hay DOS formas de placeholder según quién creó el lead: la del ptv-cron
    // (nombre "Prospecto WhatsApp" / empresa "Por identificar…") y la de
    // createZohoLead (Last_Name "Prospecto" / Company "Prospecto WhatsApp").
    // La segunda no calzaba con este where y esos leads quedaban invisibles
    // para siempre (caso Daffne/Claudia Martínez, 18-ago).
    const q =
      `select id, First_Name, Last_Name, Company, Phone, Email, RUT_Empresa from Leads ` +
      `where (((((First_Name = 'Prospecto') or (Last_Name = 'Prospecto WhatsApp')) ` +
      `or ((Last_Name = 'Prospecto') or (Company = 'Prospecto WhatsApp'))) ` +
      `or (Company like 'Por identificar%')) and (Created_Time >= '${desde}T00:00:00-04:00')) ` +
      `order by Created_Time desc limit 25`
    const res = await fetch(`${api}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }),
    })
    if (!res.ok) {
      console.warn(`[ptv] enriquecimiento: COQL ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
      return 0
    }
    const filas = (((await res.json().catch(() => ({}))) as {
      data?: Array<{
        id: string
        First_Name?: string
        Last_Name?: string
        Company?: string
        Phone?: string
        Email?: string
        RUT_Empresa?: string
      }>
    }).data || [])
    let hechos = 0
    for (const ld of filas) {
      if (hechos >= 10) break
      const fono = String(ld.Phone || "").replace(/\D/g, "")
      if (!fono) continue
      // Candado de intento: un lead se procesa a lo más una vez cada 6h.
      const kvKey = `enrq_${ld.id}`
      const vivo = await supa<{ key: string; expires_at?: string }>(
        `vic_kv?key=eq.${kvKey}&select=key,expires_at&limit=1`,
      )
      if (vivo[0] && (!vivo[0].expires_at || new Date(vivo[0].expires_at).getTime() > Date.now())) continue
      await supa(`vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: kvKey, value: new Date().toISOString(),
          expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
        }),
      }).catch(() => [])
      const conv = await supa<{ id: string; user_msg_count?: number }>(
        `vic_v3_conversations?contact=eq.${fono}&select=id,user_msg_count&limit=1`,
      )
      if (!conv[0]?.id || (conv[0].user_msg_count || 0) < 1) continue
      const msgs = await supa<{ role: string; content: string }>(
        `vic_v3_messages?conversation_id=eq.${conv[0].id}&select=role,content&order=at.asc&limit=40`,
      )
      const dialogo = msgs
        .filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
        .map((m) => `${m.role === "user" ? "CLIENTE" : "VICKY"}: ${String(m.content || "").slice(0, 300)}`)
        .join("\n")
        .slice(0, 6000)
      if (!dialogo.includes("CLIENTE:")) continue
      const ex = await extraerDatosLeadDeChat(dialogo, apiKey)
      // El RUT NO se le pide al modelo: se detecta con el validador de dígito
      // verificador sobre lo que escribió el CLIENTE. De ahí sale la razón
      // social del padrón SII — desde el 13-ago Vicky ya no pregunta el
      // nombre de la empresa (era fricción), así que el RUT es la ÚNICA
      // fuente confiable para dejar de ver "Por identificar" en el CRM.
      const soloCliente = dialogo
        .split("\n")
        .filter((l) => l.startsWith("CLIENTE:"))
        .join("\n")
      const rutChat = fono.startsWith("56") ? rutEnTexto(soloCliente) : null
      let razonSii = ""
      if (rutChat) {
        const ficha = await fichaEmpresaSii(rutChat).catch(() => null)
        razonSii = ficha?.razonSocial || ""
      }
      if (!ex && !rutChat) continue
      const empresaNueva = (ex?.empresa || razonSii || "").slice(0, 200)
      const nombreCliente = ex?.nombre || ""

      const campos: Record<string, string> = {}
      if (nombreCliente && nombreEsPlaceholder(ld.First_Name, ld.Last_Name)) {
        const partes = nombreCliente.split(/\s+/)
        if (partes[0]) campos.First_Name = partes[0].slice(0, 100)
        campos.Last_Name = (partes.slice(1).join(" ") || partes[0] || "").slice(0, 100) || "Prospecto"
      }
      if (empresaNueva && RE_EMPRESA_PLACEHOLDER.test(String(ld.Company || "").trim())) {
        campos.Company = empresaNueva
      }
      // Conciliación del campo EMPRESA (Lalo 20-ago): lead con NOMBRE real
      // (recién extraído o ya renombrado antes) pero Empresa aún en
      // placeholder y sin razón social disponible → se deja "-" (el campo es
      // obligatorio en Leads, no acepta vacío). "Ximena Godoy / Prospecto
      // WhatsApp" despistaba más que un guion.
      const nombreRealConocido = Boolean(nombreCliente) || !nombreEsPlaceholder(ld.First_Name, ld.Last_Name)
      if (!campos.Company && nombreRealConocido && RE_EMPRESA_PLACEHOLDER.test(String(ld.Company || "").trim())) {
        campos.Company = "-"
      }
      if (ex?.email && !String(ld.Email || "").trim()) campos.Email = ex.email
      if (rutChat && !String(ld.RUT_Empresa || "").trim()) campos.RUT_Empresa = rutChat
      if (ex?.trabajadores) {
        const { mapRangoEmpleados } = await import("@/lib/zoho-leads")
        const rango = mapRangoEmpleados(ex.trabajadores)
        if (rango) campos.Rango_de_Empleados = rango
      }
      if (Object.keys(campos).length === 0) continue

      // ¿DÓNDE va el dato? Mientras el lead está vivo, en el lead. Una vez
      // CONVERTIDO, el lead queda congelado y lo que la gente mira son el
      // trato, la cuenta y el contacto: ahí hay que ir a dejarlo (Lalo
      // 14-ago). El propio lead guarda a dónde fue: Converted_Deal /
      // Converted_Account / Converted_Contact.
      // ¿Está convertido? COQL no expone Converted__s en esta org
      // (INVALID_QUERY, verificado 14-ago), así que se le pregunta al propio
      // lead — son 6 registros por tick, el costo es irrelevante.
      const det = await fetch(
        `${api}/crm/v3/Leads/${ld.id}?fields=Converted_Deal,Converted_Account,Converted_Contact`,
        { headers: H, cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      const reg = ((det as { data?: Array<Record<string, { id?: string } | null>> } | null)?.data ||
        [])[0] as Record<string, { id?: string } | null> | undefined
      const dealId = reg?.Converted_Deal?.id || ""
      const accountId = reg?.Converted_Account?.id || ""
      const contactId = reg?.Converted_Contact?.id || ""
      if (dealId || accountId || contactId) {
        let tocados = 0
        if (dealId && (campos.Company || campos.RUT_Empresa)) {
          const dealActual = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Deal_Name,Rut_ID_Account`, {
            headers: H,
            cache: "no-store",
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
          const d = ((dealActual as { data?: Array<Record<string, unknown>> } | null)?.data || [])[0] || {}
          const nombreDeal = String(d.Deal_Name || "")
          const campoDeal: Record<string, unknown> = {}
          if (campos.Company && RE_EMPRESA_PLACEHOLDER.test(nombreDeal)) {
            campoDeal.Deal_Name = `${campos.Company} (Control de Asistencia)`
          }
          if (campos.RUT_Empresa && !String(d.Rut_ID_Account || "").trim()) {
            campoDeal.Rut_ID_Account = campos.RUT_Empresa
          }
          if (Object.keys(campoDeal).length && (await putZoho(api, H, "Deals", dealId, campoDeal))) tocados++
        }
        if (accountId && campos.Company) {
          const cuentaActual = await fetch(`${api}/crm/v3/Accounts/${accountId}?fields=Account_Name`, {
            headers: H,
            cache: "no-store",
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
          const ac = ((cuentaActual as { data?: Array<Record<string, unknown>> } | null)?.data || [])[0] || {}
          if (RE_EMPRESA_PLACEHOLDER.test(String(ac.Account_Name || ""))) {
            if (await putZoho(api, H, "Accounts", accountId, { Account_Name: campos.Company })) tocados++
          }
        }
        if (contactId && (campos.First_Name || campos.Email)) {
          const contactoActual = await fetch(
            `${api}/crm/v3/Contacts/${contactId}?fields=First_Name,Last_Name,Email`,
            { headers: H, cache: "no-store" },
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
          const co = ((contactoActual as { data?: Array<Record<string, unknown>> } | null)?.data || [])[0] || {}
          const campoCont: Record<string, unknown> = {}
          if (campos.First_Name && nombreEsPlaceholder(String(co.First_Name || ""), String(co.Last_Name || ""))) {
            campoCont.First_Name = campos.First_Name
            campoCont.Last_Name = campos.Last_Name
          }
          if (campos.Email && !String(co.Email || "").trim()) campoCont.Email = campos.Email
          if (Object.keys(campoCont).length && (await putZoho(api, H, "Contacts", contactId, campoCont))) tocados++
        }
        if (tocados) {
          hechos++
          console.log(
            `[ptv] lead ${ld.id} CONVERTIDO — dato llevado a ${tocados} registro(s) vivos: ${Object.keys(campos).join(", ")}`,
          )
        }
        continue
      }

      const { updateZohoLeadFields } = await import("@/lib/zoho-leads")
      const ok = await updateZohoLeadFields(ld.id, campos).catch(() => ({ success: false }))
      if (ok.success) {
        hechos++
        console.log(`[ptv] lead ${ld.id} enriquecido desde el chat: ${Object.keys(campos).join(", ")}`)
      }
    }
    return hechos
  } catch (e) {
    console.warn("[ptv] enriquecerLeadsDeChat falló:", e instanceof Error ? e.message : e)
    return 0
  }
}

/** Turno de tómbola persistido en vic_kv (equitativo entre invocaciones). */
async function siguienteVendedor(pais: "cl" | "co" | "mx" | "pe") {
  const lista = vendedoresDePais(pais)
  if (!lista.length) return null
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const key = `ptv_rr_${pais}`
  const last = parseInt((await getKvValue(key).catch(() => null)) || "-1")
  const idx = (isNaN(last) ? 0 : last + 1) % lista.length
  await setKvValue(key, String(idx)).catch(() => {})
  return lista[idx]
}

/** Regla de tómbola de Deals en ZOHO por país (Lalo, 31-jul): cuando el PTV
 * entrega un DEAL, el dueño lo decide la regla de asignación de Zoho — la
 * misma tómbola que usa el equipo ("Tómbola Deals 2026 Chile") — y no la
 * rotación interna. La rotación interna queda para leads sin deal, para
 * países sin regla configurada y como fallback si la regla falla. */
const TOMBOLA_DEALS_RULE: Record<string, string> = {
  cl: (process.env.VICKY_PTV_TOMBOLA_DEALS_CL || "3525045000595568541").trim(),
  co: (process.env.VICKY_PTV_TOMBOLA_DEALS_CO || "").trim(),
  mx: (process.env.VICKY_PTV_TOMBOLA_DEALS_MX || "").trim(),
}

/** Nombre real para la presentación al prospecto (la tómbola interna solo
 * conoce el email; a un cliente jamás se le dice "emujica"). */
const NOMBRE_VENDEDOR: Record<string, string> = {
  "emujica@geovictoria.com": "Eddyluz Mujica",
  "agordillo@geovictoria.com": "Alejandro Gordillo",
  "egalindo@geovictoria.com": "Eddy Galindo",
  "ysegura@geovictoria.com": "Yahel Segura",
  "mguzmanr@geovictoria.com": "Miguel Guzmán",
  "mmendozav@geovictoria.com": "Mónica Mendoza",
  // Roster CL de la rotación de respaldo y de las reglas de Zoho (02-sep):
  // sin estas entradas la fila quedaba con el usuario del correo ("aaraque")
  // en vez del nombre real. Al cliente nunca le llegó así — el mensaje usa el
  // nombre de la ficha de Zoho — pero el registro interno sí, y es el que
  // leen la cartera, el chequeo 9h y las alertas.
  "aaraque@geovictoria.com": "Aleydis Araque",
  "asepulveda@geovictoria.com": "Aracelli Sepúlveda",
  "alopez@geovictoria.com": "Ana Paula López",
  "dgalvez@geovictoria.com": "Daniela Galvez",
  "gmelendez@geovictoria.com": "Grey Melendez",
  "tmartinezq@geovictoria.com": "Tamara Martinez",
  "adiazg@geovictoria.com": "Anderson Diaz",
  "pdiaz@geovictoria.com": "Paola Diaz",
}

/** WhatsApp de los interinos (directorio verificado 27-jul; Mónica desde su
 * ficha Zoho, 04-ago). Los vendedores sorteados por Zoho traen su teléfono
 * desde su ficha de usuario. */
const WHATSAPP_VENDEDOR: Record<string, string> = {
  "emujica@geovictoria.com": "+56 9 3932 1687",
  "agordillo@geovictoria.com": "+57 314 267 7765",
  "ysegura@geovictoria.com": "+52 55 3763 6604",
  "mmendozav@geovictoria.com": "+51 962 277 502",
}

type VendedorFinal = {
  email: string
  zohoId: string
  nombre: string
  telefono?: string
  via: "tombola_zoho" | "tombola_interna" | "dueno_deal" | "dueno_lead_sdr"
}

/** Aviso por correo al vendedor de un traspaso sobre un LEAD (los deals van
 * con el template oficial vía notificarTraspasoDeal). Hallazgo Anáhuac
 * (31-jul): la alerta central no le llega al vendedor asignado — el correo
 * directo SÍ. La copia a Victoria Luna es SOLO CHILE (Lalo 31-jul): CO y MX
 * siguen con sus reglas antiguas. Best-effort. */
async function notificarTraspasoLeadEmail(
  leadId: string,
  vendedorEmail: string,
  fono: string,
  H: Record<string, string>,
  api: string,
  motivoHtml?: string,
): Promise<void> {
  try {
    const esChile = fono.startsWith("56")
    const cuerpo =
      motivoHtml ||
      "el cliente dejó de responder y venció su tiempo de espera. <b>Llámalo en menos de 5 minutos</b> — la conversación completa está en las notas del lead, precio incluido si se le mostró."
    const { correoEntregable } = await import("@/lib/correo-alias")
    const destino = await correoEntregable(vendedorEmail)
    await fetch(`${api}/crm/v3/Leads/${leadId}/actions/send_mail`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [{
          from: { email: "vicky@geovictoria.com" },
          to: [{ email: destino }],
          ...(esChile ? { cc: [{ email: (process.env.VICKY_TRASPASO_CC || "vluna@geovictoria.com").trim() }] } : {}),
          subject: fono ? `Traspaso PTV: llamar YA a +${fono}` : "Nuevo lead de formulario web para contactar",
          content: `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;"><p>Vicky te traspasó esta conversación de WhatsApp: ${cuerpo}</p><p><a href="https://crm.zoho.com/crm/org685875245/tab/Leads/${leadId}">Ver el Lead en Zoho</a></p></body></html>`,
          mail_format: "html",
        }],
      }),
    })
  } catch { /* best-effort */ }
}

/** Teléfono del vendedor desde su ficha de usuario en Zoho (best-effort). */
async function telefonoDeUsuario(userId: string, H: Record<string, string>, api: string): Promise<string> {
  try {
    const r = await fetch(`${api}/crm/v3/users/${userId}`, { headers: H, cache: "no-store" })
    if (!r.ok) return ""
    const u = ((await r.json().catch(() => ({}))) as { users?: Array<{ phone?: string; mobile?: string }> }).users?.[0]
    return (u?.phone || u?.mobile || "").trim()
  } catch {
    return ""
  }
}

/**
 * Asigna en Zoho el lead (o su deal si ya convirtió) y devuelve el vendedor
 * FINAL — que puede diferir de la tómbola interna: si hay deal y el país
 * tiene regla de tómbola en Zoho, el PUT dispara la regla (lar_id) y el
 * dueño que Zoho sortee es quien se presenta al prospecto y recibe la
 * alerta. Best-effort: ante cualquier falla se cae al vendedor interno.
 */
/**
 * EXCEPCIÓN POR MOTIVO TERMINAL (Lalo 21-ago, catastro de traspasos — reclamo
 * de las SDR vía Dave: los relojes les "devolvían" contactos que ellas ya
 * habían descartado). Lead SIN convertir "No Calificado" con motivo terminal
 * (es un usuario, busca empleo, hardware ajeno, spam, pruebas) → esa
 * conversación no tiene prospecto que entregar. Devuelve el motivo si aplica;
 * best-effort: ante cualquier duda devuelve null y el traspaso sigue normal.
 */
async function leadTerminalNoProspecto(contact: string): Promise<string | null> {
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")
    // Sin converted=both a propósito: la excepción es SOLO para leads vivos
    // (un lead convertido tiene deal y sus reglas propias).
    const res = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&per_page=3`, { headers: H, cache: "no-store" })
    if (!res.ok || res.status === 204) return null
    const rows =
      ((await res.json().catch(() => ({}))) as {
        data?: Array<{ Lead_Status?: string; Motivo_No_calificado?: string }>
      }).data || []
    const { esMotivoTerminal } = await import("@/lib/zoho-leads")
    const hit = rows.find((l) => esMotivoTerminal(String(l.Lead_Status || ""), String(l.Motivo_No_calificado || "")))
    return hit ? String(hit.Motivo_No_calificado || "") : null
  } catch {
    return null
  }
}

async function asignarEnZoho(
  contact: string,
  pais: string,
  interno: { email: string; zohoId: string },
  // Escalera de roles (12-ago): con precio mostrado el lead va a la tómbola
  // de CALIFICADOS (ejecutivos); sin precio, a la de SDR sin calificar.
  calificado = false,
  // Segunda pasada tras crear el registro desde el chat (arreglo 1, 07-sep):
  // evita el bucle si el hito no dejó lead.
  segundaPasada = false,
): Promise<VendedorFinal> {
  const porDefecto: VendedorFinal = {
    ...interno,
    nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
    telefono: WHATSAPP_VENDEDOR[interno.email] || "",
    via: "tombola_interna",
  }
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")
    const res = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    // GEMELOS del mismo fono (caso Paola/CPT 26-ago): el form de la landing y
    // la emision de Vicky pueden parir DOS leads en minutos (el dedup no ve al
    // recien nacido por el retraso de indexacion de Zoho). Si un resultado ya
    // CONVIRTIO a deal, ese manda — entregar el gemelo sin convertir como
    // "lead para llamar" arma doble gestion.
    const filasLead = res.ok && res.status !== 204
      ? ((await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; Converted_Deal?: { id?: string } | null; Owner?: { id?: string; name?: string; email?: string }; Lead_Status?: string; N_Empleados_que_marcan?: number | string | null; RUT_Empresa?: string | null }> }).data || []
      : []
    const lead = filasLead.find((l) => l.Converted_Deal?.id) || filasLead[0]
    // ANTES DE CUALQUIER TRASPASO SE REVISA EL ESTADO DE LA CONVERSACIÓN
    // (Lalo 08-sep): con lead vivo en CL se lee lo que el chat ya dijo y se
    // pasa por el hito ANTES de elegir destino. Regla: calificado (dotación
    // conocida) + RUT → deal (forzado aunque sea ≤20) + Tómbola Deals;
    // calificado sin RUT → tómbola de leads TLMK; sin calificar → SDR. Sin
    // esto, un lead nacido "1." con 18 personas iba a SDR (caso Joyce) y un
    // "40 app" sin RUT también (caso Diego).
    if (lead?.id && !lead.Converted_Deal?.id && pais === "cl" && !segundaPasada) {
      try {
        const { datosDelChat } = await import("@/lib/extraer-datos-chat")
        const chat = await datosDelChat(fono)
        const empleadosLead = Number(lead.N_Empleados_que_marcan || 0) || 0
        const rutLead = String(lead.RUT_Empresa || "").trim()
        const empleados = chat.empleados || empleadosLead
        const rut = chat.rut || rutLead
        const calificadoAhora = calificado || empleados > 0 || String(lead.Lead_Status || "").trim().startsWith("4.")
        if (chat.tieneAlgo || (calificadoAhora && rut)) {
          const { sincronizarHitoCrm } = await import("@/lib/crm-hitos")
          await sincronizarHitoCrm(fono, "intencion", {
            nombre: chat.nombre,
            empresa: chat.empresa,
            email: chat.email,
            rut: rut || undefined,
            empleados: empleados || undefined,
            forzarDeal: Boolean(calificadoAhora && rut),
          })
          console.log(
            `[ptv] ${fono}: estado de la conversación revisado antes del traspaso (empleados=${empleados || "?"}, rut=${rut || "-"}, calificado=${calificadoAhora}); segunda pasada`,
          )
          return await asignarEnZoho(contact, pais, interno, calificadoAhora, true)
        }
      } catch (e) {
        console.warn(`[ptv] ${fono}: revisión del chat antes del traspaso falló — sigue con el lead tal cual:`, e instanceof Error ? e.message : e)
      }
    }
    if (!lead?.id) {
      // Sin lead en Zoho no hay registro que asignar: se CREA (regla 1 del
      // Proceso de Gestión de Leads: primer contacto → lead automático) ya a
      // nombre del vendedor del traspaso. createZohoLead trae candado y
      // dedup por búsqueda — jamás duplica. Hallazgo de la auditoría 31-jul:
      // 12 de los 36 traspasos del primer día no tenían lead y la asignación
      // quedaba solo en vic_ptv.
      const { createZohoLead } = await import("@/lib/zoho-leads")
      const paisNombre = pais === "co" ? "Colombia" : pais === "mx" ? "México" : "Chile"
      // CO: el lead sin cotización lo posee el SDR Inbound (acuerdo equipo CO
      // 04-ago) — se crea sin dueño y se asigna por round-robin SDR abajo.
      const esCO = pais === "co"
      // CL (Lalo 06-ago): el lead nuevo de un traspaso NO nace con la
      // rotación interna (roster de una sola persona = todo a Eddyluz) —
      // nace sin dueño y lo sortea la regla de calificación (Araceli/Aleydis).
      const esCL = pais === "cl"
      // MX (Lalo 13-ago): solo la FORMAL queda con Yahel (rama del deal);
      // todo lo demás va como LEAD a los SDR Inbound MX, con nota de la
      // conversación (URL directa a Botmaker + transcript).
      const esMX = pais === "mx"
      // ARREGLO 1 (Lalo 07-sep, casos Conbes y Diego): antes de crear un lead
      // CIEGO se lee lo que el chat YA dijo (nombre, empresa, dotación, RUT,
      // correo) y se pasa por el hito de intención — la MISMA escalera del
      // CRM: RUT + >20 → deal + Tómbola Deals; dotación conocida → lead
      // calificado (la segunda pasada lo encuentra y lo entrega a la regla
      // TLMK, no a las SDR); sin nada → lead ciego como siempre.
      if (esCL && !segundaPasada) {
        try {
          const { datosDelChat } = await import("@/lib/extraer-datos-chat")
          const chat = await datosDelChat(fono)
          if (chat.tieneAlgo) {
            const { sincronizarHitoCrm } = await import("@/lib/crm-hitos")
            await sincronizarHitoCrm(fono, "intencion", {
              nombre: chat.nombre,
              empresa: chat.empresa,
              email: chat.email,
              rut: chat.rut,
              empleados: chat.empleados,
            })
            console.log(
              `[ptv] ${fono}: sin lead al traspasar — registro creado desde el chat (empleados=${chat.empleados ?? "?"}, rut=${chat.rut || "-"}); segunda pasada`,
            )
            return await asignarEnZoho(contact, pais, interno, calificado || (chat.empleados || 0) > 0, true)
          }
        } catch (e) {
          console.warn(`[ptv] ${fono}: lectura del chat para el traspaso falló — lead ciego:`, e instanceof Error ? e.message : e)
        }
      }
      const creado = await createZohoLead({
        nombre: "Prospecto WhatsApp",
        empresa: `Por identificar (WhatsApp +${fono})`,
        telefono: fono,
        contactoWA: fono,
        pais: paisNombre,
        necesidad: "Traspaso PTV: conversación activa con Vicky sin registro previo en el CRM — lead creado al asignar vendedor.",
        ownerEmail: esCO || esCL || esMX ? undefined : interno.email,
        ownerId: esCO || esCL || esMX ? undefined : interno.zohoId,
      }).catch(() => null)
      if (!creado || !creado.success) {
        console.warn(`[ptv] ${fono}: sin lead en Zoho y la creación falló — asignación solo en vic_ptv`)
      } else if (esCL) {
        const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
        if (calificado) {
          // Vio precio = lead CALIFICADO (escalera de roles). Lead_Status vive
          // bajo Blueprint (PUT directo rebota RECORD_IN_BLUEPRINT): va por la
          // transición, con el helper que ya conoce los campos mandatorios.
          const { updateZohoLeadStatus } = await import("@/lib/zoho-leads")
          await updateZohoLeadStatus(creado.leadId, "4. Calificado").catch(() => {})
        }
        const r = await reasignarLeadCalificacionCL(creado.leadId, { calificado }).catch(() => null)
        // TODA entrega CL lleva la nota con el chat (Ana 26-ago) — antes solo MX.
        await notaTraspasoConversacion(creado.leadId, fono).catch(() => {})
        await notificarTraspasoLeadEmail(creado.leadId, r?.ownerEmail || interno.email, fono, H, api)
        if (r?.success && r.ownerEmail && r.ownerId) {
          const tel = await telefonoDeUsuario(r.ownerId, H, api)
          return {
            email: r.ownerEmail,
            zohoId: r.ownerId,
            nombre: r.ownerNombre || NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
            telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
            via: "tombola_zoho",
          }
        }
      } else if (esMX) {
        const { reasignarLeadSdrInboundMX } = await import("@/lib/zoho-leads")
        const r = await reasignarLeadSdrInboundMX(creado.leadId).catch(() => null)
        // Nota con la conversación + URL directa a Botmaker (best-effort).
        await notaTraspasoConversacion(creado.leadId, fono).catch(() => {})
        // La MISMA notificación de "nuevo lead" que ya reciben los dueños.
        await notificarTraspasoLeadEmail(creado.leadId, r?.ownerEmail || interno.email, fono, H, api)
        if (r?.success && r.ownerEmail && r.ownerId) {
          const tel = await telefonoDeUsuario(r.ownerId, H, api)
          return {
            email: r.ownerEmail,
            zohoId: r.ownerId,
            nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
            telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
            via: "dueno_lead_sdr",
          }
        }
        // Sin roster MX configurado (o RR falló): el lead queda con la
        // interina como siempre — fallback explícito, no silencioso.
        await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: creado.leadId, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      } else if (esCO) {
        const { reasignarLeadSdrInboundCO } = await import("@/lib/zoho-leads")
        const r = await reasignarLeadSdrInboundCO(creado.leadId).catch(() => null)
        await notificarTraspasoLeadEmail(creado.leadId, r?.ownerEmail || interno.email, fono, H, api)
        // Regla equipo CO (05-ago): al prospecto se le presenta el DUEÑO del
        // lead (el SDR, Galindo) — jamás un nombre distinto al dueño.
        if (r?.ownerEmail && r?.ownerId) {
          const tel = await telefonoDeUsuario(r.ownerId, H, api)
          return {
            email: r.ownerEmail,
            zohoId: r.ownerId,
            nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
            telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
            via: "dueno_lead_sdr",
          }
        }
      } else {
        await notificarTraspasoLeadEmail(creado.leadId, interno.email, fono, H, api)
      }
      return porDefecto
    }
    if (lead.Converted_Deal?.id) {
      const dealId = lead.Converted_Deal.id
      // Deal CERRADO = OTRA negociación (Lalo 31-jul): no se toca — el primer
      // barrido le quitó a Grey Meléndez un Cierre Perdido de 2023 y pisó
      // otro de Admin. La dedup/asignación es de procesos ABIERTOS; el
      // registro nuevo de esta conversación lo abre crm-hitos (reglas 4 y 6).
      const gDeal = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Stage,Owner`, { headers: H, cache: "no-store" })
      const filaDeal = gDeal.ok
        ? ((await gDeal.json().catch(() => ({}))) as { data?: Array<{ Stage?: string; Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]
        : undefined
      const stage = String(filaDeal?.Stage || "")
      if (/Cierre Perdido|8\. Facturando/.test(stage)) {
        console.warn(`[ptv] ${fono}: su deal ${dealId} está cerrado (${stage}) — no se reasigna; vendedor solo en vic_ptv`)
        return porDefecto
      }
      // Deal con dueño HUMANO vigente (la tómbola ya corrió al crearlo, o lo
      // gestiona un ejecutivo): NO se re-sortea — se presenta a ESE dueño.
      // Re-sortear acá cambiaría el dueño después de que el cliente pudo
      // haber escuchado otro nombre (caso Tosun/vaitiare/Sasval, 31-jul).
      const ownerActual = filaDeal?.Owner
      if (ownerActual?.id && ownerActual?.email && ownerActual.email.toLowerCase() !== "vicky@geovictoria.com") {
        const tel = await telefonoDeUsuario(ownerActual.id, H, api)
        // El dueño vigente recibe su aviso de traspaso (hallazgo Anáhuac:
        // la alerta central no le llega al asignado — el correo directo sí).
        const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
        await notificarTraspasoDeal(dealId).catch(() => {})
        return {
          email: ownerActual.email,
          zohoId: ownerActual.id,
          nombre: ownerActual.name || ownerActual.email.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[ownerActual.email.toLowerCase()] || "",
          via: "dueno_deal",
        }
      }
      const regla = TOMBOLA_DEALS_RULE[pais] || ""
      if (regla) {
        const put = await fetch(`${api}/crm/v3/Deals`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: dealId }], lar_id: regla }),
        })
        if (put.ok) {
          const get = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner`, { headers: H, cache: "no-store" })
          const owner = ((await get.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]?.Owner
          if (owner?.id && owner?.email) {
            const tel = await telefonoDeUsuario(owner.id, H, api)
            // Notificación de traspaso al dueño sorteado + CC Victoria
            // (template oficial, Lalo 31-jul). Best-effort.
            const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
            await notificarTraspasoDeal(dealId).catch(() => {})
            return { email: owner.email, zohoId: owner.id, nombre: owner.name || owner.email.split("@")[0], telefono: tel, via: "tombola_zoho" }
          }
        } else {
          console.warn(`[ptv] regla de tómbola Zoho falló (${put.status}) para deal ${dealId} — fallback a tómbola interna`)
        }
      }
      await fetch(`${api}/crm/v3/Deals`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: dealId, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
      await notificarTraspasoDeal(dealId).catch(() => {})
    } else if (pais === "co") {
      // CO: lead sin cotización → SDR fijo (Galindo, regla equipo 05-ago).
      // Sin cambios de propietario reales: si ya es de Galindo el PUT es
      // no-op; el prospecto conoce al DUEÑO del lead, no al roster.
      const { reasignarLeadSdrInboundCO } = await import("@/lib/zoho-leads")
      const r = await reasignarLeadSdrInboundCO(lead.id).catch(() => null)
      await notificarTraspasoLeadEmail(lead.id, r?.ownerEmail || interno.email, fono, H, api)
      if (r?.ownerEmail && r?.ownerId) {
        const tel = await telefonoDeUsuario(r.ownerId, H, api)
        return {
          email: r.ownerEmail,
          zohoId: r.ownerId,
          nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
          via: "dueno_lead_sdr",
        }
      }
    } else if (pais === "cl") {
      // Lead vivo SIN deal alcanzado por un reloj = Vicky no logró calificarlo
      // a tiempo (Lalo 06-ago): va a la tómbola de leads de calificación
      // (regla Araceli/Aleydis), NO a la rotación interna — el roster interno
      // CL es una sola persona y le llovía todo a Eddyluz (caso Veltis).
      // Dueño humano real no se pisa: se presenta ÉL. Eddyluz cuenta como
      // interina (marcador de "sin dueño real"), igual que Vicky.
      const ownerLead = (lead.Owner?.email || "").toLowerCase()
      // emujica@ salió de este patrón el 03-sep (orden de Lalo: "ella no es
      // interina, ni Anderson"). Un lead de Eddyluz es de Eddyluz: se le
      // presenta ella, no se re-sortea.
      const esInterina = !ownerLead || /vicky@|info@geovictoria/.test(ownerLead)
      if (!esInterina && lead.Owner?.id) {
        await notificarTraspasoLeadEmail(lead.id, ownerLead, fono, H, api)
        const tel = await telefonoDeUsuario(lead.Owner.id, H, api)
        return {
          email: ownerLead,
          zohoId: lead.Owner.id,
          nombre: lead.Owner.name || NOMBRE_VENDEDOR[ownerLead] || ownerLead.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[ownerLead] || "",
          via: "dueno_lead_sdr",
        }
      }
      const { reasignarLeadCalificacionCL, updateZohoLeadStatus } = await import("@/lib/zoho-leads")
      // CALIFICADO SIN PRECIO (Lalo 25-ago, caso Lisandra): "si se logra
      // calificar no debería volver al proceso de calificación de las SDR —
      // entregarlo como lead a telemarketing con toda la información". El flag
      // `calificado` del reloj solo mira PRECIO mostrado; si la conversación
      // ya dejó la dotación (lead en "4. Calificado" o N° de empleados
      // llenado), la calificación está HECHA → tómbola TLMK de ejecutivos.
      // OJO campo real: `N_Empleados_que_marcan` (08-sep: se leía
      // `N_de_empleados`, que no existe — un lead con 18 personas estampadas y
      // status "1." se trataba como no calificado y caía en SDR; caso Joyce).
      const calificadoPorLead =
        String(lead.Lead_Status || "").trim().startsWith("4.") ||
        Number(lead.N_Empleados_que_marcan || 0) > 0
      const entregaCalificada = calificado || calificadoPorLead
      if (calificado && !calificadoPorLead) {
        // Vio precio pero el status quedó atrás: se sube para que el
        // ejecutivo reciba el lead ya marcado calificado.
        await updateZohoLeadStatus(lead.id, "4. Calificado").catch(() => {})
      }
      const r = await reasignarLeadCalificacionCL(lead.id, { calificado: entregaCalificada }).catch(() => null)
      // Nota con el chat en toda entrega CL (Ana 26-ago).
      await notaTraspasoConversacion(lead.id, fono).catch(() => {})
      if (r?.success && r.ownerEmail && r.ownerId) {
        await notificarTraspasoLeadEmail(lead.id, r.ownerEmail, fono, H, api)
        const tel = await telefonoDeUsuario(r.ownerId, H, api)
        return {
          email: r.ownerEmail,
          zohoId: r.ownerId,
          nombre: r.ownerNombre || NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
          via: "tombola_zoho",
        }
      }
      // Fallback (regla y RR fallaron): rotación interna como siempre.
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      await notificarTraspasoLeadEmail(lead.id, interno.email, fono, H, api)
    } else if (pais === "mx") {
      // MX (Lalo 13-ago): lead vivo sin formal → SDR Inbound MX por round-robin,
      // con nota de conversación (URL a Botmaker + transcript) y la notificación
      // de nuevo lead al dueño. Dueño humano real previo NO se pisa (se presenta él).
      const ownerLeadMx = (lead.Owner?.email || "").toLowerCase()
      const esInterinaMx = !ownerLeadMx || /vicky@|info@geovictoria|ysegura@/.test(ownerLeadMx)
      if (!esInterinaMx && lead.Owner?.id) {
        await notaTraspasoConversacion(lead.id, fono).catch(() => {})
        await notificarTraspasoLeadEmail(lead.id, ownerLeadMx, fono, H, api)
        const tel = await telefonoDeUsuario(lead.Owner.id, H, api)
        return {
          email: ownerLeadMx,
          zohoId: lead.Owner.id,
          nombre: lead.Owner.name || NOMBRE_VENDEDOR[ownerLeadMx] || ownerLeadMx.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[ownerLeadMx] || "",
          via: "dueno_lead_sdr",
        }
      }
      const { reasignarLeadSdrInboundMX } = await import("@/lib/zoho-leads")
      const r = await reasignarLeadSdrInboundMX(lead.id).catch(() => null)
      await notaTraspasoConversacion(lead.id, fono).catch(() => {})
      await notificarTraspasoLeadEmail(lead.id, r?.ownerEmail || interno.email, fono, H, api)
      if (r?.success && r.ownerEmail && r.ownerId) {
        const tel = await telefonoDeUsuario(r.ownerId, H, api)
        return {
          email: r.ownerEmail,
          zohoId: r.ownerId,
          nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
          via: "dueno_lead_sdr",
        }
      }
      // Sin roster MX (VIC_SDR_INBOUND_MX vacío): comportamiento actual (Yahel).
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
    } else {
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      await notificarTraspasoLeadEmail(lead.id, interno.email, fono, H, api)
    }
    return porDefecto
  } catch (e) {
    console.warn("[ptv] asignarEnZoho falló:", e instanceof Error ? e.message : e)
    return porDefecto
  }
}

/**
 * La conversación en Botmaker sigue al dueño del registro en Zoho (Lalo
 * 14-ago). Hasta hoy el traspaso asignaba en el CRM y mandaba la
 * presentación, pero en Botmaker la conversación quedaba sin dueño: el
 * ejecutivo no la veía, y por eso todos estaban de admin viendo TODO.
 *
 * Best-effort absoluto: si falla, el traspaso siguió igual de bien.
 */
async function asignarConversacionEnBotmaker(contact: string, ownerEmail: string): Promise<void> {
  try {
    const { asignarConversacionAlDueno } = await import("@/lib/botmaker-agentes")
    const r = await asignarConversacionAlDueno(contact, ownerEmail)
    console.log(
      `[ptv] +${contact}: conversación → ${ownerEmail} en Botmaker: ${r.asignado ? "ASIGNADA" : `no (${r.motivo})`}`,
    )
  } catch (e) {
    console.warn(`[ptv] asignación Botmaker falló (${contact}):`, e instanceof Error ? e.message : e)
  }
}

/** ¿La cotización formal vigente del contacto ya está Aceptada en Zoho?
 * Solo se consulta para CANDIDATOS a traspaso v2 (barato). Best-effort:
 * ante cualquier duda devuelve false (el traspaso procede). */
async function cotizacionAceptada(contact: string): Promise<boolean> {
  try {
    const pointers = await getQuotePointers(contact).catch(() => [])
    const quoteId = pointers[0]?.quoteId
    if (!quoteId) return false
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const modulo = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const r = await fetch(`${api}/crm/v3/${modulo}/${quoteId}?fields=Estado_Cotizacion`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!r.ok) return false
    const estado = String(
      ((await r.json().catch(() => ({}))) as { data?: Array<{ Estado_Cotizacion?: string }> }).data?.[0]
        ?.Estado_Cotizacion || "",
    )
    return /aceptada|pagada/i.test(estado)
  } catch {
    return false
  }
}

// ── Reloj de calificación 24 h hábiles → tómbola de RE-ASIGNACIÓN (Lalo
// 03-ago, solo CL). Conversación sin intención comercial detectable en 24 h
// hábiles → el lead (se crea si no existe) se re-asigna por la regla de Zoho
// "Re-asignación de Vicky" a un ejecutivo de telemarketing, que hereda la
// calificación. La notificación al ejecutivo la da Zoho (regla); Vicky
// presenta al ejecutivo por la plantilla HSM (la ventana está cerrada por
// definición: el cliente no responde hace 24 h hábiles). ────────────────────
// Regla de re-asignación por país: CL usa la regla de Zoho (tómbola de
// telemarketing); PE no tiene tómbola — regla vacía = asignación DIRECTA a la
// ejecutiva del país (vendedoresDePais). Extensible por env.
const TM_REGLA: Record<string, string> = {
  // ESCALERA 18-ago (Lalo): "si Vicky no logra calificar pasa a leads de los
  // SDR" — el reloj de 24h dispara justamente cuando NO hubo calificación,
  // así que entrega por la regla SDR "Asignación Leads Sin calificar Vicky
  // SDR" (…3111), ya no por la TLMK de ejecutivos (…6001).
  cl: (process.env.VICKY_TM_REASIGNACION_RULE_CL || "3525045000652043111").trim(),
  pe: (process.env.VICKY_TM_REASIGNACION_RULE_PE || "").trim(),
}
const TM_PAIS_NOMBRE: Record<string, string> = { cl: "Chile", pe: "Perú" }
// VICKY PE AUTÓNOMA (orden de Lalo 11-ago, pre-encendido): en Perú NO se
// presenta a nadie por ahora — sin traspasos de etapa ni de calificación
// mientras Vicky PE sea autónoma (Mónica igual recibe los LEADS por los
// caminos de registro; lo que se apaga es el traspaso de la CONVERSACIÓN y
// la presentación al prospecto). Reencender sin deploy: vic_kv
// pe_presentacion=on (o env VICKY_PE_PRESENTACION=on).
async function pePresentaHabilitado(): Promise<boolean> {
  if ((process.env.VICKY_PE_PRESENTACION || "").trim().toLowerCase() === "on") return true
  try {
    const { getKvValue } = await import("@/lib/supabase-persistence-v3")
    return ((await getKvValue("pe_presentacion")) || "").trim().toLowerCase() === "on"
  } catch {
    return false
  }
}
const TM_FONO_REGEX: Record<string, RegExp> = { cl: /^56\d{8,10}$/, pe: /^51\d{8,10}$/ }
const TM_TEMPLATE = (process.env.VICKY_TM_TEMPLATE_PRESENTACION || "vicky_traspaso_ejecutivo").trim()
const MAX_TM_POR_TICK = 10
/** Teléfonos de los telemarketers ("email:+56...,email:+56..."). Fallback:
 * campo Phone/Mobile de su ficha de usuario en Zoho. */
function telefonoTmPorEmail(email: string): string {
  const raw = (process.env.VICKY_TM_TELEFONOS || "").trim()
  for (const par of raw.split(",")) {
    const [e, tel] = par.split(":").map((x) => (x || "").trim())
    if (e && tel && e.toLowerCase() === email.toLowerCase()) return tel
  }
  return ""
}

type CandidatoTM = { contact: string; origen: "outbound" | "inbound"; pais: "cl" | "pe" }

/**
 * LA ENTREGA A TELEMARKETING QUE FALLA NO PUEDE REINTENTARSE PARA SIEMPRE
 * (04-sep). `traspasarATelemarketing` tiene dos salidas de error —no se pudo
 * crear el lead, y sin dueño tras la regla— que cerraban la fila `vic_ptv`
 * pero dejaban la conversación intacta: al tick siguiente volvía a
 * candidatearse. Dos contactos (56928393806 y 56974962588, ambos con lead
 * imposible de crear) generaron 58 y 26 filas `vic_ptv` en un día, una cada
 * dos minutos, y ensuciaron el panel de traspasos con entregas fantasma.
 *
 * Regla: hasta 3 intentos —una caída de Zoho no debe costar la entrega— y al
 * cuarto la conversación se marca y sale del radar, con aviso interno para
 * que un humano la recoja. El contador vive 7 días en vic_kv.
 */
const TM_MAX_INTENTOS = 3

async function registrarFalloEntregaTm(
  contact: string,
  origen: string,
  detalle: string,
): Promise<void> {
  const key = `tm24_int_${contact}`
  const previo = await supa<{ key: string; value?: string }>(
    `vic_kv?key=eq.${encodeURIComponent(key)}&select=key,value&limit=1`,
  ).catch(() => [])
  const intentos = Number(previo[0]?.value || 0) + 1
  await supa(`vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key,
      value: String(intentos),
      expires_at: new Date(Date.now() + 7 * 24 * 3600e3).toISOString(),
    }),
  }).catch(() => [])
  if (intentos < TM_MAX_INTENTOS) return

  // Agotados los intentos: se saca del radar por los dos caminos por los que
  // entra (loop = outbound, conversación = inbound).
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    body: JSON.stringify({ estado: "cerrado", motivo_cierre: "tm_entrega_fallida" }),
  }).catch(() => [])
  await supa(`vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    body: JSON.stringify({ followup_closed_reason: "tm_entrega_fallida" }),
  }).catch(() => [])
  await avisarEquipoInterno(
    `\u26a0\ufe0f Entrega a telemarketing IMPOSIBLE tras ${intentos} intentos — +${contact}\n` +
      `Motivo tecnico: ${detalle} (origen ${origen}).\n` +
      `La conversacion queda fuera del reloj de calificacion: hay que crear el lead a mano si el caso vale.`,
  ).catch(() => false)
}

async function traspasarATelemarketing(
  contact: string,
  origen: string,
  ahora: Date,
  feriados: Set<string>,
  pais: "cl" | "pe" = "cl",
): Promise<{ ok: boolean; vendedor?: string; detalle?: string }> {
  // Candado primero (UNIQUE contact+activo evita dobles).
  const fila = await supa<{ id: string }>(`vic_ptv`, {
    method: "POST",
    body: JSON.stringify({
      contact,
      motivo: `sin_calificar_24h_${origen}`,
      ttv_minutos: CALIFICACION_24H_MIN,
      precio_mostrado: false,
      vendedor_email: "",
      vendedor_zoho_id: "",
      vendedor_nombre: "",
      chequeo_at: sumarHorasHabiles(ahora, 9, pais, feriados).toISOString(),
    }),
  })
  if (!fila.length) return { ok: false, detalle: "candado" }

  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")

    // 1. Lead: buscar; con deal convertido NO es un sin-calificar (fuera).
    const s = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    const lead = s.ok && s.status !== 204
      ? ((await s.json().catch(() => ({}))) as {
          data?: Array<{ id?: string; First_Name?: string; Converted_Deal?: { id?: string } | null; Owner?: { id?: string; email?: string; name?: string } }>
        }).data?.[0]
      : undefined
    if (lead?.Converted_Deal?.id) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
      // Con DEAL convertido la conversación NO es "sin calificar": se cierra
      // también su fila del loop para que no vuelva a candidatearse en cada
      // tick (primer barrido 03-ago: dos contactos reintentaban infinito).
      await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
        method: "PATCH",
        body: JSON.stringify({ estado: "cerrado", motivo_cierre: "tm_no_aplica_deal" }),
      })
      return { ok: false, detalle: "tiene deal — no es sin-calificar" }
    }

    let leadId = lead?.id || ""
    const ownerActual = (lead?.Owner?.email || "").toLowerCase()
    const ownerBot = !ownerActual || /vicky@|info@geovictoria/.test(ownerActual)
    if (!leadId) {
      // Sin lead → se crea (regla 1 del Proceso de Gestión de Leads) y la
      // regla de re-asignación decide el dueño en el paso siguiente.
      const { createZohoLead } = await import("@/lib/zoho-leads")
      const creado = await createZohoLead({
        nombre: "Prospecto WhatsApp",
        empresa: `Por identificar (WhatsApp +${fono})`,
        telefono: fono,
        contactoWA: fono,
        pais: TM_PAIS_NOMBRE[pais] || "Chile",
        necesidad: `Traspaso a telemarketing: ${origen === "outbound" ? "outbound sin respuesta" : "inbound sin responder la primera pregunta"} en 24 horas hábiles — el ejecutivo califica.`,
      }).catch(() => null)
      if (!creado || !creado.success) {
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
        await registrarFalloEntregaTm(contact, origen, "no se pudo crear el lead")
        return { ok: false, detalle: "no se pudo crear el lead" }
      }
      leadId = creado.leadId
    }

    // 2. Dueño: si el lead ya es de un HUMANO, no se pisa su gestión (regla
    // marketing 30-jul) — ese humano es el ejecutivo que se presenta. Si es
    // del bot: CL va a la TÓMBOLA DE LEADS DE CALIFICACIÓN — la regla de Zoho
    // "Asignación Leads Vicky TLMK" cuyo roster Lalo dejó en Araceli y Aleydis
    // (06-ago: "lo que no ha podido calificar vuelve a Aleydis y Aracelli";
    // reasignarLeadCalificacionCL dispara la regla y solo si no asigna cae al
    // round-robin interno de ellas dos) — y PE (sin tómbola) asigna directo a
    // la ejecutiva del país (Mónica).
    let owner = lead?.Owner && !ownerBot ? lead.Owner : undefined
    if (!owner?.id && pais === "cl") {
      const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
      // Nota con el chat en toda entrega CL (Ana 26-ago).
      await notaTraspasoConversacion(leadId, fono).catch(() => {})
      // Reloj de 24h sin calificar: por definición va a la tómbola SDR.
      const r = await reasignarLeadCalificacionCL(leadId, { calificado: false })
      if (r.success && r.ownerId && r.ownerEmail) {
        owner = { id: r.ownerId, email: r.ownerEmail, name: r.ownerNombre }
      } else {
        console.warn(`[tm-24h] tómbola de calificación falló lead=${leadId}: ${r.error || "sin detalle"}`)
      }
    }
    if (!owner?.id) {
      const regla = (pais === "cl" ? (process.env.VICKY_TM_CALIFICACION_RULE_ID || "").trim() : "") || TM_REGLA[pais] || ""
      if (regla) {
        const put = await fetch(`${api}/crm/v3/Leads`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: leadId }], lar_id: regla }),
        })
        if (!put.ok) console.warn(`[tm-24h] regla de re-asignación falló (${put.status}) lead=${leadId}`)
        const g = await fetch(`${api}/crm/v3/Leads/${leadId}?fields=Owner,First_Name`, { headers: H, cache: "no-store" })
        owner = ((await g.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; email?: string; name?: string } }> }).data?.[0]?.Owner
      } else {
        const { vendedoresDePais } = await import("@/lib/ptv")
        const interno = vendedoresDePais(pais)[0]
        if (interno?.zohoId) {
          await fetch(`${api}/crm/v3/Leads`, {
            method: "PUT", headers: H, cache: "no-store",
            body: JSON.stringify({
              data: [{ id: leadId, Owner: { id: interno.zohoId } }],
              skip_feature_execution: [{ name: "assignment_rules" }],
            }),
          }).catch(() => {})
          owner = { id: interno.zohoId, email: interno.email, name: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0] }
        }
      }
    }
    if (!owner?.id || !owner.email) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
      await registrarFalloEntregaTm(contact, origen, "sin dueño tras la regla de asignación")
      return { ok: false, detalle: "sin dueño tras la regla" }
    }

    // 3. Registro final del traspaso.
    await supa(`vic_ptv?id=eq.${fila[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({
        vendedor_email: owner.email,
        vendedor_zoho_id: owner.id,
        vendedor_nombre: owner.name || owner.email.split("@")[0],
      }),
    })

    // 3b. Correo DIRECTO al vendedor (caso Paola Díaz 04-ago: la asignación
    // por regla de Zoho no le avisa de forma visible al asignado — mismo
    // hallazgo Anáhuac del 31-jul en los traspasos de nivel lead. Sin este
    // correo, el ejecutivo no se entera de que Vicky le entregó el lead).
    await notificarTraspasoLeadEmail(
      leadId,
      owner.email,
      contact,
      H,
      api,
      `no logró calificarla en 24 horas hábiles (${origen === "sin_calificar_24h_inbound" ? "el cliente escribió y no respondió la primera pregunta" : "outbound sin respuesta desde el primer toque"}). <b>El lead ahora es tuyo</b> — la transcripción está en sus notas.`,
    ).catch(() => {})

    // 4. Presentación por PLANTILLA (regla dura: ejecutivo, teléfono y correo
    // son obligatorios — sin teléfono no sale, antes que presentar a medias).
    const telefono = telefonoTmPorEmail(owner.email) || (await telefonoDeUsuario(owner.id, H, api))
    if (telefono) {
      const params: Record<string, string> = {
        nombre: (lead?.First_Name || "").trim() || "👋",
        ejecutivo_smb: owner.name || owner.email.split("@")[0],
        telefono_ejecutivo: telefono,
        correoElectronico: owner.email,
      }
      const enviado = await sendBotmakerTemplate(contact, TM_TEMPLATE, params).catch(() => false)
      if (enviado) {
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ presentado_al_prospecto: true }) })
        await appendAssistantV3(
          contact,
          `[Plantilla ${TM_TEMPLATE}]: presenté a ${params.ejecutivo_smb} (${telefono} · ${owner.email}) como tu ejecutivo de acompañamiento.`,
        ).catch(() => {})
      }
    } else {
      console.warn(`[tm-24h] ${contact}: sin teléfono para ${owner.email} — traspaso sin presentación (el ejecutivo llama directo)`)
    }

    // 5. El traspaso apaga la cadencia del loop para este contacto.
    await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "tm_traspasado" }),
    })
    console.log(`[tm-24h] ${contact} → ${owner.email} (${origen})`)
    return { ok: true, vendedor: owner.email }
  } catch (e) {
    console.warn(`[tm-24h] ${contact} falló:`, e instanceof Error ? e.message : e)
    return { ok: false, detalle: "excepción" }
  }
}

/**
 * TRASPASO INMEDIATO — "quiero que me llamen" deja de ser una promesa y pasa a
 * ser un traspaso de verdad (Lalo, 03-sep).
 *
 * EL PROBLEMA QUE RESUELVE. Hasta hoy, pedir hablar con una persona solo
 * dejaba una fila en `vic_promesas` y un mensaje diciendo "se va a contactar
 * contigo en las próximas horas". Nada más: sin registro en Zoho, sin tómbola
 * y sin nadie asignado. De 33 promesas hechas desde el 29-ago, 20 vencieron
 * sin cumplirse (61%) y las 33 nacieron con `vendedor_email` en NULL — se le
 * preguntaba al sistema quién era el responsable un segundo ANTES de que el
 * sistema lo decidiera. El caso Soledad (pidió tres veces, dos promesas
 * registradas, nadie llamó) es el retrato exacto.
 *
 * VIVE ACÁ A PROPÓSITO. La maquinaria de traspaso —escalera de registro,
 * tómbola, candados de dueño humano— ya existe en este archivo y es el camino
 * más crítico del sistema. Moverla a lib/ sería un refactor grande con riesgo
 * real de regresión; en cambio exportar la función desde acá garantiza UNA
 * sola implementación: el reloj del cron y la petición explícita hacen
 * exactamente lo mismo, y no pueden desincronizarse.
 *
 * LOS DATOS QUE MANDAN EL DISEÑO (medidos el 03-sep sobre 178 leads en 4 días):
 *  · 89% de los contactos YA tiene lead (lo crea el formulario web). No se
 *    crea nada: se reusa. Solo el 11% que escribe directo al WhatsApp necesita
 *    uno nuevo, y el dedup ya evita duplicarlos (los 19 del período eran
 *    genuinamente nuevos, ni uno duplicó un lead del formulario).
 *  · El registro correcto lo elige la ESCALERA que ya existe según lo que la
 *    conversación logró calificar — no se fuerza deal ni lead desde acá.
 */
export type ResultadoTraspaso = {
  ok: boolean
  motivo?: string
  vendedor?: { nombre: string; email: string; telefono: string }
  yaTeniaVendedor?: boolean
}

export async function traspasarAhora(
  contact: string,
  opts: { motivo: string; calificado?: boolean } = { motivo: "solicitud_explicita_persona" },
): Promise<ResultadoTraspaso> {
  const clean = (contact || "").replace(/\D/g, "")
  if (!clean) return { ok: false, motivo: "sin contacto" }
  const pais = (paisDeContacto(clean) || "cl") as "cl" | "co" | "mx" | "pe"

  // 0. CANDADO: si ya hay traspaso activo, NO se re-sortea. Se devuelve el
  //    vendedor que ya lo atiende para que Vicky lo repita, en vez de mover al
  //    cliente de manos por segunda vez.
  const activo = await supa<{ vendedor_email: string; vendedor_nombre: string }>(
    `vic_ptv?contact=eq.${encodeURIComponent(clean)}&estado=eq.activo&select=vendedor_email,vendedor_nombre&limit=1`,
  ).catch(() => [])
  if (activo.length) {
    const email = activo[0].vendedor_email || ""
    return {
      ok: true,
      yaTeniaVendedor: true,
      vendedor: {
        nombre: activo[0].vendedor_nombre || NOMBRE_VENDEDOR[email] || email.split("@")[0],
        email,
        telefono: WHATSAPP_VENDEDOR[email] || "",
      },
    }
  }

  const interno = await siguienteVendedor(pais)
  if (!interno) return { ok: false, motivo: "sin roster" }

  // 1. Registro PRIMERO: el UNIQUE de vic_ptv es el candado anti-carrera (dos
  //    turnos del modelo en paralelo no pueden traspasar dos veces).
  const ahora = new Date()
  const feriados = await feriadosDePais(pais).catch(() => new Set<string>())
  const fila = await supa<{ id: string }>(`vic_ptv`, {
    method: "POST",
    body: JSON.stringify({
      contact: clean,
      motivo: opts.motivo,
      ttv_minutos: 0,
      precio_mostrado: Boolean(opts.calificado),
      vendedor_email: interno.email,
      vendedor_zoho_id: interno.zohoId,
      vendedor_nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
      chequeo_at: sumarHorasHabiles(ahora, 9, pais, feriados).toISOString(),
    }),
  }).catch(() => [])
  if (!fila.length) return { ok: false, motivo: "candado: ya había traspaso" }

  // 2. Zoho: la ESCALERA elige el registro (reusa el lead del formulario en el
  //    89% de los casos) y la tómbola sortea. El dueño humano nunca se pisa —
  //    esa guarda vive dentro de asignarEnZoho.
  const vendedor = await asignarEnZoho(clean, pais, interno, Boolean(opts.calificado)).catch(() => null)
  const v = vendedor || {
    ...interno,
    nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
    telefono: WHATSAPP_VENDEDOR[interno.email] || "",
    via: "fallback",
  }
  if (v.email !== interno.email || v.zohoId !== interno.zohoId) {
    await supa(`vic_ptv?id=eq.${fila[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ vendedor_email: v.email, vendedor_zoho_id: v.zohoId, vendedor_nombre: v.nombre }),
    }).catch(() => {})
  }

  // 3. El chat de Botmaker pasa a esa persona (si no, el ejecutivo no lo ve).
  await asignarConversacionEnBotmaker(clean, v.email).catch(() => {})

  // 4. Se apaga la cadencia: con vendedor encima, Vicky no sigue tocando.
  //    Sigue respondiendo si el cliente escribe (candado v3).
  await supa(`vic_loop?contact=eq.${encodeURIComponent(clean)}`, {
    method: "PATCH",
    body: JSON.stringify({ estado: "cerrado", motivo_cierre: "ptv_traspasado" }),
  }).catch(() => {})

  // 5. Alerta interna con el reloj explícito.
  await avisarEquipoInterno(
    `📞 TRASPASO INMEDIATO (${opts.motivo}) a ${v.email} — contacto +${clean}. El cliente PIDIÓ hablar con una persona: LLAMAR EN MENOS DE 5 MINUTOS. La conversación completa está en las notas del registro en Zoho.`,
  ).catch(() => {})

  // La presentación al prospecto NO se manda desde acá: la hace Vicky en su
  // propia respuesta, en el mismo turno, para que el cliente reciba UN mensaje
  // coherente y no dos seguidos. Por eso se devuelven los datos del vendedor.
  await supa(`vic_ptv?id=eq.${fila[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ presentado_al_prospecto: true }),
  }).catch(() => {})

  return {
    ok: true,
    vendedor: { nombre: v.nombre, email: v.email, telefono: v.telefono || "" },
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  // MODO SOLO PRESENTACIONES (Lalo 08-sep, "esos 80 vamos por tandas de 20 de
  // lo más actual a lo más antiguo"): ?soloPresentaciones=1&max=20&horas=720
  // reintenta únicamente las presentaciones pendientes, sin correr el tick.
  {
    const sp = new URL(req.url).searchParams
    if (sp.get("soloConciliacionSdr") === "1") {
      const r = await reconciliarSdrCalificados(new Date())
      return NextResponse.json({ ok: true, modo: "soloConciliacionSdr", ...r })
    }
    if (sp.get("soloPresentaciones") === "1") {
      const r = await reintentarPresentacionesPendientes(new Date(), {
        max: Number(sp.get("max")) || 20,
        horas: Number(sp.get("horas")) || 48,
        orden: sp.get("orden") === "asc" ? "asc" : "desc",
      })
      return NextResponse.json({ ok: true, modo: "soloPresentaciones", ...r })
    }
  }
  // ── DISPARO DEL CANARIO (Rodrigo 03-sep) ──────────────────────────────────
  // Los crons del vercel.json NO corren en este proyecto (la "producción" de
  // Vercel apunta al master viejo; los ticks reales vienen de un programador
  // externo que golpea estos endpoints). El canario del camino de oro se
  // dispara desde acá: 1 vez por hora, best-effort, jamás frena el barrido —
  // y corre aunque el PTV esté apagado (por eso va ANTES de ese switch).
  try {
    const ultimo = Date.parse((await getKvValue("canario_last_disparo")) || "") || 0
    if (Date.now() - ultimo > 55 * 60_000) {
      await setKvValue("canario_last_disparo", new Date().toISOString())
      const secretoCanario = await getFollowupCronSecret().catch(() => "")
      if (secretoCanario) {
        await fetch(`${new URL(req.url).origin}/api/vic-canario`, {
          headers: { "x-cron-secret": secretoCanario },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        }).catch((e) => console.warn("[ptv] canario no respondió:", e instanceof Error ? e.message : e))
      }
    }
  } catch { /* best-effort: el canario nunca frena el PTV */ }
  if (!ptvHabilitado()) {
    {
      const { estamparLatido } = await import("@/lib/latido")
      await estamparLatido("ptv").catch(() => undefined)
    }
    return NextResponse.json({ ok: true, skipped: "VICKY_PTV_ENABLED off" })
  }
  // Candado de turno (barrido acelerado 10-ago): agenda externa + despacho
  // cada 2 min desde vic-callback-cron. Dos ticks solapados traspasarían al
  // mismo contacto dos veces (dos presentaciones). Uno solo tiene el turno.
  const { reclamarTurno, liberarTurno } = await import("@/lib/cron-lock")
  if (!(await reclamarTurno("ptv"))) {
    return NextResponse.json({ ok: true, skipped: "otro tick en curso" })
  }
  try {

  // SANADOR DE TOKEN ZOHO (incidente 17-ago): Zoho puede REVOCAR un access
  // token antes de su vencimiento declarado (tope de tokens vivos — el
  // cotizador comparte credenciales) y el kv sigue sirviendo el muerto hasta
  // que el reloj lo venza: una hora de agente ciego a Zoho. Este probe corre
  // cada tick (~10 min): un 401 fuerza el refresco y repara el kv para TODOS
  // los consumidores. Best-effort, jamás frena el barrido.
  try {
    const { getZohoAccessToken, getZohoAccessTokenFresco } = await import("@/lib/zoho-token")
    const tok = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const probe = await fetch(`${api}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: "select id from Leads limit 1" }),
      cache: "no-store",
    })
    if (probe.status === 401) {
      await getZohoAccessTokenFresco()
      console.warn("[vic-ptv-cron] token Zoho revocado antes de vencer — refrescado por el sanador")
    }
  } catch { /* best-effort */ }

  const ahora = new Date()
  const desde = new Date(ahora.getTime() - VENTANA_BARRIDO_MS).toISOString()
  // Flag del traspaso v2: env O vic_kv (traspaso_v2_enabled=on) — la clave kv
  // permite encender/apagar al instante sin tocar el env de Vercel.
  const v2Activo =
    traspasoV2Habilitado() ||
    ((await getKvValue("traspaso_v2_enabled").catch(() => null)) || "").trim() === "on"

  // 1. Conversaciones con actividad reciente + su compromiso de pausa (vic_loop).
  const convs = await supa<{
    contact: string
    country: string | null
    last_user_at: string | null
    updated_at: string
    pref_escalon: number | null
    pref_escalon_at: string | null
    pref_quote_id: string | null
    formal_quote_id: string | null
    formal_quote_at: string | null
    followup_closed_reason: string | null
    first_user_at: string | null
    user_msg_count: number | null
  }>(
    `vic_v3_conversations?updated_at=gte.${encodeURIComponent(desde)}` +
      `&select=contact,country,last_user_at,updated_at,pref_escalon,pref_escalon_at,pref_quote_id,formal_quote_id,formal_quote_at,followup_closed_reason,first_user_at,user_msg_count&order=updated_at.desc&limit=1000`,
  )
  const activos = await supa<{ contact: string }>(`vic_ptv?estado=eq.activo&select=contact&limit=1000`)
  const conTraspaso = new Set(activos.map((a) => a.contact))
  // >50 detectados (Lalo 06-ago): "no pasa por el proceso de traspaso" — su
  // camino es tómbola de deals (calificado), tómbola de leads de calificación
  // (sin número) u host de reunión. El reloj de etapa NO les corre (caso
  // Veltis: derivado >50 a las 13:00 y el reloj de 120' lo traspasó igual).
  const mas50 = await supa<{ contact: string }>(
    `vic_loop?motivo_cierre=in.(mas_de_50,sobre_umbral,no_prospecto)&select=contact&limit=1000`,
  )
  const contactosMas50 = new Set(mas50.map((m) => m.contact))
  const pausas = await supa<{ contact: string; compromiso_at: string | null }>(
    `vic_loop?select=contact,compromiso_at&compromiso_at=not.is.null&limit=500`,
  )
  const compromisoPor = new Map(pausas.map((p) => [p.contact, p.compromiso_at]))

  const traspasados: Array<{ contact: string; vendedor: string; ttv: number }> = []
  const contactosPrueba = testContactSet()
  for (const c of convs) {
    if (traspasados.length >= MAX_TRASPASOS_POR_TICK) break
    // Elegibilidad (fix 31-jul, cazado en el primer día encendido):
    //  - contactos internos de prueba NUNCA se traspasan (el tester terminó
    //    en la bandeja de Eddyluz con orden de llamarlo en 5 minutos);
    //  - solo teléfonos DISCABLES (56/57/52...): el PTV exige que el vendedor
    //    LLAME — los IDs anónimos de Meta (CIMA "CO.10259...") no tienen
    //    número y esa conversación se queda con Vicky por chat.
    if (isTestContact(c.contact, contactosPrueba)) continue
    if (!/^(56|57|52|51)\d{8,12}$/.test(c.contact)) continue
    const pais = (paisDeContacto(c.contact) || (c.country as "cl" | "co" | "mx" | "pe" | null))
    if (!pais) continue
    // opt-out/soporte/perdido: el loop ya cerró esta conversación — no traspasar.
    if (c.followup_closed_reason) continue
    // >50: fuera del proceso de traspaso (Lalo 06-ago).
    if (contactosMas50.has(c.contact)) continue
    // Reloj TTV: el silencio se mide desde el último mensaje del CLIENTE.
    // updated_at se mueve con cada toque del Loop, y usarlo de referencia
    // reiniciaba el TTV en cada toque (brecha 1, 30-jul). Sin mensaje del
    // cliente no hay TTV que medir: esa conversación la gobierna el Loop.
    if (!c.last_user_at) continue
    const ultimoCliente = new Date(c.last_user_at)
    // ESTRICTO, no >= (caso Fundación Amigos de Jesús, 10-ago): cuando el
    // mensaje del cliente y la respuesta de Vicky quedan grabados en el
    // MISMO milisegundo, el empate hacía "cliente activo" verdadero para
    // siempre y esa conversación nunca más era traspasable. El empate
    // significa que Vicky YA respondió (los appends van en orden); el único
    // instante genuinamente ambiguo — cliente recién escribió y Vicky aún no
    // contesta — es inofensivo con >, porque ese mismo mensaje acaba de
    // reiniciar el reloj de silencio a cero.
    const clienteRespondioDespues = ultimoCliente.getTime() > new Date(c.updated_at).getTime()
    const feriados = await feriadosDePais(pais)
    const compromisoAt = compromisoPor.get(c.contact) ? new Date(String(compromisoPor.get(c.contact))) : null
    // TRASPASO v2 (CL desde 03-ago; PE desde el día uno — Lalo 04-ago; CO
    // desde 05-ago — mismo flujo de relojes que Chile, ok de Lalo): relojes
    // de DURACIÓN DE ETAPA en minutos hábiles reemplazan a los TTV de
    // silencio — corren aunque el cliente converse. En CO el traspaso AVISA
    // y presenta al dueño vigente, JAMÁS cambia propietarios (regla equipo
    // CO: el primero se lo queda hasta el final — asignarEnZoho ya respeta
    // dueños humanos, y todos los registros CO nacen con Galindo/Gordillo).
    // MX en v2 desde el 08-ago (réplica ordenada por Lalo); con flag apagado, todos vuelven al TTV clásico.
    // PE autónoma (Lalo 11-ago): sin presentación, la conversación peruana
    // no se traspasa por relojes — Vicky la sigue atendiendo.
    if (pais === "pe" && !(await pePresentaHabilitado())) continue
    const usaV2 = v2Activo && (pais === "cl" || pais === "pe" || pais === "co" || pais === "mx")
    const decision = usaV2
      ? debeTraspasarEtapa({
          firstUserAt: c.first_user_at ? new Date(c.first_user_at) : null,
          userMsgCount: Number(c.user_msg_count || 0),
          precioAt: c.pref_escalon_at ? new Date(c.pref_escalon_at) : null,
          formalAt: c.formal_quote_at ? new Date(c.formal_quote_at) : null,
          aceptada: false, // se verifica en Zoho SOLO si la decisión es traspasar
          // Relojes con-precio de SILENCIO (08-ago): misma referencia que el
          // TTV clásico — el último mensaje del CLIENTE, que los toques del
          // Loop no mueven; cliente activo (nos debe respuesta Vicky) = no corre.
          ultimoClienteAt: ultimoCliente,
          clienteRespondioDespues,
          pais,
          ahora,
          feriados,
          compromisoAt,
          traspasoActivo: conTraspaso.has(c.contact),
        })
      : debeTraspasar({
          referenciaRelojAt: ultimoCliente,
          clienteRespondioDespues,
          precioMostrado: Boolean(c.pref_escalon_at || c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
          pais,
          ahora,
          feriados,
          compromisoAt,
          traspasoActivo: conTraspaso.has(c.contact),
        })
    if (!decision.traspasar) continue
    // PAGO REGISTRADO (19-ago, caso MATER/COT546): el cliente ya pagó por
    // transferencia — no hay NADA que traspasar. Sin esta guarda, el reloj de
    // 120' traspasó a una clienta pagada (correo "Asignación Nuevo Deal" a la
    // dueña del deal + presentación al prospecto) porque su cotización era
    // del canal EJECUTIVO y la conversación con Vicky nació recién al pagar.
    if (await pagoRegistradoReciente(c.contact)) continue
    // Fase ONBOARDING (25-ago): cliente creando su cuenta — nada que traspasar.
    if (await enFaseOnboarding(c.contact)) continue
    // v2, etapas con cotización de por medio: si la vigente ya está ACEPTADA
    // en Zoho, no hay demora que castigar — el cliente está en el pago.
    if (usaV2 && decision.motivo !== "etapa_sin_preform") {
      if (await cotizacionAceptada(c.contact)) continue
    }
    // MOTIVO TERMINAL (Lalo 21-ago): un SDR ya descartó a este contacto por
    // un motivo sin vuelta ("Es un usuario", spam, pruebas…) — no se traspasa
    // ni se le vuelve a entregar el lead a nadie. El loop cierra con motivo
    // propio (queda fuera de relojes y toques); Vicky sigue solo reactiva.
    const motivoTerminal = await leadTerminalNoProspecto(c.contact)
    if (motivoTerminal) {
      await supa(`vic_loop?contact=eq.${encodeURIComponent(c.contact)}`, {
        method: "PATCH",
        body: JSON.stringify({ estado: "cerrado", motivo_cierre: "no_prospecto" }),
      })
      console.log(
        `[ptv] ${c.contact}: lead No Calificado terminal ("${motivoTerminal}") — traspaso omitido, loop cerrado (no_prospecto)`,
      )
      continue
    }

    const interno = await siguienteVendedor(pais)
    if (!interno) continue
    // Registro PRIMERO (candado UNIQUE evita carrera de doble traspaso).
    const fila = await supa<{ id: string }>(`vic_ptv`, {
      method: "POST",
      body: JSON.stringify({
        contact: c.contact,
        motivo: decision.motivo,
        ttv_minutos: decision.ttv,
        precio_mostrado: Boolean(c.pref_escalon_at || c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
        vendedor_email: interno.email,
        vendedor_zoho_id: interno.zohoId,
        vendedor_nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
        chequeo_at: sumarHorasHabiles(ahora, 9, pais, feriados).toISOString(),
      }),
    })
    if (!fila.length) continue // candado: ya había traspaso activo
    // Asignación en Zoho ANTES de presentar: si el deal pasa por la regla de
    // tómbola de Zoho, el dueño que Zoho sorteó es quien se presenta al
    // prospecto y quien recibe la alerta — nunca un nombre distinto al dueño.
    const vendedor = await asignarEnZoho(
      c.contact,
      pais,
      interno,
      Boolean(c.pref_escalon_at || c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
    )
    // El registro se corrige cuando cambia el correo O el id (Lalo 02-sep):
    // comparar solo el correo dejaba filas con el id de otra persona cuando la
    // tómbola devolvía el mismo correo con distinto usuario. Los tres campos
    // viajan siempre juntos: nombre, correo e id son de la MISMA persona.
    if (vendedor.email !== interno.email || vendedor.zohoId !== interno.zohoId) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ vendedor_email: vendedor.email, vendedor_zoho_id: vendedor.zohoId, vendedor_nombre: vendedor.nombre }),
      })
    }
    // Y la conversación en Botmaker pasa a ese mismo vendedor: hasta hoy se
    // asignaba el registro en el CRM y se presentaba al prospecto, pero el
    // chat quedaba sin dueño y el ejecutivo no lo veía.
    await asignarConversacionEnBotmaker(c.contact, vendedor.email)
    // Presentación al prospecto (solo con ventana Meta abierta).
    const ventanaAbierta = Boolean(c.last_user_at && ahora.getTime() - new Date(c.last_user_at).getTime() < VENTANA_META_MS)
    if (ventanaAbierta) {
      const texto = mensajePresentacion(pais, vendedor.nombre, { email: vendedor.email, whatsapp: vendedor.telefono })
      const enviado = await sendBotmakerMessage(c.contact, texto).catch(() => false)
      if (enviado) {
        await appendAssistantV3(c.contact, texto).catch(() => {})
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ presentado_al_prospecto: true }) })
      }
    }
    // El traspaso APAGA la cadencia automática de esta conversación: con un
    // vendedor encima, Vicky no sigue mandando toques (el único contacto
    // proactivo posterior es el chequeo de calidad de las 9 h hábiles).
    // Vicky sigue respondiendo REACTIVAMENTE si el cliente escribe.
    await supa(`vic_loop?contact=eq.${encodeURIComponent(c.contact)}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "ptv_traspasado" }),
    })
    await avisarEquipoInterno(
      `📞 PTV: traspaso a ${vendedor.email} — contacto +${c.contact} (TTV ${decision.ttv} min vencido, ${decision.motivo}). LLAMAR EN MENOS DE 5 MINUTOS. La conversación completa está en las notas del registro en Zoho; si hay link de pago vigente, empujar el mismo link.`,
    ).catch(() => {})
    traspasados.push({ contact: c.contact, vendedor: vendedor.email, ttv: decision.ttv || 0 })
  }

  // 2bis. Reloj de calificación 24 h hábiles → telemarketing (v2, solo CL).
  // Solo en horario hábil: a nadie se le entrega un lead a las 3 AM.
  const tmTraspasados: Array<{ contact: string; vendedor?: string; origen: string; pais: string }> = []
  if (v2Activo) {
    const { esHorarioHabil } = await import("@/lib/ptv")
    const candidatos: CandidatoTM[] = []
    const feriadosPorPais: Record<string, Set<string>> = {}
    // CL con tómbola de re-asignación; PE directo a Mónica (Lalo 04-ago:
    // Perú nace con el traspaso v2 — la contención ya persiste sus
    // conversaciones, así que los leads peruanos llegan a la ejecutiva
    // ANTES de que Vicky PE venda).
    // PE autónoma (Lalo 11-ago): el reloj de calificación PE también queda
    // en pausa — sin presentaciones en Perú hasta nueva orden.
    const paisesTm: Array<"cl" | "pe"> = (await pePresentaHabilitado()) ? ["cl", "pe"] : ["cl"]
    for (const paisTm of paisesTm) {
      const feriados = await feriadosDePais(paisTm)
      feriadosPorPais[paisTm] = feriados
      // Solo en horario hábil del país: a nadie se le entrega un lead a las 3 AM.
      if (!esHorarioHabil(paisTm, ahora, feriados)) continue
      const regex = TM_FONO_REGEX[paisTm]
      // Outbound: enrolado en el loop, sin respuesta (estado activo) y con el
      // toque 0 hace ≥24 h hábiles. La pausa anunciada suspende.
      const enLoop = await supa<{ contact: string; t0: string; compromiso_at: string | null }>(
        `vic_loop?estado=eq.activo&country=eq.${paisTm}&select=contact,t0,compromiso_at&limit=300`,
      )
      for (const r of enLoop) {
        if (candidatos.length >= MAX_TM_POR_TICK) break
        if (!regex.test(r.contact)) continue
        if (conTraspaso.has(r.contact)) continue
        if (isTestContact(r.contact, contactosPrueba)) continue
        if (r.compromiso_at && new Date(r.compromiso_at) > ahora) continue
        if (minutosHabilesEntre(new Date(r.t0), ahora, paisTm, feriados) < CALIFICACION_24H_MIN) continue
        candidatos.push({ contact: r.contact, origen: "outbound", pais: paisTm })
      }
      // Inbound: escribió UNA vez, no respondió la primera pregunta y no hay
      // hito comercial. Ventana de 14 días para no revivir fósiles.
      const desdeInbound = new Date(ahora.getTime() - 14 * 24 * 3600_000).toISOString()
      const corte24hCalendario = new Date(ahora.getTime() - 24 * 3600_000).toISOString()
      const inbound = await supa<{ contact: string; first_user_at: string | null; followup_closed_reason: string | null }>(
        `vic_v3_conversations?user_msg_count=eq.1&country=eq.${paisTm}&pref_quote_id=is.null&formal_quote_id=is.null` +
          `&followup_closed_reason=is.null&first_user_at=gte.${encodeURIComponent(desdeInbound)}` +
          `&first_user_at=lte.${encodeURIComponent(corte24hCalendario)}&select=contact,first_user_at,followup_closed_reason&limit=200`,
      )
      for (const r of inbound) {
        if (candidatos.length >= MAX_TM_POR_TICK) break
        if (!r.first_user_at) continue
        if (!regex.test(r.contact)) continue
        if (conTraspaso.has(r.contact)) continue
        if (isTestContact(r.contact, contactosPrueba)) continue
        if (compromisoPor.get(r.contact) && new Date(String(compromisoPor.get(r.contact))) > ahora) continue
        if (minutosHabilesEntre(new Date(r.first_user_at), ahora, paisTm, feriados) < CALIFICACION_24H_MIN) continue
        // Hitos fuera de la conversación: reunión agendada o llamada pedida =
        // intención comercial → NO va a telemarketing por esta vía.
        const reuniones = await supa<{ id: string }>(`vic_v3_meetings?contact=eq.${encodeURIComponent(r.contact)}&select=id&limit=1`)
        if (reuniones.length) continue
        const llamadas = await supa<{ id: string }>(`vic_scheduled_calls?contact=eq.${encodeURIComponent(r.contact)}&select=id&limit=1`)
        if (llamadas.length) continue
        candidatos.push({ contact: r.contact, origen: "inbound", pais: paisTm })
      }
    }
    for (const cand of candidatos) {
      const r = await traspasarATelemarketing(cand.contact, cand.origen, ahora, feriadosPorPais[cand.pais], cand.pais)
      if (r.ok) {
        conTraspaso.add(cand.contact)
        tmTraspasados.push({ contact: cand.contact, vendedor: r.vendedor, origen: cand.origen, pais: cand.pais })
      }
    }
  }

  // 3. Chequeos de calidad vencidos.
  const chequeos = await supa<{ id: string; contact: string; vendedor_email: string; vendedor_nombre: string | null }>(
    `vic_ptv?estado=eq.activo&chequeo_hecho_at=is.null&chequeo_at=lte.${encodeURIComponent(ahora.toISOString())}&select=id,contact,vendedor_email,vendedor_nombre&limit=20`,
  )
  let chequeosEnviados = 0
  for (const ch of chequeos) {
    const conv = convs.find((c) => c.contact === ch.contact)
    const pais = (paisDeContacto(ch.contact) || "cl") as "cl" | "co" | "mx" | "pe"
    const ventanaAbierta = Boolean(conv?.last_user_at && ahora.getTime() - new Date(conv.last_user_at).getTime() < VENTANA_META_MS)
    if (ventanaAbierta) {
      // Jamás un prefijo de correo en la cara del cliente: si no conocemos el
      // nombre, el chequeo pregunta por "nuestro ejecutivo" (filas viejas de
      // vic_ptv sin vendedor_nombre — auditoría 31-jul).
      const texto = mensajeChequeo(pais, ch.vendedor_nombre || NOMBRE_VENDEDOR[ch.vendedor_email] || "nuestro ejecutivo")
      const enviado = await sendBotmakerMessage(ch.contact, texto).catch(() => false)
      if (enviado) {
        await appendAssistantV3(ch.contact, texto).catch(() => {})
        chequeosEnviados++
      }
      await supa(`vic_ptv?id=eq.${ch.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_hecho_at: ahora.toISOString(), chequeo_resultado: enviado ? null : "sin_respuesta" }) })
    } else {
      await supa(`vic_ptv?id=eq.${ch.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_hecho_at: ahora.toISOString(), chequeo_resultado: "sin_respuesta" }) })
    }
  }

  // 4. CANDADO v3 (Lalo 07-ago, "haz la 2"): el traspaso ya no silencia a
  // Vicky hasta que el vendedor haga contacto REAL. Esta reconciliación
  // mantiene el vic_loop en sincronía con esa regla, en ambas direcciones.
  const reconciliacion = await reconciliarSilencioTraspasos().catch((e) => {
    console.warn("[ptv-cron] reconciliación de silencio falló:", e instanceof Error ? e.message : e)
    return { reabiertos: 0, recerrados: 0 }
  })

  // 4b. PRESENTACIONES PENDIENTES (Lalo 08-sep): los traspasos que quedaron
  // mudos con el cliente (reloj vencido antes de las 9, ventana cerrada) se
  // presentan apenas hay ventana.
  // INTERRUPTOR (Lalo 08-sep, "antes de presentar a cualquiera confírmame"):
  // el reintento del tick corre solo con vic_kv `ptv_reintento_presentacion`="on".
  const reintentoOn = ((await getKvValue("ptv_reintento_presentacion").catch(() => null)) || "").trim() === "on"
  const presentacionesPend = reintentoOn
    ? await reintentarPresentacionesPendientes(ahora).catch((e) => {
        console.warn("[ptv-cron] reintento de presentaciones falló:", e instanceof Error ? e.message : e)
        return { presentados: 0, pendientes: 0, detalle: [] as string[] }
      })
    : { presentados: 0, pendientes: 0, detalle: [] as string[] }
  if (presentacionesPend.presentados > 0 || presentacionesPend.pendientes > 0) {
    console.log(`[ptv-cron] presentaciones pendientes: ${JSON.stringify(presentacionesPend)}`)
  }

  // 4c. CONCILIACIÓN SDR → CALIFICADOS (Lalo 08-sep): con vic_kv
  // `sdr_recon_enabled`="on" (apagado por defecto hasta su OK).
  const sdrReconOn = ((await getKvValue("sdr_recon_enabled").catch(() => null)) || "").trim() === "on"
  if (sdrReconOn) {
    const rc = await reconciliarSdrCalificados(ahora).catch((e) => {
      console.warn("[ptv-cron] conciliación SDR falló:", e instanceof Error ? e.message : e)
      return { revisados: 0, reenviados: 0, detalle: [] as string[] }
    })
    if (rc.revisados > 0) console.log(`[ptv-cron] conciliación SDR: ${JSON.stringify(rc)}`)
  }

  // 5. ESCALADA SLA 60' (punto 1, Lalo 08-ago): traspaso activo sin contacto
  // real del vendedor a los 60 min hábiles → alerta interna, una sola vez.
  const slaAlertas = await escaladaSla(ahora).catch((e) => {
    console.warn("[ptv-cron] escalada SLA falló:", e instanceof Error ? e.message : e)
    return 0
  })

  // 7. COBRO ASISTIDO (punto 2 de la segunda tanda, Lalo 08-ago): cotización
  // ACEPTADA hace 30+ minutos sin señal de pago → un empujón de pago único.
  // El cliente que aceptó es el más caliente de todo el embudo.
  const limpieza = await limpiezaCartera7d(ahora).catch((e) => {
    console.warn("[ptv-cron] limpieza de cartera falló:", e instanceof Error ? e.message : e)
    return 0
  })

  const resorteos = await evaluarRespuestasChequeo(ahora).catch((e) => {
    console.warn("[ptv-cron] evaluador de chequeos falló:", e instanceof Error ? e.message : e)
    return { ok: 0, mal: 0 }
  })

  const chequeosOnb = await chequeoOnboardingPostPago(ahora).catch((e) => {
    console.warn("[ptv-cron] chequeo onboarding post-pago falló:", e instanceof Error ? e.message : e)
    return 0
  })

  const cobros = await cobroAsistido(ahora).catch((e) => {
    console.warn("[ptv-cron] cobro asistido falló:", e instanceof Error ? e.message : e)
    return { enviados: 0, pendientes: 0 }
  })

  // Latido (Lalo 08-ago): tick exitoso queda estampado; este cron vigila a los demás.
  {
    const { estamparLatido, vigilarLatidos } = await import("@/lib/latido")
    await estamparLatido("ptv").catch(() => undefined)
    await vigilarLatidos("ptv").catch(() => undefined)
  }

  // 8. CRONES HUÉRFANOS (Lalo 10-ago, "arréglalo"): vic-espejo-notas-cron y
  // vic-mudos-cron están declarados en vercel.json pero el scheduler real
  // nunca los dispara (el cron de Vercel corre contra el deployment de master
  // viejo). Este cron SÍ corre cada 10 minutos, así que los despacha él.
  const huerfanos = await despacharHuerfanos().catch(() => [] as string[])

  // 9. LEADS CRUZADOS DE PAÍS (caso Aleydis/+51994037412, 11-ago): la regla
  // de Zoho "Asignación Leads Vicky TLMK" corre ASÍNCRONA tras la creación y
  // puede pisar al dueño correcto con el roster CHILENO de calificación,
  // aunque el lead sea de otro país (el filtro de territorio de la regla
  // sigue pendiente del lado de Lalo). Este reconciliador deshace el cruce:
  // lead SIN convertir del roster CL con territorio ≠ Chile → ejecutivo de
  // su país (PE → Mónica, MX → Yahel). Best-effort, máx 10 por tick.
  const cruzados = await reconciliarLeadsCruzados().catch((e) => {
    console.warn("[ptv-cron] leads cruzados falló:", e instanceof Error ? e.message : e)
    return 0
  })

  // Fonos del form con prefijo de país duplicado → se corrigen en Zoho para
  // que el dedup por fono del chat calce (antes del rescate, mismo tick).
  const fonosForm = await normalizarFonosForm().catch((e) => {
    console.warn("[ptv-cron] normalizador fonos form falló:", e instanceof Error ? e.message : e)
    return 0
  })
  if (fonosForm) console.log(`[ptv-cron] fonos form corregidos: ${fonosForm}`)

  // RESCATE DEL FORM-FILL MUDO (Lalo 21-ago): lead del formulario de landing
  // sin conversación a las 24h → entrega al canal humano de su país.
  const rescatesForm = await rescatarFormSinConversacion(ahora).catch((e) => {
    console.warn("[ptv-cron] rescate form falló:", e instanceof Error ? e.message : e)
    return 0
  })
  if (rescatesForm) console.log(`[ptv-cron] rescate form: ${rescatesForm} leads entregados`)

  // BACKSTOP ENTERPRISE (Lalo 28-ago, caso Clínica Alemana→Ana): lead vivo
  // >300 personas parado en el roster TLMK → se re-encamina a calificación
  // SDR (la guarda de reasignarLeadCalificacionCL le deja la nota de misión:
  // conseguir el RUT para que la escalera lo suba a deal enterprise).
  const enterpriseTlmk = await reencaminarEnterpriseTlmk().catch((e) => {
    console.warn("[ptv-cron] backstop enterprise TLMK falló:", e instanceof Error ? e.message : e)
    return 0
  })
  if (enterpriseTlmk) console.log(`[ptv-cron] enterprise en TLMK re-encaminados: ${enterpriseTlmk}`)

  // Vigía del espejo (Lalo 24-ago): sin capturas en 3h hábiles → alerta.
  await vigilarEspejo(ahora).catch((e) => {
    console.warn("[ptv-cron] vigía espejo falló:", e instanceof Error ? e.message : e)
  })

  // REINTENTO DE CORREOS DE PAGADA POR TRANSFERENCIA (Lalo 01-sep, caso
  // Valuaciones/COT1052: el notify-paid best-effort murió en una tormenta de
  // tokens de Zoho y el correo jamás salió). Las marcas notify_pagada_pend_*
  // las deja notificarPagadaAlCotizador al fallar; acá se reintentan hasta
  // entregar (ventana 48h, máx 5 por tick).
  const notifPagadas = await reintentarNotifyPagadaPendientes().catch((e) => {
    console.warn("[ptv-cron] reintento notify-paid falló:", e instanceof Error ? e.message : e)
    return 0
  })
  if (notifPagadas) console.log(`[ptv-cron] correos PAGADA reintentados con éxito: ${notifPagadas}`)

  // Vigía de PROMESAS de contacto humano (P1 27-ago): promesas vencidas sin
  // evidencia en el espejo → alerta interna + visible en la Cartera.
  const promesas = await (async () => {
    const { vigilarPromesas } = await import("@/lib/promesas")
    return vigilarPromesas(15)
  })().catch((e) => {
    console.warn("[ptv-cron] vigía de promesas falló:", e instanceof Error ? e.message : e)
    return { revisadas: 0, cumplidas: 0, alertadas: 0 }
  })
  if (promesas.revisadas > 0) console.log(`[ptv-cron] promesas: ${JSON.stringify(promesas)}`)

  // Enriquecimiento de leads placeholder desde el chat (Lalo 13-ago): los
  // "Prospecto WhatsApp" se completan con lo que el cliente ya dijo.
  const enriquecidos = await enriquecerLeadsDeChat().catch((e) => {
    console.warn("[ptv-cron] enriquecimiento falló:", e instanceof Error ? e.message : e)
    return 0
  })

  // Estado del lead contra los hitos de la conversación (Eduardo 14-ago): el
  // status solo sube y la fecha de primer cambio se ancla al hito real.
  const statusConciliados = await conciliarStatusLeads().catch((e) => {
    console.warn("[ptv-cron] conciliación de status falló:", e instanceof Error ? e.message : e)
    return 0
  })

  // La conversación en Botmaker sigue al dueño del registro en Zoho.
  const asignacionBm = await conciliarAsignacionBotmaker().catch((e) => {
    console.warn("[ptv-cron] conciliación Botmaker falló:", e instanceof Error ? e.message : e)
    return { asignadas: 0, revisadas: 0, notas: 0 }
  })

  return NextResponse.json({
    ok: true,
    crones_huerfanos_despachados: huerfanos,
    leads_cruzados_corregidos: cruzados,
    leads_enriquecidos: enriquecidos,
    leads_status_conciliados: statusConciliados,
    conversaciones_asignadas_botmaker: asignacionBm.asignadas,
    conversaciones_revisadas_botmaker: asignacionBm.revisadas,
    notas_transcripcion_refrescadas: asignacionBm.notas,
    conversaciones_revisadas: convs.length,
    traspasados,
    tm_traspasados: tmTraspasados,
    chequeos_procesados: chequeos.length,
    chequeos_enviados: chequeosEnviados,
    loops_reabiertos_sin_atencion: reconciliacion.reabiertos,
    loops_recerrados_por_atencion: reconciliacion.recerrados,
    sla_alertas_60min: slaAlertas,
    cobros_asistidos: cobros.enviados,
    chequeos_onboarding_post_pago: chequeosOnb,
    chequeos_ok: resorteos.ok,
    chequeos_mal_resorteados: resorteos.mal,
    cartera_cierre_perdido_7d: limpieza,
    aceptadas_sin_pago: cobros.pendientes,
  })
  } finally {
    await liberarTurno("ptv").catch(() => undefined)
  }
}

/**
 * COBRO ASISTIDO (punto 2 de la segunda tanda, Lalo 08-ago): mide el gap
 * aceptada→pago y lo ataca. Barre cotizaciones en estado "Aceptada"
 * modificadas en las últimas 6 horas; si a los 30+ minutos no hay señal de
 * pago (loop cerrado por pagado, estado Pagada, o nota de venta emitida), se
 * envía UN mensaje de ayuda al pago (ventana de Meta abierta) — una sola vez
 * por cotización (kv cobro_asistido_<quoteId>).
 */
/** Ventana de contacto proactivo al cliente (Rodrigo 09-ago): todos los días
 * 9:00-21:00 hora local del contacto — ningún mensaje proactivo fuera de ella.
 * (Las alertas INTERNAS al equipo no se gatean: esas corren a toda hora.) */
function enVentanaProactiva(fono: string, ahora: Date): boolean {
  const pais = paisDeContacto(fono) || "cl"
  const tz =
    pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const hora =
    Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(ahora)) % 24
  return hora >= 9 && hora < 21
}

/**
 * PRESENTACIÓN PENDIENTE (Lalo 08-sep, "confirmo"): 19 de los 21 traspasos
 * sin presentar de la semana fueron los relojes que vencen a las 08:00-08:41
 * — el mensaje al cliente salía fuera de la ventana 9-21 (o con la ventana de
 * Meta cerrada tras el fin de semana) y nadie lo reintentaba: el ejecutivo
 * recibía el lead y el cliente jamás sabía quién lo atendía. Ahora cada tick
 * en ventana reintenta las presentaciones pendientes de traspasos ACTIVOS de
 * menos de 48 h: mensaje si la ventana de Meta está abierta, plantilla
 * `vicky_traspaso_ejecutivo` si no (CL/PE; sin teléfono del vendedor no se
 * presenta a medias). Máximo 10 por tick para no hacer ráfaga.
 */
async function reintentarPresentacionesPendientes(
  ahora: Date,
  opts: { max?: number; horas?: number; orden?: "asc" | "desc" } = {},
): Promise<{ presentados: number; pendientes: number; detalle: string[] }> {
  const maxPorPasada = Math.max(1, Math.min(60, Number(opts.max) || 10))
  const horas = Math.max(1, Math.min(24 * 90, Number(opts.horas) || 48))
  const orden = opts.orden === "desc" ? "desc" : "asc"
  const desde = new Date(ahora.getTime() - horas * 3600_000).toISOString()
  const filas = await supa<{
    id: string
    contact: string
    vendedor_email: string | null
    vendedor_nombre: string | null
    vendedor_zoho_id: string | null
    traspasado_at: string
  }>(
    `vic_ptv?estado=eq.activo&presentado_al_prospecto=eq.false&traspasado_at=gte.${encodeURIComponent(desde)}` +
      `&select=id,contact,vendedor_email,vendedor_nombre,vendedor_zoho_id,traspasado_at&order=traspasado_at.${orden}&limit=200`,
  ).catch(() => [])
  let presentados = 0
  let pendientes = 0
  const detalle: string[] = []
  const tests = testContactSet()
  let H: Record<string, string> | null = null
  let api = ""
  for (const f of filas) {
    const clean = String(f.contact || "").replace(/\D/g, "")
    const email = (f.vendedor_email || "").trim()
    if (!clean || !email || isTestContact(clean, tests)) continue
    if (!enVentanaProactiva(clean, ahora)) {
      pendientes++
      continue
    }
    if (presentados >= maxPorPasada) {
      pendientes++
      continue
    }
    // Un traspaso de hace menos de 5 min lo presenta su propio camino; acá
    // solo entran los que quedaron mudos.
    if (ahora.getTime() - new Date(f.traspasado_at).getTime() < 5 * 60_000) continue
    const pais = (paisDeContacto(clean) || "cl") as "cl" | "co" | "mx" | "pe"
    const nombre = (f.vendedor_nombre || "").trim() || NOMBRE_VENDEDOR[email] || email.split("@")[0]
    let telefono = WHATSAPP_VENDEDOR[email] || telefonoTmPorEmail(email)
    if (!telefono && f.vendedor_zoho_id) {
      try {
        if (!H) {
          const { getZohoAccessToken } = await import("@/lib/zoho-token")
          const token = await getZohoAccessToken()
          api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
          H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
        }
        telefono = await telefonoDeUsuario(String(f.vendedor_zoho_id), H, api)
      } catch { /* sin teléfono: se decide abajo */ }
    }
    const conv = await supa<{ last_user_at: string | null }>(
      `vic_v3_conversations?contact=eq.${encodeURIComponent(clean)}&select=last_user_at&limit=1`,
    ).catch(() => [])
    const lastUser = conv[0]?.last_user_at ? new Date(conv[0].last_user_at).getTime() : 0
    const ventanaAbierta = lastUser > 0 && ahora.getTime() - lastUser < VENTANA_META_MS
    let enviado = false
    let registro = ""
    if (ventanaAbierta) {
      const texto = mensajePresentacion(pais, nombre, { email, whatsapp: telefono || undefined })
      enviado = await sendBotmakerMessage(clean, texto).catch(() => false)
      registro = texto
    } else if ((pais === "cl" || pais === "pe") && telefono) {
      enviado = await sendBotmakerTemplate(clean, TM_TEMPLATE, {
        nombre: "👋",
        ejecutivo_smb: nombre,
        telefono_ejecutivo: telefono,
        correoElectronico: email,
      }).catch(() => false)
      registro = `[Plantilla ${TM_TEMPLATE}]: presenté a ${nombre} (${telefono} · ${email}) como tu ejecutivo de acompañamiento.`
    } else {
      pendientes++
      continue
    }
    if (enviado) {
      await supa(`vic_ptv?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify({ presentado_al_prospecto: true }) }).catch(() => {})
      await appendAssistantV3(clean, registro).catch(() => {})
      presentados++
      detalle.push(`+${clean} → ${nombre} (${ventanaAbierta ? "texto" : "plantilla"})`)
      console.log(`[ptv-cron] presentación reintentada +${clean} → ${email} (${ventanaAbierta ? "texto" : "plantilla"})`)
    } else {
      pendientes++
      detalle.push(`+${clean} → ${nombre}: NO salió (${ventanaAbierta ? "texto" : "plantilla"})`)
    }
  }
  return { presentados, pendientes, detalle }
}

/**
 * CONCILIACIÓN SDR → CALIFICADOS (Lalo 08-sep, "los de Aleydis y Aracelli
 * solo deberían traspasárselos si no se logró calificar; si no, tómbola de
 * leads TLMK sin RUT y deal + tómbola con RUT"). Cada tick repasa leads y
 * deals de la última semana en manos del roster SDR: si la conversación o el
 * registro ya traen dotación (calificado) y no está cerrado ni marcado "No
 * Calificado", se re-entrega por la regla correcta, se avisa al nuevo dueño y
 * se presenta al cliente. Solo abiertos: pagados y perdidos no se tocan.
 * Candado kv `sdr_recon_<id>` (7 d). Máximo 4 por tick.
 */
async function reconciliarSdrCalificados(ahora: Date): Promise<{ revisados: number; reenviados: number; detalle: string[] }> {
  const roster = (process.env.VICKY_TM_ROSTER_CALIFICACION_EMAILS || "aaraque@geovictoria.com,asepulveda@geovictoria.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  const out = { revisados: 0, reenviados: 0, detalle: [] as string[] }
  if (!roster.length) return out
  const desde = new Date(ahora.getTime() - 7 * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const coql = async <T,>(q: string): Promise<T[]> => {
    const r = await fetch(`${api}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }) })
    if (!r.ok || r.status === 204) return []
    return (((await r.json().catch(() => ({}))) as { data?: T[] }).data || [])
  }
  const lista = roster.map((e) => `'${e}'`).join(",")
  const tests = testContactSet()
  const cerrado = async (fono: string): Promise<boolean> => {
    // Pagado (venta en caja) = cerrado; también comprobante/pago online reciente.
    const punteros = await getQuotePointers(fono).catch(() => [])
    for (const p of punteros) {
      if (p.quoteId && (await getKvValue(`venta_dash_v3_${p.quoteId}`).catch(() => null))) return true
    }
    if (await getKvValue(`comprobante_ok_${fono}`).catch(() => null)) return true
    if (await getKvValue(`pago_online_${fono}`).catch(() => null)) return true
    return false
  }
  const presentar = async (fono: string, email: string, zohoId: string, nombre: string, motivo: string) => {
    // La fila vic_ptv activa del contacto pasa al dueño nuevo y se presenta.
    const filas = await supa<{ id: string }>(`vic_ptv?contact=eq.${fono}&estado=eq.activo&select=id&limit=1`).catch(() => [])
    if (filas[0]?.id) {
      await supa(`vic_ptv?id=eq.${filas[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ vendedor_email: email, vendedor_zoho_id: zohoId, vendedor_nombre: nombre, presentado_al_prospecto: false, motivo }),
      }).catch(() => {})
    } else {
      await supa(`vic_ptv`, {
        method: "POST",
        body: JSON.stringify({ contact: fono, motivo, ttv_minutos: 0, precio_mostrado: false, vendedor_email: email, vendedor_zoho_id: zohoId, vendedor_nombre: nombre, traspasado_at: ahora.toISOString(), presentado_al_prospecto: false, estado: "activo" }),
      }).catch(() => {})
    }
    await asignarConversacionEnBotmaker(fono, email).catch(() => {})
    await reintentarPresentacionesPendientes(ahora, { max: 3, horas: 24 * 8 }).catch(() => null)
  }
  let chatsLeidos = 0
  // ── Leads vivos del roster SDR ──
  const leads = await coql<{ id: string; Phone?: string; Lead_Status?: string; N_Empleados_que_marcan?: number; RUT_Empresa?: string; "Owner.email"?: string; First_Name?: string; Company?: string }>(
    `select id, Phone, Lead_Status, N_Empleados_que_marcan, RUT_Empresa, Owner.email, First_Name, Company from Leads ` +
      `where ((Owner.email in (${lista}) and Converted__s = false) and Created_Time >= '${desde}') limit 60`,
  )
  for (const l of leads) {
    if (out.reenviados >= 4) break
    const status = String(l.Lead_Status || "")
    if (/no calificado/i.test(status)) continue
    const fono = String(l.Phone || "").replace(/\D/g, "")
    if (!fono || !fono.startsWith("56") || isTestContact(fono, tests)) continue
    if (await getKvValue(`sdr_recon_${l.id}`).catch(() => null)) continue
    // Con deal vivo del mismo fono (candado deal_fono_, caso Joyce: la formal
    // creó el deal sin convertir el lead) manda el bloque de DEALS de abajo.
    if (await getKvValue(`deal_fono_${fono}`).catch(() => null)) continue
    out.revisados++
    let empleados = Number(l.N_Empleados_que_marcan || 0) || 0
    let rut = String(l.RUT_Empresa || "").trim()
    let datosChat: { nombre?: string; empresa?: string; email?: string } = {}
    if (empleados <= 0 && !status.trim().startsWith("4.") && chatsLeidos < 3) {
      chatsLeidos++
      try {
        const { datosDelChat } = await import("@/lib/extraer-datos-chat")
        const chat = await datosDelChat(fono)
        empleados = chat.empleados || 0
        rut = rut || chat.rut || ""
        datosChat = { nombre: chat.nombre, empresa: chat.empresa, email: chat.email }
      } catch { /* sin lectura: no calificado por ahora */ }
    }
    const calificado = empleados > 0 || status.trim().startsWith("4.")
    if (!calificado) continue
    if (await cerrado(fono)) {
      await setKvValue(`sdr_recon_${l.id}`, "cerrado").catch(() => {})
      continue
    }
    await setKvValue(`sdr_recon_${l.id}`, ahora.toISOString()).catch(() => {})
    try {
      if (rut) {
        // Con RUT: deal (forzado) + Tómbola Deals.
        const { sincronizarHitoCrm } = await import("@/lib/crm-hitos")
        await sincronizarHitoCrm(fono, "intencion", { ...datosChat, rut, empleados: empleados || undefined, forzarDeal: true })
        const rs = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
        const filas = rs.ok && rs.status !== 204 ? (((await rs.json().catch(() => ({}))) as { data?: Array<{ Converted_Deal?: { id?: string } | null }> }).data || []) : []
        const dealId = filas.find((x) => x.Converted_Deal?.id)?.Converted_Deal?.id || ""
        if (dealId && TOMBOLA_DEALS_RULE.cl) {
          const put = await fetch(`${api}/crm/v3/Deals`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: dealId }], lar_id: TOMBOLA_DEALS_RULE.cl }) })
          const get = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner`, { headers: H, cache: "no-store" })
          const owner = (((await get.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]?.Owner)
          if (put.ok && owner?.id && owner?.email && !roster.includes(owner.email.toLowerCase())) {
            const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
            await notificarTraspasoDeal(dealId).catch(() => {})
            await presentar(fono, owner.email, owner.id, owner.name || owner.email.split("@")[0], "sdr_calificado_deal")
            out.reenviados++
            out.detalle.push(`+${fono} lead ${l.id} (${empleados} pers., RUT) → deal ${dealId} → ${owner.email}`)
            await avisarEquipoInterno(`🔁 CONCILIACIÓN SDR: +${fono} (${l.Company || datosChat.empresa || "?"}, ${empleados || "?"} personas, con RUT) estaba con ${l["Owner.email"]} sin calificar y ya está CALIFICADO → deal ${dealId} sorteado a ${owner.email}.`).catch(() => {})
            continue
          }
        }
      }
      // Sin RUT (o sin deal): lead calificado → tómbola de leads TLMK.
      const { reasignarLeadCalificacionCL, updateZohoLeadStatus } = await import("@/lib/zoho-leads")
      if (!status.trim().startsWith("4.")) await updateZohoLeadStatus(l.id, "4. Calificado").catch(() => {})
      if (empleados > 0 && !(Number(l.N_Empleados_que_marcan || 0) > 0)) {
        await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: l.id, N_Empleados_que_marcan: empleados }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }) }).catch(() => null)
      }
      const r = await reasignarLeadCalificacionCL(l.id, { calificado: true }).catch(() => null)
      if (r?.success && r.ownerEmail && r.ownerId && !roster.includes(r.ownerEmail.toLowerCase())) {
        await notificarTraspasoLeadEmail(l.id, r.ownerEmail, fono, H, api, `estaba en calificación SDR y la conversación YA trae la dotación (${empleados || "?"} personas): <b>lead calificado, ahora es tuyo</b>.`).catch(() => {})
        await presentar(fono, r.ownerEmail, r.ownerId, r.ownerNombre || NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0], "sdr_calificado_lead")
        out.reenviados++
        out.detalle.push(`+${fono} lead ${l.id} (${empleados} pers., sin RUT) → TLMK ${r.ownerEmail}`)
        await avisarEquipoInterno(`🔁 CONCILIACIÓN SDR: +${fono} (${l.Company || datosChat.empresa || "?"}, ${empleados || "?"} personas, sin RUT) estaba con ${l["Owner.email"]} y ya está CALIFICADO → tómbola TLMK → ${r.ownerEmail}.`).catch(() => {})
      } else {
        out.detalle.push(`+${fono} lead ${l.id}: la regla TLMK devolvió ${r?.ownerEmail || "nada"} (sin cambio)`)
      }
    } catch (e) {
      out.detalle.push(`+${fono} lead ${l.id}: error ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // ── Deals vivos del roster SDR (lead calificado que ya convirtió) ──
  const deals = await coql<{ id: string; Deal_Name?: string; Stage?: string; N_Empleados_que_marcan?: number; "Owner.email"?: string; "Contact_Name.Phone"?: string }>(
    `select id, Deal_Name, Stage, N_Empleados_que_marcan, Owner.email, Contact_Name.Phone from Deals ` +
      `where ((Owner.email in (${lista}) and Created_Time >= '${desde}') and Stage not in ('Cierre Perdido','7. Implementando','8. Facturando')) limit 40`,
  )
  for (const d of deals) {
    if (out.reenviados >= 4) break
    if (await getKvValue(`sdr_recon_deal_${d.id}`).catch(() => null)) continue
    const fono = String(d["Contact_Name.Phone"] || "").replace(/\D/g, "")
    if (!fono || !fono.startsWith("56") || isTestContact(fono, tests)) continue
    out.revisados++
    if (await cerrado(fono)) {
      await setKvValue(`sdr_recon_deal_${d.id}`, "cerrado").catch(() => {})
      continue
    }
    await setKvValue(`sdr_recon_deal_${d.id}`, ahora.toISOString()).catch(() => {})
    try {
      if (!TOMBOLA_DEALS_RULE.cl) break
      const put = await fetch(`${api}/crm/v3/Deals`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: d.id }], lar_id: TOMBOLA_DEALS_RULE.cl }) })
      const get = await fetch(`${api}/crm/v3/Deals/${d.id}?fields=Owner`, { headers: H, cache: "no-store" })
      const owner = (((await get.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]?.Owner)
      if (put.ok && owner?.id && owner?.email && !roster.includes(owner.email.toLowerCase())) {
        const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
        await notificarTraspasoDeal(d.id).catch(() => {})
        await presentar(fono, owner.email, owner.id, owner.name || owner.email.split("@")[0], "sdr_calificado_deal")
        out.reenviados++
        out.detalle.push(`+${fono} deal ${d.id} (${d.Deal_Name || ""}) → ${owner.email}`)
        await avisarEquipoInterno(`🔁 CONCILIACIÓN SDR: el deal ${d.Deal_Name || d.id} (+${fono}) estaba con ${d["Owner.email"]} (calificación) y ya está CALIFICADO → Tómbola Deals → ${owner.email}.`).catch(() => {})
      } else {
        out.detalle.push(`+${fono} deal ${d.id}: la tómbola devolvió ${owner?.email || "nada"} (sin cambio)`)
      }
    } catch (e) {
      out.detalle.push(`+${fono} deal ${d.id}: error ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/**
 * LIMPIEZA DE CARTERA (biblia VB 12-ago, orden de Lalo): deals de VICKY en
 * etapas tempranas (1/2/3/4) con MÁS DE 7 DÍAS CORRIDOS sin última actividad
 * pasan a "Cierre Perdido" vía transición de Blueprint (el Stage no se
 * escribe directo). Máx 5 por tick, candado kv por deal (un intento diario),
 * y verificación releyendo el Stage — el SUCCESS del PUT no garantiza nada
 * (cicatriz "partially saved" del 20-jul). "6. Listo para Cierre" (aceptadas)
 * y "7. Implementando" (pagadas) NO se tocan.
 */
async function limpiezaCartera7d(ahora: Date): Promise<number> {
  if ((process.env.VICKY_LIMPIEZA_7D_OFF || "").trim() === "1") return 0
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return 0
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  // 14 DÍAS (Lalo 21-ago, compromiso con el equipo: "cambiar los tiempos de
  // cierre perdido automático a 2 semanas" — antes 7). Override sin deploy:
  // env VICKY_CARTERA_DIAS.
  const diasCartera = Math.max(1, Number(process.env.VICKY_CARTERA_DIAS || 14) || 14)
  const corte = new Date(ahora.getTime() - diasCartera * 86400e3).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const q =
    `select id, Deal_Name, Stage, Last_Activity_Time, Contact_Name.Phone, Contact_Name.Mobile from Deals ` +
    `where Deal_Name like '%Cotización Vicky%' and Last_Activity_Time <= '${corte}' ` +
    `and Stage in ('1. Trato Creado', '2. Primera Reunion Realizada', '3. En Levantamiento', '4. Propuesta Enviada / En Negociación') ` +
    `order by Last_Activity_Time asc limit 0, 20`
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }),
  }).catch(() => null)
  const deals = res && res.ok ? (((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
  if (!deals.length) return 0
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  let cerrados = 0
  for (const d of deals) {
    if (cerrados >= 5) break
    const dealId = String(d.id || "")
    // LAS 3 FUENTES DE ACTIVIDAD (Lalo 13-ago, "debe estar impecable"): Zoho
    // ya filtró por Last_Activity, pero un deal puede estar VIVO por WhatsApp
    // de Vicky o del VENDEDOR (espejo) sin que Zoho lo sepa — jamás cerrarlo
    // como perdido en ese caso (patrón real: Paola/G&A, venta activa por
    // espejo con Zoho quieto).
    let fonoDeal = String(d["Contact_Name.Mobile"] || d["Contact_Name.Phone"] || "").replace(/\D/g, "")
    if (fonoDeal.length === 9 && fonoDeal.startsWith("9")) fonoDeal = `56${fonoDeal}`
    if (fonoDeal) {
      const corte7dIso = new Date(ahora.getTime() - 7 * 86400e3).toISOString()
      const [convViva, espejoVivo, llamadaViva] = await Promise.all([
        supa<{ id: string }>(`vic_v3_conversations?contact=eq.${fonoDeal}&updated_at=gte.${corte7dIso}&select=id&limit=1`),
        supa<{ id: string }>(`vic_wa_espejo_mensajes?telefono_chat=eq.${fonoDeal}&enviado_at=gte.${corte7dIso}&select=id&limit=1`),
        supa<{ id: string }>(`vic_wa_espejo_llamadas?telefono=eq.${fonoDeal}&at=gte.${corte7dIso}&select=id&limit=1`),
      ])
      if (convViva.length || espejoVivo.length || llamadaViva.length) {
        console.log(`[cartera-7d] deal ${dealId} (${fonoDeal}): actividad viva en ${convViva.length ? "Vicky" : espejoVivo.length ? "espejo vendedor" : "llamada espejo"} — NO se cierra.`)
        continue
      }
    }
    const marca = `cierre7d_${dealId}`
    const previa = await getKvValue(marca).catch(() => null)
    // Un intento por día por deal: los que fallan (transición no disponible,
    // campos raros) no se martillan cada 10 minutos.
    if (previa && ahora.getTime() - new Date(previa).getTime() < 20 * 3600e3) continue
    await setKvValue(marca, ahora.toISOString()).catch(() => {})
    try {
      const bpRes = await fetch(`${api}/crm/v2/Deals/${dealId}/actions/blueprint`, { headers: H, cache: "no-store" })
      if (!bpRes.ok) continue
      const bp = (await bpRes.json().catch(() => ({}))) as {
        blueprint?: { transitions?: Array<{ id: string; name?: string; next_field_value?: string; data?: Record<string, unknown>; fields?: Array<{ api_name?: string; data_type?: string }> }> }
      }
      const transitions = bp?.blueprint?.transitions || []
      const match = transitions.find((t) =>
        (String(t.next_field_value || "").toLowerCase().includes("perdido")) ||
        (String(t.name || "").toLowerCase().includes("perdido")),
      )
      if (!match) {
        console.log(`[cartera-7d] deal ${dealId}: sin transición a Cierre Perdido (${transitions.map((t) => t.next_field_value || t.name).join(", ").slice(0, 100)})`)
        continue
      }
      const data: Record<string, unknown> = { ...(match.data || {}) }
      const campos = match.fields || []
      const tieneCampo = (apiName: string) => campos.some((f) => f.api_name === apiName)
      if (tieneCampo("Raz_n_de_P_rdida") && !data.Raz_n_de_P_rdida) data.Raz_n_de_P_rdida = "Otro"
      if (tieneCampo("Explicaci_n_Raz_n_P_rdida_Otro") && !data.Explicaci_n_Raz_n_P_rdida_Otro) {
        data.Explicaci_n_Raz_n_P_rdida_Otro = "Limpieza automática: 7 días corridos sin actividad (regla Vicky 13-ago)"
      }
      for (const f of campos) {
        const apiName = f.api_name || ""
        if (f.data_type === "multiselectpicklist" && apiName && typeof data[apiName] === "string") {
          data[apiName] = String(data[apiName]).split(";").map((v) => v.trim()).filter(Boolean)
        }
      }
      const exec = await fetch(`${api}/crm/v2/Deals/${dealId}/actions/blueprint`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: match.id, data }] }),
      })
      const execData = (await exec.json().catch(() => ({}))) as { code?: string }
      if (!exec.ok || (execData?.code && execData.code !== "SUCCESS")) continue
      const ver = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Stage`, { headers: H, cache: "no-store" })
      const verData = (await ver.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }
      const stageNuevo = String(verData?.data?.[0]?.Stage || "")
      if (/perdido/i.test(stageNuevo)) {
        cerrados++
        console.log(`[cartera-7d] deal ${dealId} (${String(d.Deal_Name || "")}) → Cierre Perdido (sin actividad desde ${String(d.Last_Activity_Time || "")})`)
      }
    } catch (e) {
      console.warn(`[cartera-7d] deal ${dealId} falló:`, e instanceof Error ? e.message : e)
    }
  }
  return cerrados
}

/**
 * R5 DE LA BIBLIA — evaluador del chequeo 9h (VB 12-ago): tras el "¿cómo te
 * fue con {Vendedor}?", clasifica la PRIMERA respuesta del cliente. Mala
 * respuesta ("no me han llamado", "nadie me contactó") → alerta interna +
 * RE-SORTEO inmediato: la tómbola corre de nuevo, vic_ptv cambia de vendedor
 * y el nuevo se presenta al cliente. Respuesta positiva → chequeo_resultado
 * 'ok'. Determinista (regex), sin LLM — máx 10 por tick.
 */
async function evaluarRespuestasChequeo(ahora: Date): Promise<{ ok: number; mal: number }> {
  const filas = await supa<{
    id: string
    contact: string
    vendedor_email: string
    vendedor_nombre: string | null
    chequeo_hecho_at: string
  }>(
    `vic_ptv?estado=eq.activo&chequeo_hecho_at=not.is.null&chequeo_resultado=is.null&select=id,contact,vendedor_email,vendedor_nombre,chequeo_hecho_at&limit=10`,
  )
  if (!filas.length) return { ok: 0, mal: 0 }
  const NEGATIVA =
    /\b(no me (ha[ns]? )?(llamado|contactado|escrito|hablado)|nadie me|todav[ií]a no|a[uú]n no|aun no|ninguna llamada|no he (hablado|recibido|sabido)|sin noticias|mal[ai]?\b|pesim|nunca me)/i
  const POSITIVA = /\b(s[ií]\b|ya (me )?(llam|habl|contact|escrib)|todo (bien|ok|perfecto)|excelente|muy bien|gracias|conversamos|hablamos)/i
  let okCount = 0
  let malCount = 0
  for (const f of filas) {
    // Primera respuesta del CLIENTE posterior al chequeo.
    const conv = await supa<{ id: string }>(
      `vic_v3_conversations?contact=eq.${f.contact}&select=id&limit=1`,
    ).catch(() => [])
    if (!conv.length) continue
    const msgs = await supa<{ content: string; at: string }>(
      `vic_v3_messages?conversation_id=eq.${conv[0].id}&role=eq.user&at=gt.${encodeURIComponent(f.chequeo_hecho_at)}&select=content,at&order=at.asc&limit=2`,
    ).catch(() => [])
    if (!msgs.length) continue // aún sin respuesta: el chequeo sigue pendiente
    const texto = msgs.map((m) => m.content).join(" ").slice(0, 300)
    const esMala = NEGATIVA.test(texto) && !POSITIVA.test(texto)
    if (!esMala) {
      await supa(`vic_ptv?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_resultado: "ok" }) })
      okCount++
      continue
    }
    // MALA respuesta → alerta + re-sorteo + presentación del nuevo vendedor.
    malCount++
    const pais = (paisDeContacto(f.contact) || "cl") as "cl" | "co" | "mx" | "pe"
    const { avisarEquipoInterno } = await import("@/lib/alerta-interna")
    await avisarEquipoInterno(
      `🚨 CHEQUEO 9H NEGATIVO: +${f.contact} dice que ${f.vendedor_nombre || f.vendedor_email || "el vendedor"} no lo contactó ("${texto.slice(0, 120)}"). Re-sorteando vendedor (R5 biblia).`,
    ).catch(() => {})
    const interno = await siguienteVendedor(pais)
    if (!interno) {
      await supa(`vic_ptv?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_resultado: "mal" }) })
      continue
    }
    const nuevo = await asignarEnZoho(f.contact, pais, interno, true).catch(() => null)
    if (nuevo?.email) await asignarConversacionEnBotmaker(f.contact, nuevo.email)
    if (nuevo && nuevo.email && nuevo.email !== f.vendedor_email) {
      await supa(`vic_ptv?id=eq.${f.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          chequeo_resultado: "mal",
          vendedor_email: nuevo.email,
          vendedor_zoho_id: nuevo.zohoId,
          vendedor_nombre: nuevo.nombre,
          reasignado_at: new Date().toISOString(),
        }),
      })
      const texto2 = mensajePresentacion(pais, nuevo.nombre, { email: nuevo.email, whatsapp: nuevo.telefono })
      const enviado = await sendBotmakerMessage(f.contact, `Mil disculpas por la espera 🙏 ${texto2}`).catch(() => false)
      if (enviado) await appendAssistantV3(f.contact, texto2).catch(() => {})
    } else {
      // La tómbola devolvió al mismo (o falló): queda la alerta y el resultado.
      await supa(`vic_ptv?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_resultado: "mal" }) })
    }
  }
  return { ok: okCount, mal: malCount }
}

/**
 * TOQUE POST-PAGO (biblia VB 12-ago; plantilla vicky_chequeo_onboarding
 * APROBADA por Meta el 13-ago): al día siguiente del pago, Vicky pregunta
 * cómo va la activación de la cuenta. Ventana objetivo: cotizaciones PAGADAS
 * hace 18-32 horas (≈ "ayer"). Un solo envío por cotización (candado kv),
 * ventana proactiva 9-21, prefijos discables y sin contactos internos.
 * La plantilla abre fuera de la ventana de Meta (24h+ tras el pago es lo
 * normal); su saludo con presentación es válido: re-abre un hilo dormido.
 */
async function chequeoOnboardingPostPago(ahora: Date): Promise<number> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return 0
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const desde = new Date(ahora.getTime() - 32 * 3600_000)
  const hasta = new Date(ahora.getTime() - 18 * 3600_000)
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const q =
    `select id, Numero_Cotizacion, Telefono_Cliente, Tel_fono_Contacto, Pagador_Nombre, Modified_Time ` +
    `from Cotizaciones_GeoVictoria where Estado_Cotizacion = 'Pagada' and Modified_Time >= '${fmt(desde)}' ` +
    `and Modified_Time <= '${fmt(hasta)}' order by Modified_Time desc limit 0, 30`
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: q }),
  }).catch(() => null)
  const data = res && res.ok ? (((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
  if (!data.length) return 0
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const tpl = (process.env.VICKY_TPL_CHEQUEO_ONBOARDING || "vicky_chequeo_onboarding").trim()
  const pruebas = testContactSet()
  let enviados = 0
  for (const cot of data) {
    if (enviados >= 10) break
    const fono = String(cot.Telefono_Cliente || cot.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (!/^(56|57|52|51)\d{8,12}$/.test(fono) || isTestContact(fono, pruebas)) continue
    if (!enVentanaProactiva(fono, ahora)) continue
    const quoteId = String(cot.id || "")
    const marca = `chequeo_onboarding_${quoteId}`
    if (await getKvValue(marca).catch(() => null)) continue
    const nombre = String(cot.Pagador_Nombre || "").trim().split(/\s+/)[0] || "👋"
    const ok = await sendBotmakerTemplate(fono, tpl, { nombre }).catch(() => false)
    if (!ok) continue
    await setKvValue(marca, new Date().toISOString()).catch(() => {})
    await appendAssistantV3(
      fono,
      `Te escribí para saber cómo va la activación de tu cuenta tras el pago de ayer 😊 Si necesitas una mano con la configuración, me dices por aquí.`,
    ).catch(() => {})
    enviados++
    console.log(`[ptv-cron] chequeo onboarding post-pago → ${fono} (${String(cot.Numero_Cotizacion || quoteId)})`)
  }
  return enviados
}

async function cobroAsistido(ahora: Date): Promise<{ enviados: number; pendientes: number }> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return { enviados: 0, pendientes: 0 }
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  // 20h de lookback (no 6): una aceptada a las 22:00 queda gateada por la
  // ventana 9-21 y debe seguir apareciendo en la consulta a la mañana
  // siguiente. La marca kv por cotización evita dobles envíos.
  const desde = new Date(ahora.getTime() - 20 * 3600_000)
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const q =
    `select id, Numero_Cotizacion, Telefono_Cliente, Tel_fono_Contacto, Modified_Time, ID_SO ` +
    `from Cotizaciones_GeoVictoria where Estado_Cotizacion = 'Aceptada' and Modified_Time >= '${fmt(desde)}' ` +
    `order by Modified_Time desc limit 0, 50`
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: q }),
  }).catch(() => null)
  const data = res && res.ok ? (((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
  if (!data.length) return { enviados: 0, pendientes: 0 }
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const pruebas = testContactSet()
  let enviados = 0
  let pendientes = 0
  for (const cot of data) {
    const fono = String(cot.Telefono_Cliente || cot.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (!/^(56|57|52|51)\d{8,12}$/.test(fono) || isTestContact(fono, pruebas)) continue
    // Señal de pago: loop cerrado por PAGO REAL (motivo diferenciado 10-ago).
    // OJO: ID_SO ya NO sirve — desde que la cotización nace en Creator al
    // emitirse, ese campo viene lleno SIEMPRE (dejaba al cobro asistido ciego).
    const loopRow = await supa<{ contact: string; stage: string | null; motivo_cierre: string | null }>(
      `vic_loop?contact=eq.${encodeURIComponent(fono)}&select=contact,stage,motivo_cierre&limit=1`,
    )
    const loop = loopRow[0]
    if (loop?.motivo_cierre === "pagado") continue
    // CADENCIA DE CIERRE (25-ago, VB Lalo): la aceptación ya no cierra el loop
    // — pasa a la etapa 'aceptada' con sus toques 60'/24h/72h. Si esa etapa
    // gobierna (activa o agotada: aceptada_sin_pago), el empujón +30' se
    // RETIRA para no duplicar (el doc lo pedía: "pasando por el gate
    // central"). El cobro asistido queda de RESPALDO para contactos que no
    // alcanzaron a enrolarse en el loop.
    if (loop && (loop.stage === "aceptada" || loop.motivo_cierre === "aceptada_sin_pago")) continue
    // 30 minutos de gracia para pagar solo; Modified_Time es el proxy del
    // momento de aceptación (el clic en aceptar la modifica).
    const modMs = Date.parse(String(cot.Modified_Time || ""))
    if (!Number.isFinite(modMs) || ahora.getTime() - modMs < 30 * 60_000) continue
    pendientes++
    if (enviados >= 10) continue
    const marca = `cobro_asistido_${String(cot.id)}`
    if (await getKvValue(marca).catch(() => null)) continue
    // Solo con ventana de Meta abierta (el que aceptó estuvo activo hace poco).
    const conv = await supa<{ last_user_at: string | null }>(
      `vic_v3_conversations?contact=eq.${encodeURIComponent(fono)}&select=last_user_at&limit=1`,
    )
    const lastUser = conv[0]?.last_user_at ? Date.parse(conv[0].last_user_at) : 0
    if (!lastUser || ahora.getTime() - lastUser >= VENTANA_META_MS) {
      await setKvValue(marca, "ventana_cerrada").catch(() => {})
      continue
    }
    if (!enVentanaProactiva(fono, ahora)) continue // fuera de 9-21: próximo tick en ventana
    const texto =
      "Vi que aceptaste tu cotización 🎉 ¿Te ayudo a completar el pago? Puedes pagar en línea desde el mismo link, y si prefieres transferencia me avisas: te paso los datos y con el comprobante por aquí lo dejamos listo."
    const okEnvio = await sendBotmakerMessage(fono, texto).catch(() => false)
    if (okEnvio) {
      await appendAssistantV3(fono, texto).catch(() => {})
      await setKvValue(marca, ahora.toISOString()).catch(() => {})
      enviados++
    }
  }
  return { enviados, pendientes }
}

/**
 * ESCALADA SLA (punto 1, Lalo 08-ago): el diseño del traspaso asume que el
 * vendedor llama en <5 minutos y nadie lo medía. A los 60 minutos hábiles de
 * un traspaso ACTIVO sin contacto real (mensaje espejado, llamada contestada
 * o atención manual del dashboard), sale UNA alerta interna con nombre y
 * apellido. El panel de SLA del dashboard muestra la foto completa.
 */
async function escaladaSla(ahora: Date): Promise<number> {
  // Piso de encendido: solo traspasos POSTERIORES al despliegue del SLA —
  // los de antes ya los maneja el candado v3 (Vicky reabierta) y alertarlos
  // en lote el primer tick era puro ruido para el equipo.
  const piso = "2026-08-09T00:00:00Z"
  const ventana = new Date(ahora.getTime() - 48 * 3600_000).toISOString()
  const desde = ventana > piso ? ventana : piso
  const activos = await supa<{ id: string; contact: string; vendedor_email: string | null; vendedor_nombre: string | null; traspasado_at: string }>(
    `vic_ptv?estado=eq.activo&traspasado_at=gte.${encodeURIComponent(desde)}&select=id,contact,vendedor_email,vendedor_nombre,traspasado_at&limit=200`,
  )
  if (!activos.length) return 0
  const atendidos = await contactosAtendidosPorVendedor(
    activos.map((a) => ({ contact: a.contact, desdeIso: a.traspasado_at })),
  ).catch(() => new Set<string>())
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  let alertas = 0
  for (const a of activos) {
    if (alertas >= 15) break
    if (atendidos.has(a.contact)) continue
    const pais = paisDeContacto(a.contact) || "cl"
    const feriados = await feriadosDePais(pais)
    if (minutosHabilesEntre(new Date(a.traspasado_at), ahora, pais, feriados) < 60) continue
    const marca = `sla_alerta_${a.id}`
    if (await getKvValue(marca).catch(() => null)) continue
    await avisarEquipoInterno(
      `⏱️ SLA VENCIDO: +${a.contact} fue traspasado a ${a.vendedor_nombre || a.vendedor_email || "?"} hace más de 60 min hábiles y NO registra contacto (ni WhatsApp espejado, ni llamada, ni marca manual). El cliente está esperando — llamar AHORA o marcar "ya lo contacté" en el dashboard si ya se atendió por otra vía.`,
    ).catch(() => {})
    await setKvValue(marca, ahora.toISOString()).catch(() => {})
    alertas++
  }
  return alertas
}

/**
 * Reconciliación del silencio post-traspaso (candado v3, Lalo 07-ago).
 *
 * Diagnóstico del 07-ago: el traspaso v2 cerraba el vic_loop al minuto 10-15
 * de la etapa y el candado silenciaba TODA proactividad — 68 formales
 * emitidas del 04 al 07-ago con CERO aceptadas, mientras el vendedor
 * convertía ~0. La regla nueva: Vicky sigue con sus seguimientos de cierre
 * hasta que haya contacto humano REAL (mensaje del vendedor por su WhatsApp
 * espejado o llamada contestada, después del traspaso).
 *
 *  - REABRE loops cerrados por ptv_traspasado/tm_traspasado (últimos 7 días)
 *    cuyo vendedor aún no contacta al cliente: toques escalonados para no
 *    disparar una ráfaga.
 *  - RE-CIERRA los reabiertos cuando la atención del vendedor aparece (el
 *    humano tomó la conversación; Vicky vuelve a callar como siempre).
 *
 * Con VICKY_PTV_CANDADO_CLASICO=1 no reabre nada (rollback sin deploy).
 */
/**
 * LEADS CRUZADOS DE PAÍS (11-ago): deshace las asignaciones de la regla de
 * Zoho que caen en el roster chileno de calificación con leads de OTRO país.
 * La regla corre asíncrona tras el create y puede pisar al dueño correcto;
 * mientras Lalo no le ponga el filtro de territorio, este barrido corrige.
 * Solo toca leads SIN convertir cuyo dueño es del roster CL — un dueño
 * humano de otro equipo jamás se pisa.
 */
/**
 * RESCATE DEL FORM-FILL MUDO (Lalo 21-ago, "sí, configuremos rescate"): lead
 * del formulario de landing (Form_Vicky=Si) que sigue con el usuario Vicky y
 * a las 24 h no tiene conversación de WhatsApp — o no puede tenerla nunca
 * (sin teléfono / teléfono inválido) — se entrega como LEAD al canal humano
 * de su país: CL → tómbola SDR sin calificar, CO → SDR fijo (Galindo),
 * MX → RR SDR inbound, PE → Mónica. Con notificación de nuevo lead + nota.
 * Solo en horario hábil del país (la entrega no cae de madrugada), máx 10
 * por tick, candado kv `rescate_form_<id>` (un lead se evalúa UNA vez: si ya
 * conversa, se estampa y no se vuelve a mirar — de ahí lo toma el flujo
 * normal). Ventana ajustable sin deploy: env VICKY_FORM_RESCATE_HORAS.
 */
/**
 * NORMALIZADOR DE FONOS DEL FORM (21-ago, caso Maximiliano "+5656954367033"):
 * el miniform de las landing antepone el código de país aunque el usuario ya
 * lo haya tipeado (el campo muestra "+56" y la gente igual escribe
 * "56944668823"). Con el prefijo doble, el dedup por fono del chat no calza
 * y el lead se duplica. Este paso corrige el Phone en Zoho apenas entra el
 * lead — corre cada tick, es un COQL + PATCHs puntuales, best-effort.
 */
async function normalizarFonosForm(): Promise<number> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const q = await fetch(`${api}/crm/v3/coql`, {
    method: "POST", headers: H, cache: "no-store",
    body: JSON.stringify({
      select_query:
        "select id, Phone from Leads where (Form_Vicky = 'Si' and Converted__s = false) and " +
        "((Phone like '+5656%' or Phone like '+5757%') or (Phone like '+5252%' or Phone like '+5151%')) limit 20",
    }),
  })
  if (!q.ok || q.status === 204) return 0
  const filas = ((await q.json().catch(() => ({}))) as { data?: Array<{ id?: string; Phone?: string }> }).data || []
  let corregidos = 0
  for (const l of filas) {
    const tel = String(l.Phone || "").replace(/\D/g, "")
    if (!l.id || !/^(56|57|52|51)\1\d{8,12}$/.test(tel)) continue
    const real = tel.slice(2)
    const put = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({
        data: [{ id: l.id, Phone: `+${real}` }],
        skip_feature_execution: [{ name: "assignment_rules" }],
        // blueprint permitido: si el lead del form venía sin engancharse al
        // blueprint, este toque lo activa (workflows siguen apagados).
        trigger: ["blueprint"],
      }),
    }).catch(() => null)
    if (put?.ok) {
      corregidos++
      console.log(`[form-fonos] lead ${l.id}: Phone ${l.Phone} → +${real} (prefijo duplicado del form)`)
    }
  }
  // SEGUNDA PASADA (25-ago, caso Jeremías/Green Energy): el form guardó
  // "+569432070140" (un dígito de más) y el fono real del chat era
  // +56932070140 — el dedup no calzó y nació un lead duplicado. Regla:
  // fono del form SIN conversación cuyos ÚLTIMOS 8 DÍGITOS calzan con
  // exactamente UNA conversación de Vicky → ese es el número real y se
  // corrige en Zoho (con eso el dedup y el cruce del dash vuelven a calzar).
  try {
    const q2 = await fetch(`${api}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          "select id, Phone from Leads where (Form_Vicky = 'Si' and Converted__s = false) " +
          "and Created_Time >= '" + new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10) + "T00:00:00-04:00' " +
          "order by Created_Time desc limit 50",
      }),
    })
    const filas2 = q2.ok && q2.status !== 204
      ? ((await q2.json().catch(() => ({}))) as { data?: Array<{ id?: string; Phone?: string }> }).data || []
      : []
    for (const l of filas2) {
      const tel = String(l.Phone || "").replace(/\D/g, "")
      if (!l.id || tel.length < 10) continue
      // Con conversación propia el fono está bien: nada que corregir.
      const propia = await supa<{ contact: string }>(
        `vic_v3_conversations?contact=eq.${encodeURIComponent(tel)}&select=contact&limit=1`,
      )
      if (propia.length) continue
      const suf = tel.slice(-8)
      const cand = await supa<{ contact: string }>(
        `vic_v3_conversations?contact=like.*${suf}&select=contact&limit=2`,
      )
      if (cand.length !== 1) continue
      const real = (cand[0].contact || "").replace(/\D/g, "")
      if (!/^(56|57|52|51)\d{8,12}$/.test(real) || real === tel) continue
      const put = await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({
          data: [{ id: l.id, Phone: `+${real}` }],
          skip_feature_execution: [{ name: "assignment_rules" }],
          trigger: ["blueprint"],
        }),
      }).catch(() => null)
      if (put?.ok) {
        corregidos++
        console.log(`[form-fonos] lead ${l.id}: Phone ${l.Phone} → +${real} (sufijo calza con conversación única)`)
      }
    }
  } catch (e) {
    console.warn("[form-fonos] segunda pasada (sufijo) falló:", e instanceof Error ? e.message : e)
  }
  return corregidos
}

/**
 * VIGÍA DEL ESPEJO (Lalo 24-ago, "dejemos arreglado los whatsapp espejo"):
 * la caída del worker del 20-ago estuvo 4 días muda y se descubrió por
 * deducción. Ahora: si la tabla de mensajes espejados no recibe NADA en más
 * de 3 horas dentro de horario hábil CL (con 5+ sesiones conectadas, algo
 * siempre entra), se avisa al equipo interno UNA vez por episodio (candado
 * kv de 12h). Best-effort.
 */
async function vigilarEspejo(ahora: Date): Promise<void> {
  const feriados = await feriadosDePais("cl").catch(() => new Set<string>())
  const { esHorarioHabil } = await import("@/lib/ptv")
  if (!esHorarioHabil("cl", ahora, feriados)) return
  const filas = await supa<{ created_at?: string }>(
    `vic_wa_espejo_mensajes?select=created_at&order=created_at.desc&limit=1`,
  ).catch(() => [])
  const ultimo = Date.parse(String(filas[0]?.created_at || ""))
  if (!Number.isFinite(ultimo)) return
  const horasMudo = (ahora.getTime() - ultimo) / 3600e3
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  if (horasMudo < 3) {
    // Episodio cerrado: se re-arma la alerta para la próxima caída.
    await setKvValue("alerta_espejo_caido", "").catch(() => {})
    return
  }
  // Una alerta cada 12h como máximo por episodio.
  const alertaPrevia = Date.parse(String((await getKvValue("alerta_espejo_caido").catch(() => "")) || ""))
  if (Number.isFinite(alertaPrevia) && ahora.getTime() - alertaPrevia < 12 * 3600e3) return
  await setKvValue("alerta_espejo_caido", new Date(ahora).toISOString()).catch(() => {})
  await avisarEquipoInterno(
    `⚠️ ESPEJO WHATSAPP POSIBLEMENTE CAÍDO: la última captura de mensajes de los celulares de los ejecutivos fue hace ${horasMudo.toFixed(1)} horas (en horario hábil eso no es normal). Revisar el worker en Railway (restart/redeploy) y el estado de las sesiones en vic-admin-wa-espejo.`,
  ).catch(() => {})
  console.warn(`[vigia-espejo] sin mensajes espejados hace ${horasMudo.toFixed(1)}h — alerta enviada`)
}

async function rescatarFormSinConversacion(ahora: Date): Promise<number> {
  const horasVentana = Math.max(1, Number(process.env.VICKY_FORM_RESCATE_HORAS || 24) || 24)
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  // COQL v8, NO v3 (autopsia 28-ago, "por qué el rescate jamás entregó"): la
  // condición Owner.email no resuelve en v3 —igual que el hallazgo del dash
  // "v3 NO expande Owner"— y la consulta moría con 400. Con el `return 0`
  // mudo de abajo, el rescate llevaba una semana sin entregar a nadie y sin
  // dejar rastro (ni candados, ni logs). Ahora el fallo se LOGUEA siempre.
  const q = await fetch(`${api}/crm/v8/coql`, {
    method: "POST", headers: H, cache: "no-store",
    body: JSON.stringify({
      select_query:
        "select id, First_Name, Last_Name, Company, Phone, Email, Territorio, Created_Time from Leads " +
        "where (Form_Vicky = 'Si' and Converted__s = false) and Owner.email = 'vicky@geovictoria.com' " +
        "order by Created_Time asc limit 50",
    }),
  })
  if (!q.ok) {
    console.warn(`[rescate-form] COQL falló ${q.status}: ${(await q.text().catch(() => "")).slice(0, 200)}`)
    return 0
  }
  if (q.status === 204) return 0
  const filas =
    ((await q.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; First_Name?: string; Last_Name?: string; Company?: string; Phone?: string; Email?: string; Territorio?: string; Created_Time?: string }>
    }).data || []
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const { esHorarioHabil } = await import("@/lib/ptv")
  let rescatados = 0
  for (const l of filas) {
    if (rescatados >= 10 || !l.id) continue
    const creadoMs = Date.parse(String(l.Created_Time || ""))
    if (!Number.isFinite(creadoMs) || ahora.getTime() - creadoMs < horasVentana * 3600e3) continue
    // Internos de prueba fuera (mismo criterio del dash).
    const blob = `${l.First_Name || ""} ${l.Last_Name || ""} ${l.Company || ""} ${l.Email || ""}`.toLowerCase()
    if (/prueba|test vicky|no llamar|geovictoria|pruebasmkt|huellerocompany/.test(blob)) continue
    if (await getKvValue(`rescate_form_${l.id}`).catch(() => null)) continue
    let tel = String(l.Phone || "").replace(/\D/g, "")
    // Prefijo de país duplicado por el form ("+5656…"): se colapsa para que
    // la búsqueda de conversación apunte al WhatsApp real.
    if (/^(56|57|52|51)\1\d{8,12}$/.test(tel)) tel = tel.slice(2)
    const telOk = /^(56|57|52|51)\d{8,12}$/.test(tel)
    if (telOk) {
      const conv = await supa<{ contact: string }>(
        `vic_v3_conversations?contact=eq.${encodeURIComponent(tel)}&select=contact&limit=1`,
      ).catch(() => [])
      if (conv.length) {
        // Ya conversa: el flujo normal (hitos/relojes) lo gobierna — este
        // lead sale del radar del rescate para siempre.
        await setKvValue(`rescate_form_${l.id}`, "conversa").catch(() => {})
        continue
      }
    }
    // GEMELO YA ATENDIDO (28-ago, caso Aleydis/Maximiliano Varas): el form
    // crea leads SIN dedup, y muchos "mudos" son personas que YA existen como
    // CONTACTO en Zoho (las atendió un ejecutivo por otro registro). Entregar
    // el gemelo genera ruido real ("llamé y me dijo que ya le enviaron
    // cotización"). Si el teléfono o el correo ya son de un contacto, el lead
    // NO se entrega: candado + nota para el dedup humano (patrón Recontacto).
    try {
      const correo = String(l.Email || "").trim().replace(/'/g, "")
      const condiciones = [
        telOk ? `Phone = '+${tel}'` : "",
        correo ? `Email = '${correo}'` : "",
      ].filter(Boolean)
      if (condiciones.length) {
        const rg = await fetch(`${api}/crm/v8/coql`, {
          method: "POST", headers: H, cache: "no-store",
          body: JSON.stringify({
            select_query: `select id, Last_Name, Owner.last_name from Contacts where ${condiciones.length === 2 ? `(${condiciones.join(" or ")})` : condiciones[0]} limit 1`,
          }),
        })
        if (rg.status === 200) {
          const gemelo = (((await rg.json().catch(() => ({}))) as {
            data?: Array<{ id?: string; Last_Name?: string; "Owner.last_name"?: string }>
          }).data || [])[0]
          if (gemelo?.id) {
            await setKvValue(`rescate_form_${l.id}`, `gemelo:${gemelo.id}`).catch(() => {})
            const { agregarNotaLead } = await import("@/lib/zoho-leads")
            await agregarNotaLead(
              l.id,
              "Form Vicky — posible duplicado, no se entrega",
              `Este lead llegó por el formulario de las landing pero su teléfono/correo ya existe como CONTACTO en Zoho ` +
                `(${gemelo.Last_Name || "contacto"}, dueño ${gemelo["Owner.last_name"] || "?"}, id ${gemelo.id}) — la persona ya fue atendida por otro registro. ` +
                `Se omite de la tómbola SDR para no duplicar gestión; revisar/fusionar como Recontacto si corresponde.`,
            ).catch(() => {})
            console.log(`[rescate-form] lead ${l.id} omitido: gemelo contacto ${gemelo.id}`)
            continue
          }
        }
      }
    } catch { /* sin señal de gemelo: sigue el rescate normal */ }
    // País: prefijo del teléfono; sin teléfono, el Territorio del lead.
    const terr = String(l.Territorio || "").trim().toLowerCase()
    const pais = telOk
      ? tel.startsWith("56") ? "cl" : tel.startsWith("57") ? "co" : tel.startsWith("52") ? "mx" : "pe"
      : terr === "chile" ? "cl" : terr === "colombia" ? "co" : terr === "méxico" || terr === "mexico" ? "mx" : terr === "perú" || terr === "peru" ? "pe" : ""
    if (!pais) {
      console.warn(`[rescate-form] lead ${l.id}: sin teléfono válido ni Territorio — revisar a mano`)
      await setKvValue(`rescate_form_${l.id}`, "sin_pais").catch(() => {})
      continue
    }
    const feriados = await feriadosDePais(pais)
    if (!esHorarioHabil(pais, ahora, feriados)) continue // espera la ventana hábil, sin candado
    await setKvValue(`rescate_form_${l.id}`, "rescatado").catch(() => {})
    const { reasignarLeadCalificacionCL, reasignarLeadSdrInboundCO, reasignarLeadSdrInboundMX, agregarNotaLead } =
      await import("@/lib/zoho-leads")
    let ownerEmail = ""
    if (pais === "cl") {
      const r = await reasignarLeadCalificacionCL(l.id, { calificado: false }).catch(() => null)
      ownerEmail = r?.ownerEmail || ""
    } else if (pais === "co") {
      const r = await reasignarLeadSdrInboundCO(l.id).catch(() => null)
      ownerEmail = r?.ownerEmail || ""
    } else if (pais === "mx") {
      const r = await reasignarLeadSdrInboundMX(l.id).catch(() => null)
      ownerEmail = r?.ownerEmail || ""
    } else {
      const put = await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({
          data: [{ id: l.id, Owner: { id: "3525045000323383015" } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => null)
      if (put?.ok) ownerEmail = "mmendozav@geovictoria.com"
    }
    if (!ownerEmail) {
      console.warn(`[rescate-form] lead ${l.id} (${pais}): la entrega no asignó dueño`)
      continue
    }
    const horas = Math.floor((ahora.getTime() - creadoMs) / 3600e3)
    const detalleTel = !l.Phone
      ? "El formulario no trajo teléfono, así que Vicky no puede contactarlo por WhatsApp"
      : telOk
        ? `Nunca inició conversación por WhatsApp (+${tel})`
        : `El teléfono del formulario no es válido ("${l.Phone}")`
    await agregarNotaLead(
      l.id,
      "Rescate: llenó el formulario y no conversó con Vicky",
      `Este lead llenó el formulario de la web/landing hace ${horas} h y no hay conversación de WhatsApp con Vicky. ${detalleTel}. Se entrega al canal humano para contactarlo por correo o teléfono.`,
    ).catch(() => false)
    await notificarTraspasoLeadEmail(
      l.id,
      ownerEmail,
      telOk ? tel : "",
      H,
      api,
      `este lead llenó el <b>formulario de la web/landing</b> hace ${horas} h y nunca inició conversación por WhatsApp. ${detalleTel}. Es tuyo: contáctalo por correo${telOk ? " o teléfono" : ""}.`,
    ).catch(() => {})
    rescatados++
    console.log(`[rescate-form] lead ${l.id} (${pais}) → ${ownerEmail} (${horas} h sin conversación)`)
  }
  return rescatados
}

async function reconciliarLeadsCruzados(): Promise<number> {
  const rosterCL = (process.env.VICKY_TM_ROSTER_CALIFICACION_EMAILS ||
    "aaraque@geovictoria.com,asepulveda@geovictoria.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  // Destino por territorio (mismos dueños fijos del canal de cada país).
  const destinoPorTerritorio: Record<string, { id: string; email: string }> = {
    "perú": { id: "3525045000323383015", email: "mmendozav@geovictoria.com" }, // Mónica
    "peru": { id: "3525045000323383015", email: "mmendozav@geovictoria.com" },
    "méxico": { id: "3525045000434395001", email: "mguzmanr@geovictoria.com" }, // Miguel Guzmán (SDR inbound, Lalo 12-ago)
    "mexico": { id: "3525045000308323003", email: "ysegura@geovictoria.com" },
    // COLOMBIA faltaba en este mapa (cazado 21-ago con el lead CO del form
    // que quedó con Sepúlveda): leads CO → SDR fijo Galindo (regla equipo CO
    // 05-ago; el roster Araceli/Aleydis es SOLO calificación Chile).
    "colombia": { id: "3525045000613817111", email: "egalindo@geovictoria.com" },
  }
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const emails = rosterCL.map((e) => `'${e}'`).join(",")
  const q = await fetch(`${api}/crm/v3/coql`, {
    method: "POST", headers: H, cache: "no-store",
    body: JSON.stringify({
      select_query: `select id, Territorio, Phone, Owner.email from Leads where (Owner.email in (${emails}) and Converted__s = false) and Territorio != 'Chile' limit 10`,
    }),
  })
  if (!q.ok || q.status === 204) return 0
  const filas = ((await q.json().catch(() => ({}))) as { data?: Array<{ id?: string; Territorio?: string; Phone?: string }> }).data || []
  let corregidos = 0
  for (const l of filas) {
    const destino = destinoPorTerritorio[String(l.Territorio || "").trim().toLowerCase()]
    if (!destino || !l.id) continue
    const put = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({
        data: [{ id: l.id, Owner: { id: destino.id } }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    }).catch(() => null)
    if (put?.ok) {
      corregidos++
      console.warn(`[leads-cruzados] lead ${l.id} (${l.Territorio}, ${l.Phone || "?"}) roster CL → ${destino.email}`)
    }
  }
  return corregidos
}

/**
 * BACKSTOP ENTERPRISE EN TLMK (Lalo 28-ago, caso Clínica Alemana→Ana López):
 * un lead vivo que declara >300 personas jamás debe quedar en el roster de
 * VENTA de telemarketing — su rango tope es 300. La guarda preventiva vive en
 * reasignarLeadCalificacionCL (toda entrega nueva ya rutea a SDR); este
 * reconciliador caza los que ya quedaron mal parados (histórico + cualquier
 * camino lateral: regla de Zoho asíncrona, asignación manual, form). Máx 5
 * por tick, candado kv por lead — jamás toca leads convertidos ni gestión
 * cerrada (No Calificado / Calificado convertido).
 */
async function reencaminarEnterpriseTlmk(): Promise<number> {
  const umbral = Number(process.env.VICKY_ENTERPRISE_UMBRAL || 300) || 300
  const rosterTlmk = (process.env.VICKY_TLMK_ROSTER_EMAILS ||
    "emujica@geovictoria.com,pdiaz@geovictoria.com,gmelendez@geovictoria.com," +
    "tmartinezq@geovictoria.com,alopez@geovictoria.com,dgalvez@geovictoria.com,adiazg@geovictoria.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!rosterTlmk.length) return 0
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  // v8: v3 no expande Owner en COQL (misma cicatriz del rescate del form).
  const q = await fetch(`${api}/crm/v8/coql`, {
    method: "POST", headers: H, cache: "no-store",
    body: JSON.stringify({
      select_query:
        `select id, Phone, Owner.email, N_Empleados_que_marcan from Leads ` +
        `where ((N_Empleados_que_marcan > ${umbral} and Converted__s = false) and ` +
        `Lead_Status in ('1. No contactado','2. Intento de contacto','3. Contactado','4. Calificado')) ` +
        `order by Created_Time desc limit 40`,
    }),
  })
  if (!q.ok) {
    console.warn(`[enterprise-tlmk] COQL falló ${q.status}: ${(await q.text().catch(() => "")).slice(0, 200)}`)
    return 0
  }
  if (q.status === 204) return 0
  const filas = ((await q.json().catch(() => ({}))) as {
    data?: Array<{ id?: string; Phone?: string; "Owner.email"?: string; N_Empleados_que_marcan?: number }>
  }).data || []
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  let movidos = 0
  for (const l of filas) {
    if (movidos >= 5) break
    const ownerEmail = String(l["Owner.email"] || "").toLowerCase()
    if (!l.id || !rosterTlmk.includes(ownerEmail)) continue
    const marca = `ent_tlmk_${l.id}`
    if (await getKvValue(marca).catch(() => null)) continue
    await setKvValue(marca, new Date().toISOString()).catch(() => {})
    const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
    const r = await reasignarLeadCalificacionCL(l.id, { calificado: false }).catch(() => null)
    if (r?.success) {
      movidos++
      console.warn(`[enterprise-tlmk] lead ${l.id} (~${l.N_Empleados_que_marcan} pers., estaba con ${ownerEmail}) → ${r.ownerEmail}`)
      if (r.ownerEmail) {
        await notificarTraspasoLeadEmail(
          l.id, r.ownerEmail, String(l.Phone || "").replace(/\D/g, ""), H, api,
          `este lead declara ~${l.N_Empleados_que_marcan} personas (tramo enterprise, sobre el rango de telemarketing). ` +
            `<b>Tu misión es conseguir el RUT y calificarlo</b> — con el RUT registrado el sistema crea el deal y lo asigna solo al equipo enterprise. No se cotiza desde telemarketing.`,
        ).catch(() => {})
      }
    }
  }
  return movidos
}

async function reconciliarSilencioTraspasos(): Promise<{ reabiertos: number; recerrados: number }> {
  if ((process.env.VICKY_PTV_CANDADO_CLASICO || "").trim() === "1") return { reabiertos: 0, recerrados: 0 }
  const desde = new Date(Date.now() - 7 * 24 * 3600e3).toISOString()
  const ptvRows = await supa<{ contact: string; traspasado_at?: string }>(
    `vic_ptv?estado=eq.activo&traspasado_at=gte.${encodeURIComponent(desde)}&select=contact,traspasado_at&limit=500`,
  ).catch(() => [])
  if (!ptvRows.length) return { reabiertos: 0, recerrados: 0 }
  const testSet = testContactSet()
  const vivos = ptvRows.filter((r) => r.contact && !isTestContact(r.contact, testSet))
  const atendidos = await contactosAtendidosPorVendedor(
    vivos.map((r) => ({ contact: r.contact, desdeIso: r.traspasado_at || "" })),
  ).catch(() => new Set<string>())

  const lista = vivos.map((r) => `"${r.contact}"`).join(",")
  const loops = await supa<{ contact: string; estado: string; motivo_cierre: string | null }>(
    `vic_loop?contact=in.(${lista})&select=contact,estado,motivo_cierre&limit=500`,
  ).catch(() => [])

  let reabiertos = 0
  let recerrados = 0
  const ahoraMs = Date.now()
  // CANDADO v4 (Lalo 27-ago): Vicky no se apaga NUNCA por traspaso — se
  // reabren TODOS los loops cerrados por ptv/tm (atendidos incluidos) y ya no
  // se re-cierra por atención del vendedor. El acompañamiento sigue; el t5
  // con contexto pregunta cómo le fue con el ejecutivo. Rollback sin deploy:
  // VICKY_TRASPASO_SILENCIA=1 restaura el comportamiento v3.
  const silenciaV3 = (process.env.VICKY_TRASPASO_SILENCIA || "").trim() === "1" ||
    (process.env.VICKY_PTV_CANDADO_CLASICO || "").trim() === "1"
  for (const l of loops) {
    const atendido = silenciaV3 ? atendidos.has(l.contact) : false
    if (!atendido && l.estado === "cerrado" && (l.motivo_cierre === "ptv_traspasado" || l.motivo_cierre === "tm_traspasado")) {
      if (reabiertos >= 40) continue
      // PAGO REGISTRADO (19-ago, MATER/COT546): el candado v3 reabrió el loop
      // de una clienta pagada 20 min después del traspaso fantasma y el toque
      // t1 le pidió la dotación desde cero. Cliente pagado no se reabre.
      if (await pagoRegistradoReciente(l.contact)) continue
      // Fase ONBOARDING (25-ago): el alta en curso jamás se reabre como venta.
      if (await enFaseOnboarding(l.contact)) continue
      // Escalonado: 20 min + 7 min por loop reabierto en este tick.
      const proximoToque = new Date(ahoraMs + 20 * 60_000 + reabiertos * 7 * 60_000).toISOString()
      await supa(`vic_loop?contact=eq.${encodeURIComponent(l.contact)}`, {
        method: "PATCH",
        body: JSON.stringify({
          estado: "activo",
          motivo_cierre: null,
          next_touch_at: proximoToque,
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => {})
      reabiertos++
    } else if (atendido && l.estado === "activo") {
      await supa(`vic_loop?contact=eq.${encodeURIComponent(l.contact)}`, {
        method: "PATCH",
        body: JSON.stringify({ estado: "cerrado", motivo_cierre: "ptv_traspasado", updated_at: new Date().toISOString() }),
      }).catch(() => {})
      recerrados++
    }
  }
  if (reabiertos || recerrados) {
    console.log(`[ptv-cron] candado v3: ${reabiertos} loops reabiertos (vendedor sin contactar), ${recerrados} re-cerrados (vendedor atendió)`)
  }
  return { reabiertos, recerrados }
}
