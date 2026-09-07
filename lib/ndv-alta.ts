/**
 * NDV ANTES DE LA IMPLEMENTACIÓN — el trabajo post-alta del onboarding por chat.
 *
 * Orden de Lalo (07-sep): "la nota de venta la confirmamos NOSOTROS en el
 * flujo, antes de crear la implementación, para tener el ID desde antes". El
 * alta crea la empresa en la plataforma (companyId) y desde ahí:
 *
 *   1. el COTIZADOR (`/api/creator/ndv-alta-chat`) convierte el espejo de la
 *      cotización pagada en Nota de Venta con la empresa YA creada, la
 *      confirma cuando su PDF existe y devuelve la Referencia NDV del CRM;
 *   2. recién con ese id nace la Implementación GV Avanzado enlazada a la NDV
 *      (Nota_de_Venta_Asociada) y la cotización queda con NDV + IMP.
 *
 * Nada de esto cabe con certeza en el turno del webhook (la confirmación
 * espera un PDF que Creator genera en background), así que es un JOB en
 * vic_kv (`onb_ndvimp_<contacto>`) que se intenta una vez en línea y que el
 * cron `vic-onboarding-ndv-imp` (cada ~2', vía despachador) sigue empujando
 * hasta terminar. Idempotente: el estado vive en el propio job.
 *
 * Tope (env VICKY_NDV_ALTA_TOPE_MIN, default 30'): si la NDV no se logra en
 * ese plazo, la Implementación nace IGUAL (el cliente ya pagó y ya tiene su
 * cuenta; el relator no puede esperar a Creator) con aviso interno, y el job
 * sigue intentando enlazar la NDV hasta 24 h.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { claveCapacitacion } from "./onboarding/fase"

export const claveJobNdvImp = (contact: string) => `onb_ndvimp_${contact.replace(/\D/g, "")}`

export type JobNdvImp = {
  contact: string
  quoteId?: string
  companyId: string
  empresa: string
  rut?: string
  creadoAt: string
  intentos: number
  ultimoIntentoAt?: string
  enCursoAt?: string
  ndv?: { ndvId?: string; idNdv?: string; referenciaId?: string; estado?: string; descuadreUF?: number | null }
  ndvPendiente?: string
  ndvError?: string
  /** El cotizador dijo que no se puede (sin espejo, etc.): no se insiste. */
  ndvImposible?: boolean
  impId?: string
  impNumero?: string
  impSinNdv?: boolean
  terminadoAt?: string
  motivoFin?: string
}

const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const TOPE_NDV_MIN = Math.max(5, Number(process.env.VICKY_NDV_ALTA_TOPE_MIN || 30) || 30)
const TOPE_ENLACE_H = 24
const MAX_INTENTOS_IMP = 12

async function leerJob(contact: string): Promise<JobNdvImp | null> {
  const crudo = await getKvValue(claveJobNdvImp(contact)).catch(() => null)
  if (!crudo) return null
  try {
    const j = JSON.parse(crudo) as JobNdvImp
    return j && j.companyId ? j : null
  } catch {
    return null
  }
}

async function guardarJob(job: JobNdvImp): Promise<void> {
  await setKvValue(claveJobNdvImp(job.contact), JSON.stringify(job)).catch(() => {})
}

/** Encola (o refresca) el job tras un alta exitosa. No pisa un job vivo del
 * mismo contacto con la misma empresa (reintentos del alta). */
export async function encolarNdvImp(
  contact: string,
  datos: { companyId: string; empresa: string; rut?: string; quoteId?: string },
): Promise<JobNdvImp> {
  const c = contact.replace(/\D/g, "")
  const previo = await leerJob(c)
  if (previo && !previo.terminadoAt && previo.companyId === datos.companyId) return previo
  let quoteId = (datos.quoteId || "").trim()
  if (!quoteId) {
    try {
      const { getQuotePointers } = await import("./supabase-persistence-v3")
      const punteros = await getQuotePointers(c).catch(() => [])
      quoteId = (punteros.find((x) => (x.quoteId || "").trim())?.quoteId || "").trim()
    } catch {
      /* sin puntero: la implementación nace sin NDV */
    }
  }
  const job: JobNdvImp = {
    contact: c,
    quoteId: quoteId || undefined,
    companyId: datos.companyId,
    empresa: datos.empresa,
    rut: datos.rut,
    creadoAt: new Date().toISOString(),
    intentos: 0,
  }
  await guardarJob(job)
  return job
}

type RespuestaNdvAlta = {
  ok?: boolean
  listo?: boolean
  reintentable?: boolean
  pendiente?: string
  error?: string
  ndvId?: string
  idNdv?: string
  referenciaId?: string
  estadoReferencia?: string
  descuadreUF?: number | null
  yaEstaba?: boolean
}

async function pedirNdvAlta(job: JobNdvImp): Promise<RespuestaNdvAlta> {
  const secret = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
  const ctrl = new AbortController()
  const corte = setTimeout(() => ctrl.abort(), 58_000)
  try {
    const r = await fetch(`${COTIZADORA_API_BASE}/api/creator/ndv-alta-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-vicky-secret": secret } : {}) },
      body: JSON.stringify({ quoteId: job.quoteId, companyId: job.companyId, empresaNombre: job.empresa, rut: job.rut }),
      cache: "no-store",
      signal: ctrl.signal,
    })
    const j = (await r.json().catch(() => ({}))) as RespuestaNdvAlta
    if (!r.ok && !j.error) j.error = `HTTP ${r.status}`
    return j
  } catch (e) {
    return { ok: false, reintentable: true, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(corte)
  }
}

/**
 * Una pasada del job: avanza NDV → Implementación → enlace. Devuelve el
 * estado para el log del cron. Segura de llamar en paralelo (candado
 * `enCursoAt` de 90 s) y de repetir (cada paso mira lo ya hecho).
 */
export async function procesarNdvImp(contact: string): Promise<{ estado: string; job?: JobNdvImp }> {
  const c = contact.replace(/\D/g, "")
  const job = await leerJob(c)
  if (!job) return { estado: "sin_job" }
  if (job.terminadoAt) return { estado: "terminado", job }
  if (job.enCursoAt && Date.now() - Date.parse(job.enCursoAt) < 90_000) return { estado: "en_curso", job }
  job.enCursoAt = new Date().toISOString()
  job.intentos = (job.intentos || 0) + 1
  job.ultimoIntentoAt = job.enCursoAt
  await guardarJob(job)

  const edadMin = (Date.now() - Date.parse(job.creadoAt)) / 60e3
  try {
    // 1. NDV (solo si hay cotización y aún no tenemos la referencia).
    if (job.quoteId && !job.ndv?.referenciaId && !job.ndvImposible) {
      const r = await pedirNdvAlta(job)
      if (r.listo && r.referenciaId) {
        job.ndv = {
          ndvId: r.ndvId,
          idNdv: r.idNdv,
          referenciaId: r.referenciaId,
          estado: r.estadoReferencia,
          descuadreUF: r.descuadreUF ?? null,
        }
        job.ndvPendiente = undefined
        job.ndvError = undefined
        if (typeof r.descuadreUF === "number" && Math.abs(r.descuadreUF) > 0.005) {
          await avisarEquipoInterno(
            `⚠️ NDV ${r.idNdv || ""} de ${job.empresa}: el mensual de la nota difiere de lo vendido en ${r.descuadreUF > 0 ? "+" : ""}${r.descuadreUF} UF — revisar en Creator antes de facturar.`,
          ).catch(() => {})
        }
      } else {
        job.ndvPendiente = r.pendiente || (r.ok === false ? "error" : "sin_respuesta")
        job.ndvError = r.error
        if (r.reintentable === false) {
          job.ndvImposible = true
          await avisarEquipoInterno(
            `⚠️ NDV del alta por chat de ${job.empresa} (companyId ${job.companyId}) NO se pudo generar automáticamente: ${r.error || "sin detalle"}. Hay que convertir/confirmar la nota a mano en Creator.`,
          ).catch(() => {})
        }
      }
    }

    // 2. Implementación: con la NDV lista, o vencido el tope, o si la NDV es
    //    imposible / no hay cotización.
    const ndvLista = Boolean(job.ndv?.referenciaId)
    const puedeCrearImp = ndvLista || job.ndvImposible || !job.quoteId || edadMin >= TOPE_NDV_MIN
    if (!job.impId && puedeCrearImp) {
      // Idempotencia extra: si otra vía ya dejó implementación en la
      // capacitación del contacto, se adopta en vez de crear otra.
      const capCruda = await getKvValue(claveCapacitacion(c)).catch(() => null)
      const cap = capCruda ? (JSON.parse(capCruda) as { implementacionId?: string; numero?: string }) : null
      if (cap?.implementacionId) {
        job.impId = cap.implementacionId
        job.impNumero = cap.numero || undefined
      } else {
        const m = await import("./implementacion-vicky")
        const ctx = await m.contextoImplementacionDesdeVenta(c)
        const imp = await m.crearImplementacionGvAvanzado({
          ...ctx,
          razonSocial: job.empresa,
          rut: job.rut,
          companyId: job.companyId,
          ndvId: job.ndv?.referenciaId,
          comentarios:
            `Alta por chat de Vicky (companyId ${job.companyId}). Empresa YA creada en la plataforma; no requiere creación.` +
            (job.ndv?.idNdv ? ` Nota de venta ${job.ndv.idNdv} confirmada.` : " Nota de venta pendiente de confirmar."),
        })
        if (imp) {
          job.impId = imp.id
          job.impNumero = imp.numero
          job.impSinNdv = !ndvLista
          await setKvValue(
            claveCapacitacion(c),
            JSON.stringify({ implementacionId: imp.id, numero: imp.numero || "", relator: imp.relator, empresa: job.empresa }),
          ).catch(() => {})
          await avisarEquipoInterno(
            `🛠️ IMPLEMENTACIÓN GV Avanzado creada para ${job.empresa} → ${imp.relator.nombre} (${imp.relator.email})${imp.numero ? ` · ${imp.numero}` : ""}` +
              (ndvLista
                ? ` · ${job.ndv?.idNdv || "NDV"} confirmada y enlazada.`
                : ` · SIN nota de venta todavía (${job.ndvPendiente || "pendiente"}${job.ndvError ? `: ${job.ndvError}` : ""}) — se sigue intentando enlazarla.`),
          ).catch(() => {})
        } else if (job.intentos >= MAX_INTENTOS_IMP) {
          await avisarEquipoInterno(
            `⚠️ NO se pudo crear la implementación de ${job.empresa} (companyId ${job.companyId}) tras ${job.intentos} intentos. La empresa SÍ quedó creada — hay que abrir la implementación a mano.`,
          ).catch(() => {})
          job.terminadoAt = new Date().toISOString()
          job.motivoFin = "imp_fallo"
        }
      }
    }

    // 3. Enlace tardío: la implementación nació sin NDV y la NDV llegó después.
    if (job.impId && job.impSinNdv && job.ndv?.referenciaId) {
      const { getZohoAccessToken } = await import("./zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
      const ok = await fetch(`${api}/crm/v3/Implementaciones/${job.impId}`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ Nota_de_Venta_Asociada: { id: job.ndv.referenciaId } }], trigger: ["blueprint"] }),
      })
        .then((r) => r.ok)
        .catch(() => false)
      if (job.quoteId) {
        await fetch(`${api}/crm/v3/Cotizaciones_GeoVictoria/${job.quoteId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [{ Nota_de_Venta: { id: job.ndv.referenciaId } }] }),
        }).catch(() => null)
      }
      if (ok) {
        job.impSinNdv = false
        await avisarEquipoInterno(
          `🔗 ${job.ndv.idNdv || "NDV"} de ${job.empresa} quedó confirmada y enlazada a ${job.impNumero || "la implementación"}.`,
        ).catch(() => {})
      }
    }

    // 4. Cierre del job.
    if (job.impId && !job.impSinNdv) {
      job.terminadoAt = new Date().toISOString()
      job.motivoFin = "completo"
    } else if (job.impId && (job.ndvImposible || !job.quoteId)) {
      job.terminadoAt = new Date().toISOString()
      job.motivoFin = job.ndvImposible ? "ndv_imposible" : "sin_cotizacion"
    } else if (job.impId && edadMin >= TOPE_ENLACE_H * 60) {
      job.terminadoAt = new Date().toISOString()
      job.motivoFin = "ndv_no_llego"
      await avisarEquipoInterno(
        `⚠️ La NDV de ${job.empresa} (${job.impNumero || job.impId}) no se logró en ${TOPE_ENLACE_H} h (${job.ndvPendiente || "pendiente"}${job.ndvError ? `: ${job.ndvError}` : ""}). Convertir/confirmar a mano en Creator y enlazarla.`,
      ).catch(() => {})
    }
  } catch (e) {
    job.ndvError = e instanceof Error ? e.message : String(e)
    console.warn(`[ndv-alta] ${c}: pasada falló:`, job.ndvError)
  } finally {
    job.enCursoAt = undefined
    await guardarJob(job)
  }
  return { estado: job.terminadoAt ? `terminado:${job.motivoFin}` : job.impId ? "imp_creada_ndv_pendiente" : "esperando_ndv", job }
}

/** Contactos con job vivo (para el cron). */
export async function contactosConJobNdvImp(): Promise<string[]> {
  const url = (process.env.SUPABASE_URL || "").trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!url || !key) return []
  const filas = (await fetch(`${url}/rest/v1/vic_kv?key=like.onb_ndvimp_*&select=key,value&limit=200`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ key: string; value: string }>
  return filas
    .filter((f) => {
      try {
        return !(JSON.parse(f.value) as JobNdvImp).terminadoAt
      } catch {
        return false
      }
    })
    .map((f) => f.key.replace(/^onb_ndvimp_/, ""))
}
