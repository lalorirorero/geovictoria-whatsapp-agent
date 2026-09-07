/**
 * INSIGHT DE LA CONVERSACIÓN → IMPLEMENTACIÓN (Lalo 07-sep, pedido de Diego
 * Alegre e Ignacio Salinas).
 *
 * Diego: "me llegó una y estoy medio ciego a cómo fue la interacción… sería
 * bacán una nota que diga 'el cliente solo mandó un usuario admin, no mandó
 * turnos ni nada, dijo que lo vería en la capa'". Ignacio: las 10
 * definiciones de operación que necesita para configurar en la capacitación.
 *
 * Lo que deja en la Implementación, cada vez que se sincroniza:
 *   · `Comentarios_adicionales`    → el "insight" en una línea (estilo Diego) + el checklist
 *                                    DETERMINISTA de lo levantado y lo que falta (admin,
 *                                    nómina, turnos, planificaciones, capacitación, equipos,
 *                                    las 10 definiciones). OJO: `Detalles` ("Detalles Req
 *                                    Software") es de SOLO LECTURA en el módulo — probado
 *                                    07-sep, el PUT lo ignora en silencio.
 *   · `Dolor_levantado_con_Cliente`→ resumen corto de la conversación (modelo, solo con lo
 *                                    que dijo el cliente; con fallback determinista).
 *   · `Conversaci_n_Whatsapp`      → URL del chat en Botmaker (texto de 255).
 *   · Nota "Insight de la conversación (Vicky)" → todo lo anterior + transcripción.
 *     Se ACTUALIZA (id en vic_kv), no se duplica.
 *
 * Se sincroniza al nacer la implementación y se refresca cuando cambia algo
 * relevante (nómina, capacitación, definiciones, cierre). Best-effort puro:
 * nunca lanza, nunca toca la conversación.
 */

import { getZohoAccessToken } from "./zoho-token"
import { fetchHistoryV3, getKvValue, setKvValue } from "./supabase-persistence-v3"
import {
  claveBorrador,
  claveCapacitacion,
  claveConfiguracion,
  claveEsquema,
  claveInsightNota,
  claveInsightSync,
} from "./onboarding/fase"
import { configuracionVacia, type Configuracion } from "./onboarding/configuracion"
import { parsearBorrador, type Borrador } from "./onboarding/borrador"
import { PREGUNTAS_ESQUEMA, pendientesEsquema, respondidasEsquema, type EsquemaOperacion } from "./onboarding/esquema"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
export const TITULO_NOTA_INSIGHT = "Insight de la conversación (Vicky)"
const DEBOUNCE_MS = 10 * 60 * 1000

type Capacitacion = {
  implementacionId?: string
  numero?: string
  empresa?: string
  relator?: { nombre: string; email: string }
  bookingId?: string
  cuando?: string
}

type ItemCot = {
  Nombre_Item?: string | null
  Codigo_Item?: string | null
  Categoria_Item?: string | null
  Modalidad?: string | null
  Cantidad?: number | null
  Es_Recurrente?: boolean | null
  Subtotal_CLP?: number | null
  Descuento_Pct?: number | null
}

export type DatosInsight = {
  contact: string
  empresa: string
  borrador: Borrador | null
  config: Configuracion
  esquema: EsquemaOperacion
  cap: Capacitacion | null
  items: ItemCot[]
  numeroCotizacion: string
  mensajes: Array<{ role: string; content: string; at?: string }>
  chatUrl: string
}

async function leerJson<T>(clave: string): Promise<T | null> {
  try {
    const raw = await getKvValue(clave)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function itemsDeLaVenta(contact: string): Promise<{ items: ItemCot[]; numero: string }> {
  try {
    const { getQuotePointers } = await import("./supabase-persistence-v3")
    const punteros = await getQuotePointers(contact).catch(() => [])
    const p = punteros.find((x) => (x.quoteId || "").trim())
    if (!p) return { items: [], numero: "" }
    const token = await getZohoAccessToken()
    const modulo = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const r = await fetch(`${API()}/crm/v3/${modulo}/${p.quoteId}?fields=Numero_Cotizacion,Detalle_Items_Cotizacion`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    const q = ((await r.json().catch(() => ({}))) as { data?: Array<{ Numero_Cotizacion?: string; Detalle_Items_Cotizacion?: ItemCot[] }> }).data?.[0]
    return { items: Array.isArray(q?.Detalle_Items_Cotizacion) ? q!.Detalle_Items_Cotizacion! : [], numero: String(q?.Numero_Cotizacion || "") }
  } catch {
    return { items: [], numero: "" }
  }
}

export async function reunirDatosInsight(contact: string): Promise<DatosInsight> {
  const fono = (contact || "").replace(/\D/g, "")
  const [borradorRaw, config, esquema, cap, venta, mensajes] = await Promise.all([
    getKvValue(claveBorrador(fono)).catch(() => null),
    leerJson<Partial<Configuracion>>(claveConfiguracion(fono)),
    leerJson<EsquemaOperacion>(claveEsquema(fono)),
    leerJson<Capacitacion>(claveCapacitacion(fono)),
    itemsDeLaVenta(fono),
    fetchHistoryV3(fono, 80).catch(() => []),
  ])
  let chatUrl = ""
  try {
    const { leerChat, chatRefDeContacto } = await import("./botmaker-agentes")
    const { urlChat } = await import("./enlace-conversacion")
    const chat = await leerChat(chatRefDeContacto(fono))
    chatUrl = urlChat(chat?.chatId || "")
  } catch {
    chatUrl = ""
  }
  const borrador = borradorRaw ? parsearBorrador(borradorRaw) : null
  return {
    contact: fono,
    empresa: cap?.empresa || borrador?.empresa?.nombre || "",
    borrador,
    config: { ...configuracionVacia(), ...(config || {}) },
    esquema: esquema || {},
    cap,
    items: venta.items,
    numeroCotizacion: venta.numero,
    mensajes: (mensajes as Array<{ role: string; content: string; at?: string }>) || [],
    chatUrl,
  }
}

function fechaCL(d = new Date()): string {
  return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" }).format(d)
}

/** Equipos vendidos, legibles: "1 SenseFace 2A en arriendo · instalación técnica RM (San Miguel) · envío bonificado". */
function equiposVendidos(items: ItemCot[]): string {
  const partes: string[] = []
  for (const it of items) {
    const nombre = String(it.Nombre_Item || "")
    const cat = String(it.Categoria_Item || "")
    const cant = Number(it.Cantidad) || 0
    if (/equipos biom/i.test(cat) && !/tarjeta/i.test(String(it.Codigo_Item || ""))) {
      partes.push(`${cant} ${nombre}${/arriendo/i.test(String(it.Modalidad || "")) ? " en arriendo" : " (venta)"}`)
    } else if (/instalacion/i.test(String(it.Codigo_Item || ""))) {
      partes.push(`instalación técnica ${nombre.replace(/^Instalaci[oó]n de reloj\s*/i, "")}`.trim())
    } else if (/envio/i.test(String(it.Codigo_Item || ""))) {
      partes.push(Number(it.Descuento_Pct) >= 100 ? "envío bonificado" : `envío ${nombre.replace(/^Env[ií]o de reloj\s*/i, "")}`.trim())
    } else if (/tarjeta/i.test(String(it.Codigo_Item || ""))) {
      partes.push(`${cant} tarjetas de proximidad`)
    }
  }
  return partes.length ? partes.join(" · ") : "sin equipos (solo app)"
}

/** El checklist determinista: lo que SÍ se levantó y lo que NO. */
export function checklistInsight(d: DatosInsight): string {
  const L: string[] = []
  const admin = d.borrador?.admin
  const nombreAdmin = [admin?.nombre, admin?.apellido].filter(Boolean).join(" ").trim()
  L.push(`LEVANTADO POR VICKY EN EL CHAT (actualizado ${fechaCL()})`)
  L.push(
    nombreAdmin || admin?.email
      ? `✅ Administrador creado: ${nombreAdmin || "(sin nombre)"}${admin?.email ? ` · ${admin.email}` : ""}`
      : "❌ Administrador: sin datos en el chat",
  )
  const n = d.config.trabajadores.length
  const sinCorreo = d.config.trabajadores.filter((t) => !String(t.correo || "").trim()).length
  L.push(
    n > 0
      ? `✅ Nómina: ${n} trabajador${n === 1 ? "" : "es"} cargados por chat${sinCorreo ? ` (${sinCorreo} sin correo personal)` : ""}`
      : "❌ Nómina: 0 trabajadores cargados (los sube en la capacitación o después)",
  )
  const nt = d.config.turnos.length
  const np = d.config.planificaciones.length
  const na = d.config.asignaciones.length
  L.push(nt > 0 ? `✅ Turnos definidos: ${d.config.turnos.map((t) => t.nombre).filter(Boolean).join(", ")}` : "❌ Turnos: no definidos")
  L.push(np > 0 ? `✅ Planificaciones: ${np} (${na} asignaciones)` : "❌ Planificaciones: no armadas")
  L.push(
    d.cap?.bookingId
      ? `✅ Capacitación (Curso 1) agendada: ${d.cap.cuando || "fecha en Bookings"}${d.cap.relator ? ` con ${d.cap.relator.nombre}` : ""}`
      : `❌ Capacitación: sin agendar${d.cap?.relator ? ` (relator asignado: ${d.cap.relator.nombre})` : ""}`,
  )
  L.push(`• Vendido${d.numeroCotizacion ? ` (${d.numeroCotizacion})` : ""}: ${equiposVendidos(d.items)}`)
  const resp = respondidasEsquema(d.esquema)
  const pend = pendientesEsquema(d.esquema)
  L.push(`• Definiciones para la capacitación: ${resp.length}/${PREGUNTAS_ESQUEMA.length} respondidas por chat`)
  for (const p of resp) L.push(`   ✅ ${p.corta}: ${String(d.esquema[p.id]).trim()}`)
  if (d.esquema.nota) L.push(`   • Otros: ${d.esquema.nota}`)
  if (pend.length) {
    L.push(`   ❌ Por definir en la capacitación${d.esquema.loVeEnCapacitacion ? " (el cliente prefirió verlas ahí)" : ""}: ${pend.map((p) => p.corta).join(" · ")}`)
  }
  if (d.chatUrl) L.push(`• Chat completo: ${d.chatUrl}`)
  return L.join("\n")
}

/** Transcripción legible: hora CL, quién habló, sin registros internos. */
export function transcripcionInsight(d: DatosInsight, maxChars = 24000): string {
  const lineas = d.mensajes
    .filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
    .map((m) => {
      const hora = m.at
        ? new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(m.at))
        : ""
      const quien = m.role === "user" ? "CLIENTE" : "Vicky"
      return `${hora} ${quien}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 700)}`
    })
  let out = lineas.join("\n")
  if (out.length > maxChars) out = `…(recortado)\n${out.slice(out.length - maxChars)}`
  return out
}

/** Resumen + insight por modelo. SOLO con lo que dijo el cliente; si falla, determinista. */
export async function resumenInsight(d: DatosInsight, checklist: string): Promise<{ resumen: string; insight: string }> {
  const fallback = () => {
    const n = d.config.trabajadores.length
    const insight =
      `El cliente ${d.borrador?.admin?.email ? "dejó creado su usuario administrador" : "completó el alta"}` +
      (n > 0 ? `, cargó ${n} trabajador${n === 1 ? "" : "es"}` : ", no mandó la nómina") +
      (d.config.turnos.length ? ", definió turnos" : ", no definió turnos ni planificaciones") +
      (d.cap?.bookingId ? ` y ya tiene capacitación agendada (${d.cap.cuando || ""}).` : " y aún no agenda su capacitación.")
    return { resumen: checklist, insight }
  }
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  const transcript = transcripcionInsight(d, 14000)
  if (!apiKey || !transcript) return fallback()
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        system:
          "Eres el asistente del equipo de implementación de GeoVictoria (control de asistencia). Recibes la transcripción " +
          "de un chat de WhatsApp entre Vicky (vendedora/onboarding automática) y un cliente que ya pagó, más un checklist " +
          "determinista de lo que quedó configurado. Escribe para el RELATOR que hará la capacitación. Responde SOLO un JSON: " +
          '{"resumen": string, "insight": string}. ' +
          "resumen = 3 a 6 líneas cortas (una por línea, con guion) con lo que el cliente contó de su operación y lo que pidió: " +
          "rubro, cómo trabaja su gente, cómo quieren marcar, equipos, instalación, dudas, compromisos, cambios de opinión. " +
          "insight = UNA frase directa, estilo 'el cliente solo mandó un usuario admin, no mandó turnos ni nada, dijo que lo vería " +
          "en la capacitación': qué alcanzó a hacer, qué dejó pendiente y con qué actitud. Reglas: usa ÚNICAMENTE lo que aparece " +
          "en la transcripción y el checklist; no inventes datos ni intenciones; español de Chile neutro; sin nombres de vendedores.",
        messages: [{ role: "user", content: `CHECKLIST:\n${checklist}\n\nTRANSCRIPCIÓN:\n${transcript}` }],
      }),
      cache: "no-store",
    })
    if (!res.ok) return fallback()
    const data = (await res.json().catch(() => ({}))) as { content?: Array<{ text?: string }> }
    const texto = data?.content?.[0]?.text || ""
    const m = texto.match(/\{[\s\S]*\}/)
    if (!m) return fallback()
    const j = JSON.parse(m[0]) as { resumen?: string; insight?: string }
    const resumen = String(j.resumen || "").trim()
    const insight = String(j.insight || "").trim()
    if (!resumen || !insight) return fallback()
    return { resumen, insight }
  } catch {
    return fallback()
  }
}

async function upsertNota(token: string, impId: string, contact: string, titulo: string, contenido: string): Promise<string> {
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  let notaId = (await getKvValue(claveInsightNota(contact)).catch(() => null)) || ""
  if (!notaId) {
    // Sin id guardado: buscar por título para no duplicar (p. ej. tras un reset de kv).
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${impId}/Notes?fields=Note_Title&per_page=50`, { headers: H, cache: "no-store" })
    if (r.ok && r.status !== 204) {
      const j = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string; Note_Title?: string }> }
      notaId = j?.data?.find((n) => String(n.Note_Title || "").startsWith(TITULO_NOTA_INSIGHT))?.id || ""
    }
  }
  if (notaId) {
    const r = await fetch(`${API()}/crm/v3/Notes/${notaId}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [{ Note_Title: titulo, Note_Content: contenido }] }),
    })
    if (r.ok) return notaId
    // Si la nota ya no existe (borrada a mano), se crea de nuevo.
  }
  const r = await fetch(`${API()}/crm/v3/Notes`, {
    method: "POST",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({ data: [{ Note_Title: titulo, Note_Content: contenido, Parent_Id: impId, $se_module: "Implementaciones" }] }),
  })
  const j = (await r.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
  const nuevo = j?.data?.[0]?.details?.id || ""
  if (nuevo) await setKvValue(claveInsightNota(contact), nuevo).catch(() => {})
  return nuevo
}

/**
 * Sincroniza el insight hacia la Implementación del contacto. Devuelve qué
 * hizo (para el endpoint admin) y nunca lanza. `force` salta el debounce.
 */
export async function sincronizarInsightImplementacion(
  contact: string,
  opts: { force?: boolean; implementacionId?: string } = {},
): Promise<{ ok: boolean; motivo?: string; implementacionId?: string; notaId?: string; insight?: string }> {
  const fono = (contact || "").replace(/\D/g, "")
  try {
    const d = await reunirDatosInsight(fono)
    const impId = opts.implementacionId || d.cap?.implementacionId || ""
    if (!impId) return { ok: false, motivo: "sin implementación para este contacto" }
    if (!opts.force) {
      const ultimo = Number((await getKvValue(claveInsightSync(fono)).catch(() => null)) || 0)
      if (ultimo && Date.now() - ultimo < DEBOUNCE_MS) return { ok: true, motivo: "debounce", implementacionId: impId }
    }
    await setKvValue(claveInsightSync(fono), String(Date.now())).catch(() => {})

    const checklist = checklistInsight(d)
    const { resumen, insight } = await resumenInsight(d, checklist)
    const transcript = transcripcionInsight(d)
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

    const campos: Record<string, unknown> = {
      Comentarios_adicionales: `${insight}\n\n${checklist}`.slice(0, 30000),
      Dolor_levantado_con_Cliente: resumen.slice(0, 30000),
    }
    if (d.chatUrl) campos.Conversaci_n_Whatsapp = d.chatUrl.slice(0, 255)
    const put = await fetch(`${API()}/crm/v3/Implementaciones/${impId}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [campos], trigger: ["blueprint"] }),
    })
    if (!put.ok) {
      const cuerpo = await put.text().catch(() => "")
      console.warn(`[imp-insight] campos de ${impId} rechazados: ${put.status} ${cuerpo.slice(0, 300)}`)
      // Reintento sin el link por si el campo es más corto/estricto de lo esperado.
      if (campos.Conversaci_n_Whatsapp) {
        delete campos.Conversaci_n_Whatsapp
        await fetch(`${API()}/crm/v3/Implementaciones/${impId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [campos], trigger: ["blueprint"] }),
        }).catch(() => null)
      }
    }

    const contenido =
      `${checklist}\n\nRESUMEN DE LA CONVERSACIÓN\n${resumen}\n\nINSIGHT\n${insight}\n\n` +
      `TRANSCRIPCIÓN (WhatsApp con Vicky${d.chatUrl ? `, chat completo: ${d.chatUrl}` : ""})\n${transcript || "(sin mensajes)"}`
    const notaId = await upsertNota(token, impId, fono, `${TITULO_NOTA_INSIGHT} · ${d.empresa || fono}`.slice(0, 120), contenido.slice(0, 60000))
    console.log(`[imp-insight] ${impId} sincronizado (nota ${notaId || "∅"}): ${insight.slice(0, 120)}`)
    return { ok: true, implementacionId: impId, notaId: notaId || undefined, insight }
  } catch (e) {
    console.warn("[imp-insight] excepción:", e instanceof Error ? e.message : e)
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) }
  }
}

/** Disparo en segundo plano desde el canal (nunca espera ni lanza). */
export function sincronizarInsightEnSegundoPlano(contact: string, opts: { force?: boolean } = {}): void {
  void sincronizarInsightImplementacion(contact, opts).catch(() => null)
}
