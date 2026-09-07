/**
 * Tool: generar_link_cotizadora
 *
 * Crea la cotización en Zoho a través de la cotizadora (endpoint create-from-vicky)
 * y devuelve tanto pdfUrl como acceptanceUrl.
 *
 * Acepta IDs opcionales (accountId, contactId, leadId) cuando Vicky ya identificó
 * al prospect via buscar_prospect_en_zoho. En ese caso, el endpoint reusa esos IDs
 * en lugar de crear duplicados. Si pasa leadId, el endpoint convierte el Lead a
 * Account+Contact+Deal usando los datos nuevos (datos nuevos ganan).
 *
 * Scope: 1-50 trabajadores.
 *
 * Instalación de hardware:
 *   Cuando la cotización incluye hardware, requiere el array `puntosInstalacion`.
 *   La lógica es idéntica a `cotizar_referencial` y los items resultantes se
 *   envían al endpoint create-from-vicky como líneas con tipo "servicio".
 */

/** Plantilla aprobada por Meta para entregar la cotización con botón. */
const PLANTILLA_ENTREGA = (process.env.VICKY_PLANTILLA_ENTREGA || "vicky_cotizacion_pago_mkt").trim()

import {
  ARRIENDO_RECARGO_REGIONES_UF,
  getModuloDisponibleParaVicky,
  getHardwareDisponibleParaVicky,
  getServiciosAplicablesConHardware,
  obtenerPrecioServicio,
  obtenerTierAplicable,
  validarRangoModulo,
  esRelojDePared,
} from "@/lib/catalogo"
import { anotarTablaPrecios } from "@/lib/nota-tabla-precios"
import { clasificarUbicacion } from "@/lib/geografia"
import { esInstalacionBonificada } from "@/lib/catalogo/servicios"
import { getUFActual } from "@/lib/uf"
import { rutValido, formatearRut } from "@/lib/rut"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { updateZohoLeadOwner } from "@/lib/zoho-leads"
import { getZohoAccessToken } from "@/lib/zoho-token"

const SUPABASE_URL_GLC = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY_GLC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API_DOMAIN_GLC = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE_GLC = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

/**
 * REGLA DE ASIGNACIÓN (Lalo, 27-jul): la reunión de un cliente con cotización
 * es del DUEÑO del deal. Esta es la dirección "cotización después de la
 * reunión": si el contacto ya tiene una reunión FUTURA agendada con un KAM del
 * round-robin, al emitirse la cotización el lead de esa reunión se reasigna al
 * dueño de la cotización y el equipo recibe el aviso para mover la invitación
 * de Cal.com (el host no se puede mover por API). Best-effort: nunca afecta la
 * emisión de la cotización.
 */
async function alinearReunionExistente(telefono: string, quoteId: string): Promise<void> {
  try {
    if (!SUPABASE_URL_GLC || !SUPABASE_KEY_GLC || !quoteId) return
    const contact = (telefono || "").replace(/\D/g, "")
    if (!contact) return
    const res = await fetch(
      `${SUPABASE_URL_GLC}/rest/v1/vic_v3_meetings?contact=eq.${contact}&status=eq.scheduled` +
        `&start_at=gt.${new Date().toISOString()}&select=booking_uid,start_at,organizer_email,zoho_lead_id,prospect_name` +
        `&order=start_at.asc&limit=1`,
      {
        headers: { apikey: SUPABASE_KEY_GLC, Authorization: `Bearer ${SUPABASE_KEY_GLC}` },
        cache: "no-store",
      },
    )
    if (!res.ok) return
    const reunion = ((await res.json().catch(() => [])) as Array<{
      booking_uid: string
      start_at: string
      organizer_email: string | null
      zoho_lead_id: string | null
      prospect_name: string | null
    }>)[0]
    if (!reunion) return

    const token = await getZohoAccessToken()
    const coql = await fetch(`${ZOHO_API_DOMAIN_GLC}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select Owner.email, Owner.full_name from ${QUOTE_MODULE_GLC} where id = '${quoteId}'`,
      }),
      cache: "no-store",
    })
    if (!coql.ok) return
    const rows = ((await coql.json().catch(() => null))?.data || []) as Array<Record<string, string>>
    const duenoEmail = (rows[0]?.["Owner.email"] || "").trim()
    const duenoNombre = (rows[0]?.["Owner.full_name"] || duenoEmail.split("@")[0]).trim()
    if (!duenoEmail || duenoEmail === (reunion.organizer_email || "").trim()) return

    let leadReasignado = false
    if (reunion.zoho_lead_id) {
      const upd = await updateZohoLeadOwner(reunion.zoho_lead_id, duenoEmail).catch(() => ({ success: false }))
      leadReasignado = !!upd.success
    }
    await avisarEquipoInterno(
      `\u26a0\ufe0f Cotización emitida para un cliente con REUNIÓN ya agendada\n` +
        `Cliente: ${reunion.prospect_name || contact}\n` +
        `Reunión: ${reunion.start_at} — asignada por Cal.com a ${reunion.organizer_email || "(sin organizador)"}\n` +
        `Dueño de la cotización: ${duenoNombre} (${duenoEmail}) — quote ${quoteId}\n` +
        `Lead de la reunión ${leadReasignado ? `reasignado a ${duenoNombre}` : "NO se pudo reasignar (revisar a mano)"}. ` +
        `Falta mover la invitación en Cal.com (booking ${reunion.booking_uid}).`,
    )
  } catch (e) {
    console.warn("[generar_link_cotizadora] alinearReunionExistente falló:", e)
  }
}

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const SCOPE_MAX_USUARIOS = 50
// MODELO 06-ago (Lalo): la emisión ya NO sortea — si el cotizador no trae un
// dueño humano real (herencia/ptv/manual), el deal está ESPERANDO en Vicky y
// nadie debe ser presentado al cliente: Vicky sigue a cargo hasta que los
// relojes de traspaso asignen. Este texto se lo dice al modelo tal cual.
const EJECUTIVO_DEFAULT = "Vicky (sin ejecutivo asignado aún — tú sigues a cargo; no presentes a nadie)"
const IVA_RATE = 0.19

// Sectores válidos (espejo del prompt y de la picklist de Zoho).
const SECTORES_VALIDOS = [
  "1. Agrícola",
  "2. Condominio",
  "3. Construcción",
  "4. Inmobilaria",
  "5. Consultoria",
  "6. Banca y Finanzas",
  "7. Educación",
  "8. Municipio",
  "9. Gobierno",
  "10. Mineria",
  "11. Naviera",
  "12. Outsourcing Seguridad",
  "12. Outsourcing General",
  "13. Outsourcing Retail",
  "14. Planta Productiva",
  "15. Logistica",
  "16. Retail Enterprise",
  "17. Retail SMB",
  "18. Salud",
  "19. Servicios",
  "20. Transporte",
  "21. Turismo, Hotelería y Gastronomía",
] as const

type SectorValido = typeof SECTORES_VALIDOS[number]

// Se mantiene el nombre por compatibilidad con quien la importa, pero ahora
// delega en la fuente única con caché (lib/uf.ts): mismo valor en todo el flujo.
export async function getUFActualSafe(): Promise<number> {
  return getUFActual()
}

export const generarLinkCotizadoraSchema = {
  name: "generar_link_cotizadora",
  description:
    "Crea la cotización formal en Zoho CRM, genera el PDF de propuesta y, SI hay correo, se lo envía al cliente. `contactoEmail` es OPCIONAL (Lalo 31-ago): con el RUT basta para emitir — sin correo la entrega corre por este mismo WhatsApp (tu mensaje con el link + el PDF que adjunta el sistema) y el correo se lo pide el formulario de facturación al aceptar. Devuelve dos enlaces: pdfUrl (el PDF descargable) y acceptanceUrl (la página web para aceptar). Úsala apenas el cliente entregue el RUT tras mostrar el precio (con o sin correo): esa entrega ES la confirmación implícita (política 24-jul) — no hagas preguntas de confirmación adicionales. NO la uses si el cliente está rechazando ni antes de que haya visto un precio. Si la cotización incluye hardware, requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un reloj). Normalmente NO necesitas pasar IDs de Zoho: el backend deduplica por RUT — si la empresa ya existe asocia la cotización a su cuenta, y si no la crea. EXCEPCIÓN (conversaciones que iniciaste tú, con bloque '[Datos del formulario web: ... zohoLeadId ...]'): pasa `leadId` = ese zohoLeadId para que el lead original se CONVIERTA en cuenta+contacto+deal con la cotización asociada, sin duplicados.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: {
        type: "string" as const,
        description:
          "Razón social — SOLO si el cliente la dijo espontáneamente (NUNCA se la preguntes — regla Lalo 13-ago). Si no la tienes, OMITE el campo: el sistema resuelve la razón social oficial desde el RUT (padrón SII) y, si es persona natural, usa su nombre.",
      },
      contacto: { type: "string" as const, description: "Nombre del contacto", minLength: 1 },
      contactoEmail: { type: "string" as const, description: "Email del contacto", format: "email" },
      contactoTelefono: { type: "string" as const, description: "Teléfono con +código país" },
      rutEmpresa: { type: "string" as const, description: "RUT empresa o persona natural" },
      direccionEmpresa: {
        type: "string" as const,
        description: "Dirección (calle y número) de la empresa, para emitir la cotización. Pregúntala al prospecto.",
      },
      comunaEmpresa: {
        type: "string" as const,
        description: "Comuna de la empresa, para emitir la cotización.",
      },
      regionEmpresa: {
        type: "string" as const,
        description: "Región de la empresa, para emitir la cotización.",
      },
      userCount: {
        type: "number" as const, minimum: 1, maximum: SCOPE_MAX_USUARIOS,
        description: "Cantidad de trabajadores (1-50)",
      },
      sectorEmpresa: {
        type: "string" as const,
        enum: SECTORES_VALIDOS as unknown as string[],
        description:
          "OPCIONAL — el rubro NO es requisito para cotizar y NO debe pedirse al prospecto. Dedúcelo del nombre SOLO si es obvio y debe ser exactamente uno de los valores del enum. Si no es claro, OMÍTELO: el sistema usa '19. Servicios' automáticamente.",
      },
      modulos: {
        type: "array" as const, items: { type: "string" as const },
        description: "IDs de módulos confirmados (deben estar en catálogo). Siempre incluir 'asistencia' como base.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "number" as const, minimum: 1 },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "POR DEFECTO 'arriendo'. El reloj se cotiza SIEMPRE arrendado; usa 'venta' ÚNICAMENTE si el cliente pidió COMPRARLO de forma explícita en la conversación. Nunca elijas 'venta' por tu cuenta, ni para comparar, ni porque el cliente pregunte cuánto vale el reloj. Ante la duda, omite el campo.",
            },
          },
          required: ["id"],
        },
      },
      evidenciaEleccionReloj: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (copiada literal de su mensaje, sin parafrasear ni corregir) donde eligió el reloj o el mixto — ej: 'me interesa con ambos', 'quiero el reloj', 'la primera opción'. El sistema verifica que exista palabra por palabra en la conversación; sin esa cita la cotización con hardware se rechaza. Si el cliente aún no ha elegido, NO cotices con hardware: pregúntale el marcaje.",
      },
      evidenciaUbicacion: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (literal) donde dijo la comuna/ubicación del punto — ej: 'no disculpa es para olmué', 'estamos en Renca'. Sin esa cita (o sin que la comuna aparezca en sus mensajes) la cotización con hardware se rechaza.",
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: {
              type: "string" as const,
              description:
                "Ubicación del punto, tal como la entregó el prospecto (comuna, región, ordinal, etc.). La tool clasifica internamente RM vs regiones.",
            },
            autoInstalada: {
              type: "boolean" as const,
              description:
                "true si el prospecto instalará por su cuenta (sin cobro de instalación, con advertencias; el envío se cobra igual). false si la realiza GeoVictoria.",
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad del reloj de ESTE punto: 'arriendo' o 'venta' (compra). Determina la tarifa de envío e instalación del punto. Si toda la cotización es de una sola modalidad, puedes omitirlo (se infiere del hardware); si hay relojes en arriendo Y compra en distintos puntos, es OBLIGATORIO indicarlo por punto.",
            },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description:
          "Lista de puntos físicos de instalación. OBLIGATORIO si la cotización incluye hardware. Una entrada por punto, no por reloj. El envío y la instalación se cobran por punto.",
      },
      accountId: {
        type: "string" as const,
        description:
          "Opcional. No es necesario pasarlo: el backend deduplica por RUT (si la empresa ya existe, asocia la cotización a su cuenta). Déjalo vacío.",
      },
      contactId: {
        type: "string" as const,
        description:
          "ID del Contact existente en Zoho. Solo pasarlo si el Contact pertenece a la misma Account que estás usando (o si vas a reasignarlo). Si lo pasas, el endpoint NO crea Contact nuevo.",
      },
      leadId: {
        type: "string" as const,
        description:
          "ID de un Lead no convertido en Zoho. Si lo pasas, el endpoint convierte el Lead a Account+Contact+Deal usando los datos nuevos que enviaste (datos nuevos ganan). NO pasar simultáneamente con accountId/contactId.",
      },
      escalonDescuento: {
        type: "number" as const,
        minimum: 0,
        description:
          "Descuento negociado en el preform. Si el cliente ACEPTÓ un descuento durante la negociación (consultar_descuento_referencial), pasá el `escalon_actual` que devolvió la consulta que el cliente aceptó: la cotización se generará YA con ese descuento (un solo PDF, con el precio acordado). Si no hubo descuento, omití este campo.",
      },
    },
    required: ["contacto", "rutEmpresa", "userCount", "modulos"],
  },
}

export type PuntoInstalacionInput = {
  ubicacion: string
  autoInstalada: boolean
  /** Modalidad del reloj del punto. Si se omite, se infiere del hardware. */
  modalidad?: "arriendo" | "venta"
}

export type LinkCotizadoraInput = {
  empresa?: string
  contacto: string
  /** Opcional (Lalo 03-ago): sin correo la formal se emite igual y la entrega
   *  corre por WhatsApp (PDF + link); el cotizador omite el envío de email. */
  contactoEmail?: string
  contactoTelefono?: string
  rutEmpresa: string
  direccionEmpresa?: string
  comunaEmpresa?: string
  regionEmpresa?: string
  userCount: number
  sectorEmpresa: SectorValido | string
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
  accountId?: string
  contactId?: string
  leadId?: string
  escalonDescuento?: number
  // IDs del Borrador negociado en el preform. Los inyecta el agent-loop desde
  // la persistencia por contacto (no los pasa el modelo). Si vienen, el endpoint
  // reusa ese Borrador y lo finaliza (PDF + correo + "Enviada") en vez de crear
  // una cotización nueva.
  /** Cap de dotación por CANAL (interno, no está en el input_schema): el
   * agente del editor pasa 8000 (rango calculadora de Nacho). */
  _maxUsuariosOverride?: number
  /** Canal EJECUTIVO (interno): acepta "RM"/"Región" a secas como ubicación de
   * un punto — como la calculadora de Nacho (Eddyluz 12-ago). El genérico
   * "Región" cobra la tarifa de resto de regiones con advertencia visible. */
  _zonaGenericaOk?: boolean
  /** Canal EJECUTIVO (interno): honra precioUnitUF por ítem de hardware
   * (override del vendedor, ej. reloj a 0,3 UF). */
  _preciosOverrideOk?: boolean
  /** Canal EJECUTIVO (interno): la emisión NO envía el correo al cliente —
   * la entrega es siempre un botón humano (principio 4; Lalo 11-ago: "deja
   * de enviar cotizaciones automáticamente desde la cotizadora"). */
  _sinCorreoCliente?: boolean
  _draftQuoteId?: string
  _draftDealId?: string
  _draftAccountId?: string
  _draftContactId?: string
  // Asignación MANUAL del deal (solo flujos admin, jamás el modelo): id de
  // usuario Zoho que queda como dueño SIN pasar por la tómbola. Para el caso
  // "el ejecutivo ya atendió al cliente por otro canal y pide la cotización a
  // su nombre" — el correo y el PDF lo presentan a él.
  _ownerOverrideId?: string
}

/**
 * Tramo de la escalera de precios de un módulo, tal como viaja a la cotizadora.
 *
 * La NDV de Creator imprime la escalera COMPLETA y resalta el tramo que aplica
 * (ver las notas de venta de referencia): sin ella el PDF muestra una sola fila
 * y Creator no puede redactar la descripción del ítem. El catálogo vive acá, así
 * que la escalera se manda desde acá — la cotizadora no tiene una copia que se
 * pueda desincronizar. OJO: los precios de Vicky NO son los de la plantilla
 * "Asistencia" de Creator (Vicky vende más barato), así que la tabla se manda
 * inline y jamás por plantilla.
 */
export type TramoEscalera = {
  desde: number
  hasta: number
  modalidad: "fijo" | "por_usuario"
  precioUF: number
}

type ItemCotizacion = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string
  /** Escalera completa del módulo. Solo para tipo "modulo". */
  escalera?: TramoEscalera[]
  // Solo para tipo "servicio" de instalación: indica si la tarifa aplicada
  // corresponde a Región Metropolitana o regiones. La cotizadora lo persiste
  // y lo usa para decidir descuentos de instalación.
  zonaTarifa?: "RM" | "regiones"
  /** Bonificación por línea (ej. envío arriendo 0,5 UF → $0 con −100%): el
   * subtotal viaja en 0 y el PDF tacha el precio de lista. */
  descuentoPct?: number
}

export type LinkCotizadoraResultado =
  | {
      ok: true
      pdfUrl: string
      acceptanceUrl: string
      codigoCorto: string
      linkCorto: string
      /** true = el link ya salió en la plantilla con botón; no repetirlo como texto. */
      plantillaEnviada: boolean
      quoteId: string
      dealId: string
      accountId: string
      contactId: string
      ejecutivoAsignado: string
      totalUF: number
      totalCLP: number
      advertencias: string[]
      reuse: {
        accountReused: boolean
        contactReused: boolean
        leadConverted: boolean
      }
    }
  | { ok: false; error: string }

/** Valor de REFERENCIA del envío en arriendo (lista comercial de Nacho:
 * envío arriendo 0,5 UF) — se muestra TACHADO con −100% en la cotización;
 * el cobro real sigue incluido en la tarifa de arriendo por zona (13-ago). */
export const ENVIO_ARRIENDO_REFERENCIA_UF = 0.5

// Consolida líneas idénticas (mismo tipo, id, nombre, modalidad, precio
// unitario y zona) en una sola fila, sumando cantidad y subtotal. Evita que,
// por ejemplo, 4 instalaciones idénticas (mismo punto) aparezcan como 4 filas
// repetidas en la cotización y el PDF. No altera totales.
export function consolidarLineasIguales(items: ItemCotizacion[]): ItemCotizacion[] {
  const porClave = new Map<string, ItemCotizacion>()
  const orden: string[] = []
  for (const it of items) {
    const clave = [
      it.tipo,
      it.id,
      it.nombre,
      it.modalidad,
      it.precioUnitarioUF,
      it.zonaTarifa ?? "",
      it.descuentoPct ?? 0,
    ].join("||")
    const existente = porClave.get(clave)
    if (existente) {
      existente.cantidad += it.cantidad
      existente.subtotalUF = Number((existente.subtotalUF + it.subtotalUF).toFixed(3))
    } else {
      porClave.set(clave, { ...it })
      orden.push(clave)
    }
  }
  return orden.map((c) => porClave.get(c) as ItemCotizacion)
}

export type ConstruirItemsArgs = {
  userCount: number
  modulos: string[]
  /** Canal ejecutivo: "Región" a secas vale como ubicación (tarifa resto). */
  zonaGenericaOk?: boolean
  /** Canal ejecutivo: honra `precioUnitUF` por ítem de hardware (override
   * libre >0 con advertencia bajo lista×0,75 — paridad con la Cotizadora de
   * Ejecutivos, pedido Lalo 11-ago: "los relojes a 0,3 UF"). Sin el flag,
   * los overrides se IGNORAN (Vicky con clientes jamás repreciar). */
  preciosOverrideOk?: boolean
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta"; precioUnitUF?: number }>
  puntosInstalacion?: PuntoInstalacionInput[]
}

export type ConstruirItemsResult =
  | { ok: true; items: ItemCotizacion[]; advertencias: string[] }
  | { ok: false; error: string }

// Arma las líneas de la cotización (módulos + hardware + instalaciones) a partir
// de los parámetros. Lo usan tanto generar_link_cotizadora (para crear la
// cotización formal) como consultar_descuento_referencial (para previsualizar el
// descuento en el preform), de modo que el preview y la cotización final tengan
// ítems idénticos. Aplica la consolidación de líneas repetidas.
export function construirItemsCotizacion(args: ConstruirItemsArgs): ConstruirItemsResult {
  const { userCount, modulos = [], hardware = [], puntosInstalacion = [] } = args

  const items: ItemCotizacion[] = []
  const advertencias: string[] = []

  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]
  for (const moduloId of modulosConBase) {
    const modulo = getModuloDisponibleParaVicky(moduloId)
    if (!modulo) {
      return { ok: false, error: `Módulo '${moduloId}' no está habilitado para Vicky.` }
    }
    const rangoError = validarRangoModulo(modulo, userCount)
    if (rangoError) { advertencias.push(rangoError); continue }
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) continue
    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotalUF = tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF
    items.push({
      tipo: "modulo", id: modulo.id, nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitarioUF: tier.precioUF,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
      escalera: modulo.tiers.map((t) => ({
        desde: t.minUsuarios,
        hasta: t.maxUsuarios,
        modalidad: t.modalidad,
        precioUF: t.precioUF,
      })),
    })
  }

  // ACCESORIOS (tarjetas de proximidad, 01-sep): acompañan al reloj como
  // venta única. NO cuentan para puntos/envío/instalación ni arriendo por
  // zona, y SOLOS no se cotizan (sin reloj no hay lector que las lea).
  const hayAccesorios = hardware.some((hw) => getHardwareDisponibleParaVicky(hw.id)?.esAccesorio === true)
  const hardwareEquipos = hardware.filter((hw) => getHardwareDisponibleParaVicky(hw.id)?.esAccesorio !== true)
  if (hayAccesorios && !hardwareEquipos.some((hw) => esRelojDePared(hw.id))) {
    return {
      ok: false,
      error:
        "Los accesorios (tarjetas de proximidad, impresora térmica) solo acompañan a un reloj control físico de pared. " +
        "Cotízalos junto al reloj, o agrega el reloj a la configuración.",
    }
  }
  // Accesorio con arriendo disponible (impresora): sigue la modalidad del reloj.
  const relojEnArriendo = hardwareEquipos.some((hw) => (hw.modalidad ?? "arriendo") === "arriendo")

  let hayHardware = false
  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) return { ok: false, error: `Hardware '${hw.id}' no está habilitado para Vicky.` }
    const esAccesorio = dispositivo.esAccesorio === true
    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadAccesorio: "arriendo" | "venta" =
      relojEnArriendo && dispositivo.modalidadesDisponibles.includes("arriendo") ? "arriendo" : "venta"
    const modalidadElegida: "arriendo" | "venta" = hw.modalidad ?? (esAccesorio ? modalidadAccesorio : "arriendo")
    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return { ok: false, error: `${dispositivo.displayName} no disponible en modalidad '${modalidadElegida}'` }
    }
    if (modalidadElegida === "venta" && !esAccesorio) {
      // Vicky NUNCA propone venta por su cuenta: solo si el cliente pidió
      // comprar. Si esto aparece sin que el cliente lo haya pedido, el modelo
      // se saltó la regla — y la diferencia de precio es enorme (6 UF de una vez
      // contra 0,35 al mes), así que conviene que quede a la vista.
      console.warn(
        `[generar_link_cotizadora] reloj ${dispositivo.id} cotizado en VENTA (${dispositivo.ventaUF} UF). ` +
          "Solo debería ocurrir si el cliente pidió comprarlo explícitamente.",
      )
    }
    const precioLista = modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF
    let precioUnitario = precioLista
    // Override del canal ejecutivo (Lalo 11-ago): precio dictado por el
    // vendedor (ej. reloj a 0,3 UF). Libre sobre 0 — bajo lista×0,75 se
    // acepta igual con ADVERTENCIA visible (mismo criterio que la Cotizadora
    // de Ejecutivos: visibilidad sin bloqueo).
    const override = Number(hw.precioUnitUF)
    if (args.preciosOverrideOk === true && Number.isFinite(override) && override > 0) {
      precioUnitario = Number(override.toFixed(3))
      if (precioLista > 0 && precioUnitario < precioLista * 0.75) {
        advertencias.push(
          `${dispositivo.displayName} (${modalidadElegida}) a ${precioUnitario} UF — bajo el 75% de la lista (${precioLista} UF): permitido, pero revísalo.`,
        )
      }
    }
    if (precioUnitario === 0) return { ok: false, error: `${dispositivo.displayName} sin precio en modalidad '${modalidadElegida}'` }
    items.push({
      tipo: "hardware", id: dispositivo.id, nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitarioUF: precioUnitario,
      subtotalUF: Number((cantidad * precioUnitario).toFixed(3)),
    })
    // Los accesorios no gatillan puntos/envío/instalación: viajan con el reloj.
    if (!esAccesorio) hayHardware = true
  }

  if (hayHardware) {
    if (puntosInstalacion.length === 0) {
      return {
        ok: false,
        error:
          "La cotización incluye hardware pero no se entregó 'puntosInstalacion'. " +
          "Pregunta al prospecto la comuna o región de cada punto antes de generar el link.",
      }
    }

    for (const punto of puntosInstalacion) {
      const c = clasificarUbicacion(punto.ubicacion, { zonaGenericaOk: args.zonaGenericaOk })
      if (c.tipo === "no_clasificable") {
        return {
          ok: false,
          error:
            `No pude clasificar la ubicación '${punto.ubicacion}' (${c.razon}). ` +
            `Pregúntale al prospecto la comuna o región específica y vuelve a llamar la tool.`,
        }
      }
    }

    // Modalidad uniforme del hardware (para inferir la modalidad de cada punto
    // cuando la cotización es de una sola modalidad). Si hay arriendo Y venta a
    // la vez, cada punto debe traer su `modalidad` explícita.
    const modalidadesHw = new Set(
      hardwareEquipos.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"),
    )
    const modalidadUniforme: "arriendo" | "venta" | null =
      modalidadesHw.size === 1 ? [...modalidadesHw][0] : null

    // Hardware plug-and-play (huellero USB): no requiere visita técnica de
    // instalación on-site. Si TODO el hardware de la cotización es de este tipo,
    // el servicio de instalación no se cobra (el envío sí se mantiene). Mismo
    // criterio que cotizar_referencial — cero drift entre estimado y formal.
    const soloHardwareSinInstalacion =
      hardwareEquipos.length > 0 &&
      hardwareEquipos.every((hw) => getHardwareDisponibleParaVicky(hw.id)?.requiereInstalacionOnsite === false)

    const serviciosAplicables = getServiciosAplicablesConHardware()
    for (const punto of puntosInstalacion) {
      const clasificacion = clasificarUbicacion(punto.ubicacion, { zonaGenericaOk: args.zonaGenericaOk })
      if (clasificacion.tipo === "no_clasificable") continue

      if (!clasificacion.reconocida) {
        advertencias.push(
          clasificacion.canonico === "regiones"
            ? `Punto '${punto.ubicacion}' con zona genérica: se aplicó la tarifa de resto de regiones ` +
              `(instalación 5 UF). Si el punto está en IV, V o VI región la tarifa es 3 UF — ajusta con la comuna real.`
            : `Ubicación '${punto.ubicacion}' no reconocida en la lista oficial. ` +
              `Se aplicó tarifa de regiones por defecto. El ejecutivo confirmará al revisar la cotización.`,
        )
      }

      const modalidadPunto = punto.modalidad ?? modalidadUniforme
      if (!modalidadPunto) {
        return {
          ok: false,
          error:
            "La cotización tiene relojes en arriendo Y en compra, así que necesito la modalidad de cada punto. " +
            "Vuelve a llamar la tool indicando `modalidad` ('arriendo' o 'venta') en cada entrada de puntosInstalacion.",
        }
      }

      const esRM = clasificacion.tipo === "RM"
      const zonaPunto = clasificacion.zonaInstalacion
      for (const servicio of serviciosAplicables) {
        // Instalación auto-gestionada por el cliente, o hardware plug-and-play
        // (huellero USB): no se cobra la instalación (solo el envío se mantiene).
        if ((punto.autoInstalada || soloHardwareSinInstalacion) && servicio.omitirSiAutoInstalada) {
          if (punto.autoInstalada) {
            for (const adv of servicio.advertenciasAutoInstalacion) {
              advertencias.push(`Auto-instalación en ${punto.ubicacion}: ${adv}`)
            }
          }
          continue
        }
        const precioUF = obtenerPrecioServicio(servicio, zonaPunto, modalidadPunto)
        // ENVÍO DEL ARRIENDO VISIBLE Y BONIFICADO (Lalo 24-ago, reclamo de
        // Grey/COT798): el despacho sigue incluido en la tarifa de arriendo
        // por zona (13-ago, sin cobro extra), pero ahora la cotización lo
        // MUESTRA como línea con el valor de referencia de la lista comercial
        // (cotizadora de Nacho: envío arriendo 0,5 UF) tachado → $0 −100%,
        // patrón de la Capacitación. Subtotal 0: no cambia ningún total.
        if (precioUF <= 0) {
          if (servicio.id === "envio_reloj" && modalidadPunto === "arriendo") {
            items.push({
              tipo: "servicio",
              id: servicio.id,
              nombre: `${servicio.nombre} (${punto.ubicacion})`,
              modalidad: "Cobro único",
              cantidad: 1,
              precioUnitarioUF: ENVIO_ARRIENDO_REFERENCIA_UF,
              subtotalUF: 0,
              zonaTarifa: esRM ? "RM" : "regiones",
              descuentoPct: 100,
            })
          }
          // Otras combinaciones sin cobro: no se agrega línea.
          continue
        }
        // INSTALACIÓN BONIFICADA — arriendo en RM (Lalo 07-sep): la visita
        // técnica no se cobra; la línea muestra la tarifa de lista TACHADA
        // (−100 %), mismo patrón del envío del arriendo. Subtotal 0.
        const bonificada =
          servicio.id === "instalacion_reloj" && esInstalacionBonificada(modalidadPunto, zonaPunto)
        items.push({
          tipo: "servicio",
          id: servicio.id,
          nombre: `${servicio.nombre} (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitarioUF: precioUF,
          subtotalUF: bonificada ? 0 : Number(precioUF.toFixed(3)),
          zonaTarifa: esRM ? "RM" : "regiones",
          ...(bonificada ? { descuentoPct: 100 } : {}),
        })
      }
    }

    // ── ARRIENDO POR ZONA (Lalo 13-ago) — espejo EXACTO del preform ──
    // Sin envío en arriendo; el arriendo mensual se cobra 0,35 UF en RM y
    // 0,40 UF en regiones (recargo por unidad). Zonas mixtas dividen la línea.
    const zonasPuntosArr = puntosInstalacion
      .map((p) => clasificarUbicacion(p.ubicacion, { zonaGenericaOk: args.zonaGenericaOk }))
      .filter((c) => c.tipo !== "no_clasificable")
      .map((c) => (c.zonaInstalacion === "RM" ? "rm" : "regiones"))
    const puntosRegionesArr = zonasPuntosArr.filter((z) => z === "regiones").length
    // Canal ejecutivo con precios dictados (preciosOverrideOk): el vendedor
    // manda el precio final — sin recargo automático encima.
    if (puntosRegionesArr > 0 && args.preciosOverrideOk !== true) {
      for (let ix = items.length - 1; ix >= 0; ix--) {
        const it = items[ix]
        if (it.tipo !== "hardware" || it.modalidad !== "Arriendo mensual") continue
        // Los accesorios en arriendo (impresora) no llevan recargo de zona.
        if (getHardwareDisponibleParaVicky(it.id)?.esAccesorio === true) continue
        const enRegiones = Math.min(it.cantidad, puntosRegionesArr)
        const enRM = it.cantidad - enRegiones
        const precioReg = Number((it.precioUnitarioUF + ARRIENDO_RECARGO_REGIONES_UF).toFixed(3))
        if (enRM <= 0) {
          it.precioUnitarioUF = precioReg
          it.subtotalUF = Number((it.cantidad * precioReg).toFixed(3))
        } else {
          it.cantidad = enRM
          it.subtotalUF = Number((enRM * it.precioUnitarioUF).toFixed(3))
          items.splice(ix + 1, 0, {
            ...it,
            cantidad: enRegiones,
            precioUnitarioUF: precioReg,
            subtotalUF: Number((enRegiones * precioReg).toFixed(3)),
            nombre: `${it.nombre} (regiones)`,
          })
        }
      }
    }
  }

  if (items.length === 0) return { ok: false, error: "No hay items válidos para cotizar." }

  // Consolidar líneas idénticas (p. ej. instalaciones repetidas del mismo punto).
  const itemsFinal = consolidarLineasIguales(items)
  return { ok: true, items: itemsFinal, advertencias }
}

export async function generarLinkCotizadora(
  args: LinkCotizadoraInput,
): Promise<LinkCotizadoraResultado> {
  const {
    empresa, contacto, contactoEmail, contactoTelefono,
    rutEmpresa, direccionEmpresa, comunaEmpresa, regionEmpresa,
    userCount, sectorEmpresa, modulos = [], hardware = [],
    puntosInstalacion = [],
    accountId, contactId, leadId, escalonDescuento,
    _draftQuoteId, _draftDealId, _draftAccountId, _draftContactId,
    _ownerOverrideId,
  } = args

  if (!contacto?.trim() || !rutEmpresa?.trim()) {
    return { ok: false, error: "Faltan campos obligatorios: contacto, rutEmpresa." }
  }
  // EMPRESA SIN PREGUNTAR (Lalo 13-ago): si el cliente no la mencionó, la
  // razón social se resuelve del padrón SII por el RUT; persona natural o RUT
  // fuera del padrón → nombre de la persona. La conversación jamás se frena.
  let empresaFinal = (empresa || "").trim()
  if (!empresaFinal) {
    try {
      const { fichaEmpresaSii } = await import("@/lib/empresas-sii")
      const ficha = await fichaEmpresaSii(rutEmpresa.trim().toUpperCase().replace(/\./g, ""))
      if (ficha?.razonSocial) empresaFinal = ficha.razonSocial
    } catch { /* fallback abajo */ }
    if (!empresaFinal) empresaFinal = contacto.trim()
  }
  if (contactoEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactoEmail)) {
    return { ok: false, error: `El email '${contactoEmail}' no tiene formato válido.` }
  }
  // Validación del RUT/RUN chileno (módulo 11). Si no pasa, NO generamos la
  // cotización: el modelo debe pedirle al cliente que confirme el RUT correcto.
  if (!rutValido(rutEmpresa)) {
    return {
      ok: false,
      error:
        `El RUT '${rutEmpresa}' no es válido (no pasa el dígito verificador). ` +
        "Pídele al cliente que te confirme su RUT (empresa o persona natural) con el dígito verificador correcto, y NO generes la cotización hasta tener uno válido. No es un error técnico.",
    }
  }
  // Cap por CANAL: Vicky (tool del chat) sigue en 50; el agente del editor
  // (canal ejecutivo) pasa _maxUsuariosOverride=8000 — el rango de la
  // calculadora de Nacho. El override es un campo interno que el modelo no
  // conoce (no está en el input_schema): solo lo pasan llamadores de código.
  const capUsuarios = Math.min(
    Number((args as { _maxUsuariosOverride?: number })._maxUsuariosOverride || SCOPE_MAX_USUARIOS),
    8000,
  )
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > capUsuarios) {
    return { ok: false, error: `userCount=${userCount} fuera de rango 1-${capUsuarios}.` }
  }
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return { ok: false, error: "modulos requerido (mínimo 1)" }
  }
  // IDs efectivos: si existe un Borrador negociado (inyectado por el agent-loop),
  // sus IDs mandan y se reusan para FINALIZAR esa misma cotización en vez de
  // crear una nueva. El Lead, si lo hubo, ya se convirtió al crear el Borrador,
  // así que ignoramos leadId cuando hay Borrador.
  const draftExists = Boolean(_draftQuoteId?.trim() || _draftDealId?.trim())
  const effAccountId = _draftAccountId?.trim() || accountId?.trim() || undefined
  const effContactId = _draftContactId?.trim() || contactId?.trim() || undefined
  const effDealId = _draftDealId?.trim() || undefined
  const effQuoteId = _draftQuoteId?.trim() || undefined
  const effLeadId = draftExists ? undefined : leadId?.trim() || undefined

  // Validación: leadId no puede venir con accountId/contactId (salvo que haya
  // Borrador, donde leadId se descarta arriba).
  if (effLeadId && (effAccountId || effContactId)) {
    return {
      ok: false,
      error: "No pasar leadId junto con accountId/contactId. El leadId convierte el Lead a Account+Contact+Deal; ya no hay IDs previos que reusar.",
    }
  }

  const sectorNormalizado: SectorValido =
    (SECTORES_VALIDOS as readonly string[]).includes(sectorEmpresa)
      ? (sectorEmpresa as SectorValido)
      : "19. Servicios"

  // ── Calcular items (mismo builder que usa la negociación referencial) ──
  const construccion = construirItemsCotizacion({
    userCount, modulos, hardware, puntosInstalacion,
    zonaGenericaOk: args._zonaGenericaOk === true,
    preciosOverrideOk: (args as { _preciosOverrideOk?: boolean })._preciosOverrideOk === true,
  })
  if (!construccion.ok) return { ok: false, error: construccion.error }
  const itemsFinal = construccion.items
  const advertencias = construccion.advertencias

  const subtotalUF = itemsFinal.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActualSafe()
  const totalCLP = Math.round(totalUF * ufActual)

  // Cuerpo de la request (constante entre reintentos).
  const reqBody = JSON.stringify({
    // Canal ejecutivo: la emisión NO manda el correo al cliente (la entrega
    // es un botón humano del editor). Vicky con clientes no pasa el flag y
    // su correo automático sigue igual.
    sinCorreoCliente: (args as { _sinCorreoCliente?: boolean })._sinCorreoCliente === true || undefined,
    cliente: {
      empresa: empresaFinal,
      contacto: contacto.trim(),
      contactoEmail: contactoEmail?.trim() ? contactoEmail.trim().toLowerCase() : undefined,
      contactoTelefono: contactoTelefono?.trim() || "",
      rutEmpresa: formatearRut(rutEmpresa),
      direccionEmpresa: direccionEmpresa?.trim() || "",
      comunaEmpresa: comunaEmpresa?.trim() || "",
      regionEmpresa: regionEmpresa?.trim() || "",
      userCount,
      sectorEmpresa: sectorNormalizado,
    },
    // IDs existentes (opcionales): si se pasan, el endpoint reusa o convierte.
    // Cuando hay Borrador negociado, también van dealId/quoteId para que el
    // endpoint finalice esa misma cotización (no cree una nueva).
    existing: {
      accountId: effAccountId,
      contactId: effContactId,
      dealId: effDealId,
      quoteId: effQuoteId,
      leadId: effLeadId,
      ownerId: _ownerOverrideId?.trim() || undefined,
    },
    // Descuento negociado en el preform (si el cliente aceptó uno): la
    // cotización nace ya con ese descuento, sin regenerar PDF después.
    escalonDescuento:
      typeof escalonDescuento === "number" && escalonDescuento > 0
        ? escalonDescuento
        : undefined,
    cotizacion: {
      items: itemsFinal,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      ivaUF: Number(ivaUF.toFixed(3)),
      totalUF: Number(totalUF.toFixed(3)),
      ufActual: Number(ufActual.toFixed(2)),
      totalCLP,
    },
  })

  type CreateFromVickyResp = {
    ok: boolean
    pdfUrl?: string
    acceptanceUrl?: string
    codigoCorto?: string
    linkCorto?: string
    quoteId?: string
    dealId?: string
    accountId?: string
    contactId?: string
    reuse?: { accountReused?: boolean; contactReused?: boolean; leadConverted?: boolean }
    ejecutivo?: { nombre?: string; email?: string }
    error?: string
    detail?: string
  }

  // Reintento interno (silencioso): el create-from-vicky puede fallar de forma
  // transitoria (latencia de Zoho) o por inconsistencias de dedup que se
  // resuelven al reintentar (el endpoint termina creando registros consistentes
  // en un 2º intento). Reintentamos hasta MAX_INTENTOS para que el cliente NUNCA
  // vea el "tuve un problema" por una falla pasajera. El acceptanceUrl es lo
  // crítico; el pdfUrl puede venir vacío (se genera en segundo plano).
  // AVISO INMEDIATO (Eduardo 17-ago): la emisión demora varios segundos y con
  // la entrega por plantilla el turno termina MUDO — sin este puente el
  // cliente ve puro silencio entre su último dato y la cotización. Se manda
  // directo por Botmaker (no por el reply del modelo) para que salga AHORA.
  // Best-effort: si falla, la emisión sigue igual.
  {
    const fono = (contactoTelefono || "").replace(/\D/g, "")
    if (fono.startsWith("56")) {
      try {
        const { sendBotmakerMessage } = await import("@/lib/botmaker-push-v3")
        void sendBotmakerMessage(fono, "Perfecto, te mando la cotización en seguida.").catch(() => false)
      } catch {}
    }
  }

  const MAX_INTENTOS = 3
  let data: CreateFromVickyResp | null = null
  let lastError = "Respuesta inválida de la cotizadora"
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const response = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: reqBody,
        cache: "no-store",
      })
      if (!response.ok) {
        const errBody = await response.text().catch(() => "")
        lastError = `Cotizadora respondió ${response.status}: ${errBody.slice(0, 200)}`
      } else {
        const parsed = (await response.json()) as CreateFromVickyResp
        if (parsed.ok && parsed.acceptanceUrl) {
          data = parsed
          break
        }
        lastError = parsed.error || parsed.detail || "Respuesta inválida de la cotizadora"
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `No se pudo contactar la cotizadora: ${msg.slice(0, 200)}`
    }
    if (intento < MAX_INTENTOS) {
      console.warn(
        `[generar_link_cotizadora] intento ${intento}/${MAX_INTENTOS} falló (${lastError.slice(0, 140)}); reintentando...`,
      )
      await new Promise((r) => setTimeout(r, 1200 * intento))
    }
  }

  if (!data || !data.acceptanceUrl) {
    return { ok: false, error: lastError }
  }

  // Regla de asignación reunión↔cotización (dirección inversa). Best-effort.
  await alinearReunionExistente(contactoTelefono || "", data.quoteId || "")

  // Nota de auditoría con la tabla de precios ofrecida (Lalo 14-ago): queda
  // en la cotización desde su nacimiento, así nadie tiene que reconstruir a
  // mano qué lista regía cuando el cliente vio ese valor. Best-effort: su
  // falla jamás afecta la emisión ni la respuesta al cliente.
  void anotarTablaPrecios(data.quoteId || "").catch(() => false)

  // ENTREGA POR PLANTILLA CON BOTÓN (Eduardo 17-ago). El link largo con el JWT
  // no cabe en un botón de WhatsApp; el cotizador ahora devuelve `codigoCorto`
  // (`<quoteId>-<firma HMAC>`) y la plantilla `vicky_cotizacion_pago_mkt` lo
  // pega en el botón "Pagar aquí" vía `/q/${codigo}`.
  //
  // Best-effort y NUNCA bloqueante: si el envío falla, `plantillaEnviada` vuelve
  // en false y el modelo entrega el link como texto, como siempre. Un cliente
  // sin su link es lo peor que puede pasar en este punto del flujo.
  // Apagado sin deploy: VICKY_ENTREGA_PLANTILLA=0
  let plantillaEnviada = false
  // APAGADA por defecto (Eduardo 17-ago, tras probarla en vivo): el botón de
  // plantilla obliga al interstitial "¿Deseas abrir este enlace?" de WhatsApp
  // (URL dinámica) y arrastró turno mudo + falsas alarmas. Dentro de la
  // ventana de 24 h la entrega vuelve a ser TEXTO con el LINK CORTO (abre
  // directo, sin diálogo). La plantilla aprobada queda para fuera de ventana.
  const plantillaOn = (process.env.VICKY_ENTREGA_PLANTILLA || "0").trim() === "1"
  const fonoPlantilla = (contactoTelefono || "").replace(/\D/g, "")
  if (plantillaOn && data.codigoCorto && fonoPlantilla.startsWith("56")) {
    try {
      const { sendBotmakerTemplate } = await import("@/lib/botmaker-push-v3")
      // El cuerpo exige {{1}}: sin nombre la plantilla la rechaza WhatsApp, así
      // que va un saludo neutro antes que quedarse sin entregar.
      const nombre = (contacto || "").trim().split(/\s+/)[0] || "hola"
      plantillaEnviada = await sendBotmakerTemplate(fonoPlantilla, PLANTILLA_ENTREGA, {
        nombre,
        codigo: data.codigoCorto,
      })
      // Marca de "la entrega YA salió" (caso Rodrigo 17-ago): una pasada
      // posterior del modelo puede intentar entregar de nuevo — inventando un
      // link que el guardián anti-alucinación reemplaza por "tuve un
      // problema…" — y el cliente ve un error tras una entrega EXITOSA. Con
      // esta marca, el camino de salida bota esos mensajes en silencio.
      if (plantillaEnviada) {
        try {
          const { setKvValue } = await import("@/lib/supabase-persistence-v3")
          await setKvValue(`plantilla_reciente_${fonoPlantilla}`, String(Date.now())).catch(() => {})
        } catch {}
      }
    } catch (e) {
      console.warn(`[generar-link] plantilla de entrega falló: ${e instanceof Error ? e.message : e}`)
    }
  }

  // COMPROBANTE QUE LLEGÓ ANTES DE ESTA FORMAL (05-sep, prueba E6): si el
  // cliente ya pagó con el precio referencial, la formal recién emitida es a
  // la que hay que asociarlo. La tool lo dice en su resultado para que el
  // modelo llame registrar_comprobante_transferencia en ESTE turno y el
  // cliente no quede esperando una verificación que nadie va a hacer.
  let comprobantePendiente: { monto: number; bancoOrigen: string; fechaDetectada: string; detalle: string; hace: string } | null = null
  try {
    const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
    const fonoPend = String(contactoTelefono || "").replace(/\D/g, "")
    const raw = fonoPend ? await getKvValue(`comprobante_pendiente_${fonoPend}`).catch(() => null) : null
    if (raw) {
      const p = JSON.parse(raw) as { at?: string; monto?: number; bancoOrigen?: string; fechaDetectada?: string; detalle?: string }
      const edadMs = Date.now() - Date.parse(p.at || "")
      if (Number.isFinite(edadMs) && edadMs < 48 * 3600_000 && Number(p.monto) > 0) {
        comprobantePendiente = {
          monto: Number(p.monto),
          bancoOrigen: String(p.bancoOrigen || ""),
          fechaDetectada: String(p.fechaDetectada || ""),
          detalle: String(p.detalle || ""),
          hace: `${Math.max(1, Math.round(edadMs / 60000))} min`,
        }
        await setKvValue(`comprobante_pendiente_${fonoPend}`, "").catch(() => {})
      }
    }
  } catch { /* best-effort */ }

  return {
    ok: true,
    ...(comprobantePendiente
      ? {
          comprobantePendiente,
          instruccionObligatoria:
            `El cliente YA mandó un comprobante de transferencia por $${comprobantePendiente.monto.toLocaleString("es-CL")} hace ${comprobantePendiente.hace}, antes de esta cotización formal. ` +
            `Llama AHORA, en este mismo turno, registrar_comprobante_transferencia con montoDetectado=${comprobantePendiente.monto}` +
            (comprobantePendiente.bancoOrigen ? `, bancoOrigen="${comprobantePendiente.bancoOrigen}"` : "") +
            (comprobantePendiente.fechaDetectada ? `, fechaDetectada="${comprobantePendiente.fechaDetectada}"` : "") +
            ` para asociarlo a esta cotización y activar su cuenta. No le pidas que lo reenvíe.`,
        }
      : {}),
    pdfUrl: data.pdfUrl || "",
    acceptanceUrl: data.acceptanceUrl,
    codigoCorto: data.codigoCorto || "",
    // El link que se entrega por chat: corto y sin interstitial. El largo con
    // el token queda de respaldo para cotizaciones viejas sin código.
    linkCorto: data.linkCorto || "",
    plantillaEnviada,
    quoteId: data.quoteId || "",
    dealId: data.dealId || "",
    accountId: data.accountId || "",
    contactId: data.contactId || "",
    ejecutivoAsignado: (data.ejecutivo && data.ejecutivo.nombre) || EJECUTIVO_DEFAULT,
    totalUF: Number(totalUF.toFixed(3)),
    totalCLP,
    advertencias,
    reuse: {
      accountReused: data.reuse?.accountReused || false,
      contactReused: data.reuse?.contactReused || false,
      leadConverted: data.reuse?.leadConverted || false,
    },
  }
}
