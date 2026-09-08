/**
 * Helper para crear Leads en Zoho CRM desde Vicky V3.
 *
 * Diferencia operativa CLAVE con respecto al ownerEmail:
 *   - Si NO se pasa ownerEmail → Owner = vicky default → entra a TÓMBOLA.
 *   - Si SÍ se pasa ownerEmail → resuelve user_id por email → asigna directo (NO tómbola).
 *
 * Usado por:
 *   - registrar_solicitud_callback (sin ownerEmail → tómbola)
 *   - agendar_reunion (con ownerEmail = organizerEmail Cal.com → directo)
 */

import { getZohoAccessToken } from "./zoho-token"

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

function splitName(fullName?: string): { firstName: string; lastName: string } {
  const clean = (fullName || "").trim()
  if (!clean) return { firstName: "", lastName: "Prospecto" }
  const parts = clean.split(/\s+/)
  if (parts.length === 1) return { firstName: "", lastName: parts[0] }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  }
}

export function mapRangoEmpleados(trabajadores?: string | number): string | undefined {
  const raw = typeof trabajadores === "number" ? String(trabajadores) : trabajadores || ""
  const n = parseInt(raw.replace(/\D/g, ""))
  if (isNaN(n) || n <= 0) return undefined
  if (n <= 19) return "1 - 19"
  if (n <= 49) return "20 - 49"
  if (n <= 99) return "50 - 99"
  if (n <= 199) return "100 - 199"
  if (n <= 499) return "200 - 499"
  if (n <= 999) return "500 - 999"
  if (n <= 1999) return "1000 - 1999"
  if (n <= 2999) return "2000 - 2999"
  if (n <= 4999) return "3000 - 4999"
  return "5000 o más"
}

function mapProductoSolucion(necesidad?: string): string | undefined {
  if (!necesidad) return undefined
  const n = necesidad.toLowerCase()
  if (n.includes("acceso")) return "Control de acceso"
  if (n.includes("comedor")) return "Servicio de  comedor"
  if (n.includes("asistencia")) return "Control de Asistencia"
  return undefined
}

function sanitize(text: string | undefined, maxLen = 200): string {
  if (!text) return ""
  return text.replace(/[^\x20-\x7EÀ-ɏ -ÿ\n]/g, " ").slice(0, maxLen).trim()
}

function buildTranscript(
  conversation?: Array<{ role?: string; content?: string; at?: string }>,
): string {
  const rows = Array.isArray(conversation) ? conversation : []
  return rows
    .map((m) => {
      const role = m?.role === "assistant" ? "Vic" : "Prospecto"
      const at = typeof m?.at === "string" ? m.at : ""
      const content = typeof m?.content === "string" ? m.content : ""
      return `${at} | ${role}: ${content}`
    })
    .join("\n")
    .slice(0, 32000)
}

export async function resolveOwnerId(
  email: string,
  token: string,
  apiDomain: string,
): Promise<string | null> {
  // OJO: la API pagina de a 200 y los usuarios van ordenados por antigüedad,
  // así que las contrataciones recientes quedan en las ÚLTIMAS páginas. El
  // tope anterior de 5 páginas dejaba sin resolver al equipo CO (Eddy y Diego
  // están en la página 6 de +1200 usuarios) y el lead de la reunión caía al
  // owner default en silencio (bug prueba CO 13-jul). Recorremos hasta agotar
  // more_records, con tope de seguridad amplio.
  try {
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(
        `${apiDomain}/crm/v2/users?type=AllUsers&per_page=200&page=${page}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        },
      )
      if (!res.ok) return null
      const data = (await res.json()) as {
        users?: Array<{ id: string; email: string; status?: string }>
        info?: { more_records?: boolean }
      }
      const match = (data?.users || []).find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      )
      if (match?.id) {
        // Zoho no acepta usuarios desactivados como Owner: mejor caer al owner
        // default (con log) que fallar el update con un error confuso.
        if ((match.status || "").toLowerCase() !== "active") {
          console.error(
            `[zoho-leads] resolveOwnerId: ${email} existe en Zoho pero está "${match.status}" — no se puede asignar (reactivarlo o corregir el email del host en Cal.com)`,
          )
          return null
        }
        return match.id
      }
      if (!data?.info?.more_records) break
    }
    console.error(`[zoho-leads] resolveOwnerId: email ${email} no encontrado entre los usuarios de Zoho`)
    return null
  } catch {
    return null
  }
}

/**
 * Actualiza el Owner de un Lead existente (al reagendar con cambio de host).
 * Resuelve el user_id por email; si no lo encuentra, NO toca el owner (evita
 * dejarlo en un id inválido). Best-effort: nunca rompe el flujo de reagendar.
 */
export async function updateZohoLeadOwner(
  leadId: string,
  ownerEmail: string,
): Promise<{ success: boolean; error?: string }> {
  if (!leadId || !ownerEmail) return { success: false, error: "leadId u ownerEmail faltante" }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    const ownerId = await resolveOwnerId(ownerEmail, accessToken, apiDomain)
    if (!ownerId) return { success: false, error: `No se resolvió user_id para ${ownerEmail}` }

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Owner: { id: ownerId } }] }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string; message?: string }>
    }
    const status = data?.data?.[0]?.status
    if (!res.ok || status !== "success") {
      return { success: false, error: `Zoho update owner: ${JSON.stringify(data).slice(0, 200)}` }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "error actualizando owner del lead" }
  }
}

/**
 * VISIBILIDAD INTER-CANAL (caso Ingesub, 20-jul): busca si el contacto tiene
 * un lead ABIERTO (no convertido) trabajado por OTRO dueño (humano). Es la
 * base del sistema anti-venta-paralela-a-ciegas: dos canales pueden atender
 * al mismo cliente, pero jamás sin saberlo. Best-effort: null en error.
 */
const VICKY_OWNER_ID_PUBLIC = "3525045000484500876"

export async function buscarLeadAbiertoDeOtroDueno(
  telefono?: string,
  email?: string,
): Promise<{ id: string; ownerNombre: string; ownerEmail: string; empresa: string; status: string } | null> {
  const fono = (telefono || "").replace(/\D/g, "")
  const mail = (email || "").trim().toLowerCase()
  if (!fono && !mail) return null
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const buscar = async (qs: string) => {
      const res = await fetch(
        `${apiDomain}/crm/v2/${moduleName}/search?${qs}&converted=false&per_page=10`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, cache: "no-store" },
      )
      if (!res.ok) return []
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{
          id?: string
          Owner?: { id?: string; name?: string; email?: string }
          Company?: string
          Lead_Status?: string
          Modified_Time?: string
        }>
      }
      return data?.data || []
    }
    const candidatos = [
      ...(fono ? await buscar(`phone=${encodeURIComponent(fono.slice(-9))}`) : []),
      ...(mail ? await buscar(`email=${encodeURIComponent(mail)}`) : []),
    ]
    // CADUCIDAD (regla del doc de Gestión de Leads, aplicada por Lalo 03-ago
    // — caso Karina): un lead ajeno solo BLOQUEA la prospección de Vicky si
    // tuvo actividad en los últimos 3 meses. Un lead zombi (16 meses parado
    // en "Calificado") no puede vetar al canal 24/7 para siempre — el dueño
    // igual recibe su nota/aviso por el camino del que detecta el duplicado.
    const CADUCIDAD_MS = 90 * 24 * 3600e3
    const ajeno = candidatos.find(
      (l) =>
        l?.Owner?.id &&
        String(l.Owner.id) !== VICKY_OWNER_ID_PUBLIC &&
        Date.now() - Date.parse(String(l.Modified_Time || "")) < CADUCIDAD_MS,
    )
    if (!ajeno) return null
    return {
      id: String(ajeno.id),
      ownerNombre: String(ajeno.Owner?.name || "(sin nombre)"),
      ownerEmail: String(ajeno.Owner?.email || ""),
      empresa: String(ajeno.Company || ""),
      status: String(ajeno.Lead_Status || ""),
    }
  } catch {
    return null
  }
}

/** Agrega una nota visible en la cronología de un lead. Best-effort. */
export async function agregarNotaLead(
  leadId: string,
  titulo: string,
  contenido: string,
): Promise<boolean> {
  if (!leadId || !contenido) return false
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}/Notes`, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Note_Title: titulo.slice(0, 120), Note_Content: contenido.slice(0, 30000) }] }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Actualiza campos arbitrarios de un lead (ej. Country/Territorio cuando el
 * formulario trae el país que no calza con el prefijo telefónico — caso
 * Joys/Perú 19-jul: Country "Chile" con teléfono +51). Best-effort: nunca
 * rompe el flujo. No maneja blueprint (usar updateZohoLeadStatus para
 * Lead_Status).
 */
export async function updateZohoLeadFields(
  leadId: string,
  fields: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  if (!leadId || !fields || Object.keys(fields).length === 0) {
    return { success: false, error: "leadId o fields faltante" }
  }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const res = await fetch(`${apiDomain}/crm/v3/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ ...fields }],
        // JAMÁS cambiar propietarios (Eduardo 14-ago). Esta función solo
        // completa datos (nombre, empresa, RUT, correo), pero un PUT sobre un
        // lead dispara las assignment rules de Zoho y el dueño se re-sortea
        // solo — la conciliación habría empezado a mover leads de mano sin
        // que nadie lo pidiera. El skip corta eso de raíz.
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return { success: false, error: `Zoho update fields ${res.status} ${data?.data?.[0]?.code || ""}` }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Actualiza el Lead_Status de un lead (diccionario acordado con Marketing
 * jul-2026: envío de mensaje = "2. Intento de contacto"; respuesta del cliente
 * = "3. Contactado"). Best-effort: nunca rompe el flujo.
 */
export async function updateZohoLeadStatus(
  leadId: string,
  status: string,
): Promise<{ success: boolean; error?: string }> {
  if (!leadId || !status) return { success: false, error: "leadId o status faltante" }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const res = await fetch(`${apiDomain}/crm/v3/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        // Subir el status no puede re-sortear al dueño (Eduardo 14-ago).
        data: [{ Lead_Status: status }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      // El Lead_Status del org vive dentro de un BLUEPRINT: el update directo
      // devuelve RECORD_IN_BLUEPRINT y hay que ejecutar la TRANSICIÓN cuyo
      // estado destino coincida con el pedido.
      if (data?.data?.[0]?.code === "RECORD_IN_BLUEPRINT") {
        return await ejecutarTransicionBlueprint(
          apiDomain,
          accessToken,
          moduleName,
          leadId,
          status,
        )
      }
      return { success: false, error: `Zoho update status ${res.status}` }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "error actualizando status" }
  }
}

// Campos que las transiciones del blueprint exigen y su valor default para el
// contexto de Vicky (el cliente respondió el WhatsApp y está en conversación).
const BLUEPRINT_FIELD_DEFAULTS: Record<string, string> = {
  // Picklist "Pendiente para calificado" de la transición a "3. Contactado".
  Motivo_Calificado_no_convertido: "Falta información del cliente",
  // La transición a "4. Calificado" declara SIETE campos (verificado contra
  // el blueprint el 14-ago). Con solo dos de ellos, Zoho responde SUCCESS y
  // NO mueve el lead: falla en silencio, y por eso ningún lead de Vicky
  // llegaba a Calificado. Los que se pueden dar por defecto van acá; el
  // resto (N° de empleados, RUT, territorio) se copian del propio lead.
  Tombola: "Mantener propietario",
  Producto_Soluci_n: "Control de Asistencia",
  Sector: "19. Servicios",
  Tiene_potencial_de_expansi_n_Regional: "No",
}

/** Campos que la transición exige y que NO se inventan: se copian del lead si
 * los tiene. Inventar el N° de empleados fue una cicatriz cara (06-ago: el
 * default 1 mandaba empresas de 500 al tramo SMB de la tómbola). */
const BLUEPRINT_FIELDS_DEL_LEAD = [
  "N_Empleados_que_marcan",
  "RUT_Empresa",
  "Territorio",
  "Sector",
  "Tiene_potencial_de_expansi_n_Regional",
]

// Ejecuta la transición del blueprint del lead cuyo valor de destino calza con
// el status pedido (match exacto o por inclusión, ej. "3. Contactado").
async function ejecutarTransicionBlueprint(
  apiDomain: string,
  accessToken: string,
  moduleName: string,
  leadId: string,
  status: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    }
    const bpRes = await fetch(
      `${apiDomain}/crm/v2/${moduleName}/${leadId}/actions/blueprint`,
      { headers, cache: "no-store" },
    )
    if (!bpRes.ok) return { success: false, error: `blueprint GET ${bpRes.status}` }
    const bp = (await bpRes.json().catch(() => ({}))) as {
      blueprint?: {
        transitions?: Array<{
          id: string
          name?: string
          next_field_value?: string
          fields?: Array<{ api_name?: string }>
        }>
      }
    }
    const transitions = bp?.blueprint?.transitions || []
    const objetivo = status.toLowerCase()
    const match = transitions.find((t) => {
      const destino = (t.next_field_value || "").toLowerCase()
      const nombre = (t.name || "").toLowerCase()
      return destino === objetivo || destino.includes(objetivo) || objetivo.includes(destino) || nombre.includes(objetivo)
    })
    if (!match) {
      return {
        success: false,
        error: `sin transición hacia "${status}" (disponibles: ${transitions
          .map((t) => t.next_field_value || t.name)
          .join(", ")
          .slice(0, 150)})`,
      }
    }
    // Completar TODOS los campos que la transición exige. Primero lo que el
    // lead ya trae (su verdad manda), después los defaults conocidos.
    const declarados = (match.fields || []).map((f) => f?.api_name || "").filter(Boolean)
    const delLead: Record<string, unknown> = {}
    const aCopiar = declarados.filter((a3) => BLUEPRINT_FIELDS_DEL_LEAD.includes(a3))
    if (aCopiar.length) {
      const actual = await fetch(
        `${apiDomain}/crm/v3/${moduleName}/${leadId}?fields=${aCopiar.join(",")}`,
        { headers, cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      Object.assign(
        delLead,
        (((actual as { data?: Array<Record<string, unknown>> } | null)?.data || [])[0]) || {},
      )
    }
    const data: Record<string, unknown> = {}
    for (const api of declarados) {
      const propio = delLead[api]
      if (propio !== undefined && propio !== null && String(propio).trim() !== "") {
        data[api] = propio
      } else if (BLUEPRINT_FIELD_DEFAULTS[api]) {
        data[api] = BLUEPRINT_FIELD_DEFAULTS[api]
      }
    }
    const exec = await fetch(
      `${apiDomain}/crm/v2/${moduleName}/${leadId}/actions/blueprint`,
      {
        method: "PUT",
        headers,
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: match.id, data }] }),
      },
    )
    // OJO con la forma de la respuesta: Zoho devuelve el resultado DENTRO de
    // un arreglo ({"blueprint":[{code,status,message}]} o {"data":[...]}).
    // Mirar solo el nivel superior daba "éxito" a errores per-registro — así
    // es como la transición a "4. Calificado" venía fallando en silencio.
    const execRaw = (await exec.json().catch(() => ({}))) as Record<string, unknown>
    const primero =
      (Array.isArray(execRaw?.blueprint) ? execRaw.blueprint[0] : undefined) ||
      (Array.isArray(execRaw?.data) ? execRaw.data[0] : undefined) ||
      execRaw
    const execData = (primero || {}) as { code?: string; status?: string; message?: string }
    if (!exec.ok || (execData?.code && execData.code !== "SUCCESS")) {
      return {
        success: false,
        error: `blueprint PUT ${exec.status}: ${JSON.stringify(execRaw).slice(0, 600)}`,
      }
    }
    // VERIFICAR que de verdad se movió (Eduardo 14-ago). Hay transiciones que
    // responden SUCCESS y dejan el lead donde estaba —el salto a
    // "4. Calificado" lo hace— y ese falso éxito hacía que la conciliación
    // reportara leads corregidos que en el CRM seguían atrás. Mejor decir que
    // falló y que quede a la vista.
    const check = await fetch(`${apiDomain}/crm/v3/${moduleName}/${leadId}?fields=Lead_Status`, {
      headers,
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    const quedo = String(
      (((check as { data?: Array<{ Lead_Status?: string }> } | null)?.data || [])[0]?.Lead_Status) || "",
    ).trim()
    if (quedo && quedo.toLowerCase() !== status.toLowerCase()) {
      return {
        success: false,
        error: `blueprint aceptó la transición "${match.name || match.id}" pero el lead quedó en "${quedo}" (pedido "${status}")`,
      }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción blueprint" }
  }
}

// SDRs Inbound para la reasignación de lo que Vicky suelta (acuerdo con
// Marketing jul-2026). Formato "email:zohoUserId" — con el id directo no
// dependemos de la API de usuarios (400+ usuarios, paginada y con scope
// propio). Si falta el id, se resuelve por email como fallback.
const SDR_INBOUND = (
  process.env.VIC_SDR_INBOUND ||
  "aaraque@geovictoria.com:3525045000583802005,asepulveda@geovictoria.com:3525045000594735052"
)
  .split(",")
  .map((s) => {
    const [email, id] = s.split(":").map((x) => x.trim())
    return { email, id: id || "" }
  })
  .filter((s) => s.email)

/**
 * Reasigna un lead al siguiente SDR Inbound del round-robin (turno persistido
 * en vic_kv → equitativo entre invocaciones serverless). Devuelve a quién quedó.
 */
/**
 * Cada entrega de lead arrastra sus PENDIENTES (Lalo 29-ago): la tarea y la
 * llamada que el workflow "TASK Y CALL NO CONTACTADO" dejó a nombre del robot
 * pasan al dueño sorteado, para que aparezcan en su to-do. Best-effort: si
 * falla, la entrega del lead igual se dio por buena.
 */
async function moverPendientes(leadId: string, ownerId?: string, ownerEmail?: string): Promise<void> {
  try {
    const { reasignarPendientesDelLead } = await import("./reasignar-pendientes-lead")
    await reasignarPendientesDelLead(leadId, { ownerId, ownerEmail })
  } catch {
    /* nunca bloquea el traspaso */
  }
}

export async function reasignarLeadSdrInbound(
  leadId: string,
): Promise<{ success: boolean; ownerEmail?: string; error?: string }> {
  if (!leadId || SDR_INBOUND.length === 0) {
    return { success: false, error: "leadId faltante o sin SDRs configuradas" }
  }
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const last = parseInt((await getKvValue("sdr_inbound_rr").catch(() => null)) || "-1")
    const idx = (isNaN(last) ? 0 : last + 1) % SDR_INBOUND.length
    const sdr = SDR_INBOUND[idx]

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const ownerId = sdr.id || (await resolveOwnerId(sdr.email, accessToken, apiDomain))
    if (!ownerId) return { success: false, error: `sin user_id para ${sdr.email}` }

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Owner: { id: ownerId } }] }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string; message?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return {
        success: false,
        error: `PUT owner ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      }
    }
    await setKvValue("sdr_inbound_rr", String(idx)).catch(() => {})
    await moverPendientes(leadId, ownerId, sdr.email)
    return { success: true, ownerEmail: sdr.email }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción reasignando" }
  }
}

/**
 * MOTIVOS TERMINALES de "No Calificado" (Lalo 21-ago, catastro de traspasos —
 * reclamo de las SDR vía Dave: Vicky les "devolvía" contactos que ellas ya
 * habían descartado). Un lead descartado por estos motivos NO es un prospecto:
 * el re-contacto jamás lo reactiva, jamás renace un lead nuevo y jamás se
 * vuelve a entregar por traspaso. Vicky sigue atendiendo REACTIVA (responde
 * si le escriben); el CRM queda como el SDR lo dejó. La única puerta que lo
 * revive es la venta real (emisión formal / hitos post-formales).
 * Valores EXACTOS del picklist Motivo_No_calificado (verificados 21-ago).
 * Override sin deploy: env VICKY_MOTIVOS_TERMINALES (lista separada por "|").
 */
const MOTIVOS_TERMINALES_DEFAULT = [
  "Es un usuario",
  "Usuario que busca empleo",
  "Quiere otro tipo de Hardware (Que no vendemos)",
  "Pruebas (internas)",
  "SPAM (Publicidad-Virus)",
]

export function esMotivoTerminal(status: string, motivo: string | null | undefined): boolean {
  if (!/no calificado/i.test(status || "")) return false
  const custom = (process.env.VICKY_MOTIVOS_TERMINALES || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
  const lista = custom.length ? custom : MOTIVOS_TERMINALES_DEFAULT
  const m = String(motivo || "").trim().toLowerCase()
  return m !== "" && lista.some((x) => x.toLowerCase() === m)
}

/**
 * TELEMARKETING CL (Lalo 04-ago): un lead que Vicky NO puede atender (número
 * sin WhatsApp, cadencia agotada, sin calificar) se re-asigna con la REGLA de
 * Zoho "Re-asignación de Vicky" (lar_id) — NO con la rotación SDR interna.
 * Misma filosofía que la tómbola de deals y los callbacks: la regla decide.
 * Devuelve el email del dueño sorteado, o undefined si la regla no asignó.
 */
const TM_TOMBOLA_LEADS_CL = (process.env.VICKY_TM_TOMBOLA_LEADS_CL || "3525045000649066001").trim()
// ESCALERA DE ROLES (biblia, reglas de Lalo 12-ago): dos tómbolas de Zoho.
// Lead CALIFICADO (precio mostrado / dotación conocida) → "Asignación Leads
// Vicky TLMK" 3525045000649066001, cuyo roster Lalo cambió a EJECUTIVOS el
// 12-ago 17:11. Lead SIN calificar → "Asignación Leads Sin calificar Vicky
// SDR" 3525045000652043111 (creada 12-ago). El RR interno Araceli/Aleydis
// queda de fallback SOLO para el camino sin calificar (es el roster SDR).
const TM_TOMBOLA_SIN_CALIFICAR_CL = (process.env.VICKY_TM_SIN_CALIFICAR_RULE_ID || "3525045000652043111").trim()

export async function reasignarLeadTelemarketingCL(
  leadId: string,
): Promise<{ success: boolean; ownerEmail?: string; error?: string }> {
  // ESCALERA 18-ago (Lalo): sus tres llamadores (número sin WhatsApp, cadencia
  // agotada, mensaje no entregado) son casos donde Vicky NO logró calificar →
  // "pasa a leads de los SDR" (regla …3111), ya no a la TLMK de ejecutivos.
  const regla = TM_TOMBOLA_SIN_CALIFICAR_CL || TM_TOMBOLA_LEADS_CL
  if (!leadId || !regla) return { success: false, error: "leadId o regla faltante" }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const H = { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" }
    const put = await fetch(`${apiDomain}/crm/v3/Leads`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: leadId }], lar_id: regla }),
    })
    if (!put.ok) return { success: false, error: `regla PUT ${put.status}` }
    const g = await fetch(`${apiDomain}/crm/v3/Leads/${leadId}?fields=Owner`, { headers: H, cache: "no-store" })
    const owner = g.ok
      ? ((await g.json().catch(() => ({}))) as { data?: Array<{ Owner?: { email?: string } }> }).data?.[0]?.Owner
      : undefined
    const email = (owner?.email || "").toLowerCase()
    if (!email || /vicky@|info@geovictoria/.test(email)) return { success: false, error: "la regla no asignó dueño" }
    await moverPendientes(leadId, undefined, owner?.email)
    return { success: true, ownerEmail: owner?.email }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción" }
  }
}

/**
 * TÓMBOLA DE LEADS POR CALIFICACIÓN — escalera de roles (biblia 12-ago):
 * `calificado: true` (precio mostrado o dotación conocida) dispara la regla
 * de leads CALIFICADOS → ejecutivos (649066001, roster de Lalo 12-ago);
 * sin el flag va a la regla SIN CALIFICAR → SDR (652043111). El camino
 * primario siempre es la REGLA de Zoho (lar_id); el round-robin interno
 * Araceli/Aleydis queda de fallback SOLO para el camino sin calificar (ellas
 * son el roster SDR — un calificado jamás debe caerles por fallback).
 * Overrides sin deploy: VICKY_TM_CALIFICACION_RULE_ID (calificados),
 * VICKY_TM_SIN_CALIFICAR_RULE_ID (SDR) y VICKY_TM_CALIFICACION_DESTINOS
 * ("email:user_id:Nombre,..." del fallback SDR).
 */
const DESTINOS_CALIFICACION_CL = (
  process.env.VICKY_TM_CALIFICACION_DESTINOS ||
  "aaraque@geovictoria.com:3525045000583802005:Aleydis Araque," +
    "asepulveda@geovictoria.com:3525045000594735052:Aracelli Sepúlveda"
)
  .split(",")
  .map((par) => {
    const [email, id, nombre] = par.split(":").map((x) => (x || "").trim())
    return { email: (email || "").toLowerCase(), id: id || "", nombre: nombre || (email || "").split("@")[0] }
  })
  .filter((d) => d.email && d.id)

export async function reasignarLeadCalificacionCL(
  leadId: string,
  opts: { calificado?: boolean } = {},
): Promise<{ success: boolean; ownerEmail?: string; ownerId?: string; ownerNombre?: string; error?: string }> {
  if (!leadId) return { success: false, error: "leadId faltante" }
  // TRAMO ENTERPRISE >300 (Lalo 28-ago, caso Clínica Alemana→Ana): un lead
  // enterprise JAMÁS va al circuito de venta TLMK. Sin RUT no puede subir a
  // deal por la escalera, así que se entrega a las SDR con la MISIÓN de
  // conseguir el RUT — con RUT registrado, la escalera lo convierte a deal y
  // la Tómbola de Deals (entradas 301+) lo asigna al roster KAM. Este es el
  // punto único por el que pasan todas las entregas CL (traspaso, reloj de
  // calificación, rescate de forms), así que la regla vive acá.
  let esEnterprise = false
  let dotacionLead = 0
  try {
    const tk = await getZohoAccessToken()
    const dom = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const g = await fetch(`${dom}/crm/v3/Leads/${leadId}?fields=N_Empleados_que_marcan`, {
      headers: { Authorization: `Zoho-oauthtoken ${tk}` },
      cache: "no-store",
    })
    dotacionLead =
      Number(
        ((await g.json().catch(() => ({}))) as { data?: Array<{ N_Empleados_que_marcan?: number }> }).data?.[0]
          ?.N_Empleados_que_marcan,
      ) || 0
    const umbralEnt = Number(process.env.VICKY_ENTERPRISE_UMBRAL || 300) || 300
    esEnterprise = dotacionLead > umbralEnt
  } catch {
    /* sin dotación legible: flujo normal */
  }
  const calificado = opts.calificado === true && !esEnterprise
  const notaEnterprise = async () => {
    if (!esEnterprise) return
    await agregarNotaLead(
      leadId,
      "TRAMO ENTERPRISE — misión SDR: conseguir el RUT",
      `Este lead declara ~${dotacionLead} personas: supera el rango de venta de telemarketing (>300) y por regla va a calificación SDR, no al circuito TLMK. ` +
        `Misión: obtener el RUT y calificar — con el RUT registrado, el sistema crea el deal automáticamente y lo asigna al roster enterprise por la Tómbola de Deals. ` +
        `NO cotizar desde telemarketing. (Ruteo enterprise automático, regla del 28-ago.)`,
    ).catch(() => {})
  }
  // Camino primario: la REGLA de Zoho que corresponda al escalón.
  const regla = calificado
    ? (process.env.VICKY_TM_CALIFICACION_RULE_ID || TM_TOMBOLA_LEADS_CL).trim()
    : TM_TOMBOLA_SIN_CALIFICAR_CL
  if (regla) {
    try {
      const accessToken = await getZohoAccessToken()
      const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
      const H = { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" }
      const put = await fetch(`${apiDomain}/crm/v3/Leads`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id: leadId }], lar_id: regla }),
      })
      if (put.ok) {
        // La regla de Zoho corre ASÍNCRONA tras el PUT: una sola lectura
        // inmediata suele ver todavía a vicky@ y el llamador cae al fallback —
        // el correo de "nuevo lead" termina en la persona equivocada y la
        // dueña real jamás se entera (caso Ana López / Clínica Alemana,
        // 28-ago). Se relee con reintentos hasta ver al ganador del sorteo.
        for (let intento = 0; intento < 4; intento++) {
          if (intento > 0) await new Promise((r) => setTimeout(r, 2500))
          const g = await fetch(`${apiDomain}/crm/v3/Leads/${leadId}?fields=Owner`, { headers: H, cache: "no-store" })
          const owner = g.ok
            ? ((await g.json().catch(() => ({}))) as {
                data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }>
              }).data?.[0]?.Owner
            : undefined
          const email = (owner?.email || "").toLowerCase()
          if (email && !/vicky@|info@geovictoria/.test(email)) {
            await notaEnterprise()
            await moverPendientes(leadId, owner?.id, owner?.email)
            return { success: true, ownerEmail: owner?.email, ownerId: owner?.id, ownerNombre: owner?.name }
          }
        }
      }
      console.warn(`[zoho-leads] regla ${calificado ? "calificados" : "sin-calificar"} ${regla} no asignó lead ${leadId}`)
    } catch { /* fallback RR abajo (solo sin calificar) */ }
  }
  // El RR interno es el roster SDR: un lead CALIFICADO no cae ahí — si su
  // regla no asignó, se reporta y el llamador decide (interino/dueño actual).
  if (calificado) {
    return { success: false, error: "regla de calificados no asignó (sin fallback SDR)" }
  }
  if (DESTINOS_CALIFICACION_CL.length === 0) {
    return { success: false, error: "regla no asignó y sin destinos de fallback" }
  }
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const last = parseInt((await getKvValue("tm_calif_rr_cl").catch(() => null)) || "-1")
    const idx = (isNaN(last) ? 0 : last + 1) % DESTINOS_CALIFICACION_CL.length
    const destino = DESTINOS_CALIFICACION_CL[idx]

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const res = await fetch(`${apiDomain}/crm/v3/Leads`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: leadId, Owner: { id: destino.id } }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; message?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return { success: false, error: `PUT owner ${res.status}: ${JSON.stringify(data).slice(0, 200)}` }
    }
    await setKvValue("tm_calif_rr_cl", String(idx)).catch(() => {})
    await notaEnterprise()
    await moverPendientes(leadId, destino.id, destino.email)
    return { success: true, ownerEmail: destino.email, ownerId: destino.id, ownerNombre: destino.nombre }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción reasignando" }
  }
}

// SDR de Colombia — REGLA EQUIPO CO (Lalo 05-ago: "para colombia no hay round
// robin por el momento, son fijos"): TODO hito que no sea la cotización formal
// va a Eddy Galindo, fijo. Se conserva el formato env "email_o_label:user_id"
// (VIC_SDR_INBOUND_CO) por si vuelve una rotación: HOY solo se usa la PRIMERA
// entrada; las demás se ignoran.
const SDR_INBOUND_CO = (
  process.env.VIC_SDR_INBOUND_CO ||
  "egalindo@geovictoria.com:3525045000613817111"
)
  .split(",")
  .map((s) => {
    const [email, id] = s.split(":").map((x) => x.trim())
    return { email, id: id || "" }
  })
  .filter((s) => s.email)

/**
 * Reasigna un lead CO al SDR colombiano FIJO (Eddy Galindo — regla equipo CO
 * 05-ago, sin round-robin). El turno vic_kv `sdr_inbound_rr_co` quedó sin uso.
 */
export async function reasignarLeadSdrInboundCO(
  leadId: string,
): Promise<{ success: boolean; ownerEmail?: string; ownerId?: string; error?: string }> {
  if (!leadId || SDR_INBOUND_CO.length === 0) {
    return { success: false, error: "leadId faltante o sin SDRs CO configuradas" }
  }
  try {
    const sdr = SDR_INBOUND_CO[0] // fijo: primera entrada (Galindo)

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const ownerId = sdr.id || (await resolveOwnerId(sdr.email, accessToken, apiDomain))
    if (!ownerId) return { success: false, error: `sin user_id para ${sdr.email}` }

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Owner: { id: ownerId } }] }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string; message?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return {
        success: false,
        error: `PUT owner ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      }
    }
    await moverPendientes(leadId, ownerId, sdr.email)
    return { success: true, ownerEmail: sdr.email, ownerId }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción reasignando" }
  }
}

// SDR INBOUND MÉXICO (Lalo 13-ago): todo traspaso MX que NO sea cotización
// formal entrega el LEAD a los SDR Inbound mexicanos por round-robin (turno
// en vic_kv `sdr_inbound_rr_mx`). Roster por env VIC_SDR_INBOUND_MX en formato
// "email:zohoUserId,email:zohoUserId". SIN roster configurado la función
// devuelve success:false y el llamador cae al comportamiento actual (Yahel) —
// deployable antes de tener los nombres.
const SDR_INBOUND_MX = (process.env.VIC_SDR_INBOUND_MX || "")
  .split(",")
  .map((s) => {
    const [email, id] = s.split(":").map((x) => x.trim())
    return { email, id: id || "" }
  })
  .filter((s) => s.email)

// Tómbola de SDR Inbound MX en ZOHO (Lalo 13-ago): la regla decide el sorteo.
// Override por env; el RR interno del roster queda solo de fallback.
const TM_SDR_INBOUND_MX = (process.env.VICKY_TM_SDR_INBOUND_MX_RULE_ID || "3525045000652685096").trim()

/** Reasigna un lead MX vía la tómbola de Zoho de SDR Inbound; fallback RR interno. */
export async function reasignarLeadSdrInboundMX(
  leadId: string,
): Promise<{ success: boolean; ownerEmail?: string; ownerId?: string; error?: string }> {
  if (!leadId) return { success: false, error: "leadId faltante" }
  // Camino primario: la REGLA de Zoho (lar_id) — mismo patrón que CL.
  if (TM_SDR_INBOUND_MX) {
    try {
      const accessToken = await getZohoAccessToken()
      const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
      const H = { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" }
      const put = await fetch(`${apiDomain}/crm/v3/Leads`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id: leadId }], lar_id: TM_SDR_INBOUND_MX }),
      })
      if (put.ok) {
        const g = await fetch(`${apiDomain}/crm/v3/Leads/${leadId}?fields=Owner`, { headers: H, cache: "no-store" })
        const owner = g.ok
          ? ((await g.json().catch(() => ({}))) as {
              data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }>
            }).data?.[0]?.Owner
          : undefined
        const email = (owner?.email || "").toLowerCase()
        // La regla asignó solo si el dueño dejó de ser un usuario interino.
        if (email && !/vicky@|info@geovictoria/.test(email)) {
          await moverPendientes(leadId, owner?.id, owner?.email)
          return { success: true, ownerEmail: owner?.email, ownerId: owner?.id }
        }
      }
      console.warn(`[zoho-leads] tómbola SDR MX ${TM_SDR_INBOUND_MX} no asignó lead ${leadId} — fallback RR interno`)
    } catch { /* fallback RR abajo */ }
  }
  if (SDR_INBOUND_MX.length === 0) {
    return { success: false, error: "tómbola MX no asignó y sin roster de fallback (VIC_SDR_INBOUND_MX)" }
  }
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const last = parseInt((await getKvValue("sdr_inbound_rr_mx").catch(() => null)) || "-1")
    const idx = (isNaN(last) ? 0 : last + 1) % SDR_INBOUND_MX.length
    const sdr = SDR_INBOUND_MX[idx]

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const ownerId = sdr.id || (await resolveOwnerId(sdr.email, accessToken, apiDomain))
    if (!ownerId) return { success: false, error: `sin user_id para ${sdr.email}` }

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ Owner: { id: ownerId } }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string; message?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return {
        success: false,
        error: `PUT owner ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      }
    }
    await setKvValue("sdr_inbound_rr_mx", String(idx)).catch(() => {})
    return { success: true, ownerEmail: sdr.email, ownerId }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción reasignando" }
  }
}

export type CreateZohoLeadInput = {
  nombre?: string
  empresa?: string
  email?: string
  telefono?: string
  cargo?: string
  pais?: string
  ciudad?: string
  trabajadores?: string | number
  necesidad?: string
  idioma?: string
  reunionAgendada?: boolean
  preferenciaHorario?: string
  sistemaActual?: string
  contactoWA?: string
  ownerEmail?: string
  /** Owner directo por Zoho user id (multi-país: SDRs CO). Gana sobre ownerEmail. */
  ownerId?: string
  conversacion?: Array<{ role?: string; content?: string; at?: string }>
}

export type CreateZohoLeadResult =
  | {
      success: true
      leadId: string
      entraATombola: boolean
      ownerEmail: string
    }
  | {
      success: false
      error: string
    }

const VICKY_DEFAULT_OWNER_EMAIL = "vicky@geovictoria.com"

// Id de Vicky en Zoho. Los leads SIN reunión deben quedar SIEMPRE con este
// owner (entran a tómbola). No se usa ZOHO_CRM_OWNER_ID para evitar que una
// variable de entorno mal configurada los redirija a otra persona.
const VICKY_OWNER_ID = "3525045000484500876"

export async function createZohoLead(input: CreateZohoLeadInput): Promise<CreateZohoLeadResult> {
  try {
    // CLIENTE EXISTENTE (Lalo 08-sep): jamás un lead para un número que ya es
    // cliente (cuenta 3. Cliente/Facturando o con usuarios activos).
    try {
      const fonoCE = ((input.telefono || "").trim() || (input.contactoWA || "").trim()).replace(/\D/g, "")
      if (fonoCE.startsWith("56")) {
        const { detectarClienteExistente } = await import("./cliente-existente")
        const ce = await detectarClienteExistente(fonoCE)
        if (ce) {
          console.log(`[zoho-leads] ${fonoCE}: cliente existente (${ce.cuentaNombre}) — no se crea lead`)
          return { success: false, error: `cliente_existente:${ce.cuentaNombre}` }
        }
      }
    } catch { /* sin señal: sigue */ }
    // CANDADO ANTI-DUPLICADOS (casos SYDA/Vélez/Catalina/Mayra, 28-30 jul):
    // el search de Zoho tarda ~2 min en indexar un lead nuevo, así que un
    // reintento o un segundo flujo dentro de esa ventana creaba otro lead
    // idéntico. El candado vive en vic_kv (consistencia inmediata): si este
    // teléfono ya creó un lead, se REUTILIZA en vez de duplicar.
    const fonoCandado = ((input.telefono || "").trim() || (input.contactoWA || "").trim()).replace(/\D/g, "")
    const kvKeyLead = fonoCandado ? `zoho_lead_${fonoCandado}` : ""
    if (kvKeyLead) {
      try {
        const { getKvValue } = await import("./supabase-persistence-v3")
        const existente = (await getKvValue(kvKeyLead)) || ""
        if (existente && !existente.startsWith("creando:")) {
          console.log(`[zoho-leads] candado: ${fonoCandado} ya tiene lead ${existente} — se reutiliza, no se duplica`)
          return { success: true, leadId: existente, entraATombola: false, ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL }
        }
        // CREACIÓN EN VUELO (anti-carrera, caso gemelos 56963008969 31-jul:
        // dos hitos crearon dos leads con 2 segundos de diferencia). Si otro
        // proceso marcó "creando:" hace <2 min, se espera a que cierre el
        // candado con el id real y se reutiliza; si no aparece, se sigue.
        if (existente.startsWith("creando:")) {
          const desde = Number(existente.slice(8)) || 0
          if (Date.now() - desde < 120_000) {
            for (let i = 0; i < 5; i++) {
              await new Promise((r) => setTimeout(r, 1200))
              const ahora = (await getKvValue(kvKeyLead).catch(() => "")) || ""
              if (ahora && !ahora.startsWith("creando:")) {
                console.log(`[zoho-leads] anti-carrera: otro proceso creó el lead ${ahora} para ${fonoCandado} — se reutiliza`)
                return { success: true, leadId: ahora, entraATombola: false, ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL }
              }
            }
          }
        }
        // Candado vacío ≠ lead inexistente: los teléfonos anteriores al
        // candado no tienen entrada en vic_kv (re-duplicados SYDA/Catalina,
        // noche del 30-31 jul). Fallback: buscar en Zoho y, si el lead ya
        // existe, reutilizarlo y cerrar el candado hacia adelante.
        const accessTokenDedup = await getZohoAccessToken()
        const apiDedup = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
        const resDedup = await fetch(
          `${apiDedup}/crm/v3/Leads/search?phone=${encodeURIComponent(fonoCandado)}&converted=both&per_page=3`,
          { headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}` }, cache: "no-store" },
        )
        if (resDedup.ok && resDedup.status !== 204) {
          const dataDedup = (await resDedup.json().catch(() => ({}))) as {
            data?: Array<{ id?: string; Converted_Deal?: { id?: string } | null; Owner?: { email?: string; name?: string } }>
          }
          const leadDedup = dataDedup?.data?.[0]
          const leadExistente = leadDedup?.id
          const dealConvertido = leadDedup?.Converted_Deal?.id
          // La dedup es de PROCESOS ABIERTOS (caso Aldo/Marfull, 31-jul): un
          // lead CONVERTIDO cuyo deal quedó en Cierre Perdido o Facturando es
          // OTRA negociación — NO se reutiliza, la creación sigue y el
          // re-contacto renace como lead nuevo (reglas 4 y 6). Con deal
          // ACTIVO sí se reutiliza, y se RE-NOTIFICA al dueño con una nota en
          // su deal (regla 5): el cliente volvió a pedir contacto y antes
          // nadie se enteraba.
          let reusar = Boolean(leadExistente)
          if (leadExistente && dealConvertido) {
            try {
              const gS = await fetch(`${apiDedup}/crm/v3/Deals/${dealConvertido}?fields=Stage`, {
                headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}` },
                cache: "no-store",
              })
              const stageDedup = gS.ok
                ? String(((await gS.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }).data?.[0]?.Stage || "")
                : ""
              if (/Cierre Perdido|8\. Facturando/.test(stageDedup)) {
                reusar = false
                console.log(`[zoho-leads] dedup: lead ${leadExistente} convertido con deal CERRADO (${stageDedup}) — renace lead nuevo (reglas 4/6)`)
              } else {
                await fetch(`${apiDedup}/crm/v3/Notes`, {
                  method: "POST",
                  headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}`, "Content-Type": "application/json" },
                  cache: "no-store",
                  body: JSON.stringify({
                    data: [{
                      Note_Title: "El cliente volvió a pedir contacto por WhatsApp",
                      Note_Content: `Vicky recibió una nueva solicitud de este cliente (+${fonoCandado}): ${(input.necesidad || "retomó la conversación").slice(0, 400)}. El deal es tuyo y no se creó ninguno nuevo (regla 5). Contactarlo a la brevedad.`,
                      Parent_Id: { module: { api_name: "Deals" }, id: dealConvertido },
                    }],
                  }),
                }).catch(() => {})
              }
            } catch { /* ante la duda, se reutiliza como antes */ }
          }
          if (leadExistente && reusar) {
            const { setKvValue } = await import("./supabase-persistence-v3")
            await setKvValue(kvKeyLead, String(leadExistente)).catch(() => {})
            console.log(`[zoho-leads] dedup por búsqueda: ${fonoCandado} ya tiene lead ${leadExistente} — se reutiliza y se cierra el candado`)
            return { success: true, leadId: String(leadExistente), entraATombola: false, ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL }
          }
        }
        // DEDUP POR EMAIL (regla marketing: teléfono Y email; escenario Lalo
        // 04-ago "el cliente también llenó formulario"): el lead del
        // formulario web trae su correo pero puede tener OTRO teléfono (o en
        // otro formato) — el dedup por fono no lo ve y nacía un doble. Si hay
        // lead SIN convertir con este email, se reutiliza, se cierra el
        // candado del fono hacia él y se le completa el teléfono si venía
        // vacío (aditivo — jamás pisa uno existente).
        const emailDedup = (input.email || "").trim()
        if (emailDedup) {
          const resEmail = await fetch(
            `${apiDedup}/crm/v3/Leads/search?email=${encodeURIComponent(emailDedup)}&converted=both&per_page=3`,
            { headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}` }, cache: "no-store" },
          )
          if (resEmail.ok && resEmail.status !== 204) {
            const dataEmail = (await resEmail.json().catch(() => ({}))) as {
              data?: Array<{
                id?: string
                Phone?: string
                Converted_Deal?: { id?: string } | null
                Converted_Account?: { id?: string } | null
                Converted_Contact?: { id?: string } | null
              }>
            }
            const leadEmail = (dataEmail?.data || []).find(
              (l) => !(l?.Converted_Deal?.id || l?.Converted_Account?.id || l?.Converted_Contact?.id),
            )
            if (leadEmail?.id) {
              const { setKvValue } = await import("./supabase-persistence-v3")
              await setKvValue(kvKeyLead, String(leadEmail.id)).catch(() => {})
              if (!String(leadEmail.Phone || "").trim()) {
                await fetch(`${apiDedup}/crm/v3/Leads`, {
                  method: "PUT",
                  headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}`, "Content-Type": "application/json" },
                  cache: "no-store",
                  body: JSON.stringify({ data: [{ id: leadEmail.id, Phone: `+${fonoCandado}` }] }),
                }).catch(() => {})
              }
              console.log(`[zoho-leads] dedup por email: ${emailDedup} ya tiene lead ${leadEmail.id} (formulario/otro fono) — se reutiliza`)
              return { success: true, leadId: String(leadEmail.id), entraATombola: false, ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL }
            }
          }
        }
        // DEDUP POR EMPRESA/NOMBRE (Lalo 21-ago, botón WhatsApp de las
        // landings CL): el pre-formulario crea un lead SIN teléfono (nombre,
        // apellido, correo corporativo, empresa) y el mensaje prellenado del
        // botón repite esos MISMOS textos ("Hola, soy Belén de Agroindustria
        // Valle Rojo Spa…") — así que cuando el chat dispara su hito, la
        // empresa/nombre calzan letra por letra con el lead del formulario.
        // Match determinista y acotado: lead SIN convertir + SIN teléfono +
        // creado hace ≤14 días con la MISMA empresa (o, en su defecto, mismo
        // nombre completo) → se ADOPTA: se le completa el fono y se cierra el
        // candado hacia él. Jamás toca leads con otro teléfono. Cuando el
        // formulario incorpore teléfono, el dedup por fono lo pilla antes y
        // este paso queda de respaldo.
        try {
          const desdeIso = new Date(Date.now() - 14 * 86400e3).toISOString()
          const candidatos: Array<{ id?: string; Phone?: string; Created_Time?: string }> = []
          const empresaDedup = sanitize(input.empresa, 200).trim()
          const nombreDedup = (input.nombre || "").trim()
          const criterios: string[] = []
          if (empresaDedup && !/^prospecto/i.test(empresaDedup)) {
            criterios.push(`(Company:equals:${empresaDedup.replace(/[(),]/g, " ").trim()})`)
          }
          if (nombreDedup && nombreDedup.includes(" ")) {
            const n = splitName(nombreDedup)
            if (n.firstName && n.lastName) {
              criterios.push(
                `((First_Name:equals:${n.firstName.replace(/[(),]/g, " ").trim()})and(Last_Name:equals:${n.lastName.replace(/[(),]/g, " ").trim()}))`,
              )
            }
          }
          for (const criteria of criterios) {
            const resCrit = await fetch(
              `${apiDedup}/crm/v3/Leads/search?criteria=${encodeURIComponent(criteria)}&converted=false&fields=id,Phone,Created_Time&per_page=5`,
              { headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}` }, cache: "no-store" },
            )
            if (resCrit.ok && resCrit.status !== 204) {
              const dataCrit = (await resCrit.json().catch(() => ({}))) as { data?: typeof candidatos }
              candidatos.push(...(dataCrit?.data || []))
            }
            if (candidatos.length) break // la empresa manda; el nombre es respaldo
          }
          const adoptable = candidatos.find(
            (l) => l?.id && !String(l.Phone || "").trim() && String(l.Created_Time || "") >= desdeIso,
          )
          if (adoptable?.id) {
            const { setKvValue } = await import("./supabase-persistence-v3")
            await setKvValue(kvKeyLead, String(adoptable.id)).catch(() => {})
            await fetch(`${apiDedup}/crm/v3/Leads`, {
              method: "PUT",
              headers: { Authorization: `Zoho-oauthtoken ${accessTokenDedup}`, "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({ data: [{ id: adoptable.id, Phone: `+${fonoCandado}` }] }),
            }).catch(() => {})
            console.log(
              `[zoho-leads] dedup por empresa/nombre: lead ${adoptable.id} del formulario (sin fono, ≤14d) adoptado para ${fonoCandado} — se le completa el teléfono`,
            )
            return { success: true, leadId: String(adoptable.id), entraATombola: false, ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL }
          }
        } catch { /* best-effort: si la búsqueda falla, la creación sigue */ }
        // Reservar el candado ANTES de crear: la ventana de carrera baja de
        // varios segundos (lo que tarda el POST) a milisegundos.
        const { setKvValue } = await import("./supabase-persistence-v3")
        await setKvValue(kvKeyLead, `creando:${Date.now()}`).catch(() => {})
      } catch { /* sin candado no se bloquea la creación */ }
    }
    const names = splitName(input.nombre)
    const transcript = buildTranscript(input.conversacion)

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    // Si hay reunión agendada → owner = host (ownerEmail resuelto).
    // Si NO → owner = Vicky SIEMPRE (tómbola), ignorando ZOHO_CRM_OWNER_ID.
    const resolvedOwnerId =
      (input.ownerId || "").trim() ||
      (input.ownerEmail ? await resolveOwnerId(input.ownerEmail, accessToken, apiDomain) : null)
    const ownerId = resolvedOwnerId || VICKY_OWNER_ID
    const entraATombola = !resolvedOwnerId

    const trabajadoresNum =
      typeof input.trabajadores === "number"
        ? input.trabajadores
        : parseInt(String(input.trabajadores || "").replace(/\D/g, ""))

    const record: Record<string, unknown> = {
      First_Name: sanitize(names.firstName, 100),
      Last_Name: sanitize(names.lastName, 100) || "Prospecto",
      Company: sanitize(input.empresa, 200) || "Prospecto WhatsApp",
      Canal: "WhatsApp",
      Lead_Source: getEnv("ZOHO_DEFAULT_LEAD_SOURCE") || "SEO",
      Owner: { id: ownerId },
      // Primera revisión = la atención de Vicky (regla Lalo 10-ago): un lead
      // inbound nace porque Vicky YA respondió la primera pregunta — el
      // tiempo de respuesta del equipo parte en 0, no cuando un humano abre
      // el lead días después (caso Ana María, cierre de julio: 4 leads con
      // miles de horas por esta brecha).
      Fecha_de_Primera_revision_Lead: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    }

    const email = (input.email || "").trim()
    if (email) record.Email = email
    // Teléfono: si el caller no lo pasó, cae al contacto de WhatsApp (siempre lo
    // hay en Vicky). Regla del equipo (jul-2026): ningún lead de Vicky sin fono.
    const phone = (input.telefono || "").trim() || (input.contactoWA || "").trim()
    if (phone) record.Phone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`
    // País/Territorio: deducidos del fono si el caller no los dio. Regla del
    // equipo (jul-2026): los leads deben llegar con territorio para que las
    // assignment rules los repartan (los sin territorio quedaban huérfanos).
    const digits = phone.replace(/\D/g, "")
    // Marcador de línea de los contactos LID ("CO.1594...", 25-ago GRANIPACK):
    // sin número real, el país lo dice el prefijo que puso el webhook.
    const marcaLinea = /^\s*(CL|CO|MX|PE)\./i
      .exec(String(input.telefono || input.contactoWA || ""))?.[1]
      ?.toUpperCase()
    const paisDeMarca =
      marcaLinea === "CL" ? "Chile" : marcaLinea === "CO" ? "Colombia" : marcaLinea === "MX" ? "México" : marcaLinea === "PE" ? "Perú" : ""
    const pais =
      sanitize(input.pais, 100) ||
      paisDeMarca ||
      (digits.startsWith("56") ? "Chile" : digits.startsWith("57") ? "Colombia" : "")
    if (pais) record.Country = pais
    if (digits.startsWith("56") || pais.toLowerCase() === "chile") record.Territorio = "Chile"
    else if (digits.startsWith("57") || pais.toLowerCase() === "colombia") record.Territorio = "Colombia"
    // México quedaba sin territorio y un default lo dejaba en "Chile" (caso
    // SYDA/Isauro): los +52 son México, siempre.
    else if (digits.startsWith("52") || pais.toLowerCase() === "méxico" || pais.toLowerCase() === "mexico") {
      record.Territorio = "México"
      if (!record.Country) record.Country = "México"
    }
    // Perú (Fase 1b, 05-ago): los +51 llevan Territorio "Perú" (picklist de
    // Zoho verificado — el valor existe). Sin esto, los leads de Vicky PE
    // quedaban sin territorio, invisibles para los filtros por país.
    else if (digits.startsWith("51") || pais.toLowerCase() === "perú" || pais.toLowerCase() === "peru") {
      record.Territorio = "Perú"
      if (!record.Country) record.Country = "Perú"
    }
    const ciudad = sanitize(input.ciudad, 100)
    if (ciudad) record.City = ciudad

    const productoSolucion = mapProductoSolucion(input.necesidad)
    if (productoSolucion) record.Producto_Soluci_n = productoSolucion

    const rangoEmpleados = mapRangoEmpleados(input.trabajadores)
    if (rangoEmpleados) record.Rango_de_Empleados = rangoEmpleados

    if (!isNaN(trabajadoresNum) && trabajadoresNum > 0) {
      record.N_Empleados_que_marcan = trabajadoresNum
    }

    record.Comentario = [
      `Necesidad: ${input.necesidad || ""}`,
      `Cargo: ${input.cargo || ""}`,
      `Trabajadores: ${input.trabajadores ?? ""}`,
      `Sistema actual: ${input.sistemaActual || ""}`,
      `Idioma: ${input.idioma || ""}`,
      `Reunión agendada: ${input.reunionAgendada === true ? "true" : input.reunionAgendada === false ? "false" : ""}`,
      `Preferencia horario: ${input.preferenciaHorario || ""}`,
      `Contacto WA: ${input.contactoWA || ""}`,
    ]
      .filter((line) => line.split(":")[1]?.trim())
      .join("\n")
      .trim()

    const createResponse = await fetch(`${apiDomain}/crm/v2/${moduleName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      // "blueprint" explícito (21-ago, reclamo de las SDR vía Lalo): al listar
      // triggers, lo no listado queda APAGADO — con solo ["workflow"] los
      // leads nacían sin blueprint y las SDR no veían la banda de etapas.
      body: JSON.stringify({ data: [record], trigger: ["workflow", "blueprint"] }),
      cache: "no-store",
    })

    const createBody = (await createResponse.json()) as {
      data?: Array<{ status?: string; details?: { id?: string }; message?: string; code?: string }>
    }
    const status = createBody?.data?.[0]?.status || ""
    const details = createBody?.data?.[0]?.details || {}
    const leadId = details?.id || null

    if (!createResponse.ok || status !== "success" || !leadId) {
      const errMsg =
        createBody?.data?.[0]?.message ||
        createBody?.data?.[0]?.code ||
        `Zoho devolvió status ${createResponse.status}`
      console.error("[zoho-leads] Error creando Lead:", JSON.stringify(createBody).slice(0, 500))
      return { success: false, error: errMsg }
    }

    // Cerrar el candado apenas existe el lead (antes de las notas: lo que
    // importa es que un segundo intento inmediato ya lo encuentre).
    if (kvKeyLead) {
      import("./supabase-persistence-v3")
        .then(({ setKvValue }) => setKvValue(kvKeyLead, leadId))
        .catch(() => {})
    }
    // Y el vínculo DURABLE en la conversación (Lalo 15-ago): el candado kv
    // es anti-duplicación, no un índice — el cruce conversación↔CRM tiene que
    // vivir en la conversación misma.
    if (fonoCandado) {
      import("./supabase-persistence-v3")
        .then(({ vincularZohoAConversacion }) => vincularZohoAConversacion(fonoCandado, { leadId }))
        .catch(() => {})
      import("./registro-zoho")
        .then(({ registrarEnZoho }) =>
          registrarEnZoho(fonoCandado, [{ modulo: "Leads", id: leadId }], { origen: "zoho-leads" }),
        )
        .catch(() => {})
    }
    // El registro queda marcado con el chat del que nació.
    if (fonoCandado) {
      import("./enlace-conversacion")
        .then(({ marcarRegistroConChat }) => marcarRegistroConChat("Leads", leadId, fonoCandado))
        .catch(() => {})
    }

    if (transcript) {
      fetch(`${apiDomain}/crm/v2/Notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        body: JSON.stringify({
          data: [
            {
              Note_Title: "Transcripción WhatsApp Vicky",
              Note_Content: transcript,
              Parent_Id: leadId,
              $se_module: moduleName,
            },
          ],
        }),
        cache: "no-store",
      }).catch(() => {})
    }

    // VISIBILIDAD INTER-CANAL (caso Ingesub, 20-jul): si el contacto además
    // tiene un lead abierto de un HUMANO (formulario en paralelo), Vicky sigue
    // atendiendo (el cliente eligió el canal) pero TODOS quedan avisados desde
    // el minuto uno — nota cruzada en ambos leads. Solo aplica a leads que
    // entran a la tómbola (los de reunión ya van dirigidos a un humano).
    if (entraATombola) {
      const humano = await buscarLeadAbiertoDeOtroDueno(input.telefono, input.email).catch(() => null)
      if (humano && humano.id !== leadId) {
        const cuando = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })
        agregarNotaLead(
          humano.id,
          "Este contacto está conversando con Vicky por WhatsApp",
          `Aviso automático (${cuando}): ${input.nombre || "el contacto"} (${input.telefono || ""}${input.email ? ` · ${input.email}` : ""}) inició una conversación comercial con Vicky por WhatsApp y ella lo está atendiendo. Lead de Vicky: ${leadId}. Coordinar para no vender en paralelo (caso Ingesub 20-jul).`,
        ).catch(() => {})
        agregarNotaLead(
          leadId,
          "Contacto con proceso humano paralelo",
          `Aviso automático (${cuando}): este contacto ya tiene un lead abierto trabajado por ${humano.ownerNombre} (${humano.ownerEmail}), estado "${humano.status}". Vicky sigue atendiendo la conversación, pero el equipo debe coordinar quién cierra.`,
        ).catch(() => {})
        console.warn(
          `[zoho-leads] VENTA PARALELA detectada: ${input.telefono || input.email} tiene lead abierto de ${humano.ownerNombre} — notas cruzadas creadas`,
        )
      }
    }

    return {
      success: true,
      leadId,
      entraATombola,
      ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado en createZohoLead"
    console.error("[zoho-leads] Exception:", error)
    return { success: false, error: message }
  }
}
