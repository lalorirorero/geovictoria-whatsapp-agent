/**
 * Sincronización determinista Zoho CRM ← hitos de la conversación de Vicky
 * (Lalo, 30-jul-2026). Regla de marketing: NUNCA crear deals directos — todo
 * deal nace de un LEAD CONVERTIDO. Diccionario de hitos → etapa (piso):
 *
 *   intención comercial        → deal nace en "1. Trato Creado"
 *   reunión realizada          → piso "2. Primera Reunion Realizada"
 *   discovery sin preform      → piso "3. En Levantamiento"
 *   preform visto en adelante  → piso "4. Propuesta Enviada / En Negociación"
 *   aceptada o pagada          → piso "6. Listo para Cierre"
 *   onboarding terminado       → piso "7. Implementando"
 *
 * EL STAGE NUNCA RETROCEDE: cada hito es un PISO; el deal sube a
 * max(etapa actual, piso) vía transiciones Blueprint (cada deal tiene SU
 * blueprint — hay dos en CL — así que siempre GET sus transitions primero, y
 * los campos mandatorios van DENTRO del data del PUT).
 *
 * EL DATO PUEDE NACER EN DOS LADOS (por eso la resolución va primero):
 *   - ENTRANTE: la conversación parte en WhatsApp → no existe nada en Zoho →
 *     se crea el lead y se convierte con deal en el piso del hito.
 *   - SALIENTE: el lead nació en el CRM y NOSOTROS iniciamos la conversación
 *     (asignación del lead) → el lead YA existe → se reutiliza tal cual, se
 *     respeta a su dueño y solo se avanza (status/etapa hacia arriba).
 *
 * Reglas duras:
 *   - Lead de un dueño HUMANO (SDR) → no se convierte ni se toca su gestión:
 *     solo sube Lead_Status (nunca baja) y queda nota. (Regla anti-pisoteo.)
 *   - Contacto existente sin lead (cliente actual) → no se crea nada (evita
 *     duplicar personas); se registra para revisión.
 *   - Teléfonos de prueba (VICKY_TELEFONOS_PRUEBA) → no crean registros.
 *   - Todo best-effort: un fallo acá JAMÁS afecta el turno de la conversación.
 *
 * Flag: VICKY_CRM_HITOS_ENABLED (apagado por defecto).
 */

export type Hito =
  | "intencion"
  | "reunion_realizada"
  | "discovery"
  | "preform"
  | "aceptada"
  | "onboarding_listo"

/** BIBLIA (VB 12-ago) — DEAL SOLO CON LA FORMAL: en CHILE los hitos
 * PRE-FORMALES dejan LEAD (calificado si corresponde) y el deal nace
 * únicamente con la cotización formal (lo crea la emisión del cotizador,
 * que exige RUT). Los hitos POST-formales (aceptada, onboarding_listo)
 * conservan la conversión: a esa altura la formal ya existió y un deal
 * faltante es un hoyo de datos que sí se repara. CO/MX/PE conservan sus
 * reglas propias. Rollback sin deploy: VICKY_DEAL_CLASICO=1. */
const HITOS_PRE_FORMALES: ReadonlySet<Hito> = new Set([
  "intencion",
  "discovery",
  "preform",
  "reunion_realizada",
])

function dealSoloConFormal(territorio: string | null, hito: Hito): boolean {
  if ((process.env.VICKY_DEAL_CLASICO || "").trim() === "1") return false
  return territorio === "Chile" && HITOS_PRE_FORMALES.has(hito)
}

/** ESCALERA 18-ago (Lalo): "si hay intención comercial y RUT debemos crear
 * deal y pasarlo a la tómbola de deals". Es la EXCEPCIÓN al deal-solo-formal,
 * SOLO sobre el umbral de venta autónoma ("el flujo ≤20 no cambia en nada"):
 * con RUT y dotación >20 el deal nace en el hito y la tómbola de deals lo
 * sortea al acto. Enterprise (>300) también entra por aquí — lo resuelven las
 * entradas de la propia regla "Tómbola Deals 2026 Chile" (Lalo 18-ago).
 * Sin RUT la escalera de leads sigue igual: calificado → tómbola de leads de
 * ejecutivos; sin calificar → SDR (dejarLeadPreFormal / reloj de 24h). */
function escaleraDealConRut(
  territorio: string | null,
  lead: { rut?: string; empleados?: number },
  datos: { rut?: string; empleados?: number },
): boolean {
  if (territorio !== "Chile") return false
  const n = datos.empleados || lead.empleados || 0
  const rut = String(datos.rut || lead.rut || "").trim()
  return Boolean(rut) && n > 20
}

/** Piso de etapa del deal que garantiza cada hito. */
export const PISO_POR_HITO: Record<Hito, string> = {
  intencion: "1. Trato Creado",
  reunion_realizada: "2. Primera Reunion Realizada",
  discovery: "3. En Levantamiento",
  preform: "4. Propuesta Enviada / En Negociación",
  aceptada: "6. Listo para Cierre",
  onboarding_listo: "7. Implementando",
}

/**
 * Orden del pipeline para la regla "nunca retrocede". "Cierre Perdido" es
 * terminal: un deal perdido no se resucita automáticamente.
 */
const ORDEN_ETAPA: Record<string, number> = {
  "1. Trato Creado": 1,
  "2. Primera Reunion Realizada": 2,
  "3. En Levantamiento": 3,
  "4. Propuesta Enviada / En Negociación": 4,
  "5. Piloto": 5,
  "6. Listo para Cierre": 6,
  "7. Implementando": 7,
  "8. Facturando": 8,
}

/**
 * Decide a qué etapa debe moverse un deal dado su etapa actual y el piso del
 * hito. null = no tocar (ya está en o sobre el piso, o está en un estado
 * fuera del pipeline como "Cierre Perdido").
 */
export function etapaObjetivo(actual: string, piso: string, revivirPerdido = false): string | null {
  const p = ORDEN_ETAPA[piso]
  if (!p) return null
  // CAMPAÑA DE REACTIVACIÓN (Lalo 03-sep): un deal en Cierre Perdido SÍ vuelve
  // al pipeline, pero SOLO para los contactos marcados de la campaña — el
  // resto sigue con la regla de siempre (perdido es terminal, el re-contacto
  // renace como lead nuevo). El dueño NO cambia: revivir es del deal, no de
  // su propiedad.
  if (revivirPerdido && actual === "Cierre Perdido") return piso
  const a = ORDEN_ETAPA[actual]
  if (!a) return null
  return a < p ? piso : null
}

/**
 * ¿Este contacto pertenece a la campaña de reactivación? La marca la siembra
 * la campaña (vic_kv `reactivar_deal_<fono>` = id del deal perdido) y es lo
 * único que habilita revivir un Cierre Perdido. Sin marca, nada cambia.
 */
export async function dealAReactivar(contact: string): Promise<string | null> {
  const clean = (contact || "").replace(/\D/g, "")
  if (!clean) return null
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const v = (await getKvValue(`reactivar_deal_${clean}`)) || ""
    return /^\d{6,}$/.test(v.trim()) ? v.trim() : null
  } catch {
    return null
  }
}

/**
 * Hito que implica el ÉXITO de cada tool de Vicky. El preform es
 * cotizar_referencial (el precio mostrado en el chat); las tools de agenda y
 * callback demuestran intención pero no precio; el comprobante de
 * transferencia es aceptación de la cotización.
 */
export const HITO_POR_TOOL: Record<string, Hito> = {
  cotizar_referencial: "preform",
  consultar_descuento_referencial: "preform",
  consultar_siguiente_descuento: "preform",
  aplicar_siguiente_descuento: "preform",
  actualizar_cotizacion: "preform",
  enviar_cotizacion_whatsapp: "preform",
  generar_link_cotizadora: "intencion",
  consultar_disponibilidad_horario: "intencion",
  agendar_reunion: "intencion",
  reagendar_reunion: "intencion",
  registrar_solicitud_callback: "intencion",
  registrar_comprobante_transferencia: "aceptada",
}

/**
 * Datos frescos que la conversación entrega en el MISMO acto del hito (Lalo
 * 30-jul: "si aparece la empresa, actualizarla; si aparece un correo,
 * actualizarlo"). La fuente es el INPUT de la tool: cuando Vicky llama
 * generar_link_cotizadora ya extrajo empresa/RUT/correo del chat — no hay que
 * re-minarlos. Se aplican SOLO sobre campos vacíos o placeholder (regla
 * anti-pisoteo: jamás sobreescribir gestión humana).
 */
export type DatosConversacion = {
  nombre?: string
  empresa?: string
  email?: string
  rut?: string
  empleados?: number
  /** Traspaso a humano con RUT y calificado (Lalo 08-sep: "si hay RUT pasa a
   * deal y a tómbola de telemarketing"): el deal nace aunque la dotación sea
   * ≤20 — la excepción es SOLO para entregas a persona, no para el flujo
   * autónomo ≤20 (ese sigue: deal con la formal). */
  forzarDeal?: boolean
}

/**
 * Número de empleados desde lo que DIJO el cliente o trajo el formulario: los
 * >50 llegan casi siempre como texto ("entre 200 y 400", "200 - 499
 * empleados", "300 aprox", "más de 100") y el Number() estricto los
 * descartaba — el deal nacía con N=1 y la tómbola de deals lo sorteaba en el
 * tramo SMB (casos VDZ/Bodegas San Francisco/VITAPRO, orden de Lalo 06-ago:
 * los >50 deben caer SÍ O SÍ en su tramo real de la regla). Regla: se toma el
 * PISO del rango (primer número); "más de X" cuenta como X+1.
 */
export function parseEmpleados(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v)
  const s = String(v ?? "").trim()
  if (!s) return undefined
  const m = s.match(/\d[\d.]*/)
  if (!m) return undefined
  const n = Math.round(Number(m[0].replace(/\.(?=\d{3}\b)/g, "")))
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return undefined
  const masDe = /(m[áa]s\s+de|sobre|arriba\s+de|\+\s*$|superior(?:es)?\s+a)/i.test(
    s.slice(0, (m.index || 0) + m[0].length + 2),
  )
  return masDe ? n + 1 : n
}

export function datosDeToolInput(toolName: string, input: unknown): DatosConversacion {
  const i = (input || {}) as Record<string, unknown>
  const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  switch (toolName) {
    case "cotizar_referencial":
      return { empleados: parseEmpleados(i.userCount) }
    case "generar_link_cotizadora":
    case "actualizar_cotizacion":
      return {
        empresa: txt(i.empresa),
        email: txt(i.contactoEmail),
        rut: txt(i.rutEmpresa),
        nombre: txt(i.contactoNombre) || txt(i.contacto),
      }
    case "agendar_reunion":
    case "reagendar_reunion":
      return {
        nombre: txt(i.prospectName),
        email: txt(i.prospectEmail),
        empresa: txt(i.empresa),
        empleados: parseEmpleados(i.trabajadores),
      }
    case "registrar_solicitud_callback":
      return {
        nombre: txt(i.nombre),
        empresa: txt(i.empresa),
        email: txt(i.email),
        empleados: parseEmpleados(i.trabajadores),
      }
    // Derivación >50 (Lalo 06-ago): el lead/deal debe nacer con TODOS los
    // datos para caer en el tramo correcto de la tómbola de deals. Flujo 21+
    // (Lalo 13-ago): el dato pedido es el RUT — la razón social sale del
    // padrón SII (se resuelve en sincronizarHitoCrm) y el deal nace con RUT.
    case "derivar_a_soporte":
      return {
        nombre: txt(i.nombre),
        empresa: txt(i.empresa),
        email: txt(i.email),
        rut: txt(i.rutEmpresa),
        empleados: parseEmpleados(i.trabajadores),
      }
    default:
      return {}
  }
}

/** Company/nombre de relleno que cuentan como "vacío" para el enriquecimiento. */
function esPlaceholder(valor: string): boolean {
  return !valor || /por identificar|prospecto whatsapp|no identificado|sin empresa|tu empresa/i.test(valor)
}

/** Orden de Lead_Status para subir sin pisar (nunca hacia abajo). */
const ORDEN_LEAD_STATUS: Record<string, number> = {
  "1. No contactado": 1,
  "2. Intento de contacto": 2,
  "3. Contactado": 3,
  "4. Calificado": 4,
}

/** Lead_Status mínimo que implica cada hito (todos son conversación activa). */
const STATUS_POR_HITO: Partial<Record<Hito, string>> = {
  intencion: "4. Calificado",
  discovery: "4. Calificado",
  preform: "4. Calificado",
  aceptada: "4. Calificado",
}

const VICKY_OWNER_ID = "3525045000484500876"
// Dueños "del bot": el usuario Vicky y los interinos por país. Ninguno cuenta
// como gestión humana — son marcadores de "sin dueño real" (fix gemelos
// 03-ago: heredarlos dejaba el deal fuera de la tómbola).
const INTERINOS = new Set([
  VICKY_OWNER_ID,
  "3525045000000200013", // GeoVictoria Admin (info@) — dueño default de los
  // leads del formulario web: heredarlo dejaba deals con dueño fantasma que
  // nadie atiende y fuera de Vicky-interina/tómbola (hallazgo Lalo 07-ago:
  // 4 deals del Admin, 2 nacidos ese mismo día).
  // Eddyluz (3525045000000211283) SALIÓ de esta lista el 03-sep por orden de
  // Lalo: "ella no es interina, ni Anderson". Venía del relevo del 27-jul,
  // cuando todo lo nuevo nacía a su nombre y ese marcador servía para saber
  // que el deal aún no tenía dueño real. Hace tiempo que dejó de ser cierto:
  // es una ejecutiva más y su cartera se respeta como la de cualquiera. Con
  // ella acá, cualquier hito con sorteoInmediato podía QUITARLE un deal suyo.
  "3525045000203758005", // Gordillo (interino CO)
  "3525045000308323003", // Yahel (interina MX)
])

// SDRs Inbound de Colombia (acuerdo equipo CO 04-ago: Gordillo/Valeria): en CO
// el LEAD sin cotización lo posee el SDR (Galindo y cía), y al emitir la formal
// el DEAL pasa al EJECUTIVO (Gordillo). Por eso un lead de un SDR CO NO se
// hereda al deal: es un handoff SDR→ejecutivo, no gestión que preservar.
const SDR_CO_IDS = new Set([
  "3525045000613817111", // Eddy Galindo
  "3525045000619732095", // Guerrero
  "3525045000639899035", // Quiroga
])

/** ¿El dueño del lead es un HUMANO REAL cuya gestión se hereda al deal? No lo
 * son los interinos ni —en Colombia— los SDR (esos entregan el deal al
 * ejecutivo al cotizar). */
function heredaGestionAlDeal(ownerId: string, territorio: string): boolean {
  if (!ownerId || INTERINOS.has(ownerId)) return false
  if (territorio === "Colombia" && SDR_CO_IDS.has(ownerId)) return false
  return true
}
const HOY_MAS_30 = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

function habilitado(): boolean {
  return getEnv("VICKY_CRM_HITOS_ENABLED") === "on"
}

/** Teléfonos internos de prueba: jamás crean registros (caso HuelleroCompany). */
function esTelefonoDePrueba(contact: string): boolean {
  const lista = getEnv("VICKY_TELEFONOS_PRUEBA")
    .split(",")
    .map((t) => t.replace(/\D/g, ""))
    .filter(Boolean)
  const clean = (contact || "").replace(/\D/g, "")
  return lista.includes(clean)
}

function territorioDeContacto(contact: string): "Chile" | "Colombia" | "México" | "Perú" | null {
  // Marcador de línea (25-ago, caso GRANIPACK): los contactos LID de WhatsApp
  // (número real oculto por Meta) llegan como "CO.1594..." — el webhook del
  // país los prefija. Sin esto el LID no calza con ningún prefijo telefónico,
  // territorioDeContacto devolvía null y el deal de un colombiano caía al
  // default CHILE (Territorio, UF y tómbola CL — terminó sorteado a Grey).
  const marca = /^\s*(CL|CO|MX|PE)\./i.exec(String(contact || ""))?.[1]?.toUpperCase()
  if (marca === "CL") return "Chile"
  if (marca === "CO") return "Colombia"
  if (marca === "MX") return "México"
  if (marca === "PE") return "Perú"
  const c = (contact || "").replace(/\D/g, "")
  if (c.startsWith("56")) return "Chile"
  if (c.startsWith("57")) return "Colombia"
  if (c.startsWith("52")) return "México"
  // Perú (Fase 1b, 05-ago): sin este caso, un +51 caía al default "Chile" en
  // la creación del deal (Territorio y moneda equivocados).
  if (c.startsWith("51")) return "Perú"
  return null
}

type ZohoHeaders = { Authorization: string; "Content-Type": string }

async function zohoHeaders(): Promise<{ h: ZohoHeaders; api: string }> {
  // Import dinámico: mantiene este módulo importable por los tests puros
  // (node --test sin resolución de extensiones de Next).
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  return {
    h: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    api: getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com",
  }
}

type LeadEncontrado = {
  id: string
  ownerId: string
  status: string
  company: string
  empleados: number
  email: string
  lastName: string
  rut: string
  ultimaActividad: string
  /** Motivo del descarte cuando Lead_Status = "No Calificado" (excepción
   * terminal 21-ago: ciertos motivos jamás se reactivan ni renacen). */
  motivoNoCalificado: string
  convertido: boolean
  dealId: string | null
  contactId: string | null
}

/**
 * RESOLUCIÓN por teléfono — el corazón de los dos orígenes del dato. Busca en
 * Leads (convertidos incluidos) y devuelve lo que hay; si no hay lead, mira
 * Contacts para detectar clientes actuales.
 */
async function resolverPorTelefono(contact: string): Promise<
  | { tipo: "lead"; lead: LeadEncontrado }
  | { tipo: "contacto_sin_lead"; contactId: string }
  | { tipo: "nada" }
> {
  const { h, api } = await zohoHeaders()
  const fono = contact.replace(/\D/g, "")
  // Candado vic_kv primero: el search de Zoho tarda ~2 min en indexar leads
  // nuevos y esa ventana producía duplicados (caso SYDA 28-jul). El candado
  // apunta directo al id, con GET inmediato y sin lag.
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const idCandado = (await getKvValue(`zoho_lead_${fono}`)) || ""
    // "creando:<ts>" = reserva anti-carrera de createZohoLead, no un id.
    if (idCandado && !idCandado.startsWith("creando:")) {
      const rDirecto = await fetch(
        `${api}/crm/v3/Leads/${idCandado}?fields=Owner,Lead_Status,Motivo_No_calificado,Company,N_Empleados_que_marcan,Email,Last_Name,RUT_Empresa,Last_Activity_Time,Converted_Deal,Converted_Contact,Converted_Account`,
        { headers: h, cache: "no-store" },
      )
      if (rDirecto.ok) {
        const l = ((await rDirecto.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0]
        if (l?.id) {
          const g = (k: string) => (l[k] as { id?: string } | null)?.id
          return {
            tipo: "lead",
            lead: {
              id: String(l.id),
              ownerId: String((l.Owner as { id?: string })?.id || ""),
              status: String(l.Lead_Status || ""),
              company: String(l.Company || ""),
              empleados: Number(l.N_Empleados_que_marcan) || 0,
              email: String(l.Email || ""),
              lastName: String(l.Last_Name || ""),
              rut: String(l.RUT_Empresa || ""),
              ultimaActividad: String(l.Last_Activity_Time || ""),
              motivoNoCalificado: String(l.Motivo_No_calificado || ""),
              convertido: Boolean(g("Converted_Account") || g("Converted_Contact") || g("Converted_Deal")),
              dealId: g("Converted_Deal") ? String(g("Converted_Deal")) : null,
              contactId: g("Converted_Contact") ? String(g("Converted_Contact")) : null,
            },
          }
        }
      }
    }
  } catch { /* sin candado, sigue el search normal */ }
  const res = await fetch(
    `${api}/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=5`,
    { headers: h, cache: "no-store" },
  )
  if (res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{
        id?: string
        Owner?: { id?: string }
        Lead_Status?: string
        Motivo_No_calificado?: string
        Company?: string
        N_Empleados_que_marcan?: number
        Email?: string
        Last_Name?: string
        RUT_Empresa?: string
        Last_Activity_Time?: string
        Converted_Deal?: { id?: string } | null
        Converted_Contact?: { id?: string } | null
        Converted_Account?: { id?: string } | null
      }>
    }
    const l = data?.data?.[0]
    if (l?.id) {
      const convertido = Boolean(l.Converted_Account?.id || l.Converted_Contact?.id || l.Converted_Deal?.id)
      return {
        tipo: "lead",
        lead: {
          id: String(l.id),
          ownerId: String(l.Owner?.id || ""),
          status: String(l.Lead_Status || ""),
          company: String(l.Company || ""),
          empleados: Number(l.N_Empleados_que_marcan) || 0,
          email: String(l.Email || ""),
          lastName: String(l.Last_Name || ""),
          rut: String(l.RUT_Empresa || ""),
          ultimaActividad: String(l.Last_Activity_Time || ""),
          motivoNoCalificado: String(l.Motivo_No_calificado || ""),
          convertido,
          dealId: l.Converted_Deal?.id ? String(l.Converted_Deal.id) : null,
          contactId: l.Converted_Contact?.id ? String(l.Converted_Contact.id) : null,
        },
      }
    }
  }
  const resC = await fetch(
    `${api}/crm/v3/Contacts/search?phone=${encodeURIComponent(fono)}&per_page=2`,
    { headers: h, cache: "no-store" },
  )
  if (resC.ok && resC.status !== 204) {
    const data = (await resC.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }
    if (data?.data?.[0]?.id) return { tipo: "contacto_sin_lead", contactId: String(data.data[0].id) }
  }
  return { tipo: "nada" }
}

/** Deal vivo del contacto (para leads convertidos sin Converted_Deal). */
async function dealVivoDelContacto(contactId: string): Promise<{ id: string; stage: string } | null> {
  const { h, api } = await zohoHeaders()
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: h,
    cache: "no-store",
    body: JSON.stringify({
      select_query: `select id, Stage from Deals where Contact_Name = ${contactId} and Stage != 'Cierre Perdido' order by Modified_Time desc limit 1`,
    }),
  })
  if (!res.ok || res.status === 204) return null
  const text = await res.text().catch(() => "")
  if (!text.trim()) return null
  try {
    const d = JSON.parse(text) as { data?: Array<{ id: string; Stage: string }> }
    return d?.data?.[0] ? { id: d.data[0].id, stage: d.data[0].Stage } : null
  } catch {
    return null
  }
}

/**
 * Reglas de re-contacto de Dave (doc Proceso de Gestión de Leads, 30-jul):
 * encendible por env VICKY_REGLAS_RECONTACTO_ENABLED=on o por vic_kv
 * `reglas_recontacto_enabled`=on (encendido/apagado al instante sin deploy,
 * mismo patrón que traspaso_v2_enabled).
 */
async function reglasRecontactoActivas(): Promise<boolean> {
  if (getEnv("VICKY_REGLAS_RECONTACTO_ENABLED") === "on") return true
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    return ((await getKvValue("reglas_recontacto_enabled")) || "").trim() === "on"
  } catch {
    return false
  }
}

/**
 * Candado CRUZADO hito↔cotización (fix duplicados 04-ago: Lotus Pet, CYE
 * Clima, Spacio Creativo, Distribuidora MV, Artespectáculo). Hay DOS puertas
 * que crean deals para el mismo teléfono — este módulo (por hito de
 * conversación) y create-from-vicky en el cotizador (por emisión de la
 * formal) — y no se veían entre sí: el índice de búsqueda de Zoho tarda en
 * reflejar registros de hace segundos, así que cada puerta creaba su propio
 * deal (11 segundos de diferencia en Lotus Pet). Ambas escriben en vic_kv
 * `deal_fono_<fono>` APENAS su deal existe y consultan ANTES de crear: la
 * que llega segunda REUSA ese deal (le sube el piso) en vez de duplicarlo.
 * TTL 6 h — pasada la ventana, la búsqueda normal de Zoho ya ve todo.
 */
const DEAL_KV_TTL_MS = 6 * 60 * 60 * 1000

async function dealActivoEnKv(fono: string): Promise<string | null> {
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const leer = async (): Promise<{ at?: string; dealId?: string; creando?: boolean } | null> => {
      const raw = await getKvValue(`deal_fono_${fono}`)
      return raw ? (JSON.parse(raw) as { at?: string; dealId?: string; creando?: boolean }) : null
    }
    let v = await leer()
    if (!v?.at || Date.now() - Date.parse(v.at) > DEAL_KV_TTL_MS) return null
    // Marca "creando" (anti-carrera 25-ago, gemelos Quilodrán): la otra puerta
    // está pariendo el deal AHORA MISMO — esperar su id real y reusarlo.
    if (!v.dealId && v.creando && Date.now() - Date.parse(v.at) < 120_000) {
      for (let i = 0; i < 3 && !v?.dealId; i++) {
        await new Promise((r) => setTimeout(r, 5000))
        v = await leer()
      }
    }
    return v?.dealId ? String(v.dealId) : null
  } catch {
    return null
  }
}

/** Reserva la creación del deal del fono (marca "creando") ANTES de crear.
 * false = otra puerta ya tiene deal o reserva vigente → re-consultar y REUSAR. */
async function reservarDealEnKv(fono: string, origen: string): Promise<boolean> {
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const raw = await getKvValue(`deal_fono_${fono}`)
    if (raw) {
      const v = JSON.parse(raw) as { at?: string; dealId?: string; creando?: boolean }
      if (v?.at && Date.now() - Date.parse(v.at) < DEAL_KV_TTL_MS) {
        if (v.dealId) return false
        if (v.creando && Date.now() - Date.parse(v.at) < 120_000) return false
      }
    }
    await setKvValue(`deal_fono_${fono}`, JSON.stringify({ at: new Date().toISOString(), creando: true, origen }))
    return true
  } catch {
    return true // fail-open: mejor un posible gemelo que un hito perdido
  }
}

async function registrarDealEnKv(fono: string, dealId: string, origen: string): Promise<void> {
  try {
    const { setKvValue } = await import("./supabase-persistence-v3")
    await setKvValue(
      `deal_fono_${fono}`,
      JSON.stringify({ at: new Date().toISOString(), dealId, origen }),
    )
  } catch {
    /* best-effort */
  }
}

/**
 * Enriquecimiento ADITIVO del lead con los datos frescos de la conversación:
 * solo campos vacíos o placeholder — jamás pisa un dato existente (gestión de
 * SDR incluida). Devuelve el lead con los valores efectivos post-update para
 * que la conversión use la empresa/empleados reales.
 */
async function enriquecerLead(lead: LeadEncontrado, datos: DatosConversacion): Promise<LeadEncontrado> {
  const campos: Record<string, unknown> = {}
  if (datos.empresa && esPlaceholder(lead.company)) campos.Company = datos.empresa.slice(0, 200)
  if (datos.email && !lead.email) campos.Email = datos.email
  if (datos.rut && !lead.rut) campos.RUT_Empresa = datos.rut
  if (datos.empleados && !lead.empleados) campos.N_Empleados_que_marcan = datos.empleados
  if (datos.nombre && esPlaceholder(lead.lastName)) {
    const partes = datos.nombre.trim().split(/\s+/)
    campos.Last_Name = partes.length > 1 ? partes.slice(-1)[0] : partes[0]
    if (partes.length > 1) campos.First_Name = partes.slice(0, -1).join(" ")
  }
  if (!Object.keys(campos).length) return lead
  try {
    const { h, api } = await zohoHeaders()
    const r = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: lead.id, ...campos }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const d = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
    if (d?.data?.[0]?.code === "SUCCESS") {
      console.log(`[crm-hitos] lead ${lead.id} enriquecido: ${Object.keys(campos).join(", ")}`)
      return {
        ...lead,
        company: (campos.Company as string) || lead.company,
        email: (campos.Email as string) || lead.email,
        rut: (campos.RUT_Empresa as string) || lead.rut,
        empleados: (campos.N_Empleados_que_marcan as number) || lead.empleados,
        lastName: (campos.Last_Name as string) || lead.lastName,
      }
    }
  } catch (e) {
    console.warn(`[crm-hitos] enriquecer ${lead.id} falló:`, e instanceof Error ? e.message : e)
  }
  return lead
}

/**
 * Sube el Lead_Status al piso del hito (nunca hacia abajo, nunca pisa un
 * status mayor puesto por un SDR).
 */
async function subirLeadStatus(lead: LeadEncontrado, hito: Hito): Promise<void> {
  const objetivo = STATUS_POR_HITO[hito]
  if (!objetivo) return
  const actual = ORDEN_LEAD_STATUS[lead.status] || 0
  const meta = ORDEN_LEAD_STATUS[objetivo] || 0
  if (actual >= meta) return
  const { updateZohoLeadStatus } = await import("./zoho-leads")
  const r = await updateZohoLeadStatus(lead.id, objetivo)
  if (!r.success) console.warn(`[crm-hitos] lead ${lead.id} status→${objetivo} falló: ${r.error}`)
}

/**
 * IDENTIDAD COMERCIAL mínima para crear DEAL y CUENTA (exigencia del equipo
 * comercial, Lalo 31-jul): nombre de empresa real o RUT. Sin identidad, el
 * hito queda registrado en el LEAD (status + nota + transcripción) y la
 * conversión espera al dato — que suele llegar uno o dos mensajes después
 * (el prompt ahora pregunta la empresa en la calificación). Mata de raíz los
 * deals "Prospecto WhatsApp" y la cuenta compartida donde convergían todos
 * los anónimos (7 deals de 6 empresas distintas bajo una misma cuenta).
 */
function tieneIdentidadComercial(lead: LeadEncontrado, datos: DatosConversacion): boolean {
  const empresa = [datos.empresa, lead.company].find((v) => v && !esPlaceholder(v))
  return Boolean(empresa || datos.rut || lead.rut)
}

/** Regla de asignación de Deals en Zoho (Lalo, 31-jul): TODO deal que Vicky
 * crea sin dueño humano heredado pasa por la tómbola del equipo — la regla
 * "Tómbola Deals 2026 Chile" (lar_id en el PUT). CO/MX aún sin regla (se
 * suman por env). Si la regla falla, el deal conserva el interino del país:
 * jamás queda en la bandeja de nadie. */
const TOMBOLA_DEALS_POR_TERRITORIO: Record<string, string> = {
  Chile: (process.env.VICKY_PTV_TOMBOLA_DEALS_CL || "3525045000595568541").trim(),
  Colombia: (process.env.VICKY_PTV_TOMBOLA_DEALS_CO || "").trim(),
  "México": (process.env.VICKY_PTV_TOMBOLA_DEALS_MX || "").trim(),
}

/** Notificación de traspaso (Lalo 31-jul): tras el sorteo, el template
 * "Traspaso Deal Global 2024" sale al dueño sorteado con copia a Victoria
 * Luna — la misma alerta del workflow de Zoho, gatillada por API porque el
 * sorteo ocurre DESPUÉS del create (el workflow on-create no la ve). */
const TPL_TRASPASO_DEAL = (process.env.VICKY_TPL_TRASPASO_DEAL || "3525045000389574614").trim()
const CC_TRASPASO_DEAL = (process.env.VICKY_TRASPASO_CC || "vluna@geovictoria.com").trim()

export async function notificarTraspasoDeal(dealId: string): Promise<void> {
  try {
    const { h, api } = await zohoHeaders()
    // La regla de Zoho corre ASÍNCRONA tras el PUT: una sola lectura inmediata
    // suele ver todavía a vicky@, y entonces el aviso de "tienes un trato
    // nuevo" sale al ROBOT — o sea, a nadie (misma cicatriz que el 28-ago en
    // los leads, caso Ana López / Clínica Alemana). Se relee hasta ver a una
    // persona; si el sorteo nunca aterriza, NO se manda nada y queda el aviso
    // en el log, que es honesto: no hubo a quién avisarle.
    let fila: { Owner?: { email?: string }; Territorio?: string } | undefined
    for (let intento = 0; intento < 4; intento++) {
      if (intento > 0) await new Promise((r) => setTimeout(r, 2500))
      const g = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner,Territorio`, { headers: h, cache: "no-store" })
      if (!g.ok) return
      fila = ((await g.json().catch(() => ({}))) as {
        data?: Array<{ Owner?: { email?: string }; Territorio?: string }>
      }).data?.[0]
      const correo = (fila?.Owner?.email || "").toLowerCase()
      if (correo && !/vicky@|info@geovictoria/.test(correo)) break
      fila = undefined
    }
    const owner = fila?.Owner
    if (!owner?.email) {
      console.warn(`[crm-hitos] deal ${dealId} sigue con dueño robot tras el sorteo — nadie fue notificado`)
      return
    }
    // La copia a Victoria Luna es SOLO CHILE (Lalo 31-jul): CO y MX siguen
    // con sus reglas antiguas — el dueño recibe su aviso, sin CC.
    const esChile = /chile/i.test(String(fila?.Territorio || "")) || !fila?.Territorio
    const { correoEntregable } = await import("./correo-alias")
    const destino = await correoEntregable(owner.email)
    await fetch(`${api}/crm/v3/Deals/${dealId}/actions/send_mail`, {
      method: "POST",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        data: [{
          from: { email: "vicky@geovictoria.com" },
          to: [{ email: destino }],
          ...(esChile && CC_TRASPASO_DEAL ? { cc: [{ email: CC_TRASPASO_DEAL }] } : {}),
          template: { id: TPL_TRASPASO_DEAL },
        }],
      }),
    })
  } catch (e) {
    console.warn(`[crm-hitos] notificarTraspasoDeal falló:`, e instanceof Error ? e.message : e)
  }
}

export async function aplicarTombolaDeals(dealId: string, territorio: string): Promise<void> {
  const regla = TOMBOLA_DEALS_POR_TERRITORIO[territorio] || ""
  if (!regla) return
  try {
    const { h, api } = await zohoHeaders()
    const res = await fetch(`${api}/crm/v3/Deals`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: dealId }], lar_id: regla }),
    })
    if (!res.ok) {
      console.warn(`[crm-hitos] tómbola de deals falló (${res.status}) para ${dealId} — conserva el interino`)
      return
    }
    // El dueño sorteado se entera al instante (con copia a Victoria).
    await notificarTraspasoDeal(dealId)
  } catch (e) {
    console.warn(`[crm-hitos] tómbola de deals lanzó:`, e instanceof Error ? e.message : e)
  }
}

/**
 * Convierte el lead con deal naciendo en la etapa del piso (regla de
 * marketing: el deal SIEMPRE nace de la conversión). Owner del deal: dueño
 * humano del lead lo hereda (gestión intocable); sin dueño humano, el deal
 * nace con el interino del país y pasa por la TÓMBOLA de Zoho (Lalo 31-jul).
 * Maneja cuenta duplicada reconvirtiendo con Accounts:{id}.
 */
async function convertirConDeal(
  lead: LeadEncontrado,
  contact: string,
  piso: string,
  // Reunión agendada (Lalo 06-ago): el owner se FUERZA al host de la reunión
  // — mata la carrera lead-reasignado-vs-hito que mandó el deal de VDZ a la
  // tómbola mientras el cliente conocía a Aleydis.
  ownerForzadoId?: string,
  // Umbral 08-ago: derivación con promesa de ejecutivo → sorteo al nacer.
  sorteoInmediato?: boolean,
  // Eduardo 14-ago: la DERIVACIÓN (rama "que me llamen") entrega el caso como
  // LEAD a la tómbola de leads y NO crea trato. La REUNIÓN sí lo crea: ahí hay
  // un compromiso agendado y el deal nace con el host como dueño.
  entregarComoLead?: boolean,
): Promise<string | null> {
  // CANDADO ANTI-CARRERA (25-ago): reservar la creación ANTES de convertir.
  // Si la emisión (u otro hito) ya está creando el deal de este fono, se
  // espera su id real y se REUSA — los gemelos de Quilodrán nacieron en la
  // ventana entre la consulta y la escritura del candado.
  const fonoCandado = contact.replace(/\D/g, "")
  if (fonoCandado && !(await reservarDealEnKv(fonoCandado, "hito"))) {
    const otro = await dealActivoEnKv(fonoCandado)
    if (otro) {
      console.log(`[crm-hitos] ${fonoCandado}: creación en curso por la otra puerta — se reusa deal ${otro} (anti-carrera)`)
      return otro
    }
    // Reserva ajena vencida sin id: se sigue creando (jamás perder el hito).
  }
  const { h, api } = await zohoHeaders()
  const territorio = territorioDeContacto(contact) || "Chile"
  // CUENTA "-" (05-sep): Zoho nombra la cuenta nueva con Lead.Company y, si ya
  // existe una con ese nombre, FUSIONA ahí. El conciliador de nombres deja
  // Company="-" cuando no hay razón social (regla Lalo 20-ago) y con eso cuatro
  // clientes reales terminaron colgando de una cuenta "-" de 2022. Antes de
  // convertir, un Company placeholder se reemplaza por la razón social del SII
  // (si hay RUT) o por el placeholder ÚNICO por contacto que ya usa el
  // ptv-cron, para que la cuenta nazca propia y el cotizador la renombre
  // después. Best-effort: si el PUT falla, el convert sigue.
  const companyLead = String(lead.company || "").trim()
  if (!companyLead || /^[-–—\s]*$/.test(companyLead) || /^prospecto whatsapp$/i.test(companyLead) || /^no declarado$/i.test(companyLead)) {
    let nombreCuenta = ""
    if (lead.rut) {
      try {
        const { fichaEmpresaSii } = await import("./empresas-sii")
        nombreCuenta = (await fichaEmpresaSii(lead.rut.trim().toUpperCase().replace(/\./g, "")))?.razonSocial || ""
      } catch { nombreCuenta = "" }
    }
    if (!nombreCuenta) nombreCuenta = `Por identificar (WhatsApp +${contact.replace(/\D/g, "")})`
    await fetch(`${api}/crm/v3/Leads/${lead.id}`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: lead.id, Company: nombreCuenta }], trigger: ["blueprint"] }),
    }).catch(() => null)
    lead = { ...lead, company: nombreCuenta }
    console.log(`[crm-hitos] ${contact}: Company placeholder "${companyLead || "∅"}" → "${nombreCuenta}" antes de convertir`)
  }
  // Sin dato real, el N NO se inventa (Lalo 06-ago): el default 1 mandaba
  // empresas de 500 al tramo SMB de la tómbola de deals (casos VDZ/Bodegas
  // San Francisco/VITAPRO).
  const empleados = lead.empleados || 0
  // CHILE SIN NÚMERO = oportunidad NO calificada (Lalo 06-ago): no nace deal.
  // Con reunión agendada, el LEAD se fuerza al host (él califica en la
  // reunión); sin reunión, vuelve a la tómbola de leads de Aracelli/Aleydis,
  // que califican y ahí recién el deal nace en su tramo real. Dueño humano
  // previo no se pisa: esa gestión ya tiene responsable.
  // SOBRE EL UMBRAL = LEAD, NO TRATO (Eduardo 14-ago, corrige la regla del
  // 06-ago): la derivación por dotación fuera del rango de Vicky entrega el
  // caso a la TÓMBOLA DE LEADS de ejecutivos comerciales — el deal lo crea
  // después el ejecutivo cuando corresponda. Antes nacía un trato aunque
  // nadie hubiera hablado con el cliente. El owner sorteado se devuelve para
  // que Vicky pueda presentarlo y ofrecer reunión con él.
  if (entregarComoLead && territorio === "Chile") {
    if (heredaGestionAlDeal(lead.ownerId, territorio)) {
      console.log(`[crm-hitos] +${contact}: sobre-umbral con dueño humano previo — se conserva`)
      return null
    }
    const { reasignarLeadCalificacionCL } = await import("./zoho-leads")
    const r = await reasignarLeadCalificacionCL(lead.id, { calificado: empleados > 0 }).catch(
      () => null,
    )
    console.log(
      `[crm-hitos] +${contact}: sobre-umbral → tómbola de LEADS (${r?.ownerEmail || "sin asignar"}), sin crear trato`,
    )
    if (r?.ownerId || r?.ownerEmail) {
      await guardarEjecutivoAsignado(contact, {
        id: r.ownerId || "",
        nombre: r.ownerNombre || "",
        email: r.ownerEmail || "",
      })
      // AVISO AL EJECUTIVO (29-ago): la regla de Zoho asignaba en SILENCIO —
      // el único correo ("Nuevo Lead Chile") sale al crearse el lead, cuando
      // el dueño todavía es Vicky. Casos Sebastián Goic y Belén Fuentes:
      // pidieron que los llamaran y el ejecutivo nunca supo que los tenía.
      const { notificarLeadAsignado } = await import("./notificar-lead-asignado")
      await notificarLeadAsignado({
        leadId: lead.id,
        vendedorEmail: r.ownerEmail || "",
        contact,
        nombre: lead.lastName,
        empresa: lead.company,
        empleados,
        pidioHumano: true,
      }).catch(() => false)
    }
    return null
  }
  if (territorio === "Chile" && empleados <= 0) {
    if (ownerForzadoId) {
      await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ id: lead.id, Owner: { id: ownerForzadoId } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => {})
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores CON reunión — deal NO creado; lead ${lead.id} forzado al host de la reunión`,
      )
    } else if (!heredaGestionAlDeal(lead.ownerId, territorio)) {
      const { reasignarLeadCalificacionCL } = await import("./zoho-leads")
      // Hito SIN N° de trabajadores = lead sin calificar → tómbola SDR.
      const r = await reasignarLeadCalificacionCL(lead.id, { calificado: false }).catch(() => null)
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores — deal NO creado; lead ${lead.id} → tómbola de calificación (${r?.ownerEmail || "sin asignar"})`,
      )
    } else {
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores — deal NO creado; lead ${lead.id} sigue con su dueño humano`,
      )
    }
    return null
  }
  // SECTOR PÚBLICO POR RAZÓN SOCIAL (Lalo 18-ago, "vamos con tu propuesta"):
  // la regla de la tómbola de deals rutea >300 + Sector "8. Municipio"/"9.
  // Gobierno" a los KAM de gobierno (Arizmendi/Navarrete) — con el "19.
  // Servicios" fijo de siempre, un municipio de 600 caía al roster enterprise
  // PRIVADO (caso Corp. Municipal de Castro, corregido a mano por el equipo).
  // Solo los patrones inequívocos; lo dudoso conserva el default y lo
  // corrige el humano.
  const sectorPublico = ((n: string): string | null => {
    if (/municipal/i.test(n)) return "8. Municipio" // municipalidad, corporación municipal
    if (/ministerio|gobierno de|gobierno regional|subsecretar|servicio de salud|instituto nacional|seremi|junaeb|junji|fonasa|registro civil/i.test(n))
      return "9. Gobierno"
    return null
  })(lead.company || "")
  const deal = {
    Deal_Name: `${lead.company || "Prospecto WhatsApp"} (Control de Asistencia)`,
    // RUT en el DEAL, no solo en la cuenta (Lalo 10-ago, caso Embajada de
    // Bélgica): el equipo comercial lo necesita en ambos registros. Si el
    // lead aún no lo tiene (hito temprano), la emisión formal lo completa
    // después (create-from-vicky rellena Rut_ID_Account del deal reusado).
    ...(lead.rut ? { Rut_ID_Account: lead.rut } : {}),
    Stage: piso,
    Pipeline: "Standard (Standard)",
    Territorio: territorio,
    Tombola: "Mantener propietario",
    Sector: sectorPublico || "19. Servicios",
    // Moneda por territorio. OJO Perú: el picklist de Zoho usa "SOL" (no
    // "PEN") — verificado contra el metadata del campo el 05-ago. Chile es
    // CLP desde el 20-ago (convención de montos de marketing: el recurrente
    // del trato va en pesos, no en UF).
    Monda_del_trato:
      territorio === "Colombia" ? "COP" : territorio === "México" ? "MXN" : territorio === "Perú" ? "SOL" : "CLP",
    Producto_Soluci_n: "Control de Asistencia",
    Tipo_de_Cobro: empleados > 0 && empleados <= 10 ? "Mensual fijo" : "Por usuario",
    ...(empleados > 0 ? { N_Empleados_que_marcan: empleados } : {}),
    Closing_Date: HOY_MAS_30(),
    // Dueño humano del lead → lo hereda el deal. Sin dueño humano:
    // - Territorio CON regla de tómbola (Chile): el deal nace a nombre del
    //   USUARIO VICKY y la tómbola lo sortea al instante. Si el sorteo falla,
    //   queda visiblemente en Vicky (Lalo 04-ago: con Eddyluz-interina era
    //   imposible distinguir "sorteo cayó en Eddy" de "sorteo nunca corrió").
    // - Territorio SIN regla (CO/MX): interino del país como siempre — ahí el
    //   interino ES el dueño real y Vicky-user sería la bandeja de nadie.
    // CO — REGLA EQUIPO (Lalo 05-ago): el deal de un hito NO-formal (preform,
    // reunión, discovery) nace con Eddy Galindo (SDR fijo) y SE QUEDA con él
    // hasta el final (sin cambios de propietario — la formal NO lo traspasa).
    // Solo los registros que la formal CREA nacen con Gordillo.
    Owner: {
      id: heredaGestionAlDeal(lead.ownerId, territorio)
        ? lead.ownerId
        : TOMBOLA_DEALS_POR_TERRITORIO[territorio]
          ? VICKY_OWNER_ID
          : ({ Colombia: "3525045000613817111", "México": "3525045000434395001" /* Miguel Guzmán, SDR inbound (Lalo 12-ago) */, "Perú": "3525045000323383015" } as Record<string, string>)[territorio] || VICKY_OWNER_ID,
    },
    Description: `Deal creado automáticamente por Vicky al detectar el hito en la conversación de WhatsApp (+${contact.replace(/\D/g, "")}).`,
  }
  const convertir = async (accountId?: string) => {
    const body = {
      data: [
        {
          overwrite: false,
          notify_lead_owner: false,
          notify_new_entity_owner: false,
          ...(accountId ? { Accounts: { id: accountId } } : {}),
          Deals: deal,
        },
      ],
    }
    const res = await fetch(`${api}/crm/v3/Leads/${lead.id}/actions/convert`, {
      method: "POST",
      headers: h,
      cache: "no-store",
      body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({}))) as {
      data?: Array<{
        code?: string
        // La conversión devuelve los TRES registros que crea de una vez:
        // trato, cuenta y contacto. Antes solo se leía el trato.
        Deals?: { id?: string }
        Accounts?: { id?: string }
        Contacts?: { id?: string }
        details?: {
          duplicate_record?: { id?: string }
          Deals?: { id?: string }
          Accounts?: { id?: string }
          Contacts?: { id?: string }
        }
        duplicate_record?: { id?: string }
      }>
    }
  }
  let r = await convertir()
  let fila = r?.data?.[0]
  if (fila?.code !== "SUCCESS") {
    const dupId = fila?.duplicate_record?.id || fila?.details?.duplicate_record?.id
    if (dupId) {
      r = await convertir(String(dupId))
      fila = r?.data?.[0]
    }
  }
  // BUG CAZADO 04-ago (el origen del sesgo de Eddyluz que reportó Victoria):
  // Zoho devuelve los IDs de la conversión DENTRO de details ({code:"SUCCESS",
  // details:{Deals:{id},Contacts:{id},Accounts:{id}}}), y este código los
  // buscaba en la raíz — todo convert exitoso caía al camino de "falló", el
  // deal quedaba creado con la interina y la tómbola JAMÁS corría.
  const dealCreado = fila?.Deals?.id || fila?.details?.Deals?.id
  if (fila?.code === "SUCCESS" && dealCreado) {
    console.log(`[crm-hitos] lead ${lead.id} convertido → deal ${dealCreado} en "${piso}"`)
    // El vínculo durable en la conversación + la marca del chat en el trato
    // (Lalo 15-ago). Best-effort: no se espera ni bloquea la conversión.
    void (async () => {
      const { vincularZohoAConversacion } = await import("./supabase-persistence-v3")
      await vincularZohoAConversacion(contact, { leadId: lead.id, dealId: String(dealCreado) })
      // La conversión crea de una vez trato, cuenta y contacto: los tres
      // quedan registrados, no solo el trato.
      const { registrarEnZoho } = await import("./registro-zoho")
      await registrarEnZoho(
        contact,
        [
          { modulo: "Leads", id: lead.id },
          { modulo: "Deals", id: String(dealCreado) },
          { modulo: "Accounts", id: fila?.Accounts?.id || fila?.details?.Accounts?.id },
          { modulo: "Contacts", id: fila?.Contacts?.id || fila?.details?.Contacts?.id },
        ],
        { origen: "crm-hitos" },
      )
      const { marcarRegistroConChat } = await import("./enlace-conversacion")
      await marcarRegistroConChat("Deals", String(dealCreado), contact)
    })().catch(() => undefined)
    // REUNIÓN MANDA (Lalo 06-ago): con reunión agendada el deal se fuerza al
    // HOST — una sola cara ante el cliente. Gana sobre tómbola y traspaso.
    if (ownerForzadoId) {
      await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ id: String(dealCreado), Owner: { id: ownerForzadoId } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => {})
      console.log(`[crm-hitos] deal ${dealCreado} forzado al host de la reunión (${ownerForzadoId})`)
      await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
      await registrarDealEnKv(contact.replace(/\D/g, ""), String(dealCreado), "hito")
      return String(dealCreado)
    }
    const heredaDuenoHumano = heredaGestionAlDeal(lead.ownerId, territorio)
    // TRASPASO VIGENTE MANDA (caso Ana/Daniela 04-ago): si el contacto tiene
    // vic_ptv activo, al cliente YA se le presentó ese ejecutivo (con nombre,
    // correo y WhatsApp) — sortear el deal a otra persona rompe la promesa.
    // El deal se asigna directo al ejecutivo del traspaso, sin tómbola.
    // EXCEPTO COLOMBIA (regla equipo 05-ago, caso Jotapartes): el deal de un
    // hito no-formal nace y SE QUEDA con Galindo — un vic_ptv del TTV viejo
    // (Gordillo, muchas veces ni siquiera presentado al cliente) no lo pisa.
    let asignadoPorTraspaso = false
    if (!heredaDuenoHumano && territorio !== "Colombia") {
      try {
        const { vendedorTraspasado } = await import("./loop-v2")
        const v = await vendedorTraspasado(contact.replace(/\D/g, ""))
        if (v?.zohoId) {
          await fetch(`${api}/crm/v3/Deals`, {
            method: "PUT",
            headers: h,
            cache: "no-store",
            body: JSON.stringify({
              data: [{ id: String(dealCreado), Owner: { id: v.zohoId } }],
              skip_feature_execution: [{ name: "assignment_rules" }],
            }),
          })
          asignadoPorTraspaso = true
          console.log(`[crm-hitos] deal ${dealCreado} asignado al ejecutivo del traspaso vigente (${v.email})`)
          await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
        }
      } catch { /* sin traspaso vigente, sigue el flujo normal */ }
    }
    if (!asignadoPorTraspaso) {
      if (!heredaDuenoHumano) {
        // MODELO 06-ago (Lalo): en Chile el deal ≤50 nace y ESPERA en el
        // usuario Vicky (la interina oficial) — SIN sorteo y SIN notificación.
        // La asignación al vendedor va de la mano con los relojes de traspaso
        // (120/15/10 min hábiles): asignarEnZoho del cron sortea el deal con
        // la regla de Zoho recién cuando la conversación se traspasa (caso
        // Rodrigo/Neumasport: el sorteo en caliente lo alertaba apenas el
        // cliente veía el precio). Los >50 SÍ se sortean al nacer (doc
        // Rodrigo 30-jul: deal + tómbola en el acto — no tienen relojes).
        // Umbral 08-ago: sorteoInmediato (derivación sobre-umbral) también
        // sortea al nacer, con cualquier N — al cliente ya se le prometió
        // que un ejecutivo le entrega el precio.
        if (!sorteoInmediato && territorio === "Chile" && empleados > 0 && empleados <= 50) {
          console.log(
            `[crm-hitos] deal ${dealCreado} (${empleados} empleados) queda en Vicky — sorteo y notificación al traspaso, no en caliente`,
          )
        } else {
          await aplicarTombolaDeals(String(dealCreado), territorio)
        }
      } else {
        // Dueño humano heredado (caso Paola/Agrícola Vaticano 04-ago): sin
        // tómbola no salía NINGUNA notificación y el deal nacía en silencio —
        // el dueño se enteraba por casualidad. El correo directo va igual.
        await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
      }
    }
    await registrarDealEnKv(contact.replace(/\D/g, ""), String(dealCreado), "hito")
    return String(dealCreado)
  }
  console.warn(`[crm-hitos] convert de ${lead.id} falló: ${JSON.stringify(r).slice(0, 250)}`)
  return null
}

/**
 * Avanza el deal hasta el piso vía transiciones Blueprint (máx. 3 saltos).
 * Los campos mandatorios de cada transición se completan con los valores del
 * propio deal (releídos) — la lección del backfill: van DENTRO del data.
 */
async function avanzarDealHasta(dealId: string, piso: string, revivirPerdido = false): Promise<void> {
  const { h, api } = await zohoHeaders()
  for (let salto = 0; salto < 3; salto++) {
    const bpRes = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, {
      headers: h,
      cache: "no-store",
    })
    if (!bpRes.ok) return
    const bp = (await bpRes.json().catch(() => ({}))) as {
      blueprint?: {
        process_info?: { field_value?: string }
        transitions?: Array<{
          id: string
          next_field_value?: string
          fields?: Array<{ api_name?: string; mandatory?: boolean }>
        }>
      }
    }
    const actual = bp?.blueprint?.process_info?.field_value || ""
    const objetivo = etapaObjetivo(actual, piso, revivirPerdido)
    if (!objetivo) return
    // La transición que más avance sin pasarse del piso.
    const candidatas = (bp?.blueprint?.transitions || [])
      .filter((t) => {
        const orden = ORDEN_ETAPA[t.next_field_value || ""]
        // Saliendo de Cierre Perdido no hay "orden actual" contra el cual
        // comparar: sirve cualquier transición que no pase del piso.
        const desde = revivirPerdido && actual === "Cierre Perdido" ? 0 : ORDEN_ETAPA[actual] || 0
        return orden && orden > desde && orden <= (ORDEN_ETAPA[piso] || 0)
      })
      .sort((a, b) => (ORDEN_ETAPA[b.next_field_value || ""] || 0) - (ORDEN_ETAPA[a.next_field_value || ""] || 0))
    const trans = candidatas[0]
    if (!trans) {
      console.warn(`[crm-hitos] deal ${dealId}: sin transición de "${actual}" hacia "${piso}"`)
      return
    }
    // Los mandatorios de la transición se llenan con los valores del deal.
    const dRes = await fetch(
      `${api}/crm/v3/Deals/${dealId}?fields=Contact_Name,Producto_Soluci_n,Tipo_de_Cobro,Monda_del_trato,N_Empleados_que_marcan,M_todo_de_carga_de_informaci_n`,
      { headers: h, cache: "no-store" },
    )
    const dBody = (await dRes.json().catch(() => ({}))) as {
      data?: Array<Record<string, unknown>>
    }
    const dealActual = dBody?.data?.[0] || {}
    const data: Record<string, unknown> = {}
    for (const f of trans.fields || []) {
      const api_name = f?.api_name || ""
      if (!api_name) continue
      const valor = dealActual[api_name]
      if (valor !== null && valor !== undefined && valor !== "") data[api_name] = valor
      // Default seguro para el único mandatorio sin valor natural en Vicky:
      // la carga por Excel no dispara automatizaciones hacia el cliente.
      else if (api_name === "M_todo_de_carga_de_informaci_n") data[api_name] = "Planilla Excel (proceso manual)"
    }
    const exec = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({ blueprint: [{ transition_id: trans.id, data }] }),
    })
    const execBody = (await exec.json().catch(() => ({}))) as { code?: string }
    if (!exec.ok || execBody?.code !== "SUCCESS") {
      console.warn(
        `[crm-hitos] deal ${dealId}: transición a "${trans.next_field_value}" falló: ${JSON.stringify(execBody).slice(0, 200)}`,
      )
      return
    }
    console.log(`[crm-hitos] deal ${dealId}: "${actual}" → "${trans.next_field_value}"`)
    if (trans.next_field_value === piso) return
  }
}

const TITULO_NOTA_TRANSCRIPCION = "Transcripción WhatsApp Vicky"

/**
 * NOTA VIVA de transcripción en el deal (pedido Lalo 30-jul): una sola nota
 * por deal, que se ACTUALIZA con la conversación completa en cada hito — no
 * se acumulan copias. (El PDF adjunto queda para el barrido batch: en
 * serverless no hay renderer.) Best-effort.
 */
/**
 * UNA SOLA NOTA DE TRANSCRIPCIÓN POR REGISTRO, SIEMPRE AL DÍA (Lalo 15-ago).
 *
 * La conversación sigue viva después del traspaso, pero la nota que el
 * ejecutivo abre para ponerse al día quedaba congelada en el momento en que
 * se creó. Acá se le vuelca el diálogo completo.
 *
 * Regla exacta: si el registro YA tiene una nota con transcripción, se
 * actualiza esa —nunca se agrega otra al lado—; si NO tiene ninguna y hay
 * conversación, se crea UNA, que desde entonces será la que se refresque.
 *
 * Reconoce las dos que el sistema escribe: la de los hitos ("Transcripción
 * WhatsApp Vicky") y la del traspaso ("Traspaso de Vicky — conversación y
 * chat directo"), esta última conservando su cabecera (el link directo al
 * chat) y reemplazando solo el cuerpo del diálogo.
 */
const TITULOS_CON_TRANSCRIPCION = [TITULO_NOTA_TRANSCRIPCION, "Traspaso de Vicky"]
const MARCA_TRANSCRIPCION = "CONVERSACIÓN RECIENTE CON VICKY:"

export async function sincronizarNotaTranscripcion(
  contact: string,
  registros: Array<{ modulo: string; id: string }>,
): Promise<number> {
  let refrescadas = 0
  try {
    const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
    const historia = await fetchHistoryV3(contact, 200)
    if (!historia.length) return 0
    const transcript = historia
      .map((m) => {
        const rol = m.role === "assistant" ? "Vicky" : "Cliente"
        const at = (m as { at?: string }).at || ""
        return `${at} | ${rol}: ${m.content || ""}`
      })
      .join("\n")
      .slice(0, 30000)
    const { h, api } = await zohoHeaders()
    for (const reg of registros) {
      if (!reg.id) continue
      const res = await fetch(
        `${api}/crm/v3/${reg.modulo}/${reg.id}/Notes?fields=Note_Title,Note_Content&per_page=50`,
        { headers: h, cache: "no-store" },
      )
      if (!res.ok) continue
      const data =
        res.status === 204
          ? {}
          : ((await res.json().catch(() => ({}))) as {
              data?: Array<{ id?: string; Note_Title?: string; Note_Content?: string }>
            })
      const conTranscripcion = (data?.data || []).filter((n) =>
        TITULOS_CON_TRANSCRIPCION.some((t) => String(n.Note_Title || "").startsWith(t)),
      )
      // Sin nota previa y CON conversación: nace la nota que de ahora en
      // adelante se irá actualizando. Se usa el sub-recurso del registro —
      // el POST global a /Notes con Parent_Id falla en silencio en módulos
      // custom (cicatriz del 25-jul y del backfill del 14-ago).
      if (!conTranscripcion.length) {
        const creada = await fetch(`${api}/crm/v3/${reg.modulo}/${reg.id}/Notes`, {
          method: "POST",
          headers: h,
          cache: "no-store",
          body: JSON.stringify({
            data: [{ Note_Title: TITULO_NOTA_TRANSCRIPCION, Note_Content: transcript }],
          }),
        })
        if (creada.ok) {
          refrescadas++
          console.log(`[crm-hitos] ${reg.modulo}/${reg.id}: nota de transcripción creada`)
        }
        continue
      }
      for (const n of conTranscripcion) {
        // La nota del traspaso lleva cabecera (link al chat + contexto): se
        // conserva y se reemplaza SOLO el diálogo que va debajo de la marca.
        const previo = String(n.Note_Content || "")
        const corte = previo.indexOf(MARCA_TRANSCRIPCION)
        const contenido =
          corte >= 0
            ? `${previo.slice(0, corte)}${MARCA_TRANSCRIPCION}\n${transcript}`
            : transcript
        if (contenido.trim() === previo.trim()) continue
        const put = await fetch(`${api}/crm/v3/Notes/${n.id}`, {
          method: "PUT",
          headers: h,
          cache: "no-store",
          body: JSON.stringify({ data: [{ Note_Content: contenido.slice(0, 32000) }] }),
        })
        if (put.ok) refrescadas++
      }
    }
  } catch (e) {
    console.warn("[crm-hitos] refrescarTranscripcionesExistentes falló:", e instanceof Error ? e.message : e)
  }
  return refrescadas
}

export async function actualizarNotaTranscripcion(dealId: string, contact: string): Promise<void> {
  try {
    const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
    const historia = await fetchHistoryV3(contact, 200)
    if (!historia.length) return
    const transcript = historia
      .map((m) => {
        const rol = m.role === "assistant" ? "Vicky" : "Cliente"
        const at = (m as { at?: string }).at || ""
        return `${at} | ${rol}: ${m.content || ""}`
      })
      .join("\n")
      .slice(0, 30000)
    const { h, api } = await zohoHeaders()
    const res = await fetch(
      `${api}/crm/v3/Deals/${dealId}/Notes?fields=Note_Title&per_page=50`,
      { headers: h, cache: "no-store" },
    )
    let notaId: string | null = null
    if (res.ok && res.status !== 204) {
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; Note_Title?: string }>
      }
      notaId =
        data?.data?.find((n) => (n.Note_Title || "").startsWith(TITULO_NOTA_TRANSCRIPCION))?.id ||
        null
    }
    if (notaId) {
      await fetch(`${api}/crm/v3/Notes/${notaId}`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({ data: [{ Note_Content: transcript }] }),
      })
    } else {
      await fetch(`${api}/crm/v3/Notes`, {
        method: "POST",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [
            {
              Note_Title: TITULO_NOTA_TRANSCRIPCION,
              Note_Content: transcript,
              Parent_Id: dealId,
              $se_module: "Deals",
            },
          ],
        }),
      })
    }
  } catch (e) {
    console.warn(`[crm-hitos] nota transcripción deal ${dealId} falló:`, e instanceof Error ? e.message : e)
  }
}

// Guard por instancia: el mismo (contacto, hito) no se re-procesa en el mismo
// proceso serverless. Zoho igual queda consistente si se repite (todo es
// idempotente hacia arriba), esto solo ahorra llamadas.
const procesados = new Set<string>()

/**
 * Punto de entrada: sincroniza el CRM con un hito detectado en la
 * conversación. Best-effort — loguea y nunca lanza.
 */
/**
 * Tools que YA crean su propio lead adentro (agendar/callback): el hook jamás
 * debe crear otro — si el resolver no lo encuentra (lag de indexación), se
 * espera al cron. Los duplicados Catalina/Mayra del 30-jul nacieron de esta
 * carrera.
 */
export const TOOLS_QUE_CREAN_SU_LEAD = new Set([
  "agendar_reunion",
  "reagendar_reunion",
  "registrar_solicitud_callback",
])

/** Destino del LEAD pre-formal (escalera de roles, biblia 12-ago):
 * reunión → owner forzado al host de la agenda; sorteoInmediato (21-50 / >50
 * derivados) → tómbola de VENDEDORES (regla de calificados — la dotación
 * conocida ES la calificación); resto → el lead sigue su curso normal (dueño
 * actual o los relojes lo entregarán). Nunca nace deal aquí. */
async function dejarLeadPreFormal(
  lead: LeadEncontrado,
  clean: string,
  hito: Hito,
  ownerForzadoId: string,
  sorteoInmediato?: boolean,
): Promise<void> {
  try {
    // LA CONVERSACIÓN VIAJA SIEMPRE (03-sep). Este era el ÚNICO camino de
    // entrega donde el lead llegaba sin la transcripción: los deals la tienen
    // (actualizarNotaTranscripcion) y el lead que entrega el cron también,
    // pero acá solo se cambiaba el status y se reasignaba. El ejecutivo
    // recibía nombre y teléfono sin saber qué se conversó — justo en el
    // camino de "quiero que me llamen" antes de calificar.
    if (lead.id) {
      const { dejarNotaConversacionEnLead } = await import("./nota-conversacion-lead")
      void dejarNotaConversacionEnLead(lead.id, clean).catch(() => false)
    }
    if (ownerForzadoId && lead.id) {
      const { getZohoAccessToken } = await import("./zoho-token")
      const token = await getZohoAccessToken()
      const api = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
      await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          data: [{ id: lead.id, Owner: { id: ownerForzadoId } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => {})
      console.log(`[crm-hitos] ${clean}: hito "${hito}" pre-formal — LEAD ${lead.id} forzado al host de la reunión (deal nace con la formal)`)
      return
    }
    if (sorteoInmediato && lead.id) {
      const { reasignarLeadCalificacionCL } = await import("./zoho-leads")
      const r = await reasignarLeadCalificacionCL(lead.id, { calificado: true }).catch(() => null)
      // Doc regla general 5a: "con el ejecutivo ya asignado, Vicky lo PRESENTA
      // en ese mismo mensaje". La entrega como LEAD no guardaba el ejecutivo
      // sorteado y la tool despedía sin presentar a nadie (18-ago: Instituto,
      // INTEXGROUP y Castro se derivaron con un "un ejecutivo te va a llamar"
      // anónimo). Ahora el sorteado queda disponible para la presentación.
      if (r?.success && r.ownerId) {
        await guardarEjecutivoAsignado(clean, {
          id: r.ownerId,
          nombre: r.ownerNombre || "",
          email: r.ownerEmail || "",
        }).catch(() => {})
        // Mismo hueco del silencio (29-ago): la regla asigna y nadie avisa.
        const { notificarLeadAsignado } = await import("./notificar-lead-asignado")
        await notificarLeadAsignado({
          leadId: lead.id,
          vendedorEmail: r.ownerEmail || "",
          contact: clean,
          nombre: lead.lastName,
          empresa: lead.company,
          empleados: lead.empleados,
          pidioHumano: true,
        }).catch(() => false)
      }
      console.log(
        `[crm-hitos] ${clean}: hito "${hito}" pre-formal con sorteo inmediato — LEAD ${lead.id} → tómbola de vendedores (${r?.ownerEmail || "regla sin asignar"}); deal nace con la formal`,
      )
      return
    }
    console.log(`[crm-hitos] ${clean}: hito "${hito}" pre-formal — LEAD ${lead.id} actualizado; el deal nace con la cotización formal (biblia 12-ago)`)
  } catch (e) {
    console.warn(`[crm-hitos] dejarLeadPreFormal falló para ${clean}:`, e instanceof Error ? e.message : e)
  }
}

/** Ejecutivo sorteado en una derivación sobre-umbral: se guarda para que la
 * tool pueda presentarlo al cliente EN EL MISMO turno (Eduardo 14-ago: "al
 * asignar, Vicky debe devolver los datos del ejecutivo y preguntar si quiere
 * dejar una reunión agendada con él"). El teléfono sale de su ficha de
 * usuario en Zoho; sin teléfono se presenta igual, con nombre y correo. */
export type EjecutivoAsignado = { id: string; nombre: string; email: string; telefono?: string }

export async function guardarEjecutivoAsignado(
  contact: string,
  ejec: EjecutivoAsignado,
): Promise<void> {
  try {
    let telefono = ""
    if (ejec.id) {
      const { h, api } = await zohoHeaders()
      const r = await fetch(`${api}/crm/v3/users/${ejec.id}`, { headers: h, cache: "no-store" })
      if (r.ok) {
        const u = ((await r.json().catch(() => ({}))) as {
          users?: Array<{ phone?: string; mobile?: string; full_name?: string; email?: string }>
        }).users?.[0]
        telefono = String(u?.phone || u?.mobile || "").trim()
        if (!ejec.nombre && u?.full_name) ejec.nombre = u.full_name
        if (!ejec.email && u?.email) ejec.email = u.email
      }
    }
    const { setKvValue } = await import("./supabase-persistence-v3")
    await setKvValue(
      `ejec_sobre_umbral_${contact.replace(/\D/g, "")}`,
      JSON.stringify({ ...ejec, telefono, at: Date.now() }),
    )
  } catch {
    /* best-effort: sin esto la derivación igual queda registrada */
  }
}

export async function leerEjecutivoAsignado(contact: string): Promise<EjecutivoAsignado | null> {
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const raw = await getKvValue(`ejec_sobre_umbral_${contact.replace(/\D/g, "")}`)
    if (!raw) return null
    const j = JSON.parse(raw) as EjecutivoAsignado & { at?: number }
    return j?.nombre || j?.email ? j : null
  } catch {
    return null
  }
}

export async function sincronizarHitoCrm(
  contact: string,
  hito: Hito,
  datos: DatosConversacion = {},
  // sorteoInmediato (umbral 08-ago): el hito viene de una derivación donde al
  // cliente se le prometió ejecutivo — el deal CL ≤50 NO espera en Vicky: la
  // tómbola sortea y notifica al nacer, igual que los >50.
  opts: {
    noCrear?: boolean
    ownerForzadoEmail?: string
    sorteoInmediato?: boolean
    entregarComoLead?: boolean
  } = {},
): Promise<void> {
  try {
    if (!habilitado()) return
    const clean = (contact || "").replace(/\D/g, "")
    if (!clean || esTelefonoDePrueba(clean)) return
    // RUT DESDE EL HISTORIAL (Lalo 01-sep, caso Avilés/Centro de Desarrollo):
    // el cliente dio el RUT en el chat 3 minutos antes de la derivación, pero
    // el modelo no lo pasó en la tool → la escalera clasificó "calificado sin
    // RUT" y entregó LEAD donde correspondía DEAL con tómbola. Antes de
    // clasificar, si el hito viene sin RUT se busca el primer RUT válido en
    // los mensajes recientes del CLIENTE (mismo extractor del enriquecedor).
    // Solo PRE-entrega: el RUT que aparece DESPUÉS de entregado jamás
    // convierte ni re-sortea (decisión Lalo 01-sep — eso es del ejecutivo).
    if (!datos.rut && clean.startsWith("56")) {
      try {
        const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
        const { rutEnTexto } = await import("./empresas-sii")
        const historial = await fetchHistoryV3(clean, 40)
        const soloCliente = historial
          .filter((m) => m.role === "user")
          .map((m) => String(m.content || ""))
          .join("\n")
        const rutChat = rutEnTexto(soloCliente)
        if (rutChat) {
          datos = { ...datos, rut: rutChat }
          console.log(`[crm-hitos] ${clean}: RUT ${rutChat} recuperado del historial para clasificar el hito "${hito}"`)
        }
      } catch {
        /* best-effort: sin historial, clasifica con lo que trajo la tool */
      }
    }
    // Flujo 21+ (Lalo 13-ago): con RUT y sin nombre de empresa, la razón
    // social se resuelve del padrón SII — el lead/deal nace con nombre real
    // en vez de "Por identificar". Best-effort: sin ficha, sigue igual.
    if (datos.rut && !datos.empresa && clean.startsWith("56")) {
      try {
        const { fichaEmpresaSii } = await import("./empresas-sii")
        const ficha = await fichaEmpresaSii(datos.rut.trim().toUpperCase().replace(/\./g, ""))
        if (ficha?.razonSocial) datos = { ...datos, empresa: ficha.razonSocial }
      } catch {
        /* best-effort */
      }
    }
    // Host de reunión → id de usuario Zoho (Lalo 06-ago: con reunión, el
    // owner del deal/lead se fuerza al host). Resolución best-effort.
    let ownerForzadoId = ""
    if (opts.ownerForzadoEmail) {
      const { resolveOwnerId } = await import("./zoho-leads")
      const { getZohoAccessToken } = await import("./zoho-token")
      ownerForzadoId =
        (await resolveOwnerId(
          opts.ownerForzadoEmail,
          await getZohoAccessToken(),
          getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com",
        ).catch(() => "")) || ""
    }
    // La clave del guard incluye los datos: el mismo hito con información
    // NUEVA (apareció la empresa, llegó el correo) sí se re-procesa.
    const key = `${clean}:${hito}:${JSON.stringify(datos)}`
    if (procesados.has(key)) return
    procesados.add(key)

    const piso = PISO_POR_HITO[hito]
    const res = await resolverPorTelefono(clean)

    if (res.tipo === "contacto_sin_lead") {
      // Cliente actual sin lead: no se crea nada (evita duplicar personas).
      console.log(`[crm-hitos] ${clean}: contacto existente ${res.contactId} sin lead — hito "${hito}" solo registrado en log`)
      return
    }

    if (res.tipo === "nada") {
      // Candado cruzado: si la OTRA puerta (emisión de la formal) acaba de
      // crear lead+deal para este fono, la búsqueda de Zoho aún no los ve —
      // crear acá duplicaba lead Y deal. Se reusa el deal y solo sube el piso.
      const dealCruzado = await dealActivoEnKv(clean)
      if (dealCruzado) {
        console.log(`[crm-hitos] ${clean}: deal ${dealCruzado} recién creado por la otra puerta (candado kv) — hito "${hito}" solo sube el piso, sin lead ni deal nuevos`)
        await avanzarDealHasta(dealCruzado, piso, Boolean(await dealAReactivar(clean)))
        await actualizarNotaTranscripcion(dealCruzado, clean)
        return
      }
      if (opts.noCrear) {
        console.log(`[crm-hitos] ${clean}: la tool crea su propio lead — no se duplica (se reconcilia en el próximo barrido)`)
        return
      }
      // ENTRANTE puro (hito sin tool de derivación): lead nuevo SIN interina
      // humana hardcodeada (Lalo 18-ago, caso Eddyluz/llamadas fantasma —
      // supersede el "dueño interino por país" del 30-jul). El lead nacía con
      // Eddyluz, un workflow de Zoho le programaba la LLAMADA de seguimiento
      // en ese instante, y 3 segundos después la tómbola sorteaba el lead a
      // otra persona — la llamada quedaba huérfana a nombre de la interina.
      // Regla nueva (extiende "Vicky es la interina oficial" del 06-ago a los
      // LEADS): nace con el usuario VICKY y el dueño real lo pone la
      // maquinaria de cada país (tómbola CL, round-robin SDR CO/MX, o el reloj
      // de calificación); el reconciliador del cron cubre las fallas de regla.
      // Perú es la excepción deliberada: Mónica NO es interina sino la
      // ejecutiva única real (sin tómbola) — su gestión SÍ se hereda al deal.
      const territorio = territorioDeContacto(clean)
      const esCO = territorio === "Colombia"
      // SOLO CHILE cambia (Lalo 18-ago: "en los países no toques nada"):
      // CL sin interina — nace con el usuario Vicky. CO/MX/PE conservan sus
      // dueños de siempre.
      const OWNER_INTERINO: Record<string, string> = {
        "México": "3525045000434395001", // Miguel Guzmán — SDR inbound MX (Lalo 12-ago; leads sin formal van a él)
        // Perú: Mónica Mendoza — NO es interina sino la ejecutiva única real
        // (sin tómbola): su gestión SÍ se hereda al deal.
        "Perú": "3525045000323383015",
      }
      const { createZohoLead } = await import("./zoho-leads")
      const creado = await createZohoLead({
        contactoWA: clean,
        telefono: clean,
        nombre: datos.nombre,
        empresa: datos.empresa,
        email: datos.email,
        trabajadores: datos.empleados,
        // CO: round-robin SDR abajo, no acá. CHILE: usuario Vicky (sin
        // interina) hasta que la tómbola/reloj entregue al dueño real.
        ownerId: esCO ? undefined : territorio ? OWNER_INTERINO[territorio] : undefined,
      })
      if (!creado.success) {
        console.warn(`[crm-hitos] ${clean}: no se pudo crear lead (${creado.error})`)
        return
      }
      if (esCO) {
        const { reasignarLeadSdrInboundCO } = await import("./zoho-leads")
        await reasignarLeadSdrInboundCO(creado.leadId).catch(() => {})
      }
      const lead: LeadEncontrado = {
        id: creado.leadId,
        ownerId: "",
        status: "",
        company: datos.empresa || "",
        empleados: datos.empleados || 0,
        email: datos.email || "",
        lastName: datos.nombre || "",
        rut: "",
        ultimaActividad: "",
        motivoNoCalificado: "",
        convertido: false,
        dealId: null,
        contactId: null,
      }
      await subirLeadStatus(lead, hito)
      if (!tieneIdentidadComercial(lead, datos)) {
        console.log(`[crm-hitos] ${clean}: hito "${hito}" sin empresa/RUT — lead ${creado.leadId} espera identidad para convertir (deal pendiente)`)
        return
      }
      const escaleraNuevo = escaleraDealConRut(territorioDeContacto(clean), lead, datos) || (datos.forzarDeal === true && Boolean(datos.rut || lead.rut))
      if (dealSoloConFormal(territorioDeContacto(clean), hito) && !escaleraNuevo) {
        await dejarLeadPreFormal(lead, clean, hito, ownerForzadoId, opts.sorteoInmediato)
        return
      }
      const dealId = await convertirConDeal(lead, clean, piso, ownerForzadoId || undefined, opts.sorteoInmediato || escaleraNuevo, opts.entregarComoLead)
      if (!dealId) console.warn(`[crm-hitos] ${clean}: lead ${creado.leadId} quedó sin convertir`)
      else await actualizarNotaTranscripcion(dealId, clean)
      return
    }

    // Hay lead (caso SALIENTE o entrante repetido). Primero el enriquecimiento
    // aditivo: cualquier dato nuevo de la conversación entra a campos vacíos.
    const lead = await enriquecerLead(res.lead, datos)
    // "De Vicky" = usuario Vicky O interinos por país (04-ago): la interina es
    // marcador de "sin dueño real", no gestión — tratarla como humana dejaba
    // sus leads sin convertir (backfill de los 14 forzados a Eddyluz).
    // Y en COLOMBIA también los SDR Inbound (fix 05-ago): el lead sin
    // cotización vive con el SDR POR DISEÑO, y el hito de cotización ES el
    // handoff SDR→ejecutivo — el lead debe convertirse (el deal no hereda al
    // SDR: heredaGestionAlDeal lo excluye y el dueño sale del mapa CO).
    // Tratarlo como "dueño humano" dejaba los leads SDR CO sin convertir nunca.
    const esSdrCO =
      territorioDeContacto(clean) === "Colombia" && SDR_CO_IDS.has(lead.ownerId)
    const esDeVicky = !lead.ownerId || INTERINOS.has(lead.ownerId) || esSdrCO

    // ── EXCEPCIÓN POR MOTIVO TERMINAL (Lalo 21-ago, catastro de traspasos) ──
    // Un lead que un SDR descartó como "No Calificado" por un motivo TERMINAL
    // (es un usuario, busca empleo, hardware que no vendemos, spam, pruebas)
    // no es un prospecto: el re-contacto NO lo reactiva (ni siquiera el
    // status), NO renace lead nuevo y NO se vuelve a entregar a nadie. Vicky
    // sigue atendiendo reactiva; el CRM queda como el SDR lo dejó. La única
    // puerta que lo revive es la venta real: los hitos POST-formales
    // (aceptada/onboarding) y la emisión formal del cotizador siguen su
    // camino normal — si el motivo estaba mal puesto, la compra lo demuestra.
    if (!lead.convertido && HITOS_PRE_FORMALES.has(hito)) {
      const { esMotivoTerminal } = await import("./zoho-leads")
      if (esMotivoTerminal(lead.status, lead.motivoNoCalificado)) {
        console.log(
          `[crm-hitos] ${clean}: lead ${lead.id} No Calificado terminal ("${lead.motivoNoCalificado}") — hito "${hito}" no reactiva ni renace`,
        )
        return
      }
    }

    // ── Reglas de re-contacto (doc David 30-jul) — detrás de sub-flag ──
    // Reglas 2/5: registro activo → RE-NOTIFICAR al dueño, sin crear nada.
    // Regla 3: "No Calificado" <3 meses → se re-trabaja el mismo lead;
    //          >3 meses → lead NUEVO en etapa 1 (excepción legítima al dedup).
    // Todo por el canal trasero: jamás toca la conversación.
    if (await reglasRecontactoActivas()) {
      if (!lead.convertido && !esDeVicky) {
        if (/no calificado/i.test(lead.status)) {
          const tresMeses = 90 * 864e5
          const viejo = lead.ultimaActividad && Date.now() - Date.parse(lead.ultimaActividad) > tresMeses
          if (viejo) {
            // >3 meses: renace como lead nuevo (regla 3b). Se libera el
            // candado para que la creación proceda.
            const { setKvValue } = await import("./supabase-persistence-v3")
            await setKvValue(`zoho_lead_${clean}`, "").catch(() => {})
            const { createZohoLead } = await import("./zoho-leads")
            const nuevo = await createZohoLead({
              contactoWA: clean, telefono: clean, nombre: datos.nombre,
              empresa: datos.empresa, email: datos.email, trabajadores: datos.empleados,
            })
            if (nuevo.success) console.log(`[crm-hitos] ${clean}: lead renacido ${nuevo.leadId} (No Calificado >3 meses, regla 3b)`)
            return
          }
          // <3 meses (regla 3a): se re-trabaja el mismo lead — sigue el flujo
          // normal de status/nota más abajo.
        }
        // Regla 2: lead activo de dueño humano → re-notificar (nota; el flujo
        // de abajo ya evita convertir leads ajenos).
        const { agregarNotaLead } = await import("./zoho-leads")
        await agregarNotaLead(
          lead.id,
          "El cliente volvió a escribirle a Vicky",
          `Re-contacto por WhatsApp (hito: ${hito}). El cliente retomó la conversación con Vicky; este lead es tuyo y no se creó ninguno nuevo. Revisa la transcripción en las notas para el contexto.`,
        ).catch(() => false)
      }
    }

    if (!lead.convertido) {
      await subirLeadStatus(lead, hito)
      const escaleraExistente = escaleraDealConRut(territorioDeContacto(clean), lead, datos) || (datos.forzarDeal === true && Boolean(datos.rut || lead.rut))
      // ESCALERA 18-ago sobre lead de dueño humano: con RUT y N>20 el deal SÍ
      // nace, pero A NOMBRE DEL MISMO dueño (a un humano real nadie lo
      // re-sortea — 04-ago). Cubre el retrofit de INTEXGROUP/Castro y el caso
      // "el cliente dio el RUT después de entregado el lead calificado".
      let ownerHeredado = ""
      if (!esDeVicky && getEnv("VICKY_CRM_HITOS_CONVERTIR_AJENOS") !== "on") {
        if (!escaleraExistente) {
          // Lead de un humano sin escalera: no se pisa su gestión — solo status y nota.
          const { agregarNotaLead } = await import("./zoho-leads")
          await agregarNotaLead(
            lead.id,
            `Vicky: hito "${hito}" en WhatsApp`,
            `Vicky detectó el hito "${hito}" conversando con este lead por WhatsApp. Según el diccionario correspondería un deal en "${piso}"; no se creó automáticamente porque el lead tiene dueño humano.`,
          ).catch(() => false)
          return
        }
        ownerHeredado = lead.ownerId
      }
      if (!tieneIdentidadComercial(lead, datos)) {
        console.log(`[crm-hitos] ${clean}: hito "${hito}" sin empresa/RUT — lead ${lead.id} espera identidad para convertir (deal pendiente)`)
        return
      }
      // Candado cruzado: la emisión pudo haber creado SU deal hace segundos
      // (con OTRO lead convertido). Convertir este lead con un deal propio
      // duplicaba — se reusa el existente y este lead queda solo con status.
      const dealCruzado = await dealActivoEnKv(clean)
      if (dealCruzado) {
        console.log(`[crm-hitos] ${clean}: deal ${dealCruzado} recién creado por la otra puerta (candado kv) — hito "${hito}" sube el piso, lead ${lead.id} no convierte deal propio`)
        await avanzarDealHasta(dealCruzado, piso, Boolean(await dealAReactivar(clean)))
        await actualizarNotaTranscripcion(dealCruzado, clean)
        return
      }
      if (dealSoloConFormal(territorioDeContacto(clean), hito) && !escaleraExistente) {
        await dejarLeadPreFormal(lead, clean, hito, ownerForzadoId, opts.sorteoInmediato)
        return
      }
      const dealNuevo = await convertirConDeal(
        lead,
        clean,
        piso,
        ownerForzadoId || ownerHeredado || undefined,
        opts.sorteoInmediato || (escaleraExistente && !ownerHeredado),
        opts.entregarComoLead,
      )
      if (dealNuevo) await actualizarNotaTranscripcion(dealNuevo, clean)
      return
    }

    // Lead ya convertido: ubicar el deal y subirlo al piso.
    let dealId = lead.dealId
    if (!dealId && lead.contactId) {
      const deal = await dealVivoDelContacto(lead.contactId)
      dealId = deal?.id || null
    }
    // Reglas 4/6 (doc David): deal en Cierre Perdido o en 8. Facturando →
    // el re-contacto RENACE como lead nuevo en etapa 1 (nueva oportunidad).
    if (await reglasRecontactoActivas()) {
      const { h, api } = await zohoHeaders()
      const idParaEstado = dealId || lead.dealId
      let stageActual = ""
      if (idParaEstado) {
        const rEstado = await fetch(`${api}/crm/v3/Deals/${idParaEstado}?fields=Stage,Owner`, { headers: h, cache: "no-store" })
        const dEstado = ((await rEstado.json().catch(() => ({}))) as { data?: Array<{ Stage?: string; Owner?: { id?: string } }> }).data?.[0]
        stageActual = String(dEstado?.Stage || "")
        // EXCEPCIÓN DE CAMPAÑA (Lalo 03-sep): si el contacto está marcado para
        // reactivación, su deal perdido NO renace como lead nuevo — se revive
        // el mismo deal, con su dueño intacto, y la cotización queda asociada
        // ahí. Solo aplica a Cierre Perdido: un cliente en 8. Facturando sigue
        // renaciendo como oportunidad nueva, que es lo correcto.
        const reactivar = await dealAReactivar(clean)
        if (reactivar && stageActual === "Cierre Perdido") {
          console.log(`[crm-hitos] ${clean}: campaña de reactivación — se revive el deal ${idParaEstado} (dueño intacto)`)
        } else if (stageActual === "Cierre Perdido" || stageActual === "8. Facturando") {
          const { setKvValue } = await import("./supabase-persistence-v3")
          await setKvValue(`zoho_lead_${clean}`, "").catch(() => {})
          const { createZohoLead } = await import("./zoho-leads")
          const nuevo = await createZohoLead({
            contactoWA: clean, telefono: clean, nombre: datos.nombre,
            empresa: datos.empresa, email: datos.email, trabajadores: datos.empleados,
          })
          if (nuevo.success) console.log(`[crm-hitos] ${clean}: lead renacido ${nuevo.leadId} (deal en "${stageActual}", reglas 4/6)`)
          return
        }
        // Regla 5: deal ACTIVO → re-notificar al dueño del deal, sin crear nada.
        const { agregarNotaLead } = await import("./zoho-leads")
        await fetch(`${api}/crm/v3/Notes`, {
          method: "POST", headers: h, cache: "no-store",
          body: JSON.stringify({ data: [{
            Note_Title: "El cliente volvió a escribirle a Vicky",
            Note_Content: `Re-contacto por WhatsApp (hito: ${hito}). El cliente retomó la conversación; este deal es tuyo y no se creó ninguno nuevo. Transcripción actualizada en las notas.`,
            Parent_Id: idParaEstado, $se_module: "Deals",
          }] }),
        }).catch(() => null)
        void agregarNotaLead
      }
    }
    if (!dealId) {
      // EL DEAL DEL CONTACTO PUEDE ESTAR A LA VISTA (05-sep, prueba E2E de
      // Lalo): un comprobante de pago resolvió por teléfono un lead viejo
      // (2023) cuyo contacto no tenía deals, y "renació" un lead nuevo y lo
      // mandó a la tómbola SDR — para un cliente que acababa de PAGAR una
      // cotización con deal propio. Antes de renacer se mira lo que la
      // conversación ya sabe: el deal del puntero de cotización y el candado
      // deal_fono_. Si existe, el hito sube ese deal y no crea nada.
      try {
        const { getQuotePointers } = await import("./supabase-persistence-v3")
        const punteros = await getQuotePointers(clean).catch(() => [])
        const delPuntero = punteros.find((p) => (p.dealId || "").trim())?.dealId || ""
        const delCandado = delPuntero ? "" : (await dealActivoEnKv(clean)) || ""
        const conocido = (delPuntero || delCandado).trim()
        if (conocido && /^\d{10,}$/.test(conocido)) {
          dealId = conocido
          console.log(`[crm-hitos] ${clean}: lead ${lead.id} convertido sin deal propio, pero el contacto tiene deal ${dealId} (${delPuntero ? "cotización" : "candado kv"}) — se usa ese, no renace`)
        }
      } catch { /* best-effort */ }
    }
    if (!dealId && hito === "aceptada") {
      // Un pago sin deal a la vista no es una oportunidad nueva: es un
      // registro que falta. Se avisa en log y NO se fabrica un lead.
      console.warn(`[crm-hitos] ${clean}: hito "aceptada" sin deal conocido — no se renace lead por un pago; revisar puntero de cotización`)
      return
    }
    if (!dealId) {
      // LEAD CONVERTIDO Y SIN DEAL VIVO: el hito se perdía en silencio (caso
      // Eduardo 14-ago, callback de 70 empleados: su solicitud no dejó NADA
      // en el CRM porque su lead de 2023 estaba convertido y su deal ya no
      // existía). Es la misma situación de las reglas 4/6 —la oportunidad
      // anterior terminó— así que el re-contacto RENACE como lead nuevo en
      // etapa 1 en vez de evaporarse. Sin esto, un cliente que cotizó hace
      // un año y vuelve queda sin registro y nadie lo llama.
      if (await reglasRecontactoActivas()) {
        const { setKvValue } = await import("./supabase-persistence-v3")
        await setKvValue(`zoho_lead_${clean}`, "").catch(() => {})
        const { createZohoLead } = await import("./zoho-leads")
        const renacido = await createZohoLead({
          contactoWA: clean,
          telefono: clean,
          nombre: datos.nombre,
          empresa: datos.empresa,
          email: datos.email,
          trabajadores: datos.empleados,
        })
        if (renacido.success && renacido.leadId) {
          console.log(
            `[crm-hitos] ${clean}: lead renacido ${renacido.leadId} (el anterior estaba convertido y sin deal vivo)`,
          )
          // El lead renacido sigue el MISMO camino que uno nuevo (pregunta de
          // Lalo 14-ago: "¿este lead pasará a la tómbola?"). Si no continuara,
          // quedaría huérfano con el dueño por defecto: calificado (con N)
          // → deal + tómbola de deals; sin N → tómbola de calificación. La
          // ficha se arma con lo que trae el hito: el lead acaba de nacer.
          const leadRenacido = {
            id: String(renacido.leadId),
            ownerId: "",
            status: "1. No contactado",
            company: datos.empresa || "",
            empleados: datos.empleados || 0,
            email: datos.email || "",
            lastName: datos.nombre || "",
            rut: datos.rut || "",
            ultimaActividad: "",
            motivoNoCalificado: "",
            convertido: false,
            dealId: null,
            contactId: null,
            accountId: null,
          } as typeof lead
          if (dealSoloConFormal(territorioDeContacto(clean), hito)) {
            await dejarLeadPreFormal(leadRenacido, clean, hito, ownerForzadoId, opts.sorteoInmediato)
            return
          }
          const dealRenacido = await convertirConDeal(
            leadRenacido,
            clean,
            piso,
            ownerForzadoId || undefined,
            opts.sorteoInmediato,
            opts.entregarComoLead,
          )
          if (dealRenacido) await actualizarNotaTranscripcion(dealRenacido, clean)
          return
        }
        console.warn(`[crm-hitos] ${clean}: no se pudo renacer el lead sin deal vivo`)
      }
      console.log(`[crm-hitos] ${clean}: lead ${lead.id} convertido sin deal vivo — hito "${hito}" sin destino`)
      return
    }
    await avanzarDealHasta(dealId, piso, Boolean(await dealAReactivar(clean)))
    await actualizarNotaTranscripcion(dealId, clean)
    // Umbral 08-ago: si el deal EXISTENTE seguía esperando con Vicky (u otro
    // interino) y este hito promete ejecutivo (sorteoInmediato), la tómbola
    // corre ahora — el caso "cotizó con 15, hoy dice que son 30" no puede
    // quedar esperando el reloj de 120'. Dueño humano real jamás se pisa.
    if (opts.sorteoInmediato) {
      try {
        const { h, api } = await zohoHeaders()
        const rOwner = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner`, { headers: h, cache: "no-store" })
        const ownerId = String(
          ((await rOwner.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string } }> }).data?.[0]?.Owner?.id || "",
        )
        if (ownerId && INTERINOS.has(ownerId)) {
          await aplicarTombolaDeals(String(dealId), territorioDeContacto(clean) || "Chile")
          console.log(`[crm-hitos] ${clean}: deal ${dealId} esperaba en interino — sorteado por derivación sobre-umbral`)
        }
      } catch { /* best-effort: el reloj de traspaso sigue de respaldo */ }
    }
  } catch (e) {
    console.warn("[crm-hitos] excepción:", e instanceof Error ? e.message : e)
  }
}
