/**
 * Registro de comprobantes de transferencia enviados por WhatsApp.
 *
 * v1 VALIDAR + NOTIFICAR (decisión Lalo 17-jul): Vicky confirma la RECEPCIÓN
 * al cliente y deja el comprobante en manos del equipo; la confirmación del
 * PAGO la hace finanzas tras verificar en el banco. NUNCA se marca la
 * cotización como pagada desde acá (un comprobante adulterado no debe gatillar
 * el post-venta). Contexto: 2 de las 12 primeras ventas pagaron por
 * transferencia y quedaron INVISIBLES para el sistema (Supermercado Sur,
 * ELEAM) — esta tool cierra ese hoyo de visibilidad.
 *
 * v2 VALIDACIÓN BLANDA (decisión Lalo 26-jul, MVP/piloto de revenue): la
 * verificación bancaria deja de BLOQUEAR al cliente. Si Vicky pudo leer el
 * comprobante, el acceso al onboarding sale en ese mismo turno; finanzas sigue
 * verificando en paralelo, ahora como auditoría. Si el abono no aparece, el
 * equipo corta el onboarding a mano. Antes el cliente ya había pagado y quedaba
 * esperando hasta 24 horas hábiles — justo el punto donde la inmediatez (la
 * ventaja central de Vicky) se caía.
 *
 * Aplica a CL y MX. Colombia no entra: paga solo con tarjeta vía MercadoPago y
 * su set de tools no expone esta función.
 *
 * Qué hace:
 *   1. Asocia el comprobante a la cotización formal VIGENTE del contacto
 *      (puntero multi-RUT más reciente).
 *   2. Deja una NOTA en la cotización de Zoho con el detalle detectado.
 *   3. Avisa al equipo por WhatsApp (best-effort, ventana de 24h mediante),
 *      marcando si hubo habilitación blanda para que finanzas sepa que el
 *      cliente ya está adentro.
 *   4. Devuelve mensajeParaProspecto: recepción confirmada + acceso al
 *      onboarding si el comprobante era legible. Sin afirmar JAMÁS que el pago
 *      quedó confirmado — se confirma la recepción, no el dinero.
 */

import { getKvValue, getQuotePointers, setKvValue, type QuotePointer } from "@/lib/supabase-persistence-v3"
import { transicionarDealHacia } from "@/lib/zoho-deals"
import { claveFase, claveBorrador, claveQuoteOnboarding } from "@/lib/onboarding/fase"
import { onboardingActivoPara } from "@/lib/onboarding-piloto"
import { parsearBorrador, sembrarBorrador } from "@/lib/onboarding/borrador"
import { acuseComprobanteCL } from "@/lib/onboarding/prompt"
import {
  paramsPlantillaOnboarding,
  renderPlantillaOnboarding,
} from "@/lib/onboarding/plantilla"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { enviarCorreoCobranza } from "@/lib/correo-cobranza"
import { adjuntarComprobanteACotizacion, mediaEntranteReciente } from "@/lib/comprobante-adjunto"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

export const registrarComprobanteTransferenciaSchema = {
  name: "registrar_comprobante_transferencia",
  description:
    "Registra un comprobante de transferencia bancaria que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae del comprobante lo que se vea: monto transferido, banco y fecha. La tool asocia el comprobante a la cotización vigente, avisa al equipo de finanzas y devuelve el mensajeParaProspecto: si el comprobante era legible, ese mensaje YA incluye el acceso al onboarding para que el cliente configure su cuenta de inmediato. Copia el mensajeParaProspecto TAL CUAL, con el link incluido. IMPORTANTE sobre montoDetectado: es lo que decide si el cliente queda habilitado de inmediato o tiene que esperar la revisión del equipo — pásalo solo si lo LEÍSTE en el comprobante; si no se alcanza a leer, pasa 0 (nunca lo inventes ni lo deduzcas del precio de la cotización). Y nunca afirmes tú que el pago quedó confirmado: se confirma la recepción, no el dinero.",
  input_schema: {
    type: "object" as const,
    properties: {
      montoDetectado: {
        type: "number" as const,
        description:
          "Monto en CLP que muestra el comprobante (solo dígitos, sin puntos). Si la imagen no deja leer el monto, pasa 0.",
      },
      bancoOrigen: { type: "string" as const, description: "Banco emisor si se ve en el comprobante." },
      fechaDetectada: { type: "string" as const, description: "Fecha de la transferencia si se ve." },
      detalle: {
        type: "string" as const,
        description: "Resumen en una frase de lo que muestra el comprobante (destinatario, hora, nro de operación).",
      },
      pagoDeclarado: {
        type: "boolean" as const,
        description:
          "true cuando el cliente DECLARA que pagó ('el pago está listo', 'ya transferí') pero NO ha enviado el comprobante. Registra el aviso para que finanzas verifique el abono, sin afirmar confirmación.",
      },
      medio: {
        type: "string" as const,
        enum: ["transferencia", "mercado_pago"],
        description:
          "Qué es el comprobante: 'transferencia' (banco a banco) o 'mercado_pago' cuando es el comprobante/recibo que entrega Mercado Pago tras pagar con tarjeta (dice Mercado Pago, MercadoPago, 'Comprobante de pago' de MP, número de operación de MP). El pago con tarjeta se confirma solo; este comprobante NO se registra como transferencia.",
      },
      numeroCotizacion: {
        type: "string" as const,
        description:
          "Número de la cotización si el cliente lo menciona o aparece en el comprobante (ej. 'COT307' o '307'). Pásalo SIEMPRE que esté visible: permite asociar el pago aunque el cliente escriba desde un número de WhatsApp distinto al que recibió la cotización (caso real: paga el dueño desde su celular y la cotización la pidió otra persona de la empresa).",
      },
    },
    required: ["montoDetectado"],
  },
}

type Input = {
  montoDetectado?: number
  medio?: "transferencia" | "mercado_pago"
  bancoOrigen?: string
  fechaDetectada?: string
  detalle?: string
  pagoDeclarado?: boolean
  numeroCotizacion?: string
}

// ── MÉXICO (22-jul, decisión Lalo): sin MercadoPago MX, el pago inicial va por
// transferencia BANORTE. Al recibir el comprobante, Vicky NO solo confirma la
// recepción: entrega DE INMEDIATO el acceso al auto-onboarding y presenta a
// la ejecutiva (Yahel Segura). El pago sigue quedando EN VERIFICACIÓN con
// finanzas — el link no confirma dinero; si el comprobante resultara falso,
// el equipo corta el onboarding a mano.
const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

/**
 * Pago inicial ESPERADO de la cotización, en CLP y sin recargo de tarjeta —
 * la misma fórmula que cobra el checkout, servida por el cotizador
 * (`/api/quote-acceptance/pago-inicial`). 0 si no se pudo saber: ahí no se
 * frena nada (fail-open a la validación blanda de siempre).
 */
async function pagoInicialEsperadoClp(quoteId: string): Promise<number> {
  try {
    if (!VICKY_COTIZADORA_SECRET) return 0
    const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/pago-inicial?quoteId=${encodeURIComponent(quoteId)}`, {
      headers: { "x-vicky-secret": VICKY_COTIZADORA_SECRET },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return 0
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; oneShotClp?: number }
    return j?.ok ? Math.max(0, Math.round(Number(j.oneShotClp) || 0)) : 0
  } catch {
    return 0
  }
}
const EJECUTIVA_MX = {
  nombre: "Yahel Segura",
  whatsapp: "+52 55 3763 6604",
  email: "ysegura@geovictoria.com",
}

export async function obtenerLinkOnboarding(quoteId: string): Promise<string> {
  try {
    const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/onboarding-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({ quoteId }),
      cache: "no-store",
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; onboardingUrl?: string }
    return r.ok && data.ok && data.onboardingUrl ? data.onboardingUrl : ""
  } catch {
    return ""
  }
}

// ── Fallback por número de cotización (caso Grupo Dog Delivery, 03-ago) ──
//
// El puntero de cotización vigente es POR CONTACTO, así que si el comprobante
// llega desde un número de WhatsApp distinto al que recibió la cotización
// (pagó el dueño desde su celular), getQuotePointers no encuentra nada y el
// cliente quedaba sin habilitación aunque dijera "pagué la COT307" en el chat.
// Acá se resuelve ese número contra Zoho para asociar el pago igual.
/** Nombre del contacto de la cotización (persona natural sin razón social). */
async function nombreContactoDeCotizacion(quoteId: string): Promise<string> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Contacto_Asociado,Cuenta_Asociada`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    const d = ((await r.json().catch(() => ({}))) as {
      data?: Array<{ Contacto_Asociado?: { name?: string }; Cuenta_Asociada?: { name?: string } }>
    }).data?.[0]
    const cuenta = String(d?.Cuenta_Asociada?.name || "").trim()
    if (cuenta && cuenta !== "-") return cuenta
    return String(d?.Contacto_Asociado?.name || "").trim()
  } catch {
    return ""
  }
}

async function buscarCotizacionPorNumero(
  numero: string,
): Promise<import("@/lib/supabase-persistence-v3").QuotePointer | null> {
  const digitos = (numero || "").replace(/\D/g, "")
  if (!digitos) return null
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/search?criteria=${encodeURIComponent(
        `(Numero_Cotizacion:equals:COT${digitos})`,
      )}&fields=${encodeURIComponent("id,Numero_Cotizacion,Cuenta_Asociada,RUT_Cliente")}`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      },
    )
    if (!res.ok) return null
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; Cuenta_Asociada?: { name?: string }; RUT_Cliente?: string }>
    }
    const row = data.data?.[0]
    if (!row?.id) return null
    return {
      quoteId: String(row.id),
      empresa: String(row.Cuenta_Asociada?.name || ""),
      rut: String(row.RUT_Cliente || ""),
      dealId: "",
      acceptanceUrl: "",
      pdfUrl: "",
      totalClp: null,
      totalUf: null,
      updatedAt: new Date().toISOString(),
    }
  } catch (err) {
    console.error("[comprobante] búsqueda por número de cotización falló:", err)
    return null
  }
}

/** Comprobante recibido → la cotización pasa a "Pagada" (decisión Lalo
 * 04-ago, opción 1): el estado dispara los workflows de Zoho amarrados a
 * "Pagada". Riesgo asumido y documentado en la nota: es pago DECLARADO — si
 * el abono no aparece en el banco, cobranza revierte el estado a mano. */
/** ¿La cotización ya está Pagada en Zoho? (fail-closed: ante duda, se considera NO pagada). */
async function cotizacionYaPagada(quoteId: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Estado_Cotizacion`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return false
    const e = String(((await r.json().catch(() => ({}))) as { data?: Array<{ Estado_Cotizacion?: string }> }).data?.[0]?.Estado_Cotizacion || "")
    return /pagad/i.test(e)
  } catch {
    return false
  }
}

export async function marcarCotizacionPagada(quoteId: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: quoteId, Estado_Cotizacion: "Pagada" }] }),
    })
    if (!res.ok) {
      console.warn(`[comprobante] Estado→Pagada falló (${res.status}) quote=${quoteId}`)
      return false
    }
    console.log(`[comprobante] quote=${quoteId} Estado_Cotizacion → Pagada`)
    // Correo interno de PAGADA (hoyo detectado 10-ago, caso Fernando/COT408):
    // ese correo vive en el COTIZADOR (notifyQuoteEvent — destinatarios por
    // país + Owner, filtro anti-pruebas, WhatsApp interno) y solo lo
    // gatillaban los pagos por MercadoPago. La transferencia entra por acá,
    // así que acá se dispara. Best-effort: su falla no toca ni el estado ni
    // la conversación.
    await notificarPagadaAlCotizador(quoteId)
    return true
  } catch (e) {
    console.warn("[comprobante] Estado→Pagada lanzó:", e instanceof Error ? e.message : e)
    return false
  }
}

/** Dispara en el cotizador la notificación interna de "Cotización PAGADA"
 * (correo al equipo + WhatsApp interno). Única puerta para pagos SIN
 * MercadoPago. Nunca lanza. Exportada para el reenvío manual
 * (vic-admin-notify-paid). */
export async function notificarPagadaAlCotizador(quoteId: string): Promise<void> {
  let entrego = false
  try {
    const base = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
    const secret = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
    if (!secret) return
    const r = await fetch(`${base}/api/payments/notify-paid?quoteId=${encodeURIComponent(quoteId)}`, {
      method: "POST",
      headers: { "x-vicky-secret": secret },
      cache: "no-store",
    })
    entrego = r.ok
    console.log(`[comprobante] notify-paid ${r.ok ? "ok" : `falló (${r.status})`} quote=${quoteId}`)
  } catch (e) {
    console.warn("[comprobante] notify-paid lanzó:", e instanceof Error ? e.message : e)
  }
  // COLA DE REINTENTO (Lalo 01-sep, caso Valuaciones/COT1052: el disparo
  // best-effort murió en la tormenta de tokens de Zoho y el correo de PAGADA
  // jamás salió). Si el cotizador no confirmó, queda marca en vic_kv y el
  // vic-ptv-cron reintenta hasta que el correo salga (ventana 48h).
  if (!entrego) {
    await setKvValue(`notify_pagada_pend_${quoteId}`, new Date().toISOString()).catch(() => {})
  }
}

/** Foto del pago → deal GANADO (pedido Lalo 07-ago): junto con marcar la
 * cotización Pagada, el deal avanza por blueprint hacia "7. Implementando" —
 * la etapa ganada que el dashboard espeja como "Ganada". Forward-only (jamás
 * retrocede ni toca Cierre Perdido/Congelado); si el blueprint solo ofrece el
 * paso intermedio "6. Listo para Cierre", se avanza y se reintenta el tramo
 * final de inmediato. Best-effort: nunca toca la respuesta al cliente. */
async function avanzarDealAGanado(pointer: QuotePointer): Promise<void> {
  try {
    let dealId = (pointer.dealId || "").trim()
    if (!dealId) {
      const token = await getZohoAccessToken()
      const r = await fetch(
        `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${pointer.quoteId}?fields=Deal_Asociado`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
      )
      const data = (await r.json().catch(() => null)) as {
        data?: Array<{ Deal_Asociado?: { id?: string } }>
      } | null
      dealId = String(data?.data?.[0]?.Deal_Asociado?.id || "")
    }
    if (!dealId) {
      console.warn(`[comprobante] quote=${pointer.quoteId} sin deal asociado — no se pudo marcar ganado`)
      return
    }
    let r1 = await transicionarDealHacia(dealId, "implementando")
    if (r1.resultado === "avanzado" && !/implement/i.test(r1.detalle || "")) {
      r1 = await transicionarDealHacia(dealId, "implementando")
    }
    console.log(
      `[comprobante] deal=${dealId} → ganado: ${r1.resultado}${r1.detalle ? ` (${r1.detalle})` : ""}`,
    )
  } catch (e) {
    console.warn("[comprobante] avanzarDealAGanado falló:", e instanceof Error ? e.message : e)
  }
}

async function crearNotaEnCotizacion(quoteId: string, contenido: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    // Endpoint de related records (25-jul): POST /{módulo}/{id}/Notes. El
    // formato anterior (POST /Notes con Parent_Id objeto) fallaba SIEMPRE en
    // silencio con el módulo custom — ninguna cotización tenía la nota del
    // comprobante (verificado en JEANSCO/COT265).
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${encodeURIComponent(quoteId)}/Notes`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              Note_Title: "Comprobante de transferencia recibido por WhatsApp",
              Note_Content: contenido,
            },
          ],
        }),
        cache: "no-store",
      },
    )
    if (!res.ok) {
      const detalle = await res.text().catch(() => "")
      console.error(`[comprobante] nota Zoho falló ${res.status}: ${detalle.slice(0, 300)}`)
    }
    return res.ok
  } catch (err) {
    console.error("[comprobante] nota Zoho excepción:", err)
    return false
  }
}

export async function registrarComprobanteTransferencia(
  contact: string,
  input: Input,
  // "mx": monto en MXN y, tras registrar, entrega el link de auto-onboarding y
  // presenta a la ejecutiva (flujo transferencia BANORTE). Default: CL.
  pais: "cl" | "mx" = "cl",
): Promise<{ ok: boolean; mensajeParaProspecto: string; notaCreada?: boolean; avisoInterno?: boolean }> {
  const monto = Math.max(0, Math.round(Number(input.montoDetectado) || 0))
  const montoFmt =
    monto > 0
      ? pais === "mx"
        ? `$${monto.toLocaleString("es-MX")} MXN`
        : `$${monto.toLocaleString("es-CL")}`
      : "monto no legible"

  const pointers = await getQuotePointers(contact).catch(() => [])
  let pointer = pointers[0] || null
  // ALTA ABIERTA MANDA (08-sep, caso Lorena: dos cotizaciones, una por RUT):
  // si el ciclo de alta ya está anclado a una cotización de este contacto,
  // el comprobante se asocia a ESA y no al puntero más reciente.
  // Y una cotización YA PAGADA no vuelve a recibir comprobantes: si el
  // cliente paga la segunda empresa con OTRA transferencia (Lalo: "es como el
  // cliente quiera"), el comprobante se asocia a la que sigue sin pagar.
  try {
    const abierta = (await getKvValue(claveQuoteOnboarding(contact)).catch(() => null)) || ""
    const pa = abierta ? pointers.find((p) => p.quoteId === abierta) : undefined
    if (pa && !(await cotizacionYaPagada(pa.quoteId))) pointer = pa
    else if (pointer && pointers.length > 1 && (await cotizacionYaPagada(pointer.quoteId))) {
      for (const o of pointers) {
        if (o.quoteId !== pointer.quoteId && !(await cotizacionYaPagada(o.quoteId))) {
          pointer = o
          break
        }
      }
    }
  } catch { /* sin ancla: puntero más reciente */ }

  // Sin puntero para ESTE número: si el cliente mencionó el número de la
  // cotización (chat o comprobante), se resuelve contra Zoho. La nota interna
  // marca la asociación cruzada para que finanzas mire con más atención.
  let asociadoPorNumero = false
  if (!pointer && input.numeroCotizacion) {
    const porNumero = await buscarCotizacionPorNumero(input.numeroCotizacion)
    if (porNumero) {
      pointer = porNumero
      asociadoPorNumero = true
    }
  }

  const declarado = input.pagoDeclarado === true

  // COMPROBANTE DE MERCADO PAGO (Lalo 05-sep, caso Maquinarias Santa Sara):
  // el cliente pagó con tarjeta y mandó la imagen del recibo de MP ANTES de
  // que MP nos confirmara el pago (el webhook llegó vacío y el poll lo vio
  // 90 s después). La tool lo tomaba como transferencia: marcaba Pagada, el
  // cotizador disparaba el post-pago, y al confirmarse el pago real todo
  // salía por segunda vez (2 correos PAGADA, 2 bienvenidas). Un recibo de MP
  // no se registra: el pago con tarjeta se confirma solo.
  const textoMedio = `${input.bancoOrigen || ""} ${input.detalle || ""}`.toLowerCase()
  const esMercadoPago = input.medio === "mercado_pago" || /mercado\s*pago|mercadopago|\bmp\b/.test(textoMedio)
  if (esMercadoPago && !declarado) {
    await avisarEquipoInterno(
      `ℹ️ +${contact} mandó el comprobante de MERCADO PAGO (pago con tarjeta)${pointer ? ` de la cotización ${pointer.quoteId}` : ""}. No se registra como transferencia: el pago se confirma solo por MP.`,
    ).catch(() => false)
    return {
      ok: true,
      mensajeParaProspecto:
        "¡Gracias! Ese es el comprobante de tu pago con tarjeta: Mercado Pago me lo confirma solo en un par de minutos, no necesitas mandarme nada 🙌 Apenas entre te escribo por aquí para crear tu cuenta.",
      notaCreada: false,
      avisoInterno: true,
    }
  }

  // PAGO CON TARJETA YA REGISTRADO (Lalo 05-sep, caso Maquinarias Santa Sara):
  // el cliente pagó por Mercado Pago y después mandó la imagen del
  // comprobante que entrega MP. Esta tool lo tomaba como una transferencia
  // nueva: segunda "Pagada", segundo enrolamiento y un wizard encima del
  // arranque que ya había salido por el pago online. Si el post-pago dejó la
  // marca `pago_online_` para esta cotización (<48 h), acá no se registra
  // nada: se le agradece y se sigue con el alta que ya está en curso.
  if (pointer) {
    try {
      const rawOnline = await getKvValue(`pago_online_${contact}`)
      if (rawOnline) {
        const po = JSON.parse(rawOnline) as { at?: string; quoteId?: string }
        const edadMs = po.at ? Date.now() - new Date(po.at).getTime() : Number.POSITIVE_INFINITY
        if (edadMs < 48 * 60 * 60 * 1000 && (!po.quoteId || String(po.quoteId) === String(pointer.quoteId))) {
          await avisarEquipoInterno(
            `ℹ️ +${contact} mandó el comprobante de Mercado Pago DESPUÉS de pagar con tarjeta (quote ${pointer.quoteId}). No se registra dos veces; el alta sigue por el camino del pago online.`,
          ).catch(() => false)
          return {
            ok: true,
            mensajeParaProspecto:
              "¡Gracias! Ese pago con tarjeta ya me llegó confirmado por Mercado Pago, así que no necesitas mandarme comprobante 🙌 Seguimos con la creación de tu cuenta por aquí.",
            notaCreada: false,
            avisoInterno: true,
          }
        }
      }
    } catch { /* sin marca: sigue el registro normal */ }
  }

  // Funnel de pago (Rodrigo 17-ago): el comprobante por WhatsApp es un paso
  // MEDIBLE del último metro — queda como evento `pf_<quoteId>_comprobante_wsp`
  // junto a los pings de la página (vic-pago-evento). Best-effort: jamás
  // afecta el registro del comprobante ni la conversación.
  if (pointer?.quoteId) {
    void setKvValue(
      `pf_${pointer.quoteId}_comprobante_wsp`,
      `${new Date().toISOString()}|wsp${declarado ? "|declarado" : ""}`,
    ).catch(() => {})
  }

  // ── VALIDACIÓN BLANDA (decisión Lalo 26-jul, MVP/piloto de revenue) ──
  //
  // Antes: el cliente mandaba el comprobante y esperaba hasta 24 horas hábiles a
  // que finanzas verificara el abono en el banco ANTES de poder configurar nada.
  // Ese bloqueo humano contradice el posicionamiento central de Vicky (la
  // inmediatez es su ventaja frente a un vendedor humano) y es justo el punto
  // donde el cliente ya pagó y se queda esperando.
  //
  // Ahora: si Vicky pudo LEER el comprobante, se le entrega el acceso al
  // onboarding de inmediato. La verificación bancaria sigue corriendo en
  // paralelo, pero como AUDITORÍA — no como bloqueo. Si el abono no aparece, el
  // equipo corta el onboarding a mano (mismo patrón que MX desde el 22-jul).
  //
  // El único criterio duro: el comprobante tiene que ser LEGIBLE (monto > 0).
  // Si el monto no se pudo leer — imagen borrosa, PDF que el visor no abrió, o
  // pago solo DECLARADO sin comprobante — NO se habilita: ahí no hay nada que
  // validar, ni siquiera blandamente, y se mantiene el mensaje de verificación.
  //
  // Lo que NO cambia: la cotización nunca se marca como pagada desde acá, y
  // Vicky jamás afirma que el pago quedó confirmado.
  const comprobanteLegible = !declarado && monto > 0
  // MONTO CONTRA EL PAGO INICIAL (Lalo 05-sep, prueba E3: $20.000 contra
  // $26.756 se aceptó como pago completo). Si el comprobante trae MENOS que
  // el pago inicial de la cotización (tolerancia 2% por redondeos), NO se
  // habilita el alta ni se marca Pagada: se le pide la diferencia. Sin dato
  // del cotizador (0) rige la validación blanda de siempre.
  const esperadoClp = pointer && comprobanteLegible ? await pagoInicialEsperadoClp(pointer.quoteId) : 0
  const montoInsuficiente = comprobanteLegible && esperadoClp > 0 && monto < Math.round(esperadoClp * 0.98)
  const habilitaBlanda = comprobanteLegible && !!pointer && !montoInsuficiente
  const fmtClp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`

  // UN SOLO COMPROBANTE PARA VARIAS COTIZACIONES (Lalo 08-sep, caso Lorena:
  // dos RUT, una transferencia por el total — "no tienen que ser 2
  // transferencias"). Si el monto cubre el pago inicial de TODAS las
  // cotizaciones vivas del contacto, todas quedan Pagadas: el alta parte con
  // la principal y las demás caen en la cola del post-pago (segunda empresa).
  const otrasCubiertas: Array<{ p: QuotePointer; esperado: number }> = []
  if (habilitaBlanda && pointer && esperadoClp > 0 && pointers.length > 1) {
    try {
      let suma = esperadoClp
      const cand: Array<{ p: QuotePointer; esperado: number }> = []
      for (const o of pointers) {
        if (o.quoteId === pointer.quoteId) continue
        if (await cotizacionYaPagada(o.quoteId)) continue
        const esp = await pagoInicialEsperadoClp(o.quoteId)
        if (esp > 0) {
          cand.push({ p: o, esperado: esp })
          suma += esp
        }
      }
      if (cand.length && monto >= Math.round(suma * 0.98)) otrasCubiertas.push(...cand)
    } catch { /* sin cobertura extra: solo la principal */ }
  }
  const nombresCubiertas = [pointer?.empresa, ...otrasCubiertas.map((o) => o.p.empresa)].filter(Boolean).join(" y ")
  const acuse = (m: string) =>
    acuseComprobanteCL(m) +
    (otrasCubiertas.length
      ? `\n\nCon este pago quedan cubiertas las ${otrasCubiertas.length + 1} empresas (${nombresCubiertas}) 🙌 Partimos creando la cuenta de ${pointer?.empresa || "la primera"}; apenas quede lista seguimos con la otra por este mismo chat.`
      : "")

  const lineas = [
    declarado
      ? `Cliente DECLARÓ pago por WhatsApp — sin comprobante (${new Date().toISOString()})`
      : `Comprobante de transferencia recibido por WhatsApp (${new Date().toISOString()})`,
    `Contacto: +${contact}`,
    pointer ? `Cotización vigente: quote_id ${pointer.quoteId} · ${pointer.empresa || "-"} · RUT ${pointer.rut || "-"}` : "SIN cotización formal vigente asociada al contacto",
    asociadoPorNumero
      ? `⚠️ ASOCIACIÓN POR NÚMERO: el comprobante llegó desde un número de WhatsApp DISTINTO al de la cotización; se asoció por el número de cotización que mencionó el cliente (${(input.numeroCotizacion || "").trim()}). Verificar con más atención.`
      : "",
    `Monto según comprobante: ${montoFmt}`,
    esperadoClp > 0 ? `Pago inicial esperado (cotizador): ${fmtClp(esperadoClp)}` : "",
    montoInsuficiente
      ? `⛔ MONTO INSUFICIENTE: el comprobante (${montoFmt}) es menor al pago inicial (${fmtClp(esperadoClp)}). NO se habilitó el onboarding ni se marcó Pagada; se le pidió al cliente la diferencia de ${fmtClp(esperadoClp - monto)}.`
      : "",
    pointer?.totalClp ? `Total registrado en la cotización: $${Math.round(pointer.totalClp).toLocaleString("es-CL")} (referencial — verificar pago inicial exacto)` : "",
    ...otrasCubiertas.map(
      (o) =>
        `✅ El comprobante cubre TAMBIÉN la cotización ${o.p.quoteId} (${o.p.empresa || "-"} · RUT ${o.p.rut || "-"} · pago inicial ${fmtClp(o.esperado)}): se marca PAGADA; su alta queda EN COLA hasta que termine la de ${pointer?.empresa || pointer?.quoteId}.`,
    ),
    input.bancoOrigen ? `Banco origen: ${input.bancoOrigen}` : "",
    input.fechaDetectada ? `Fecha transferencia: ${input.fechaDetectada}` : "",
    input.detalle ? `Detalle: ${input.detalle}` : "",
    habilitaBlanda
      ? "⚠️ VALIDACIÓN BLANDA: el comprobante era legible, así que al cliente YA se le entregó el acceso al onboarding sin esperar la verificación bancaria. Si el abono NO aparece, hay que cortar el onboarding a mano."
      : "",
    declarado
      ? "ACCIÓN: verificar el abono en el banco y confirmar el pago (pago DECLARADO sin comprobante — el estado de la cotización NO fue modificado)."
      : "La cotización fue marcada como PAGADA automáticamente al recibir el comprobante (decisión Lalo 04-ago). ACCIÓN: verificar el abono en el banco; si NO aparece, revertir el estado a mano.",
  ].filter(Boolean)
  const contenidoNota = lineas.join("\n")

  // 1. Nota en la cotización de Zoho (la traza durable para finanzas).
  const notaCreada = pointer ? await crearNotaEnCotizacion(pointer.quoteId, contenidoNota) : false

  // 2. Aviso interno por el canal único (05-sep, orden de Lalo "quita las
  //    notificaciones internas que mandas a mi whatsapp"): respeta el
  //    interruptor vic_kv avisos_internos_wsp y queda persistido en el inbox.
  const avisoInterno = await avisarEquipoInterno(
    `💰 COMPROBANTE DE TRANSFERENCIA\n${contenidoNota}`,
  ).catch(() => false)

  console.log(
    `[comprobante] contact=${contact} monto=${monto} quote=${pointer?.quoteId || "-"} nota=${notaCreada} aviso=${avisoInterno}`,
  )

  // 3. Monto insuficiente: queda la nota y el aviso; el alta NO parte.
  if (montoInsuficiente && pointer) {
    await enviarCorreoCobranza({
      quoteId: pointer.quoteId,
      numeroCotizacion: (input.numeroCotizacion || "").trim() || undefined,
      empresa: pointer.empresa,
      rut: pointer.rut,
      telefono: contact,
      monto: montoFmt,
      banco: input.bancoOrigen,
      fecha: input.fechaDetectada,
      detalle: input.detalle,
      advertencia: `MONTO INSUFICIENTE: el comprobante es de ${montoFmt} y el pago inicial de la cotización es ${fmtClp(esperadoClp)}. Vicky NO habilitó el alta y le pidió al cliente la diferencia de ${fmtClp(esperadoClp - monto)}.`,
    }).catch(() => {})
    return {
      ok: true,
      mensajeParaProspecto:
        `Recibí tu comprobante por ${montoFmt} 🙌 Lo dejé asociado a tu cotización, pero el pago inicial es de ${fmtClp(esperadoClp)}, así que faltan ${fmtClp(esperadoClp - monto)}. ` +
        "Cuando transfieras la diferencia me mandas ese comprobante y dejamos tu cuenta andando al tiro 😊",
      notaCreada,
      avisoInterno,
    }
  }

  // 3bis. Pago DECLARADO sin comprobante (caso Transportes Viig, 22-jul): el
  // cliente dijo "el pago está listo" y Vicky afirmó una confirmación que no
  // existía. Ahora: se registra el AVISO para que finanzas verifique, se le
  // agradece y se le pide el comprobante para acelerar — sin afirmar nada.
  if (declarado) {
    const mensajeParaProspecto =
      `¡Gracias por avisarme! 🙌 Dejé tu pago en verificación con nuestro equipo de finanzas — apenas confirmen el abono te escribo por aquí y coordinamos los siguientes pasos. ` +
      `Si tienes el comprobante a mano, mándamelo por este mismo chat y aceleramos la confirmación 😊`
    return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
  }

  // 2bis. Correo a cobranza (petición Lalo 03-ago): con cotización asociada,
  // el pago va también por correo — no solo nota + WhatsApp interno. Incluye
  // el link del comprobante si el webhook guardó la media reciente del
  // contacto. Best-effort: su falla jamás toca la respuesta al cliente.
  if (pointer) {
    let comprobanteUrl = ""
    try {
      const kv = await getKvValue(`media_reciente_${contact}`)
      if (kv) {
        const parsed = JSON.parse(kv) as { url?: string; at?: string }
        const edadMs = parsed.at ? Date.now() - new Date(parsed.at).getTime() : Number.POSITIVE_INFINITY
        if (parsed.url && edadMs < 2 * 60 * 60 * 1000) comprobanteUrl = parsed.url
      }
    } catch {
      /* sin link — el correo sale igual */
    }
    // Fallback: si vic_kv no alcanzó a guardar la media (deploy en medio,
    // KV caído), se busca el último archivo entrante en la API de Botmaker.
    if (!comprobanteUrl && !declarado) {
      const bm = await mediaEntranteReciente(contact, 2).catch(() => null)
      if (bm?.url) comprobanteUrl = bm.url
    }
    // La imagen ORIGINAL queda adjunta en la cotización (Lalo 03-ago: "sirve
    // para gestión interna") — la nota transcribe, el attachment respalda.
    if (comprobanteUrl && !declarado) {
      await adjuntarComprobanteACotizacion(
        pointer.quoteId,
        comprobanteUrl,
        `comprobante-transferencia-${contact}`,
      ).catch(() => ({ ok: false }))
    }
    await enviarCorreoCobranza({
      quoteId: pointer.quoteId,
      numeroCotizacion: (input.numeroCotizacion || "").trim() || undefined,
      empresa: pointer.empresa,
      rut: pointer.rut,
      telefono: contact,
      monto: montoFmt,
      banco: input.bancoOrigen,
      fecha: input.fechaDetectada,
      detalle: input.detalle,
      comprobanteUrl,
      advertencia: asociadoPorNumero
        ? "El comprobante llegó desde un número de WhatsApp DISTINTO al de la cotización (se asoció por el número que mencionó el cliente). Verificar con más atención."
        : undefined,
    }).catch(() => {})
    // Comprobante real recibido → Estado_Cotizacion "Pagada" (opción 1, Lalo
    // 04-ago): dispara los workflows de Zoho amarrados al estado. Best-effort.
    // MARCAS ANTES DE "PAGADA" (Lalo 05-sep, "parece que gatilla 2 altas"):
    // marcar Pagada avisa al cotizador, y el cotizador dispara el post-pago del
    // agente (vic-quote-notify evento pagada) — que 27 s después mandaba una
    // SEGUNDA bienvenida con wizard encima del acuse de esta tool (caso
    // Leonardo/COT1142) y estampaba `pago_online_` como si fuera tarjeta. Con
    // el candado del post-pago y la marca de comprobante puestos ANTES, ese
    // camino ve "ya_enviado" y sabe que fue transferencia.
    await setKvValue(`traspaso_postpago_${pointer.quoteId}`, new Date().toISOString()).catch(() => {})
    await setKvValue(
      `comprobante_ok_${contact}`,
      JSON.stringify({ at: new Date().toISOString(), numero: (input.numeroCotizacion || "").trim() || pointer.quoteId, quoteId: pointer.quoteId }),
    ).catch(() => {})
    await marcarCotizacionPagada(pointer.quoteId).catch(() => false)
    // Y el DEAL avanza a ganado (Lalo 07-ago): misma política que "Pagada" —
    // si el abono no aparece en el banco, cobranza revierte a mano.
    await avanzarDealAGanado(pointer).catch(() => {})
    for (const o of otrasCubiertas) {
      await crearNotaEnCotizacion(o.p.quoteId, contenidoNota).catch(() => false)
      await marcarCotizacionPagada(o.p.quoteId).catch(() => false)
    }
    // GUARDRAIL DEL PAGADOR (Lalo 18-ago, caso +56978903360/COT339): cuando el
    // comprobante llega desde un número DISTINTO al de la cotización, el loop
    // del REMITENTE seguía vivo (solo se cerraba el del contacto de la
    // cotización) — 11 minutos después el toque t1 le habló como prospecto
    // nuevo, el cliente siguió la corriente y Vicky le EMITIÓ una segunda
    // cotización duplicada. Dos candados, ambos best-effort:
    // (1) el loop del remitente muere con motivo 'pagado';
    // (2) marca kv 48h → el webhook inyecta la directiva de MODO POST-VENTA
    //     (no cotizar salvo pedido explícito para OTRA empresa).
    try {
      const { pagoCierraLoop } = await import("../loop-v2")
      await pagoCierraLoop(contact, "pagado")
    } catch { /* best-effort */ }
  }

  // 3. Confirmación al cliente.
  //
  // VALIDACIÓN BLANDA: con el comprobante legible, el acceso al onboarding sale
  // AHORA. No se le pide al cliente que espere la verificación bancaria — esa
  // corre en paralelo como auditoría. Nunca se afirma que el pago está
  // confirmado: se confirma la RECEPCIÓN y se le habilita la configuración.
  if (habilitaBlanda && pointer) {
    // VICKY ONBOARDING (CL, decisión 26-jul): con el flag encendido, el
    // comprobante legible ya NO deriva al wizard web — mueve al contacto a la
    // fase onboarding y Vicky conduce el alta por este mismo chat. Es la
    // SEGUNDA puerta al post-pago (la otra es cerrarYTraspasarPostPago con el
    // pago online); las dos tienen que enrolar o el que transfiere se queda
    // fuera. El borrador se siembra con la empresa y el RUT de la cotización
    // para no volver a preguntarlos.
    //
    // Acá NO hace falta el fallback a plantilla HSM que sí lleva la vía del
    // pago online: el cliente ACABA de mandar el comprobante, así que la
    // ventana de 24 h está abierta por definición.
    if (pais === "cl" && (await onboardingActivoPara(contact))) {
      // SEGUNDA EMPRESA con el alta de la primera todavía abierta (08-sep):
      // no se re-siembra ni se manda otro formulario — queda pagada y en
      // cola (el post-pago del cotizador la encola con aviso interno).
      try {
        const faseAct = (await getKvValue(claveFase(contact)).catch(() => null)) || ""
        const anclada = (await getKvValue(claveQuoteOnboarding(contact)).catch(() => null)) || ""
        if (faseAct === "onboarding" && anclada && anclada !== pointer.quoteId) {
          const abiertaNombre = pointers.find((p) => p.quoteId === anclada)?.empresa || "la primera empresa"
          return {
            ok: true,
            mensajeParaProspecto:
              `${acuse(montoFmt)}\n\nEsta cotización (${pointer.empresa || "segunda empresa"}) queda registrada como pagada. Como ya estamos creando la cuenta de ${abiertaNombre}, apenas quede lista seguimos con ${pointer.empresa || "la segunda"} por este mismo chat 😊`,
            notaCreada,
            avisoInterno,
          }
        }
      } catch { /* sigue el camino normal */ }
      let sembrado = null
      try {
        const previo = parsearBorrador(await getKvValue(claveBorrador(contact)).catch(() => null))
        // PERSONA NATURAL (05-sep, E1): la cotización sin razón social dejaba
        // el placeholder "tu empresa" en el arranque, el modelo lo guardaba
        // como nombre de la empresa y la Implementación nacía "ASISTENCIA -
        // tu empresa". Sin razón social, el nombre es el del contacto de la
        // cotización (la cuenta "-" de Zoho cuenta como vacía).
        const limpio = (s: unknown) => { const t = String(s || "").trim(); return t === "-" ? "" : t }
        let nombreEmpresa = limpio(pointer.empresa)
        if (!nombreEmpresa) nombreEmpresa = await nombreContactoDeCotizacion(pointer.quoteId)
        sembrado = sembrarBorrador(
          previo,
          { empresa: { nombre: nombreEmpresa || undefined, identificador: pointer.rut } },
          "cl",
        )
        await setKvValue(claveBorrador(contact), JSON.stringify(sembrado))
        await setKvValue(claveFase(contact), "onboarding")
        // La cotización que abre el ciclo queda anclada (08-sep) si nadie la ancló antes.
        const yaAnclada = (await getKvValue(claveQuoteOnboarding(contact)).catch(() => null)) || ""
        if (!yaAnclada) await setKvValue(claveQuoteOnboarding(contact), pointer.quoteId).catch(() => {})
      } catch (e) {
        console.error("[comprobante] no se pudo enrolar en onboarding:", e)
      }
      // UN SOLO MENSAJE: acuse + arranque, sin push aparte (Eduardo, 26-jul:
      // el cliente no espera nada). Antes el arranque salía por
      // entregarKickoffOnboarding en paralelo, así que podía llegar ANTES que
      // el acuse — y el acuse anunciaba "te escribo en seguida", que es
      // justamente hacerlo esperar. Acá la ventana está abierta por definición
      // (el cliente acaba de mandar la imagen), así que el texto va directo,
      // renderizado del MISMO cuerpo que usa la plantilla del pago online.
      // TODO PAGO ARRANCA EL FORMULARIO (Lalo 05-sep): con el gate del Flow
      // encendido, el comprobante manda la misma plantilla "Crear cuenta" que
      // el pago con tarjeta (entregarKickoffOnboarding decide Flow o botón
      // según la ventana). La marca traspaso_postpago_<quote> evita que el
      // post-pago del cotizador vuelva a mandar el arranque si después llega
      // un pago online de la misma cotización.
      const flowOn = ((await getKvValue("alta_flow_kickoff").catch(() => null)) || "").trim() === "on"
      if (flowOn) {
        try {
          const { entregarKickoffOnboarding } = await import("@/lib/onboarding-envio")
          const nombreCliente = await nombreContactoDeCotizacion(pointer.quoteId).catch(() => "")
          const k = await entregarKickoffOnboarding(
            contact,
            sembrado?.empresa.nombre,
            sembrado?.empresa.identificador,
            nombreCliente || undefined,
          )
          if (k.via !== "fallo") {
            await setKvValue(`traspaso_postpago_${pointer.quoteId}`, new Date().toISOString()).catch(() => {})
            const cierre =
              k.via === "texto"
                ? "" // el arranque conversacional ya salió por el push del helper
                : '\n\nTe acabo de mandar el formulario "Crear cuenta": ahí completas los datos de tu empresa y del administrador en un minuto. Si prefieres, también lo hacemos conversando por aquí.'
            return { ok: true, mensajeParaProspecto: `${acuse(montoFmt)}${cierre}`, notaCreada, avisoInterno }
          }
        } catch (e) {
          console.warn("[comprobante] kickoff por formulario falló; sigue el arranque en el mensaje:", e instanceof Error ? e.message : e)
        }
      }
      const arranque = renderPlantillaOnboarding(
        paramsPlantillaOnboarding(sembrado?.empresa.nombre, sembrado?.empresa.identificador),
      )
      await setKvValue(`traspaso_postpago_${pointer.quoteId}`, new Date().toISOString()).catch(() => {})
      return {
        ok: true,
        mensajeParaProspecto: `${acuse(montoFmt)}\n\n${arranque}`,
        notaCreada,
        avisoInterno,
      }
    }

    const linkOnboarding = await obtenerLinkOnboarding(pointer.quoteId)
    if (!linkOnboarding) {
      // Sin link no hay habilitación posible: el equipo debe mandarlo a mano.
      avisarEquipoInterno(
        `⚠️ Comprobante ${pais.toUpperCase()} de +${contact}: no se pudo generar el link de auto-onboarding (quote ${pointer.quoteId}). Enviarlo a mano.`,
      ).catch(() => {})
    }

    if (pais === "mx") {
      // MX suma la presentación de la ejecutiva (única excepción a "sin
      // ejecutivo antes del pago": acá el cliente ya pagó).
      const mensajeParaProspecto = linkOnboarding
        ? `¡Recibí tu comprobante por ${montoFmt}! 🙌 Quedó asociado a tu cotización y ya te dejo habilitada la configuración de tu cuenta — no tienes que esperar nada.\n\n` +
          `Aquí tienes tu acceso al auto-onboarding: ahí configuras tu empresa y cargas a tus colaboradores en unos 15 minutos.\n${linkOnboarding}\n\n` +
          `Y te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda del proceso, me escribes por aquí 😊`
        : `¡Recibí tu comprobante por ${montoFmt}! 🙌 Quedó asociado a tu cotización y ya te estoy habilitando la configuración de tu cuenta — te paso el acceso por aquí en unos minutos.\n\n` +
          `Te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda, me escribes por aquí 😊`
      return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
    }

    // CL: recepción + habilitación inmediata, acompañada por Vicky.
    const mensajeParaProspecto = linkOnboarding
      ? `Recibí tu comprobante por ${montoFmt} 🙌 Quedó asociado a tu cotización y ya te dejo habilitada la configuración de tu cuenta — no tienes que esperar nada.\n\n` +
        `Aquí tienes tu acceso: en unos 15 minutos dejas configurada tu empresa y cargados a tus trabajadores.\n${linkOnboarding}\n\n` +
        `Cualquier duda mientras lo llenas, me escribes por acá y lo vemos juntos 😊`
      : `Recibí tu comprobante por ${montoFmt} 🙌 Quedó asociado a tu cotización y ya te estoy habilitando la configuración de tu cuenta — te paso el acceso por acá en unos minutos. Cualquier duda, me escribes 😊`
    return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
  }

  // Sin habilitación blanda: comprobante ilegible, o sin cotización formal
  // asociada al contacto. Acá NO hay nada que validar, así que se mantiene el
  // mensaje de verificación con el plazo transparente (decisión Lalo 25-jul).
  // COMPROBANTE ANTES DE LA FORMAL (05-sep, prueba E6): el cliente transfirió
  // con el precio referencial y mandó la foto antes de dar RUT y correo. Sin
  // puntero no había a qué asociarlo, la formal salía después y nadie volvía
  // a mirar el comprobante: el cliente quedaba "esperando a finanzas" para
  // siempre, sin alta y sin onboarding. Se guarda 48 h; la emisión de la
  // formal lo lee y ordena asociarlo en ese mismo turno.
  if (!pointer && monto > 0) {
    await setKvValue(
      `comprobante_pendiente_${contact}`,
      JSON.stringify({
        at: new Date().toISOString(),
        monto,
        bancoOrigen: input.bancoOrigen || "",
        fechaDetectada: input.fechaDetectada || "",
        detalle: input.detalle || "",
      }),
    ).catch(() => {})
  }
  const mensajeParaProspecto = pointer
    ? `Recibí tu comprobante 🙌 Ya quedó asociado a tu cotización — no alcancé a leer el monto, así que lo está revisando nuestro equipo (toma máximo 24 horas hábiles). Apenas quede confirmado te escribo por aquí para partir con la configuración de tu cuenta. Si quieres acelerarlo, mándame el comprobante de nuevo con la imagen más nítida 😊`
    : monto > 0
      ? `Recibí tu comprobante por ${montoFmt} 🙌 Para dejarlo asociado y activarte la cuenta me falta solo emitir tu cotización formal: pásame el RUT de la empresa y tu correo y en un minuto queda todo ligado 😊`
      : `Recibí tu comprobante 🙌 Lo dejé en manos del equipo para asociarlo a tu cotización — la verificación toma máximo 24 horas hábiles. Apenas se confirme te escribo por aquí para partir con la configuración de tu cuenta. ¡Gracias!`

  return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
}
