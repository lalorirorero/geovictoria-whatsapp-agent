/**
 * Cierre de cadencia + TRASPASO post-pago, compartido por dos vías:
 *
 *   1. Webhook vic-quote-notify (tiempo real): el cotizador avisa al pagar.
 *   2. Barrido horario en vic-deal-stage-cron (red de seguridad): cubre el
 *      caso Constanza/COT233 (20-jul) — el cotizador registró el pago pero el
 *      request al agente nunca salió (faltan VICKY_AGENT_NOTIFY_URL /
 *      VICKY_AGENT_CRON_SECRET en su Vercel) y el cliente quedó sin traspaso
 *      y con la llamada agendada viva.
 *
 * Idempotente: el traspaso se envía UNA vez por cotización (candado kv
 * traspaso_postpago_<quoteId>), venga por la vía que venga.
 */

import {
  appendAssistantV3,
  closeFollowup,
  findContactByQuoteId,
  getKvValue,
  getQuotePointers,
  setKvValue,
} from "./supabase-persistence-v3"
import { sendBotmakerMessage } from "./botmaker-push-v3"
import { PERFIL_CO } from "./paises/co"
import { ownerDeCotizacion } from "./zoho-quote-owner"
import { obtenerLinkOnboarding } from "./tools/registrar-comprobante-transferencia"
import { pagoCierraLoop } from "./loop-v2"
import { claveFase, claveBorrador } from "./onboarding/fase"
import { onboardingActivoPara } from "./onboarding-piloto"
import { entregarKickoffOnboarding } from "./onboarding-envio"

// Los mensajes POST-PAGO son transaccionales (07-sep): el gate de proactividad
// los registra pero no los bloquea. Ver evaluarGateProactividad.
const TRANSACCIONAL = { transaccional: true } as const
import { parsearBorrador, sembrarBorrador, type Borrador } from "./onboarding/borrador"

export type ResultadoTraspaso = {
  contact?: string
  traspaso: "enviado" | "ya_enviado" | "push_fallo" | "omitido" | "sin_contacto" | "sin_link_onboarding" | "omitido_canal_ejecutivo"
}

/**
 * VENTA 100% VICKY (Lalo 31-jul, caso D'amore; destino actualizado 04-ago):
 * si el cliente PAGÓ sin que ningún humano interviniera en la venta (sin
 * traspaso PTV activo), TODOS los registros — cotización, deal, cuenta y
 * contacto — se asignan al dueño de ventas autónomas: hoy ALEYDIS ARAQUE,
 * configurable por vic_kv `owner_venta_autonoma` (gana sobre el env). El
 * mensaje post-pago ahora SÍ la presenta (decisión Lalo 04-ago — ella hace
 * la gestión post-venta). Best-effort: cualquier falla deja todo como estaba.
 */
const OWNER_VENTA_AUTONOMA_DEFAULT = "3525045000583802005" // Aleydis Araque

async function ownerVentaAutonoma(): Promise<string> {
  const kv = (await getKvValue("owner_venta_autonoma").catch(() => null)) || ""
  return kv.trim() || (process.env.VICKY_OWNER_VENTA_AUTONOMA || "").trim() || OWNER_VENTA_AUTONOMA_DEFAULT
}

export type EjecutivoAutonoma = { nombre: string; email: string; telefono: string }

/** Nombre/correo/teléfono del dueño de ventas autónomas desde su ficha de
 * usuario en Zoho — si cambia el dueño en vic_kv, la presentación se adapta
 * sola. Fallback: Aleydis con sus datos verificados (04-ago). */
async function datosOwnerAutonoma(
  ownerId: string,
  H: Record<string, string>,
  api: string,
): Promise<EjecutivoAutonoma> {
  const fallback: EjecutivoAutonoma = {
    nombre: "Aleydis Araque",
    email: "aaraque@geovictoria.com",
    telefono: "+56 9 8291 6868",
  }
  try {
    const r = await fetch(`${api}/crm/v3/users/${ownerId}`, { headers: H, cache: "no-store" })
    if (!r.ok) return fallback
    const u = ((await r.json().catch(() => ({}))) as {
      users?: Array<{ full_name?: string; email?: string; phone?: string; mobile?: string }>
    }).users?.[0]
    if (!u?.email) return fallback
    return {
      nombre: (u.full_name || "").trim() || u.email.split("@")[0],
      email: u.email,
      telefono: (u.phone || u.mobile || "").trim(),
    }
  } catch {
    return fallback
  }
}

/** Usuarios "robot" cuyas notas NO cuentan como gestión del ejecutivo: el
 * usuario Vicky y el token de integración (GeoVictoria Admin). Las notas del
 * ESPEJO las crea el robot pero SÍ cuentan (son el chat real del vendedor):
 * se reconocen por el título "WhatsApp … (espejo…". */
const USUARIOS_ROBOT_NOTAS = new Set(["3525045000484500876", "3525045000000200013"])

/** ¿El ejecutivo HIZO algo en el deal? (Lalo 24-ago) — alguna nota suya (o de
 * cualquier humano) o la nota-espejo de su WhatsApp (vic-espejo-notas-cron la
 * sincroniza cada ~15 min, así que un chat/llamada real del vendedor cuenta
 * solo). Mismo criterio que usa el correo PAGADA del cotizador. */
export async function hayGestionEnDeal(
  dealId: string,
  H: Record<string, string>,
  api: string,
): Promise<boolean> {
  try {
    const r = await fetch(`${api}/crm/v3/Deals/${dealId}/Notes?fields=Note_Title,Created_By&per_page=100`, {
      headers: H,
      cache: "no-store",
    })
    if (!r.ok || r.status === 204) return false
    const notas = ((await r.json().catch(() => ({}))) as {
      data?: Array<{ Note_Title?: string | null; Created_By?: { id?: string } | null }>
    }).data || []
    return notas.some((n) => {
      if (/\(espejo/i.test(String(n.Note_Title || ""))) return true
      const autor = String(n.Created_By?.id || "")
      return Boolean(autor) && !USUARIOS_ROBOT_NOTAS.has(autor)
    })
  } catch {
    return false
  }
}

async function asignarVentaAutonoma(
  contact: string,
  quoteId: string,
): Promise<{ autonoma: boolean; ejecutivo?: EjecutivoAutonoma }> {
  try {
    const owner = await ownerVentaAutonoma()
    if (!owner) return { autonoma: false }
    // SOLO CHILE (Lalo 31-jul): CO y MX siguen con sus reglas antiguas.
    if (!contact.startsWith("56")) return { autonoma: false }
    // ¿Intervino un humano? Antes un traspaso PTV activo bastaba para dejarle
    // la venta al vendedor. REGLA NUEVA (Lalo 24-ago, caso Javiera/Tamara:
    // tómbola 11:06, pagos 11:26 y 11:55, cero gestión de la vendedora): el
    // traspaso disparado NO es gestión — en cada pago se verifica si el
    // ejecutivo hizo ALGO en el deal (alguna nota, o la nota-espejo de su
    // WhatsApp). Sin gestión, el deal vuelve al dueño de ventas autónomas
    // (Aleydis) para que acompañe la gestión comercial post-venta.
    const url = (process.env.SUPABASE_URL || "").trim()
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    let ptvActivo: { id: string } | null = null
    if (url && key) {
      const r = await fetch(
        `${url}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(contact)}&estado=eq.activo&select=id&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
      )
      const filas = r.ok ? ((await r.json().catch(() => [])) as Array<{ id: string }>) : []
      if (Array.isArray(filas) && filas.length > 0) ptvActivo = filas[0]
    }
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    // El deal se resuelve ANTES de decidir: el chequeo de gestión lo necesita.
    // FUENTE 1 = el Deal_Asociado de la cotización PAGADA: ese es el deal de
    // ESTA venta. FUENTE 2 (solo si la cotización no lo trae) = el deal
    // convertido del lead del teléfono, saltando los CERRADOS. Cicatriz
    // TESLA AUSTRAL (07-sep): la búsqueda por fono devolvió un deal en Cierre
    // Perdido de julio (otro ejecutivo, con notas) en vez del deal nuevo de la
    // cotización; la venta 100% Vicky quedó juzgada "ASISTIDA" y sin asignar.
    const gQuote = await fetch(
      `${api}/crm/v3/${quoteModule}/${quoteId}?fields=Deal_Asociado,Cuenta_Asociada,Contacto_Asociado`,
      { headers: H, cache: "no-store" },
    )
    const filaQuote = gQuote.ok
      ? ((await gQuote.json().catch(() => ({}))) as {
          data?: Array<{
            Deal_Asociado?: { id?: string } | null
            Cuenta_Asociada?: { id?: string } | null
            Contacto_Asociado?: { id?: string } | null
          }>
        }).data?.[0]
      : undefined
    let dealIdPre: string | undefined = filaQuote?.Deal_Asociado?.id ? String(filaQuote.Deal_Asociado.id) : undefined
    if (!dealIdPre) {
      const fonoDeal = contact.replace(/\D/g, "")
      const sLead = await fetch(`${api}/crm/v3/Leads/search?phone=${fonoDeal}&converted=both&per_page=5`, { headers: H, cache: "no-store" })
      const candidatos = sLead.ok && sLead.status !== 204
        ? (((await sLead.json().catch(() => ({}))) as { data?: Array<{ Converted_Deal?: { id?: string } | null }> }).data || [])
            .map((l) => l.Converted_Deal?.id)
            .filter((id): id is string => Boolean(id))
        : []
      for (const cand of candidatos) {
        const gD = await fetch(`${api}/crm/v3/Deals/${cand}?fields=Stage`, { headers: H, cache: "no-store" }).catch(() => null)
        const stage = gD && gD.ok && gD.status === 200
          ? String(((await gD.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }).data?.[0]?.Stage || "")
          : ""
        if (/cierre perdido/i.test(stage)) {
          console.log(`[postpago] deal ${cand} del fono ${fonoDeal} está en ${stage} — no cuenta para la venta ${quoteId}`)
          continue
        }
        dealIdPre = String(cand)
        break
      }
    }
    let traspasoSinGestion = false
    if (ptvActivo) {
      const gestiono = dealIdPre ? await hayGestionEnDeal(String(dealIdPre), H, api) : false
      if (gestiono) {
        console.log(`[postpago] pago con traspaso activo y gestión del ejecutivo en el deal ${dealIdPre} — venta ASISTIDA, asignación intacta.`)
        return { autonoma: false }
      }
      traspasoSinGestion = true
      console.log(
        `[postpago] pago con traspaso activo pero SIN gestión del ejecutivo en el deal ${dealIdPre || "-"} — vuelve al dueño de ventas autónomas (Lalo 24-ago).`,
      )
    }
    // Dueño HUMANO real de la cotización (sin fila PTV igual cuenta — bug
    // Gescor 13-ago: Grey era la dueña y la asignación autónoma la pisó):
    // solo los interinos (Vicky/Admin) se consideran "sin dueño". Con
    // traspaso-sin-gestión NO aplica: ese dueño vino de la tómbola
    // automática, no de gestión real — es justo lo que se está revirtiendo.
    if (!traspasoSinGestion) {
      const gOwner = await fetch(`${api}/crm/v3/${quoteModule}/${quoteId}?fields=Owner`, { headers: H, cache: "no-store" })
      const ownerActual = gOwner.ok
        ? ((await gOwner.json().catch(() => ({}))) as { data?: Array<{ Owner?: { email?: string } }> }).data?.[0]?.Owner
        : undefined
      const emailOwner = (ownerActual?.email || "").toLowerCase()
      if (emailOwner && !/vicky@|info@geovictoria/.test(emailOwner)) {
        console.log(`[postpago] cotización ${quoteId} con dueño humano ${emailOwner} — venta NO autónoma, asignación intacta.`)
        return { autonoma: false }
      }
    }
    // La cotización, y de ella la cuenta y el contacto asociados ("todos los
    // registros", Lalo 04-ago). El lead convertido no se toca: Zoho no
    // permite editar leads ya convertidos.
    await fetch(`${api}/crm/v3/${quoteModule}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: quoteId, Owner: { id: owner } }] }),
    }).catch(() => {})
    const skip = { skip_feature_execution: [{ name: "assignment_rules" }] }
    if (filaQuote?.Cuenta_Asociada?.id) {
      await fetch(`${api}/crm/v3/Accounts`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: filaQuote.Cuenta_Asociada.id, Owner: { id: owner } }], ...skip }),
      }).catch(() => {})
    }
    if (filaQuote?.Contacto_Asociado?.id) {
      await fetch(`${api}/crm/v3/Contacts`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: filaQuote.Contacto_Asociado.id, Owner: { id: owner } }], ...skip }),
      }).catch(() => {})
    }
    const dealId = dealIdPre
    if (dealId) {
      await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id: String(dealId), Owner: { id: owner } }], trigger: ["blueprint"], ...skip }),
      }).catch(() => {})
    }
    const ejecutivo = await datosOwnerAutonoma(owner, H, api)
    // Traspaso revertido por inactividad: la fila vic_ptv pasa a nombre del
    // dueño autónomo — el chequeo 9h y cualquier flujo posterior hablan de
    // quien de verdad quedó a cargo.
    if (traspasoSinGestion && ptvActivo && url && key) {
      await fetch(`${url}/rest/v1/vic_ptv?id=eq.${ptvActivo.id}`, {
        method: "PATCH",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // Los TRES campos juntos (Lalo 02-sep, auditoría de traspasos de la
        // semana): hasta hoy el PATCH escribía email y nombre pero dejaba el
        // vendedor_zoho_id del traspaso anterior, así que la fila quedaba
        // mezclada — nombre y correo de una persona, id de otra (caso Cristian
        // Banda 31-ago: presentado a Ana Paula, registro con Aleydis y el id de
        // Ana Paula). El chequeo 9h, la cartera y las alertas leen esa fila.
        body: JSON.stringify({
          vendedor_email: ejecutivo.email,
          vendedor_nombre: ejecutivo.nombre,
          vendedor_zoho_id: String(owner || ""),
        }),
      }).catch(() => {})
    }
    console.log(
      `[postpago] venta ${traspasoSinGestion ? "autónoma por INACTIVIDAD del ejecutivo (traspaso revertido)" : "100% Vicky"}: cotización ${quoteId}, deal ${dealId || "-"}, cuenta y contacto asignados a ${ejecutivo.email}`,
    )
    return { autonoma: true, ejecutivo }
  } catch (e) {
    console.warn("[postpago] asignarVentaAutonoma falló:", e instanceof Error ? e.message : e)
    return { autonoma: false }
  }
}

/**
 * Cierra toda la proactividad del contacto dueño de la cotización (nudges,
 * anuncios y llamadas agendadas) y, si `enviarTraspaso`, le presenta a su
 * ejecutivo humano. Best-effort en cada paso; nunca lanza.
 */

/** ¿La cotización nació en la cotizadora de EJECUTIVOS? (Intervenci_n_Humana
 *  "Con intervención humana"). Best-effort: si Zoho no responde, false — el
 *  chequeo con reintentos de más abajo sigue mandando. */
async function esCanalEjecutivo(quoteId: string): Promise<boolean> {
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const token = await getZohoAccessToken()
    const r = await fetch(`${api}/crm/v3/${quoteModule}/${quoteId}?fields=Intervenci_n_Humana`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return false
    const marca = String(
      ((await r.json().catch(() => ({}))) as { data?: Array<{ Intervenci_n_Humana?: string }> }).data?.[0]?.Intervenci_n_Humana || "",
    )
    return /intervenci/i.test(marca)
  } catch {
    return false
  }
}

export async function cerrarYTraspasarPostPago(
  quoteId: string,
  opts: { enviarTraspaso?: boolean; motivoCierre?: "pagado" | "aceptada" } = {},
): Promise<ResultadoTraspaso> {
  const enviarTraspaso = opts.enviarTraspaso !== false
  let contact = await findContactByQuoteId(quoteId).catch(() => null)
  if (!contact) {
    // Último fallback (27-ago, caso Cafetería Aragón): pago del CANAL
    // EJECUTIVO de un cliente que jamás chateó con Vicky — sin conversación y
    // sin puntero, el teléfono vive solo en la cotización. Solo celular
    // chileno: un fijo no tiene WhatsApp y otros países siguen su camino.
    try {
      const { getZohoAccessToken } = await import("./zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
      const r = await fetch(`${api}/crm/v3/${quoteModule}/${quoteId}?fields=Tel_fono_Contacto`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      const tel = r.ok && r.status === 200
        ? String(
            ((await r.json().catch(() => ({}))) as { data?: Array<{ Tel_fono_Contacto?: string }> }).data?.[0]
              ?.Tel_fono_Contacto || "",
          ).replace(/\D/g, "")
        : ""
      if (/^569\d{8}$/.test(tel)) contact = tel
    } catch { /* sin teléfono utilizable: sin_contacto como siempre */ }
  }
  if (!contact) return { traspaso: "sin_contacto" }

  await closeFollowup(contact, "cotizacion_aceptada").catch(() => {})
  // Regla de oro del Loop v2: la venta cerrada corta el loop de toques para
  // siempre (best-effort). El motivo distingue pago real de aceptación (fix
  // 10-ago) — el cobro asistido depende de esa diferencia.
  await pagoCierraLoop(contact, opts.motivoCierre || "pagado").catch(() => {})
  // Venta 100% Vicky → todos los registros al dueño de ventas autónomas
  // (Aleydis, vic_kv owner_venta_autonoma) y la bienvenida LA presenta
  // (decisión Lalo 04-ago: ella hace la gestión post-venta).
  // SOLO CON PAGO REAL (bug COT395/Gescor 13-ago: la ACEPTACIÓN disparaba
  // esta asignación y le quitó la cotización a Grey — aceptar no es pagar).
  const ventaAutonoma =
    (opts.motivoCierre || "pagado") === "pagado"
      ? await asignarVentaAutonoma(contact, quoteId)
      : { autonoma: false as const }

  const esCO = contact.startsWith("57")
  const esMX = contact.startsWith("521") || (contact.startsWith("52") && contact.length === 12)
  const esCL = !esCO && !esMX
  // Vicky onboarding — CHILE PRIMERO (decisión 26-jul): el pago es la ÚNICA
  // puerta que mueve al contacto de venta a onboarding. CO y MX siguen con el
  // traspaso a ejecutivo humano hasta que la fase se abra para ellos.
  let borradorSembrado: Borrador | null = null
  // CANAL EJECUTIVO (Lalo 05-sep): una venta de la cotizadora de ejecutivos
  // ("Con intervención humana") jamás entra al alta por chat — antes este
  // bloque movía al contacto a fase onboarding y recién más abajo se
  // descubría el canal y se omitía el mensaje: el cliente quedaba en una
  // fase sin kickoff y, con el wizard ya frenado en el cotizador, sin nada.
  const canalEjecutivo = await esCanalEjecutivo(quoteId)
  if (esCL && !canalEjecutivo && (await onboardingActivoPara(contact))) {
    await setKvValue(claveFase(contact), "onboarding").catch(() => {})
    // Sembrar el borrador con lo que la VENTA ya sabe (regla de Eduardo,
    // 26-jul: no volver a preguntar lo que el cliente ya dio — confirmarlo o
    // actualizarlo). La cotización PAGADA trae razón social y RUT; si el
    // contacto ya dijo algo en la fase, eso queda por encima de la semilla.
    try {
      const pointers = await getQuotePointers(contact)
      const pagada = pointers.find((p) => p.quoteId === quoteId) || pointers[0]
      const previo = parsearBorrador(await getKvValue(claveBorrador(contact)).catch(() => null))
      // ADMIN CANDIDATO desde la venta (Lalo 24-ago, "que solo lo confirme"):
      // el contacto de la cotización trae nombre/apellido/correo, y el pago
      // con tarjeta trae el RUT del titular (Pagador_RUT) como SUGERENCIA —
      // el prompt lo confirma en vez de asumirlo (la tarjeta puede ser de
      // otra persona), y pregunta primero si el admin será él/ella u otro.
      let adminSemilla: { nombre?: string; apellido?: string; email?: string; identificador?: string } = {}
      try {
        const { getZohoAccessToken } = await import("./zoho-token")
        const token = await getZohoAccessToken()
        const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
        const Hh = { Authorization: `Zoho-oauthtoken ${token}` }
        const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
        const rq = await fetch(
          `${api}/crm/v3/${quoteModule}/${quoteId}?fields=Contacto_Asociado,Email_Contacto,Pagador_RUT,Pagador_Nombre`,
          { headers: Hh, cache: "no-store" },
        )
        const fila = rq.ok
          ? ((await rq.json().catch(() => ({}))) as {
              data?: Array<{ Contacto_Asociado?: { id?: string } | null; Email_Contacto?: string; Pagador_RUT?: string; Pagador_Nombre?: string }>
            }).data?.[0]
          : undefined
        adminSemilla.email = (fila?.Email_Contacto || "").trim() || undefined
        adminSemilla.identificador = (fila?.Pagador_RUT || "").trim() || undefined
        const contactoId = fila?.Contacto_Asociado?.id
        if (contactoId) {
          const rc = await fetch(`${api}/crm/v3/Contacts/${contactoId}?fields=First_Name,Last_Name,Email`, { headers: Hh, cache: "no-store" })
          const c = rc.ok
            ? ((await rc.json().catch(() => ({}))) as { data?: Array<{ First_Name?: string; Last_Name?: string; Email?: string }> }).data?.[0]
            : undefined
          if (c) {
            adminSemilla.nombre = (c.First_Name || "").trim() || undefined
            adminSemilla.apellido = (c.Last_Name || "").trim() || undefined
            adminSemilla.email = adminSemilla.email || (c.Email || "").trim() || undefined
          }
        }
      } catch { /* semilla parcial: empresa sola sigue valiendo */ }
      borradorSembrado = sembrarBorrador(
        previo,
        { empresa: { nombre: pagada?.empresa, identificador: pagada?.rut }, admin: adminSemilla },
        "cl",
      )
      await setKvValue(claveBorrador(contact), JSON.stringify(borradorSembrado))
    } catch {
      borradorSembrado = null
    }
  }

  // MARCA DE PAGO CON TARJETA (P1 27-ago, caso EMD: tras pagar con tarjeta,
  // Vicky le pidió el comprobante de transferencia). Este camino corre SOLO
  // para pagos online verificados en MP — la marca alimenta la directiva
  // post-venta del webhook para que el guion sepa el MÉTODO.
  // SOLO SI DE VERDAD FUE TARJETA (05-sep): este camino también corre cuando
  // un comprobante de TRANSFERENCIA marca la cotización Pagada (la tool avisa
  // al cotizador y el cotizador dispara este post-pago) y cuando el barrido de
  // respaldo repasa las Pagadas 35 h después. En esos casos estampar
  // `pago_online_` hacía que Vicky dijera "pagaste con tarjeta" a quien
  // transfirió. Si hay comprobante registrado para esta cotización, no es MP.
  let fueTransferencia = false
  try {
    const raw = await getKvValue(`comprobante_ok_${contact}`)
    if (raw) {
      const c = JSON.parse(raw) as { at?: string; numero?: string; quoteId?: string }
      const edadMs = c.at ? Date.now() - new Date(c.at).getTime() : Number.POSITIVE_INFINITY
      const mismaCot = String(c.quoteId || c.numero || "") === String(quoteId)
      fueTransferencia = mismaCot || edadMs < 6 * 60 * 60 * 1000
    }
  } catch { /* sin marca */ }
  if ((opts.motivoCierre || "pagado") === "pagado" && !fueTransferencia) {
    await setKvValue(
      `pago_online_${contact}`,
      JSON.stringify({ at: new Date().toISOString(), quoteId }),
    ).catch(() => {})
  }

  if (!enviarTraspaso) return { contact, traspaso: "omitido" }

  // CANAL EJECUTIVO: NADA POR EL WHATSAPP DE VICKY (Lalo 31-ago, casos
  // COMERCIAL PEREA y GAMAN MEDINA). Cuando la cotización la emitió un
  // ejecutivo con la cotizadora, el cliente muchas veces no ha hablado nunca
  // con Vicky: la bienvenida le llega como PRIMER mensaje, de alguien que no
  // conoce, mientras su ejecutivo ya le está entregando el onboarding por su
  // propio hilo. Todo lo demás sigue igual —el auto-onboarding se genera, el
  // loop se cierra, el CRM se ordena—: lo único que se apaga es el mensaje.
  // Sin marca de canal (cotizaciones anteriores al 19-ago) se envía como
  // siempre: la ausencia de dato no puede dejar a un cliente sin bienvenida.
  // La lectura de la marca REINTENTA (01-sep, caso TELECO/COT1037): la caída
  // de Zoho de las 00:26 hizo fallar este fetch, el fail-open dejó pasar la
  // bienvenida y le llegó a una clienta del canal ejecutivo — exactamente lo
  // que la guarda existe para impedir. Tres intentos con espera; el fail-open
  // queda solo para cuando Zoho falla TRES veces seguidas (mejor una
  // bienvenida de más que un cliente huérfano, pero no al primer estornudo).
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const token = await getZohoAccessToken()
        const r = await fetch(`${api}/crm/v3/${quoteModule}/${quoteId}?fields=Intervenci_n_Humana`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        })
        if (r.status === 200) {
          const marca = String(
            ((await r.json().catch(() => ({}))) as { data?: Array<{ Intervenci_n_Humana?: string }> }).data?.[0]
              ?.Intervenci_n_Humana || "",
          )
          if (/intervenci/i.test(marca)) {
            console.log(`[postpago] canal EJECUTIVO en ${quoteId}: sin mensaje de Vicky a ${contact}`)
            return { contact, traspaso: "omitido_canal_ejecutivo" }
          }
          break // marca leída y no es ejecutivo → se envía
        }
        console.warn(`[postpago] lectura de canal ${quoteId} intento ${intento}: HTTP ${r.status}`)
      } catch (e) {
        console.warn(`[postpago] lectura de canal ${quoteId} intento ${intento} falló:`, e instanceof Error ? e.message : e)
      }
      if (intento < 3) await new Promise((res) => setTimeout(res, 2000 * intento))
    }
  } catch { /* fail-open tras agotar reintentos */ }

  const kvKey = `traspaso_postpago_${quoteId}`
  const ya = await getKvValue(kvKey).catch(() => null)
  if (ya) return { contact, traspaso: "ya_enviado" }
  // DEDUP POR CONTACTO (P1 27-ago, caso Javiera 24-ago: pagó DOS cotizaciones
  // el mismo día y recibió dos bienvenidas idénticas en el mismo minuto). Si
  // este contacto ya recibió una bienvenida hace <6h, la segunda cotización no
  // repite el discurso: si su link de onboarding es DISTINTO (otra empresa),
  // va solo el link corto; si es el mismo, no va nada.
  const kvContacto = `traspaso_postpago_c_${contact}`
  const previaCruda = await getKvValue(kvContacto).catch(() => null)
  let bienvenidaPrevia: { at?: string; link?: string } | null = null
  try {
    bienvenidaPrevia = previaCruda ? (JSON.parse(previaCruda) as { at?: string; link?: string }) : null
  } catch { bienvenidaPrevia = null }
  const previaReciente =
    Boolean(bienvenidaPrevia?.at) &&
    Date.now() - new Date(String(bienvenidaPrevia?.at)).getTime() < 6 * 3600e3

  // Vicky AUTÓNOMA en CL (decisión 26-jul): con el flag encendido NO se
  // presenta a ningún ejecutivo — el mismo mensaje de bienvenida abre el alta
  // por chat, y el gate del webhook atiende las respuestas con el agente de
  // onboarding. Reemplaza al bloque del ejecutivo, no lo suma.
  if (esCL && !canalEjecutivo && (await onboardingActivoPara(contact))) {
    // UN solo mensaje de arranque para las dos vías de pago y para dentro y
    // fuera de la ventana. Fuera de ventana el texto libre moriría en silencio
    // (el cliente pudo pagar un domingo tras dos días callado), así que ahí va
    // la plantilla HSM — con el MISMO texto.
    const { via, texto } = await entregarKickoffOnboarding(
      contact,
      borradorSembrado?.empresa.nombre,
      borradorSembrado?.empresa.identificador,
      borradorSembrado?.admin.nombre,
    )
    if (via === "fallo") return { contact, traspaso: "push_fallo" }
    await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
    // Solo el texto libre entra al historial: la plantilla la despacha Botmaker
    // y meterla le daría al modelo un turno que no dijo.
    if (via === "texto") await appendAssistantV3(contact, texto, "cl").catch(() => {})
    return { contact, traspaso: "enviado" }
  }

  // CL: se presenta al DUEÑO REAL del deal pagado, no a un nombre fijo.
  // Relevo 27-jul: las cotizaciones nuevas son de Eddyluz y las anteriores
  // siguen siendo de Anderson — presentar al equivocado en el mensaje de
  // bienvenida es exactamente la incoherencia del caso "yo misma te
  // acompaño" (tests/coherencia-post-pago), ahora entre dos humanos.
  // FUENTE ÚNICA (P1 27-ago): el directorio vive en lib/directorio-ejecutivos
  // (mismo que usa el cinturón de teléfonos del webhook). Extensible sin
  // deploy por env VICKY_TELEFONOS_EJECUTIVOS.
  const { directorioEjecutivos } = await import("./directorio-ejecutivos")
  const EJECUTIVOS_CL: Record<string, { nombre: string; email: string; telefono: string }> = {}
  for (const f of directorioEjecutivos()) EJECUTIVOS_CL[f.email] = f
  const duenoCL = !esMX && !esCO ? await ownerDeCotizacion(quoteId).catch(() => null) : null
  // Teléfono del dueño: directorio local primero; si no lo conocemos, su
  // ficha de usuario en Zoho (mismo dato que usa el modal de transferencia).
  let telefonoDuenoCL = duenoCL ? EJECUTIVOS_CL[duenoCL.email.toLowerCase()]?.telefono || "" : ""
  if (duenoCL && !telefonoDuenoCL && duenoCL.id) {
    try {
      const { getZohoAccessToken } = await import("./zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const r = await fetch(`${api}/crm/v3/users/${duenoCL.id}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      const u = r.ok
        ? ((await r.json().catch(() => ({}))) as { users?: Array<{ phone?: string; mobile?: string }> }).users?.[0]
        : undefined
      telefonoDuenoCL = (u?.phone || u?.mobile || "").trim()
    } catch { /* sin teléfono: el mensaje va solo con correo */ }
  }
  // Sin dueño humano resuelto NO se inventa uno: presentar a la persona
  // equivocada es peor que presentar al equipo (caso Moncada 27-ago — el
  // resolver COQL roto hacía caer TODOS los pagos al fallback Eddyluz
  // mientras el deal era de Anderson). El fallback con nombre murió.
  const ejecutivo = esMX
    ? { nombre: "Yahel Segura", email: "ysegura@geovictoria.com", telefono: "+52 55 3763 6604" }
    : esCO
      ? PERFIL_CO.equipo.ejecutivo
      : duenoCL
        ? {
            // Nombre real desde Zoho (jamás un prefijo de correo); el teléfono
            // sale del directorio o de su ficha Zoho.
            nombre: duenoCL.nombre || EJECUTIVOS_CL[duenoCL.email]?.nombre || "",
            email: duenoCL.email,
            telefono: telefonoDuenoCL,
          }
        : null
  // Caso Jessica/JEANSCO (24-jul): el mensaje de bienvenida DEBE traer el link
  // del auto-onboarding — antes solo presentaba al ejecutivo y el cliente
  // tenía que encontrar el wizard por su cuenta. El endpoint es idempotente.
  const linkOnboarding = await obtenerLinkOnboarding(quoteId).catch(() => "")
  if (previaReciente) {
    const linkNuevo = (linkOnboarding || "").trim()
    const linkPrevio = (bienvenidaPrevia?.link || "").trim()
    if (!linkNuevo || linkNuevo === linkPrevio) {
      // Mismo onboarding (o sin link): la bienvenida de hace un rato ya lo
      // cubrió. Se sella el candado de ESTA cotización para que el respaldo
      // horario no la reintente.
      await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
      return { contact, traspaso: "ya_enviado" }
    }
    // Segunda empresa del mismo pagador (caso Javiera): solo el dato nuevo,
    // sin repetir el discurso de bienvenida. Misma regla de ventana.
    const corto =
      `Tu segunda cotización también quedó registrada ✅ El auto-onboarding de esta empresa va aparte, aquí:\n👉 ${linkNuevo}`
    const { getLastUserAt } = await import("./supabase-persistence-v3")
    const ultimo2 = await getLastUserAt(contact).catch(() => null)
    const abierta2 = Boolean(ultimo2) && Date.now() - (ultimo2 as Date).getTime() < 24 * 3600e3
    let salio = false
    if (abierta2) {
      salio = await sendBotmakerMessage(contact, corto, undefined, TRANSACCIONAL).catch(() => false)
      if (salio) await appendAssistantV3(contact, corto, "cl").catch(() => {})
    }
    if (!salio && !esCO && !esMX) {
      const { sendBotmakerTemplate } = await import("./botmaker-push-v3")
      const { PLANTILLA_BIENVENIDA_PAGO_CL, paramsBienvenidaPago } = await import("./plantilla-bienvenida-pago")
      salio = await sendBotmakerTemplate(
        contact,
        PLANTILLA_BIENVENIDA_PAGO_CL.name,
        paramsBienvenidaPago(linkNuevo, null),
        undefined,
        TRANSACCIONAL,
      ).catch(() => false)
    }
    if (!salio) return { contact, traspaso: "push_fallo" }
    await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
    await setKvValue(kvContacto, JSON.stringify({ at: new Date().toISOString(), link: linkNuevo })).catch(() => {})
    return { contact, traspaso: "enviado" }
  }
  const encabezado =
    `¡Felicitaciones y bienvenido a GeoVictoria! 🎉 Tu pago quedó registrado.\n\n` +
    (linkOnboarding
      ? `Para dejar tu empresa configurada y lista para operar, completa tu auto-onboarding aquí (toma ~10 minutos):\n👉 ${linkOnboarding}\n\n`
      : "")
  // Venta autónoma: se presenta al dueño de ventas autónomas (Aleydis) — es
  // quien hace la gestión post-venta (Lalo 04-ago; antes no se presentaba a
  // nadie y "nuestro equipo te contactará" quedaba sin cara).
  const quienPresenta = ventaAutonoma.autonoma && ventaAutonoma.ejecutivo ? ventaAutonoma.ejecutivo : ejecutivo
  const traspaso =
    encabezado +
    (quienPresenta && quienPresenta.nombre
      ? `De aquí en adelante te acompaña *${quienPresenta.nombre}*, ${ventaAutonoma.autonoma ? "de nuestro equipo" : "tu ejecutivo comercial"}, quien te contactará para coordinar la puesta en marcha:\n` +
        (quienPresenta.telefono ? `📱 ${quienPresenta.telefono}\n` : "") +
        `✉️ ${quienPresenta.email}`
      : `De aquí en adelante te acompaña nuestro equipo comercial, que te contactará para coordinar la puesta en marcha. Cualquier duda me escribes por aquí 🙌`)
  // LA VENTANA SE CHEQUEA ANTES, NO SE CONFÍA EN EL PUSH (27-ago, lección del
  // barrido de las 12:42): Botmaker ACEPTA el texto libre y devuelve OK aunque
  // la ventana de 24 h esté cerrada — el mensaje muere en silencio después.
  // Mismo patrón de entregarKickoffOnboarding: con ventana abierta va texto
  // libre; cerrada (o push fallido), plantilla HSM. Solo CL tiene plantilla
  // (vive en el bot Vicky Chile); CO/MX conservan el texto libre de siempre.
  const { getLastUserAt } = await import("./supabase-persistence-v3")
  const ultimoUsuario = await getLastUserAt(contact).catch(() => null)
  const ventanaAbierta = Boolean(ultimoUsuario) && Date.now() - (ultimoUsuario as Date).getTime() < 24 * 3600e3
  if (ventanaAbierta || esCO || esMX) {
    const pushed = await sendBotmakerMessage(
      contact,
      traspaso,
      esCO ? PERFIL_CO.canal.channelId : undefined,
      TRANSACCIONAL,
    ).catch(() => false)
    if (pushed) {
      await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
      await setKvValue(kvContacto, JSON.stringify({ at: new Date().toISOString(), link: (linkOnboarding || "").trim() })).catch(() => {})
      await appendAssistantV3(contact, traspaso, esCO ? "co" : "cl").catch(() => {})
      return { contact, traspaso: "enviado" }
    }
    // La ventana pudo cerrarse entre la consulta y el envío: CL sigue al
    // respaldo de plantilla antes de darlo por perdido.
    if (esCO || esMX) return { contact, traspaso: "push_fallo" }
  }
  // SIN LINK NO SALE LA PLANTILLA (31-ago, caso COMERCIAL PEREA): el cuerpo
  // del HSM es fijo y dice "completa tu auto-onboarding en este link: 👉
  // ${link}". Sin link, la variable caía en un texto de relleno y al cliente
  // le llegaba "en este link: 👉 te lo comparto enseguida por este chat" —
  // un mensaje que promete algo que no está. El texto libre sí puede omitir
  // esa línea (arriba), la plantilla no. Se espera: el kv NO se sella, así
  // que el respaldo horario reintenta cuando el onboarding exista.
  if (!(linkOnboarding || "").trim()) {
    console.warn(`[postpago] bienvenida DIFERIDA para ${contact}: la cotización ${quoteId} aún no tiene link de onboarding`)
    return { contact, traspaso: "sin_link_onboarding" }
  }
  const { sendBotmakerTemplate } = await import("./botmaker-push-v3")
  const { PLANTILLA_BIENVENIDA_PAGO_CL, paramsBienvenidaPago } = await import("./plantilla-bienvenida-pago")
  const okTpl = await sendBotmakerTemplate(
    contact,
    PLANTILLA_BIENVENIDA_PAGO_CL.name,
    paramsBienvenidaPago(linkOnboarding, quienPresenta),
    undefined,
    TRANSACCIONAL,
  ).catch(() => false)
  if (okTpl) {
    await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
    await setKvValue(kvContacto, JSON.stringify({ at: new Date().toISOString(), link: (linkOnboarding || "").trim() })).catch(() => {})
    // La plantilla la despacha Botmaker: no entra al historial (patrón
    // del kickoff — meterla le daría al modelo un turno que no dijo).
    return { contact, traspaso: "enviado" }
  }
  return { contact, traspaso: "push_fallo" }
}
