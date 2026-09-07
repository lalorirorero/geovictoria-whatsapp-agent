/**
 * Helpers para enviar mensajes proactivos a Botmaker.
 *
 * El endpoint freeform `/v2.0/chats-actions/send-messages` permite mandar
 * mensajes de texto libre a una conversación EN CURSO (dentro de la ventana
 * de 24h del último mensaje del usuario, según WhatsApp Business).
 *
 * Lo usamos para entregar el reply de Vicky V3 fuera de la respuesta HTTP
 * del webhook de Botmaker, evitando timeouts cuando el procesamiento
 * (especialmente generación de cotización formal) tarda más que el
 * timeout del webhook.
 */

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BM_CHANNEL_V3 = (process.env.BOTMAKER_CHANNEL_V3 || "").trim()

const BM_HEADERS = {
  "access-token": BM_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
}

const SEND_MESSAGES_URL =
  "https://api.botmaker.com/v2.0/chats-actions/send-messages"
const TYPING_URL =
  "https://api.botmaker.com/v2.0/chats-actions/send-read-typing-feedback"
// Notificaciones / plantillas HSM (mensajes proactivos FUERA de la ventana de
// 24h, ej. recordatorios de reunión). Endpoint de la API de Notificaciones de
// Botmaker (host distinto: go.botmaker.com).
const NOTIFICATIONS_URL = "https://go.botmaker.com/api/v1.0/intent/v2"

/** Normaliza el contactId al formato que espera Botmaker (sin "+"). */
function normalizeContactId(raw: string): string {
  const sinMas = (raw || "").trim().replace(/^\+/, "")
  // IDs anónimos de WhatsApp (números ocultos de Meta / contactos sin fono):
  // llegan como "CO.1025995573684934" y NO son teléfonos — son el contactId
  // real de Botmaker. Si les quitamos el prefijo, Botmaker abre un chat
  // FANTASMA con puros dígitos y el cliente nunca recibe la respuesta (caso
  // CIMA Ingenieros, 30-jul). Se pasan CRUDOS.
  if (/[^\d]/.test(sinMas)) return sinMas
  return sinMas
}

// ── Canal de ORIGEN por contacto (caso +573117482905, 21-jul) ───────────────
// Un colombiano puede escribirle a la línea CHILENA (o viceversa): si le
// respondemos por la línea "de su país" se abren DOS chats paralelos — él
// escribe en uno y Vicky contesta desde otro número. Regla WhatsApp: se
// responde por el MISMO canal donde el cliente escribió. El canal de origen
// se persiste en vic_kv (canal_origen_<contacto>) — lo setea el webhook cuando
// la acción de código manda `channelId`, o a mano para casos puntuales — y
// tiene precedencia sobre el channelId que pase el llamador. Lectura inline
// (sin importar supabase-persistence-v3, para no crear ciclo de imports).
const SUPABASE_URL_KV = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY_KV = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function canalDeOrigen(contactId: string): Promise<string> {
  if (!SUPABASE_URL_KV || !SUPABASE_KEY_KV) return ""
  try {
    const r = await fetch(
      `${SUPABASE_URL_KV}/rest/v1/vic_kv?key=eq.canal_origen_${encodeURIComponent(contactId)}&select=value&limit=1`,
      {
        headers: { apikey: SUPABASE_KEY_KV, Authorization: `Bearer ${SUPABASE_KEY_KV}` },
        cache: "no-store",
      },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string }>
    return (rows?.[0]?.value || "").trim()
  } catch {
    return ""
  }
}

/**
 * Envía un mensaje de texto a una conversación de WhatsApp vía Botmaker.
 *
 * WhatsApp interpreta:
 *   - `*texto*` como **negrita**
 *   - `_texto_` como _cursiva_
 *   - `~texto~` como ~tachado~
 *   - ```` ```texto``` ```` como código
 *
 * @param contactId Teléfono del cliente. Acepta con o sin "+".
 * @param text Mensaje a enviar (texto libre).
 * @returns true si Botmaker aceptó el envío (status 202), false en error.
 */
/**
 * Detección AUTOMÁTICA del canal de origen (fallback, caso +573172822429):
 * mientras las acciones de código de Botmaker no envíen `channelId`, se
 * consulta la API de mensajes por los últimos minutos y se busca el último
 * mensaje DEL USUARIO de este contacto — su chat.channelId es la línea por la
 * que escribió. Si se encuentra, se persiste en vic_kv (canal_origen_<c>) para
 * que todos los pushes salgan por ahí. Best-effort: sin token o sin hallazgo,
 * no hace nada.
 */
/** País por prefijo de un número WhatsApp (sin "+"): cl | co | mx | otro. */
function paisDeNumero(num: string): "cl" | "co" | "mx" | "otro" {
  if (num.startsWith("56")) return "cl"
  if (num.startsWith("57")) return "co"
  if (num.startsWith("52")) return "mx"
  return "otro"
}

/**
 * ¿El channelId que reporta la acción de código es coherente con el país del
 * contacto? El channelId termina en el número de la línea (ej.
 * "GeoVictoriaEspaol-whatsapp-56967308227"). Un contacto +57 con canal de la
 * línea +56 casi siempre es el master bot ruteando mal (caso María 23-jul):
 * ese canal NO debe persistirse como origen. Contactos de países sin línea
 * propia (Perú, EEUU...) escriben por cualquier línea, así que para ellos
 * cualquier canal es coherente.
 */
export function canalCoherenteConContacto(contactId: string, canal: string): boolean {
  const numCanal = (canal.match(/(\d+)\s*$/) || [])[1] || ""
  if (!numCanal) return true
  const paisContacto = paisDeNumero(normalizeContactId(contactId))
  if (paisContacto === "otro") return true
  return paisDeNumero(numCanal) === paisContacto
}

export async function detectarCanalOrigen(contactId: string): Promise<string> {
  if (!BM_TOKEN || !SUPABASE_URL_KV || !SUPABASE_KEY_KV) return ""
  const clean = normalizeContactId(contactId)
  try {
    // Ventana de 24 h CON paginación (fix 11-ago, caso +573003012670: la
    // búsqueda vieja de 30 min / 250 mensajes no encontraba al contacto en
    // horas ocupadas, el kv no se escribía y la respuesta salía por la línea
    // del prefijo — cruzada y rechazada por Meta).
    const desde = new Date(Date.now() - 24 * 3600e3).toISOString()
    type Item = { from?: string; creationTime?: string; chat?: { contactId?: string; channelId?: string } }
    const items: Item[] = []
    let url = `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}&pag=true`
    for (let page = 0; page < 8 && url; page++) {
      const r = await fetch(url, { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" })
      if (!r.ok) break
      const data = (await r.json().catch(() => ({}))) as { items?: Item[]; nextPage?: string }
      items.push(...(Array.isArray(data.items) ? data.items : []))
      // Corte temprano: si el contacto ya apareció, no hace falta seguir.
      if (items.some((m) => m.from === "user" && m.chat?.contactId === clean && m.chat?.channelId)) break
      url = String(data.nextPage || "")
      if (!Array.isArray(data.items) || data.items.length === 0) break
    }
    const delContacto = items
      .filter((m) => m.from === "user" && m.chat?.contactId === clean && m.chat?.channelId)
      .sort((a, b) => String(b.creationTime || "").localeCompare(String(a.creationTime || "")))
    const canal = delContacto[0]?.chat?.channelId || ""
    if (canal) {
      await fetch(`${SUPABASE_URL_KV}/rest/v1/vic_kv?on_conflict=key`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY_KV,
          Authorization: `Bearer ${SUPABASE_KEY_KV}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ key: `canal_origen_${clean}`, value: canal }),
        cache: "no-store",
      }).catch(() => {})
      console.log(`[botmaker-push] canal de origen detectado para ${clean}: ${canal}`)
    }
    return canal
  } catch (e) {
    console.error("[botmaker-push] detectarCanalOrigen falló:", e)
    return ""
  }
}

export async function sendBotmakerMessage(
  contactId: string,
  text: string,
  // Multi-país: channelId de la línea por la que responder. Default: línea
  // Chile (BOTMAKER_CHANNEL_V3), compatible con todos los llamadores actuales.
  channelId?: string,
  // transaccional: consecuencia directa de una acción del cliente (pagó) —
  // el gate lo registra pero no lo bloquea. Ver evaluarGateProactividad.
  opts: { transaccional?: boolean } = {},
): Promise<boolean> {
  if (!contactId || !text) {
    console.error("[botmaker-push] contactId y text son requeridos")
    return false
  }

  const cleanContact = normalizeContactId(contactId)
  // El canal de ORIGEN del contacto (si está registrado) manda sobre el del
  // llamador: se responde por donde el cliente escribió. EXCEPCIÓN (22-jul):
  // los números INTERNOS de aviso (QUOTE_NOTIFY_TO / VICKY_REPORT_PHONE) no
  // siguen el canal de origen — si un miembro del equipo prueba una línea
  // nueva como cliente, su canal_origen queda apuntando ahí y los avisos
  // internos empezarían a saltar de línea (pasó con la línea MX). Los avisos
  // del equipo van SIEMPRE por el canal que pida el llamador (o la línea CL).
  const internos = new Set(
    [process.env.QUOTE_NOTIFY_TO, process.env.VICKY_REPORT_PHONE]
      .map((n) => (n || "").trim().replace(/\D/g, ""))
      .filter(Boolean),
  )
  const origen = internos.has(cleanContact) ? "" : await canalDeOrigen(cleanContact)
  const canal = (origen || channelId || BM_CHANNEL_V3).trim()
  if (origen && origen !== (channelId || BM_CHANNEL_V3).trim()) {
    console.log(
      `[botmaker-push] contact=${cleanContact}: canal de origen ${origen} (override sobre ${channelId || "default"})`,
    )
  }
  if (!BM_TOKEN || !canal) {
    console.error(
      "[botmaker-push] BOTMAKER_ACCESS_TOKEN o channelId no configurados",
    )
    return false
  }

  // GATE CENTRAL de proactividad (Fase 2 biblia, 12-ago): en modo sombra solo
  // registra; con GATE_ENFORCE=1 bloquea. Fail-open interno — jamás lanza.
  {
    const { evaluarGateProactividad } = await import("./gate-proactividad")
    const gate = await evaluarGateProactividad(cleanContact, { tipo: "texto", transaccional: opts.transaccional })
    if (!gate.permitir) return false
  }

  try {
    const res = await fetch(SEND_MESSAGES_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        chat: { channelId: canal, contactId: cleanContact },
        messages: [{ text }],
      }),
      cache: "no-store",
    })

    // Botmaker devuelve 202 Accepted cuando el job de envío fue creado.
    // Aceptamos también 200 por si acaso.
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-push] send-messages ${res.status} para ${cleanContact}:`,
        body.slice(0, 300),
      )
      return false
    }

    return true
  } catch (err) {
    console.error("[botmaker-push] Excepción al enviar mensaje:", err)
    return false
  }
}

/**
 * Número de WhatsApp del canal (sin "+"), que la API de notificaciones pide
 * como `chatChannelNumber`. Se setea explícito (BOTMAKER_CHANNEL_NUMBER) o se
 * extrae del channelId (ej. "GeoVictoriaEspaol-whatsapp-56967308227" →
 * "56967308227").
 */
/**
 * Dispara un INTENT de Botmaker sobre el chat de un contacto, opcionalmente
 * seteando VARIABLES del chat antes de la ejecución (la API las aplica en la
 * misma llamada). Uso 28-ago: el tap del quick-reply del alta dispara
 * `#altaflow` con las variables `alta_*` frescas del borrador — el bloque del
 * Bot Designer abre el formulario DIRECTO en "Datos de tu empresa" prellenada
 * (sin pantalla del número y sin depender del INIT roto de Botmaker).
 */
const BM_BUSINESS_ID = (process.env.BOTMAKER_BUSINESS_ID || "GeoVictoriaEspaol").trim()

export async function triggerBotmakerIntent(
  contactId: string,
  intentIdOrName: string,
  variables?: Record<string, string>,
): Promise<boolean> {
  if (!BM_TOKEN || !contactId || !intentIdOrName) return false
  const clean = normalizeContactId(contactId)
  const origen = await canalDeOrigen(clean)
  const num = channelNumber(origen || undefined)
  if (!num) return false
  try {
    const res = await fetch("https://api.botmaker.com/v2.0/chats-actions/trigger-intent", {
      method: "POST",
      headers: BM_HEADERS,
      cache: "no-store",
      body: JSON.stringify({
        chat: { contactId: clean, channelId: `${BM_BUSINESS_ID}-whatsapp-${num}` },
        intentIdOrName,
        ...(variables && Object.keys(variables).length ? { variables } : {}),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`[botmaker-intent] ${intentIdOrName} → ${res.status} para ${clean}:`, body.slice(0, 300))
      return false
    }
    return true
  } catch (e) {
    console.error("[botmaker-intent] excepción:", e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * ¿La ventana de 24h de WhatsApp del contacto está ABIERTA? Fuente de verdad
 * REAL: Botmaker expone `whatsAppWindowCloseDatetime` en el chat (28-ago —
 * nuestro reloj getLastUserAt no ve los taps de quick-reply que van por
 * intent, y decidía "plantilla" con la ventana recién abierta). null = no se
 * pudo saber (el caller decide su fallback).
 */
export async function ventanaWhatsAppAbierta(contactId: string): Promise<boolean | null> {
  if (!BM_TOKEN || !contactId) return null
  const clean = normalizeContactId(contactId)
  const origen = await canalDeOrigen(clean)
  const num = channelNumber(origen || undefined)
  if (!num) return null
  try {
    const r = await fetch(
      `https://api.botmaker.com/v2.0/chats?contact-id=${encodeURIComponent(clean)}&channel-id=${encodeURIComponent(`${BM_BUSINESS_ID}-whatsapp-${num}`)}`,
      { headers: BM_HEADERS, cache: "no-store" },
    )
    if (!r.ok) return null
    const data = (await r.json().catch(() => null)) as
      | { items?: Array<{ whatsAppWindowCloseDatetime?: string }> }
      | Array<{ whatsAppWindowCloseDatetime?: string }>
      | null
    const item = Array.isArray(data) ? data[0] : data?.items?.[0]
    const cierre = Date.parse(String(item?.whatsAppWindowCloseDatetime || ""))
    if (!Number.isFinite(cierre)) return false // sin ventana registrada = cerrada
    return cierre > Date.now() + 60_000 // margen de 1 min para el envío
  } catch {
    return null
  }
}

function channelNumber(overrideNumero?: string): string {
  const explicitOverride = (overrideNumero || "").replace(/\D/g, "")
  if (explicitOverride) return explicitOverride
  const explicit = (process.env.BOTMAKER_CHANNEL_NUMBER || "").replace(/\D/g, "")
  if (explicit) return explicit
  const m = BM_CHANNEL_V3.match(/(\d{6,})\s*$/)
  return m ? m[1] : ""
}

/**
 * Envía una plantilla HSM de WhatsApp (mensaje proactivo aprobado por Meta) a
 * un contacto, vía la API de Notificaciones de Botmaker. Se usa para los
 * recordatorios de reunión, que salen fuera de la ventana de 24h y por eso NO
 * pueden ir como texto libre.
 *
 * @param contactId Teléfono del cliente (con o sin "+").
 * @param templateName Nombre de la plantilla aprobada (ruleNameOrId).
 * @param params Variables de la plantilla por NOMBRE (ej. { nombre, hora_reunion }).
 */
/**
 * Envía un ARCHIVO (PDF) por WhatsApp. Mismo ruteo de canal que
 * sendBotmakerMessage — se responde por donde el cliente escribió.
 *
 * POR QUÉ EXISTE (26-jul): el correo con la cotización sí se entrega, pero cae
 * en Promociones/Otros y el cliente reporta "no me llegó" (10 contactos entre
 * junio y julio). WhatsApp es el canal donde el cliente YA está hablando: darle
 * el PDF ahí evita la dependencia del correo por completo.
 *
 * El esquema `media` es el del OpenAPI oficial de Botmaker
 * (api.botmaker.com/v2.0/openapi.json): { filename, mimeType, url }, con
 * "application/pdf" dentro del enum de mimeTypes soportados.
 */
export async function sendBotmakerMedia(
  contactId: string,
  url: string,
  opts: { filename?: string; mimeType?: string; caption?: string; channelId?: string } = {},
): Promise<boolean> {
  if (!contactId || !url) {
    console.error("[botmaker-push] contactId y url son requeridos para media")
    return false
  }
  const cleanContact = normalizeContactId(contactId)
  const origen = await canalDeOrigen(cleanContact)
  const canal = (origen || opts.channelId || BM_CHANNEL_V3).trim()
  if (!BM_TOKEN || !canal) {
    console.error("[botmaker-push] BOTMAKER_ACCESS_TOKEN o channelId no configurados")
    return false
  }

  // El caption va como mensaje de texto aparte: el objeto `media` del esquema
  // no lo lleva, y mandarlo dentro haría que el archivo saliera sin contexto.
  const messages: Array<Record<string, unknown>> = []
  if (opts.caption) messages.push({ text: opts.caption })
  messages.push({
    media: {
      filename: opts.filename || "documento.pdf",
      mimeType: opts.mimeType || "application/pdf",
      url,
    },
  })

  // GATE CENTRAL de proactividad (Fase 2 biblia): sombra registra, enforce bloquea.
  {
    const { evaluarGateProactividad } = await import("./gate-proactividad")
    const gate = await evaluarGateProactividad(cleanContact, { tipo: "media" })
    if (!gate.permitir) return false
  }

  try {
    const res = await fetch(SEND_MESSAGES_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({ chat: { channelId: canal, contactId: cleanContact }, messages }),
      cache: "no-store",
    })
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-push] media ${res.status} para ${cleanContact}:`,
        body.slice(0, 300),
      )
      return false
    }
    return true
  } catch (e) {
    console.error("[botmaker-push] error enviando media:", e)
    return false
  }
}

export async function sendBotmakerTemplate(
  contactId: string,
  templateName: string,
  params: Record<string, string>,
  // Multi-país: channelId (ej. PERFIL_CO.canal.channelId) o número de la línea
  // por la que debe salir la plantilla. Default: la línea chilena, como siempre.
  channelId?: string,
  // transaccional: ver sendBotmakerMessage — el kickoff del alta post-pago
  // y la bienvenida de pago no son proactividad y el gate no los frena.
  opts: { transaccional?: boolean } = {},
): Promise<boolean> {
  if (!BM_TOKEN) {
    console.error("[botmaker-template] BOTMAKER_ACCESS_TOKEN no configurado")
    return false
  }
  if (!contactId || !templateName) {
    console.error("[botmaker-template] contactId y templateName son requeridos")
    return false
  }
  const cleanContact = normalizeContactId(contactId)
  // El canal de ORIGEN también manda en las PLANTILLAS (fix 11-ago): un
  // contacto que escribió por una línea de otro país recibía los toques por
  // la línea de su prefijo — cruzados y sin entregar. Mismo criterio que
  // sendBotmakerMessage (los números internos de aviso no siguen origen).
  const internosTpl = new Set(
    [process.env.QUOTE_NOTIFY_TO, process.env.VICKY_REPORT_PHONE]
      .map((n) => (n || "").trim().replace(/\D/g, ""))
      .filter(Boolean),
  )
  const origenTpl = internosTpl.has(cleanContact) ? "" : await canalDeOrigen(cleanContact)
  const chatChannelNumber = channelNumber(origenTpl || channelId)
  if (origenTpl && channelNumber(origenTpl) !== channelNumber(channelId)) {
    console.log(`[botmaker-template] contact=${cleanContact}: canal de origen ${origenTpl} (override sobre ${channelId || "default"})`)
  }
  if (!chatChannelNumber) {
    console.error("[botmaker-template] no se pudo determinar chatChannelNumber")
    return false
  }
  // GATE CENTRAL de proactividad (Fase 2 biblia): las plantillas son el envío
  // proactivo por excelencia — acá vive también el anti-repetición de HSM.
  {
    const { evaluarGateProactividad } = await import("./gate-proactividad")
    const gate = await evaluarGateProactividad(cleanContact, { tipo: "plantilla", plantilla: templateName, transaccional: opts.transaccional })
    if (!gate.permitir) return false
  }
  try {
    const res = await fetch(NOTIFICATIONS_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        chatPlatform: "whatsapp",
        chatChannelNumber,
        platformContactId: cleanContact,
        ruleNameOrId: templateName,
        params,
      }),
      cache: "no-store",
    })
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-template] notification ${res.status} para ${cleanContact}:`,
        body.slice(0, 400),
      )
      return false
    }
    // Envío ACEPTADO por Botmaker: recién ahora se quema el anti-repetición
    // (31-ago — estamparlo al evaluar condenaba los reintentos de un fallo).
    {
      const { sellarPlantillaEnviada } = await import("./gate-proactividad")
      void sellarPlantillaEnviada(cleanContact, templateName)
    }
    return true
  } catch (err) {
    console.error("[botmaker-template] Excepción al enviar plantilla:", err)
    return false
  }
}

/**
 * Activa/desactiva el indicador "Vicky está escribiendo..." del cliente.
 * Best-effort: no espera respuesta crítica, ignora errores.
 *
 * @param isTyping true para mostrar "escribiendo..." (al recibir un mensaje del
 *   usuario, antes de responder); false para apagarlo (una vez que Vicky ya
 *   respondió), así el indicador no queda colgado después del mensaje de Vicky.
 */
export async function sendTypingIndicator(
  contactId: string,
  isTyping = true,
  // Multi-país: canal de la línea (default: Chile).
  channelId?: string,
): Promise<void> {
  const canal = (channelId || BM_CHANNEL_V3).trim()
  if (!BM_TOKEN || !canal || !contactId) return
  const cleanContact = normalizeContactId(contactId)
  try {
    await fetch(TYPING_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        channelId: canal,
        contactId: cleanContact,
        typing: isTyping,
      }),
      cache: "no-store",
    })
  } catch {
    // Fire-and-forget: si falla, no es crítico.
  }
}
