/**
 * Dashboard de embudo (Sankey) de las conversaciones de Vicky V3.
 *
 * GET /api/vic-funnel?key=<VIC_FUNNEL_KEY>
 *
 * Página HTML en vivo (Sankey con Plotly + KPIs + hallazgos). Lee la tabla
 * vic_v3_conversation_analysis, que puebla el cron /api/vic-funnel-cron cada
 * hora con la clasificación semántica (Claude). Jerarquía:
 *
 *   Conversaciones
 *     → Intención comercial → { Crosselling, Callback, Reunión, Cotización }
 *                                 Cotización → { Enviada, Fuga, Rechazo, Sin preform }
 *     → Soporte
 *     → No identificado
 */

import { createHash } from "node:crypto"

import { esEmailInterno, isTestContact, metricsContactSet } from "@/lib/funnel-analysis"
import { getZohoAccessToken, getZohoAccessTokenFresco } from "@/lib/zoho-token"
import { estadoCotizacion, chatVickyCotizaciones, buscarCotizacionPorNumero, enviarCotizacionAlClienteDirecto, infoDeal, chatVickyCotizacionesCrear, chatVickyCotizacionesPreform, type EstadoCotizacion, type InfoDeal } from "@/lib/cotizaciones-editor"
import { chatVickyPropuestas, propuestaGuardada, renderPropuestaHtml } from "@/lib/propuestas-editor"

export const dynamic = "force-dynamic"
// El chat de Vicky Cotizaciones corre un loop de tool use contra la cotizadora
// y Zoho: necesita más que los 10 s por defecto.
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()
// Clave de acceso humano al dashboard (pedido Lalo 04-ago). El ?key= sigue
// vigente para consumidores máquina (cron del resumen, links del correo).
// Semilla del token de sesión (ya no es clave de login): rotarla desloguea a
// TODOS al instante (hecho 07-ago a pedido de Lalo, para estrenar el login
// por correo con todo el mundo re-autenticado).
const DASH_CLAVE = (process.env.VIC_DASH_CLAVE || "vic-dash-v2-2026-08-07").trim()
// Entrada directa como ADMINISTRADOR con clave (Lalo 07-ago) — alternativa al
// código por correo, para admins. Rotable por env sin deploy.
const ADMIN_CLAVE = (process.env.VIC_DASH_ADMIN_CLAVE || "Atcom2061*").trim()
const authToken = () => createHash("sha256").update(`${DASH_CLAVE}|${FUNNEL_KEY}|vic-dash`).digest("hex")
const cookieDe = (req: Request, nombre: string): string => {
  const jar = req.headers.get("cookie") || ""
  const m = jar.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`))
  return m ? m[1] : ""
}
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const VICKY_CREATOR_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

// Cotizaciones formales creadas por Vicky en Zoho — fuente de verdad del CIERRE
// (aceptadas/pagadas). Best-effort: si Zoho no responde, la página igual carga y
// la sección de tasa de cierre indica que Zoho no está disponible. Se cuentan
// client-side (son decenas, no miles) para no depender de count() de COQL.
// Este dash es de Vicky CHILE: se excluyen las cotizaciones de conversaciones
// de la línea CO (por id) y los registros de prueba (por nombre).

// ── Ventas cerradas (pedido Lalo 20-jul): tabla con empresa, inicio de la
// conversación, fecha de pago, monto y tiempo a cierre. El monto se calcula
// desde los ítems congelados en Zoho (Subtotal_CLP del día de emisión):
// pago inicial = (Σ recurrentes × (1−dcto) + Σ pago único) × 1.19 — validado
// al peso contra Mercado Pago (COT233/COT242 = $29.163). Como una venta
// pagada es inmutable, cada fila se cachea en vic_kv (venta_dash_v2_<id>).
type RawAceptada = {
  id?: string
  Name?: string
  Numero_Cotizacion?: string
  Estado_Cotizacion?: string
  Intervenci_n_Humana?: string | null
  Fecha_Hora_Cotizacion?: string | null
  Tel_fono_Contacto?: string | null
  Email_Contacto?: string | null
  Created_Time?: string
  Modified_Time?: string
  Descuento_Recurrente_Pct?: number | null
  "Cuenta_Asociada.Account_Name"?: string | null
  Onboarding_Link?: string | null
  "Owner.first_name"?: string | null
  "Owner.last_name"?: string | null
  "Deal_Asociado.Stage"?: string | null
  "Deal_Asociado.id"?: string | null
}

type VentaCerrada = {
  empresa: string
  numero: string
  inicioIso: string
  inicioAprox: boolean
  pagoIso: string
  montoClp: number
  /** Desglose del pago inicial (pedido Lalo 04-ago): fee que queda como
   * recurrencia mensual vs pagos por una sola vez (reloj/envío/instalación). */
  recurrenteClp: number
  unicoClp: number
  usuarios: string
  descuentoPct: number
  /** id de la conversación de WhatsApp, para el link "ver conversación". */
  convId: string
}

/** PANEL SLA DE LLAMADA POST-TRASPASO (punto 1, Lalo 08-ago): el proceso
 * asume que el vendedor llama en <5 minutos y nadie lo medía. Por vendedor,
 * últimos 7 días: traspasos, contactados (WhatsApp espejado, llamada
 * contestada o marca manual 🤝), mediana de minutos al primer contacto y %
 * dentro de 5/60 min. La escalada automática avisa a los 60 min hábiles. */
async function renderPanelSla(): Promise<string> {
  const desde = new Date(Date.now() - 7 * 24 * 3600e3).toISOString()
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const q = async <T,>(path: string): Promise<T[]> => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
      return r.ok ? ((await r.json()) as T[]) : []
    } catch { return [] }
  }
  const ptv = await q<{ contact: string; vendedor_email: string | null; vendedor_nombre: string | null; traspasado_at: string }>(
    `vic_ptv?traspasado_at=gte.${encodeURIComponent(desde)}&select=contact,vendedor_email,vendedor_nombre,traspasado_at&order=traspasado_at.desc&limit=400`,
  )
  if (!ptv.length) return ""
  // Última fila por contacto (vienen ordenadas desc) y tope de URL.
  const porContacto = new Map<string, (typeof ptv)[number]>()
  for (const r of ptv) if (!porContacto.has(r.contact)) porContacto.set(r.contact, r)
  const contactos = [...porContacto.keys()].slice(0, 150)
  const lista = contactos.map((c) => `"${c}"`).join(",")
  const listaKv = contactos.map((c) => `"atencion_manual_${c}"`).join(",")
  const [msjs, llams, kvs] = await Promise.all([
    q<{ telefono_chat: string; enviado_at: string }>(`vic_wa_espejo_mensajes?telefono_chat=in.(${lista})&from_me=eq.true&es_grupo=eq.false&select=telefono_chat,enviado_at&limit=5000`),
    q<{ telefono: string; at: string }>(`vic_wa_espejo_llamadas?telefono=in.(${lista})&estado=eq.accept&select=telefono,at&limit=2000`),
    q<{ key: string; value: string }>(`vic_kv?key=in.(${listaKv})&select=key,value&limit=500`),
  ])
  const eventos = new Map<string, number[]>()
  const evt = (tel: string, iso: string) => {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return
    const arr = eventos.get(tel) || []
    arr.push(t)
    eventos.set(tel, arr)
  }
  for (const m of msjs) evt(m.telefono_chat, m.enviado_at)
  for (const l of llams) evt(l.telefono, l.at)
  for (const k of kvs) evt(String(k.key).replace("atencion_manual_", ""), k.value)
  type Agg = { n: number; atendidos: number; minutos: number[]; d5: number; d60: number }
  const porVendedor = new Map<string, Agg>()
  for (const c of contactos) {
    const r = porContacto.get(c)!
    const key = r.vendedor_nombre || r.vendedor_email || "(sin vendedor)"
    const a = porVendedor.get(key) || { n: 0, atendidos: 0, minutos: [], d5: 0, d60: 0 }
    a.n++
    const t0 = Date.parse(r.traspasado_at) - 5 * 60_000
    const primero = (eventos.get(c) || []).filter((t) => t >= t0).sort((x, y) => x - y)[0]
    if (primero !== undefined) {
      a.atendidos++
      const min = Math.max(0, (primero - Date.parse(r.traspasado_at)) / 60_000)
      a.minutos.push(min)
      if (min <= 5) a.d5++
      if (min <= 60) a.d60++
    }
    porVendedor.set(key, a)
  }
  const filas = [...porVendedor.entries()]
    .sort((x, y) => y[1].n - x[1].n)
    .map(([nombre, a]) => {
      const med = a.minutos.length
        ? Math.round([...a.minutos].sort((x, y) => x - y)[Math.floor(a.minutos.length / 2)])
        : null
      const sin = a.n - a.atendidos
      const pct = (v: number) => (a.n ? `${Math.round((v / a.n) * 100)}%` : "—")
      return `<tr><td>${nombre}</td><td style="text-align:center">${a.n}</td><td style="text-align:center">${a.atendidos}</td><td style="text-align:center;font-weight:600;color:${sin ? "#b91c1c" : "#166534"}">${sin}</td><td style="text-align:center">${med === null ? "—" : `${med} min`}</td><td style="text-align:center">${pct(a.d5)}</td><td style="text-align:center">${pct(a.d60)}</td></tr>`
    })
    .join("")
  return `
  <div class="kgroup">SLA de llamada post-traspaso · últimos 7 días <span class="pct" title="Contacto = mensaje desde el WhatsApp espejado del vendedor, llamada de WhatsApp contestada, o marca manual 🤝 del dashboard. La escalada automática alerta a los 60 min hábiles sin contacto.">¿cómo se mide?</span></div>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left"><th>Vendedor</th><th style="text-align:center">Traspasos</th><th style="text-align:center">Contactados</th><th style="text-align:center">Sin contacto</th><th style="text-align:center">Mediana 1er contacto</th><th style="text-align:center">≤ 5 min</th><th style="text-align:center">≤ 60 min</th></tr></thead>
    <tbody>${filas}</tbody>
  </table></div>`
}

/** PANEL RESPUESTA POR PLANTILLA (punto 4 de la segunda tanda, Lalo 08-ago):
 * cada toque del loop queda registrado (vic_kv tqlog_*, 15 días) y acá se
 * mide cuáles generan respuesta del cliente en 24 h y cuáles queman
 * contactos — con esto se reescriben las plantillas débiles con datos.
 * Precedente: vicky_lead_nudge tenía 100% lectura y 0% respuesta. */
async function renderPanelPlantillas(): Promise<string> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const q = async <T,>(path: string): Promise<T[]> => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
      return r.ok ? ((await r.json()) as T[]) : []
    } catch { return [] }
  }
  const filasKv = await q<{ key: string; value: string }>(`vic_kv?key=like.tqlog_%25&select=key,value&limit=2000`)
  const titulo = `<div class="kgroup">Respuesta por plantilla del loop · últimos 15 días <span class="pct" title="Un toque cuenta como respondido si el cliente escribió dentro de las 24 horas siguientes. El registro partió el 08-ago.">¿cómo se mide?</span></div>`
  const eventos: Array<{ c: string; tpl: string; at: number }> = []
  for (const f of filasKv) {
    try {
      const v = JSON.parse(f.value) as { c?: string; tpl?: string; at?: string }
      const at = Date.parse(String(v.at || ""))
      if (v.c && v.tpl && Number.isFinite(at)) eventos.push({ c: v.c, tpl: v.tpl, at })
    } catch { /* fila ilegible */ }
  }
  if (!eventos.length) {
    return `${titulo}<div class="sub" style="margin:4px 0 12px">Sin datos aún — el registro de toques partió el 08-ago en la noche; esta tabla se llena sola con la operación.</div>`
  }
  const contactos = [...new Set(eventos.map((e) => e.c))].slice(0, 120)
  const convs = await q<{ id: string; contact: string }>(
    `vic_v3_conversations?contact=in.(${contactos.map((c) => `"${c}"`).join(",")})&select=id,contact&limit=300`,
  )
  const contactoPorConv = new Map(convs.map((c) => [c.id, c.contact]))
  const minAt = new Date(Math.min(...eventos.map((e) => e.at))).toISOString()
  const msjs = await q<{ conversation_id: string; at: string }>(
    `vic_v3_messages?role=eq.user&conversation_id=in.(${convs.map((c) => `"${c.id}"`).join(",")})&at=gte.${encodeURIComponent(minAt)}&select=conversation_id,at&limit=5000`,
  )
  const userTs = new Map<string, number[]>()
  for (const m of msjs) {
    const c = contactoPorConv.get(m.conversation_id)
    if (!c) continue
    const t = Date.parse(m.at)
    if (!Number.isFinite(t)) continue
    const arr = userTs.get(c) || []
    arr.push(t)
    userTs.set(c, arr)
  }
  type Agg = { n: number; resp: number }
  const porTpl = new Map<string, Agg>()
  for (const e of eventos) {
    const a = porTpl.get(e.tpl) || { n: 0, resp: 0 }
    a.n++
    if ((userTs.get(e.c) || []).some((t) => t > e.at && t <= e.at + 24 * 3600e3)) a.resp++
    porTpl.set(e.tpl, a)
  }
  const filas = [...porTpl.entries()]
    .sort((x, y) => y[1].n - x[1].n)
    .map(([tpl, a]) => {
      const pct = a.n ? Math.round((a.resp / a.n) * 100) : 0
      const color = pct >= 15 ? "#166534" : pct >= 5 ? "#92700c" : "#b91c1c"
      return `<tr><td style="font-family:monospace;font-size:12px">${tpl}</td><td style="text-align:center">${a.n}</td><td style="text-align:center">${a.resp}</td><td style="text-align:center;font-weight:700;color:${color}">${pct}%</td></tr>`
    })
    .join("")
  return `${titulo}
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left"><th>Plantilla / toque</th><th style="text-align:center">Enviados</th><th style="text-align:center">Respondieron en 24h</th><th style="text-align:center">% respuesta</th></tr></thead>
    <tbody>${filas}</tbody>
  </table></div>`
}

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    const rows = r.ok ? ((await r.json()) as Array<{ value?: string }>) : []
    return rows[0]?.value || ""
  } catch {
    return ""
  }
}

async function kvSet(key: string, value: string, expiresAt?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(expiresAt ? { key, value, expires_at: expiresAt } : { key, value }),
    cache: "no-store",
  }).catch(() => {})
}

/** Pagada = link de onboarding (flujo MP) O estado "Pagada" en Zoho. El
 * segundo criterio es la venta por TRANSFERENCIA: marcarCotizacionPagada
 * (07-ago) deja Estado_Cotizacion="Pagada" sin pasar por texto "acept" y sin
 * Onboarding_Link garantizado — con el filtro viejo esas ventas desaparecían
 * de "Ventas cerradas" y los KPIs (cazado 11-ago con COT334/COT408). */
function esPagada(q: { Estado_Cotizacion?: string | null; Onboarding_Link?: string | null }): boolean {
  if (String(q.Onboarding_Link || "").trim()) return true
  return String(q.Estado_Cotizacion || "").toLowerCase().includes("pagad")
}

function esAceptadaOMas(q: { Estado_Cotizacion?: string | null; Onboarding_Link?: string | null }): boolean {
  return esPagada(q) || String(q.Estado_Cotizacion || "").toLowerCase().includes("acept")
}

async function construirVentasCerradas(aceptadas: RawAceptada[]): Promise<VentaCerrada[]> {
  const token = await getZohoAccessToken().catch(() => "")
  const ventas: VentaCerrada[] = []
  // Caché completa en lecturas por LOTE (19-ago, "el dash carga lento"): el
  // kvGet POR VENTA eran ~50 viajes seriales a Supabase en cada carga —
  // varios segundos solo en leer una caché que casi siempre está completa.
  const cachePorId = new Map<string, string>()
  {
    const ids = [...new Set(aceptadas.map((q) => String(q.id || "")).filter(Boolean))]
    for (let i = 0; i < ids.length; i += 80) {
      const keys = ids.slice(i, i + 80).map((id) => `"venta_dash_v3_${id}"`).join(",")
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys})&select=key,value`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cache: "no-store",
      }).catch(() => null)
      const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) : []
      for (const row of rows) cachePorId.set(String(row.key).replace(/^venta_dash_v3_/, ""), String(row.value || ""))
    }
  }
  for (const q of aceptadas) {
    const id = String(q.id || "")
    if (!id) continue
    const cacheKey = `venta_dash_v3_${id}`
    const cached = cachePorId.get(id) || ""
    if (cached) {
      try {
        const venta = JSON.parse(cached) as VentaCerrada
        // Caché de antes del desglose único/recurrente (04-ago): se salta el
        // push para recomputarla una vez con los campos nuevos.
        if (typeof venta.recurrenteClp === "number" && typeof venta.unicoClp === "number") {
          // Ventas cacheadas antes de que existiera el link a la conversación:
          // se les completa el convId una vez y se re-cachean.
          if (!venta.convId) {
            venta.convId = ""
            const fonoCache = digits(String(q.Tel_fono_Contacto || ""))
            if (fonoCache) {
              const r = await fetch(
                `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fonoCache}&select=id&order=started_at.asc&limit=1`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
              ).catch(() => null)
              const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ id?: string }>) : []
              venta.convId = String(rows[0]?.id || "")
              if (venta.convId) await kvSet(cacheKey, JSON.stringify(venta))
            }
          }
          ventas.push(venta)
          continue
        }
      } catch {
        // caché corrupta → recomputar
      }
    }
    // Monto: ítems del subform (getRecord completo, 1 sola vez por venta).
    let montoClp = 0
    let recurrenteClp = 0
    let unicoClp = 0
    let usuarios = "—"
    let descuentoPct = 0
    if (token) {
      try {
        const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${id}`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        })
        const body = (await r.json().catch(() => null)) as {
          data?: Array<{
            Descuento_Recurrente_Pct?: number
            Detalle_Items_Cotizacion?: Array<{
              Subtotal_CLP?: number
              Es_Recurrente?: boolean
              Codigo_Item?: string
              Modalidad?: string
              Cantidad?: number
            }>
          }>
        } | null
        const rec = body?.data?.[0]
        const pct = Number(rec?.Descuento_Recurrente_Pct ?? q.Descuento_Recurrente_Pct ?? 0) || 0
        descuentoPct = pct
        const items = rec?.Detalle_Items_Cotizacion || []
        // Usuarios/tramo: del ítem de asistencia — "Por usuario" trae la
        // cantidad real; "Fijo" es el plan de tarifa fija del tramo 1-10.
        const asistencia = items.find((i) => (i.Codigo_Item || "") === "asistencia")
        if (asistencia) {
          usuarios =
            String(asistencia.Modalidad || "").toLowerCase() === "fijo"
              ? "1-10 (tarifa fija)"
              : `${Number(asistencia.Cantidad) || 0}`
        }
        const recurrente = items.filter((i) => i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        const unico = items.filter((i) => !i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        recurrenteClp = Math.round(recurrente * (1 - pct / 100) * 1.19)
        unicoClp = Math.round(unico * 1.19)
        montoClp = recurrenteClp + unicoClp
      } catch {
        montoClp = 0
        recurrenteClp = 0
        unicoClp = 0
      }
    }
    // Inicio de conversación: started_at por teléfono; fallback: creación de
    // la cotización. El id de esa conversación alimenta el link "ver conversación".
    const fono = digits(String(q.Tel_fono_Contacto || ""))
    let inicioIso = ""
    let convId = ""
    if (fono) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fono}&select=id,started_at&order=started_at.asc&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
        )
        const rows = r.ok ? ((await r.json()) as Array<{ id?: string; started_at?: string }>) : []
        inicioIso = rows[0]?.started_at || ""
        convId = String(rows[0]?.id || "")
      } catch {
        inicioIso = ""
      }
    }
    const inicioAprox = !inicioIso
    if (!inicioIso) inicioIso = String(q.Created_Time || "")
    const pagoIso = String(q.Fecha_Hora_Cotizacion || q.Modified_Time || "")
    const empresa =
      String(q["Cuenta_Asociada.Account_Name"] || "").trim() ||
      String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim() ||
      "(sin nombre)"
    const venta: VentaCerrada = {
      empresa,
      numero: String(q.Numero_Cotizacion || ""),
      inicioIso,
      inicioAprox,
      pagoIso,
      montoClp,
      recurrenteClp,
      unicoClp,
      usuarios,
      descuentoPct,
      convId,
    }
    ventas.push(venta)
    // Cinturón: al kv de ventas SOLO entran pagadas reales (Onboarding_Link
    // o estado Pagada) — una Aceptada sin pago jamás se registra como venta.
    if (montoClp > 0 && pagoIso && esPagada(q)) await kvSet(cacheKey, JSON.stringify(venta))
  }
  return ventas.sort((a, b) => (b.pagoIso || "").localeCompare(a.pagoIso || ""))
}

/** Fee mensual RECURRENTE por contacto (pedido Lalo 04-ago): suma de los ítems
 * Es_Recurrente del subform de la cotización, con descuento y con IVA — deja
 * fuera compra/envío/instalación del reloj. Caché por quote en vic_kv (48 h);
 * los que falten se completan de a poco en cargas siguientes (tope por carga
 * para no reventar el tiempo de la función). */
async function fetchFeesMensuales(
  pares: Array<{ contact: string; quoteId: string }>,
): Promise<Map<string, { uf: number | null; clp: number | null; usuarios: number | null }>> {
  const out = new Map<string, { uf: number | null; clp: number | null; usuarios: number | null }>()
  if (!pares.length) return out
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const cache = new Map<string, { uf: number | null; clp: number | null; usuarios: number | null }>()
  const ids = [...new Set(pares.map((p) => p.quoteId))]
  for (let i = 0; i < ids.length; i += 80) {
    // v2: la caché v1 no traía la dotación (usuarios) — clave nueva.
    const keys = ids.slice(i, i + 80).map((id) => `"fee_mes_v2_${id}"`).join(",")
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys})&expires_at=gt.${new Date().toISOString()}&select=key,value`,
      { headers: hSb, cache: "no-store" },
    ).catch(() => null)
    const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) : []
    for (const row of rows) {
      try {
        cache.set(String(row.key).replace(/^fee_mes_v2_/, ""), JSON.parse(row.value) as { uf: number | null; clp: number | null; usuarios: number | null })
      } catch {}
    }
  }
  const faltantes = ids.filter((id) => !cache.has(id)).slice(0, 36)
  if (faltantes.length) {
    const token = await getZohoAccessToken().catch(() => "")
    if (token) {
      for (let i = 0; i < faltantes.length; i += 6) {
        await Promise.all(
          faltantes.slice(i, i + 6).map(async (id) => {
            try {
              const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${id}`, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                cache: "no-store",
              })
              const body = (await r.json().catch(() => null)) as {
                data?: Array<{
                  Descuento_Recurrente_Pct?: number
                  Detalle_Items_Cotizacion?: Array<{
                    Subtotal_UF?: number
                    Subtotal_CLP?: number
                    Es_Recurrente?: boolean
                    Codigo_Item?: string
                    Modalidad?: string
                    Cantidad?: number
                  }>
                }>
              } | null
              const rec = body?.data?.[0]
              if (!rec) return
              const pct = Number(rec.Descuento_Recurrente_Pct ?? 0) || 0
              const items = rec.Detalle_Items_Cotizacion || []
              const recurrentes = items.filter((it) => it.Es_Recurrente)
              const uf = recurrentes.reduce((a, it) => a + (Number(it.Subtotal_UF) || 0), 0)
              const clp = recurrentes.reduce((a, it) => a + (Number(it.Subtotal_CLP) || 0), 0)
              // Dotación cotizada: ítem de asistencia («Fijo» = plan 1-10).
              const asistencia = items.find((it) => String(it.Codigo_Item || "") === "asistencia")
              const usuarios = asistencia
                ? String(asistencia.Modalidad || "").toLowerCase() === "fijo"
                  ? 10
                  : Number(asistencia.Cantidad) || null
                : null
              const fee = {
                uf: uf ? Number((uf * (1 - pct / 100) * 1.19).toFixed(2)) : null,
                clp: clp ? Math.round(clp * (1 - pct / 100) * 1.19) : null,
                usuarios,
              }
              cache.set(id, fee)
              await kvSet(`fee_mes_v2_${id}`, JSON.stringify(fee), new Date(Date.now() + 48 * 3600e3).toISOString())
            } catch {}
          }),
        )
      }
    }
  }
  for (const p of pares) {
    const fee = cache.get(p.quoteId)
    if (fee && (fee.uf || fee.clp) && !out.has(p.contact)) out.set(p.contact, fee)
  }
  return out
}

function fmtSantiago(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDuracion(inicioIso: string, pagoIso: string): string {
  const a = new Date(inicioIso).getTime()
  const b = new Date(pagoIso).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return "—"
  const horasTotales = Math.floor((b - a) / 3600000)
  const dias = Math.floor(horasTotales / 24)
  const horas = horasTotales % 24
  if (dias === 0 && horas === 0) return `${Math.round((b - a) / 60000)} min`
  return dias === 0 ? `${horas}h` : `${dias}d ${horas}h`
}

function fmtDuracionMs(ms: number): string {
  if (!(ms > 0)) return "—"
  const horasTotales = Math.floor(ms / 3600000)
  const dias = Math.floor(horasTotales / 24)
  const horas = horasTotales % 24
  if (dias === 0 && horas === 0) return `${Math.round(ms / 60000)} min`
  return dias === 0 ? `${horas}h` : `${dias}d ${horas}h`
}

function renderVentasCerradas(ventas: VentaCerrada[], key: string, formularioSet: Set<string> = new Set(), telPorNumero: Map<string, string> = new Map()): string {
  if (!ventas.length) return ""
  // Canal de llegada por venta: el teléfono no viaja en la caché de la venta,
  // se cruza por número de cotización contra la lista viva de Zoho.
  const llegoPorDe = (numero: string): string => {
    const t = numero ? telPorNumero.get(numero) || "" : ""
    return t ? chipLlegoPor(formularioSet.has(t)) : "—"
  }
  // Tarjetas de tiempos (pedido Lalo 20-jul): promedio y mediana del tiempo
  // inicio de conversación → pago, sobre las ventas con ambas fechas válidas.
  const duraciones = ventas
    .map((v) => new Date(v.pagoIso).getTime() - new Date(v.inicioIso).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)
  let tarjetasTiempos = ""
  if (duraciones.length) {
    const promedio = duraciones.reduce((a, b) => a + b, 0) / duraciones.length
    const mitad = Math.floor(duraciones.length / 2)
    const mediana =
      duraciones.length % 2 ? duraciones[mitad] : (duraciones[mitad - 1] + duraciones[mitad]) / 2
    const masRapida = duraciones[0]
    const masLenta = duraciones[duraciones.length - 1]
    const card = (label: string, value: string, color: string, sub?: string) =>
      `<div class="kpi"><div class="kpi-v" style="color:${color}">${value}</div><div class="kpi-l">${label}${sub ? ` <span class="pct">${sub}</span>` : ""}</div></div>`
    tarjetasTiempos = `<div class="kpis" style="margin-bottom:12px">
      ${card("Tiempo promedio a cierre", fmtDuracionMs(promedio), "#00838F", "inicio conversación → pago")}
      ${card("Mediana", fmtDuracionMs(mediana), "#27ae60", "la mitad de las ventas cierra antes de esto")}
      ${card("Más rápida", fmtDuracionMs(masRapida), "#8e44ad")}
      ${card("Más lenta", fmtDuracionMs(masLenta), "#e67e22")}
    </div>`
  }
  const filas = ventas
    .map(
      (v) => `<tr>
        <td>${v.empresa}${v.numero ? ` <span class="sub" style="display:inline">· ${v.numero}</span>` : ""}${v.convId ? `<div style="margin-top:2px"><a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(v.convId)}" style="font-size:12px;font-weight:400">ver conversación →</a></div>` : ""}</td>
        <td style="white-space:nowrap">${llegoPorDe(v.numero)}</td>
        <td>${fmtSantiago(v.inicioIso)}${v.inicioAprox ? " *" : ""}</td>
        <td>${fmtSantiago(v.pagoIso)}</td>
        <td style="text-align:center">${v.usuarios || "—"}</td>
        <td style="text-align:center">${v.descuentoPct > 0 ? `${v.descuentoPct}%` : "—"}</td>
        <td style="text-align:right">${v.unicoClp > 0 ? `$${v.unicoClp.toLocaleString("es-CL")}` : "—"}</td>
        <td style="text-align:right">${v.recurrenteClp > 0 ? `$${v.recurrenteClp.toLocaleString("es-CL")}/mes` : "—"}</td>
        <td style="text-align:right"><b>${fmtDuracion(v.inicioIso, v.pagoIso)}</b></td>
      </tr>`,
    )
    .join("")
  const totalUnico = ventas.reduce((a, v) => a + (v.unicoClp || 0), 0)
  const totalRecurrente = ventas.reduce((a, v) => a + (v.recurrenteClp || 0), 0)
  return `<div class="card"><h2>Ventas cerradas <span class="pct" style="font-weight:400">— ${ventas.length} pagadas · $${totalUnico.toLocaleString("es-CL")} en pagos únicos · $${totalRecurrente.toLocaleString("es-CL")}/mes de recurrencia</span></h2>
  ${tarjetasTiempos}
  <div style="overflow-x:auto"><table class="tabla-ventas" style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;border-bottom:2px solid #e3e7ea">
      <th style="padding:6px 8px">Empresa</th><th style="padding:6px 8px" title="Cómo llegó el contacto: nos escribió directo por WhatsApp, o entró como lead cargado (formulario web / base) a la cadencia outbound">Llegó por</th><th style="padding:6px 8px">Inicio conversación</th><th style="padding:6px 8px">Pago</th><th style="padding:6px 8px;text-align:center">Usuarios</th><th style="padding:6px 8px;text-align:center">Dcto.</th><th style="padding:6px 8px;text-align:right">Pago único</th><th style="padding:6px 8px;text-align:right">Recurrencia</th><th style="padding:6px 8px;text-align:right">Inicio → pago</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">Pago único = compra/envío/instalación del reloj (con IVA), se paga una sola vez. Recurrencia = fee mensual de módulos y arriendos (con descuento e IVA); el pago inicial del cliente suma ambos. Calculado desde los ítems registrados en Zoho. Fechas en hora de Chile. * = sin conversación registrada: se usa la fecha de emisión de la cotización como inicio.</div>
</div>`
}

// ── Filtro Desde–Hasta (pedido Lalo 27-jul) ─────────────────────────────────
// El rango se interpreta en hora de CHILE (UTC-4): desde las 00:00 del "desde"
// hasta las 23:59:59 del "hasta". Aplica sobre la fecha de INICIO de la
// conversación (Sankey y KPIs) y la fecha de CREACIÓN de la cotización (cierre
// y ventas cerradas). La sección "Funnel por origen" queda fuera del filtro a
// propósito: sus conjuntos (toque 0, asignados) son acumulados del programa y
// partirlos por fecha con precisión requiere datos que ese fetch no trae.
type RangoFechas = { desdeMs: number; hastaMs: number; desdeStr: string; hastaStr: string; etiqueta: string }

function parseRango(searchParams: URLSearchParams): RangoFechas | null {
  const fecha = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "")
  const desde = fecha(searchParams.get("desde"))
  const hasta = fecha(searchParams.get("hasta"))
  if (!desde && !hasta) return null
  const desdeMs = desde ? Date.parse(`${desde}T00:00:00-04:00`) : 0
  const hastaMs = hasta ? Date.parse(`${hasta}T23:59:59.999-04:00`) : Number.MAX_SAFE_INTEGER
  if (Number.isNaN(desdeMs) || Number.isNaN(hastaMs) || desdeMs > hastaMs) return null
  const etiqueta = desde && hasta ? `${desde} → ${hasta}` : desde ? `desde ${desde}` : `hasta ${hasta}`
  return { desdeMs, hastaMs, desdeStr: desde, hastaStr: hasta, etiqueta }
}

const enRango = (iso: string | null | undefined, r: RangoFechas): boolean => {
  const t = Date.parse(String(iso || ""))
  return Number.isFinite(t) && t >= r.desdeMs && t <= r.hastaMs
}

/** id de conversación → started_at, para filtrar el análisis por fecha. */
async function fetchFechasConversaciones(): Promise<Map<string, string>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,started_at&limit=10000`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  const out = new Map<string, string>()
  if (!res.ok) return out
  const rows = (await res.json().catch(() => [])) as Array<{ id?: string; started_at?: string }>
  for (const r of rows) if (r.id) out.set(r.id, r.started_at || "")
  return out
}

/** Deja en el cierre SOLO las cotizaciones de contactos que conversaron con
 * Vicky (Lalo 14-ago). Recalcula los contadores para que los KPIs cuadren con
 * las listas que se muestran al hacer clic. */
function filtrarCierreAVicky<T extends {
  total: number
  aceptadas: number
  autonomas: number
  asistidas: number
  sinClasificar: number
  aceptadasList: RawAceptada[]
  todasList: RawAceptada[]
  quotesList: RawAceptada[]
}>(cierre: T, convs: ConvListado[]): T {
  const conChat = new Set(convs.map((c) => digits(c.contact)).filter(Boolean))
  const deVicky = (q: RawAceptada) => {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    return Boolean(tel && conChat.has(tel))
  }
  const aceptadasList = cierre.aceptadasList.filter(deVicky)
  const quotesList = cierre.quotesList.filter(deVicky)
  const marca = (q: RawAceptada) => String(q.Intervenci_n_Humana || "").toLowerCase()
  const autonomas = aceptadasList.filter((q) => marca(q).includes("100%")).length
  const asistidas = aceptadasList.filter((q) => marca(q).includes("intervenci")).length
  return {
    ...cierre,
    total: quotesList.length,
    aceptadas: aceptadasList.length,
    autonomas,
    asistidas,
    sinClasificar: aceptadasList.length - autonomas - asistidas,
    aceptadasList,
    quotesList,
    todasList: cierre.todasList.filter(deVicky),
  }
}

async function fetchCierreZoho(paisPorQuote: Map<string, Pais>, pais: Pais, rango: RangoFechas | null): Promise<{
  total: number
  aceptadas: number
  // Desglose del campo "Intervención Humana" sobre las ACEPTADAS: cierres
  // 100% conducidos por Vicky vs los que necesitaron un humano (lo marca el
  // equipo comercial en Zoho, cotización por cotización).
  autonomas: number
  asistidas: number
  sinClasificar: number
  aceptadasList: RawAceptada[]
  todasList: RawAceptada[]
  /** Emitidas del rango (base del KPI "Cotizaciones en Zoho") — se expone la
   * lista para poder re-filtrar por Estado/Propietario globales. */
  quotesList: RawAceptada[]
} | null> {
  try {
    let token = await getZohoAccessToken()
    // PAGINADO y ORDENADO (bug cazado 10-ago, pago de Fernando/Empresa
    // Natural "no aparece en el dash"): el `limit 200` original, SIN order
    // by, dejaba que Zoho devolviera las 200 filas MÁS VIEJAS de un universo
    // que ya pasa de 400 — el dash quedó ciego a todo lo emitido después de
    // ~COT426 y el hoyo crecía con cada emisión. Ahora: Created_Time desc
    // (lo nuevo primero) y páginas de 200 hasta agotar (tope 3000 — si algún
    // día se supera, lo que se trunca es la prehistoria, no el presente).
    const filas: RawAceptada[] = []
    let refrescado = false
    // v8: la query junta TRES lookups (Cuenta_Asociada, Owner, Deal_Asociado)
    // y COQL v3 topa en 2 relaciones (LIMIT_EXCEEDED by:relation — Zoho lo
    // empezó a aplicar ~17-ago; hasta entonces v3 lo dejaba pasar).
    const pedirPagina = (offset: number) =>
      fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query: `select id, Name, Numero_Cotizacion, Estado_Cotizacion, Intervenci_n_Humana, Fecha_Hora_Cotizacion, Tel_fono_Contacto, Email_Contacto, Created_Time, Modified_Time, Descuento_Recurrente_Pct, Cuenta_Asociada.Account_Name, Onboarding_Link, Owner.first_name, Owner.last_name, Deal_Asociado.Stage, Deal_Asociado.id from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} order by Created_Time desc limit ${offset}, 200`,
        }),
        cache: "no-store",
      })
    // Página 0 SERIAL: maneja el 401 con refresco una sola vez (incidente
    // 17-ago: token revocado antes de su vencimiento — el dash quedó una hora
    // sin aceptadas/pagadas; el refresco repara el kv para todos los
    // consumidores de Zoho).
    {
      let res = await pedirPagina(0)
      if (res.status === 401 && !refrescado) {
        refrescado = true
        token = await getZohoAccessTokenFresco().catch(() => token)
        res = await pedirPagina(0)
      }
      if (!res.ok) return null
      const pagina = (await res.json().catch(() => null)) as {
        data?: RawAceptada[]
        info?: { more_records?: boolean }
      } | null
      filas.push(...(pagina?.data || []))
      // Páginas siguientes en OLEADAS PARALELAS de 5 (19-ago, "el dash carga
      // lento"): el listado eran 4-6 viajes COQL uno tras otro — el mayor
      // costo fijo de la carga. Con el token ya validado por la página 0, el
      // paralelo es seguro.
      if (pagina?.info?.more_records) {
        let masPaginas = true
        for (let base = 200; base < 3000 && masPaginas; base += 1000) {
          const offsets: number[] = []
          for (let o = base; o < Math.min(base + 1000, 3000); o += 200) offsets.push(o)
          const resultados = await Promise.all(
            offsets.map(async (offset) => {
              const r = await pedirPagina(offset).catch(() => null)
              if (!r || !r.ok) return { ok: false as const, data: [] as RawAceptada[], more: false }
              const p = (await r.json().catch(() => null)) as {
                data?: RawAceptada[]
                info?: { more_records?: boolean }
              } | null
              return { ok: true as const, data: p?.data || [], more: Boolean(p?.info?.more_records) }
            }),
          )
          for (const rp of resultados) {
            if (!rp.ok) {
              masPaginas = false
              break // páginas posteriores fallan → se sirve lo acumulado
            }
            filas.push(...rp.data)
            if (!rp.more) {
              masPaginas = false
              break
            }
          }
        }
      }
    }
    const universo = filas.filter((q) => {
      // País de la cotización: el de su conversación de origen; si no está
      // ligada, por prefijo del teléfono (histórico: Chile por defecto).
      const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
      const paisQuote: Pais = paisPorQuote.get(String(q.id || "")) || paisDeTelefono(tel) || "cl"
      if (paisQuote !== pais) return false
      // Cotizaciones INTERNAS fuera de los KPIs y de "Aceptadas / pagadas"
      // (Rodrigo 10-ago): el filtro de abajo solo cazaba nombres con
      // "prueba", así que COT420/COT281 —emitidas a los teléfonos de Rodrigo
      // y Lalo, a nombre de "GeoVictoria SPA"— se contaban como ventas.
      if (tel && isTestContact(tel)) return false
      // Pruebas del EDITOR sin teléfono (Lalo 13-ago, "toooodo fuera del
      // dash"): el correo de contacto interno saca la cotización de TODO el
      // universo — KPIs, Evolución, listas y ventas heredan de acá.
      if (esEmailInterno(String(q.Email_Contacto || ""))) return false
      const nombre = String(q.Name || "").toLowerCase()
      if (nombre.includes("prueba") || nombre.includes("huellerocompany")) return false
      // Nadie le vende a GeoVictoria: una cotización a nombre de la propia
      // empresa es interna (cinturón por si el teléfono no está en la lista).
      if (/\bgeo\s*victoria\b/.test(nombre)) return false
      return true
    })
    // Filtro Desde–Hasta con DOS relojes (pedido Lalo 31-jul): las emitidas
    // filtran por fecha de EMISIÓN (Created_Time); las aceptadas/pagadas por
    // fecha de PAGO (Fecha_Hora_Cotizacion, con Modified_Time de respaldo —
    // la misma fecha que muestra la columna "Pago" de la tabla de ventas).
    // Una cotización emitida un día anterior pero pagada dentro del rango
    // CUENTA como pago del rango (caso Ayres/Cofradía del 31-jul).
    const quotes = universo.filter((q) => !rango || enRango(q.Created_Time, rango))
    const aceptadasList = universo
      .filter((q) => esAceptadaOMas(q))
      .filter((q) => !rango || enRango(q.Fecha_Hora_Cotizacion || q.Modified_Time, rango))
    const marca = (q: { Intervenci_n_Humana?: string | null }) => String(q.Intervenci_n_Humana || "").toLowerCase()
    const autonomas = aceptadasList.filter((q) => marca(q).includes("100%")).length
    const asistidas = aceptadasList.filter((q) => marca(q).includes("intervenci")).length
    return {
      total: quotes.length,
      aceptadas: aceptadasList.length,
      autonomas,
      asistidas,
      sinClasificar: aceptadasList.length - autonomas - asistidas,
      aceptadasList,
      // Universo completo SIN filtro de fechas: lo consume el Listado
      // comercial (esa sección filtra en el navegador).
      todasList: universo,
      quotesList: quotes,
    }
  } catch {
    return null
  }
}

// País de cada conversación/contacto/cotización, para partir el dashboard por
// línea de Vicky (CL/CO/PE/MX). El país viene de vic_v3_conversations.country;
// si falta, se resuelve por prefijo telefónico (y Chile como último recurso,
// que es el comportamiento histórico del dash).
async function fetchPaisesConversaciones(): Promise<{
  paisPorConv: Map<string, Pais>
  paisPorContacto: Map<string, Pais>
  paisPorQuote: Map<string, Pais>
}> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact,country,formal_quote_id&limit=10000`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  const rows = res.ok
    ? ((await res.json()) as Array<{ id: string; contact: string; country: string | null; formal_quote_id: string | null }>)
    : []
  const paisPorConv = new Map<string, Pais>()
  const paisPorContacto = new Map<string, Pais>()
  const paisPorQuote = new Map<string, Pais>()
  for (const r of rows) {
    const declarado = String(r.country || "").toLowerCase()
    const p: Pais = (declarado in PAISES ? declarado : paisDeTelefono(digits(r.contact)) || "cl") as Pais
    paisPorConv.set(r.id, p)
    paisPorContacto.set(digits(r.contact), p)
    if (r.formal_quote_id) paisPorQuote.set(r.formal_quote_id, p)
  }
  return { paisPorConv, paisPorContacto, paisPorQuote }
}

// Mejoras aplicadas al agente (changelog curado, editable a mano — pídeme
// actualizarlo). Cada entrada lleva fecha para que no se lea como hallazgo
// vigente cuando ya fue resuelto.
const CURATED_FINDINGS: Array<{ fecha: string; titulo: string; detalle: string }> = [
  {
    fecha: "jul-2026",
    titulo: "Menos es más + micro-cierre en la captura de datos",
    detalle:
      "La mayor fuga era precio → datos (5 datos de golpe con RUT incluido). Ahora Vicky capta nombre/empresa temprano, valida el precio con un micro-cierre ('¿te hace sentido avanzar?') y al cierre pide solo RUT + email; ante objeción, negocia descuento en vez de perder al cliente. En medición (corte 02-jul).",
  },
  {
    fecha: "jun-2026",
    titulo: "Objeción al precio de compra del reloj se atacaba mal",
    detalle:
      "Cuando el cliente objetaba el reloj en venta, se descontaba el plan mensual (irrelevante al pago inicial). Resuelto: ahora Vicky pivotea a arriendo ante esa objeción.",
  },
  {
    fecha: "jun-2026",
    titulo: "Vicky ofrecía la compra del reloj sin que se la pidieran",
    detalle:
      "Ante '¿cuánto vale el reloj?' daba el precio de compra (8 UF). Resuelto: ahora responde solo arriendo salvo que el cliente pida comprar.",
  },
  {
    fecha: "jun-2026",
    titulo: "Dimensionamiento de relojes",
    detalle:
      "Se aceptaba 1 reloj para muchas personas con turnos (riesgo de fila). Resuelto: ahora pregunta por simultaneidad y sugiere 2.",
  },
  {
    fecha: "jun-2026",
    titulo: "Micro-plan para 1 trabajador",
    detalle:
      "Se agregó tarifa especial 0,25 UF (1 que marca + admin), sin descuento recurrente, para no perder micro-clientes.",
  },
]

type Row = {
  conversation_id: string
  contact: string
  bolsa: string | null
  bolsa_sub: string | null
  grupo: string
  sub_bucket: string | null
  cotizacion_outcome: string | null
  motivo_no_cierre: string | null
  es_cliente_actual: boolean
  resumen: string | null
  accionable: string | null
  hallazgos: Array<{ tipo: string; detalle: string }> | null
  analyzed_at: string | null
}

async function fetchAnalysis(): Promise<Row[]> {
  // PAGINADO (bug 19-ago, "tanto sin intención?"): PostgREST corta en 1000
  // filas y la tabla ya pasó las 1274 — el dash clasificaba con el análisis
  // TRUNCADO (274 conversaciones invisibles: soporte subcontado, intención
  // subcontada). Se pagina hasta agotar.
  const filas: Row[] = []
  for (let offset = 0; offset < 20000; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversation_analysis?select=conversation_id,contact,bolsa,bolsa_sub,grupo,sub_bucket,cotizacion_outcome,motivo_no_cierre,es_cliente_actual,resumen,accionable,hallazgos,analyzed_at&order=analyzed_at.asc&limit=1000&offset=${offset}`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cache: "no-store",
      },
    )
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const lote = (await res.json()) as Row[]
    filas.push(...lote)
    if (lote.length < 1000) break
  }
  return filas
}

const digits = (c: string) => (c || "").replace(/\D/g, "")

// ── Branding GeoVictoria (skill geovictoria-design, 04-ago) ─────────────────
// BR Sonoma para títulos, Nunito para UI; paleta oficial: #ffbb00 (CTA),
// #00aff2 (links/data), #646464 (SOLO tipografía), blanco de fondo. Assets
// servidos desde /public/gv/.
const GV_FONT_CSS = `
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-SemiBold.otf") format("opentype");font-weight:600;font-display:swap}
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-Bold.otf") format("opentype");font-weight:700;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Regular.ttf") format("truetype");font-weight:400;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-SemiBold.ttf") format("truetype");font-weight:600;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Bold.ttf") format("truetype");font-weight:700;font-display:swap}`
const GV_BODY_FONT = `"Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`
const GV_TITLE_FONT = `"BR Sonoma","Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`

// ── Países soportados por el dashboard (pedido Lalo 04-ago: sumar PE y MX) ──
type Pais = "cl" | "co" | "pe" | "mx"
const PAISES: Record<Pais, { nombre: string; label: string; bandera: string; prefijo: string }> = {
  cl: { nombre: "CHILE", label: "Chile", bandera: "🇨🇱", prefijo: "56" },
  co: { nombre: "COLOMBIA", label: "Colombia", bandera: "🇨🇴", prefijo: "57" },
  pe: { nombre: "PERÚ", label: "Perú", bandera: "🇵🇪", prefijo: "51" },
  mx: { nombre: "MÉXICO", label: "México", bandera: "🇲🇽", prefijo: "52" },
}
/** País por prefijo telefónico ("" si no calza con ninguno soportado). */
const paisDeTelefono = (tel: string): Pais | "" => {
  if (tel.startsWith("56")) return "cl"
  if (tel.startsWith("57")) return "co"
  if (tel.startsWith("521") || (tel.startsWith("52") && tel.length === 12)) return "mx"
  if (tel.startsWith("51")) return "pe"
  return ""
}

// ── Funnel por ORIGEN (pedido Lalo 21-jul): outbound (leads asignados) vs
// inbound (el cliente llegó solo). Señales:
//   - vic_outbound_cadence: un registro por toque 0 enviado → contacto OUTBOUND.
//   - Leads Zoho "1. No contactado" de Vicky: asignados aún sin toque.
//   - vic_v3_conversations.last_user_at: el contacto RESPONDIÓ alguna vez.
async function fetchOrigenFunnel(pais: Pais): Promise<{
  toque0: Set<string>
  sinContactar: number
  asignadosTotal: number
  convertidos: Set<string>
  respondio: Set<string>
  /** Teléfonos detrás de los contadores, para poder intersectarlos con los
   * filtros globales de Estado/Propietario (los números de arriba se mantienen
   * como fuente de verdad cuando no hay filtro). */
  asignados: Set<string>
  sinContactarTels: Set<string>
}> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  // Universo CERRADO por prefijo (22-jul): cada país cuenta SOLO su prefijo
  // (+56 CL, +57 CO, +51 PE, +52 MX).
  const delPais = (c: string) => paisDeTelefono(c) === pais
  // Inicio del programa outbound actual (primer lead asignado a Vicky):
  // excluye los leads de la era telemarketing 2025 que también son de Vicky.
  const PROGRAMA_DESDE = "2026-07-16T00:00:00-04:00"
  const [cadRes, convRes, leadsRes, convertedRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/vic_outbound_cadence?select=contact`, { headers: h, cache: "no-store" }),
    fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=contact,last_user_at`, { headers: h, cache: "no-store" }),
    (async () => {
      try {
        const token = await getZohoAccessToken()
        // TODOS los leads vivos de Vicky (cualquier estado): el conteo por
        // estado '1. No contactado' subcontaba los asignados (fix 22-jul).
        return await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            select_query: `select id, Phone from Leads where Owner.id = ${VICKY_CREATOR_ID} and Created_Time > '${PROGRAMA_DESDE}' limit 200`,
          }),
          cache: "no-store",
        })
      } catch {
        return null
      }
    })(),
    (async () => {
      try {
        // Leads CONVERTIDOS a deal (les mandamos cotización): desaparecen de
        // las consultas normales de Leads pero SON leads asignados (fix
        // 22-jul, pedido Lalo: "considera también los convertidos").
        const token = await getZohoAccessToken()
        const criteria = encodeURIComponent(`(Owner.id:equals:${VICKY_CREATOR_ID})`)
        return await fetch(
          `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${criteria}&converted=true&fields=id,Phone,Created_Time&per_page=200`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
        )
      } catch {
        return null
      }
    })(),
  ])
  const cad = cadRes.ok ? ((await cadRes.json()) as Array<{ contact: string }>) : []
  const convs = convRes.ok
    ? ((await convRes.json()) as Array<{ contact: string; last_user_at: string | null }>)
    : []
  const toque0 = new Set(cad.map((c) => digits(c.contact)).filter((c) => c && delPais(c) && !isTestContact(c)))
  // Unión por teléfono: cadencia + leads vivos + convertidos (sin duplicar).
  const asignados = new Set<string>(toque0)
  const sinContactarTels = new Set<string>()
  let sinContactar = 0
  if (leadsRes && leadsRes.ok) {
    const data = (await leadsRes.json().catch(() => ({}))) as {
      data?: Array<{ Phone?: string | null }>
    }
    for (const l of data?.data || []) {
      const tel = digits(String(l.Phone || ""))
      if (tel && delPais(tel) && !isTestContact(tel)) asignados.add(tel)
      if (tel && delPais(tel)) sinContactarTels.add(tel)
    }
    sinContactar = (data?.data || []).filter((l) => delPais(digits(String(l.Phone || "")))).length
  }
  // Set aparte de CONVERTIDOS (hecho duro de Zoho: el lead pasó a deal porque
  // se le envió cotización) — etapa propia del funnel desde el 22-jul.
  const convertidos = new Set<string>()
  if (convertedRes && convertedRes.ok) {
    const data = (await convertedRes.json().catch(() => ({}))) as {
      data?: Array<{ Phone?: string | null; Created_Time?: string }>
    }
    for (const l of data?.data || []) {
      if (String(l.Created_Time || "") < "2026-07-16") continue
      const tel = digits(String(l.Phone || ""))
      if (tel && delPais(tel) && !isTestContact(tel)) {
        asignados.add(tel)
        convertidos.add(tel)
      }
    }
  }
  return {
    toque0,
    sinContactar,
    asignadosTotal: asignados.size,
    convertidos,
    respondio: new Set(convs.filter((c) => c.last_user_at).map((c) => digits(c.contact))),
    asignados,
    sinContactarTels,
  }
}

// Señales DETERMINISTAS (hechos en la base, no inferencia del LLM): contactos
// con cotización formal enviada (quote_pointers / formal_quote_id) y contactos
// con reunión agendada (vic_v3_meetings). Se imponen sobre la clasificación.
async function fetchHardSignals(): Promise<{ quote: Set<string>; meeting: Set<string> }> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const get = async (path: string): Promise<{ contact: string }[]> => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
    return r.ok ? ((await r.json()) as { contact: string }[]) : []
  }
  const [qp, fq, mt] = await Promise.all([
    get("vic_v3_quote_pointers?select=contact"),
    get("vic_v3_conversations?select=contact&formal_quote_id=not.is.null"),
    get("vic_v3_meetings?select=contact"),
  ])
  return {
    quote: new Set([...qp, ...fq].map((x) => digits(x.contact))),
    meeting: new Set(mt.map((x) => digits(x.contact))),
  }
}

// ── LISTADO COMERCIAL VIVO (pedido Lalo 03-ago) ─────────────────────────────
// Una fila por caso comercial con su estado más avanzado, la fecha/hora de ESE
// estado, el estado del registro en Zoho y el propietario. Filtros de fecha,
// estado y propietario en el navegador (la sección trae los últimos 30 días).
// Escalera de estados (cada uno pisa al anterior):
//   Sin contactar → Contactado → En levantamiento → Preform enviado →
//   Formal enviada → Aceptada → Pagada

type FilaListado = {
  empresa: string
  contacto: string
  estado: string
  fechaIso: string
  estadoZoho: string
  propietario: string
  /** TODOS los dueños asociados (deal + cotización + lead): el filtro por
   * identidad matchea cualquiera — que el deal sea de A y la cotización de B
   * no le esconde la oportunidad a ninguno de los dos (borde Lalo 07-ago). */
  propietarios?: string[]
  /** Origen de la fila: "vicky" (huella en el canal: conversación/lead/preform/
   * cotización de Vicky) o "zoho" (deal del equipo sin huella en Vicky). */
  origen?: "vicky" | "zoho"
  /** Inicio de la conversación (o creación del lead si nunca conversó). */
  primerContactoIso: string
  /** id de la conversación para el link al chat (vista ?conv= del embudo). */
  convId: string
  /** Próxima acción para el ejecutivo: la del análisis LLM, o un respaldo
   * determinístico por estado si la conversación aún no fue analizada. */
  accionable: string
  /** Resumen del análisis, como tooltip del accionable. */
  resumen: string
  /** Última respuesta del cliente y último mensaje de la conversación — junto
   * con fechaIso y primerContactoIso definen la "actividad" del caso para el
   * filtro global Desde–Hasta. */
  lastUserIso: string
  updatedIso: string
  /** Último contacto real con el cliente: lo más reciente entre el chat de
   * WhatsApp y la actividad registrada en Zoho (lead/deal/cotización). */
  ultimoContactoIso: string
  /** Link directo al registro en Zoho: deal → lead → cotización. */
  zohoUrl: string
}

/** "hace 23 min" / "hace 3 h 12 min" / "hace 2 d 5 h" desde una fecha ISO. */
function haceTexto(iso: string): string {
  const t = Date.parse(iso || "")
  if (!Number.isFinite(t)) return "—"
  const min = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h ${min % 60} min`
  const d = Math.floor(h / 24)
  return `hace ${d} d ${h % 24} h`
}

/** Horas desde el último contacto real de la fila (chat o Zoho). */
function horasDesdeFila(f: FilaListado): number {
  const t = Date.parse(f.ultimoContactoIso || f.updatedIso || f.fechaIso || "")
  return Number.isFinite(t) ? (Date.now() - t) / 3600e3 : 9999
}

/** Días hábiles COMPLETOS (L-V) transcurridos desde el último contacto. */
function diasHabilesDesdeFila(f: FilaListado): number {
  const t = Date.parse(f.ultimoContactoIso || f.updatedIso || f.fechaIso || "")
  if (!Number.isFinite(t)) return 99
  const cur = new Date(t)
  cur.setHours(0, 0, 0, 0)
  cur.setDate(cur.getDate() + 1)
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  let n = 0
  while (cur <= hoy) {
    const dw = cur.getDay()
    if (dw !== 0 && dw !== 6) n++
    cur.setDate(cur.getDate() + 1)
  }
  return n
}

/** Máximo de fechas ISO comparando por instante real (los formatos mezclan
 * offsets de Supabase y Zoho — la comparación lexicográfica miente). */
function maxIso(...vals: Array<string | null | undefined>): string {
  let best = ""
  let bestT = -Infinity
  for (const v of vals) {
    const s = String(v || "")
    const t = Date.parse(s)
    if (Number.isFinite(t) && t > bestT) {
      bestT = t
      best = s
    }
  }
  return best
}

// El org es el mismo que usan los correos del PTV y el dashboard viejo.
const ZOHO_CRM_URL = "https://crm.zoho.com/crm/org685875245"
function zohoUrlDe(dealId?: string | null, leadId?: string | null, quoteId?: string | null): string {
  if (dealId) return `${ZOHO_CRM_URL}/tab/Potentials/${dealId}`
  if (leadId) return `${ZOHO_CRM_URL}/tab/Leads/${leadId}`
  if (quoteId) return `${ZOHO_CRM_URL}/tab/${QUOTE_MODULE}/${quoteId}`
  return ""
}

/** Respaldo determinístico del accionable cuando el análisis aún no corre. */
function accionableFallback(estado: string, motivo: string | null): string {
  switch (estado) {
    case "Pagada":
      return "Venta cerrada: llamar para dar la bienvenida y acompañar el onboarding."
    case "Aceptada":
      return "Aceptó la cotización: contactar para ayudarle a completar el pago."
    case "Formal enviada":
      return "Cotización en su correo: llamar para resolver dudas y empujar el cierre."
    case "Preform enviado":
      return `Vio el precio y no pidió la formal${motivo ? ` (motivo: ${motivo.replace(/_/g, " ")})` : ""}: llamar para destrabar.`
    case "En levantamiento":
      return "Conversación activa con Vicky: intervenir solo si se estanca."
    case "Contactado":
      return "Respondió sin entrar a cotizar: retomar el interés con una llamada."
    default:
      return "No respondió el toque inicial: intentar una llamada directa."
  }
}

type ConvListado = { id: string; contact: string; started_at: string | null; last_user_at: string | null; updated_at: string | null }

async function fetchConvsListado(): Promise<ConvListado[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact,started_at,last_user_at,updated_at&order=started_at.desc&limit=2000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  return res.ok ? ((await res.json().catch(() => [])) as ConvListado[]) : []
}

/** Último mensaje de PRECIO por contacto (el preform del chat), con timestamp
 * real desde vic_v3_messages — misma señal que usa el conteo de preforms.
 * Además parsea la DOTACIÓN cotizada del texto («Asistencia: 40 × 0,055 UF»;
 * plan de tarifa fija sin multiplicador = tramo 1-10). */
async function fetchPreformAts(convs: ConvListado[]): Promise<{ at: Map<string, string>; usuarios: Map<string, number> }> {
  const at = new Map<string, string>()
  const usuarios = new Map<string, number>()
  const porConvId = new Map(convs.map((c) => [c.id, c.contact]))
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.assistant&or=(content.ilike.*Resumen%20mensual*,content.ilike.*Total%20mensual%20con%20IVA*)&select=conversation_id,at,content&order=at.desc&limit=1000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  if (!res.ok) return { at, usuarios }
  const rows = (await res.json().catch(() => [])) as Array<{ conversation_id: string; at: string; content?: string }>
  for (const r of rows) {
    const contact = porConvId.get(r.conversation_id)
    if (!contact) continue
    const tel = digits(contact)
    // order=at.desc: la primera aparición por contacto es su último preform.
    if (at.has(tel)) continue
    at.set(tel, r.at)
    const c = String(r.content || "")
    const m = c.match(/Asistencia:?\s*(\d{1,4})\s*[×x]/i)
    if (m) usuarios.set(tel, parseInt(m[1], 10))
    else if (/Asistencia:\s*[\d.,]+\s*UF/i.test(c)) usuarios.set(tel, 10)
  }
  return { at, usuarios }
}

/** Tramos de dotación para los paneles de gestión (pedido Lalo 05-ago). */
const SEGMENTOS_DOTACION = ["1-10", "11-20", "21-50", ">50", "s/d"] as const
function segmentoDotacion(u: number | null | undefined): (typeof SEGMENTOS_DOTACION)[number] {
  if (!u || u <= 0) return "s/d"
  if (u <= 10) return "1-10"
  if (u <= 20) return "11-20"
  if (u <= 50) return "21-50"
  return ">50"
}

type LeadListado = {
  id?: string
  Full_Name?: string
  Company?: string | null
  Phone?: string | null
  Lead_Status?: string | null
  Created_Time?: string
  Last_Activity_Time?: string | null
  "Owner.first_name"?: string | null
  "Owner.last_name"?: string | null
  N_Empleados_que_marcan?: number | null
  /** Shape del search API (los convertidos vienen por search, no por COQL). */
  Owner?: { name?: string } | null
  Converted_Deal?: { id?: string } | null
}

function propietarioDeLead(l: LeadListado): string {
  return (
    `${l["Owner.first_name"] || ""} ${l["Owner.last_name"] || ""}`.trim() ||
    String(l.Owner?.name || "").trim() ||
    "—"
  )
}

/** Leads del flujo de Vicky (vivos + convertidos) de los últimos 30 días, y
 * los deals creados por Vicky (para etapa/dueño de los preform sin quote).
 * extraDealIds: deals asociados a cotizaciones (Deal_Asociado) para conocer
 * su dueño VIGENTE — apenas se asigna el trato a un ejecutivo, el dashboard
 * lo muestra (pedido Lalo 06-ago). */
async function fetchZohoListado(contactosConocidos: Set<string>, extraDealIds: string[] = []): Promise<{
  leads: LeadListado[]
  dealsPorId: Map<string, { stage: string; owner: string; lastActivity: string }>
}> {
  const leads: LeadListado[] = []
  const dealsPorId = new Map<string, { stage: string; owner: string; lastActivity: string }>()
  try {
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    // split("T")[0] y no slice: el guard de funnel-filtro-fechas prohíbe el
    // patrón del bug de inputs; acá es un literal para COQL, no un value de UI.
    const desde = new Date(Date.now() - 30 * 24 * 3600e3).toISOString().split("T")[0]
    const [vivosRes, convertidosRes, dealsRes] = await Promise.all([
      fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Full_Name, Company, Phone, Lead_Status, Created_Time, Last_Activity_Time, N_Empleados_que_marcan, Owner.first_name, Owner.last_name from Leads where Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00' limit 200`,
        }),
      }),
      // Convertidos: la búsqueda por criterio trae TODOS los de la org; se
      // filtran después por los contactos que conocemos de las conversaciones.
      fetch(
        `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${encodeURIComponent(`(Created_Time:greater_equal:${desde}T00:00:00-04:00)`)}&converted=true&fields=id,Full_Name,Company,Phone,Lead_Status,Created_Time,Last_Activity_Time,N_Empleados_que_marcan,Converted_Deal,Owner&per_page=200`,
        { headers: H, cache: "no-store" },
      ),
      fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Stage, Last_Activity_Time, Owner.first_name, Owner.last_name from Deals where Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00' limit 200`,
        }),
      }),
    ])
    if (vivosRes.ok && vivosRes.status !== 204) {
      const d = (await vivosRes.json().catch(() => ({}))) as { data?: LeadListado[] }
      leads.push(...(d?.data || []))
    }
    if (convertidosRes.ok && convertidosRes.status !== 204) {
      const d = (await convertidosRes.json().catch(() => ({}))) as { data?: LeadListado[] }
      for (const l of d?.data || []) {
        if (contactosConocidos.has(digits(String(l.Phone || "")))) leads.push(l)
      }
    }
    if (dealsRes.ok && dealsRes.status !== 204) {
      const d = (await dealsRes.json().catch(() => ({}))) as {
        data?: Array<{ id: string; Stage?: string; Last_Activity_Time?: string; "Owner.first_name"?: string; "Owner.last_name"?: string }>
      }
      for (const dl of d?.data || []) {
        dealsPorId.set(String(dl.id), {
          stage: String(dl.Stage || ""),
          owner: `${dl["Owner.first_name"] || ""} ${dl["Owner.last_name"] || ""}`.trim(),
          lastActivity: String(dl.Last_Activity_Time || ""),
        })
      }
    }
    // Deals de leads convertidos que NO creó Vicky (caso Chanares 03-ago: la
    // SDR convirtió el lead a mano y el deal quedó fuera del COQL por
    // Created_By) — se completan por id para que el listado muestre SIEMPRE
    // la etapa y el dueño del deal cuando el lead ya es deal.
    const faltantes = [
      ...new Set(
        [...leads.map((l) => String(l.Converted_Deal?.id || "")), ...extraDealIds]
          .filter((id) => id && !dealsPorId.has(id)),
      ),
    ].slice(0, 50)
    if (faltantes.length) {
      const rExtra = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${await getZohoAccessToken()}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Stage, Last_Activity_Time, Owner.first_name, Owner.last_name from Deals where id in (${faltantes.join(",")}) limit ${faltantes.length}`,
        }),
      })
      if (rExtra.ok && rExtra.status !== 204) {
        const d = (await rExtra.json().catch(() => ({}))) as {
          data?: Array<{ id: string; Stage?: string; Last_Activity_Time?: string; "Owner.first_name"?: string; "Owner.last_name"?: string }>
        }
        for (const dl of d?.data || []) {
          dealsPorId.set(String(dl.id), {
            stage: String(dl.Stage || ""),
            owner: `${dl["Owner.first_name"] || ""} ${dl["Owner.last_name"] || ""}`.trim(),
            lastActivity: String(dl.Last_Activity_Time || ""),
          })
        }
      }
    }
  } catch (e) {
    console.warn("[vic-funnel] listado Zoho falló:", e instanceof Error ? e.message : e)
  }
  return { leads, dealsPorId }
}

type DealEquipo = {
  id: string
  Deal_Name?: string
  Stage?: string
  Created_Time?: string
  Last_Activity_Time?: string
  "Owner.first_name"?: string
  "Owner.last_name"?: string
  "Contact_Name.Phone"?: string
  "Contact_Name.Mobile"?: string
  "Contact_Name.Email"?: string
  "Account_Name.Account_Name"?: string
  N_Empleados_que_marcan?: number
}

/** TODOS los deals ACTIVOS del pipeline en Zoho — la cartera completa que
 * manejan los vendedores, haya pasado o no por Vicky (pedido Lalo 07-ago).
 * Activo = etapa no terminal (fuera Cierre Perdido/Congelado/Facturando) con
 * actividad o creación en los últimos 60 días. */
// Roster de TELEMARKETING para el selector de cotizaciones (Lalo 11-ago):
// las ejecutivas/os del canal + Vicky (interina de los deals que esperan).
// Override sin deploy: env VICKY_COTIZADORA_ROSTER_EMAILS (coma-separado).
const ROSTER_TELEMARKETING_EMAILS = (
  process.env.VICKY_COTIZADORA_ROSTER_EMAILS ||
  "emujica@geovictoria.com,pdiaz@geovictoria.com,gmelendez@geovictoria.com,alopez@geovictoria.com," +
    "tmartinezq@geovictoria.com,dgalvez@geovictoria.com,adiazg@geovictoria.com," +
    "asepulveda@geovictoria.com,aaraque@geovictoria.com,vicky@geovictoria.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

async function fetchDealsEquipo(soloTelemarketing = false): Promise<DealEquipo[]> {
  const out: DealEquipo[] = []
  try {
    const token = await getZohoAccessToken()
    const desde = new Date(Date.now() - 60 * 24 * 3600e3).toISOString().split("T")[0]
    // Selector de cotizaciones (Lalo 11-ago, "que no sea tanta carga"): solo
    // deals del roster de telemarketing en etapas 1→4 (~900 hoy, medido) —
    // sin ventana de actividad, así ninguno se cae por "frío" (caso FRIOSAN).
    const whereTm =
      `where (Owner.email in (${ROSTER_TELEMARKETING_EMAILS.map((e) => `'${e}'`).join(",")}) ` +
      `and Stage in ('1. Trato Creado', '2. Primera Reunion Realizada', '3. En Levantamiento', '4. Propuesta Enviada / En Negociación')) `
    const whereGeneral =
      `where ((Last_Activity_Time >= '${desde}T00:00:00-04:00' or Created_Time >= '${desde}T00:00:00-04:00') ` +
      `and Stage not in ('Cierre Perdido', 'Congelado', 'Facturación congelada', '8. Facturando')) `
    for (let offset = 0; offset < 2000; offset += 200) {
      // v8: TRES lookups (Owner, Contact_Name, Account_Name) — v3 topa en 2
      // relaciones (LIMIT_EXCEEDED; ver cotdeals_buscar, mismo incidente).
      const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          select_query:
            `select id, Deal_Name, Stage, Created_Time, Last_Activity_Time, Owner.first_name, Owner.last_name, ` +
            `Contact_Name.Phone, Contact_Name.Mobile, Contact_Name.Email, Account_Name.Account_Name, N_Empleados_que_marcan from Deals ` +
            (soloTelemarketing ? whereTm : whereGeneral) +
            // Hay más de 1000 deals activos (tope de la paginación): el orden
            // por actividad reciente deja fuera solo lo más frío.
            `order by Last_Activity_Time desc limit ${offset}, 200`,
        }),
      })
      if (!r.ok || r.status === 204) break
      const d = (await r.json().catch(() => ({}))) as { data?: DealEquipo[] }
      const rows = d?.data || []
      out.push(...rows)
      if (rows.length < 200) break
    }
  } catch (e) {
    console.warn("[vic-funnel] deals del equipo fallaron:", e instanceof Error ? e.message : e)
  }
  // Deals de PRUEBA fuera del dash (Lalo 13-ago): contacto con correo
  // interno o teléfono de la lista de métricas. Solo el camino del DASH —
  // el selector de cotizaciones (soloTelemarketing) los conserva para poder
  // anclar cotizaciones de prueba a sus propios deals.
  if (soloTelemarketing) return out
  const testSet = metricsContactSet()
  return out.filter((dl) => {
    if (esEmailInterno(String(dl["Contact_Name.Email"] || ""))) return false
    let tel = digits(String(dl["Contact_Name.Mobile"] || dl["Contact_Name.Phone"] || ""))
    if (tel.length === 9 && tel.startsWith("9")) tel = `56${tel}`
    return !(tel && isTestContact(tel, testSet))
  })
}

/** Estado del dashboard para un deal que NO pasó por la escalera de Vicky:
 * se mapea desde la etapa del pipeline de Zoho. */
function estadoDesdeStage(stage: string): string {
  const s = (stage || "").toLowerCase()
  if (/implement|facturando|ganado/.test(s)) return "Onboarding"
  if (/perdido/.test(s)) return "Perdida"
  if (/listo para cierre/.test(s)) return "Aceptada"
  if (/propuesta|negociaci|piloto/.test(s)) return "Formal enviada"
  if (/levantamiento/.test(s)) return "En levantamiento"
  return "Contactado"
}

function empresaDeQuote(q: RawAceptada): string {
  return (
    String(q["Cuenta_Asociada.Account_Name"] || "").trim() ||
    String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim() ||
    "(sin nombre)"
  )
}

function construirListadoComercial(params: {
  quotes: RawAceptada[]
  leads: LeadListado[]
  dealsPorId: Map<string, { stage: string; owner: string; lastActivity: string }>
  convs: ConvListado[]
  preformAt: Map<string, string>
  analysisRows: Row[]
  pais: Pais
  /** Cartera completa del equipo (deals activos de Zoho, pedido Lalo 07-ago). */
  dealsEquipo?: DealEquipo[]
}): FilaListado[] {
  const { quotes, leads, dealsPorId, convs, preformAt, analysisRows, pais, dealsEquipo = [] } = params
  // Deals ya representados por una fila de Vicky (cotización o lead
  // convertido): la pasada 4 no los duplica.
  const dealsUsados = new Set<string>()
  const delPais = (c: string) => paisDeTelefono(c) === pais
  const testSet = metricsContactSet()
  const convPorContacto = new Map(convs.map((c) => [digits(c.contact), c]))
  const analisisPorContacto = new Map(analysisRows.map((r) => [digits(r.contact), r]))
  const corte30d = Date.now() - 30 * 24 * 3600e3
  const filas: FilaListado[] = []
  const cubiertos = new Set<string>()
  const leadPorTel = new Map<string, LeadListado>()
  for (const l of leads) {
    const t = digits(String(l.Phone || ""))
    if (t && !leadPorTel.has(t)) leadPorTel.set(t, l)
  }

  // 1. Cotizaciones (formal en adelante). ÚLTIMA quote por contacto; las sin
  //    teléfono van como fila propia.
  const quotesOrdenadas = [...quotes].sort((a, b) => String(b.Created_Time || "").localeCompare(String(a.Created_Time || "")))
  for (const q of quotesOrdenadas) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && (!delPais(tel) || isTestContact(tel, testSet))) continue
    if (tel && cubiertos.has(tel)) continue
    if (Date.parse(String(q.Created_Time || "")) < corte30d) continue
    if (tel) cubiertos.add(tel)
    const pagada = esPagada(q)
    const aceptada = esAceptadaOMas(q)
    const estado = pagada ? "Pagada" : aceptada ? "Aceptada" : "Formal enviada"
    const fechaIso = pagada || aceptada
      ? String(q.Fecha_Hora_Cotizacion || q.Modified_Time || q.Created_Time || "")
      : String(q.Created_Time || "")
    const conv = tel ? convPorContacto.get(tel) : undefined
    const ana = tel ? analisisPorContacto.get(tel) : undefined
    // Dueño VIGENTE: el del DEAL (apenas se asigna el trato a un ejecutivo,
    // el dashboard lo refleja — pedido Lalo 06-ago); la cotización respalda.
    const dealDeQuote = (() => {
      const id = String(q["Deal_Asociado.id"] || "") || String((tel && leadPorTel.get(tel)?.Converted_Deal?.id) || "")
      if (id) dealsUsados.add(id)
      return id ? dealsPorId.get(id) : undefined
    })()
    filas.push({
      empresa: empresaDeQuote(q),
      contacto: tel ? `+${tel}` : "—",
      estado,
      fechaIso,
      estadoZoho: dealDeQuote?.stage || String(q["Deal_Asociado.Stage"] || "").trim() || "—",
      propietario: (() => {
        const dueDeal = (dealDeQuote?.owner || "").trim()
        const dueQuote = `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim()
        // El deal manda, PERO si su dueño es la interina (Vicky) y la
        // cotización tiene dueño humano real, se muestra el humano.
        if (dueDeal && !/vicky geovictoria|geovictoria admin/i.test(dueDeal)) return dueDeal
        if (dueQuote && !/vicky geovictoria|geovictoria admin/i.test(dueQuote)) return dueQuote
        return dueDeal || dueQuote || "—"
      })(),
      propietarios: [
        (dealDeQuote?.owner || "").trim(),
        `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim(),
        (tel && leadPorTel.get(tel) ? propietarioDeLead(leadPorTel.get(tel)!) : ""),
      ].filter(Boolean),
      primerContactoIso: String(conv?.started_at || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback(estado, ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(
        conv?.updated_at,
        q.Modified_Time,
        tel ? leadPorTel.get(tel)?.Last_Activity_Time : "",
        (() => {
          const dealId = String(q["Deal_Asociado.id"] || "") || String((tel && leadPorTel.get(tel)?.Converted_Deal?.id) || "")
          return dealId ? dealsPorId.get(dealId)?.lastActivity : ""
        })(),
      ),
      zohoUrl: zohoUrlDe(
        String(q["Deal_Asociado.id"] || "") || String((tel && leadPorTel.get(tel)?.Converted_Deal?.id) || ""),
        String((tel && leadPorTel.get(tel)?.id) || ""),
        String(q.id || ""),
      ),
    })
  }

  // 2. Preform sin formal: el precio se mostró en el chat y no hay quote.
  for (const [tel, at] of preformAt) {
    if (cubiertos.has(tel) || !delPais(tel) || isTestContact(tel, testSet)) continue
    if (Date.parse(at) < corte30d) continue
    cubiertos.add(tel)
    const lead = leads.find((l) => digits(String(l.Phone || "")) === tel)
    if (lead?.Converted_Deal?.id) dealsUsados.add(String(lead.Converted_Deal.id))
    const deal = lead?.Converted_Deal?.id ? dealsPorId.get(String(lead.Converted_Deal.id)) : undefined
    const conv = convPorContacto.get(tel)
    const ana = analisisPorContacto.get(tel)
    filas.push({
      empresa: String(lead?.Company || "").trim() || "(por identificar)",
      contacto: `+${tel}`,
      estado: "Preform enviado",
      fechaIso: at,
      estadoZoho: deal?.stage || String(lead?.Lead_Status || "").trim() || "—",
      propietario: deal?.owner || (lead ? propietarioDeLead(lead) : "—"),
      propietarios: [(deal?.owner || "").trim(), lead ? propietarioDeLead(lead) : ""].filter(Boolean),
      primerContactoIso: String(conv?.started_at || lead?.Created_Time || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback("Preform enviado", ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(conv?.updated_at, lead?.Last_Activity_Time, deal?.lastActivity),
      zohoUrl: zohoUrlDe(String(lead?.Converted_Deal?.id || ""), String(lead?.id || ""), null),
    })
  }

  // 3. Leads sin precio aún: Sin contactar / Contactado / En levantamiento.
  for (const l of leads) {
    const tel = digits(String(l.Phone || ""))
    if (!tel || cubiertos.has(tel) || !delPais(tel) || isTestContact(tel, testSet)) continue
    if (Date.parse(String(l.Created_Time || "")) < corte30d) continue
    cubiertos.add(tel)
    const conv = convPorContacto.get(tel)
    const ana = analisisPorContacto.get(tel)
    const respondio = Boolean(conv?.last_user_at)
    const enLevantamiento = respondio && ana?.sub_bucket === "cotizacion"
    const estadoLead = !respondio ? "Sin contactar" : enLevantamiento ? "En levantamiento" : "Contactado"
    // Lead ya CONVERTIDO a deal (p. ej. por una SDR): el estado en Zoho y el
    // propietario son los del DEAL, no los del lead congelado (caso Chanares:
    // el dash decía "4. Calificado / —" mientras el deal era de Grey).
    if (l.Converted_Deal?.id) dealsUsados.add(String(l.Converted_Deal.id))
    const deal = l.Converted_Deal?.id ? dealsPorId.get(String(l.Converted_Deal.id)) : undefined
    filas.push({
      empresa: String(l.Company || "").trim() || String(l.Full_Name || "").trim() || "(por identificar)",
      contacto: `+${tel}`,
      estado: estadoLead,
      fechaIso: respondio ? String(conv?.last_user_at || "") : String(l.Created_Time || ""),
      estadoZoho: deal?.stage || String(l.Lead_Status || "").trim() || "—",
      propietario: deal?.owner || propietarioDeLead(l),
      propietarios: [(deal?.owner || "").trim(), propietarioDeLead(l)].filter(Boolean),
      primerContactoIso: String(conv?.started_at || l.Created_Time || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback(estadoLead, ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(conv?.updated_at, l.Last_Activity_Time, deal?.lastActivity),
      zohoUrl: zohoUrlDe(String(l.Converted_Deal?.id || ""), String(l.id || ""), null),
    })
  }

  // 4. CARTERA COMPLETA del equipo (pedido Lalo 07-ago): deals activos de
  //    Zoho que NO nacieron de Vicky ni están cubiertos por contacto o por
  //    deal. Su estado se mapea desde la etapa del pipeline; el accionable
  //    usa el análisis de la conversación cuando el contacto también habló
  //    con Vicky.
  for (const dl of dealsEquipo) {
    const id = String(dl.id || "")
    if (!id || dealsUsados.has(id)) continue
    const stageDl = String(dl.Stage || "")
    // Cinturón además del COQL: congelados/perdidos no son cartera activa.
    if (/congelad|perdido/i.test(stageDl)) continue
    let tel = digits(String(dl["Contact_Name.Mobile"] || dl["Contact_Name.Phone"] || ""))
    // Celulares chilenos guardados sin el +56 ("955371823"): normalizar para
    // que el filtro por país y el cruce con conversaciones funcionen.
    if (tel.length === 9 && tel.startsWith("9")) tel = `56${tel}`
    if (tel && (cubiertos.has(tel) || isTestContact(tel, testSet))) continue
    // Sin teléfono no hay país que validar: esos deals van solo a la vista CL.
    if (tel ? !delPais(tel) : pais !== "cl") continue
    if (tel) cubiertos.add(tel)
    const conv = tel ? convPorContacto.get(tel) : undefined
    const ana = tel ? analisisPorContacto.get(tel) : undefined
    filas.push({
      empresa: String(dl["Account_Name.Account_Name"] || "").trim() || String(dl.Deal_Name || "").trim() || "(sin nombre)",
      contacto: tel ? `+${tel}` : "—",
      estado: estadoDesdeStage(stageDl),
      fechaIso: String(dl.Created_Time || ""),
      estadoZoho: stageDl || "—",
      propietario: `${dl["Owner.first_name"] || ""} ${dl["Owner.last_name"] || ""}`.trim() || "—",
      origen: conv?.id ? "vicky" : "zoho",
      primerContactoIso: String(conv?.started_at || dl.Created_Time || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || "Trato del ejecutivo en Zoho — revisar y avanzar la etapa.",
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(conv?.updated_at, dl.Last_Activity_Time),
      zohoUrl: zohoUrlDe(id, null, null),
    })
  }

  // Estados TERMINALES desde Zoho (pedido Lalo 07-ago): si el deal ya está
  // ganado (7. Implementando / 8. Facturando) o perdido (Cierre Perdido), la
  // escalera de Vicky lo refleja tal cual — Zoho manda sobre el estado
  // interno, en ambas direcciones.
  for (const f of filas) {
    if (/implementando|facturando/i.test(f.estadoZoho)) {
      f.estado = "Onboarding"
      f.accionable = "Cliente ganado 🎉 En onboarding/facturación — sin acción comercial pendiente."
    } else if (/perdido/i.test(f.estadoZoho)) {
      f.estado = "Perdida"
      f.accionable = "Marcada como Cierre Perdido en Zoho — sin acción."
    }
  }
  return filas.sort((a, b) => b.fechaIso.localeCompare(a.fechaIso))
}

/** Escalera de estados del listado — también alimenta el filtro global. */
// Onboarding/Perdida son estados TERMINALES espejados desde el deal de Zoho
// (Implementando/Facturando → Onboarding [antes "Ganada", Rodrigo 11-ago] ·
// Cierre Perdido → Perdida); el resto es
// la escalera propia de Vicky.
/** Tramos de dotación de la cola de gestión (Rodrigo 12-ago). */
function rangoUsuarios(n?: number | null): string {
  if (!n || n <= 0) return "—"
  if (n <= 10) return "1 a 10"
  if (n <= 20) return "11 a 20"
  if (n <= 50) return "21 a 50"
  if (n <= 200) return "51 a 200"
  if (n <= 300) return "201 a 300"
  return "301 o más"
}

const ESTADOS_LISTADO = ["Sin contactar", "Contactado", "En levantamiento", "Preform enviado", "Formal enviada", "Aceptada", "Pagada", "Onboarding", "Perdida"]

// ── COLA DE GESTIÓN (pedido Lalo 04-ago): la vista principal del dash es una
// lista de trabajo — a quién llamar/contactar AHORA, segmentado por tipo de
// accionable (derivado por regla desde la escalera) y por horario.
type TipoAccion = { id: string; label: string; emoji: string; prioridad: number }
const TIPOS_ACCION: TipoAccion[] = [
  { id: "cerrar_pago", label: "Cerrar pago", emoji: "💰", prioridad: 7 },
  { id: "completar_datos", label: "Completar datos", emoji: "📋", prioridad: 6 },
  { id: "empujar_cotizacion", label: "Empujar cotización", emoji: "📄", prioridad: 5 },
  { id: "destrabar_precio", label: "Destrabar precio", emoji: "🔓", prioridad: 4 },
  { id: "primer_contacto", label: "Primer contacto", emoji: "📞", prioridad: 3 },
  { id: "retomar", label: "Retomar interés", emoji: "🔄", prioridad: 2 },
  { id: "bienvenida", label: "Bienvenida post-venta", emoji: "🎉", prioridad: 1 },
]

/** Tipo de acción por regla determinística (estado + señales del accionable). */
function tipoAccionDe(f: FilaListado): TipoAccion | null {
  const texto = `${f.accionable} ${f.resumen}`.toLowerCase()
  const faltanDatos = /\brut\b|correo|email|completar datos|faltan? dato/.test(texto)
  const t = (id: string) => TIPOS_ACCION.find((x) => x.id === id) || null
  switch (f.estado) {
    case "Aceptada":
      return t("cerrar_pago")
    case "Pagada": {
      // Bienvenida solo la primera semana; después sale de la cola.
      const dias = (Date.now() - Date.parse(f.fechaIso || "")) / 864e5
      return Number.isFinite(dias) && dias <= 7 ? t("bienvenida") : null
    }
    case "Formal enviada":
      return faltanDatos ? t("completar_datos") : t("empujar_cotizacion")
    case "Preform enviado":
      return faltanDatos ? t("completar_datos") : t("destrabar_precio")
    case "Sin contactar":
      return t("primer_contacto")
    case "Contactado":
    case "En levantamiento":
      return t("retomar")
    default:
      return null
  }
}

const TZ_OFFSET: Record<Pais, number> = { cl: -4, co: -5, pe: -5, mx: -6 }

/** Hora local del cliente (por prefijo del teléfono) y si es llamable ahora
 * (L-V, 8-18 h local; los feriados por país quedan para vic_holidays). */
function horaLocalCliente(tel: string, paisDash: Pais): { hora: string; llamable: boolean } {
  const p = paisDeTelefono(tel) || paisDash
  const d = new Date(Date.now() + TZ_OFFSET[p] * 3600e3)
  const h = d.getUTCHours()
  const dow = d.getUTCDay()
  return {
    hora: `${String(h).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    llamable: dow >= 1 && dow <= 5 && h >= 8 && h < 18,
  }
}

/** Caso listo para gestionar — lo consumen la vista HTML, el modo JSON del
 * dash y el resumen diario por correo. */
// ── Canal de llegada (Rodrigo 17-ago, "en todos los dashboards"): cómo llegó
// el contacto. Fila en vic_outbound_cadence = lead CARGADO (formulario web /
// base → cadencia outbound); sin fila = nos escribió él solo por WhatsApp.
// Mismo criterio inmutable del funnel por origen y del umbral 20/10.
function chipLlegoPor(esFormulario: boolean): string {
  return esFormulario
    ? `<span class="tag" style="background:#eef2ff;color:#4c51bf" title="Lead cargado a la cadencia outbound (formulario web / base)">📋 Formulario</span>`
    : `<span class="tag" style="background:#e6f7ee;color:#1b6e3c" title="El cliente nos escribió directo por WhatsApp">📱 WhatsApp</span>`
}

type CasoGestion = {
  empresa: string
  contacto: string
  propietario: string
  origen: "vicky" | "zoho"
  /** Canal de llegada: true = lead cargado (formulario/base outbound). */
  esFormulario: boolean
  convId: string
  tipoId: string
  tipoLabel: string
  tipoEmoji: string
  prioridad: number
  urgencia: string
  urgenciaColor: string
  horaLocal: string
  llamable: boolean
  monto: string
  /** Valor numérico del recurrente para ordenar (UF, o CLP normalizado). */
  montoOrden: number
  /** Dotación conocida (cotizada o declarada en el deal); 0 = sin dato. */
  usuarios: number
  diasSinContacto: number
  accionable: string
  resumen: string
  score: number
  /** Columnas heredadas del listado comercial (fusión 04-ago). */
  primerContactoIso: string
  estado: string
  fechaEstadoIso: string
  /** Último contacto real (chat o actividad en Zoho) — manda en la columna
   * Estado y en el contador de días sin contacto. */
  ultimoContactoIso: string
  estadoZoho: string
  /** Link directo al registro en Zoho (deal → lead → cotización). */
  zohoUrl: string
  /** Ya marcada como gestionada (se muestra atenuada, con deshacer). */
  gestionado: boolean
  /** Cotización formal vigente: link para VERLA (PDF o página de aceptación)
   * y flag para EDITARLA con Vicky Cotizaciones (pedido Lalo 06-ago). */
  cotVer: string
  cotQuoteId: string
}

function construirCasosGestion(params: {
  filas: FilaListado[]
  gestionados: Map<string, string>
  montos: Map<string, { uf: number | null; clp: number | null }>
  pais: Pais
  cots?: Map<string, { quoteId: string; ver: string }>
  usuarios?: Map<string, number>
  /** Contactos con fila en vic_outbound_cadence (lead cargado = formulario). */
  formularioSet?: Set<string>
}): { casos: CasoGestion[]; nGestionados: number } {
  const { filas, gestionados, montos, pais, cots = new Map(), usuarios = new Map(), formularioSet = new Set() } = params
  const conTipo = filas
    // Deal en "Cierre Perdido" en Zoho → fuera de la cola de gestión (pedido
    // Lalo 05-ago): la oportunidad ya se dio por perdida, no hay acción.
    .filter((f) => !/perdido/i.test(f.estadoZoho))
    .map((f) => ({ f, tipo: tipoAccionDe(f) }))
    .filter((x): x is { f: FilaListado; tipo: TipoAccion } => x.tipo !== null)
  const nGestionados = conTipo.filter((x) => gestionados.has(digits(x.f.contacto))).length

  const diasSin = (f: FilaListado) => {
    const t = Date.parse(f.ultimoContactoIso || f.updatedIso || f.fechaIso || "")
    return Number.isFinite(t) ? (Date.now() - t) / 864e5 : 99
  }
  const casos = conTipo.map(({ f, tipo }) => {
    const d = digits(f.contacto)
    const dias = diasSin(f)
    const limite = tipo.prioridad >= 5 ? 1 : 2 // los calientes vencen antes
    const urg = dias > limite * 2 ? { label: "Vencido", color: "#C62828" } : dias > limite ? { label: "Hoy", color: "#F9A825" } : { label: "Al día", color: "#2E7D32" }
    const m = montos.get(d)
    // La UF existe solo en Chile (pedido Lalo 04-ago): en CO/MX el monto es
    // moneda local con $, en PE con S/ — venga en el campo que venga (los
    // punteros de esos países guardan el monto local en uf o en clp).
    const simbolo = pais === "pe" ? "S/ " : "$"
    const montoTxt =
      pais === "cl"
        ? m?.uf
          ? `UF ${m.uf.toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
          : m?.clp
            ? `$${Math.round(m.clp).toLocaleString("es-CL")}`
            : "—"
        : m?.clp
          ? `${simbolo}${Math.round(m.clp).toLocaleString("es-CL")}`
          : m?.uf
            ? `${simbolo}${Math.round(m.uf).toLocaleString("es-CL")}`
            : "—"
    const montoUF = m?.uf || (m?.clp ? m.clp / 40000 : 0)
    const hl = horaLocalCliente(d, pais)
    return {
      empresa: f.empresa,
      contacto: d,
      propietario: f.propietario,
      origen: f.origen || "vicky",
      esFormulario: formularioSet.has(d),
      convId: f.convId,
      tipoId: tipo.id,
      tipoLabel: tipo.label,
      tipoEmoji: tipo.emoji,
      prioridad: tipo.prioridad,
      urgencia: urg.label,
      urgenciaColor: urg.color,
      horaLocal: hl.hora,
      llamable: hl.llamable,
      monto: montoTxt,
      usuarios: usuarios.get(d) || 0,
      montoOrden: montoUF,
      diasSinContacto: Math.round(dias * 10) / 10,
      accionable: f.accionable,
      resumen: f.resumen,
      score: tipo.prioridad * 100 + Math.min(montoUF, 50) * 2 + Math.min(dias, 14),
      primerContactoIso: f.primerContactoIso,
      estado: f.estado,
      fechaEstadoIso: f.fechaIso,
      ultimoContactoIso: f.ultimoContactoIso,
      estadoZoho: f.estadoZoho,
      zohoUrl: f.zohoUrl,
      gestionado: gestionados.has(d),
      cotVer: cots.get(d)?.ver || "",
      cotQuoteId: cots.get(d)?.quoteId || "",
    }
  })
  casos.sort((a, b) => b.prioridad - a.prioridad || b.score - a.score)
  return { casos, nGestionados }
}

function renderColaGestion(casos: CasoGestion[], nGestionados: number, key: string, descargaQS = "", wspSet: Set<string> = new Set(), quienSesion = "", atendidosSet: Set<string> = new Set()): string {
  const activos = casos.filter((c) => !c.gestionado)
  const fila = (c: CasoGestion): string => {
    const dias = c.diasSinContacto
    // "Listo" (✔/↩) en grande, primera columna de la fila.
    const btn = c.gestionado
      ? `<button class="btnGest" data-contact="${esc(c.contacto)}" data-estado="gestionado" title="Deshacer: volver a la cola" style="background:#fff3e0;color:#7a4b00;border:1px solid #ffcc80;border-radius:8px;padding:8px 12px;font-size:17px;cursor:pointer">↩</button>`
      : `<button class="btnGest" data-contact="${esc(c.contacto)}" title="Pendiente — al gestionarlo márcalo acá (pide registro y guarda nota en Zoho)" style="background:#fffdf5;color:#92700c;border:1px dashed #d4b106;border-radius:8px;padding:8px 12px;font-size:17px;cursor:pointer">💬</button>`
    // WhatsApp reconocible pero compacto (solo el ícono, en verde oficial).
    // wa.me exige SOLO dígitos (con el "+" o con "—" el link fallaba — caso
    // Consistorial 07-ago: contacto sin teléfono en Zoho → wa.me/— roto).
    const waDigits = String(c.contacto || "").replace(/\D/g, "")
    const btnWa = waDigits
      ? `<a href="https://wa.me/${waDigits}" target="_blank" title="Abrir chat de WhatsApp" style="background:#25D366;color:#ffffff;text-decoration:none;padding:8px 11px;border-radius:8px;font-size:16px;display:inline-block;white-space:nowrap">💬</a>`
      : `<span title="Este registro no tiene teléfono en el CRM" style="background:#e5e7eb;color:#9ca3af;padding:8px 11px;border-radius:8px;font-size:16px;display:inline-block;white-space:nowrap;cursor:not-allowed">💬</span>`
    // Fecha compacta apilada (fecha arriba, hora abajo) — usa la mitad de ancho.
    const fechaCompacta = (iso: string) => {
      const [fp, ...hp] = fmtSantiago(iso).split(", ")
      return `${fp}<div class="sub" style="margin:0;font-size:11px">${hp.join(", ")}</div>`
    }
    return `<tr data-contact="${esc(c.contacto)}"${c.gestionado ? ` class="filaGest" style="opacity:.4;display:none"` : ""}>
          <td class="tdBtn" style="white-space:nowrap;vertical-align:middle">${btn}</td>
          <td class="tdEmp" data-sort="${esc(c.empresa.toLowerCase())}">${esc(c.empresa)}${c.origen === "zoho" ? ` <span title="Trato del pipeline de Zoho — no ha pasado por Vicky" style="background:#eef2ff;color:#4c51bf;border:1px solid #c3dafe;border-radius:6px;padding:0 5px;font-size:11px;font-weight:600;vertical-align:middle">🗂 Zoho</span>` : ""}<div class="sub" style="margin:0;font-size:12px">+${esc(c.contacto)} · ${
              quienSesion && c.propietario !== quienSesion && c.propietario !== "—"
                ? `<span title="Esta oportunidad te aparece porque tienes un registro asociado (lead o cotización), pero el responsable principal es otro — coordina antes de contactar al cliente" style="background:#fff7e0;color:#92700c;border:1px solid #ffd875;border-radius:6px;padding:1px 6px;font-weight:600">responsable: ${esc(c.propietario)}</span>`
                : esc(c.propietario)
            }</div>${(() => {
            const links = [
              c.convId ? `<a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(c.convId)}" style="font-size:13px">📄 ver chat</a>` : "",
              c.zohoUrl ? `<a href="${esc(c.zohoUrl)}" target="_blank" rel="noopener" title="Abrir el registro en Zoho CRM" style="font-size:13px">🔗 Zoho</a>` : "",
              wspSet.has(c.contacto) ? `<a href="?key=${encodeURIComponent(key)}&wsp=${encodeURIComponent(c.contacto)}" target="_blank" title="WhatsApp del vendedor con este cliente (se abre listo para guardar como PDF)" style="font-size:13px">📱 wsp vendedor</a>` : "",
              c.cotVer ? `<a href="${esc(c.cotVer)}" target="_blank" rel="noopener" title="Ver la cotización formal vigente" style="font-size:13px">🧾 cotización</a>` : "",
              c.cotQuoteId
                ? `<a href="?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(c.contacto)}" title="Editar la cotización conversando con Vicky Cotizaciones y enviarla al cliente" style="font-size:13px">✏️ editar</a>`
                : c.convId && c.origen !== "zoho"
                  ? `<a href="?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(c.contacto)}" title="Emitir la cotización formal con el contexto de la conversación (preform incluido)" style="font-size:13px">➕ formal</a>`
                  : "",
            ].filter(Boolean).join(" · ")
            return links ? `<div style="margin-top:3px">${links}</div>` : ""
          })()}</td>
          <td data-l="Primer contacto" data-sort="${Date.parse(c.primerContactoIso || "") || 0}" style="white-space:nowrap">${c.primerContactoIso ? fechaCompacta(c.primerContactoIso) : "—"}</td>
          <td data-l="Estado" data-sort="${esc(c.estado.toLowerCase())}"><span class="tag">${esc(c.estado)}</span></td>
          <td data-l="Llegó por" data-sort="${c.esFormulario ? "formulario" : "whatsapp"}" style="white-space:nowrap">${chipLlegoPor(c.esFormulario)}</td>
          <td data-l="Usuarios" data-sort="${c.usuarios || 0}" style="white-space:nowrap;text-align:center" title="${c.usuarios ? `${c.usuarios} usuarios` : "sin dato de dotación"}">${rangoUsuarios(c.usuarios)}</td>
          <td data-l="Últ. actividad" data-sort="${Date.parse(c.ultimoContactoIso || c.fechaEstadoIso || "") || 0}" style="white-space:nowrap" title="última actividad con el cliente: WhatsApp de Vicky, WhatsApp o llamada del vendedor (espejo), o actividad en Zoho">${haceTexto(c.ultimoContactoIso || c.fechaEstadoIso)}${c.ultimoContactoIso ? `<div class="sub" style="margin:2px 0 0;font-size:11px">${fmtSantiago(c.ultimoContactoIso)}</div>` : ""}</td>
          <td data-l="Recurrente" data-sort="${c.montoOrden || 0}" style="white-space:nowrap;text-align:right">${c.monto}</td>
          <td data-l="Accionable" data-sort="${esc(c.accionable.toLowerCase().slice(0, 80))}">${esc(c.accionable)}${c.resumen ? `<div class="sub" style="margin:2px 0 0;font-size:12px">${esc(c.resumen)}</div>` : ""}</td>
          <td class="tdWa" style="white-space:nowrap;vertical-align:middle;padding-left:10px">${btnWa}</td>
          <!-- Botón "🤝 Ya lo contacté" RETIRADO (Lalo 12-ago): silenciaba los
               seguimientos de Vicky (candado v3 lo contaba como atención real)
               y el aprendizaje de la semana mala es que Vicky nunca se calla.
               La atención real se detecta sola (WhatsApp espejado / llamadas);
               la acción "atendido" del backend sigue viva por si hay marcas
               históricas, pero ya no hay UI que la dispare. -->
        </tr>`
  }
  const secciones = TIPOS_ACCION.map((tipo) => {
    const grupo = activos.filter((c) => c.tipoId === tipo.id)
    const grupoGest = casos.filter((c) => c.gestionado && c.tipoId === tipo.id)
    if (!grupo.length && !grupoGest.length) return ""
    return `<div class="kgroup" style="margin-top:14px">${tipo.emoji} ${tipo.label} — ${grupo.length}</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th class="noSort">Comentarios</th><th>Empresa / contacto · ejecutivo</th><th>Primer contacto</th><th>Estado</th><th title="Cómo llegó el contacto: nos escribió directo por WhatsApp, o entró como lead cargado (formulario web / base) a la cadencia outbound">Llegó por</th><th title="Dotación conocida: cotizada en el chat o declarada en el deal">Usuarios</th><th title="Última actividad con el cliente por cualquiera de las 3 fuentes: WhatsApp de Vicky, WhatsApp o llamada del vendedor (espejo), o actividad registrada en Zoho">Última actividad</th><th style="text-align:right">Recurrente</th><th style="width:38%">Accionable</th><th class="noSort" style="padding-left:10px">WA</th></tr></thead>      <tbody>${grupo.map(fila).join("")}${grupoGest.map(fila).join("")}</tbody>
    </table></div>`
  }).join("")

  return `<style>.colaGest table th,.colaGest table td{padding:7px 6px;font-size:12.5px}
  /* Celular: cada fila de la cola se vuelve una tarjeta apilada. */
  @media (max-width:640px){
    .colaGest thead{display:none}
    .colaGest table,.colaGest tbody{display:block;width:100%}
    .colaGest tr{display:block;box-sizing:border-box;border:1px solid #dfe2e7;border-radius:12px;margin:0 0 10px;padding:10px 12px;background:#fff;position:relative}
    .colaGest table td{display:block;border:0;padding:2px 0;font-size:13px;white-space:normal !important;text-align:left !important;max-width:none !important}
    .colaGest td[data-l]::before{content:attr(data-l) ": ";font-size:11px;font-weight:700;color:#9aa0a8}
    .colaGest td.tdBtn{position:absolute;top:10px;right:12px;width:auto;padding:0}
    .colaGest td.tdWa{position:absolute;top:60px;right:12px;width:auto;padding:0 !important}
    .colaGest td.tdEmp{padding-right:70px;font-weight:700;min-height:44px}
    .colaGest td.tdEmp .sub{font-weight:400}
  }</style>
  <div class="card colaGest"><h2>📞 Para gestionar hoy <span class="pct" style="font-weight:400">— ${activos.length} oportunidades con acción pendiente${nGestionados ? ` · ${nGestionados} gestionadas · <a href="#" id="lnkVerGest" style="font-size:13px">mostrar</a>` : ""}</span>${descargaQS ? `<span style="float:right;font-weight:400;font-size:13px"><a href="?${descargaQS}&formato=csv" title="Descargar la cola completa en Excel (CSV)">⬇️ Excel</a> · <a href="?${descargaQS}&formato=impresion" target="_blank" title="Vista de impresión para guardar como PDF">🖨️ PDF</a></span>` : ""}</h2>
  ${activos.length || nGestionados ? secciones : `<p class="sub" style="margin:0">Nada pendiente con los filtros actuales. 🎉</p>`}
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      // Viñeta flotante para el registro de gestión (en vez del prompt nativo).
      var pop = document.createElement("div");
      pop.style.cssText = "position:absolute;z-index:50;display:none;background:#fff;border:1px solid #d0d5db;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px;width:300px;max-width:calc(100vw - 16px);box-sizing:border-box";
      pop.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:6px">Registro de la gestión <span style="color:#c62828">*</span></div>' +
        '<div style="font-size:12px;color:#6b7280;margin-bottom:6px">¿Qué hiciste o qué acordaste con el cliente? Se guarda como nota en Zoho.</div>' +
        '<textarea id="popNota" rows="3" style="width:100%;box-sizing:border-box;font-size:13px;padding:6px;border:1px solid #d0d5db;border-radius:6px;resize:vertical"></textarea>' +
        '<div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">' +
        '<button id="popCancelar" style="background:#f3f4f6;color:#374151;border:1px solid #d0d5db;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer">Cancelar</button>' +
        '<button id="popGuardar" style="background:#ffbb00;color:#fff;border:0;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer">Guardar ✔</button></div>';
      document.body.appendChild(pop);
      var nota = pop.querySelector("#popNota");
      var btnActual = null;
      function cerrar() { pop.style.display = "none"; nota.value = ""; nota.style.borderColor = "#d0d5db"; btnActual = null; }
      function abrir(b) {
        btnActual = b;
        var r = b.getBoundingClientRect();
        pop.style.display = "block";
        var left = r.right + window.scrollX + 10;
        var maxLeft = window.scrollX + document.documentElement.clientWidth - 310;
        if (left > maxLeft) left = Math.max(window.scrollX + 8, Math.min(r.left + window.scrollX, maxLeft));
        pop.style.left = left + "px";
        pop.style.top = (r.top + window.scrollY - 8) + "px";
        nota.focus();
      }
      pop.querySelector("#popCancelar").addEventListener("click", cerrar);
      document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") cerrar(); });
      document.addEventListener("click", function (ev) {
        if (pop.style.display !== "none" && !pop.contains(ev.target) && !(btnActual && btnActual.contains(ev.target))) cerrar();
      });
      pop.querySelector("#popGuardar").addEventListener("click", async function () {
        var texto = (nota.value || "").trim();
        if (!texto) { nota.style.borderColor = "#c62828"; nota.focus(); return; }
        var b = btnActual;
        if (!b) return;
        var tr = b.closest("tr");
        this.disabled = true; this.textContent = "Guardando…";
        try {
          var res = await fetch(KEYQ + "&accion=gestionar&contact=" + encodeURIComponent(b.dataset.contact), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "nota=" + encodeURIComponent(texto),
          });
          // Sin ok del servidor el botón NO cambia (antes quedaba "gestionada"
          // en pantalla aunque el guardado hubiera fallado).
          if (!res.ok) throw new Error("HTTP " + res.status);
          tr.style.transition = "opacity .4s"; tr.style.opacity = "0.4";
          b.dataset.estado = "gestionado"; b.textContent = "↩"; b.title = "Deshacer: volver a la cola";
          b.style.background = "#fff3e0"; b.style.color = "#7a4b00"; b.style.border = "1px solid #ffcc80";
          cerrar();
        } catch (e) {
          alert("No se pudo guardar la gestión (el caso sigue pendiente). Revisa tu conexión e inténtalo de nuevo.");
        }
        this.disabled = false; this.textContent = "Guardar ✔";
      });
      function wire(b) {
        b.addEventListener("click", async function () {
          var tr = this.closest("tr");
          if (this.dataset.estado === "gestionado") {
            this.disabled = true; this.textContent = "…";
            try {
              var resU = await fetch(KEYQ + "&accion=desgestionar&contact=" + encodeURIComponent(this.dataset.contact), { method: "POST" });
              if (!resU.ok) throw new Error("HTTP " + resU.status);
              tr.style.opacity = "1"; tr.classList.remove("filaGest");
              this.dataset.estado = ""; this.textContent = "⏳"; this.title = "Pendiente — al gestionarlo márcalo acá (pide registro y guarda nota en Zoho)";
              this.style.background = "#fffdf5"; this.style.color = "#92700c"; this.style.border = "1px dashed #d4b106";
            } catch (e) {
              this.textContent = "↩";
              alert("No se pudo deshacer la gestión. Revisa tu conexión e inténtalo de nuevo.");
            }
            this.disabled = false;
            return;
          }
          abrir(this);
        });
      }
      document.querySelectorAll(".btnGest").forEach(wire);
      var lnk = document.getElementById("lnkVerGest");
      if (lnk) lnk.addEventListener("click", function (ev) {
        ev.preventDefault();
        var filas = document.querySelectorAll("tr.filaGest");
        var ocultas = filas.length && filas[0].style.display === "none";
        filas.forEach(function (f) { f.style.display = ocultas ? "" : "none"; });
        this.textContent = ocultas ? "ocultar" : "mostrar";
      });
      // Orden por columnas (pedido Lalo 06-ago): clic en un encabezado ordena
      // esa sección asc/desc — números por valor, textos A-Z / Z-A.
      document.querySelectorAll(".colaGest table").forEach(function (tabla) {
        var ths = tabla.querySelectorAll("thead th");
        ths.forEach(function (th, idx) {
          if (th.classList.contains("noSort")) return;
          th.style.cursor = "pointer";
          th.title = "Ordenar por esta columna";
          th.addEventListener("click", function () {
            var asc = th.dataset.dir !== "asc";
            ths.forEach(function (o) {
              delete o.dataset.dir;
              o.textContent = o.textContent.replace(/ [▲▼]$/, "");
            });
            th.dataset.dir = asc ? "asc" : "desc";
            th.textContent = th.textContent + (asc ? " ▲" : " ▼");
            var tbody = tabla.querySelector("tbody");
            var filas = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
            var valor = function (tr) {
              var td = tr.children[idx];
              if (!td) return "";
              return td.dataset.sort !== undefined ? td.dataset.sort : td.textContent.trim().toLowerCase();
            };
            var numerico = filas.every(function (tr) { var v = valor(tr); return v === "" || !isNaN(parseFloat(v)); });
            filas.sort(function (a, b) {
              var va = valor(a), vb = valor(b);
              var r = numerico
                ? (parseFloat(va) || 0) - (parseFloat(vb) || 0)
                : String(va).localeCompare(String(vb), "es");
              return asc ? r : -r;
            });
            filas.forEach(function (tr) { tbody.appendChild(tr); });
          });
        });
      });
    })();
  </script>
</div>`
}

function renderListadoComercial(filas: FilaListado[], key: string, periodo: string, conRango: boolean): string {
  if (!filas.length) {
    // Con rango activo la sección no desaparece: se explica que no hubo actividad.
    if (conRango) {
      return `<div class="card"><h2>Listado comercial vivo <span class="pct" style="font-weight:400">— 0 casos ${periodo}</span></h2>
  <p class="sub" style="margin:0">Sin casos con actividad en el período seleccionado.</p></div>`
    }
    return ""
  }
  const filasHtml = filas
    .map(
      (f) => `<tr data-estado="${esc(f.estado)}" data-prop="${esc(f.propietario)}" data-fecha="${esc(f.fechaIso.slice(0, 10))}">
        <td>${esc(f.empresa)}<div class="sub" style="margin:0">${esc(f.contacto)}</div></td>
        <td>${f.primerContactoIso ? fmtSantiago(f.primerContactoIso) : "—"}</td>
        <td><span class="tag">${esc(f.estado)}</span></td>
        <td>${fmtSantiago(f.fechaIso)}</td>
        <td>${esc(f.estadoZoho)}</td>
        <td>${esc(f.propietario)}</td>
        <td style="max-width:260px" title="${esc(f.resumen)}">${esc(f.accionable)}${f.convId ? `<div style="margin-top:4px"><a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(f.convId)}">ver conversación completa →</a></div>` : ""}</td>
      </tr>`,
    )
    .join("")
  return `<div class="card"><h2>Listado comercial vivo <span class="pct" style="font-weight:400">— ${filas.length} casos (${periodo})</span></h2>
  <div style="overflow-x:auto"><table id="lcTabla">
    <thead><tr><th>Empresa / contacto</th><th>Primer contacto</th><th>Estado</th><th>Fecha último estado</th><th>Estado en Zoho (deal/lead)</th><th>Propietario</th><th>Accionable (Claude)</th></tr></thead>
    <tbody>${filasHtml}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">El estado es el más avanzado alcanzado por el caso; su fecha es la del evento que lo definió (pago, aceptación, emisión de la formal, precio mostrado en el chat, última respuesta del cliente o creación del lead). "Estado en Zoho" muestra la etapa del deal (o el status del lead si aún no hay deal). El accionable lo escribe el análisis de Claude por conversación (pasa el mouse para ver el resumen; si aún no fue analizada, sale una sugerencia por estado). Fechas en hora de Chile. Para filtrar, usa los filtros globales de arriba (aplican a toda la página, incluida esta tabla). Con un rango de fechas activo se muestran solo los casos con actividad en el período: inicio de conversación, última respuesta del cliente, último mensaje o el evento del estado, cualquiera dentro del rango.</div>
</div>`
}

/** Evolución diaria (pedido Lalo 04-ago): serie de los últimos 30 días con
 * conversaciones, intención comercial, precios mostrados (preform), formales
 * emitidas, aceptadas y pagadas. Días en hora de Chile; las cotizaciones van
 * por su fecha en Zoho (emisión para formales, pago para aceptadas/pagadas). */
function renderEvolucionDiaria(params: {
  convs: ConvListado[]
  analysisRows: Row[]
  preformAt: Map<string, string>
  quotes: RawAceptada[]
  pais: Pais
  rango: RangoFechas | null
  key?: string
}): string {
  const { convs, analysisRows, preformAt, quotes, pais, rango, key = "" } = params
  const testSet = metricsContactSet()
  const diaDe = (iso: string | null | undefined): string => {
    const t = Date.parse(String(iso || ""))
    if (!Number.isFinite(t)) return ""
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t))
  }
  // El gráfico sigue el filtro Desde–Hasta; sin filtro, últimos 30 días.
  // Todos los días del rango presentes (cero cuando no hubo actividad).
  const DIA_MS = 864e5
  const finMs = rango && rango.hastaMs !== Number.MAX_SAFE_INTEGER ? rango.hastaMs : Date.now()
  const inicioMs = rango && rango.desdeMs > 0 ? rango.desdeMs : finMs - 29 * DIA_MS
  // floor y no round: el rango va de las 00:00 del desde a las 23:59 del
  // hasta — round sumaba un día fantasma al inicio (31-07 en un rango 01-08).
  const nDias = Math.min(366, Math.max(1, Math.floor((finMs - inicioMs) / DIA_MS) + 1))
  const dias: string[] = []
  for (let i = nDias - 1; i >= 0; i--) {
    const d = diaDe(new Date(finMs - i * DIA_MS).toISOString())
    if (d && dias[dias.length - 1] !== d) dias.push(d)
  }
  const idx = new Map(dias.map((d, i) => [d, i]))
  const serie = () => new Array<number>(dias.length).fill(0)
  // DETALLE POR PUNTO (Lalo 14-ago, "quiero ver el detalle de las filas que
  // generan el número"): junto al conteo se guarda QUÉ compone cada día de
  // cada serie, para abrirlo en una ventana al hacer clic en el gráfico.
  type FilaDet = { t: string; e: string; d?: string; o?: string; s?: string; id?: string }
  const detalle = () => dias.map(() => [] as FilaDet[])
  const suma = (arr: number[], iso: string | null | undefined, det?: FilaDet[][], fila?: FilaDet) => {
    const i = idx.get(diaDe(iso))
    if (i === undefined) return
    arr[i]++
    if (det && fila && det[i].length < 120) det[i].push(fila)
  }
  const sConv = serie(), sCom = serie(), sPreform = serie(), sFormal = serie(), sAcept = serie(), sPag = serie()
  const dConv = detalle(), dCom = detalle(), dPreform = detalle(), dFormal = detalle(), dAcept = detalle(), dPag = detalle()
  const empresaDeQuote = (q: RawAceptada) =>
    String(q["Cuenta_Asociada.Account_Name"] || "").trim() ||
    String(q.Name || "").replace(/^\s*Cotizaci[oó]n\s*/i, "").replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, "").trim() ||
    "(sin empresa)"
  const filaDeQuote = (q: RawAceptada): FilaDet => ({
    t: String(q.Numero_Cotizacion || "").trim() || "(sin N°)",
    e: empresaDeQuote(q),
    d: digits(String(q.Tel_fono_Contacto || "")),
    o: `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim() || "—",
    s: esPagada(q) ? "Pagada" : String(q.Estado_Cotizacion || "—"),
    id: String(q.id || ""),
  })

  const delPais = (tel: string) => paisDeTelefono(tel) === pais && !isTestContact(tel, testSet)
  const convIdPorTel = new Map<string, string>()
  for (const c of convs) {
    const t = digits(c.contact)
    if (t && !convIdPorTel.has(t)) convIdPorTel.set(t, String(c.id || ""))
  }
  const inicioPorContacto = new Map<string, string>()
  for (const c of convs) {
    const tel = digits(c.contact)
    if (!tel || !delPais(tel)) continue
    if (!inicioPorContacto.has(tel)) inicioPorContacto.set(tel, String(c.started_at || ""))
    suma(sConv, c.started_at, dConv, { t: `+${tel}`, e: "conversación", id: String(c.id || "") })
  }
  // FOTO DIARIA DE EVENTOS (definición final de Lalo 05-ago): cada serie
  // cuenta lo que OCURRIÓ ese día — chats que partieron, precios mostrados,
  // formales emitidas, aceptaciones y pagos. NO es un embudo: las líneas
  // pueden cruzarse legítimamente (la formal de hoy puede venir de un chat
  // de ayer). Dos correcciones que SÍ se conservan del 05-ago:
  //  - intención no depende solo del análisis batch: un chat que vio precio
  //    o tiene formal ES comercial aunque su análisis aún no corra (sin esto
  //    el día en curso siempre subcontaba);
  //  - las cotizaciones de contactos de PRUEBA quedan fuera de las series.
  const comercialSet = new Set<string>()
  for (const r of analysisRows) {
    if (r.grupo === "comercial") comercialSet.add(digits(r.contact))
  }
  for (const tel of preformAt.keys()) comercialSet.add(tel)
  for (const q of quotes) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && !isTestContact(tel, testSet)) comercialSet.add(tel)
  }
  for (const tel of comercialSet) {
    if (!tel || !delPais(tel)) continue
    suma(sCom, inicioPorContacto.get(tel), dCom, { t: `+${tel}`, e: "intención comercial", id: convIdPorTel.get(tel) || "" })
  }
  for (const [tel, at] of preformAt) {
    if (delPais(tel)) suma(sPreform, at, dPreform, { t: `+${tel}`, e: "precio mostrado en el chat", id: convIdPorTel.get(tel) || "" })
  }
  // Todas las cotizaciones que llegan acá son de Vicky: el universo ya se
  // filtró aguas arriba (filtrarCierreAVicky, Lalo 14-ago) — lo que los
  // ejecutivos emiten a clientes propios no entra al dash.
  for (const q of quotes) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && isTestContact(tel, testSet)) continue
    const fila = filaDeQuote(q)
    suma(sFormal, q.Created_Time, dFormal, fila)
    const pagada = esPagada(q)
    const aceptada = esAceptadaOMas(q)
    // FOTO DIARIA DE HITOS (Lalo 14-ago): cada serie cuenta el día en que
    // OCURRIÓ su hito. La aceptación/pago se cuenta por su propia fecha —
    // JAMÁS por Created_Time (el día de emisión): una cotización enviada el
    // lunes y aceptada el jueves es formal del lunes y aceptada del jueves.
    // Sin fecha de hito no se cuenta en ningún día (mejor faltar que mentir).
    const fechaHito = q.Fecha_Hora_Cotizacion || q.Modified_Time || ""
    if (aceptada) suma(sAcept, fechaHito, dAcept, fila)
    if (pagada) suma(sPag, fechaHito, dPag, fila)
  }

  const trazas = [
    { nombre: "Conversaciones", datos: sConv, color: "#9aa0a8", det: dConv },
    { nombre: "Intención comercial", datos: sCom, color: "#00aff2", det: dCom },
    { nombre: "Precio mostrado (preform)", datos: sPreform, color: "#ffbb00", det: dPreform },
    { nombre: "Formal enviada", datos: sFormal, color: "#e67e22", det: dFormal },
    { nombre: "Aceptada", datos: sAcept, color: "#27ae60", det: dAcept },
    { nombre: "Pagada", datos: sPag, color: "#1b5e20", det: dPag },
  ]
  // Agrupación según el largo del rango (pedido Lalo 04-ago): >1 semana
  // ofrece Día/Semana; ≥2 meses suma la opción Mes. La agregación corre en el
  // navegador sobre la serie diaria ya embebida.
  const btnCss = "border:1px solid #d0d5db;border-radius:6px;padding:3px 10px;margin-left:4px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;background:#fff;color:#4e4e4e"
  const selector = dias.length > 7
    ? `<span style="float:right;font-weight:400"><button class="evoBtn" data-modo="dia" style="${btnCss}">Día</button><button class="evoBtn" data-modo="semana" style="${btnCss}">Semana</button>${dias.length >= 60 ? `<button class="evoBtn" data-modo="mes" style="${btnCss}">Mes</button>` : ""}</span>`
    : ""
  return `<div class="card"><h2>📈 Evolución <span class="pct" style="font-weight:400">— ${rango ? esc(rango.etiqueta) : "últimos 30 días"}</span>${selector}</h2>
  <div id="evoDiaria" style="height:340px"></div>
  <div id="evoDet" style="display:none;position:fixed;inset:0;z-index:60;align-items:center;justify-content:center;padding:16px">
    <div id="evoDetFondo" style="position:absolute;inset:0;background:rgba(15,23,42,.45)"></div>
    <div style="position:relative;background:#fff;border-radius:14px;max-width:960px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.22)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #e5e7eb">
        <b id="evoDetTitulo" style="font-family:${GV_TITLE_FONT};font-size:15px;color:#2f5496"></b>
        <button id="evoDetCerrar" type="button" style="border:1px solid #d0d5db;background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:13px">✕</button>
      </div>
      <div id="evoDetCuerpo" style="overflow:auto;padding:14px 18px"></div>
    </div>
  </div>
  <div class="sub" style="margin:6px 0 0">Sigue el filtro Desde–Hasta (sin filtro: últimos 30 días). FOTO DIARIA DE EVENTOS: cada serie cuenta lo que ocurrió ese día — conversaciones que partieron e intenciones identificadas (por día de inicio del chat), precios mostrados (por el día en que se mostraron), formales por su día de EMISIÓN en Zoho, aceptadas por su día de ACEPTACIÓN y pagadas por su día de PAGO — cada hito cae en el día en que ocurrió, nunca en el de la emisión. NO es un embudo: las líneas pueden cruzarse (la formal de hoy puede venir de un chat de ayer). Hora de Chile. Las semanas parten lunes; el primer y último tramo pueden venir incompletos. Clic en la leyenda para ocultar/mostrar series, y <b>clic en cualquier punto para ver las filas que componen ese número</b>.</div>
  <script>
    (function () {
      var KEY_DASH = ${JSON.stringify(key)};
      var ZOHO_BASE = ${JSON.stringify(`${ZOHO_CRM_URL}/tab/${QUOTE_MODULE}`)};
      var DIAS = ${JSON.stringify(dias)};
      var SERIES = ${JSON.stringify(trazas.map((t) => ({ n: t.nombre, c: t.color, y: t.datos, det: t.det })))};
      var MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
      var LAYOUT = {
        margin: { l: 34, r: 12, t: 10, b: 46 },
        legend: { orientation: "h", y: 1.18 },
        font: { family: "Nunito, 'Segoe UI', sans-serif", size: 12, color: "#4e4e4e" },
        xaxis: { type: "category", tickangle: -45, fixedrange: true },
        yaxis: { rangemode: "tozero", gridcolor: "#eef0f3", fixedrange: true },
        plot_bgcolor: "#ffffff", paper_bgcolor: "#ffffff", hovermode: "x unified"
      };
      var CONFIG = { displayModeBar: false, responsive: true };
      function claveDe(d, modo) {
        if (modo === "mes") return MESES[parseInt(d.slice(5, 7), 10) - 1] + " " + d.slice(2, 4);
        if (modo === "semana") {
          var t = new Date(d + "T00:00:00Z");
          t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
          var i = t.toISOString();
          return "sem " + i.slice(8, 10) + "-" + i.slice(5, 7);
        }
        return d.slice(8, 10) + "-" + d.slice(5, 7);
      }
      var DET_VISIBLE = [], ETIQUETAS_X = [];
      // Ventana de DETALLE (Lalo 14-ago): al hacer clic en un punto se listan
      // las cotizaciones (o conversaciones) que componen ese número.
      // Las líneas se pegan cerca del eje y el clic cae en la serie vecina
      // (caso Lalo 14-ago: quería el 20 de canal ejecutivo y le abrió las 3
      // pagadas). Por eso la ventana trae TODAS las series de ese día como
      // botones: se entra por donde sea y se cambia sin cerrar.
      function chipsDetalleEvo(serieIdx, puntoIdx) {
        return SERIES.map(function (s, i) {
          var n = ((DET_VISIBLE[i] && DET_VISIBLE[i][puntoIdx]) || []).length;
          if (!n) return "";
          var act = i === serieIdx;
          return '<button type="button" data-serie="' + i + '" data-punto="' + puntoIdx + '" ' +
            'style="border:1px solid ' + (act ? s.c : "#d0d5db") + ';background:' + (act ? s.c : "#fff") +
            ';color:' + (act ? "#fff" : "#4e4e4e") + ';border-radius:99px;padding:3px 11px;margin:0 6px 6px 0;' +
            'cursor:pointer;font-family:inherit;font-size:12px;font-weight:700">' + s.n + ' · ' + n + '</button>';
        }).join("");
      }
      function abrirDetalleEvo(serieIdx, puntoIdx) {
        var s = SERIES[serieIdx];
        var filas = (DET_VISIBLE[serieIdx] && DET_VISIBLE[serieIdx][puntoIdx]) || [];
        var titulo = s.n + " · " + (ETIQUETAS_X[puntoIdx] || "") + " — " + filas.length + " registro" + (filas.length === 1 ? "" : "s");
        var esCotiz = filas.length > 0 && filas[0].o !== undefined;
        var cuerpo;
        if (!filas.length) {
          cuerpo = '<p class="sub" style="margin:0">Sin registros en este punto.</p>';
        } else if (esCotiz) {
          cuerpo = '<table><thead><tr><th>Cotización</th><th>Empresa</th><th>Dueño</th><th>Estado</th><th>Contacto</th></tr></thead><tbody>' +
            filas.map(function (f) {
              var link = f.id ? '<a href="' + ZOHO_BASE + '/' + f.id + '" target="_blank" rel="noopener">' + f.t + '</a>' : f.t;
              return '<tr><td style="white-space:nowrap">' + link + '</td><td>' + f.e + '</td><td>' + (f.o || "—") +
                '</td><td><span class="tag">' + (f.s || "—") + '</span></td><td style="white-space:nowrap">' + (f.d ? "+" + f.d : "—") + '</td></tr>';
            }).join("") + '</tbody></table>';
        } else {
          cuerpo = '<table><thead><tr><th>Contacto</th><th>Qué es</th><th></th></tr></thead><tbody>' +
            filas.map(function (f) {
              var ver = f.id ? '<a href="?key=' + KEY_DASH + '&conv=' + f.id + '" target="_blank" rel="noopener">ver conversación →</a>' : "";
              return '<tr><td style="white-space:nowrap">' + f.t + '</td><td>' + f.e + '</td><td>' + ver + '</td></tr>';
            }).join("") + '</tbody></table>';
        }
        document.getElementById("evoDetTitulo").textContent = titulo;
        document.getElementById("evoDetCuerpo").innerHTML =
          '<div style="margin:0 0 12px">' + chipsDetalleEvo(serieIdx, puntoIdx) + '</div>' + cuerpo;
        document.getElementById("evoDet").style.display = "flex";
      }
      document.getElementById("evoDetCuerpo").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-serie]");
        if (b) abrirDetalleEvo(Number(b.dataset.serie), Number(b.dataset.punto));
      });
      function cerrarDetalleEvo() { document.getElementById("evoDet").style.display = "none"; }
      document.getElementById("evoDetCerrar").addEventListener("click", cerrarDetalleEvo);
      document.getElementById("evoDetFondo").addEventListener("click", cerrarDetalleEvo);
      window.addEventListener("keydown", function (e) { if (e.key === "Escape") cerrarDetalleEvo(); });
      function pintar(modo) {
        var x = [], pos = {};
        DIAS.forEach(function (d) { var k = claveDe(d, modo); if (!(k in pos)) { pos[k] = x.length; x.push(k); } });
        var data = SERIES.map(function (s) {
          var y = x.map(function () { return 0; });
          DIAS.forEach(function (d, i) { y[pos[claveDe(d, modo)]] += s.y[i]; });
          return { x: x, y: y, name: s.n, type: "scatter", mode: "lines+markers", line: { color: s.c, width: 2 }, marker: { size: 5 } };
        });
        // DETALLE por punto agrupado: se acumulan las filas de los días que
        // caen en la misma columna (día, semana o mes).
        DET_VISIBLE = SERIES.map(function (s) {
          var celdas = x.map(function () { return []; });
          DIAS.forEach(function (d, i) {
            var filas = (s.det && s.det[i]) || [];
            if (filas.length) celdas[pos[claveDe(d, modo)]] = celdas[pos[claveDe(d, modo)]].concat(filas);
          });
          return celdas;
        });
        ETIQUETAS_X = x;
        Plotly.react("evoDiaria", data, LAYOUT, CONFIG).then(function () {
          var g = document.getElementById("evoDiaria");
          if (g.__drillOn) return;
          g.__drillOn = true;
          g.on("plotly_click", function (ev) {
            var p = ev.points && ev.points[0];
            if (!p) return;
            abrirDetalleEvo(p.curveNumber, p.pointIndex);
          });
        });
        document.querySelectorAll(".evoBtn").forEach(function (b) {
          var act = b.dataset.modo === modo;
          b.style.background = act ? "#ffbb00" : "#fff";
          b.style.color = act ? "#fff" : "#4e4e4e";
          b.style.borderColor = act ? "#ffbb00" : "#d0d5db";
        });
      }
      document.querySelectorAll(".evoBtn").forEach(function (b) {
        b.addEventListener("click", function () { pintar(this.dataset.modo); });
      });
      pintar("dia");
    })();
  </script>
</div>`
}

// ── Dashboard INBOUND DIARIO (pedido Rodrigo 13-ago) ────────────────────────
// "Vicky toma solo las de inbound": cuántas oportunidades inbound llegan cada
// día y hasta dónde ha llegado cada una. EMBUDO POR COHORTE, no foto diaria:
// todo se atribuye al día en que el contacto escribió por PRIMERA vez, aunque
// el hito (precio, formal, pago) haya ocurrido días después. Inbound = el
// cliente llegó solo por WhatsApp (sin toque 0 de la cadencia outbound).

/** Primera conversación por contacto (min started_at). PostgREST capa cada
 * request en 1000 filas → paginado ascendente hasta agotar (universo ~1.2k). */
/**
 * 🧲 LEADS DEL FORMULARIO DE LANDING (Lalo 21-ago, "quisiera que en el dash
 * también aparezca todo lead que llenó ese formulario"): todo lead con
 * Form_Vicky=Si (miniform de las landing CL/CO/MX), cruzado por teléfono
 * contra las conversaciones de Vicky — la brecha entre los que llenaron el
 * form y los que efectivamente llegaron a hablar. Los sin teléfono o con
 * teléfono no discable no pueden ser identificados al escribir: candidatos
 * directos al rescate. Best-effort: ante cualquier falla devuelve una
 * tarjeta de error, jamás tumba la vista inbound.
 */
type FilaFormVicky = {
  id?: string
  First_Name?: string
  Last_Name?: string
  Company?: string
  Phone?: string
  Email?: string
  Lead_Status?: string
  Owner?: { name?: string } | null
  Created_Time?: string
  Lead_Source?: string
  Territorio?: string
  Landing_Page?: string
  Campaign?: string
  Medium?: string
  DB_Source_2?: string
  _convertido?: boolean
}

/** Todos los leads del miniform (Form_Vicky=Si), internos ya filtrados.
 * Compartido por la columna "Form Vicky" del panel Bolsa y la tabla detalle. */
async function fetchLeadsFormVicky(): Promise<FilaFormVicky[]> {
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const filas: FilaFormVicky[] = []
  // Vivos por COQL. Los CONVERTIDOS son invisibles al COQL de Leads: van
  // por search aparte con converted=true (misma limitación de siempre).
  // v8 a propósito: el COQL v3 devuelve Owner sin expandir (la columna
  // Dueño salía "—" en los leads vivos — cazado 21-ago); v8 trae {name,id}.
  // PAGINADO (Lalo 27-ago): a ~9 fills/día los 200 de una página se agotan a
  // las 3 semanas y los días viejos del dash empezarían a descontar. Tope de
  // 10 páginas (2.000 leads) como backstop, no como límite esperado.
  for (let offset = 0; offset < 2000; offset += 200) {
    const rq = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, First_Name, Last_Name, Company, Phone, Email, Lead_Status, Owner, Created_Time, Lead_Source, Territorio, Landing_Page, Campaign, Medium, DB_Source_2 from Leads where Form_Vicky = 'Si' order by Created_Time desc limit 200 offset ${offset}`,
      }),
    })
    if (!rq.ok || rq.status === 204) break
    const d = (await rq.json().catch(() => ({}))) as { data?: FilaFormVicky[]; info?: { more_records?: boolean } }
    for (const f of d.data || []) filas.push(f)
    if (!d.info?.more_records || !(d.data || []).length) break
  }
  for (let page = 1; page <= 10; page++) {
    const rc = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${encodeURIComponent("(Form_Vicky:equals:Si)")}&converted=true&fields=id,First_Name,Last_Name,Company,Phone,Email,Lead_Status,Owner,Created_Time,Lead_Source,Territorio,Landing_Page,Campaign,Medium,DB_Source_2&per_page=200&page=${page}`,
      { headers: H, cache: "no-store" },
    )
    if (!rc.ok || rc.status === 204) break
    const d = (await rc.json().catch(() => ({}))) as { data?: FilaFormVicky[]; info?: { more_records?: boolean } }
    for (const f of d.data || []) filas.push({ ...f, _convertido: true })
    if (!d.info?.more_records || !(d.data || []).length) break
  }
  // Internos fuera (mismo criterio del resto del dash).
  const esInternoForm = (f: FilaFormVicky) => {
    const blob = `${f.First_Name || ""} ${f.Last_Name || ""} ${f.Company || ""} ${f.Email || ""}`.toLowerCase()
    return /prueba|test vicky|no llamar|geovictoria|pruebasmkt|huellerocompany/.test(blob)
  }
  return filas.filter((f) => f.id && !esInternoForm(f))
}

/** 📣 PESTAÑA CAMPAÑAS (Lalo 26-ago): resultados de cada campaña de
 * re-encantamiento — enviados, respuestas por botón y por texto, descuentos
 * aplicados y pagos posteriores al envío. Fuentes: vic_campanas (eventos),
 * vic_kv campana_dcto_* (estado por contacto), conversaciones (respuesta por
 * texto) y el registro de ventas (pagos). Todo best-effort: sin datos, la
 * tarjeta no aparece. */
async function renderCampanas(): Promise<string> {
  try {
    const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    const [rEv, rKv] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_campanas?select=contact,campana,evento,respuesta,at&limit=8000`, { headers: h, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.campana_dcto_*&select=key,value&limit=1000`, { headers: h, cache: "no-store" }),
    ])
    if (!rEv.ok) return ""
    const eventos = ((await rEv.json().catch(() => [])) as Array<{ contact: string; campana: string; evento: string; respuesta?: string; at?: string }>) || []
    const kvs = rKv.ok ? (((await rKv.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) : []
    if (!eventos.length) return ""
    type Agg = {
      enviados: Set<string>; si: Set<string>; no: Set<string>; aplicados: Set<string>
      ejecutivo: Set<string>; inicio: number; segmentos: Map<string, number>
      // Vía de la respuesta (Lalo 26-ago, "diferenciar botón y texto"): el
      // barrido de botones registra respuesta "si"/"si_ejecutivo"/"no"; las
      // clasificaciones de intención por TEXTO entran como "si_texto"/
      // "no_texto". Marcadores del vigía ("si_aplicado_vigia") suman al total
      // pero no definen vía: si el contacto no tiene evento de botón, es texto.
      siBoton: Set<string>; noBoton: Set<string>
      // Cascada de TOQUES (Lalo 27-ago): cada campaña son hasta 3 toques —
      // WhatsApp → correo → Dapta, en ese orden, y cada uno va SOLO a quienes
      // no respondieron el anterior. Evento 'enviado' = WhatsApp,
      // 'enviado_correo' y 'enviado_dapta' = los siguientes.
      toques: Map<string, { n: Set<string>; primerAt: number }>
      // Atribución POR CANAL (Lalo 27-ago, "que quede clara la diferenciación
      // de resultados por canal"): cada respuesta/pago se atribuye al ÚLTIMO
      // toque que ese contacto recibió antes de responder/pagar.
      envioAt: Map<string, Map<string, number>>
      respAt: Map<string, number>
    }
    const porCampana = new Map<string, Agg>()
    const agg = (c: string): Agg => {
      let a = porCampana.get(c)
      if (!a) { a = { enviados: new Set(), si: new Set(), no: new Set(), aplicados: new Set(), ejecutivo: new Set(), inicio: Number.MAX_SAFE_INTEGER, segmentos: new Map(), siBoton: new Set(), noBoton: new Set(), toques: new Map(), envioAt: new Map(), respAt: new Map() }; porCampana.set(c, a) }
      return a
    }
    const INTERNOS = new Set(["56944668823", "56978385048"])
    for (const e of eventos) {
      if (!e.campana || INTERNOS.has(digits(e.contact))) continue
      const a = agg(e.campana)
      const t = Date.parse(String(e.at || ""))
      if (Number.isFinite(t)) a.inicio = Math.min(a.inicio, t)
      if (e.evento === "enviado" || e.evento === "enviado_correo" || e.evento === "enviado_dapta") {
        if (e.evento === "enviado") a.enviados.add(e.contact)
        const tq = a.toques.get(e.evento) || { n: new Set<string>(), primerAt: Number.MAX_SAFE_INTEGER }
        tq.n.add(e.contact)
        if (Number.isFinite(t)) tq.primerAt = Math.min(tq.primerAt, t)
        a.toques.set(e.evento, tq)
        const ea = a.envioAt.get(e.evento) || new Map<string, number>()
        if (Number.isFinite(t) && !ea.has(e.contact)) ea.set(e.contact, t)
        a.envioAt.set(e.evento, ea)
      }
      if (e.evento === "respuesta") {
        const r = String(e.respuesta || "")
        if (Number.isFinite(t) && !a.respAt.has(e.contact)) a.respAt.set(e.contact, t)
        if (r.startsWith("no")) {
          a.no.add(e.contact)
          if (r === "no") a.noBoton.add(e.contact)
        } else if (r.startsWith("si")) {
          a.si.add(e.contact)
          // Botón = lo que registra el barrido de QUICK_REPLY (si / si_aplicado
          // / si_ejecutivo). "si_aplicado_vigia" NO define vía (el vigía repara
          // ambas): sin evento de botón, el contacto cuenta como texto.
          if (r === "si" || r === "si_aplicado" || r === "si_ejecutivo") a.siBoton.add(e.contact)
          if (r === "si_ejecutivo") a.ejecutivo.add(e.contact)
        }
      }
    }
    const contactosDe = new Map<string, string>()
    for (const fila of kvs) {
      try {
        const st = JSON.parse(fila.value) as { campana?: string; segmento?: string; pctAplicado?: number }
        const tel = fila.key.replace("campana_dcto_", "")
        if (!st.campana || INTERNOS.has(tel) || !porCampana.has(st.campana)) continue
        contactosDe.set(tel, st.campana)
        const a = agg(st.campana)
        if (st.pctAplicado) a.aplicados.add(tel)
        const seg = String(st.segmento || "?")
        a.segmentos.set(seg, (a.segmentos.get(seg) || 0) + 1)
      } catch { /* kv corrupto */ }
    }
    // Respondieron = sí + no (Lalo 26-ago, "sí y no deben sumar el total").
    // Toda respuesta por TEXTO se clasifica por intención y entra como evento
    // si_texto/no_texto (hoy: clasificación manual/IA; automatizarla es el
    // siguiente paso) — el conteo por last_user_at murió con la columna.
    // Pagos posteriores al envío, atribuidos por contacto de la campaña.
    const rVd = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.venta_dash_v3_*&select=key,value&limit=4000`, { headers: h, cache: "no-store" })
    const rPtr = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?select=contact,quote_id,empresa,updated_at&order=updated_at.asc&limit=8000`, { headers: h, cache: "no-store" })
    const pagos = new Map<string, { n: number; monto: number; quienes: string[] }>()
    // Empresa por contacto (para los tooltips): manda el puntero más reciente.
    const empresaDe = new Map<string, string>()
    if (rVd.ok && rPtr.ok) {
      const punteros = ((await rPtr.json().catch(() => [])) as Array<{ contact: string; quote_id: string; empresa?: string }>) || []
      const telDeQuote = new Map<string, string>()
      for (const pt of punteros) {
        telDeQuote.set(pt.quote_id, digits(pt.contact))
        if ((pt.empresa || "").trim()) empresaDe.set(digits(pt.contact), String(pt.empresa).trim())
      }
      const vds = ((await rVd.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
      for (const vd of vds) {
        try {
          const v = JSON.parse(vd.value) as { pagoIso?: string; montoClp?: number }
          const tel = telDeQuote.get(vd.key.replace("venta_dash_v3_", "")) || ""
          const camp = contactosDe.get(tel)
          if (!camp) continue
          const a = porCampana.get(camp)
          const t = Date.parse(String(v.pagoIso || ""))
          if (a && Number.isFinite(t) && t >= a.inicio) {
            const acc = pagos.get(camp) || { n: 0, monto: 0, quienes: [] }
            acc.n++; acc.monto += Number(v.montoClp || 0) || 0
            acc.quienes.push(`${tel}|${Number(v.montoClp || 0) || 0}|${t}`)
            pagos.set(camp, acc)
          }
        } catch { /* fila corrupta */ }
      }
    }
    // Tooltip al pasar el mouse (Lalo 27-ago): quién está detrás de cada
    // número — empresa, teléfono y ejecutivo a cargo (traspaso activo;
    // sin traspaso = Vicky), tope de 40 líneas.
    const ejecutivoDe = new Map<string, string>()
    try {
      const rPtv = await fetch(`${SUPABASE_URL}/rest/v1/vic_ptv?estado=eq.activo&select=contact,vendedor_nombre,vendedor_email&limit=5000`, { headers: h, cache: "no-store" })
      for (const f of ((await rPtv.json().catch(() => [])) as Array<{ contact: string; vendedor_nombre?: string; vendedor_email?: string }>) || []) {
        const nombre = (f.vendedor_nombre || "").trim() || (f.vendedor_email || "").split("@")[0]
        if (nombre) ejecutivoDe.set(digits(f.contact), nombre)
      }
    } catch { /* sin ptv: todos salen como Vicky */ }
    const lineaDe = (c: string): string =>
      `${empresaDe.get(digits(c)) || "—"} · +${digits(c)} · ${ejecutivoDe.get(digits(c)) || "Vicky"}`
    const tip = (tels: Iterable<string>): string => {
      const lineas = [...tels].map(lineaDe)
      const corte = lineas.slice(0, 40)
      if (lineas.length > corte.length) corte.push(`… y ${lineas.length - corte.length} más`)
      return esc(corte.join("\n"))
    }
    const SEG_ETQ: Record<string, string> = { "1": "vio precio", "2": "formal", "3": "aceptada" }
    const filas = [...porCampana.entries()]
      .filter(([, a]) => a.enviados.size > 0)
      .sort((x, y) => y[1].inicio - x[1].inicio)
      .map(([nombre, a]) => {
        // Intención FINAL manda: un "no" seguido de "sí" (misclick del botón,
        // caso Alan 26-ago) no cuenta como no.
        for (const c of a.si) { a.no.delete(c); a.noBoton.delete(c) }
        const env = a.enviados.size
        const respondieron = new Set([...a.si, ...a.no])
        const respTotal = respondieron.size
        const pg = pagos.get(nombre) || { n: 0, monto: 0, quienes: [] as string[] }
        const segTxt = [...a.segmentos.entries()].sort().map(([k, v]) => `${SEG_ETQ[k] || k}: ${v}`).join(" · ")
        const fechaDe = (ms: number) =>
          new Date(ms).toLocaleDateString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit" })
        const ORDEN_TOQUES: Array<{ ev: string; etq: string }> = [
          { ev: "enviado", etq: "📱 WhatsApp" },
          { ev: "enviado_correo", etq: "✉️ Correo" },
          { ev: "enviado_dapta", etq: "📞 Dapta" },
        ]
        // ATRIBUCIÓN POR CANAL (Lalo 27-ago): una respuesta o pago pertenece
        // al ÚLTIMO toque que ese contacto recibió antes de ese instante.
        const toqueDe = (contact: string, instante: number): string => {
          let mejor = ""
          let mejorAt = -1
          for (const { ev } of ORDEN_TOQUES) {
            const at = a.envioAt.get(ev)?.get(contact)
            if (at !== undefined && at <= instante && at > mejorAt) { mejor = ev; mejorAt = at }
          }
          if (!mejor) for (const { ev } of ORDEN_TOQUES) if (a.envioAt.get(ev)?.has(contact)) return ev
          return mejor || "enviado"
        }
        const pagoFila = (q: string) => { const [t2, m] = q.split("|"); return `${lineaDe(t2)} · $${Number(m).toLocaleString("es-CL")}` }
        // Fila TOTAL de la campaña + una sub-fila por toque con SUS resultados.
        let base = a.enviados
        const subFilas = ORDEN_TOQUES.map(({ ev, etq }) => {
          const tq = a.toques.get(ev)
          if (!tq || !tq.n.size) {
            const sinResp = [...base].filter((c) => !respondieron.has(c))
            return `<tr><td style="padding-left:26px"><span class="sub">${etq} · pendiente</span></td>
            <td style="text-align:center"><span class="sub" title="${tip(sinResp)}" style="cursor:help">irá a ${sinResp.length}</span></td><td colspan="5"></td></tr>`
          }
          base = tq.n
          const instanteDe = (c: string) => a.respAt.get(c) ?? Number.MAX_SAFE_INTEGER
          const siT = [...a.si].filter((c) => toqueDe(c, instanteDe(c)) === ev)
          const noT = [...a.no].filter((c) => toqueDe(c, instanteDe(c)) === ev)
          const respT = [...new Set([...siT, ...noT])]
          const aplT = [...a.aplicados].filter((c) => toqueDe(c, instanteDe(c)) === ev)
          const pagosT = pg.quienes.filter((q) => { const partes = q.split("|"); return toqueDe(partes[0], Number(partes[2]) || Number.MAX_SAFE_INTEGER) === ev })
          const montoT = pagosT.reduce((acc, q) => acc + (Number(q.split("|")[1]) || 0), 0)
          const pctT = tq.n.size ? `${Math.round((respT.length / tq.n.size) * 100)}%` : "—"
          return `<tr><td style="padding-left:26px">${etq} · ${fechaDe(tq.primerAt)}</td>
          <td style="text-align:center"><span title="${tip(tq.n)}" style="cursor:help">${tq.n.size}</span></td>
          <td style="text-align:center"><span title="${tip(respT)}" style="cursor:help">${respT.length}</span> <span class="pct">(${pctT})</span></td>
          <td style="text-align:center;color:#15803d"><span title="${tip(siT)}" style="cursor:help">${siT.length}</span></td>
          <td style="text-align:center;color:#b45309"><span title="${tip(noT)}" style="cursor:help">${noT.length}</span></td>
          <td style="text-align:center"><span title="${tip(aplT)}" style="cursor:help">${aplT.length}</span></td>
          <td style="text-align:center">${pagosT.length ? `<span title="${esc(pagosT.map(pagoFila).join("\n"))}" style="cursor:help">${pagosT.length}</span> · $${montoT.toLocaleString("es-CL")}` : "0"}</td></tr>`
        })
        const pct = (n: number) => (env ? `${Math.round((n / env) * 100)}%` : "—")
        const filaTotal = `<tr style="background:#f8fafc"><td><b>${esc(nombre)}</b><div class="sub" style="margin:2px 0 0">${esc(segTxt)}</div></td>
        <td style="text-align:center"><b title="${tip(a.enviados)}" style="cursor:help">${env}</b></td>
        <td style="text-align:center"><b title="${tip(respondieron)}" style="cursor:help">${respTotal}</b> <span class="pct">(${pct(respTotal)})</span></td>
        <td style="text-align:center;color:#15803d"><b title="${tip(a.si)}" style="cursor:help">${a.si.size}</b><div class="sub" style="margin:2px 0 0">${a.siBoton.size} botón · ${a.si.size - a.siBoton.size} texto</div></td>
        <td style="text-align:center;color:#b45309"><b title="${tip(a.no)}" style="cursor:help">${a.no.size}</b>${a.no.size ? `<div class="sub" style="margin:2px 0 0">${a.noBoton.size} botón · ${a.no.size - a.noBoton.size} texto</div>` : ""}</td>
        <td style="text-align:center"><b title="${tip(a.aplicados)}" style="cursor:help">${a.aplicados.size}</b></td>
        <td style="text-align:center">${pg.n ? `<b title="${esc(pg.quienes.map(pagoFila).join("\n"))}" style="cursor:help">${pg.n}</b> · $${pg.monto.toLocaleString("es-CL")}` : "0"}</td></tr>`
        return filaTotal + subFilas.join("")
      })
    if (!filas.length) return ""
    return `<div class="card" id="campanas"><h2>📣 Campañas de re-encantamiento</h2>
  <div class="sub" style="margin:2px 0 10px">Resultados por campaña: respuestas por botón y por texto, descuentos aplicados automáticos y pagos POSTERIORES al envío. Cada campaña son hasta 3 toques en cascada — WhatsApp → correo → Dapta — y cada toque va SOLO a quienes no respondieron el anterior. Los contactos internos de prueba quedan fuera. Reglas: máximo 2 campañas por cliente; entra solo quien lleva 48 horas hábiles sin actividad (ni con Vicky ni con un ejecutivo).</div>
  <div style="overflow-x:auto"><table><thead><tr><th>Campaña · segmentos</th><th>Enviados</th><th>Respondieron</th><th>Sí al descuento</th><th>No</th><th>Dcto aplicado</th><th>Pagos post-envío</th></tr></thead>
  <tbody>${filas.join("")}</tbody></table></div></div>`
  } catch (e) {
    console.warn("[funnel] renderCampanas falló:", e instanceof Error ? e.message : e)
    return ""
  }
}

/**
 * 🪞 MONITOREO DE WHATSAPP ESPEJO (Lalo 27-ago): listado de todos los
 * usuarios ACTIVOS de Zoho con perfil Ejecutivo Comercial o Telemarketing,
 * con el estado de su sesión de espejo (Conectado/Desconectado, según la
 * señal que publica el worker en vic_kv wa_espejo_status_<sesión>), filtros
 * por perfil y estado, y la URL del QR de cada uno lista para compartir
 * (token por sesión en vic_kv espejo_link_<sesión>; si no existe, se genera
 * aquí mismo — el link abre SOLO la página del QR de esa sesión).
 */
async function renderEspejos(qsBase: string, soloDe?: string): Promise<string> {
  // soloDe (Lalo 27-ago): un EJECUTIVO logueado ve SOLO su propio espejo —
  // su estado y su link del QR — sin la lista del resto del equipo.
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase()
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  const PERFILES = new Set(["Ejecutivo Comercial", "Telemarketing"])
  type UsuarioFila = { nombre: string; email: string; perfil: string; sesion: string }
  const usuarios: UsuarioFila[] = []
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/users?type=ActiveUsers&per_page=100&page=${page}`, { headers: H, cache: "no-store" })
    if (!r.ok || r.status === 204) break
    const cuerpo = (await r.json().catch(() => null)) as {
      users?: Array<{ full_name?: string; email?: string; profile?: { name?: string } | null }>
      info?: { more_records?: boolean }
    } | null
    for (const u of cuerpo?.users || []) {
      const perfil = String(u.profile?.name || "")
      const email = String(u.email || "").toLowerCase()
      if (!PERFILES.has(perfil) || !email) continue
      usuarios.push({ nombre: String(u.full_name || email), email, perfil, sesion: email.split("@")[0] })
    }
    if (!cuerpo?.info?.more_records) break
  }
  usuarios.sort((a, b) => a.perfil.localeCompare(b.perfil) || a.nombre.localeCompare(b.nombre))
  let usuariosVista = usuarios
  if (soloDe) {
    usuariosVista = usuarios.filter(
      (u) => norm(u.nombre) === norm(soloDe) || u.email === soloDe.toLowerCase() || u.sesion === norm(soloDe),
    )
    if (!usuariosVista.length) {
      return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Espejo WhatsApp</title></head>
      <body style="font-family:system-ui;max-width:520px;margin:60px auto;text-align:center;color:#2d3748">
      <h2>🪞 Tu espejo de WhatsApp</h2><p>No encontramos tu usuario en el listado de espejos (sesión: ${esc(soloDe)}). Avísale a administración para configurarlo.</p>
      <p><a href="?${qsBase}" style="color:#0284c7">← volver al dash</a></p></body></html>`
    }
  }
  // Estado del worker y tokens de link, en dos lecturas batch de vic_kv.
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const leerKvs = async (patron: string): Promise<Map<string, string>> => {
    const m = new Map<string, string>()
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.${patron}*&select=key,value&limit=1000`, { headers: hSb, cache: "no-store" })
      for (const f of ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) m.set(f.key, f.value)
    } catch { /* sin kv: columnas quedan vacías */ }
    return m
  }
  const [estados, links] = await Promise.all([leerKvs("wa_espejo_status_"), leerKvs("espejo_link_")])
  // Token de link faltante → se genera acá mismo (el link es solo-QR).
  const { randomBytes } = await import("crypto")
  for (const u of usuariosVista) {
    if (links.has(`espejo_link_${u.sesion}`)) continue
    const t = randomBytes(8).toString("hex")
    links.set(`espejo_link_${u.sesion}`, t)
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...hSb, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: `espejo_link_${u.sesion}`, value: t }),
      cache: "no-store",
    }).catch(() => {})
  }
  const filas = usuariosVista.map((u) => {
    let estado = "desconectado"
    let detalle = "sin sesión en el worker"
    try {
      const st = JSON.parse(estados.get(`wa_espejo_status_${u.sesion}`) || "{}") as { estado?: string; numero?: string; at?: string }
      if (st.estado) {
        estado = st.estado === "conectado" ? "conectado" : "desconectado"
        detalle = [st.estado !== "conectado" ? st.estado : "", st.numero ? `+${st.numero}` : "", st.at ? new Date(st.at).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""]
          .filter(Boolean).join(" · ")
      }
    } catch { /* sin señal */ }
    const urlQr = `/api/vic-admin-wa-espejo?session=${encodeURIComponent(u.sesion)}&t=${encodeURIComponent(links.get(`espejo_link_${u.sesion}`) || "")}`
    return `<tr data-perfil="${esc(u.perfil)}" data-estado="${estado}">
    <td><b>${esc(u.nombre)}</b><div class="sub">${esc(u.email)}</div></td>
    <td>${esc(u.perfil)}</td>
    <td>${estado === "conectado" ? '<span style="color:#15803d;font-weight:700">✅ Conectado</span>' : '<span style="color:#b91c1c;font-weight:700">⛔ Desconectado</span>'}<div class="sub">${esc(detalle)}</div></td>
    <td><a href="${urlQr}" target="_blank" rel="noopener">abrir QR</a> · <a href="#" onclick="navigator.clipboard.writeText(location.origin+'${urlQr}');this.textContent='copiado ✓';return false">copiar link</a></td></tr>`
  })
  const conectados = usuariosVista.filter((u) => {
    try { return (JSON.parse(estados.get(`wa_espejo_status_${u.sesion}`) || "{}") as { estado?: string }).estado === "conectado" } catch { return false }
  }).length
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Espejos WhatsApp</title>
  <style>
    body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f8fa;color:#2d3748}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:8px 8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    a{color:#0284c7;text-decoration:none}
    .sub{color:#8a949c;font-size:12px}
    tr:hover td{background:#f8fbfd}
    select{padding:6px 10px;border:1px solid #d7dde3;border-radius:8px;font-size:13px}
  </style></head><body><div class="wrap">
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap"><img src="/gv/logo-full-color.svg" style="height:28px" alt=""><h1 style="margin:0;font-size:20px">🪞 Espejos de WhatsApp</h1>
  <a class="sub" href="?${qsBase}">← volver al dash</a></div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      ${soloDe ? `<b>Tu espejo de WhatsApp</b>` : `<b>${conectados} conectados de ${usuariosVista.length}</b>
      <label class="sub">Perfil: <select id="fPerfil" onchange="filtra()"><option value="">todos</option><option>Ejecutivo Comercial</option><option>Telemarketing</option></select></label>
      <label class="sub">Estado: <select id="fEstado" onchange="filtra()"><option value="">todos</option><option value="conectado">Conectado</option><option value="desconectado">Desconectado</option></select></label>`}
    </div>
    <p class="sub" style="margin:8px 0 10px">${soloDe
      ? "Con tu espejo conectado, tus chats y llamadas por WhatsApp cuentan como gestión tuya: sacan a tus clientes de las campañas automáticas y quedan espejados en el deal. Si sale Desconectado, abre el link del QR y escanéalo desde tu WhatsApp Business (Dispositivos vinculados → Vincular dispositivo)."
      : 'El link del QR es individual por persona y se puede compartir directo con ella: abre SOLO su página de vinculación (WhatsApp Business → Dispositivos vinculados → escanear). El estado lo publica el worker del espejo; "sin sesión en el worker" = falta agregar esa persona a WA_SESSION_IDS en Railway.'}</p>
    <div style="overflow-x:auto"><table id="tEsp"><thead><tr><th>Persona</th><th>Perfil</th><th>Estado</th><th>Link del QR</th></tr></thead>
    <tbody>${filas.join("")}</tbody></table></div>
  </div>
  <script>function filtra(){var p=document.getElementById('fPerfil').value,e=document.getElementById('fEstado').value;document.querySelectorAll('#tEsp tbody tr').forEach(function(tr){var ok=(!p||tr.getAttribute('data-perfil')===p)&&(!e||tr.getAttribute('data-estado')===e);tr.style.display=ok?'':'none'})}</script>
  </div></body></html>`
}

/**
 * 📣 PANEL DE CAMPAÑAS para el EQUIPO (Lalo 27-ago): página autocontenida con
 * (1) los resultados por campaña con la cascada de toques y (2) el listado de
 * CANDIDATOS a la próxima ola — actualizable bajo demanda y filtrable por
 * ejecutivo comercial. Vive en el dash antiguo porque lo consumen ejecutivos
 * con su login (regla de los dos mundos, 21-ago).
 */
async function renderPanelCampanas(quien: string, qsBase: string, recalcular: boolean): Promise<string> {
  const { leerFotoCandidatos, recalcularCandidatosCampana, proximasCampanas, mananaHayToque } = await import("@/lib/campana-candidatos")
  let errorRecalc = ""
  let foto = null as Awaited<ReturnType<typeof leerFotoCandidatos>>
  if (recalcular) {
    try {
      foto = await recalcularCandidatosCampana()
    } catch (e) {
      errorRecalc = e instanceof Error ? e.message : String(e)
      foto = await leerFotoCandidatos()
    }
  } else {
    foto = await leerFotoCandidatos()
  }
  const resultados = await renderCampanas()
  const MOTIVOS: Record<string, string> = {
    cliente_activo_con_vicky: "activo con Vicky",
    gestion_ejecutivo_espejo: "gestión del ejecutivo (chat/llamada)",
    nota_humana_en_deal: "gestión del ejecutivo (nota en el deal)",
    cliente_existente: "cliente facturando",
    tope_2_campanas: "ya recibió 2 campañas",
    interno: "contacto interno",
  }
  const ejecutivos = [...new Set((foto?.aptos || []).map((c) => c.ejecutivo).filter(Boolean))].sort()
  const filaCand = (c: NonNullable<typeof foto>["aptos"][number]) =>
    `<tr data-ejec="${esc(c.ejecutivo)}"><td>${esc(c.empresa || "—")}</td><td>${esc(c.cot)}</td><td>${esc(c.estado)}</td><td>${esc(c.fechaCot)}</td>
     <td><a href="https://wa.me/${esc(c.contact)}" target="_blank" rel="noopener">+${esc(c.contact)}</a></td><td>${esc(c.ejecutivo)}</td>${c.motivoExclusion ? `<td>${esc(MOTIVOS[c.motivoExclusion] || c.motivoExclusion)}</td>` : ""}</tr>`
  const porMotivo = new Map<string, number>()
  for (const e of foto?.excluidos || []) porMotivo.set(e.motivoExclusion || "?", (porMotivo.get(e.motivoExclusion || "?") || 0) + 1)
  const chipsExcl = [...porMotivo.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<span style="display:inline-block;padding:5px 12px;border-radius:10px;background:#fdf2f2;font-weight:600">${esc(MOTIVOS[m] || m)}: ${n}</span>`)
    .join(" ")
  const edadMin = foto ? Math.max(0, Math.round((Date.now() - Date.parse(foto.generadoAt)) / 60000)) : null
  // Calendario (Lalo 27-ago): la sección muestra las PRÓXIMAS campañas con la
  // fecha de sus 3 toques; los candidatos van como TOTAL, y el listado con
  // nombres solo se publica el día previo a cada toque.
  const proximas = proximasCampanas(undefined, 2)
  const listaVisible = mananaHayToque()
  const fechaCorta = (ymd: string) => {
    const d = new Date(`${ymd}T12:00:00Z`)
    return d.toLocaleDateString("es-CL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })
  }
  const diaAntes = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  // El TOTAL lleva la misma viñeta al pasar el mouse que el resto del panel:
  // empresa, teléfono y ejecutivo de cada candidato (tope 40 líneas).
  const tipTotal = (() => {
    if (!foto) return ""
    const lineas = foto.aptos.map((c) => `${c.empresa || "—"} · +${c.contact} · ${c.ejecutivo}`)
    const corte = lineas.slice(0, 40)
    if (lineas.length > corte.length) corte.push(`… y ${lineas.length - corte.length} más`)
    return esc(corte.join("\n"))
  })()
  const fechaLarga = (ymd: string) => {
    const d = new Date(`${ymd}T12:00:00Z`)
    const txt = d.toLocaleDateString("es-CL", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })
    return txt.charAt(0).toUpperCase() + txt.slice(1)
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campañas Vicky</title>
  <style>
    body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f8fa;color:#2d3748}
    .wrap{max-width:1280px;margin:0 auto;padding:18px}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:8px 8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    a{color:#0284c7;text-decoration:none}
    .sub{color:#8a949c;font-size:12px}
    .pct{color:#8a949c;font-size:12px}
    h2{margin:0 0 6px;font-size:16px}
    tr:hover td{background:#f8fbfd}
    .btn{display:inline-block;padding:7px 14px;border-radius:9px;background:#00aff2;color:#fff;font-weight:700;font-size:13px}
    select{padding:6px 10px;border:1px solid #d7dde3;border-radius:8px;font-size:13px}
  </style></head><body><div class="wrap">
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap"><img src="/gv/logo-full-color.svg" style="height:28px" alt=""><h1 style="margin:0;font-size:20px">📣 Campañas de re-encantamiento</h1>
  <a class="sub" href="?${qsBase}">← volver al dash</a></div>
  ${resultados || '<div class="card sub">Aún no hay campañas enviadas.</div>'}
  <div class="card">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">📅 Próximas campañas</h2>
      ${listaVisible && foto ? `<span class="sub">candidatos: foto de hace ${edadMin} min</span>` : ""}
      ${listaVisible ? `<a class="btn" href="?${qsBase}&vista=campanas&recalcular=1">⟳ Actualizar candidatos</a>` : ""}
    </div>
    <div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>Campaña</th><th>📱 WhatsApp</th><th>✉️ Correo</th><th>📞 Dapta</th><th>Candidatos</th></tr></thead>
    <tbody>${proximas.map((c, i) => `<tr><td><b>${fechaLarga(c.inicio)}</b></td>${c.toques.map((t) => `<td style="text-align:center">${fechaCorta(t.fecha)}</td>`).join("")}
      <td style="text-align:center">${i === 0 && listaVisible && foto ? `<b title="${tipTotal}" style="cursor:help">${foto.aptos.length}</b> <span class="pct">(+ ${foto.excluidos.length} excluidos)</span>` : `<span class="sub">se publica el ${fechaCorta(diaAntes(c.inicio))}</span>`}</td></tr>`).join("")}</tbody></table></div>
    <p class="sub" style="margin:10px 0 0">Cada campaña son 3 toques en cascada y cada toque va solo a quienes no respondieron el anterior. Candidato = cotización formal sin pagar cuyo contacto lleva 48 horas hábiles sin actividad de nadie (ni Vicky ni un ejecutivo por chat, llamada o nota). El listado DETALLADO con nombres se publica el día previo a cada toque — si un cliente suyo aparece, con una nota al deal o un chat por su WhatsApp espejado queda fuera en el próximo recálculo.</p>
    ${errorRecalc ? `<p class="sub" style="color:#b91c1c">La actualización falló (${esc(errorRecalc)}) — se muestra la última foto disponible.</p>` : ""}
    ${listaVisible && foto ? `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px">
      <h2 style="margin:0">Listado de candidatos (${foto.aptos.length})</h2>
      <label class="sub">Ejecutivo: <select id="fEjec" onchange="filtraEjec()"><option value="">todos</option>${ejecutivos.map((e) => `<option>${esc(e)}</option>`).join("")}</select></label>
    </div>
    <div style="overflow-x:auto;margin-top:8px"><table id="tCand"><thead><tr><th>Empresa</th><th>COT</th><th>Estado</th><th>Emitida</th><th>WhatsApp</th><th>Ejecutivo</th></tr></thead>
    <tbody>${foto.aptos.map(filaCand).join("")}</tbody></table></div>
    <details style="margin-top:12px"><summary class="sub" style="cursor:pointer">Excluidos (${foto.excluidos.length}) — ${chipsExcl || "ninguno"}</summary>
    <div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>Empresa</th><th>COT</th><th>Estado</th><th>Emitida</th><th>WhatsApp</th><th>Ejecutivo</th><th>Motivo</th></tr></thead>
    <tbody>${foto.excluidos.map(filaCand).join("")}</tbody></table></div></details>`
      : `<p class="sub" style="margin:8px 0 0">📋 El número de candidatos y el listado detallado (con empresa, teléfono y ejecutivo) se publican el día previo a cada campaña${proximas.length ? ` — la próxima parte el ${fechaLarga(proximas[0].inicio)}, así que aparecerán el ${fechaLarga(diaAntes(proximas[0].inicio))}` : ""}.</p>`}
  </div>
  ${quien && quien !== "Administrador" ? `<p class="sub">Sesión: ${esc(quien)}</p>` : ""}
  <script>function filtraEjec(){var v=document.getElementById('fEjec').value;document.querySelectorAll('#tCand tbody tr').forEach(function(tr){tr.style.display=!v||tr.getAttribute('data-ejec')===v?'':'none'})}</script>
  </div></body></html>`
}

async function renderFormLanding(primeraVez: Map<string, string>, visibles: FilaFormVicky[]): Promise<string> {
  try {
    visibles.sort((a, b) => Date.parse(String(b.Created_Time || "")) - Date.parse(String(a.Created_Time || "")))
    // Contadores por categoría, y los mismos cortados por PAÍS y por
    // PROPIETARIO (Lalo 21-ago, "sepáralos por país y otra tabla por
    // propietario"). Sin teléfono, el país sale del Territorio del lead.
    type Cnt = { total: number; conv: number; ya: number; sin: number; sinTel: number; malo: number }
    const nuevoCnt = (): Cnt => ({ total: 0, conv: 0, ya: 0, sin: 0, sinTel: 0, malo: 0 })
    const totalCnt = nuevoCnt()
    const porPais = new Map<string, Cnt>()
    const porDueno = new Map<string, Cnt>()
    // Por FUENTE (Lalo 21-ago): el form vive en landings de campaña Y en el
    // sitio web — Lead_Source separa Google Ads (campaña) de SEO/Direct.
    const porFuente = new Map<string, Cnt>()
    // Para el complemento "botón directo": teléfonos que SÍ pasaron por el
    // form y la fecha del lead más antiguo visible (inicio del período).
    const telsForm = new Set<string>()
    let desdeMs = Number.POSITIVE_INFINITY
    const filasHtml: string[] = []
    for (const f of visibles) {
      let tel = digits(String(f.Phone || ""))
      // PREFIJO DUPLICADO del form (caso Maximiliano 21-ago, "+5656954367033"):
      // el formulario antepone el código de país aunque el usuario ya lo haya
      // puesto — se colapsa para que el cruce calce con el WhatsApp real.
      if (/^(56|57|52|51)\1\d{8,12}$/.test(tel)) tel = tel.slice(2)
      const telOk = /^(56|57|52|51)\d{8,12}$/.test(tel)
      const creadoMs = Date.parse(String(f.Created_Time || ""))
      if (telOk) telsForm.add(tel)
      if (Number.isFinite(creadoMs) && creadoMs < desdeMs) desdeMs = creadoMs
      const convIso = telOk ? primeraVez.get(tel) : undefined
      const terr = String(f.Territorio || "").trim().toLowerCase()
      const pais = telOk
        ? tel.startsWith("56") ? "🇨🇱 Chile" : tel.startsWith("57") ? "🇨🇴 Colombia" : tel.startsWith("52") ? "🇲🇽 México" : "🇵🇪 Perú"
        : terr === "chile" ? "🇨🇱 Chile" : terr === "colombia" ? "🇨🇴 Colombia" : terr === "méxico" || terr === "mexico" ? "🇲🇽 México" : terr === "perú" || terr === "peru" ? "🇵🇪 Perú" : terr ? terr : "país s/d"
      const dueno = f.Owner?.name || "—"
      let cat: keyof Omit<Cnt, "total">
      let estado: string
      if (!f.Phone) {
        cat = "sinTel"
        estado = `<span style="color:#b45309">⚠️ sin teléfono</span>`
      } else if (!telOk) {
        cat = "malo"
        estado = `<span style="color:#b91c1c">✖ teléfono inválido</span>`
      } else if (convIso) {
        const antes = Number.isFinite(creadoMs) && Date.parse(convIso) < creadoMs - 3600e3
        cat = antes ? "ya" : "conv"
        estado = `<span style="color:#15803d">💬 ${antes ? "ya conversaba" : "conversó"} · ${fmtSantiago(convIso)}</span>`
      } else {
        cat = "sin"
        const horas = Number.isFinite(creadoMs) ? Math.floor((Date.now() - creadoMs) / 3600e3) : 0
        estado = `<span style="color:#b45309">⏳ sin conversación (${horas} h)</span>`
      }
      const fuente = (f.Lead_Source || "—").trim() || "—"
      for (const c of [
        totalCnt,
        porPais.get(pais) || porPais.set(pais, nuevoCnt()).get(pais)!,
        porDueno.get(dueno) || porDueno.set(dueno, nuevoCnt()).get(dueno)!,
        porFuente.get(fuente) || porFuente.set(fuente, nuevoCnt()).get(fuente)!,
      ]) {
        c.total++
        c[cat]++
      }
      const nombre = `${f.First_Name || ""} ${f.Last_Name || ""}`.trim() || "—"
      const zurl = `https://crm.zoho.com/crm/org685875245/tab/Leads/${f.id}`
      filasHtml.push(
        `<tr><td>${fmtSantiago(String(f.Created_Time || ""))}</td><td><a href="${zurl}" target="_blank" rel="noopener">${nombre}</a></td>` +
          `<td>${f.Company || "—"}</td><td>${pais.split(" ")[0]}</td><td>${tel ? `+${tel}` : f.Phone || "—"}</td><td>${f.Email || "—"}</td>` +
          `<td>${estado}</td><td>${f.Lead_Status || "—"}${f._convertido ? " · convertido" : ""}</td><td>${dueno}</td><td>${f.Lead_Source || "—"}</td></tr>`,
      )
    }
    // BOTÓN DIRECTO SIN ATRIBUCIÓN (Lalo 26-ago, "cuántas inició Vicky por
    // Google Ads vs orgánico"): el corte por Fuente atribuye SOLO a quienes
    // pasaron por el form; el resto de las conversaciones nacidas en el mismo
    // período llegaron por el botón de WhatsApp directo (hoy sin atribución
    // Ads/SEO — para atribuirlas haría falta un wa.me distinto por canal).
    let botonDirecto = 0
    if (Number.isFinite(desdeMs)) {
      for (const [telConv, iso] of primeraVez) {
        if (!/^(56|57|52|51)\d{8,12}$/.test(telConv) || telsForm.has(telConv)) continue
        const t = Date.parse(iso)
        if (Number.isFinite(t) && t >= desdeMs) botonDirecto++
      }
    }
    const chips =
      `<span class="sub">Total ${totalCnt.total}</span> · <span style="color:#15803d">💬 conversó ${totalCnt.conv}</span>` +
      (totalCnt.ya ? ` · <span style="color:#15803d">ya conversaba ${totalCnt.ya}</span>` : "") +
      ` · <span style="color:#b45309">⏳ sin conversación ${totalCnt.sin}</span> · <span style="color:#b45309">⚠️ sin teléfono ${totalCnt.sinTel}</span>` +
      (totalCnt.malo ? ` · <span style="color:#b91c1c">✖ teléfono inválido ${totalCnt.malo}</span>` : "") +
      ` · <span style="color:#475569">📲 botón directo sin form: ${botonDirecto} conversaciones en el mismo período (sin atribución)</span>`
    // Tablas resumen: mismas columnas, un corte por país y otro por dueño.
    const tablaResumen = (titulo: string, mapa: Map<string, Cnt>): string => {
      const filasR = [...mapa.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(
          ([k, c]) =>
            `<tr><td>${k}</td><td>${c.total}</td><td>${c.conv}</td><td>${c.ya || ""}</td><td>${c.sin}</td><td>${c.sinTel}</td><td>${c.malo || ""}</td></tr>`,
        )
        .join("")
      return (
        `<div style="overflow-x:auto;flex:1;min-width:320px"><table><tr><th>${titulo}</th><th>Total</th><th>💬 conversó</th><th>ya conversaba</th><th>⏳ sin conv.</th><th>⚠️ sin tel.</th><th>✖ tel. inválido</th></tr>` +
        filasR +
        `</table></div>`
      )
    }
    return (
      `<div class="card" id="formlanding"><h2>🧲 Formulario de landing (Form_Vicky)</h2>` +
      `<p class="sub">Todos los leads que llenaron el miniform de las landing, cruzados por teléfono contra las conversaciones de Vicky. ${chips}</p>` +
      `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">${tablaResumen("País", porPais)}${tablaResumen("Propietario", porDueno)}${tablaResumen("Fuente", porFuente)}</div>` +
      `<div style="overflow-x:auto"><table><tr><th>Llenó el form</th><th>Nombre</th><th>Empresa</th><th></th><th>Teléfono</th><th>Correo</th><th>Conversación con Vicky</th><th>Status Zoho</th><th>Dueño</th><th>Fuente</th></tr>` +
      filasHtml.join("") +
      `</table></div></div>`
    )
  } catch (e) {
    console.warn("[vic-funnel] form landing falló:", e instanceof Error ? e.message : e)
    return `<div class="card"><h2>🧲 Formulario de landing</h2><p class="sub">No se pudo consultar Zoho en este momento.</p></div>`
  }
}

/**
 * 📋 CARTERA DE COTIZACIONES VICKY (Lalo 21-ago): vista GLOBAL por estado —
 * no por día — de las cotizaciones del canal Vicky, con responsable actual y
 * PRÓXIMO PASO recomendado por fila. Es el dash de gestión del equipo para
 * trabajar la cosecha post-formal (el gap detectado 21-ago: los ejecutivos
 * cierran a días 2-8 con llamadas; las formales de Vicky nadie las trabaja).
 * El cierre perdido automático corre a los 14 días (compromiso de Lalo con
 * el equipo) — la columna de urgencia cuenta contra ese plazo.
 */
async function renderCartera(quien: string, qsBase: string): Promise<string> {
  type Cot = {
    id?: string
    Numero_Cotizacion?: string
    Name?: string
    Estado_Cotizacion?: string
    Intervenci_n_Humana?: string
    Owner?: { name?: string } | null
    Tel_fono_Contacto?: string
    Email_Contacto?: string
    Created_Time?: string
    Modified_Time?: string
    Deal_Asociado?: { id?: string; name?: string } | null
  }
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const desde = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10)
  const cots: Cot[] = []
  for (const offset of [0, 200]) {
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, Numero_Cotizacion, Name, Estado_Cotizacion, Intervenci_n_Humana, Owner, Tel_fono_Contacto, Email_Contacto, Created_Time, Modified_Time, Deal_Asociado ` +
          `from Cotizaciones_GeoVictoria where Created_Time >= '${desde}T00:00:00-04:00' order by Created_Time desc limit ${offset}, 200`,
      }),
    })
    if (!r.ok || r.status === 204) break
    const d = (await r.json().catch(() => ({}))) as { data?: Cot[]; info?: { more_records?: boolean } }
    cots.push(...(d.data || []))
    if (!d.info?.more_records) break
  }
  // Internos fuera con el MISMO criterio de métricas del dash (los "Rodrigo"/
  // "Nico"/"Recepción Deals" de prueba se colaban — cazado en el primer render).
  const setMetricas = metricsContactSet()
  const candidatas = cots
    .filter((c) => !/prueba|test|recepci.n deals|retenci.n md|geovictoria|huellero/i.test(String(c.Name || "")))
    .filter((c) => {
      const t = digits(String(c.Tel_fono_Contacto || ""))
      return !t || !isTestContact(t, setMetricas)
    })
    // Sin teléfono, el correo delata a los internos (las pruebas de Rodrigo
    // del 13-ago venían sin fono y con rodrigo.lewit@gmail.com).
    .filter((c) => {
      const em = String(c.Email_Contacto || "").toLowerCase()
      return !em || (!esEmailInterno(em) && !/rodrigo\.lewit|egomez|rlewit|cfuentesq|pruebasmkt/.test(em))
    })
  // Contexto de conversación + traspaso + pausas de TODAS las candidatas
  // (Supabase, lotes in.()) — la conversación además decide el CANAL de las
  // cotizaciones pre-19-ago sin marca.
  const tels = [...new Set(candidatas.map((c) => digits(String(c.Tel_fono_Contacto || ""))).filter(Boolean))]
  const sup = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const convPor = new Map<string, { started_at?: string; last_user_at?: string; updated_at?: string }>()
  const ptvPor = new Map<string, { vendedor?: string; estado?: string }>()
  const pausaPor = new Map<string, string>()
  for (let i = 0; i < tels.length; i += 40) {
    const lote = tels.slice(i, i + 40).map((t) => `"${t}"`).join(",")
    const [rc, rp, rl] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=in.(${lote})&select=contact,started_at,last_user_at,updated_at&limit=200`, { headers: sup, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_ptv?contact=in.(${lote})&select=contact,vendedor_nombre,vendedor_email,estado,traspasado_at&order=traspasado_at.desc&limit=200`, { headers: sup, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_loop?contact=in.(${lote})&compromiso_at=not.is.null&select=contact,compromiso_at&limit=200`, { headers: sup, cache: "no-store" }),
    ])
    for (const f of ((await rc.json().catch(() => [])) as Array<{ contact?: string; started_at?: string; last_user_at?: string; updated_at?: string }>) || []) {
      if (f.contact) convPor.set(digits(f.contact), f)
    }
    for (const f of ((await rp.json().catch(() => [])) as Array<{ contact?: string; vendedor_nombre?: string; vendedor_email?: string; estado?: string }>) || []) {
      const t = digits(String(f.contact || ""))
      if (t && !ptvPor.has(t)) ptvPor.set(t, { vendedor: f.vendedor_nombre || f.vendedor_email, estado: f.estado })
    }
    for (const f of ((await rl.json().catch(() => [])) as Array<{ contact?: string; compromiso_at?: string }>) || []) {
      if (f.contact && f.compromiso_at) pausaPor.set(digits(f.contact), f.compromiso_at)
    }
  }
  const ahora = Date.now()
  // Canal VICKY: marca '100% Vicky'; sin marca (pre-19-ago) → dueño robot O
  // conversación de WhatsApp que ya existía al emitir (mismo criterio del
  // panel de análisis — la limpieza igualó dueños cotización=deal y el owner
  // dejó de servir como discriminador histórico).
  const esVicky = (c: Cot) => {
    const marca = String(c.Intervenci_n_Humana || "")
    if (/100%/.test(marca)) return true
    if (/intervenci/i.test(marca)) return false
    if (/vicky|victoria luna|geovictoria$/i.test(String(c.Owner?.name || ""))) return true
    const conv = convPor.get(digits(String(c.Tel_fono_Contacto || "")))
    const inicioConv = Date.parse(String(conv?.started_at || ""))
    const creada = Date.parse(String(c.Created_Time || ""))
    return Number.isFinite(inicioConv) && Number.isFinite(creada) && inicioConv <= creada + 3600e3
  }
  const deVicky = candidatas.filter(esVicky)
  const porEstado = new Map<string, number>()
  for (const c of deVicky) porEstado.set(String(c.Estado_Cotizacion || "—"), (porEstado.get(String(c.Estado_Cotizacion || "—")) || 0) + 1)
  // COLA DE TRABAJO (Lalo 24-ago): TODO lo no pagado — Enviadas, Aceptadas y
  // Rechazadas — excluyendo las cuyo DEAL ya está en Cierre Perdido.
  const trabajables = deVicky.filter((c) => /Enviada|Aceptada|Rechazada/i.test(String(c.Estado_Cotizacion || "")))
  const dealIds = [...new Set(trabajables.map((c) => String(c.Deal_Asociado?.id || "")).filter(Boolean))]
  const stagePorDeal = new Map<string, string>()
  for (let i = 0; i < dealIds.length; i += 40) {
    const lote = dealIds.slice(i, i + 40).map((d) => `'${d}'`).join(",")
    const rq2 = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ select_query: `select id, Stage from Deals where id in (${lote}) limit 200` }),
    }).catch(() => null)
    if (!rq2?.ok || rq2.status === 204) continue
    const d2 = (await rq2.json().catch(() => ({}))) as { data?: Array<{ id?: string; Stage?: string }> }
    for (const f of d2.data || []) if (f.id) stagePorDeal.set(String(f.id), String(f.Stage || ""))
  }
  const vivas = trabajables.filter((c) => {
    const st = stagePorDeal.get(String(c.Deal_Asociado?.id || "")) || ""
    return !/Cierre Perdido/i.test(st)
  })
  const dias = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? (ahora - Date.parse(iso)) / 86400e3 : NaN)
  type Fila = { orden: number; html: string }
  const filas: Fila[] = []
  for (const c of vivas) {
    const tel = digits(String(c.Tel_fono_Contacto || ""))
    const edad = dias(c.Created_Time)
    const conv = tel ? convPor.get(tel) : undefined
    const ptv = tel ? ptvPor.get(tel) : undefined
    const pausa = tel ? pausaPor.get(tel) : undefined
    const aceptada = /Aceptada/i.test(String(c.Estado_Cotizacion || ""))
    const rechazada = /Rechazada/i.test(String(c.Estado_Cotizacion || ""))
    const clienteRespondioPost = Boolean(
      conv?.last_user_at && c.Created_Time && Date.parse(conv.last_user_at) > Date.parse(c.Created_Time),
    )
    const diasMudo = dias(conv?.last_user_at)
    const responsable = ptv?.vendedor
      ? `${ptv.vendedor}${ptv.estado === "activo" ? "" : " (traspaso cerrado)"}`
      : /vicky|geovictoria$/i.test(String(c.Owner?.name || ""))
        ? "Vicky (sin traspaso)"
        : String(c.Owner?.name || "—")
    let orden = 5
    let paso = ""
    if (aceptada) {
      orden = 0
      paso = `🔥 Aceptó hace ${Math.max(0, dias(c.Modified_Time)).toFixed(1)} días y NO ha pagado — llamar YA y empujar el mismo link de pago`
    } else if (rechazada) {
      orden = 6
      paso = `❌ El cliente la rechazó — revisar el motivo en el chat: ¿re-cotizar con otro armado o dejarla caer?`
    } else if (pausa && Date.parse(pausa) > ahora) {
      orden = 4
      paso = `⏸ Pausa anunciada por el cliente hasta ${fmtSantiago(pausa)} — retomar entonces (no quemarlo antes)`
    } else if (edad < 1 && clienteRespondioPost) {
      orden = 3
      paso = `🟢 Conversación viva (emitida hoy) — Vicky la trabaja; si no cierra hoy, llamada mañana`
    } else if (!clienteRespondioPost) {
      orden = 1
      paso = `📞 NUNCA respondió después de la formal (${edad.toFixed(1)} días) — llamar directo: puede no haberla visto (el correo cae en Promociones)`
    } else if (Number.isFinite(diasMudo) && diasMudo > 2) {
      orden = 2
      paso = `📞 Tibia: su último mensaje fue hace ${diasMudo.toFixed(1)} días — llamar y ofrecer el descuento de cierre`
    } else {
      orden = 3
      paso = `👀 Respondió hace poco — revisar el chat y cerrar por teléfono si se enfría`
    }
    const diasParaCierre = Math.max(0, 14 - edad)
    const urgencia = aceptada ? "" : ` · <span style="color:${diasParaCierre < 4 ? "#b91c1c" : "#6b7280"}">se pierde en ${diasParaCierre.toFixed(0)} d</span>`
    const zurl = `https://crm.zoho.com/crm/org685875245/tab/CustomModule5/${c.id}`
    filas.push({
      orden: orden * 1000 + Math.max(0, 30 - edad),
      html:
        `<tr><td><a href="${zurl}" target="_blank" rel="noopener">${c.Numero_Cotizacion || "—"}</a></td>` +
        `<td>${esc(String(c.Name || "").replace(/^Cotización /, "").replace(/ - \d{4}-\d{2}-\d{2}$/, ""))}</td>` +
        `<td>${tel ? `<a href="https://wa.me/${tel}" target="_blank" rel="noopener">+${tel}</a>` : "—"}</td>` +
        `<td style="white-space:nowrap">${fmtSantiago(String(c.Created_Time || ""))} <span class="sub">(${edad.toFixed(1)} d)</span></td>` +
        `<td>${aceptada ? "<b style='color:#b45309'>Aceptada 💰</b>" : rechazada ? "<b style='color:#b91c1c'>Rechazada</b>" : "Enviada"}${rechazada ? "" : urgencia}</td>` +
        `<td>${esc(responsable)}</td>` +
        `<td>${conv?.last_user_at ? fmtSantiago(conv.last_user_at) : "<span style='color:#b91c1c'>sin mensajes</span>"}</td>` +
        `<td style="max-width:340px">${paso}</td></tr>`,
    })
  }
  filas.sort((a, b) => a.orden - b.orden)
  // Chips por estado REAL (dinámico: en Zoho conviven Enviada/Aceptada/Pagada/
  // Vencida/Perdida y variantes — la lista fija escondía estados).
  const chips = [...porEstado.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => {
      const bg = /pagada/i.test(e) ? "#f0faf4" : /aceptada/i.test(e) ? "#fff8e8" : /perdida|vencida/i.test(e) ? "#fdf2f2" : "#f0f7fc"
      return `<span style="display:inline-block;padding:6px 14px;border-radius:10px;background:${bg};font-weight:700">${esc(e)}: ${n}</span>`
    })
    .join(" ")
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cartera Vicky</title>
  <style>
    body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f8fa;color:#2d3748}
    .wrap{max-width:1280px;margin:0 auto;padding:18px}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:8px 8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    a{color:#0284c7;text-decoration:none}
    .sub{color:#8a949c;font-size:12px}
    tr:hover td{background:#f8fbfd}
  </style></head><body><div class="wrap">
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px"><img src="/gv/logo-full-color.svg" style="height:28px" alt=""><h1 style="margin:0;font-size:20px">📋 Cartera de cotizaciones Vicky</h1>
  <a class="sub" href="?${qsBase}">← volver al dash</a></div>
  <div class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${chips}<span class="sub">· últimos 30 días, canal Vicky</span></div>
  <p class="sub" style="margin:10px 0 0">El cierre perdido automático corre a los <b>14 días</b> sin actividad. Orden de la tabla = urgencia: aceptadas sin pago primero, luego las que nunca respondieron a la formal, luego tibias. El link del teléfono abre WhatsApp; el COT abre Zoho.</p></div>
  ${await (async () => {
    // 🤝 PROMESAS DE CONTACTO (P1 27-ago): lo que Vicky prometió que un humano
    // haría ("te llama un ejecutivo", callback). Vencida sin evidencia en el
    // espejo = alertada — acá deja de ser invisible.
    try {
      const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      const desde = new Date(Date.now() - 14 * 86_400_000).toISOString()
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_promesas?creado_at=gte.${encodeURIComponent(desde)}&order=creado_at.desc&limit=200`,
        { headers: h, cache: "no-store" },
      )
      if (!r.ok) return ""
      const filasP = ((await r.json().catch(() => [])) as Array<{
        contact: string; tipo: string; detalle?: string; vendedor_email?: string
        creado_at: string; deadline_at: string; estado: string; evidencia?: string
      }>) || []
      if (!filasP.length) return ""
      const abiertas = filasP.filter((p) => p.estado !== "cumplida")
      const cumplidas = filasP.length - abiertas.length
      const etq = (t: string) => (t === "callback" ? "llamada pedida" : t === "cotizacion_por_correo" ? "cotización por correo" : "llamada de ejecutivo")
      const chip = (e: string) =>
        e === "alertada"
          ? '<span style="background:#fee2e2;color:#b91c1c;font-size:11px;padding:2px 8px;border-radius:99px;font-weight:700">VENCIDA</span>'
          : '<span style="background:#fef9c3;color:#854d0e;font-size:11px;padding:2px 8px;border-radius:99px;font-weight:700">pendiente</span>'
      const fmtP = (iso: string) => new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
      return `<div class="card"><h2 style="margin:0 0 6px;font-size:16px">🤝 Promesas de contacto (14 días: ${filasP.length} · cumplidas ${cumplidas})</h2>
      <p class="sub" style="margin:0 0 10px">Cada vez que Vicky promete que un humano llamará, queda registrado con plazo hábil. "VENCIDA" = pasó el plazo sin rastro de contacto en el espejo (ya se avisó por alerta interna). Se marca cumplida sola al detectar el WhatsApp o la llamada del ejecutivo.</p>
      ${abiertas.length ? `<div style="overflow-x:auto"><table><tr><th>Cliente</th><th>Promesa</th><th>Responsable</th><th>Prometida</th><th>Vencía</th><th>Estado</th></tr>
      ${abiertas.map((p) => `<tr><td><a href="https://wa.me/${esc(p.contact)}" target="_blank">+${esc(p.contact)}</a></td><td>${esc(etq(p.tipo))}${p.detalle ? ` <span class="sub">· ${esc(p.detalle)}</span>` : ""}</td><td>${esc(p.vendedor_email || "—")}</td><td>${fmtP(p.creado_at)}</td><td>${fmtP(p.deadline_at)}</td><td>${chip(p.estado)}</td></tr>`).join("")}</table></div>` : '<p class="sub">Sin promesas abiertas 🎉</p>'}
      </div>`
    } catch { return "" }
  })()}
  <div class="card"><h2 style="margin:0 0 10px;font-size:16px">Vivas por trabajar (${filas.length})</h2>
  <div style="overflow-x:auto"><table><tr><th>COT</th><th>Empresa</th><th>WhatsApp</th><th>Emitida</th><th>Estado</th><th>Responsable</th><th>Últ. msj del cliente</th><th>Próximo paso sugerido</th></tr>
  ${filas.map((f) => f.html).join("")}</table></div>
  ${quien && quien !== "Administrador" ? `<p class="sub">Sesión: ${esc(quien)}</p>` : ""}
  </div></div></body></html>`
}

// ── 🤝 TRASPASOS DE VICKY AL EQUIPO (Lalo 02-sep) ───────────────────────────
// Herramienta para la LÍDER COMERCIAL (Victoria Luna): por ejecutivo, cuánto le
// traspasó Vicky en el período —con o sin cotización— separando lo que YA tuvo
// contacto del vendedor de lo que sigue sin tocar desde el traspaso.
//
// Qué cuenta como ATENDIDO (mismo criterio del candado PTV v3, nada de fe):
// un WhatsApp del vendedor por su línea espejada o una llamada aceptada,
// posteriores al traspaso. Notas de Zoho NO se miran acá: esto mide el contacto
// real con el cliente, no el registro administrativo.
//
// HONESTIDAD: los chats del espejo que aún no tienen número identificado se
// declaran arriba. Mientras un chat no cruce, su cliente puede figurar "sin
// contactar" siendo falso — el pie de la página lo dice con todas sus letras.
type FilaTraspaso = {
  contact: string
  vendedorEmail: string
  vendedorNombre: string
  traspasadoAt: string
  motivo: string
  presentado: boolean
  estado: string
  empresa: string
  quoteId: string
  totalClp: number
  aceptacionUrl: string
  ultVendedor: string
  ultOtroVendedor: string
  ultNota: string
  ultCliente: string
  llamada: string
  ultCliVicky: string
}

/** Sesión de espejo de un ejecutivo = la parte local de su correo
 *  (pdiaz@ → sesión "pdiaz"), como están dadas de alta en el worker.
 *  Override sin deploy: VICKY_ESPEJO_SESION_POR_EMAIL="correo:sesion,...". */
function sesionEspejoDe(email: string): string {
  const e = String(email || "").toLowerCase().trim()
  if (!e) return ""
  for (const par of (process.env.VICKY_ESPEJO_SESION_POR_EMAIL || "").split(",")) {
    const [correo, ses] = par.split(":").map((s) => s.trim().toLowerCase())
    if (correo && ses && correo === e) return ses
  }
  return e.split("@")[0] || ""
}

/** Líderes comerciales: ven al equipo completo. Un ejecutivo ve SOLO lo suyo
 *  (el panel es para empujar al equipo, no para que cada uno mire al resto). */
const LIDERES_COMERCIALES = (
  process.env.VICKY_LIDERES_COMERCIALES ||
  "vluna@geovictoria.com,egomez@geovictoria.com,rlewit@geovictoria.com,victoria luna,eduardo gomez,eduardo gómez,rodrigo lewit"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

/**
 * 📅 CIERRE DIARIO (Lalo 02-sep, "el dash de mejoras y el correo programado
 * diario"). El panel NO recalcula nada: lee la foto que dejó
 * `vic-cierre-diario` en vic_kv (`foto_dia_<fecha>`), que es la misma que se
 * manda por correo a las 07:30 — así el panel y el correo no pueden mostrar
 * números distintos, que es el punto del ejercicio.
 */
type FotoCierre = {
  fecha: string
  conversaciones: number
  nuevas: number
  formales: number
  medInicioFormal: number | null
  ventas: Array<{ cot: string; empresa: string; monto: number; dueno: string }>
  montoVentas: number
  motivos: Array<{ motivo: string; casos: Array<{ contact: string; resumen: string; accionable: string }> }>
  fallas: Array<{ contact: string; hora: string; mensajes: number }>
  traspasos: { total: number; sinContacto: number }
  generadoAt: string
}

const ETIQUETA_MOTIVO_CIERRE: Record<string, string> = {
  faltaron_datos: "Faltaron datos para cotizar",
  silencio: "Silencio después del precio",
  evaluando: "Está evaluando / lo ve con otro",
  precio: "Precio",
  prefirio_humano: "Pidió hablar con una persona",
  proveedor_actual: "Tiene otro proveedor",
  hardware: "Hardware o compatibilidad",
}

async function renderCierre(qsBase: string, sp: URLSearchParams): Promise<string> {
  const hoyCL = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const dias: string[] = []
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.parse(`${hoyCL}T12:00:00-04:00`) - i * 864e5)
    dias.push(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d))
  }
  const pedida = (sp.get("dia") || "").trim()
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(pedida) ? pedida : dias[0]

  const claves = [...new Set([fecha, ...dias])].map((d) => `"foto_dia_${d}"`).join(",")
  let filas: Array<{ key: string; value: string }> = []
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?select=key,value&key=in.(${encodeURIComponent(claves)})&limit=40`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    if (r.ok) filas = (await r.json()) as Array<{ key: string; value: string }>
  } catch {
    filas = []
  }
  const porDia = new Map<string, FotoCierre>()
  for (const f of filas) {
    try {
      porDia.set(String(f.key).replace("foto_dia_", ""), JSON.parse(f.value) as FotoCierre)
    } catch {
      /* foto ilegible: el día sale vacío */
    }
  }
  const f = porDia.get(fecha)
  const clpN = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`
  const largoCL = (d: string) =>
    new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${d}T12:00:00-04:00`))
  const tasa = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—")

  const tira = dias
    .map((d) => {
      const fd = porDia.get(d)
      const on = d === fecha
      const p = new URLSearchParams(qsBase)
      p.set("vista", "cierre")
      p.set("dia", d)
      const dow = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "short", day: "numeric" }).format(new Date(`${d}T12:00:00-04:00`))
      return `<a href="?${p.toString()}" style="display:inline-block;padding:7px 11px;border-radius:9px;text-decoration:none;border:1px solid ${on ? "#0284c7" : "#e5e7eb"};background:${on ? "#e8f4fd" : "#fff"};color:#2d3748;min-width:64px;text-align:center">
        <div style="font-size:11px;color:#6b7280">${esc(dow)}</div>
        <div style="font-weight:800;font-size:15px;color:${fd && fd.ventas.length ? "#0e8a6d" : "#9aa0a8"}">${fd ? fd.ventas.length : "·"}</div></a>`
    })
    .join("")

  const cuerpo = !f
    ? `<div class="card"><b>Ese día todavía no tiene foto.</b><div class="sub" style="margin-top:6px">La foto se calcula sola cada mañana. Los días anteriores al 03-sep-2026 no existen: el cierre diario nació ese día.</div></div>`
    : `
  <div class="card">
    <div style="display:flex;gap:30px;flex-wrap:wrap">
      ${[
        [String(f.ventas.length), "ventas", "#0e8a6d"],
        [clpN(f.montoVentas), "cobrados", "#0e8a6d"],
        [String(f.conversaciones), "conversaciones", "#2d3748"],
        [String(f.nuevas), "nuevas", "#2d3748"],
        [String(f.formales), `formales · ${tasa(f.formales, f.conversaciones)}`, "#2d3748"],
        [f.medInicioFormal !== null ? `${f.medInicioFormal} min` : "—", "del 1er mensaje a la formal", "#2d3748"],
      ]
        .map(([n, l, c]) => `<div><div style="font-size:23px;font-weight:800;color:${c}">${esc(n)}</div><div class="sub">${esc(l)}</div></div>`)
        .join("")}
    </div>
    <div class="sub" style="margin-top:10px">Cierre del día: <b>${tasa(f.ventas.length, f.formales)}</b> de las cotizaciones formales terminó pagada.</div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px">💰 Qué vendió</h3>
    ${
      f.ventas.length
        ? `<table><tr><th>Empresa</th><th>Cotización</th><th style="text-align:right">Monto</th><th>Quedó con</th></tr>${f.ventas
            .map(
              (v) =>
                `<tr><td><b>${esc(v.empresa)}</b></td><td class="sub">${esc(v.cot)}</td><td style="text-align:right">${v.monto ? clpN(v.monto) : "—"}</td><td class="sub">${esc(v.dueno || "—")}</td></tr>`,
            )
            .join("")}</table>`
        : `<div class="sub">Ninguna venta ese día.</div>`
    }
  </div>

  <div class="card">
    <h3 style="margin:0 0 4px;font-size:15px">🧭 Qué no vendió, y por qué</h3>
    <div class="sub" style="margin-bottom:10px">Conversaciones de ese día que el clasificador cerró sin venta, con lo que se puede hacer todavía.</div>
    ${
      f.motivos.length
        ? f.motivos
            .map(
              (m) =>
                `<div style="margin-bottom:14px"><div style="font-weight:700;font-size:13.5px">${esc(ETIQUETA_MOTIVO_CIERRE[m.motivo.replace(/^otros:/, "")] || m.motivo.replace(/^otros:/, ""))} <span class="sub">· ${m.casos.length} ${m.casos.length === 1 ? "caso" : "casos"}${m.motivo.startsWith("otros:") ? " · revisado ese día, conversación de otro día" : ""}</span></div>` +
                `<table style="margin-top:6px">${m.casos
                  .map(
                    (c) =>
                      `<tr><td style="width:130px"><a href="https://wa.me/${esc(c.contact)}">+${esc(c.contact)}</a></td>` +
                      `<td>${esc(c.resumen || "—")}${c.accionable ? `<div class="sub" style="margin-top:3px">→ ${esc(c.accionable)}</div>` : ""}</td></tr>`,
                  )
                  .join("")}</table></div>`,
            )
            .join("")
        : `<div class="sub">Sin casos clasificados ese día.</div>`
    }
  </div>

  <div class="card">
    <h3 style="margin:0 0 4px;font-size:15px">⚠️ Fallas técnicas</h3>
    <div class="sub" style="margin-bottom:10px">Veces que Vicky tuvo que decirle a alguien que no podía responderle. Cada línea es una persona que se quedó esperando.</div>
    ${
      f.fallas.length
        ? `<table>${f.fallas
            .map(
              (x) =>
                `<tr><td style="width:130px"><a href="https://wa.me/${esc(x.contact)}">+${esc(x.contact)}</a></td><td>${x.mensajes} ${x.mensajes === 1 ? "mensaje" : "mensajes"} de error</td></tr>`,
            )
            .join("")}</table>`
        : `<div class="sub" style="color:#0e8a6d">Ninguna. Vicky respondió todo el día.</div>`
    }
  </div>

  <div class="card">
    <h3 style="margin:0 0 6px;font-size:15px">🤝 Traspasos</h3>
    <div class="sub">${f.traspasos.total} conversaciones traspasadas ese día · <b>${f.traspasos.sinContacto}</b> sin WhatsApp del ejecutivo en lo que quedó del día.
    <a href="?${(() => { const p = new URLSearchParams(qsBase); p.set("vista", "traspasos"); return p.toString() })()}">ver el panel de Traspasos →</a></div>
  </div>

  <div class="sub" style="margin:0 0 20px">Estos son los mismos números del correo diario de las 07:30 — panel y correo leen la foto que el sistema guarda al cerrar el día. Todavía NO trae: la categoría de cada objeción con la cita textual del cliente y el MRR en juego.</div>`

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cierre diario de Vicky</title><style>
    body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f8fa;color:#2d3748}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    a{color:#0284c7;text-decoration:none}
    .sub{color:#8a949c;font-size:12px}
  </style></head><body><div class="wrap">
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap"><img src="/gv/logo-full-color.svg" style="height:28px" alt="">
  <h1 style="margin:0;font-size:20px">📅 Cierre diario de Vicky</h1>
  <span class="sub">${esc(largoCL(fecha))}</span>
  <a class="sub" href="?${qsBase}">← volver al dash</a></div>
  <div class="card" style="padding:12px 14px"><div class="sub" style="margin-bottom:8px">Últimos 14 días — el número es cuántas ventas cerró Vicky ese día</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">${tira}</div></div>
  ${cuerpo}
  </div></body></html>`
}

async function renderTraspasos(quien: string, qsBase: string, sp: URLSearchParams, esAdmin: boolean): Promise<string> {
  const norm = (s: string) => s.trim().toLowerCase()
  const verTodo = esAdmin || LIDERES_COMERCIALES.includes(norm(quien))
  const sup = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const fechaCL = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
  const valida = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const hoyCL = fechaCL(new Date())
  const hastaP = sp.get("hasta") || ""
  const desdeP = sp.get("desde") || ""
  const hasta = valida(hastaP) ? hastaP : hoyCL
  const desde = valida(desdeP) ? desdeP : fechaCL(new Date(Date.now() - 6 * 86_400_000))
  let ejecF = (sp.get("ejec") || "").trim().toLowerCase()
  const desdeISO = `${desde}T00:00:00-04:00`
  const hastaISO = `${hasta}T23:59:59-04:00`

  // 1. Traspasos del período (vic_ptv es la bitácora del PTV: una fila por
  //    conversación entregada, con el vendedor que quedó a cargo).
  const rp = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_ptv?traspasado_at=gte.${encodeURIComponent(desdeISO)}&traspasado_at=lte.${encodeURIComponent(hastaISO)}` +
      `&select=contact,vendedor_email,vendedor_nombre,vendedor_zoho_id,traspasado_at,motivo,presentado_al_prospecto,estado&order=traspasado_at.desc&limit=800`,
    { headers: sup, cache: "no-store" },
  )
  const crudas = ((await rp.json().catch(() => [])) as Array<Record<string, unknown>>) || []
  const setMetricas = metricsContactSet()
  const base = crudas
    .map((f) => ({
      contact: digits(String(f.contact || "")),
      vendedorEmail: String(f.vendedor_email || "").toLowerCase(),
      vendedorNombre: String(f.vendedor_nombre || "").trim(),
      traspasadoAt: String(f.traspasado_at || ""),
      motivo: String(f.motivo || ""),
      presentado: Boolean(f.presentado_al_prospecto),
      estado: String(f.estado || ""),
    }))
    .filter((f) => f.contact && !isTestContact(f.contact, setMetricas))
  // Un contacto traspasado dos veces en el período cuenta UNA vez, por su
  // traspaso más reciente (el vigente): si no, el mismo cliente aparecería
  // "sin atender" en dos ejecutivos distintos.
  const porContacto = new Map<string, (typeof base)[number]>()
  for (const f of base) if (!porContacto.has(f.contact)) porContacto.set(f.contact, f)
  const filasBase = [...porContacto.values()]
  const tels = filasBase.map((f) => f.contact)

  // 2. Contexto por lotes: cotización, conversación con Vicky y evidencia de
  //    atención del vendedor (espejo de WhatsApp + llamadas).
  const cot = new Map<string, { quoteId: string; dealId: string; empresa: string; totalClp: number; url: string }>()
  const convCli = new Map<string, string>()
  // Por contacto: última salida del vendedor POR SESIÓN de espejo. La
  // atribución importa (02-sep): sin separar por sesión, el WhatsApp de un
  // ejecutivo a un cliente de OTRO contaba como gestión del otro.
  const ultVendSes = new Map<string, Map<string, string>>()
  const ultCallSes = new Map<string, Map<string, string>>()
  const ultCli = new Map<string, string>()
  const anota = (mapa: Map<string, Map<string, string>>, tel: string, ses: string, at: string) => {
    const m = mapa.get(tel) || new Map<string, string>()
    if (!m.get(ses) || m.get(ses)! < at) m.set(ses, at)
    mapa.set(tel, m)
  }
  const maxDe = (m: Map<string, string> | undefined, incluir: (s: string) => boolean) => {
    let out = ""
    for (const [s, at] of m || []) if (incluir(s) && at > out) out = at
    return out
  }
  const minTraspaso = filasBase.reduce(
    (m, f) => (Date.parse(f.traspasadoAt) < m ? Date.parse(f.traspasadoAt) : m),
    Date.parse(hastaISO),
  )
  const desdeEspejo = new Date(Number.isFinite(minTraspaso) ? minTraspaso : Date.parse(desdeISO)).toISOString()
  for (let i = 0; i < tels.length; i += 40) {
    const lote = tels.slice(i, i + 40).map((t) => `"${t}"`).join(",")
    const [rq, rc, rm, rl] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=in.(${lote})&select=contact,quote_id,deal_id,empresa,total_clp,acceptance_url&limit=200`, { headers: sup, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=in.(${lote})&select=contact,last_user_at&limit=200`, { headers: sup, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?telefono_chat=in.(${lote})&enviado_at=gte.${encodeURIComponent(desdeEspejo)}&select=telefono_chat,from_me,enviado_at,session_id&order=enviado_at.desc&limit=3000`, { headers: sup, cache: "no-store" }),
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_llamadas?telefono=in.(${lote})&at=gte.${encodeURIComponent(desdeEspejo)}&select=telefono,estado,at,session_id&order=at.desc&limit=800`, { headers: sup, cache: "no-store" }),
    ])
    for (const f of ((await rq.json().catch(() => [])) as Array<Record<string, unknown>>) || []) {
      const t = digits(String(f.contact || ""))
      if (t && !cot.has(t)) cot.set(t, { quoteId: String(f.quote_id || ""), dealId: String(f.deal_id || ""), empresa: String(f.empresa || ""), totalClp: Number(f.total_clp || 0), url: String(f.acceptance_url || "") })
    }
    for (const f of ((await rc.json().catch(() => [])) as Array<Record<string, unknown>>) || []) {
      const t = digits(String(f.contact || ""))
      const u = String(f.last_user_at || "")
      if (t && u && (!convCli.get(t) || convCli.get(t)! < u)) convCli.set(t, u)
    }
    for (const f of ((await rm.json().catch(() => [])) as Array<Record<string, unknown>>) || []) {
      const t = digits(String(f.telefono_chat || ""))
      const at = String(f.enviado_at || "")
      if (!t || !at) continue
      if (f.from_me) anota(ultVendSes, t, String(f.session_id || ""), at)
      else if (!ultCli.get(t) || ultCli.get(t)! < at) ultCli.set(t, at)
    }
    for (const f of ((await rl.json().catch(() => [])) as Array<Record<string, unknown>>) || []) {
      const t = digits(String(f.telefono || ""))
      const at = String(f.at || "")
      // "accept" = llamada que la otra parte tomó; eso ES contacto humano.
      if (t && at && String(f.estado || "") === "accept") anota(ultCallSes, t, String(f.session_id || ""), at)
    }
  }

  // ── EL RESPONSABLE ES EL DUEÑO DEL TRATO EN ZOHO (02-sep) ────────────────
  // La bitácora `vic_ptv` guarda a quién PRESENTAMOS, y la tómbola de Zoho
  // corre asíncrona: medido sobre los traspasos de esta semana, 8 de 48 filas
  // nombraban a un ejecutivo distinto del dueño real del trato (en un caso la
  // bitácora decía Aracelli y el trato era de Paola). Quien tiene que trabajar
  // el caso es el DUEÑO del trato — esa es la verdad del CRM y con esa se mide.
  // Sin trato (o con el trato aún en el robot) manda la bitácora.
  const duenoDeal = new Map<string, { email: string; nombre: string; stage: string; creado: string }>()
  const dealIds = [...new Set([...cot.values()].map((c) => c.dealId).filter(Boolean))]
  if (dealIds.length) {
    try {
      const token = await getZohoAccessToken()
      const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
      for (let i = 0; i < dealIds.length; i += 40) {
        const lote = dealIds.slice(i, i + 40).map((d) => `'${d}'`).join(",")
        const rq = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
          method: "POST", headers: HZ, cache: "no-store",
          // `Owner` a secas trae solo el APELLIDO (dos "Diaz" en el roster —
          // Anderson y Paola — se confundían); los campos del lookup traen
          // correo y nombre de pila.
          body: JSON.stringify({ select_query: `select id, Stage, Created_Time, Owner.email, Owner.first_name, Owner.last_name from Deals where id in (${lote}) limit 200` }),
        }).catch(() => null)
        if (!rq?.ok || rq.status === 204) continue
        const dd = (await rq.json().catch(() => ({}))) as {
          data?: Array<Record<string, string | null | undefined>>
        }
        for (const f of dd.data || []) {
          const em = String(f["Owner.email"] || "").toLowerCase()
          const nom = `${String(f["Owner.first_name"] || "").trim()} ${String(f["Owner.last_name"] || "").trim()}`.trim()
          // Los usuarios robot (Vicky, GeoVictoria Admin) no son responsables.
          if (f.id && em && !/^(vicky|info)@geovictoria\.com$/.test(em)) duenoDeal.set(String(f.id), { email: em, nombre: nom || em, stage: String(f.Stage || ""), creado: String(f.Created_Time || "") })
        }
      }
    } catch (e) {
      console.warn("[traspasos] dueños de trato:", e instanceof Error ? e.message : e)
    }
  }

  // ── LA GESTIÓN TAMBIÉN VIVE EN LAS NOTAS DEL TRATO (03-sep) ──────────────
  // Orden de Lalo: "para poder decir que no hay contacto hay que mirar todo".
  // Medido sobre los 19 casos que el panel daba por no contactados, 6 tenían
  // nota del ejecutivo en Zoho — entre ellos la oportunidad más grande de la
  // semana ($391.563), que Eddyluz había atendido 58 minutos después del
  // traspaso pegando la conversación como nota. El espejo no lo vio porque su
  // sesión estaba caída. Una nota escrita por una PERSONA (los robots Vicky y
  // GeoVictoria Admin no cuentan) posterior al traspaso es gestión.
  const ultNotaDeal = new Map<string, string>()
  if (dealIds.length) {
    try {
      const token = await getZohoAccessToken()
      const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
      const ROBOTS = new Set(["3525045000484500876", "3525045000000200013"])
      for (let i = 0; i < dealIds.length; i += 20) {
        const lote = dealIds.slice(i, i + 20).map((d) => `'${d}'`).join(",")
        const rn = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
          method: "POST", headers: HZ, cache: "no-store",
          body: JSON.stringify({
            select_query: `select id, Parent_Id, Created_Time, Created_By from Notes where Parent_Id in (${lote}) order by Created_Time desc limit 200`,
          }),
        }).catch(() => null)
        if (!rn?.ok || rn.status === 204) continue
        const dn = (await rn.json().catch(() => ({}))) as {
          data?: Array<{ Parent_Id?: { id?: string } | null; Created_Time?: string; Created_By?: { id?: string } | null }>
        }
        for (const n of dn.data || []) {
          const deal = String(n.Parent_Id?.id || "")
          const autor = String(n.Created_By?.id || "")
          const at = String(n.Created_Time || "")
          if (!deal || !at || ROBOTS.has(autor)) continue
          if (!ultNotaDeal.get(deal) || ultNotaDeal.get(deal)! < at) ultNotaDeal.set(deal, at)
        }
      }
    } catch (e) {
      console.warn("[traspasos] notas del trato:", e instanceof Error ? e.message : e)
    }
  }

  // Sesiones de espejo VIVAS. Sin esto el panel acusaba de "no contactó" a
  // quien simplemente no tiene su WhatsApp espejado (02-sep: Aleydis y
  // Aracelli nunca fueron dadas de alta en el worker).
  const sesionesVivas = new Set<string>()
  try {
    const rs = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.wa_espejo_status_*&select=key,value&limit=60`, { headers: sup, cache: "no-store" })
    for (const f of ((await rs.json().catch(() => [])) as Array<{ key?: string; value?: string }>) || []) {
      const ses = String(f.key || "").replace(/^wa_espejo_status_/, "")
      if (ses && /conectado/.test(String(f.value || ""))) sesionesVivas.add(ses.toLowerCase())
    }
  } catch {}

  // Un nombre por correo: las filas con trato traen el nombre de Zoho y las
  // sin trato el de la bitácora, y la misma persona salía dos veces en la
  // tabla ("Daniela Galvez" y "Daniela Gálvez").
  const nombrePorEmail = new Map<string, string>()
  for (const d of duenoDeal.values()) if (d.email && d.nombre) nombrePorEmail.set(d.email, d.nombre)
  const filas: FilaTraspaso[] = filasBase.map((f) => {
    const dueno = duenoDeal.get(cot.get(f.contact)?.dealId || "")
    if (dueno) {
      f.vendedorEmail = dueno.email
      f.vendedorNombre = dueno.nombre
    }
    f.vendedorNombre = nombrePorEmail.get(f.vendedorEmail) || f.vendedorNombre
    const ses = sesionEspejoDe(f.vendedorEmail)
    const propio = (s: string) => Boolean(ses) && s.toLowerCase() === ses
    return {
      ...f,
      empresa: cot.get(f.contact)?.empresa || "",
      quoteId: cot.get(f.contact)?.quoteId || "",
      totalClp: cot.get(f.contact)?.totalClp || 0,
      aceptacionUrl: cot.get(f.contact)?.url || "",
      ultVendedor: maxDe(ultVendSes.get(f.contact), propio),
      ultOtroVendedor: maxDe(ultVendSes.get(f.contact), (s) => !propio(s)),
      ultNota: ultNotaDeal.get(cot.get(f.contact)?.dealId || "") || "",
      ultCliente: ultCli.get(f.contact) || "",
      llamada: maxDe(ultCallSes.get(f.contact), propio),
      ultCliVicky: convCli.get(f.contact) || "",
    }
  })

  const posterior = (iso: string, ref: string) => Boolean(iso) && Date.parse(iso) > Date.parse(ref)
  // ── FUERA LAS DEVOLUCIONES DE CARTERA ANTERIOR (03-sep, orden de Lalo) ────
  // El reloj de "formal sin respuesta" devuelve a su dueño de siempre a los
  // clientes viejos que reaparecen por las campañas de reactivación: seis de
  // los 18 de Anderson eran tratos suyos desde junio y julio. Eso no es una
  // oportunidad entregada esta semana y castiga al que más ha vendido, porque
  // mientras más cartera propia acumula, más devoluciones recibe. Un trato
  // creado más de 14 días antes del traspaso es cartera anterior, no traspaso
  // nuevo: sale de la cuenta (env VICKY_TRASPASOS_ANTIGUEDAD_DIAS).
  const DIAS_ANTIGUO = Math.max(1, Number(process.env.VICKY_TRASPASOS_ANTIGUEDAD_DIAS || 14))
  const devolucion = (f: FilaTraspaso) => {
    const creado = duenoDeal.get(cot.get(f.contact)?.dealId || "")?.creado || ""
    if (!creado) return false
    const dias = (Date.parse(f.traspasadoAt) - Date.parse(creado)) / 86_400_000
    return Number.isFinite(dias) && dias > DIAS_ANTIGUO
  }
  // Caso CERRADO: el trato ya está implementando, facturando o perdido. No es
  // gestión pendiente (02-sep: un cliente que YA PAGÓ salía como "sin
  // contactar" y eso solo hace ruido en la lista del ejecutivo).
  const cerrado = (f: FilaTraspaso) =>
    /7\.|8\.|Cierre Perdido|Implementando|Facturando/i.test(duenoDeal.get(cot.get(f.contact)?.dealId || "")?.stage || "")
  const conEspejo = (f: FilaTraspaso) => sesionesVivas.has(sesionEspejoDe(f.vendedorEmail))
  const atendida = (f: FilaTraspaso) =>
    posterior(f.ultVendedor, f.traspasadoAt) || posterior(f.llamada, f.traspasadoAt) || posterior(f.ultNota, f.traspasadoAt)
  const tocadaPorOtro = (f: FilaTraspaso) => posterior(f.ultOtroVendedor, f.traspasadoAt)
  // Sin espejo no hay forma de saberlo: no se cuenta ni como atendida ni como
  // abandonada — se declara "no medible" y punto.
  // Con nota en el trato la gestión es visible aunque no haya espejo.
  const medible = (f: FilaTraspaso) => conEspejo(f) || posterior(f.ultNota, f.traspasadoAt)
  const sinContactar = (f: FilaTraspaso) => medible(f) && !atendida(f) && !tocadaPorOtro(f) && !cerrado(f)
  const ultimaActividad = (f: FilaTraspaso) =>
    [f.ultVendedor, f.ultOtroVendedor, f.ultCliente, f.llamada, f.ultNota, f.ultCliVicky].filter(Boolean).sort().slice(-1)[0] || ""

  const devoluciones = filas.filter(devolucion)
  const nuevas = filas.filter((f) => !devolucion(f))

  // 3. Resumen por ejecutivo.
  type Ejec = { email: string; nombre: string; total: number; conCot: number; atendidos: number; porOtro: number; sinContactar: number; espejo: boolean; masViejoSinAtender: number }
  const porEjec = new Map<string, Ejec>()
  for (const f of nuevas) {
    const clave = f.vendedorEmail || f.vendedorNombre || "—"
    const e = porEjec.get(clave) || {
      email: f.vendedorEmail, nombre: f.vendedorNombre || f.vendedorEmail || "sin ejecutivo",
      total: 0, conCot: 0, atendidos: 0, porOtro: 0, sinContactar: 0, espejo: conEspejo(f), masViejoSinAtender: 0,
    }
    if (!e.nombre || /@/.test(e.nombre)) e.nombre = f.vendedorNombre || e.nombre
    e.total++
    if (f.quoteId) e.conCot++
    if (atendida(f)) e.atendidos++
    else if (tocadaPorOtro(f)) e.porOtro++
    if (sinContactar(f)) {
      e.sinContactar++
      const h = (Date.now() - Date.parse(f.traspasadoAt)) / 3_600_000
      if (Number.isFinite(h) && h > e.masViejoSinAtender) e.masViejoSinAtender = h
    }
    porEjec.set(clave, e)
  }
  // Un ejecutivo queda clavado en su propia fila (no ve la del resto).
  if (!verTodo) {
    const mio = [...porEjec.values()].find((e) => norm(e.nombre) === norm(quien) || norm(e.email) === norm(quien))
    ejecF = (mio?.email || mio?.nombre || quien).toLowerCase()
  }
  const ejecs = [...porEjec.values()]
    .filter((e) => verTodo || (e.email || e.nombre || "—").toLowerCase() === ejecF)
    .sort((a, b) => b.sinContactar - a.sinContactar || b.total - a.total)
  const alcance = verTodo ? nuevas : nuevas.filter((f) => (f.vendedorEmail || f.vendedorNombre || "—").toLowerCase() === ejecF)
  const totalT = alcance.length
  const totalAt = alcance.filter(atendida).length
  const totalSin = alcance.filter(sinContactar).length
  const totalNoMedible = alcance.filter((f) => !medible(f)).length
  const totalCot = alcance.filter((f) => f.quoteId).length

  // 4. Chats del espejo que aún no cruzan con un número (transparencia).
  let sinIdentificar = 0
  try {
    const rsi = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?telefono_chat=is.null&es_grupo=eq.false&chat_jid=like.*@lid&enviado_at=gte.${encodeURIComponent(desdeEspejo)}&select=chat_jid&limit=3000`,
      { headers: sup, cache: "no-store" },
    )
    sinIdentificar = new Set(((await rsi.json().catch(() => [])) as Array<{ chat_jid?: string }>).map((f) => String(f.chat_jid || ""))).size
  } catch {}

  const fmtCorto = (iso: string) =>
    iso ? new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—"
  const clp = (n: number) => (n > 0 ? `$${Math.round(n).toLocaleString("es-CL")}` : "—")
  const visibles = ejecF ? alcance.filter((f) => (f.vendedorEmail || f.vendedorNombre || "—").toLowerCase() === ejecF) : alcance
  const rango = (f: FilaTraspaso) => (sinContactar(f) ? 0 : !medible(f) ? 1 : atendida(f) ? 3 : 2)
  const orden = [...visibles].sort((a, b) => rango(a) - rango(b) || Date.parse(a.traspasadoAt) - Date.parse(b.traspasadoAt))
  const qsRango = (extra: Record<string, string>) => {
    const p = new URLSearchParams(qsBase)
    p.set("vista", "traspasos")
    p.set("desde", desde)
    p.set("hasta", hasta)
    for (const [k, v] of Object.entries(extra)) v ? p.set(k, v) : p.delete(k)
    return `?${p.toString()}`
  }
  const atajo = (dias: number, etiqueta: string) => {
    const d = fechaCL(new Date(Date.now() - (dias - 1) * 86_400_000))
    const p = new URLSearchParams(qsBase)
    p.set("vista", "traspasos")
    p.set("desde", d)
    p.set("hasta", hoyCL)
    if (ejecF) p.set("ejec", ejecF)
    const activo = desde === d && hasta === hoyCL
    return `<a href="?${p.toString()}" style="padding:5px 12px;border-radius:8px;border:1px solid ${activo ? "#0284c7" : "#e5e7eb"};background:${activo ? "#e8f4fb" : "#fff"};font-weight:${activo ? 700 : 500}">${etiqueta}</a>`
  }

  const filasHtml = orden
    .map((f) => {
      const at = atendida(f)
      const horas = (Date.now() - Date.parse(f.traspasadoAt)) / 3_600_000
      const estado = cerrado(f)
        ? `<span style="background:#f0faf4;color:#166534;font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">CERRADO</span>`
        : at
        ? `<span style="background:#e7f6ec;color:#166534;font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">CONTACTADO</span>`
        : tocadaPorOtro(f)
          ? `<span style="background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">LO TOMÓ OTRO</span>`
          : !medible(f)
            ? `<span style="background:#f1f3f5;color:#6b7280;font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">SIN ESPEJO</span>`
            : `<span style="background:${horas > 24 ? "#fee2e2" : "#fef9c3"};color:${horas > 24 ? "#b91c1c" : "#854d0e"};font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">SIN CONTACTAR</span>`
      const cotHtml = f.quoteId
        ? `<a href="https://crm.zoho.com/crm/org685875245/tab/CustomModule5/${esc(f.quoteId)}" target="_blank" rel="noopener">cotización</a> <span class="sub">${clp(f.totalClp)}</span>`
        : `<span class="sub">sin cotización</span>`
      const via =
        (f.llamada && posterior(f.llamada, f.traspasadoAt) ? " 📞" : "") +
        (posterior(f.ultNota, f.traspasadoAt) && !posterior(f.ultVendedor, f.traspasadoAt) ? " 📝" : "")
      return (
        `<tr><td>${esc(f.vendedorNombre || f.vendedorEmail || "—")}</td>` +
        `<td>${esc(f.empresa || "—")}<br><a href="https://wa.me/${esc(f.contact)}" target="_blank" rel="noopener" class="sub">+${esc(f.contact)}</a></td>` +
        `<td>${cotHtml}</td>` +
        `<td style="white-space:nowrap">${fmtCorto(f.traspasadoAt)}<br><span class="sub">${horas < 48 ? `hace ${horas.toFixed(0)} h` : `hace ${(horas / 24).toFixed(0)} d`}</span></td>` +
        `<td>${estado}${via}</td>` +
        `<td style="white-space:nowrap">${at ? fmtCorto(f.ultVendedor || f.llamada) : "—"}</td>` +
        `<td style="white-space:nowrap">${fmtCorto(ultimaActividad(f))}</td>` +
        `<td>${f.presentado ? "sí" : '<span class="sub">no</span>'}</td></tr>`
      )
    })
    .join("")

  const tarjetasEjec = ejecs
    .map((e) => {
      const pct = e.total ? Math.round(((e.atendidos + e.porOtro) / e.total) * 100) : 0
      const clave = (e.email || e.nombre || "—").toLowerCase()
      const activo = ejecF === clave
      const cuerpo = e.espejo
        ? `<div style="margin-top:6px"><span style="color:#166534;font-weight:700">${e.atendidos} contactados</span> · <span style="color:${e.sinContactar ? "#b91c1c" : "#6b7280"};font-weight:700">${e.sinContactar} sin contactar</span>${e.porOtro ? ` <span class="sub">· ${e.porOtro} lo tomó otro</span>` : ""}</div>` +
          `<div style="height:6px;border-radius:99px;background:#eef1f4;margin-top:8px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct >= 70 ? "#16a34a" : pct >= 40 ? "#f59e0b" : "#dc2626"}"></div></div>` +
          (e.sinContactar
            ? `<div class="sub" style="margin-top:6px">el más antiguo sin contactar: ${e.masViejoSinAtender < 48 ? `${e.masViejoSinAtender.toFixed(0)} h` : `${(e.masViejoSinAtender / 24).toFixed(0)} d`}</div>`
            : `<div class="sub" style="margin-top:6px">al día 🎉</div>`)
        : `<div style="margin-top:6px"><span style="background:#f1f3f5;color:#4b5563;font-size:11px;padding:2px 9px;border-radius:99px;font-weight:700">SIN ESPEJO</span></div>` +
          `<div class="sub" style="margin-top:6px">su WhatsApp no está espejado: no podemos saber a quién contactó.</div>`
      return (
        `<a href="${qsRango({ ejec: activo ? "" : clave })}" style="display:block;text-decoration:none;color:inherit;border:1px solid ${activo ? "#0284c7" : "#e8eaed"};background:${activo ? "#f0f9ff" : "#fff"};border-radius:12px;padding:12px 14px;min-width:200px">` +
        `<div style="font-weight:700;margin-bottom:6px">${esc(e.nombre)}</div>` +
        `<div style="font-size:22px;font-weight:700">${e.total} <span class="sub" style="font-size:12px;font-weight:500">traspasos</span></div>` +
        `<div class="sub" style="margin-top:4px">${e.conCot} con cotización</div>${cuerpo}</a>`
      )
    })
    .join("")
  const sinEspejo = ejecs.filter((e) => !e.espejo && e.email)

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Traspasos de Vicky</title>
  <style>
    body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f8fa;color:#2d3748}
    .wrap{max-width:1360px;margin:0 auto;padding:18px}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13.5px}
    th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    a{color:#0284c7;text-decoration:none}
    .sub{color:#8a949c;font-size:12px}
    tr:hover td{background:#f8fbfd}
    input[type=date]{border:1px solid #d8dde2;border-radius:8px;padding:5px 8px;font:inherit}
  </style></head><body><div class="wrap">
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap"><img src="/gv/logo-full-color.svg" style="height:28px" alt="">
  <h1 style="margin:0;font-size:20px">🤝 Traspasos de Vicky al equipo</h1>
  <a class="sub" href="?${qsBase}">← volver al dash</a><a class="sub" href="?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qsBase)), vista: "cartera" }).toString()}">📋 Cartera</a></div>

  <div class="card">
    <form method="get" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      ${[...new URLSearchParams(qsBase).entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}
      <input type="hidden" name="vista" value="traspasos">
      ${ejecF ? `<input type="hidden" name="ejec" value="${esc(ejecF)}">` : ""}
      <label class="sub">Desde <input type="date" name="desde" value="${esc(desde)}"></label>
      <label class="sub">Hasta <input type="date" name="hasta" value="${esc(hasta)}"></label>
      <button type="submit" style="padding:6px 16px;border-radius:8px;border:0;background:#0284c7;color:#fff;font-weight:700;cursor:pointer">Ver</button>
      <span style="display:flex;gap:6px;margin-left:6px">${atajo(1, "hoy")}${atajo(7, "7 días")}${atajo(14, "14 días")}${atajo(30, "30 días")}</span>
    </form>
    <div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:14px">
      <div><div style="font-size:26px;font-weight:700">${totalT}</div><div class="sub">traspasos en el período</div></div>
      <div><div style="font-size:26px;font-weight:700">${totalCot}</div><div class="sub">con cotización emitida</div></div>
      <div><div style="font-size:26px;font-weight:700;color:#166534">${totalAt}</div><div class="sub">ya contactados por el ejecutivo</div></div>
      <div><div style="font-size:26px;font-weight:700;color:${totalSin ? "#b91c1c" : "#6b7280"}">${totalSin}</div><div class="sub">sin contactar desde el traspaso</div></div>
      ${totalNoMedible ? `<div><div style="font-size:26px;font-weight:700;color:#6b7280">${totalNoMedible}</div><div class="sub">no medibles (ejecutivo sin espejo)</div></div>` : ""}
      ${devoluciones.length ? `<div><div style="font-size:26px;font-weight:700;color:#6b7280">${devoluciones.length}</div><div class="sub">devoluciones de cartera anterior (fuera de la cuenta)</div></div>` : ""}
    </div>
  </div>
  ${
    sinEspejo.length
      ? `<div class="card" style="border-left:4px solid #f59e0b">
    <h2 style="margin:0 0 6px;font-size:16px">⚠️ ${sinEspejo.length} ejecutivo(s) con el WhatsApp sin espejar</h2>
    <p class="sub" style="margin:0 0 10px">De ellos NO sabemos si contactaron o no: sus mensajes no llegan al sistema. Sus ${sinEspejo.reduce((n, e) => n + e.total, 0)} traspasos del período quedan fuera de la cuenta de "sin contactar".</p>
    <ul style="margin:0 0 10px;padding-left:20px">${sinEspejo.map((e) => `<li><b>${esc(e.nombre)}</b> <span class="sub">${esc(e.email)} · ${e.total} traspasos (${e.conCot} con cotización)</span></li>`).join("")}</ul>
    <a href="?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qsBase)), vista: "espejos" }).toString()}" style="font-weight:700">🪞 Ir a Espejos para vincular el teléfono →</a>
  </div>`
      : ""
  }

  <div class="card"><h2 style="margin:0 0 12px;font-size:16px">Por ejecutivo${ejecF ? ' <span class="sub">· filtrando (clic de nuevo para quitar)</span>' : ""}</h2>
  <div style="display:flex;gap:12px;flex-wrap:wrap">${tarjetasEjec || '<p class="sub">Sin traspasos en el período.</p>'}</div></div>

  <div class="card"><h2 style="margin:0 0 6px;font-size:16px">Detalle (${orden.length}) — sin contactar primero</h2>
  <p class="sub" style="margin:0 0 12px">Quedan fuera las <b>devoluciones de cartera anterior</b>: cuando un cliente viejo reaparece y vuelve a quedar en silencio, el reloj lo devuelve a su dueño de siempre — eso no es una oportunidad entregada esta semana (trato creado más de ${DIAS_ANTIGUO} días antes del traspaso). El ejecutivo de cada fila es el <b>dueño del trato en Zoho</b> (si el trato no existe o sigue en Vicky, el que registró el traspaso). "Contactado" = después del traspaso el ejecutivo <b>a cargo</b> escribió por su WhatsApp espejado, le tomaron una llamada, <b>o dejó una nota en el trato</b> (📝). Las notas de Vicky y del sistema no cuentan: solo las escritas por una persona. "Lo tomó otro" = quien escribió fue otra persona del equipo. "Sin espejo" = su WhatsApp no está espejado y no hay forma de saberlo. "Última actividad" incluye también lo que el cliente responde. "Presentado" = Vicky alcanzó a presentar al ejecutivo por chat (con la ventana de 24 h vencida no se puede).</p>
  <div style="overflow-x:auto"><table><tr><th>Ejecutivo</th><th>Cliente</th><th>Cotización</th><th>Traspasado</th><th>Estado</th><th>1<sup>er</sup> contacto</th><th>Última actividad</th><th>Presentado</th></tr>
  ${filasHtml || '<tr><td colspan="8" class="sub">Sin filas.</td></tr>'}</table></div></div>

  <div class="card"><p class="sub" style="margin:0">Fuente: bitácora de traspasos de Vicky cruzada con el espejo de WhatsApp del equipo.
  ${sinIdentificar ? `<b>${sinIdentificar} chat(s) del espejo</b> aún no tienen número identificado en el período: si alguno de ellos es un cliente de esta lista, su fila puede decir "sin contactar" sin serlo. El worker los va resolviendo solo.` : "Todos los chats del espejo del período están identificados."}
  ${quien && quien !== "Administrador" ? `<br>Sesión: ${esc(quien)}` : ""}</p></div>
  </div></body></html>`
}

async function fetchPrimeraConversacion(): Promise<Map<string, string>> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const primera = new Map<string, string>()
  for (let offset = 0; offset < 20000; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=contact,started_at&order=started_at.asc&limit=1000&offset=${offset}`,
      { headers: h, cache: "no-store" },
    )
    if (!res.ok) break
    const rows = (await res.json().catch(() => [])) as Array<{ contact?: string; started_at?: string }>
    for (const r of rows) {
      const tel = digits(String(r.contact || ""))
      if (tel && r.started_at && !primera.has(tel)) primera.set(tel, String(r.started_at))
    }
    if (rows.length < 1000) break
  }
  return primera
}

const ETAPAS_INBOUND = ["entrantes", "ic", "ce", "ce_sop", "ce_pos", "ce_cob", "nocal", "noid", "precio", "formal", "aceptada", "pagada"] as const
type EtapaInbound = (typeof ETAPAS_INBOUND)[number]
const ETIQUETA_ETAPA_INBOUND: Record<EtapaInbound, string> = {
  entrantes: "Conversación iniciada",
  ic: "Intención comercial",
  ce: "Cliente existente",
  ce_sop: "Cliente/Soporte",
  ce_pos: "Cliente/PostVenta",
  ce_cob: "Cliente/Cobranza",
  nocal: "No califica",
  noid: "No identificado",
  precio: "Vio precio",
  formal: "Formal enviada",
  aceptada: "Aceptada",
  pagada: "Pagada",
}
/** Alias de los links viejos (fotos/bookmarks pre-Bolsa). */
const ETAPA_ALIAS: Record<string, EtapaInbound> = {
  llegaron: "entrantes", comercial: "ic", soporte: "ce_sop", cobranza: "ce_cob", derivada: "ic",
}
/** Elementos del Grupo Foto: `tel` (Bolsa/precio) o `tel~quoteId` (formal/
 * aceptada/pagada — POR COTIZACIÓN, caso Javiera/Vista Kennedy 24-ago: dos
 * empresas de la misma conversación colapsaban en una porque el set dedupeaba
 * por teléfono). */
const telDeElemento = (el: string): string => el.split("~")[0]
const quoteDeElemento = (el: string): string => el.split("~")[1] || ""

type CohortesInbound = { dias: string[]; porDia: Record<EtapaInbound, Map<string, Set<string>>> }

function computarCohortesInbound(params: {
  /** Entradas del RPC vic_entradas_desde. OJO: el feed trae reactivaciones
   * (>=7 días de silencio) pero desde el 26-ago solo se cuenta la PRIMERA
   * entrada de la vida de cada contacto (primer hito para siempre). */
  entradas: Array<{ contact: string; at: string }>
  primeraVez: Map<string, string>
  analysisRows: Row[]
  preformAt: Map<string, string>
  quotes: RawAceptada[]
  toque0: Set<string>
  pais: Pais
  rango: RangoFechas | null
  pagos: Array<{ tel: string; t: number; qid?: string }> | null
}): CohortesInbound {
  const { entradas, primeraVez, analysisRows, preformAt, quotes, toque0, pais, rango, pagos } = params
  const testSet = metricsContactSet()
  const diaDe = (iso: string | null | undefined): string => {
    const t = Date.parse(String(iso || ""))
    if (!Number.isFinite(t)) return ""
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t))
  }
  const DIA_MS = 864e5
  const finMs = rango && rango.hastaMs !== Number.MAX_SAFE_INTEGER ? rango.hastaMs : Date.now()
  const inicioMs = rango && rango.desdeMs > 0 ? rango.desdeMs : finMs - 29 * DIA_MS
  const nDias = Math.min(366, Math.max(1, Math.floor((finMs - inicioMs) / DIA_MS) + 1))
  const dias: string[] = []
  for (let i = nDias - 1; i >= 0; i--) {
    const d = diaDe(new Date(finMs - i * DIA_MS).toISOString())
    if (d && dias[dias.length - 1] !== d) dias.push(d)
  }
  const diasSet = new Set(dias)
  const vacio = () => new Map<string, Set<string>>()
  const porDia: Record<EtapaInbound, Map<string, Set<string>>> = {
    entrantes: vacio(), ic: vacio(), ce: vacio(), ce_sop: vacio(), ce_pos: vacio(), ce_cob: vacio(),
    nocal: vacio(), noid: vacio(), precio: vacio(), formal: vacio(), aceptada: vacio(), pagada: vacio(),
  }
  const anotar = (m: Map<string, Set<string>>, dia: string, tel: string) => {
    if (!diasSet.has(dia)) return
    const set = m.get(dia) || new Set<string>()
    set.add(tel)
    m.set(dia, set)
  }
  // ═══ GRUPO BOLSA (Lalo 19-ago): 4 grupos excluyentes que SUMAN las
  // entrantes del día; cliente_existente se abre en soporte/postventa/
  // cobranza. La clasificación viene del análisis (campo bolsa, taxonomía
  // v2); histórico sin bolsa → se deriva del grupo viejo. Hecho duro:
  // preform o cotización de Vicky fuerzan intención comercial cuando el
  // análisis no la vio (o aún no corre). El primer hito por contacto
  // es PARA SIEMPRE (Lalo 26-ago): nadie vuelve a contar como entrante. ═══
  const bolsaPorTel = new Map<string, { b: string; sub: string | null; at: number }>()
  for (const r of analysisRows) {
    const tel = digits(r.contact)
    const at = Date.parse(String(r.analyzed_at || "")) || 0
    const prev = bolsaPorTel.get(tel)
    if (prev && prev.at > at) continue
    const b = r.bolsa || (r.grupo === "comercial" ? "intencion_comercial" : r.grupo === "soporte" ? "cliente_existente" : "no_identificado")
    const sub = b === "cliente_existente" ? (r.bolsa_sub || "soporte") : null
    bolsaPorTel.set(tel, { b, sub, at })
  }
  const telsConQuoteVicky = new Set<string>()
  for (const q of quotes) {
    const marca = String(q.Intervenci_n_Humana || "")
    if (/intervenci/i.test(marca)) continue
    telsConQuoteVicky.add(digits(String(q.Tel_fono_Contacto || "")))
  }
  // ═══ PRIMER HITO PARA SIEMPRE (Lalo 26-ago): un contacto ENTRA una sola
  // vez en la vida — el día de su primera conversación. Reactivaciones tras
  // ≥7 días, campañas, re-engagement: nada vuelve a contarlo como entrante.
  // Si su primera vez quedó fuera del rango visible, no aparece (correcto:
  // ya fue contado en su día). Fallback sin primeraVez: su entrada más
  // antigua del feed. ═══
  const entradaMasAntigua = new Map<string, string>()
  for (const e of entradas) {
    const tel = digits(e.contact)
    if (!tel) continue
    const d = diaDe(e.at)
    const prev = entradaMasAntigua.get(tel)
    if (d && (!prev || d < prev)) entradaMasAntigua.set(tel, d)
  }
  for (const e of entradas) {
    const tel = digits(e.contact)
    if (!tel || paisDeTelefono(tel) !== pais || isTestContact(tel, testSet)) continue
    // CONVERSACIONES INICIADAS (Lalo 31-ago): antes esta columna se llamaba
    // "Entrantes" y excluía al outbound ("lo tocó la cadencia, no llegó
    // solo"). Con la prospección encendida esa definición dejaba fuera media
    // realidad. Ahora cuenta toda conversación que NACIÓ ese día, la abriera
    // el cliente o la abriera Vicky — y el feed de entradas son mensajes DEL
    // CLIENTE, así que un toque que nadie respondió sigue sin contar: no hay
    // conversación que clasificar. Las 4 bolsas siguen sumando exacto.
    void toque0
    const dia = diaDe(e.at)
    if (!diasSet.has(dia)) continue
    const diaPrimero = diaDe(primeraVez.get(tel) || "") || entradaMasAntigua.get(tel) || dia
    if (dia !== diaPrimero) continue
    anotar(porDia.entrantes, dia, tel)
    const cls = bolsaPorTel.get(tel)
    let b = cls?.b || "no_identificado"
    if (b === "no_identificado" && (preformAt.has(tel) || telsConQuoteVicky.has(tel))) b = "intencion_comercial"
    if (b === "intencion_comercial") anotar(porDia.ic, dia, tel)
    else if (b === "cliente_existente") {
      anotar(porDia.ce, dia, tel)
      const sub = cls?.sub === "postventa" ? "ce_pos" : cls?.sub === "cobranza" ? "ce_cob" : "ce_sop"
      anotar(porDia[sub as EtapaInbound], dia, tel)
    } else if (b === "no_califica") anotar(porDia.nocal, dia, tel)
    else anotar(porDia.noid, dia, tel)
  }
  // ═══ GRUPO FOTO: hitos del día, vengan de la conversación que vengan
  // (outbound incluido — igual que la caja). Precio = sello del preform (o
  // la emisión de la formal, que siempre lleva precio); formal = emisión;
  // aceptada = fecha de aceptación; pagada = pago REAL (registro venta_dash,
  // pasado en params.pagos; fallback por cotización si el registro falla).
  const elegible = (tel: string) => Boolean(tel) && paisDeTelefono(tel) === pais && !isTestContact(tel, testSet)
  // PRIMER PRECIO PARA SIEMPRE (Lalo 26-ago): "vio precio" es el día MÁS
  // ANTIGUO entre el sello del preform y cualquier emisión formal — mostrar
  // un precio actualizado o re-estampar el sello ya no lo corre a un día
  // nuevo. Se junta primero y se anota una sola vez al final.
  const precioDiaPorTel = new Map<string, string>()
  const tomarPrecio = (tel: string, dia: string) => {
    if (!dia) return
    const prev = precioDiaPorTel.get(tel)
    if (!prev || dia < prev) precioDiaPorTel.set(tel, dia)
  }
  for (const [tel, iso] of preformAt) {
    if (!elegible(tel)) continue
    tomarPrecio(tel, diaDe(iso))
  }
  for (const q of quotes) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (!elegible(tel)) continue
    const marca = String(q.Intervenci_n_Humana || "")
    if (/intervenci/i.test(marca)) continue
    if (!/100%/.test(marca)) {
      // Histórico sin marca → regla MATER: la conversación debe existir
      // ANTES de la emisión (si nació después, la venta es del ejecutivo).
      const primeraMs = Date.parse(primeraVez.get(tel) || "")
      const creadaMs = Date.parse(String(q.Created_Time || ""))
      if (Number.isFinite(creadaMs) && (!Number.isFinite(primeraMs) || primeraMs > creadaMs + 3600e3)) continue
    }
    // POR COTIZACIÓN (Lalo 24-ago, "no aparece Kennedy"): el elemento lleva
    // tel~quoteId — dos cotizaciones del mismo fono cuentan como dos hitos y
    // la viñeta nombra a CADA empresa. "Vio precio" sigue por contacto (el
    // precio lo ve la persona, no la cotización).
    const el = `${tel}~${String(q.id || "")}`
    const diaEmision = diaDe(q.Created_Time)
    anotar(porDia.formal, diaEmision, el)
    tomarPrecio(tel, diaEmision)
    const diaAcepta = diaDe(q.Fecha_Hora_Cotizacion || q.Modified_Time)
    if (esAceptadaOMas(q)) anotar(porDia.aceptada, diaAcepta, el)
    if (esPagada(q) && !pagos) anotar(porDia.pagada, diaAcepta, el)
  }
  for (const [tel, dia] of precioDiaPorTel) anotar(porDia.precio, dia, tel)
  if (pagos) {
    for (const pago of pagos) {
      if (!elegible(pago.tel)) continue
      anotar(porDia.pagada, diaDe(new Date(pago.t).toISOString()), pago.qid ? `${pago.tel}~${pago.qid}` : pago.tel)
    }
  }
  return { dias, porDia }
}

function renderInboundDiario(
  c: CohortesInbound,
  opts: {
    rango: RangoFechas | null
    qs: string
    caja?: { cantidad: number; monto: number; detalle: string }
    /** Nombre de empresa por teléfono (para las viñetas). */
    nombres: Map<string, string>
    /** Empresa por quoteId — nombra cada cotización en las viñetas del Grupo
     * Foto (elementos tel~quoteId). */
    nombresQuote?: Map<string, string>
    /** Detalle embebido por teléfono (para el modal instantáneo). */
    detalles: Map<string, { e: string; est: string; ej: string; dot: string; ult: string; acc: string; conv: string; z: string }>
    /** Transcripción embebida por teléfono: [rol c|v, fecha, texto]. */
    trans: Map<string, Array<[string, string, string]>>
    /** Columna "Form Vicky" (Lalo 21-ago): día → [etiqueta, tel discable o ""]
     * de los que llenaron el miniform de las landing ese día. */
    formVicky?: Map<string, Array<[string, string]>>
    /** día → cuántos de esos form-fills llegaron al chat (💬). */
    formConv?: Map<string, number>
    /** tel → nombre de la campaña de marketing del lead (rotula sub-filas). */
    campanas?: Map<string, string>
    /** Tels del form que llegaron al chat (viñeta del paréntesis n💬). */
    formConvTels?: Set<string>
    /** Todos los teléfonos discables del form: marca qué Entrantes vinieron
     * de la landing/sitio (🧲) vs inbound orgánico. */
    formTels?: Set<string>
    /** tel → origen ("🧲 /landing/..." para form-fills); sin entrada = botón
     * directo del sitio web. Alimenta las sub-filas por origen (Lalo 26-ago). */
    origenes?: Map<string, string>
    /** Columna "📋 Formulario" (Lalo 31-ago): día → [etiqueta, tel] de los
     * leads del formulario web que la tómbola asignó a Vicky por el tramo
     * 1-20 y recibieron su toque 0 ese día. */
    outbound?: Map<string, Array<[string, string]>>
    /** día → cuántos recibieron su toque (✓). */
    outboundToc?: Map<string, number>
    /** día → cuántos se entregaron a una SDR sin lograr contacto (↪). */
    outboundReg?: Map<string, number>
    /** Todos los teléfonos del canal outbound: marca qué conversaciones del
     * día nacieron de un toque de Vicky (📋). */
    outboundTels?: Set<string>
  },
): string {
  const { dias: diasCrudos, porDia } = c
  // DESDE EL LUNES 17-AGO (Lalo 26-ago, "quitemos todo lo anterior"): sin un
  // rango elegido por el usuario, la tabla, los totales y las viñetas parten
  // en el 17-ago — lo previo es de otra era operativa y ensucia los números.
  // Con filtro de fechas explícito se respeta lo que el usuario pida.
  const DESDE_TABLA = "2026-08-17"
  const dias = opts.rango ? diasCrudos : diasCrudos.filter((d) => d >= DESDE_TABLA)
  if (!opts.rango) {
    for (const et of ETAPAS_INBOUND) for (const k of [...porDia[et].keys()]) if (k < DESDE_TABLA) porDia[et].delete(k)
    if (opts.formVicky) for (const k of [...opts.formVicky.keys()]) if (k < DESDE_TABLA) opts.formVicky.delete(k)
  }
  const cnt = (etapa: EtapaInbound, dia: string) => porDia[etapa].get(dia)?.size || 0
  const totUnico = (etapa: EtapaInbound) => {
    const u = new Set<string>()
    for (const set of porDia[etapa].values()) for (const t of set) u.add(t)
    return u.size
  }
  const T: Record<EtapaInbound, number> = Object.fromEntries(ETAPAS_INBOUND.map((e) => [e, totUnico(e)])) as Record<EtapaInbound, number>
  const pctDe = (parte: number, base: number) => (base > 0 ? `${Math.round((parte / base) * 100)}%` : "—")
  // Tasa de cierre ACUMULADA desde el lunes 17-ago (Lalo 26-ago): ancla FIJA,
  // independiente del rango visible — pagadas (por cotización) ÷ vieron precio
  // (por contacto), sumando solo los días desde el ancla. La foto sin filtros
  // trae 30 días, así que el ancla siempre queda cubierta; con un filtro que
  // parta después del ancla, acumula desde donde hay data.
  const ANCLA_CIERRE = "2026-08-17"
  const unicosDesdeAncla = (etapa: EtapaInbound) => {
    const u = new Set<string>()
    for (const [dia, set] of porDia[etapa]) if (dia >= ANCLA_CIERRE) for (const t of set) u.add(t)
    return u.size
  }
  const precioAcum = unicosDesdeAncla("precio")
  const pagadaAcum = unicosDesdeAncla("pagada")
  // TASA ESTRICTA entre paréntesis (Lalo 27-ago): la principal cuenta todo
  // pago del período aunque su precio se haya mostrado antes del ancla (es el
  // objetivo declarado de las campañas: subir la tasa de LA SEMANA). La
  // estricta trae al denominador a esos pagadores de siembra vieja — misma
  // población arriba y abajo, jamás inflable. Las dos miradas, sin elegir.
  const telsPrecioAncla = new Set<string>()
  for (const [dia, set] of porDia.precio) if (dia >= ANCLA_CIERRE) for (const t of set) telsPrecioAncla.add(telDeElemento(t))
  const pagadoresViejos = new Set<string>()
  for (const [dia, set] of porDia.pagada)
    if (dia >= ANCLA_CIERRE)
      for (const el of set) {
        const t = telDeElemento(el)
        if (!telsPrecioAncla.has(t)) pagadoresViejos.add(t)
      }
  const baseEstricta = precioAcum + pagadoresViejos.size
  const tasaAcumHtml =
    precioAcum > 0
      ? `<div class="sub" style="margin:0 0 10px;padding:8px 10px;background:#eef4ff;border-radius:8px">🎯 <b>Tasa de cierre acumulada desde el lun 17-ago:</b> <b>${Math.round((pagadaAcum / precioAcum) * 100)}%</b> — ${pagadaAcum} pagada${pagadaAcum === 1 ? "" : "s"} ÷ ${precioAcum} que vieron precio` +
        (pagadoresViejos.size > 0
          ? ` <span style="color:#6b7280">(estricta: <b>${Math.round((pagadaAcum / baseEstricta) * 100)}%</b> — sumando al denominador ${pagadoresViejos.size} pagador${pagadoresViejos.size === 1 ? "" : "es"} que vieron precio antes del 17)</span>`
          : "") +
        `</div>`
      : ""
  const nombreDia = (d: string) => {
    const wd = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "short" }).format(new Date(`${d}T12:00:00-04:00`))
    return `${wd} ${d.slice(8, 10)}-${d.slice(5, 7)}`
  }
  // ── Viñetas + detalle EMBEBIDOS (Lalo 19-ago: "cualquier interacción debe
  // ser rápida") — el hover y el clic al detalle no tocan la red: los datos
  // viajan dentro de la foto.
  const nom = (tel: string) => opts.nombres.get(tel) || `+${tel}`
  // Elemento tel~quoteId → nombre de ESA cotización (dos empresas del mismo
  // fono se muestran ambas); el modal/detalle sigue por teléfono pelado.
  const nomEl = (el: string) => {
    const qid = quoteDeElemento(el)
    return (qid && opts.nombresQuote?.get(qid)) || nom(telDeElemento(el))
  }
  const VIN: Record<string, Record<string, Array<[string, string]>>> = {}
  for (const et of ETAPAS_INBOUND) {
    VIN[et] = {}
    for (const [dia, tels] of porDia[et]) {
      VIN[et][dia] = [...tels].map((t) => [nomEl(t), telDeElemento(t)] as [string, string]).sort((a, b) => a[0].localeCompare(b[0]))
    }
    VIN[et]["TOTAL"] = (() => {
      const u = new Map<string, string>()
      for (const tels of porDia[et].values()) for (const t of tels) u.set(t, nomEl(t))
      return [...u].map(([t, n]) => [n, telDeElemento(t)] as [string, string]).sort((a, b) => a[0].localeCompare(b[0]))
    })()
  }
  // Columna "Form Vicky" (Lalo 21-ago): llenaron el miniform ese día. La
  // viñeta lista nombres; con teléfono discable abre el detalle como las
  // demás, sin teléfono queda como texto. El número linkea a la tabla
  // detalle del form (#formlanding), más abajo en la misma página.
  const fv = opts.formVicky || new Map<string, Array<[string, string]>>()
  VIN["form"] = {}
  for (const [dia, lista] of fv) VIN["form"][dia] = [...lista].sort((a, b) => a[0].localeCompare(b[0]))
  VIN["form"]["TOTAL"] = [...fv.values()].flat().sort((a, b) => a[0].localeCompare(b[0]))
  const fvTotal = VIN["form"]["TOTAL"].length
  const fvConvTotal = [...(opts.formConv || new Map<string, number>()).values()].reduce((a, n) => a + n, 0)
  const celdaForm = (d: string) => {
    const v = d === "TOTAL" ? fvTotal : (fv.get(d) || []).length
    if (v <= 0) return `<td style="text-align:center;color:#c8cdd3">0</td>`
    const conv = d === "TOTAL" ? fvConvTotal : opts.formConv?.get(d) || 0
    const sufijo = conv > 0 ? ` <span class="subpop" data-et="formconv" data-dia="${d}" style="font-size:11px;color:#15803d;white-space:nowrap;cursor:pointer">(${conv}💬)</span>` : ""
    return `<td class="conpop" data-et="form" data-dia="${d}" style="text-align:center;white-space:nowrap"><a href="#formlanding" style="border-bottom:1px dashed #bcd9ea"><b>${v}</b></a>${sufijo}</td>`
  }
  // Columna "📋 Formulario" (Lalo 31-ago): leads del formulario web asignados
  // a Vicky por el tramo 1-20 que recibieron su toque 0 ese día. Mismo formato
  // que Form Vicky — el (n💬) es cuántos de esos respondieron.
  const ob = opts.outbound || new Map<string, Array<[string, string]>>()
  VIN["outb"] = {}
  for (const [dia, lista] of ob) VIN["outb"][dia] = [...lista].sort((a, b) => a[0].localeCompare(b[0]))
  VIN["outb"]["TOTAL"] = [...ob.values()].flat().sort((a, b) => a[0].localeCompare(b[0]))
  const obTotal = VIN["outb"]["TOTAL"].length
  const suma = (m?: Map<string, number>) => [...(m || new Map<string, number>()).values()].reduce((a, n) => a + n, 0)
  const obTocTotal = suma(opts.outboundToc)
  const obRegTotal = suma(opts.outboundReg)
  // Viñetas de los PARÉNTESIS (Lalo 31-ago): cada sub-número tiene su propio
  // listado al pasar el mouse — subconjuntos de las listas ya armadas.
  const subLista = (base: Record<string, Array<[string, string]>>, pred: (par: [string, string]) => boolean) => {
    const out: Record<string, Array<[string, string]>> = {}
    for (const [dia, lista] of Object.entries(base || {})) out[dia] = lista.filter(pred)
    return out
  }
  VIN["formconv"] = subLista(VIN["form"], (p) => !!p[1] && !!opts.formConvTels?.has(p[1]))
  VIN["outbtoc"] = subLista(VIN["outb"], (p) => p[0].startsWith("💬"))
  VIN["outbreg"] = subLista(VIN["outb"], (p) => p[0].startsWith("↪"))
  VIN["convform"] = subLista(VIN["entrantes"], (p) => !!p[1] && !!opts.formTels?.has(p[1]))
  VIN["convoutb"] = subLista(VIN["entrantes"], (p) => !!p[1] && !!opts.outboundTels?.has(p[1]))
  const celdaOutbound = (d: string) => {
    const v = d === "TOTAL" ? obTotal : (ob.get(d) || []).length
    if (v <= 0) return `<td style="text-align:center;color:#c8cdd3">0</td>`
    const toc = d === "TOTAL" ? obTocTotal : opts.outboundToc?.get(d) || 0
    const reg = d === "TOTAL" ? obRegTotal : opts.outboundReg?.get(d) || 0
    const partes = [
      toc > 0 ? `<span class="subpop" data-et="outbtoc" data-dia="${d}" style="color:#15803d;cursor:pointer" title="Contactados: les salió el toque de Vicky">${toc}💬</span>` : "",
      reg > 0 ? `<span class="subpop" data-et="outbreg" data-dia="${d}" style="color:#b45309;cursor:pointer" title="Entregados a una SDR sin lograr contacto — pasa el mouse para ver a quién">${reg}↪</span>` : "",
    ].filter(Boolean)
    const sufijo = partes.length ? ` <span style="font-size:11px;white-space:nowrap">(${partes.join(" · ")})</span>` : ""
    return `<td class="conpop" data-et="outb" data-dia="${d}" style="text-align:center;white-space:nowrap"><b>${v}</b>${sufijo}</td>`
  }
  /** Conversaciones del día que nacieron de un toque de Vicky (📋). */
  const entrantesDeOutbound = (d: string) => {
    if (!opts.outboundTels?.size) return 0
    if (d === "TOTAL") {
      const u = new Set<string>()
      for (const set of porDia.entrantes.values()) for (const t of set) if (opts.outboundTels.has(t)) u.add(t)
      return u.size
    }
    let n = 0
    for (const t of porDia.entrantes.get(d) || []) if (opts.outboundTels.has(t)) n++
    return n
  }
  // Entrantes que vinieron del form (🧲): match por teléfono contra TODOS los
  // form-fills (el fill puede ser de un día anterior al chat).
  const entrantesDeForm = (d: string) => {
    if (!opts.formTels?.size) return 0
    if (d === "TOTAL") {
      const u = new Set<string>()
      for (const set of porDia.entrantes.values()) for (const t of set) if (opts.formTels.has(t)) u.add(t)
      return u.size
    }
    let n = 0
    for (const t of porDia.entrantes.get(d) || []) if (opts.formTels.has(t)) n++
    return n
  }
  const DET: Record<string, { e: string; est: string; ej: string; dot: string; ult: string; acc: string; conv: string; z: string }> = {}
  const TRS: Record<string, Array<[string, string, string]>> = {}
  for (const et of [...ETAPAS_INBOUND, "form", "outb"] as string[]) for (const lista of Object.values(VIN[et])) for (const [, t] of lista) {
    if (!t) continue
    if (!DET[t]) DET[t] = opts.detalles.get(t) || { e: nom(t), est: "—", ej: "—", dot: "s/d", ult: "", acc: "", conv: "", z: "" }
    if (!TRS[t] && opts.trans.has(t)) TRS[t] = opts.trans.get(t)!
  }
  // JSON seguro para vivir dentro de <script>: sin "</script>" posibles.
  const jsonSeguro = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")
  // Desglose inbound/outbound de una etapa en un día (Lalo 01-sep): elementos
  // únicos partidos por si el CONTACTO nació de un toque outbound
  // (vic_outbound_cadence, criterio inmutable del funnel).
  const partirInOut = (etapa: EtapaInbound, dia: string): { ins: number; out: number } => {
    const lista = dia === "TOTAL" ? [...porDia[etapa].values()].flatMap((s) => [...s]) : [...(porDia[etapa].get(dia) || [])]
    const u = new Set(lista)
    let out = 0
    for (const el of u) if (opts.outboundTels?.has(telDeElemento(el))) out++
    return { ins: u.size - out, out }
  }
  const celda = (dia: string, etapa: EtapaInbound, cls = "") => {
    const v = cnt(etapa, dia)
    if (v <= 0) return `<td class="${cls}" style="text-align:center;color:#c8cdd3">0</td>`
    const deForm = etapa === "entrantes" ? entrantesDeForm(dia) : 0
    const deOut = etapa === "entrantes" ? entrantesDeOutbound(dia) : 0
    const partes = [
      deForm > 0 ? `<span class="subpop" data-et="convform" data-dia="${dia}" style="cursor:pointer">${deForm}🧲</span>` : "",
      deOut > 0 ? `<span class="subpop" data-et="convoutb" data-dia="${dia}" style="cursor:pointer">${deOut}📋</span>` : "",
    ].filter(Boolean)
    let sufijo = partes.length ? ` <span style="font-size:11px;color:#0e7490;white-space:nowrap">(${partes.join(" · ")})</span>` : ""
    // % DE CIERRE POR ORIGEN (Lalo 01-sep): junto a FORMALES el conteo por
    // origen (in = inbound, out = outbound); junto a PAGADAS el CIERRE de
    // cada origen = pagadas ÷ formales de ese origen en el mismo día.
    if ((etapa === "formal" || etapa === "pagada") && opts.outboundTels?.size) {
      // Composición por tipo de conversación (Lalo 01-sep): dos porcentajes
      // que suman 100 — qué parte del número es inbound y qué parte outbound.
      const x = partirInOut(etapa, dia)
      const tot = x.ins + x.out
      if (tot > 0) {
        const pin = Math.round((x.ins * 100) / tot)
        sufijo = ` <span style="font-size:11px;color:#6b7280;white-space:nowrap" title="Tipo de conversación: % inbound · % outbound (suman 100)">(${pin}% in · ${100 - pin}% out)</span>`
      }
    }
    return `<td class="conpop ${cls}" data-et="${etapa}" data-dia="${dia}" style="text-align:center${sufijo ? ";white-space:nowrap" : ""}"><a href="?${opts.qs}&inbdet=${encodeURIComponent(dia)}&inbEtapa=${etapa}" style="border-bottom:1px dashed #bcd9ea"><b>${v}</b></a>${sufijo}</td>`
  }
  // ── SUB-FILAS POR ORIGEN (Lalo 26-ago): cada día se despliega con una
  // flechita en filas por origen — "Sitio web" (botón directo, sin form) y
  // una por cada LANDING del miniform (Landing_Page del lead). El origen es
  // por CONTACTO: aplica a todas sus etapas del día.
  const ORIGEN_WEB = "🌐 Sitio web (botón directo)"
  const origenDe = (el: string) => opts.origenes?.get(telDeElemento(el)) || ORIGEN_WEB
  const origenesDelDia = (d: string): string[] => {
    const set = new Set<string>()
    for (const et of ETAPAS_INBOUND) {
      const tels = d === "TOTAL" ? [...porDia[et].values()].flatMap((s) => [...s]) : [...(porDia[et].get(d) || [])]
      for (const t of tels) set.add(origenDe(t))
    }
    const rango = (o: string) =>
      o === ORIGEN_WEB ? 0 : o.startsWith("🧲💰") ? 1 : o.startsWith("🧲🌱") ? 2 : o.startsWith("🧲🔗") ? 3 : o.startsWith("🧲") ? 4 : 5
    return [...set].sort((a, b) => rango(a) - rango(b) || a.localeCompare(b))
  }
  const cntOrigen = (etapa: EtapaInbound, d: string, origen: string): number => {
    const tels = d === "TOTAL" ? [...porDia[etapa].values()].flatMap((s) => [...s]) : [...(porDia[etapa].get(d) || [])]
    const u = new Set<string>()
    for (const t of tels) if (origenDe(t) === origen) u.add(t)
    return u.size
  }
  const claseDia = (d: string) => `ofila-${d.replace(/[^0-9A-Za-z-]/g, "")}`
  const flechaOrigen = (d: string): string => {
    if (!opts.origenes) return ""
    if (origenesDelDia(d).length === 0) return ""
    return `<button class="oarrow" data-odia="${claseDia(d)}" title="Desglosar por origen (sitio web vs landings)" style="border:0;background:none;cursor:pointer;color:#00aff2;font-size:12px;padding:0 4px 0 0">▸</button>`
  }
  // Nombre legible de una landing a partir del path (Lalo 31-ago): se botan
  // los prefijos de idioma/país y los guiones — "/es-cl/marcaje/reloj-control/"
  // → "Marcaje · Reloj control"; "/es-cl/" → "Home".
  const nombreLanding = (path: string): string => {
    const segs = path.split("/").filter(Boolean).filter((sg) => !/^es(-[a-z]{2})?$/i.test(sg))
    if (!segs.length) return "Home"
    return segs.map((sg) => {
      const limpio = sg.replace(/-/g, " ").trim()
      return limpio.charAt(0).toUpperCase() + limpio.slice(1)
    }).join(" · ")
  }
  // Campañas de marketing (Campaign del lead) de los contactos de esa fila.
  const campanasDe = (d: string, origen: string): string[] => {
    if (!opts.campanas?.size) return []
    const u = new Set<string>()
    for (const et of ETAPAS_INBOUND) {
      const tels = d === "TOTAL" ? [...porDia[et].values()].flatMap((sx) => [...sx]) : [...(porDia[et].get(d) || [])]
      for (const t of tels) {
        if (origenDe(t) !== origen) continue
        const c = opts.campanas.get(telDeElemento(t))
        if (c) u.add(c)
      }
    }
    return [...u].sort()
  }
  const CHIP_FUENTE: Record<string, string> = {
    "💰": `<span title="Tráfico PAGADO (Lead Source Google Ads / DB Source Paid Media)" style="background:#fdf2d0;color:#8a5a00;border-radius:6px;padding:0 5px;font-size:11px">💰 Pagado</span>`,
    "🌱": `<span title="Tráfico ORGÁNICO (Lead Source SEO / AI / blog)" style="background:#e2f5e5;color:#1b5e20;border-radius:6px;padding:0 5px;font-size:11px">🌱 Orgánico</span>`,
    "🔗": `<span title="Tráfico DIRECTO (Lead Source Direct)" style="background:#e8eef5;color:#334155;border-radius:6px;padding:0 5px;font-size:11px">🔗 Directo</span>`,
    "❔": `<span title="Lead Source sin categoría conocida" style="background:#eee;color:#555;border-radius:6px;padding:0 5px;font-size:11px">❔ Otro</span>`,
  }
  const etiquetaOrigen = (d: string, o: string): string => {
    if (!o.startsWith("🧲")) return esc(o)
    const cat = [..."💰🌱🔗❔"].find((c) => o.startsWith(`🧲${c}`)) || ""
    const chip = cat ? ` ${CHIP_FUENTE[cat]}` : ""
    const resto = o.replace(/^🧲[💰🌱🔗❔]?\s*/u, "").trim()
    if (!resto.startsWith("/")) return `🧲${chip} ${esc(resto)}`
    const path = resto
    const url = `https://geovictoria.com${path.startsWith("/") ? path : `/${path}`}`
    const camps = campanasDe(d, o)
    const sufijoCamp = camps.length
      ? ` <span style="color:#8a5a00" title="Campaña de marketing (campo Campaign del lead)">📣 ${esc(camps.slice(0, 2).join(", "))}${camps.length > 2 ? ` +${camps.length - 2}` : ""}</span>`
      : ""
    return `🧲${chip} <a href="${url}" target="_blank" rel="noopener" title="${esc(path)} — abrir la landing" style="color:#0e7490;border-bottom:1px dashed #9fc3d0">${esc(nombreLanding(path))}</a>${sufijoCamp}`
  }
  const subFilasOrigen = (d: string): string => {
    if (!opts.origenes) return ""
    const origenes = origenesDelDia(d)
    if (origenes.length === 0) return ""
    return origenes
      .map((o) => {
        const c = (et: EtapaInbound, cls = "") => {
          const v = cntOrigen(et, d, o)
          return `<td class="${cls}" style="text-align:center;color:${v > 0 ? "#374151" : "#d4d8dd"}">${v}</td>`
        }
        const pagO = cntOrigen("pagada", d, o)
        const precioO = cntOrigen("precio", d, o)
        return `<tr class="ofila ${claseDia(d)}" style="display:none;background:#f7fafc;font-size:12px">
      <td style="padding-left:22px;white-space:nowrap;color:#4b5563">${etiquetaOrigen(d, o)}</td>
      <td style="text-align:center;color:#c8cdd3">—</td><td style="text-align:center;color:#c8cdd3">—</td>${c("entrantes")}${c("ic")}${c("ce")}${c("ce_sop", "sube")}${c("ce_pos", "sube")}${c("ce_cob", "sube")}${c("nocal")}${c("noid")}
      ${c("precio", "divi")}${c("formal")}${c("aceptada")}${c("pagada")}
      <td style="text-align:center;color:#6b7280">${pctDe(pagO, precioO)}</td>
    </tr>`
      })
      .join("")
  }
  const filas = [...dias].reverse().map((d) => {
    const pag = cnt("pagada", d)
    const vioPrecio = cnt("precio", d)
    return `<tr>
      <td style="white-space:nowrap">${flechaOrigen(d)}${nombreDia(d)}</td>
      ${celdaForm(d)}${celdaOutbound(d)}${celda(d, "entrantes")}${celda(d, "ic")}${celda(d, "ce")}${celda(d, "ce_sop", "sube")}${celda(d, "ce_pos", "sube")}${celda(d, "ce_cob", "sube")}${celda(d, "nocal")}${celda(d, "noid")}
      ${celda(d, "precio", "divi")}${celda(d, "formal")}${celda(d, "aceptada")}${celda(d, "pagada")}
      <td style="text-align:center;color:${pag > 0 ? "#1b5e20" : "#9aa0a8"}">${pctDe(pag, vioPrecio)}</td>
    </tr>${subFilasOrigen(d)}`
  }).join("")
  const filaTotal = `<tr style="border-top:2px solid #c9ced4;background:#fafbfc;font-weight:700">
    <td><b>TOTAL</b></td>
    ${celda("TOTAL", "entrantes")}${celda("TOTAL", "ic")}${celda("TOTAL", "ce")}${celda("TOTAL", "ce_sop", "sube")}${celda("TOTAL", "ce_pos", "sube")}${celda("TOTAL", "ce_cob", "sube")}${celda("TOTAL", "nocal")}${celda("TOTAL", "noid")}
    ${celda("TOTAL", "precio", "divi")}${celda("TOTAL", "formal")}${celda("TOTAL", "aceptada")}${celda("TOTAL", "pagada")}
    <td style="text-align:center"><b>${pctDe(T.pagada, T.precio)}</b></td>
  </tr>`
  // celda("TOTAL", …) cuenta 0 (no hay día TOTAL en porDia) — parche: filas
  // TOTAL con los únicos del período y viñeta inbdet=TOTAL.
  const celdaTotal = (etapa: EtapaInbound, cls = "") => {
    const v = T[etapa]
    if (v <= 0) return `<td class="${cls}" style="text-align:center;color:#c8cdd3">0</td>`
    const deForm = etapa === "entrantes" ? entrantesDeForm("TOTAL") : 0
    const deOut = etapa === "entrantes" ? entrantesDeOutbound("TOTAL") : 0
    const partes = [
      deForm > 0 ? `<span class="subpop" data-et="convform" data-dia="TOTAL" style="cursor:pointer">${deForm}🧲</span>` : "",
      deOut > 0 ? `<span class="subpop" data-et="convoutb" data-dia="TOTAL" style="cursor:pointer">${deOut}📋</span>` : "",
    ].filter(Boolean)
    let sufijo = partes.length ? ` <span style="font-size:11px;color:#0e7490;white-space:nowrap">(${partes.join(" · ")})</span>` : ""
    // Mismo desglose in/out del período completo (Lalo 01-sep).
    if ((etapa === "formal" || etapa === "pagada") && opts.outboundTels?.size) {
      const x = partirInOut(etapa, "TOTAL")
      const tot = x.ins + x.out
      if (tot > 0) {
        const pin = Math.round((x.ins * 100) / tot)
        sufijo = ` <span style="font-size:11px;color:#6b7280;white-space:nowrap" title="Tipo de conversación: % inbound · % outbound (suman 100)">(${pin}% in · ${100 - pin}% out)</span>`
      }
    }
    return `<td class="conpop ${cls}" data-et="${etapa}" data-dia="TOTAL" style="text-align:center${partes.length ? ";white-space:nowrap" : ""}"><a href="?${opts.qs}&inbdet=TOTAL&inbEtapa=${etapa}"><b>${v}</b></a>${sufijo}</td>`
  }
  const filaTotalOk = `<tr style="border-top:2px solid #c9ced4;background:#fafbfc;font-weight:700">
    <td>${flechaOrigen("TOTAL")}<b>TOTAL</b></td>
    ${celdaForm("TOTAL")}${celdaOutbound("TOTAL")}${celdaTotal("entrantes")}${celdaTotal("ic")}${celdaTotal("ce")}${celdaTotal("ce_sop", "sube")}${celdaTotal("ce_pos", "sube")}${celdaTotal("ce_cob", "sube")}${celdaTotal("nocal")}${celdaTotal("noid")}
    ${celdaTotal("precio", "divi")}${celdaTotal("formal")}${celdaTotal("aceptada")}${celdaTotal("pagada")}
    <td style="text-align:center"><b>${pctDe(T.pagada, T.precio)}</b></td>
  </tr>${subFilasOrigen("TOTAL")}`
  void filaTotal
  return `<div class="card"><h2>📥 Actividad inbound por día <span class="pct" style="font-weight:400">— ${opts.rango ? esc(opts.rango.etiqueta) : "últimos 30 días"} · Bolsa y Foto</span></h2>
  <div class="sub" style="margin:2px 0 10px"><b>${T.entrantes}</b> conversaciones iniciadas · ${T.ic} con intención comercial (${pctDe(T.ic, T.entrantes)}) · ${T.ce} de clientes existentes (${T.ce_sop} soporte / ${T.ce_pos} postventa / ${T.ce_cob} cobranza) · ${T.nocal} no califican · ${T.noid} sin identificar — Foto: ${T.precio} vieron precio · ${T.formal} formales · ${T.aceptada} aceptadas · <b>${T.pagada} pagadas</b></div>
  ${opts.caja ? `<div class="sub" style="margin:0 0 10px;padding:8px 10px;background:#f0faf4;border-radius:8px">💰 <b>Caja del período (canal Vicky, inbound + outbound)</b>: ${opts.caja.cantidad} pago${opts.caja.cantidad === 1 ? "" : "s"} · <b>$${opts.caja.monto.toLocaleString("es-CL")}</b>${opts.caja.detalle ? ` — ${opts.caja.detalle}` : ""}</div>` : ""}
  ${tasaAcumHtml}
  <style>
    th.sube,td.sube{background:#fbf9ff}
    th.sube{color:#7c3aed;font-weight:600;font-size:11.5px}
    .divi{border-left:2px solid #e5e7eb}
    th.gb{background:#f0f7fc;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6b7280}
    th.gf{background:#fff8e8;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6b7280}
    #inbpop{position:absolute;display:none;z-index:70;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.15);min-width:230px;max-width:330px;max-height:280px;overflow-y:auto;padding:6px 0}
    #inbpop .t{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;padding:4px 14px 6px;border-bottom:1px solid #f0f1f3}
    #inbpop a{display:block;padding:6px 14px;font-size:13px;font-weight:600;color:#4e4e4e;text-decoration:none}
    #inbpop a:hover{background:#f0f9ff;color:#00aff2}
    #inbdet-modal{position:fixed;inset:0;display:none;z-index:80;background:rgba(30,35,40,.45);align-items:center;justify-content:center}
    #inbdet-modal .m{background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.25);width:min(92vw,520px);max-height:82vh;overflow-y:auto;padding:20px 24px}
    #inbdet-modal h3{margin:0 0 10px;font-size:17px}
    #inbdet-modal table{width:100%;border-collapse:collapse;font-size:13.5px}
    #inbdet-modal td{padding:5px 8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
    #inbdet-modal td:first-child{color:#6b7280;white-space:nowrap;width:34%}
    #inbdet-modal .x{float:right;cursor:pointer;border:0;background:#f3f4f6;border-radius:8px;padding:4px 10px;font-weight:700}
    #inbdet-modal .vertrans{margin-top:12px;width:100%;padding:9px;border:0;border-radius:10px;background:#00aff2;color:#fff;font-weight:700;cursor:pointer}
    #inbchat{display:none;margin-top:12px;max-height:340px;overflow-y:auto;background:#eef2f5;border-radius:12px;padding:12px}
    #inbchat .bb{max-width:82%;margin:5px 0;padding:7px 11px;border-radius:12px;font-size:13px;white-space:pre-wrap;word-break:break-word}
    #inbchat .bc{background:#d9fdd3;margin-left:auto;border-bottom-right-radius:3px}
    #inbchat .bv{background:#fff;margin-right:auto;border-bottom-left-radius:3px}
    #inbchat .bt{font-size:10.5px;color:#8a949c;margin-top:3px}
    @media (max-width: 720px){
      #inbdet-modal .m{width:96vw;max-height:88vh;padding:14px 14px}
      #inbpop{max-width:92vw}
      .card table th, .card table td{padding:5px 6px;font-size:12px}
    }
  </style>
  <div style="overflow-x:auto;margin-top:8px"><table><thead>
  <tr><th></th><th colspan="10" class="gb">🎒 Grupo Bolsa · llegadas del día (nueva o reactivada tras ≥7 días de silencio)</th><th colspan="5" class="gf divi">📸 Grupo Foto · hitos del día</th></tr>
  <tr>
    <th>Día</th><th style="text-align:center">🧲 Form Inbound</th><th style="text-align:center">📋 Form Outbound</th><th style="text-align:center">Conversaciones iniciadas</th><th style="text-align:center">Intención comercial</th><th style="text-align:center">Cliente existente</th><th style="text-align:center" class="sube">· Soporte</th><th style="text-align:center" class="sube">· PostVenta</th><th style="text-align:center" class="sube">· Cobranza</th><th style="text-align:center">No califica</th><th style="text-align:center">No identificado</th>
    <th style="text-align:center" class="divi">Vio precio</th><th style="text-align:center">Formal enviada</th><th style="text-align:center">Aceptada</th><th style="text-align:center">💰 Pagada</th><th style="text-align:center">Cierre del día</th>
  </tr></thead><tbody>${filas}${filaTotalOk}</tbody></table></div>
  <div class="sub" style="margin:8px 0 0">FORM INBOUND: llenaron el miniform (landing o sitio web) ese día, con o sin conversación después — el (n💬) es cuántos de esos llegaron al chat; clic en el número lleva al detalle del form, más abajo. FORM OUTBOUND: leads del formulario web grande que la tómbola ASIGNÓ a Vicky por el tramo 1-20 ese día (foto inmutable al asignarse) — el paréntesis desglosa en qué terminó cada uno: 💬 contactados (les salió el toque) y ↪ entregados a una SDR sin lograr contacto — al pasar el mouse por el número se ve cada empresa y, en los ↪, a qué ejecutiva se entregó. Cuántos RESPONDIERON se lee en el (n📋) de Conversaciones iniciadas. CONVERSACIONES INICIADAS: las que NACIERON ese día, las abriera el cliente o las abriera Vicky; el paréntesis dice de qué formulario venían (n🧲 · n📋) y lo que no aparece llegó por su cuenta. Un toque que nadie respondió no cuenta acá: no hay conversación que clasificar. BOLSA: los 4 grupos son excluyentes y suman EXACTAMENTE las Conversaciones iniciadas del día; los 3 subgrupos (· morados) suman Cliente existente. El PRIMER hito por contacto es para siempre: reactivaciones, campañas, precios re-mostrados o cotizaciones re-enviadas NO vuelven a contar en un día nuevo. La clasificación puede moverse de grupo mientras la conversación se enriquece (el total de Conversaciones iniciadas no cambia). FOTO: hitos del día venga de donde venga la conversación (outbound incluido); pagada = pago confirmado en Zoho. Canal ejecutivo y contactos internos quedan fuera. Cierre del día = pagadas ÷ vieron precio ese día. Hora de Chile. Pasa el MOUSE por un número para ver sus empresas — los números de los PARÉNTESIS también tienen su viñeta con el detalle; clic en una empresa = detalle al instante; clic en el número = listado completo.</div>
  <div id="inbdet-modal"><div class="m"><button class="x" onclick="document.getElementById('inbdet-modal').style.display='none'">✕ cerrar</button><div id="inbdet-cuerpo"></div></div></div>
  <script>
  (function () {
    var VIN = ${jsonSeguro(VIN)};
    var DET = ${jsonSeguro(DET)};
    var TRS = ${jsonSeguro(TRS)};
    var ETQ = ${jsonSeguro({ ...ETIQUETA_ETAPA_INBOUND, form: "🧲 Form Inbound (llenaron el miniform)", outb: "📋 Form Outbound · tramo Vicky (toque 0 de Vicky)", formconv: "🧲💬 Form Inbound que llegaron al chat", outbtoc: "📋💬 Form Outbound contactados (les salió el toque)", outbreg: "📋↪ Form Outbound entregados a una SDR", convform: "Conversaciones venidas del Form Inbound 🧲", convoutb: "Conversaciones venidas del Form Outbound 📋" })};
    var pop = document.createElement("div"); pop.id = "inbpop"; document.body.appendChild(pop);
    // Flechitas de origen (Lalo 26-ago): despliegan las sub-filas por origen
    // (sitio web vs cada landing) del día.
    document.querySelectorAll(".oarrow").forEach(function (b) {
      b.addEventListener("click", function () {
        var abierto = b.textContent === "▾";
        b.textContent = abierto ? "▸" : "▾";
        document.querySelectorAll("tr." + b.getAttribute("data-odia")).forEach(function (tr) {
          tr.style.display = abierto ? "none" : "table-row";
        });
      });
    });
    var timer = null;
    function abrir(td) {
      clearTimeout(timer);
      var et = td.getAttribute("data-et"), dia = td.getAttribute("data-dia");
      var lista = (VIN[et] || {})[dia] || [];
      var html = '<div class="t">' + (ETQ[et] || et) + " · " + (dia === "TOTAL" ? "período" : dia) + " · " + lista.length + "</div>";
      lista.slice(0, 30).forEach(function (par) {
        // Sin teléfono discable (form sin fono) no hay detalle que abrir.
        if (par[1]) html += '<a href="#" data-tel="' + par[1] + '">' + par[0] + "</a>";
        else html += '<a href="#formlanding">' + par[0] + " ⚠️</a>";
      });
      // La ancla del TD padre (si existe) da el "listado completo"; la celda
      // 📋 y los sub-números del paréntesis no siempre la tienen.
      var tdBase = td.closest ? (td.closest("td") || td) : td;
      var ancla = tdBase.querySelector ? tdBase.querySelector("a[href]") : null;
      if (lista.length > 30) html += ancla ? '<a href="' + ancla.getAttribute("href") + '">… y ' + (lista.length - 30) + " más</a>" : '<div class="t">… y ' + (lista.length - 30) + " más</div>";
      if (ancla) html += '<a href="' + ancla.getAttribute("href") + '" style="color:#00aff2">📄 listado completo →</a>';
      pop.innerHTML = html;
      pop.querySelectorAll("a[data-tel]").forEach(function (a) {
        a.addEventListener("click", function (ev) { ev.preventDefault(); detalle(a.getAttribute("data-tel")); });
      });
      var r = td.getBoundingClientRect(), w = 280;
      pop.style.display = "block";
      w = pop.offsetWidth;
      pop.style.left = Math.max(8, Math.min(window.scrollX + r.left + r.width / 2 - w / 2, window.scrollX + document.documentElement.clientWidth - w - 8)) + "px";
      pop.style.top = (window.scrollY + r.bottom + 6) + "px";
    }
    function cerrar() { timer = setTimeout(function () { pop.style.display = "none"; }, 200); }
    function detalle(tel) {
      var d = DET[tel] || {};
      var f = function (v) { return v && String(v).trim() ? v : "—"; };
      var trans = TRS[tel] || [];
      document.getElementById("inbdet-cuerpo").innerHTML =
        "<h3>" + f(d.e) + "</h3><table>" +
        "<tr><td>Contacto</td><td>+" + tel + "</td></tr>" +
        "<tr><td>Estado</td><td>" + f(d.est) + "</td></tr>" +
        "<tr><td>Ejecutivo</td><td>" + f(d.ej) + "</td></tr>" +
        "<tr><td>Dotación</td><td>" + f(d.dot) + "</td></tr>" +
        "<tr><td>Última actividad</td><td>" + f(d.ult) + "</td></tr>" +
        "<tr><td>Accionable</td><td>" + f(d.acc) + "</td></tr>" +
        "<tr><td>Links</td><td>" + (d.conv ? '<a href="?conv=' + d.conv + '">chat completo</a> · ' : "") + (d.z ? '<a href="' + d.z + '" target="_blank">Zoho</a>' : "") + "</td></tr>" +
        "</table>" +
        // OJO: comillas SIMPLES en el div — el \" del template TS llegaba al
        // navegador sin el backslash y rompía el string: TODO el script del
        // popover moría con "Unexpected identifier 'inbchat'" y las viñetas
        // del hover no aparecían (cazado con Chromium headless, 20-ago).
        (trans.length ? '<button class="vertrans" id="btntrans">💬 Ver transcripción (' + trans.length + " mensajes)</button><div id='inbchat'></div>" : "");
      if (trans.length) {
        document.getElementById("btntrans").addEventListener("click", function () {
          var box = document.getElementById("inbchat");
          if (box.style.display === "block") { box.style.display = "none"; this.textContent = "💬 Ver transcripción (" + trans.length + " mensajes)"; return; }
          if (!box.childNodes.length) {
            trans.forEach(function (m) {
              var b = document.createElement("div");
              b.className = "bb " + (m[0] === "c" ? "bc" : "bv");
              b.textContent = m[2];
              var tt = document.createElement("div");
              tt.className = "bt";
              tt.textContent = (m[0] === "c" ? "Cliente" : "Vicky") + " · " + m[1];
              b.appendChild(tt);
              box.appendChild(b);
            });
          }
          box.style.display = "block";
          box.scrollTop = box.scrollHeight;
          this.textContent = "▲ Ocultar transcripción";
        });
      }
      pop.style.display = "none";
      document.getElementById("inbdet-modal").style.display = "flex";
    }
    // CELULAR (Lalo 19-ago, "hazlo responsivo"): sin hover, el primer toque
    // en el número abre la viñeta (el listado completo queda como ítem
    // dentro de ella); tocar fuera la cierra.
    var esTouch = window.matchMedia && window.matchMedia("(hover: none)").matches;
    document.querySelectorAll("td.conpop").forEach(function (td) {
      if (esTouch) {
        td.addEventListener("click", function (ev) { ev.preventDefault(); abrir(td); });
      } else {
        td.addEventListener("mouseenter", function () { abrir(td); });
        td.addEventListener("mouseleave", cerrar);
      }
    });
    // Sub-números del paréntesis (Lalo 31-ago): viñeta propia con su listado.
    document.querySelectorAll(".subpop").forEach(function (sp) {
      if (esTouch) {
        sp.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); abrir(sp); });
      } else {
        sp.addEventListener("mouseenter", function () { abrir(sp); });
        sp.addEventListener("mouseleave", cerrar);
      }
    });
    if (esTouch) {
      document.addEventListener("click", function (ev) {
        if (pop.style.display === "block" && !pop.contains(ev.target) && !(ev.target.closest && ev.target.closest("td.conpop"))) {
          pop.style.display = "none";
        }
      });
    }
    pop.addEventListener("mouseenter", function () { clearTimeout(timer); });
    pop.addEventListener("mouseleave", cerrar);
    document.getElementById("inbdet-modal").addEventListener("click", function (ev) {
      if (ev.target === this) this.style.display = "none";
    });
  })();
  </script>
</div>`
}

/** Panel de trabajo por EJECUTIVO (pedido Lalo 05-ago): oportunidades activas
 * que maneja cada uno, asignadas en el período, desglose por etapa, venta
 * recurrente del período y antigüedad del último contacto (2 h / 5 h / 1 día /
 * 2 días hábiles). Días hábiles = L-V, sin feriados. */
function renderTrabajoEjecutivos(params: {
  filas: FilaListado[]
  quotes: RawAceptada[]
  feesPorQuote: Map<string, { uf: number | null; clp: number | null }>
  usuarios: Map<string, number>
  rango: RangoFechas | null
  pais: Pais
  /** Query string base para los links de detalle de cada número. */
  qsPanel?: string
}): string {
  const { filas, quotes, feesPorQuote, usuarios, rango, pais, qsPanel = "" } = params
  const ahora = Date.now()
  const vivas = filas.filter((f) => !/perdido/i.test(f.estadoZoho))
  const nombreDe = (p: string) => (p && p !== "—" ? p : "(sin ejecutivo)")

  const porEjecutivo = new Map<string, FilaListado[]>()
  for (const f of vivas) {
    const e = nombreDe(f.propietario)
    if (!porEjecutivo.has(e)) porEjecutivo.set(e, [])
    porEjecutivo.get(e)!.push(f)
  }

  // Venta RECURRENTE del período por dueño de la cotización pagada (fecha de
  // pago dentro del rango; sin filtro, últimos 30 días).
  const enPeriodo = (iso: string) =>
    rango ? enRango(iso, rango) : Date.parse(iso) >= ahora - 30 * 864e5
  const ventas = new Map<string, { uf: number; clp: number; n: number }>()
  for (const q of quotes) {
    if (!esPagada(q)) continue
    const fechaPago = String(q.Fecha_Hora_Cotizacion || q.Modified_Time || q.Created_Time || "")
    if (!fechaPago || !enPeriodo(fechaPago)) continue
    const dueno = nombreDe(`${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim())
    const fee = feesPorQuote.get(String(q.id || ""))
    const cur = ventas.get(dueno) || { uf: 0, clp: 0, n: 0 }
    cur.uf += fee?.uf || 0
    cur.clp += fee?.clp || 0
    cur.n++
    ventas.set(dueno, cur)
  }
  const fmtVenta = (v: { uf: number; clp: number; n: number } | undefined): string => {
    if (!v || !v.n) return "—"
    const simbolo = pais === "pe" ? "S/ " : "$"
    const monto =
      pais === "cl" && v.uf
        ? `UF ${v.uf.toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
        : v.clp
          ? `${simbolo}${Math.round(v.clp).toLocaleString("es-CL")}`
          : v.uf
            ? `${simbolo}${Math.round(v.uf).toLocaleString("es-CL")}`
            : "—"
    return `<b>${monto}</b><div class="sub" style="margin:0;font-size:11px">${v.n} venta${v.n === 1 ? "" : "s"}/mes</div>`
  }

  const horasDesde = horasDesdeFila
  const diasHabilesDesde = diasHabilesDesdeFila

  const nombres = [...new Set([...porEjecutivo.keys(), ...ventas.keys()])]
  const filasTabla = nombres
    .map((e) => {
      const ops = porEjecutivo.get(e) || []
      const asignadas = ops.filter((f) => f.primerContactoIso && enPeriodo(f.primerContactoIso)).length
      const porEtapa = ESTADOS_LISTADO.map((est) => ops.filter((f) => f.estado === est).length)
      const porSegmento = SEGMENTOS_DOTACION.map(
        (s) => ops.filter((f) => segmentoDotacion(usuarios.get(digits(f.contacto))) === s).length,
      )
      const sinContacto = (h: number) => ops.filter((f) => horasDesde(f) > h).length
      const sin2dHabiles = ops.filter((f) => diasHabilesDesde(f) >= 2).length
      return { e, ops: ops.length, asignadas, porEtapa, porSegmento, s2: sinContacto(2), s5: sinContacto(5), s24: sinContacto(24), s2d: sin2dHabiles, venta: ventas.get(e) }
    })
    .sort((a, b) => b.ops - a.ops || (b.venta?.n || 0) - (a.venta?.n || 0))

  if (!filasTabla.length) return ""
  const tot = {
    ops: filasTabla.reduce((a, r) => a + r.ops, 0),
    asignadas: filasTabla.reduce((a, r) => a + r.asignadas, 0),
    porEtapa: ESTADOS_LISTADO.map((_, i) => filasTabla.reduce((a, r) => a + r.porEtapa[i], 0)),
    porSegmento: SEGMENTOS_DOTACION.map((_, i) => filasTabla.reduce((a, r) => a + r.porSegmento[i], 0)),
    s2: filasTabla.reduce((a, r) => a + r.s2, 0),
    s5: filasTabla.reduce((a, r) => a + r.s5, 0),
    s24: filasTabla.reduce((a, r) => a + r.s24, 0),
    s2d: filasTabla.reduce((a, r) => a + r.s2d, 0),
    venta: { uf: 0, clp: 0, n: 0 },
  }
  for (const v of ventas.values()) {
    tot.venta.uf += v.uf
    tot.venta.clp += v.clp
    tot.venta.n += v.n
  }
  // Cada número es clickeable (pedido Lalo 06-ago): abre el detalle de esas
  // empresas (?ejdet=<dimensión>&ejec=<ejecutivo>).
  const lnk = (ejec: string, dim: string, contenido: string, n: number) =>
    qsPanel && n > 0
      ? `<a href="?${qsPanel}&ejdet=${encodeURIComponent(dim)}&ejec=${encodeURIComponent(ejec)}" style="text-decoration:none" title="Ver el detalle de estas empresas">${contenido}</a>`
      : contenido
  const alerta = (n: number) => (n > 0 ? `<span style="color:#C62828;font-weight:700">${n}</span>` : `<span style="color:#9aa0a8">0</span>`)
  const filaHtml = (r: (typeof filasTabla)[number], esTotal = false) => `<tr${esTotal ? ` style="border-top:2px solid #c9ced4;font-weight:700"` : ""}>
      <td>${esc(r.e)}</td>
      <td style="text-align:center">${lnk(r.e, "manejando", `<b>${r.ops}</b>`, r.ops)}</td>
      <td style="text-align:center">${lnk(r.e, "asignadas", String(r.asignadas), r.asignadas)}</td>
      ${r.porSegmento.map((n, i) => `<td style="text-align:center;background:#fbfcfd">${n ? lnk(r.e, `seg:${SEGMENTOS_DOTACION[i]}`, String(n), n) : `<span style="color:#c9ced4">·</span>`}</td>`).join("")}
      ${r.porEtapa.map((n, i) => `<td style="text-align:center">${n ? lnk(r.e, `etapa:${ESTADOS_LISTADO[i]}`, String(n), n) : `<span style="color:#c9ced4">·</span>`}</td>`).join("")}
      <td style="text-align:right">${fmtVenta(r.venta)}</td>
      <td style="text-align:center">${lnk(r.e, "s2", alerta(r.s2), r.s2)}</td>
      <td style="text-align:center">${lnk(r.e, "s5", alerta(r.s5), r.s5)}</td>
      <td style="text-align:center">${lnk(r.e, "s24", alerta(r.s24), r.s24)}</td>
      <td style="text-align:center">${lnk(r.e, "s2d", alerta(r.s2d), r.s2d)}</td>
    </tr>`
  return `<div class="card"><h2>👥 Trabajo por ejecutivo <span class="pct" style="font-weight:400">— oportunidades vivas de los últimos 30 días · ${rango ? `período ${esc(rango.etiqueta)}` : "período: últimos 30 días"}</span></h2>
  <div style="overflow-x:auto"><table style="font-size:12.5px">
    <thead><tr>
      <th>Ejecutivo</th>
      <th style="text-align:center" title="Oportunidades vivas a su nombre (excluye Cierre Perdido)">Manejando</th>
      <th style="text-align:center" title="Oportunidades cuyo primer contacto cae en el período seleccionado">Asignadas<br>período</th>
      ${SEGMENTOS_DOTACION.map((s) => `<th style="text-align:center;background:#f2f6f9" title="Empresas por dotación cotizada (${s === "s/d" ? "sin dato de tamaño" : `${s} personas`})">${esc(s)}</th>`).join("")}
      ${ESTADOS_LISTADO.map((e) => `<th style="text-align:center">${esc(e).replace(" ", "<br>")}</th>`).join("")}
      <th style="text-align:right" title="Fee mensual recurrente de las cotizaciones PAGADAS en el período, por dueño de la cotización">Vendido<br>recurrente</th>
      <th style="text-align:center" title="Oportunidades sin contacto (chat o Zoho) hace más de 2 horas">&gt;2 h</th>
      <th style="text-align:center" title="…hace más de 5 horas">&gt;5 h</th>
      <th style="text-align:center" title="…hace más de 1 día">&gt;1 día</th>
      <th style="text-align:center" title="…hace 2 o más días hábiles (L-V)">&gt;2 d háb.</th>
    </tr></thead>
    <tbody>${filasTabla.map((r) => filaHtml(r)).join("")}${filaHtml({ e: "TOTAL", ...tot } as (typeof filasTabla)[number], true)}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">"Manejando" = oportunidades vivas de los últimos 30 días a nombre del ejecutivo (excluye Cierre Perdido). "Asignadas período" cuenta por fecha de primer contacto. Los tramos (1-10 a &gt;50) reparten las empresas según la dotación cotizada (subform de la cotización o preform del chat; s/d = sin dato). "Vendido recurrente" suma el fee mensual de las cotizaciones pagadas en el período (dueño de la cotización). Las columnas de antigüedad usan el último contacto real (chat o actividad en Zoho) y son acumulativas.</div>
</div>`
}

/** Detalle de un número del panel por ejecutivo (pedido Lalo 06-ago): la
 * lista de empresas detrás de la celda clickeada. */
function renderDetalleEjecutivo(params: {
  filas: FilaListado[]
  titulo: string
  key: string
  volverQS: string
  montos: Map<string, { uf: number | null; clp: number | null }>
  usuarios: Map<string, number>
  wspSet: Set<string>
  pais: Pais
  /** Contactos con fila en vic_outbound_cadence (lead cargado = formulario). */
  formularioSet?: Set<string>
}): Response {
  const { filas, titulo, key, volverQS, montos, usuarios, wspSet, pais, formularioSet = new Set() } = params
  const simbolo = pais === "pe" ? "S/ " : "$"
  const montoTxt = (tel: string): string => {
    const m = montos.get(tel)
    if (!m) return "—"
    if (pais === "cl" && m.uf) return `UF ${m.uf.toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
    if (m.clp) return `${simbolo}${Math.round(m.clp).toLocaleString("es-CL")}`
    if (m.uf) return `${simbolo}${Math.round(m.uf).toLocaleString("es-CL")}`
    return "—"
  }
  const filasHtml = [...filas]
    .sort((a, b) => horasDesdeFila(b) - horasDesdeFila(a))
    .map((f) => {
      const tel = digits(f.contacto)
      const h = horasDesdeFila(f)
      const links = [
        f.convId ? `<a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(f.convId)}" style="font-size:12px">📄 ver chat</a>` : "",
        f.zohoUrl ? `<a href="${esc(f.zohoUrl)}" target="_blank" rel="noopener" style="font-size:12px">🔗 Zoho</a>` : "",
        wspSet.has(tel) ? `<a href="?key=${encodeURIComponent(key)}&wsp=${encodeURIComponent(tel)}" target="_blank" style="font-size:12px">📱 wsp</a>` : "",
      ].filter(Boolean).join(" · ")
      return `<tr>
        <td><b>${esc(f.empresa)}</b><div class="sub" style="margin:0;font-size:12px">+${esc(tel)}</div>${links ? `<div style="margin-top:2px">${links}</div>` : ""}</td>
        <td>${esc(f.propietario)}</td>
        <td><span class="tag">${esc(f.estado)}</span></td>
        <td style="white-space:nowrap">${chipLlegoPor(formularioSet.has(tel))}</td>
        <td style="text-align:center">${usuarios.get(tel) || "s/d"}</td>
        <td style="white-space:nowrap">${haceTexto(f.ultimoContactoIso || f.updatedIso || f.fechaIso)}<div class="sub" style="margin:0;font-size:11px">${fmtSantiago(f.ultimoContactoIso || f.updatedIso || f.fechaIso)}</div></td>
        <td style="text-align:right;white-space:nowrap">${montoTxt(tel)}</td>
        <td style="max-width:320px">${esc(f.accionable)}</td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 4px;color:#4e4e4e}
  .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#e6f8fe;color:#4e4e4e;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <p><a href="${volverQS}">← Volver al análisis</a></p>
  <h1>${esc(titulo)}</h1>
  <div class="sub">${filas.length} empresa${filas.length === 1 ? "" : "s"} · ordenadas de más a menos tiempo sin contacto</div>
  <div class="card">${
    filas.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Empresa / contacto</th><th>Ejecutivo</th><th>Estado</th><th title="Cómo llegó el contacto: nos escribió directo por WhatsApp, o entró como lead cargado (formulario web / base) a la cadencia outbound">Llegó por</th><th style="text-align:center">Dotación</th><th>Última actividad</th><th style="text-align:right">Recurrente</th><th>Accionable</th></tr></thead><tbody>${filasHtml}</tbody></table></div>`
      : `<p class="sub" style="margin:0">Sin empresas para este corte.</p>`
  }</div>
</div></body></html>`
  return page(html)
}

/** Resumen de EMPRESAS ingresadas en el período (pedido Lalo 05-ago): cuántas
 * entraron, en qué etapa va cada una y su tramo de dotación — cruzado. */
function renderEmpresasPeriodo(params: {
  filas: FilaListado[]
  usuarios: Map<string, number>
  rango: RangoFechas | null
  qsPanel: string
}): string {
  const { filas, usuarios, rango, qsPanel } = params
  const ahora = Date.now()
  const enPeriodo = (iso: string) => (rango ? enRango(iso, rango) : Date.parse(iso) >= ahora - 30 * 864e5)
  const entrantes = filas.filter((f) => f.primerContactoIso && enPeriodo(f.primerContactoIso))
  if (!entrantes.length) return ""
  const seg = (f: FilaListado) => segmentoDotacion(usuarios.get(digits(f.contacto)))
  const filasTabla = ESTADOS_LISTADO.map((est) => {
    const grupo = entrantes.filter((f) => f.estado === est)
    return { est, total: grupo.length, porSeg: SEGMENTOS_DOTACION.map((s) => grupo.filter((f) => seg(f) === s).length) }
  }).filter((r) => r.total > 0)
  const tot = { total: entrantes.length, porSeg: SEGMENTOS_DOTACION.map((s) => entrantes.filter((f) => seg(f) === s).length) }
  // Cada número es un link al detalle de las empresas detrás de la celda
  // (pedido Lalo 11-ago): etapa × tramo; los totales filtran solo su eje.
  const linkDe = (etapa?: string, tramo?: string) =>
    `?${qsPanel}&empdet=1${etapa ? `&empEtapa=${encodeURIComponent(etapa)}` : ""}${tramo ? `&empTramo=${encodeURIComponent(tramo)}` : ""}`
  const celda = (n: number, etapa?: string, tramo?: string, negrita = false) =>
    `<td style="text-align:center">${
      n
        ? `<a href="${linkDe(etapa, tramo)}" title="Ver el detalle de estas empresas" style="font-weight:${negrita ? 700 : 400}">${n}</a>`
        : `<span style="color:#c9ced4">·</span>`
    }</td>`
  return `<div class="card"><h2>🏢 Empresas ingresadas en el período <span class="pct" style="font-weight:400">— ${entrantes.length} empresas · ${rango ? esc(rango.etiqueta) : "últimos 30 días"}</span></h2>
  <div style="overflow-x:auto"><table style="font-size:12.5px;max-width:720px">
    <thead><tr><th>Etapa actual</th><th style="text-align:center">Empresas</th>${SEGMENTOS_DOTACION.map((s) => `<th style="text-align:center" title="${s === "s/d" ? "sin dato de tamaño" : `${s} personas`}">${esc(s)}</th>`).join("")}</tr></thead>
    <tbody>
      ${filasTabla.map((r) => `<tr><td><span class="tag">${esc(r.est)}</span></td>${celda(r.total, r.est, undefined, true)}${r.porSeg.map((n, i) => celda(n, r.est, SEGMENTOS_DOTACION[i])).join("")}</tr>`).join("")}
      <tr style="border-top:2px solid #c9ced4;font-weight:700"><td>TOTAL</td>${celda(tot.total, undefined, undefined, true)}${tot.porSeg.map((n, i) => celda(n, undefined, SEGMENTOS_DOTACION[i], true)).join("")}</tr>
    </tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">Empresas cuyo PRIMER contacto cae en el período (filtro Desde–Hasta; sin filtro, últimos 30 días), con su etapa actual y su tramo de dotación cotizada (subform de la cotización o preform del chat; s/d = aún sin dato de tamaño).</div>
</div>`
}

function page(html: string, status = 200): Response {
  // no-store: dashboard vivo — sin esto el navegador reusa respuestas por
  // heurística y las pestañas parecen "no navegar" (caso Gestión↔Editor 07-ago).
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

/** Chat espejado del WHATSAPP DEL VENDEDOR con el cliente (pedido Lalo
 * 06-ago): burbujas estilo chat, imprimible a PDF. Fuente:
 * vic_wa_espejo_mensajes (worker wa-espejo — una sesión por ejecutivo,
 * solo lectura; espeja desde la vinculación del dispositivo en adelante). */
async function renderWspVendedor(contact: string): Promise<Response> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?telefono_chat=eq.${contact}&es_grupo=eq.false&select=session_id,from_me,tipo,texto,enviado_at&order=enviado_at.asc&limit=3000`,
    { headers: h, cache: "no-store" },
  ).catch(() => null)
  const msgs = r?.ok
    ? ((await r.json().catch(() => [])) as Array<{ session_id: string; from_me: boolean; tipo: string; texto: string | null; enviado_at: string }>)
    : []
  if (!msgs.length) {
    return paginaAviso(
      "Sin chat del vendedor",
      `<p>Aún no hay mensajes espejados del WhatsApp de un vendedor con <b>+${esc(contact)}</b>. El espejo captura desde la vinculación del dispositivo del ejecutivo en adelante.</p>`,
    )
  }
  // Nombres reales de las sesiones (vic_kv wa_espejo_labels, best-effort).
  let etiquetas: Record<string, string> = {}
  try {
    etiquetas = JSON.parse((await kvGet("wa_espejo_labels")) || "{}") as Record<string, string>
  } catch {}
  const nombreSesion = (s: string) => etiquetas[s] || s
  const vendedores = [...new Set(msgs.map((m) => nombreSesion(m.session_id)))]
  const burbujas = msgs
    .map((m) => {
      const mio = m.from_me
      const cuerpo = (m.texto || "").trim() || `[${m.tipo}]`
      return `<div style="display:flex;justify-content:${mio ? "flex-end" : "flex-start"};margin:4px 0">
      <div style="max-width:72%;padding:8px 12px;border-radius:12px;border:1px solid ${mio ? "#f3dc9a" : "#e5e7eb"};background:${mio ? "#FFF8E1" : "#ffffff"}">
        <div style="white-space:pre-wrap;font-size:13.5px;word-break:break-word">${esc(cuerpo)}</div>
        <div style="margin:3px 0 0;font-size:10.5px;color:#9aa0a8;text-align:right">${mio ? esc(nombreSesion(m.session_id)) : "cliente"} · ${fmtSantiago(m.enviado_at)}</div>
      </div></div>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp del vendedor — +${esc(contact)}</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 50px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:18px;margin:0 0 2px;color:#4e4e4e}
  .sub{color:#646464;font-size:12px;margin-bottom:14px}
  .btnPrint{background:#ffbb00;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:13px;cursor:pointer;float:right}
  img.logo{height:26px;vertical-align:middle;margin-right:10px}
  @media print{.btnPrint{display:none}body{background:#fff}.wrap{max-width:none;padding:0}}
</style></head><body><div class="wrap">
  <button class="btnPrint" onclick="window.print()">🖨️ Guardar como PDF</button>
  <h1><img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria">WhatsApp del vendedor · +${esc(contact)}</h1>
  <div class="sub">${msgs.length} mensajes · vendedor${vendedores.length === 1 ? "" : "es"}: ${vendedores.map(esc).join(", ")} · espejo solo-lectura del celular del ejecutivo · hora de Chile</div>
  ${burbujas}
</div></body></html>`
  return page(html)
}

/** Tarjeta con el estado VIVO de la cotización (Vicky Cotizaciones). Se
 * renderiza server-side y el chat la reemplaza tras cada turno con tools. */
function panelCotizacionHtml(e: EstadoCotizacion): string {
  const p = e.puntero
  const filas = e.items
    .map(
      (i) => `<tr>
      <td>${esc(i.nombre)}${i.codigo && i.codigo !== i.nombre ? `<div class="sub" style="margin:0;font-size:11px">${esc(i.codigo)}${i.modalidad ? ` · ${esc(i.modalidad)}` : ""}</div>` : i.modalidad ? `<div class="sub" style="margin:0;font-size:11px">${esc(i.modalidad)}</div>` : ""}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td style="white-space:nowrap">${i.recurrente ? "mensual" : "pago único"}</td>
      <td style="text-align:right;white-space:nowrap">UF ${i.subtotalUF.toLocaleString("es-CL", { maximumFractionDigits: 2 })}</td>
    </tr>`,
    )
    .join("")
  const links = [
    p.pdfUrl ? `<a href="${esc(p.pdfUrl)}" target="_blank" rel="noopener">🧾 PDF</a>` : "",
    p.quoteId ? `<a href="${ZOHO_CRM_URL}/tab/${QUOTE_MODULE}/${esc(p.quoteId)}" target="_blank" rel="noopener">🔗 Zoho</a>` : "",
  ].filter(Boolean).join(" · ")
  // Botón de envío directo (reemplaza el link de aceptación — pedido Lalo
  // 07-ago): manda al cliente el PDF vigente por el WhatsApp de Vicky. El
  // handler enviarCotCliente vive en la página del editor (?coted=).
  // Vista previa (pedido Grey 07-ago, ok Lalo): genera y abre el PDF con los
  // últimos cambios SIN enviarle nada al cliente — para verificar antes del
  // envío. Lo que muestra es exactamente lo que saldría al apretar enviar.
  const btnPreview = `<div style="margin-top:12px"><button onclick="previewCotPdf(this)" title="Genera y abre el PDF con los últimos cambios. NO le envía nada al cliente — es para revisar antes de enviar." style="background:#fff;color:#333;border:1px solid #d9d9d9;border-radius:10px;padding:10px 14px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;width:100%">👁 Vista previa del PDF (no envía nada)</button></div>`
  const btnEnviar = `<div style="margin-top:8px"><button onclick="enviarCotCliente(this)" title="Vicky le manda al cliente el PDF vigente por WhatsApp, con un mensaje corto" style="background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;width:100%">📤 Enviar a cliente por WhatsApp de Vicky</button></div>`
  // Nota de Venta a demanda (Lalo 12-ago, "déjalo implementado"): convierte la
  // COT en NDV real de Creator vía el cotizador (handoff completo del post-pago:
  // numeración NDV-xxx, subforms, tabla de cobro y PDF). Al cliente no le llega nada.
  const btnNdv = `<div style="margin-top:8px"><button onclick="crearNdvCot(this)" title="Crea la Nota de Venta en Zoho Creator a partir de esta cotización (numerada, con subformularios y PDF). Al cliente NO le llega nada." style="background:#fff;color:#333;border:1px solid #d9d9d9;border-radius:10px;padding:10px 14px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;width:100%">🧾 Crear Nota de Venta (Creator)</button></div>`
  return `<h2 style="margin:0 0 2px;font-size:15px">${esc(p.empresa || "Empresa sin nombre")}</h2>
  <div class="sub" style="margin:0 0 10px">${e.numero ? `${esc(e.numero)} · ` : ""}${p.rut ? `RUT ${esc(p.rut)} · ` : ""}<span class="tag">${esc(e.estadoZoho || "estado desconocido")}</span>${e.descuentoPct ? ` · dcto. recurrente ${e.descuentoPct}%` : ""}</div>
  ${e.items.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Ítem</th><th style="text-align:center">Cant.</th><th>Tipo</th><th style="text-align:right">Neto</th></tr></thead><tbody>${filas}</tbody></table></div>` : `<p class="sub" style="margin:0 0 8px">Detalle de ítems no disponible desde Zoho en este momento.</p>`}
  <div style="margin-top:10px;font-size:14px"><b>Total con IVA:</b> ${p.totalUf ? `UF ${p.totalUf.toLocaleString("es-CL", { maximumFractionDigits: 2 })}` : "—"}${p.totalClp ? ` <span class="sub" style="font-size:12px">(~$${Math.round(p.totalClp).toLocaleString("es-CL")})</span>` : ""}</div>
  ${links ? `<div style="margin-top:8px;font-size:13px">${links}</div>` : ""}${btnPreview}${btnEnviar}${btnNdv}`
}

/** Página del editor conversacional "Vicky Cotizaciones" (pedido Lalo 06-ago):
 * chat interno para el vendedor + panel con el estado vivo de la cotización.
 * Los cambios se aplican con la MISMA tool actualizar_cotizacion que usa Vicky
 * con clientes (PDF regenerado, mismo link) y el envío al cliente sale por el
 * WhatsApp de Vicky recién con el OK del vendedor. */
async function renderVickyCotizaciones(contact: string, key: string, quoteId = ""): Promise<Response> {
  const est = await estadoCotizacion(contact, quoteId || undefined).catch(() => null)
  if (!est) {
    // MODO PREFORM (Lalo 07-ago): sin formal pero CON conversación → el
    // editor abre con el contexto del preform para emitir la formal directo.
    const conv = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Array<{ id: string }>
    if (conv[0]?.id) return renderVickyCotizacionesPreform(contact, key)
    return paginaAviso(
      "Sin cotización formal",
      `<p>El contacto <b>+${esc(contact)}</b> no tiene una cotización formal registrada ni conversación con Vicky, así que no hay nada que editar.</p><p><a href="?key=${encodeURIComponent(key)}&vista=editor">← Volver al editor de cotizaciones</a></p>`,
    )
  }
  const empresa = est.puntero.empresa || `+${contact}`
  // Sesiones del espejo CONECTADAS: habilitan el envío del PDF desde el
  // WhatsApp personal del vendedor (pedido Lalo 07-ago).
  let sesionesWsp: Array<{ id: string; nombre: string }> = []
  try {
    const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    const [stRows, labelsRaw] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.wa_espejo_status_%25&select=key,value&limit=100`, {
        headers: hSb,
        cache: "no-store",
      }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<Array<{ key: string; value: string }>>,
      kvGet("wa_espejo_labels"),
    ])
    let etiquetas: Record<string, string> = {}
    try {
      etiquetas = JSON.parse(labelsRaw || "{}") as Record<string, string>
    } catch {}
    sesionesWsp = stRows
      .map((r) => {
        const id = String(r.key).replace(/^wa_espejo_status_/, "")
        let estadoS = ""
        try {
          estadoS = String((JSON.parse(String(r.value || "")) as { estado?: string }).estado || "")
        } catch {}
        return { id, estadoS }
      })
      .filter((s) => s.estadoS === "conectado")
      .map((s) => ({ id: s.id, nombre: etiquetas[s.id] || s.id }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
  } catch {}
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vicky Cotizaciones — ${esc(empresa)}</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:18px 16px 30px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:19px;margin:0 0 2px;color:#4e4e4e}
  .sub{color:#646464;font-size:12px}
  .cols{display:flex;gap:16px;align-items:flex-start;margin-top:14px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px}
  .lado{width:360px;flex:none;position:sticky;top:12px}
  #panelCot table{width:100%;border-collapse:collapse;font-size:12.5px}
  #panelCot th,#panelCot td{text-align:left;padding:5px 6px;border-bottom:1px solid #eef0f2;vertical-align:top}
  #panelCot th{color:#6b7280;font-weight:600;font-size:11px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  .chatCol{flex:1;min-width:0;display:flex;flex-direction:column}
  #chatBox{min-height:340px;max-height:60vh;overflow-y:auto;padding:4px 2px}
  .bub{display:flex;margin:6px 0}
  .bub>div{max-width:78%;padding:9px 13px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .bubU{justify-content:flex-end}.bubU>div{background:#FFF8E1;border:1px solid #f3dc9a}
  .bubA>div{background:#ffffff;border:1px solid #e5e7eb}
  .bubE>div{background:#fdecea;border:1px solid #f5c6c0;color:#8a1f11}
  .chip{display:inline-block;margin:4px 0;padding:4px 10px;border-radius:99px;font-size:12px;background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9}
  .chipErr{background:#fdecea;color:#8a1f11;border-color:#f5c6c0}
  .fila{display:flex;gap:8px;margin-top:10px}
  #msg{flex:1;padding:10px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:14px;font-family:inherit;resize:none}
  #btnSend{background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:0 16px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
  #btnSend:disabled{opacity:.5;cursor:default}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  img.logo{height:26px;vertical-align:middle;margin-right:10px}
  @media (max-width:760px){.cols{flex-direction:column}.lado{width:auto;position:static}}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><a href="?key=${encodeURIComponent(key)}">← Volver a la cola de gestión</a>
    <form method="GET" action="/api/vic-funnel" style="display:inline-flex;gap:6px;align-items:center">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="text" name="buscarcot" placeholder="Otra cotización o teléfono" style="padding:6px 10px;border:1px solid #d0d5db;border-radius:8px;font-size:13px;font-family:inherit;width:190px">
      <button type="submit" style="background:#00aff2;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer">🔍 Buscar</button>
    </form></p>
  <h1><img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria">Vicky Cotizaciones</h1>
  <div class="sub">Editor interno de la cotización de <b>${esc(empresa)}</b> (+${esc(contact)}). Describe el cambio y se aplica de inmediato con los precios oficiales — el link de aceptación no cambia y el PDF se regenera. La cotización se le envía al cliente <b>solo cuando tú des el OK</b>.</div>
  <div class="cols">
    <div class="chatCol card">
      <div id="chatBox">
        <div class="bub bubA"><div>Hola, soy Vicky Cotizaciones 👋 Dime qué cambio necesita la cotización de ${esc(empresa)} —dotación, relojes, módulos, puntos de instalación o descuento (escalera oficial, tope 20%)— y lo aplico de inmediato. Cuando quede lista y me des el OK, se la envío al cliente por WhatsApp con el PDF nuevo.</div></div>
      </div>
      <div class="fila">
        <textarea id="msg" rows="2" placeholder="Ej: súbela a 25 trabajadores y agrégale un segundo reloj en arriendo…"></textarea>
        <button id="btnSend" title="Le pide la modificación a Vicky Cotizaciones — al cliente NO le llega nada con este botón">Haz modificación</button>
      </div>
    </div>
    <div class="lado">
      <div id="panelCot" class="card">${panelCotizacionHtml(est)}</div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px">📲 Enviar desde el WhatsApp del vendedor</div>
        ${
          sesionesWsp.length
            ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
          <select id="selSesionWsp" style="flex:1;min-width:140px;padding:8px;border:1px solid #d0d5db;border-radius:8px;font-size:13px;font-family:inherit">${sesionesWsp.map((s) => `<option value="${esc(s.id)}">${esc(s.nombre)}</option>`).join("")}</select>
          <button onclick="enviarCotVendedor(this)" style="background:#25D366;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">Enviar</button>
        </div>
        <div class="sub" style="margin-top:6px;font-size:11.5px">El PDF vigente sale del WhatsApp personal del vendedor elegido, con un mensaje corto. El botón amarillo del panel envía por el WhatsApp de Vicky.</div>`
            : `<div class="sub" style="margin:0">Ningún WhatsApp de vendedor conectado al espejo (falta escanear el QR).</div>`
        }
      </div>
    </div>
  </div>
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      var CONTACT = ${JSON.stringify(contact)};
      var COT = ${JSON.stringify(est.puntero.quoteId || "")};
      var HIST = [];
      var box = document.getElementById("chatBox");
      var input = document.getElementById("msg");
      var btn = document.getElementById("btnSend");
      function burbuja(clase, texto) {
        var w = document.createElement("div");
        w.className = "bub " + clase;
        var d = document.createElement("div");
        d.textContent = texto;
        w.appendChild(d);
        box.appendChild(w);
        box.scrollTop = box.scrollHeight;
        return w;
      }
      function chip(texto, ok) {
        var c = document.createElement("div");
        var s = document.createElement("span");
        s.className = "chip" + (ok ? "" : " chipErr");
        s.textContent = (ok ? "🔧 " : "⚠️ ") + texto;
        c.appendChild(s);
        box.appendChild(c);
        box.scrollTop = box.scrollHeight;
      }
      async function enviar() {
        var t = input.value.trim();
        if (!t || btn.disabled) return;
        input.value = "";
        burbuja("bubU", t);
        var esperando = burbuja("bubA", "Vicky está trabajando en la cotización…");
        btn.disabled = true;
        try {
          var res = await fetch(KEYQ + "&accion=coted_chat&contact=" + encodeURIComponent(CONTACT) + (COT ? "&cot=" + encodeURIComponent(COT) : ""), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ historial: HIST, mensaje: t }),
          });
          var j = null;
          try { j = await res.json(); } catch (e) {}
          esperando.remove();
          if (!res.ok || !j || !j.ok) {
            burbuja("bubE", (j && j.error) ? j.error : "Error " + res.status + " — intenta de nuevo.");
            return;
          }
          (j.eventos || []).forEach(function (e) { chip(e.resumen, e.ok); });
          burbuja("bubA", j.reply);
          HIST.push({ role: "user", content: t });
          HIST.push({ role: "assistant", content: j.reply });
          if (HIST.length > 30) HIST = HIST.slice(-30);
          if (j.panelHtml) document.getElementById("panelCot").innerHTML = j.panelHtml;
        } catch (e) {
          esperando.remove();
          burbuja("bubE", "No se pudo enviar: " + e);
        } finally {
          btn.disabled = false;
          input.focus();
        }
      }
      btn.addEventListener("click", enviar);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); }
      });
      // Botón del panel: envío directo del PDF vigente al cliente por el
      // WhatsApp de Vicky (el panel se re-inyecta por innerHTML, por eso el
      // handler es global y va por onclick).
      // Vista previa del PDF (pedido Grey 07-ago): regenera si hay cambios y
      // abre el resultado en otra pestaña. NO envía nada al cliente. La
      // pestaña se abre ANTES del fetch (síncrono) para esquivar el bloqueador
      // de popups; si falla, se cierra.
      window.previewCotPdf = async function (b) {
        b.disabled = true;
        var orig = b.textContent;
        b.textContent = "Generando vista previa…";
        var w = window.open("", "_blank");
        try {
          var res = await fetch(KEYQ + "&accion=coted_preview&contact=" + encodeURIComponent(CONTACT) + (COT ? "&cot=" + encodeURIComponent(COT) : ""), { method: "POST" });
          var j = null;
          try { j = await res.json(); } catch (e2) {}
          if (res.ok && j && j.ok && j.pdf_url) {
            if (w) { w.location = j.pdf_url; } else { window.open(j.pdf_url, "_blank"); }
            chip(j.regenerado ? "PDF regenerado con los últimos cambios — revísalo antes de enviar 👁" : "El PDF ya estaba al día — eso es lo que se enviaría 👁", true);
          } else {
            if (w) w.close();
            chip("Vista previa falló: " + ((j && j.error) || ("error " + res.status)), false);
          }
        } catch (e3) {
          if (w) w.close();
          chip("Vista previa falló: " + e3, false);
        }
        b.disabled = false;
        b.textContent = orig;
      };
      window.enviarCotCliente = async function (b) {
        if (!confirm("¿Enviarle al cliente la cotización vigente por el WhatsApp de Vicky?")) return;
        b.disabled = true;
        var orig = b.textContent;
        b.textContent = "Enviando…";
        try {
          var res = await fetch(KEYQ + "&accion=coted_enviar&contact=" + encodeURIComponent(CONTACT) + (COT ? "&cot=" + encodeURIComponent(COT) : ""), { method: "POST" });
          var j = null;
          try { j = await res.json(); } catch (e2) {}
          if (res.ok && j && j.ok) {
            b.textContent = "✅ Enviada al cliente";
            chip("Cotización enviada al cliente por WhatsApp 📤", true);
          } else {
            chip("Envío falló: " + ((j && j.error) || ("error " + res.status)), false);
            b.disabled = false;
            b.textContent = orig;
          }
        } catch (e3) {
          chip("Envío falló: " + e3, false);
          b.disabled = false;
          b.textContent = orig;
        }
      };
      // Nota de Venta a demanda: el cotizador corre el handoff completo del
      // post-pago con el maestro naciendo como "Nota de Venta" (numerada).
      window.crearNdvCot = async function (b) {
        if (!COT) { chip("Esta cotización aún no tiene ID en Zoho.", false); return; }
        if (!confirm("¿Crear la Nota de Venta en Creator a partir de esta cotización? Al cliente NO le llega nada.")) return;
        b.disabled = true;
        var orig = b.textContent;
        b.textContent = "Creando NDV… (puede tardar ~30 s)";
        try {
          var res = await fetch(KEYQ + "&accion=ndv_crear&contact=" + encodeURIComponent(CONTACT) + "&cot=" + encodeURIComponent(COT), { method: "POST" });
          var j = null;
          try { j = await res.json(); } catch (e2) {}
          if (res.ok && j && j.ok) {
            b.textContent = "✅ NDV " + (j.idNdv || "creada");
            chip(j.mensaje || ("Nota de Venta " + (j.idNdv || "") + (j.reused ? " ya existía en Creator ✔" : " creada en Creator ✔")), true);
          } else {
            chip("No se pudo crear la NDV: " + ((j && j.error) || ("error " + res.status)), false);
            b.disabled = false; b.textContent = orig;
          }
        } catch (e3) {
          chip("No se pudo crear la NDV: " + e3, false);
          b.disabled = false; b.textContent = orig;
        }
      };
      // Envío desde el WhatsApp del VENDEDOR: encola el trabajo y sondea su
      // estado (el worker del espejo lo despacha en ~15 s).
      window.enviarCotVendedor = async function (b) {
        var sel = document.getElementById("selSesionWsp");
        if (!sel || !sel.value) return;
        var nombre = sel.options[sel.selectedIndex].textContent;
        if (!confirm("¿Enviarle al cliente la cotización vigente desde el WhatsApp de " + nombre + "?")) return;
        b.disabled = true;
        try {
          var res = await fetch(KEYQ + "&accion=coted_enviar_vendedor&contact=" + encodeURIComponent(CONTACT) + (COT ? "&cot=" + encodeURIComponent(COT) : ""), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sesion: sel.value }),
          });
          var j = null;
          try { j = await res.json(); } catch (e2) {}
          if (!res.ok || !j || !j.ok) {
            chip("No se pudo encolar el envío: " + ((j && j.error) || ("error " + res.status)), false);
            b.disabled = false;
            return;
          }
          chip("En cola: se enviará desde el WhatsApp de " + nombre + " en unos segundos…", true);
          var jobId = j.jobId;
          var intentos = 0;
          var t = setInterval(async function () {
            intentos++;
            var s = null;
            try {
              var r2 = await fetch(KEYQ + "&accion=coted_envio_estado&contact=" + encodeURIComponent(CONTACT), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jobId: jobId }),
              });
              s = await r2.json();
            } catch (e3) {}
            var st = s && s.status;
            if (st === "enviado") { clearInterval(t); chip("Cotización enviada desde el WhatsApp de " + nombre + " ✅", true); b.disabled = false; }
            else if (st === "error") { clearInterval(t); chip("El envío falló: " + ((s && s.error) || "error"), false); b.disabled = false; }
            else if (intentos >= 8) { clearInterval(t); chip("El envío sigue en cola — revisa el chat espejado en un momento.", false); b.disabled = false; }
          }, 8000);
        } catch (e4) {
          chip("No se pudo encolar el envío: " + e4, false);
          b.disabled = false;
        }
      };
      input.focus();
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Pestaña "Funnel de cotizaciones" (pedido Lalo 17-ago): listado de las
 * cotizaciones ENVIADAS con todos los hitos del último metro, para ver dónde
 * se queda pegado cada cliente. Fuentes, todas ya existentes:
 *   - vic_v3_quote_pointers → emisión (created_at) + empresa/contacto/monto
 *   - vic_kv `pf_<quoteId>_<evento>` → telemetría del funnel de pago
 *     (vic-pago-evento, Rodrigo 17-ago): abrio, terminos, acepto,
 *     pago_abierto, metodo_tarjeta, metodo_transferencia, salida_mp,
 *     transfer_wsp_click, comprobante_wsp
 *   - vic_kv `venta_dash_v3_<quoteId>` → pagoIso = PAGADA
 * Rama liviana e independiente del pipeline pesado del dash. */
/** AUDITORÍA DE TÓMBOLAS (Lalo 18-ago): lo que la regla definida esperaba vs
 * lo que Zoho realmente ejecutó, por conversación. Los veredictos los produce
 * vic-tombola-audit-cron (timeline de Zoho: evento owner_assigned con la
 * regla exacta) y viven en vic_kv `tba_idx`; esta vista solo pinta. */
async function renderAuditoriaTombolas(key: string, soloBordes: boolean): Promise<Response> {
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const kv = (await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?select=value&key=eq.tba_idx&limit=1`, {
    headers: hSb,
    cache: "no-store",
  })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ value: string }>
  type Fila = {
    id: string
    tipo: string
    nombre: string
    fono: string
    n: number
    rut: string
    dueno: string
    reglas: Array<{ reglaId: string; regla: string; owner: string }>
    bordes: string[]
    creado: string
    at: string
  }
  let filas: Fila[] = []
  try {
    filas = kv[0]?.value ? (JSON.parse(kv[0].value) as Fila[]) : []
  } catch { filas = [] }
  const total = filas.length
  const conBordes = filas.filter((f) => f.bordes.length)
  const porBorde = new Map<string, number>()
  for (const f of conBordes) for (const b of f.bordes) porBorde.set(b.split(":")[0].split(" ")[0], (porBorde.get(b.split(":")[0].split(" ")[0]) || 0) + 1)
  const visibles = soloBordes ? conBordes : filas
  const filasHtml = visibles
    .map((f) => {
      const reglas = f.reglas.length
        ? f.reglas.map((r) => `${esc(r.regla || r.reglaId)} → <b>${esc(r.owner)}</b>`).join("<br>")
        : `<span class="sub">sin regla (herencia / interina / manual)</span>`
      const bordes = f.bordes.length
        ? f.bordes.map((b) => `<span style="display:inline-block;background:#fdecea;color:#b3261e;border-radius:6px;padding:1px 8px;margin:1px 2px;font-size:12px">${esc(b)}</span>`).join("")
        : `<span style="color:#1b7f4d;font-weight:600">✓ ok</span>`
      return `<tr>
        <td style="white-space:nowrap">${esc(String(f.creado).slice(0, 16).replace("T", " "))}</td>
        <td>${f.tipo === "deal" ? "💼 deal" : "👤 lead"}</td>
        <td><b>${esc(f.nombre || "—")}</b>${f.fono ? `<div class="sub" style="margin:0;font-size:12px">+${esc(f.fono)}</div>` : ""}</td>
        <td style="text-align:right">${f.n || "—"}</td>
        <td>${esc(f.rut || "—")}</td>
        <td>${reglas}</td>
        <td><b>${esc(f.dueno || "—")}</b></td>
        <td>${bordes}</td>
      </tr>`
    })
    .join("")
  const chips = [...porBorde.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `<span style="background:#fdecea;color:#b3261e;border-radius:8px;padding:3px 10px;margin-right:6px;font-size:13px">${esc(b)}: <b>${n}</b></span>`)
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Auditoría de tómbolas — Vicky</title>
<style>
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-SemiBold.otf") format("opentype");font-weight:600;font-display:swap}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f6f9;color:#16324f}
  .wrap{max-width:1200px;margin:24px auto;padding:0 16px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 8px rgba(13,71,161,.07)}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#5a7184;text-align:left;padding:10px 12px;border-bottom:2px solid #e6ecf2}
  td{padding:9px 12px;border-bottom:1px solid #eef2f6;font-size:14px;vertical-align:top}
  .sub{color:#7a8ca0}
  h1{font-size:22px}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}">← Volver al dash</a> · <a href="?key=${encodeURIComponent(key)}&vista=cotfunnel">🧭 Funnel cotizaciones</a></p>
  <h1>🎰 Auditoría de tómbolas <span class="sub" style="font-weight:400;font-size:14px">(regla definida vs lo que ejecutó Zoho · leads y deals de Vicky, últimos 7 días · refresca cada ~2 h)</span></h1>
  <p style="margin:8px 0 14px">
    <b>${total}</b> registros auditados · <b style="color:${conBordes.length ? "#b3261e" : "#1b7f4d"}">${conBordes.length} con casos borde</b>
    &nbsp;·&nbsp; ${soloBordes ? `<a href="?key=${encodeURIComponent(key)}&vista=tombolas">ver todos</a>` : `<a href="?key=${encodeURIComponent(key)}&vista=tombolas&solo=bordes">ver solo bordes →</a>`}
    <br>${chips}
  </p>
  ${total === 0 ? `<p class="sub">Aún no hay veredictos: el auditor corre cada ~2 horas (vic-tombola-audit-cron). Dispáralo a mano o espera el próximo tick.</p>` : `<div style="overflow-x:auto"><table>
    <tr><th>Creado</th><th>Tipo</th><th>Registro</th><th>N</th><th>RUT</th><th>Regla que asignó → sorteado</th><th>Dueño actual</th><th>Veredicto</th></tr>
    ${filasHtml}
  </table></div>`}
  <p class="sub" style="font-size:12px;margin-top:14px">Fuente: línea de tiempo de Zoho (evento owner_assigned con la regla exacta) + vic_ptv (vendedor presentado) + datos del registro. Los bordes marcados "definición pendiente" son los casos que aún no tienen regla decidida (ej: intención sin RUT).</p>
</div></body></html>`
  return page(html)
}

async function renderFunnelCotizaciones(key: string): Promise<Response> {
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const dias = 14
  const desde = new Date(Date.now() - dias * 86400000).toISOString()
  const punteros = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?select=contact,quote_id,empresa,rut,total_clp,created_at&created_at=gte.${encodeURIComponent(desde)}&order=created_at.desc&limit=200`,
    { headers: hSb, cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{
    contact: string
    quote_id: string
    empresa: string | null
    rut: string | null
    total_clp: number | null
    created_at: string
  }>

  // Telemetría + pagos en DOS lecturas planas (los pf_ parten hoy 17-ago, el
  // volumen es chico; si crece, filtrar por quote_id in (...)).
  const kvs = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?select=key,value&or=(key.like.pf_*,key.like.venta_dash_v3_*)&limit=8000`,
    { headers: hSb, cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ key: string; value: string }>

  const eventos = new Map<string, Map<string, string>>() // quoteId → evento → iso
  const pagadas = new Map<string, string>() // quoteId → pagoIso
  for (const { key: k, value: v } of kvs) {
    const mPf = k.match(/^pf_(\d+)_([a-z_]+)$/)
    if (mPf) {
      const porQ = eventos.get(mPf[1]) || new Map()
      porQ.set(mPf[2], v)
      eventos.set(mPf[1], porQ)
      continue
    }
    const mVd = k.match(/^venta_dash_v3_(\d+)$/)
    if (mVd) {
      try {
        const j = JSON.parse(v)
        if (j?.pagoIso) pagadas.set(mVd[1], String(j.pagoIso))
      } catch {}
    }
  }

  // Hitos en orden de embudo. Cada celda muestra la hora del PRIMER evento.
  const HITOS: Array<{ id: string; titulo: string }> = [
    { id: "emitida", titulo: "Emitida" },
    { id: "abrio", titulo: "Abrió página" },
    { id: "terminos", titulo: "Vio T&C" },
    { id: "acepto", titulo: "Aceptó" },
    { id: "pago_abierto", titulo: "Vio pago" },
    { id: "metodo", titulo: "Eligió método" },
    { id: "salida_mp", titulo: "Fue a MP" },
    { id: "pagada", titulo: "PAGADA" },
  ]

  const fmtDT = (iso: string) => {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ""
    return d.toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  }
  const edad = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return ""
    const h = Math.floor(ms / 3600000)
    if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}m`
    if (h < 48) return `${h}h`
    return `${Math.floor(h / 24)}d`
  }

  const filas = punteros.map((q) => {
    const ev = eventos.get(String(q.quote_id)) || new Map<string, string>()
    const pago = pagadas.get(String(q.quote_id)) || ""
    const celda = (id: string): { iso: string; extra?: string } => {
      if (id === "emitida") return { iso: q.created_at }
      if (id === "pagada") return { iso: pago }
      if (id === "metodo") {
        const t = ev.get("metodo_tarjeta")
        const tr = ev.get("metodo_transferencia")
        if (t && tr) return { iso: t < tr ? t : tr, extra: "ambos" }
        if (t) return { iso: t, extra: "tarjeta" }
        if (tr) return { iso: tr, extra: ev.get("transfer_wsp_click") || ev.get("comprobante_wsp") ? "transfer+wsp" : "transfer" }
        return { iso: "" }
      }
      return { iso: ev.get(id) || "" }
    }
    const celdas = HITOS.map((h) => ({ ...h, ...celda(h.id) }))
    // Último hito alcanzado = dónde está pegada.
    let ultimo = 0
    for (const [i, c] of celdas.entries()) if (c.iso) ultimo = i
    return { q, celdas, ultimo, pagada: Boolean(pago) }
  })

  // Resumen de dónde se pegan (solo las no pagadas).
  const pegadas = new Map<string, number>()
  for (const f of filas) {
    if (f.pagada) continue
    const t = f.celdas[f.ultimo]?.titulo || "?"
    pegadas.set(t, (pegadas.get(t) || 0) + 1)
  }
  const resumen = [...pegadas.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span style="display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;border-radius:999px;padding:3px 10px;margin:2px;font-size:12.5px"><b>${n}</b> pegadas en “${esc(t)}”</span>`)
    .join(" ")

  const filasHtml = filas
    .map(({ q, celdas, ultimo, pagada }) => {
      const celdasHtml = celdas
        .map((c, i) => {
          if (!c.iso)
            return `<td style="text-align:center;color:#d1d5db">—</td>`
          const esUltimo = i === ultimo && !pagada
          const estilo = pagada && c.id === "pagada"
            ? "background:#dcfce7;font-weight:700"
            : esUltimo
              ? "background:#fef9c3;font-weight:600"
              : ""
          const extra = c.extra ? `<div style="font-size:10.5px;color:#6b7280">${esc(c.extra)}</div>` : ""
          const tiempo = esUltimo ? `<div style="font-size:10.5px;color:#b45309">hace ${edad(c.iso)}</div>` : ""
          return `<td style="text-align:center;${estilo}">${fmtDT(c.iso)}${extra}${tiempo}</td>`
        })
        .join("")
      return `<tr>
        <td><b>${esc(q.empresa || "(sin empresa)")}</b><div style="font-size:11px;color:#6b7280">${esc(q.contact)} · $${Number(q.total_clp || 0).toLocaleString("es-CL")}</div></td>
        ${celdasHtml}
      </tr>`
    })
    .join("")

  const html = `
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <h2 style="margin:6px 0">🧭 Funnel de cotizaciones — últimos ${dias} días (${filas.length})</h2>
    <a href="?key=${encodeURIComponent(key)}">← volver al dash</a>
  </div>
  <div style="margin:6px 0 12px">${resumen || ""}</div>
  <div style="font-size:12px;color:#6b7280;margin-bottom:10px">
    La celda amarilla es el ÚLTIMO hito alcanzado (ahí está pegada, con la edad). Verde = pagada.
    Los hitos de página (“Abrió” en adelante) se registran desde el 17-ago — cotizaciones anteriores solo muestran la emisión.
  </div>
  <div style="overflow-x:auto">
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <thead><tr style="background:#0ea5e9;color:#fff">
      <th style="text-align:left;padding:8px">Cotización</th>
      ${HITOS.map((h) => `<th style="padding:8px">${h.titulo}</th>`).join("")}
    </tr></thead>
    <tbody style="background:#fff">${filasHtml}</tbody>
  </table>
  </div>
  <style>td{padding:7px 8px;border-bottom:1px solid #e5e7eb}</style>`
  return page(html)
}


/** Pestaña "Editor de cotizaciones" (pedido Lalo 07-ago): buscador por número
 * (COT###) + cotizaciones recientes con link para verlas y editarlas con
 * Vicky Cotizaciones. Rama liviana: solo quote_pointers + un COQL best-effort
 * para número/estado. */
async function renderEditorCotizaciones(key: string): Promise<Response> {
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const punteros = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?select=contact,quote_id,empresa,rut,total_uf,total_clp,updated_at,pdf_url,acceptance_url&order=updated_at.desc&limit=60`,
    { headers: hSb, cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{
    contact: string
    quote_id: string | null
    empresa: string | null
    rut: string | null
    total_uf: number | null
    total_clp: number | null
    updated_at: string | null
    pdf_url: string | null
    acceptance_url: string | null
  }>
  const vivos = punteros.filter((p) => p.quote_id && !isTestContact(digits(p.contact)))

  // Número y estado desde Zoho (best-effort: sin esto la lista igual sirve).
  const zoho = new Map<string, { numero: string; estado: string }>()
  try {
    const token = await getZohoAccessToken()
    const ids = vivos.map((p) => String(p.quote_id))
    for (let i = 0; i < ids.length; i += 50) {
      const lista = ids.slice(i, i + 50).map((id) => `'${id}'`).join(",")
      const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query: `select id, Numero_Cotizacion, Estado_Cotizacion from ${QUOTE_MODULE} where id in (${lista}) limit 50`,
        }),
        cache: "no-store",
      })
      const rows = r.ok ? (((await r.json().catch(() => null)) as { data?: Array<Record<string, string>> } | null)?.data ?? []) : []
      for (const row of rows) zoho.set(String(row.id), { numero: String(row.Numero_Cotizacion || ""), estado: String(row.Estado_Cotizacion || "") })
    }
  } catch {}

  const filas = vivos
    .map((p) => {
      const d = digits(p.contact)
      const z = zoho.get(String(p.quote_id))
      const ver = String(p.pdf_url || p.acceptance_url || "")
      const total = p.total_uf
        ? `UF ${p.total_uf.toLocaleString("es-CL", { maximumFractionDigits: 2 })}`
        : p.total_clp
          ? `$${Math.round(p.total_clp).toLocaleString("es-CL")}`
          : "—"
      return `<tr>
        <td style="white-space:nowrap"><b>${esc(z?.numero || "—")}</b>${z?.estado ? `<div style="margin-top:2px"><span class="tag">${esc(z.estado)}</span></div>` : ""}</td>
        <td>${esc(p.empresa || "—")}<div class="sub" style="margin:0;font-size:12px">+${esc(d)}${p.rut ? ` · RUT ${esc(p.rut)}` : ""}</div></td>
        <td style="white-space:nowrap;text-align:right">${total}</td>
        <td style="white-space:nowrap">${fmtSantiago(String(p.updated_at || ""))}</td>
        <td style="white-space:nowrap">${ver ? `<a href="${esc(ver)}" target="_blank" rel="noopener">🧾 ver</a> · ` : ""}<a href="?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(d)}&cot=${encodeURIComponent(String(p.quote_id))}">✏️ editar</a></td>
      </tr>`
    })
    .join("")

  // PREFORMS SIN FORMAL (Lalo 07-ago): conversaciones que vieron precio
  // referencial y no tienen puntero — mismo listado, para emitir la formal
  // directo desde el contexto del chat.
  const conPuntero = new Set(vivos.map((p) => digits(p.contact)))
  const preforms = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?pref_escalon_at=not.is.null&select=contact,pref_escalon_at,last_user_at&order=pref_escalon_at.desc&limit=60`,
    { headers: hSb, cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ contact: string; pref_escalon_at: string | null; last_user_at: string | null }>
  const filasPreform = preforms
    .filter((c) => {
      const d = digits(c.contact)
      return d && !conPuntero.has(d) && !isTestContact(d)
    })
    .slice(0, 25)
    .map((c) => {
      const d = digits(c.contact)
      return `<tr>
        <td style="white-space:nowrap"><span class="tag" style="background:#fff7e0;color:#92700c">Preform</span></td>
        <td>+${esc(d)}</td>
        <td style="white-space:nowrap">${fmtSantiago(String(c.pref_escalon_at || ""))}</td>
        <td style="white-space:nowrap">${fmtSantiago(String(c.last_user_at || ""))}</td>
        <td style="white-space:nowrap"><a href="?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(d)}">➕ emitir formal</a></td>
      </tr>`
    })
    .join("")

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Editor de cotizaciones — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:22px;margin:0;color:#4e4e4e}
  h2{font-family:${GV_TITLE_FONT};font-weight:700;font-size:15px;margin:0 0 10px;color:#4e4e4e}
  .sub{color:#646464;font-size:13px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-top:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:16px"><img src="/gv/logo-full-color.svg" alt="GeoVictoria" style="height:30px"><h1>Editor de cotizaciones</h1></div>
    <div style="font-size:14px;white-space:nowrap;display:flex;gap:14px;flex-wrap:wrap">
      <a href="?key=${encodeURIComponent(key)}">📞 Gestión</a>
      <b>🧾 Editor de cotizaciones</b>
      <a href="?key=${encodeURIComponent(key)}&vista=analisis">📊 Análisis y KPIs</a>
    </div>
  </div>
  <div class="sub" style="margin-top:4px">Busca una cotización por su número o toma una de las recientes, y edítala conversando con Vicky Cotizaciones: cambia dotación, relojes o módulos con los precios oficiales, o aplica descuento (escalera oficial, tope 20%). El PDF se regenera, el link de aceptación no cambia y al cliente se le envía solo con tu OK.</div>
  <div class="card">
    <h2>🔍 Buscar por número</h2>
    <form method="GET" action="/api/vic-funnel" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="text" name="buscarcot" placeholder="Ej: COT400 o +56 9 1234 5678" required style="padding:9px 12px;border:1px solid #d0d5db;border-radius:8px;font-size:14px;font-family:inherit;width:220px">
      <button type="submit" style="background:#ffbb00;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;cursor:pointer">Buscar y abrir</button>
      <a href="?key=${encodeURIComponent(key)}&cotnueva=1" title="Crear una cotización nueva asignada a una oportunidad de Zoho" style="background:#00aff2;color:#fff;border-radius:8px;padding:9px 18px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;text-decoration:none">➕ Crear cotización</a>
    </form>
  </div>
  <div class="card">
    <h2>Cotizaciones recientes — ${vivos.length}</h2>
    ${vivos.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Cotización</th><th>Empresa / contacto</th><th style="text-align:right">Total c/IVA</th><th>Actualizada</th><th>Acciones</th></tr></thead><tbody>${filas}</tbody></table></div>` : `<p class="sub" style="margin:0">Sin cotizaciones registradas.</p>`}
  </div>
  <div class="card">
    <h2>Preforms sin formal — ${filasPreform ? filasPreform.split("<tr>").length - 1 : 0}</h2>
    <div class="sub" style="margin:0 0 8px">Clientes que vieron un precio referencial con Vicky y aún no tienen cotización formal. "Emitir formal" abre el chat con todo el contexto de la conversación.</div>
    ${filasPreform ? `<div style="overflow-x:auto"><table><thead><tr><th></th><th>Contacto</th><th>Precio visto</th><th>Últ. respuesta</th><th>Acciones</th></tr></thead><tbody>${filasPreform}</tbody></table></div>` : `<p class="sub" style="margin:0">Sin preforms pendientes.</p>`}
  </div>
</div></body></html>`
  return page(html)
}

/** MODO PREFORM (Lalo 07-ago): el contacto vio precio referencial con Vicky
 * pero no tiene formal — el chat abre YA con ese contexto para ajustar y
 * emitir la formal directo. */
async function renderVickyCotizacionesPreform(contact: string, key: string): Promise<Response> {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Formal desde preform — +${esc(contact)}</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:900px;margin:0 auto;padding:18px 16px 30px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:19px;margin:0 0 2px;color:#4e4e4e}
  .sub{color:#646464;font-size:12px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-top:14px}
  #chatBox{min-height:340px;max-height:62vh;overflow-y:auto;padding:4px 2px}
  .bub{display:flex;margin:6px 0}
  .bub>div{max-width:78%;padding:9px 13px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .bubU{justify-content:flex-end}.bubU>div{background:#FFF8E1;border:1px solid #f3dc9a}
  .bubA>div{background:#ffffff;border:1px solid #e5e7eb}
  .bubE>div{background:#fdecea;border:1px solid #f5c6c0;color:#8a1f11}
  .chip{display:inline-block;margin:4px 0;padding:4px 10px;border-radius:99px;font-size:12px;background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9}
  .chipErr{background:#fdecea;color:#8a1f11;border-color:#f5c6c0}
  .fila{display:flex;gap:8px;margin-top:10px}
  #msg{flex:1;padding:10px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:14px;font-family:inherit;resize:none}
  #btnSend{background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:0 16px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
  #btnSend:disabled{opacity:.5;cursor:default}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  img.logo{height:26px;vertical-align:middle;margin-right:10px}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}&vista=editor">← Volver al editor de cotizaciones</a></p>
  <h1><img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria">Vicky Cotizaciones — formal desde el preform</h1>
  <div class="sub">El cliente <b>+${esc(contact)}</b> vio un precio referencial con Vicky pero aún no tiene cotización formal. El agente parte con el contexto completo de esa conversación: puedes ajustar lo que quieras y emitir la formal de inmediato.</div>
  <div class="card">
    <div id="chatBox">
      <div class="bub bubA"><div>Hola 👋 Este cliente conversó con Vicky y vio un precio referencial, pero no tiene formal todavía. Escribe "resume" y te muestro la configuración que reconstruí del chat y lo que falta para emitir — o dime directamente qué cambiar y emito con eso.</div></div>
    </div>
    <div class="fila">
      <textarea id="msg" rows="2" placeholder='Ej: "resume", o "súbela a 30 y emítela con RUT 76.123.456-7"…'></textarea>
      <button id="btnSend" title="Le entrega tu mensaje al agente — al cliente no le llega nada">Enviar mensaje</button>
    </div>
  </div>
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      var CONTACT = ${JSON.stringify(contact)};
      var HIST = [];
      var box = document.getElementById("chatBox");
      var input = document.getElementById("msg");
      var btn = document.getElementById("btnSend");
      function burbuja(clase, texto) {
        var w = document.createElement("div");
        w.className = "bub " + clase;
        var d = document.createElement("div");
        d.textContent = texto;
        w.appendChild(d);
        box.appendChild(w);
        box.scrollTop = box.scrollHeight;
        return w;
      }
      function chip(texto, ok) {
        var c = document.createElement("div");
        var sp = document.createElement("span");
        sp.className = "chip" + (ok ? "" : " chipErr");
        sp.textContent = (ok ? "🔧 " : "⚠️ ") + texto;
        c.appendChild(sp);
        box.appendChild(c);
        box.scrollTop = box.scrollHeight;
      }
      async function enviar() {
        var t = input.value.trim();
        if (!t || btn.disabled) return;
        input.value = "";
        burbuja("bubU", t);
        var esperando = burbuja("bubA", "Vicky está trabajando…");
        btn.disabled = true;
        try {
          var res = await fetch(KEYQ + "&accion=cotpreform_chat&contact=" + encodeURIComponent(CONTACT), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ historial: HIST, mensaje: t }),
          });
          var j = null;
          try { j = await res.json(); } catch (e) {}
          esperando.remove();
          if (!res.ok || !j || !j.ok) {
            burbuja("bubE", (j && j.error) ? j.error : "Error " + res.status + " — intenta de nuevo.");
            return;
          }
          (j.eventos || []).forEach(function (e) { chip(e.resumen, e.ok); });
          burbuja("bubA", j.reply);
          HIST.push({ role: "user", content: t });
          HIST.push({ role: "assistant", content: j.reply });
          if (HIST.length > 30) HIST = HIST.slice(-30);
          if (j.redirigirA) {
            chip("Formal emitida — abriendo su editor…", true);
            setTimeout(function () { window.location.href = j.redirigirA; }, 1800);
          }
        } catch (e2) {
          esperando.remove();
          burbuja("bubE", "No se pudo enviar: " + e2);
        } finally {
          btn.disabled = false;
          input.focus();
        }
      }
      btn.addEventListener("click", enviar);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
      });
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Selector de OPORTUNIDAD para crear una cotización (pedido Lalo 07-ago):
 * lista los deals activos de Zoho con búsqueda en vivo — escribes el nombre y
 * la lista se acorta; eliges uno y se abre el chat de creación. */
async function renderSelectorDeal(key: string): Promise<Response> {
  const deals = (await fetchDealsEquipo(true).catch(() => [])) as DealEquipo[]
  const filas = deals
    .filter((d) => !/congelad|perdido/i.test(String(d.Stage || "")))
    .sort((a, b) => String(a["Account_Name.Account_Name"] || a.Deal_Name || "").localeCompare(String(b["Account_Name.Account_Name"] || b.Deal_Name || ""), "es"))
    .map((d) => {
      const tel = digits(String(d["Contact_Name.Mobile"] || d["Contact_Name.Phone"] || ""))
      const empresa = String(d["Account_Name.Account_Name"] || "").trim() || String(d.Deal_Name || "").trim() || "(sin nombre)"
      const dueno = `${d["Owner.first_name"] || ""} ${d["Owner.last_name"] || ""}`.trim() || "—"
      return `<tr class="filaDeal">
        <td><b>${esc(empresa)}</b><div class="sub" style="margin:0;font-size:12px">${esc(String(d.Deal_Name || ""))}</div></td>
        <td><span class="tag">${esc(String(d.Stage || "—"))}</span></td>
        <td>${esc(dueno)}</td>
        <td style="white-space:nowrap">${tel ? `+${esc(tel)}` : `<span class="sub">sin teléfono</span>`}</td>
        <td style="white-space:nowrap"><a href="/calculadora-comercial.html?deal=${encodeURIComponent(String(d.id))}&key=${encodeURIComponent(key)}">elegir →</a></td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nueva cotización — elegir oportunidad</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0;color:#4e4e4e}
  .sub{color:#646464;font-size:13px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-top:14px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  #buscar{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:15px;font-family:inherit}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}&vista=editor">← Volver al editor de cotizaciones</a></p>
  <h1><img src="/gv/logo-full-color.svg" alt="GeoVictoria" style="height:28px;vertical-align:middle;margin-right:10px">Nueva cotización — ¿a qué oportunidad se asigna?</h1>
  <div class="sub" style="margin-top:4px">La cotización nace amarrada al deal que elijas (misma cuenta, mismo contacto, mismo dueño — sin duplicar registros). Escribe para acortar la lista.</div>
  <div class="card">
    <input id="buscar" type="text" placeholder="Busca por empresa, deal, dueño o etapa…" autofocus>
    <div style="overflow-x:auto;margin-top:12px"><table>
      <thead><tr><th>Empresa / deal</th><th>Etapa</th><th>Dueño</th><th>Contacto</th><th></th></tr></thead>
      <tbody id="cuerpoDeals">${filas || ""}</tbody>
    </table></div>
    <p class="sub" id="sinResultados" style="display:none;margin:12px 0 0">Ninguna oportunidad calza con la búsqueda.</p>
    ${filas ? "" : `<p class="sub" style="margin:12px 0 0">No hay oportunidades activas en Zoho.</p>`}
  </div>
  <script>
    (function () {
      var input = document.getElementById("buscar");
      var cuerpo = document.getElementById("cuerpoDeals");
      var aviso = document.getElementById("sinResultados");
      var KEY = ${JSON.stringify(key)};
      var timer = null;
      var idsEnTabla = {};
      function filasActuales() { return Array.prototype.slice.call(cuerpo.querySelectorAll("tr")); }
      filasActuales().forEach(function (tr) {
        var a = tr.querySelector("a[href]");
        var m = a && a.getAttribute("href").match(/deal=(\\d+)/);
        if (m) idsEnTabla[m[1]] = true;
      });
      function esc(s) { var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
      function filtrar() {
        var q = input.value.trim().toLowerCase();
        var visibles = 0;
        filasActuales().forEach(function (tr) {
          var ok = !q || tr.textContent.toLowerCase().indexOf(q) !== -1;
          tr.style.display = ok ? "" : "none";
          if (ok) visibles++;
        });
        aviso.style.display = visibles ? "none" : "block";
        return visibles;
      }
      // El listado precargado es una VENTANA (deals con actividad reciente).
      // Lo que no aparece localmente se busca directo en Zoho y se agrega.
      function buscarEnZoho(q) {
        fetch("?key=" + encodeURIComponent(KEY) + "&accion=cotdeals_buscar&q=" + encodeURIComponent(q), { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            // Error de Zoho ≠ cero resultados: decirlo evita que el vendedor
            // concluya que el deal no existe (incidente token 17-ago).
            if (!d || !d.ok) {
              aviso.textContent = "⚠️ No pude buscar en Zoho (" + ((d && d.error) || "sin respuesta") + "). Reintenta en unos segundos.";
              aviso.style.display = "block";
              return;
            }
            ((d && d.deals) || []).forEach(function (x) {
              if (!x.id || idsEnTabla[x.id]) return;
              idsEnTabla[x.id] = true;
              var tr = document.createElement("tr");
              tr.className = "filaDeal";
              tr.innerHTML = "<td><b>" + esc(x.empresa) + "</b><div class=\\"sub\\" style=\\"margin:0;font-size:12px\\">" + esc(x.deal) + "</div></td>" +
                "<td><span class=\\"tag\\">" + esc(x.etapa) + "</span></td>" +
                "<td>" + esc(x.dueno) + "</td>" +
                "<td style=\\"white-space:nowrap\\">" + (x.telefono ? "+" + esc(x.telefono) : "<span class=\\"sub\\">sin tel\u00e9fono</span>") + "</td>" +
                "<td style=\\"white-space:nowrap\\"><a href=\\"/calculadora-comercial.html?deal=" + encodeURIComponent(x.id) + "&key=" + encodeURIComponent(KEY) + "\\">elegir \u2192</a></td>";
              cuerpo.appendChild(tr);
            });
            var visibles = filtrar();
            aviso.textContent = visibles ? "" : "Ninguna oportunidad calza con la b\u00fasqueda (tampoco en Zoho).";
            aviso.style.display = visibles ? "none" : "block";
          })
          .catch(function () {
            aviso.textContent = "\u26a0\ufe0f No pude buscar en Zoho (error de red). Reintenta en unos segundos.";
            aviso.style.display = "block";
          });
      }
      input.addEventListener("input", function () {
        filtrar();
        var q = input.value.trim();
        if (timer) clearTimeout(timer);
        if (q.length >= 3) {
          aviso.textContent = "Buscando tambi\u00e9n en Zoho\u2026";
          timer = setTimeout(function () { buscarEnZoho(q); }, 450);
        }
      });
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Chat de CREACIÓN de cotización sobre el deal elegido (pedido Lalo 07-ago):
 * el vendedor entrega los datos mínimos conversando y la formal nace amarrada
 * al deal; al terminar, redirige al editor de esa cotización. */
async function renderVickyCotizacionesCrear(dealId: string, key: string, motorEjec = false): Promise<Response> {
  const info = await infoDeal(dealId)
  if (!info) {
    return paginaAviso(
      "Oportunidad no encontrada",
      `<p>No pude leer el deal <b>${esc(dealId)}</b> en Zoho.</p><p><a href="?key=${encodeURIComponent(key)}&cotnueva=1">← Volver a elegir oportunidad</a></p>`,
    )
  }
  const fichaHtml = panelDealHtml(info)
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nueva cotización — ${esc(info.accountNombre || info.nombre)}</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:18px 16px 30px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:19px;margin:0 0 2px;color:#4e4e4e}
  .sub{color:#646464;font-size:12px}
  .cols{display:flex;gap:16px;align-items:flex-start;margin-top:14px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px}
  .lado{width:360px;flex:none;position:sticky;top:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  .chatCol{flex:1;min-width:0;display:flex;flex-direction:column}
  #chatBox{min-height:340px;max-height:60vh;overflow-y:auto;padding:4px 2px}
  .bub{display:flex;margin:6px 0}
  .bub>div{max-width:78%;padding:9px 13px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .bubU{justify-content:flex-end}.bubU>div{background:#FFF8E1;border:1px solid #f3dc9a}
  .bubA>div{background:#ffffff;border:1px solid #e5e7eb}
  .bubE>div{background:#fdecea;border:1px solid #f5c6c0;color:#8a1f11}
  .chip{display:inline-block;margin:4px 0;padding:4px 10px;border-radius:99px;font-size:12px;background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9}
  .chipErr{background:#fdecea;color:#8a1f11;border-color:#f5c6c0}
  .fila{display:flex;gap:8px;margin-top:10px}
  #msg{flex:1;padding:10px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:14px;font-family:inherit;resize:none}
  #btnSend{background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:0 16px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
  #btnSend:disabled{opacity:.5;cursor:default}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  img.logo{height:26px;vertical-align:middle;margin-right:10px}
  @media (max-width:760px){.cols{flex-direction:column}.lado{width:auto;position:static}}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}&cotnueva=1">← Elegir otra oportunidad</a></p>
  <h1><img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria">${motorEjec ? "Cotizadora de Ejecutivos — catálogo comercial" : "Vicky Cotizaciones — nueva cotización"}</h1>
  <div class="sub">Se asignará a la oportunidad <b>${esc(info.nombre || info.accountNombre)}</b> (misma cuenta, contacto y dueño en Zoho). ${motorEjec ? "Catálogo comercial COMPLETO (1-8.000 usuarios, equipos, casino, BI, promos — precios del canal ejecutivo). El agente no envía nada al cliente: eso es con los botones del editor." : "Cuéntale al agente qué necesita la cotización y la emite de inmediato; después te lleva al editor para ajustes o envío."}${
    // UNA SOLA PUERTA (Lalo 27-ago, "esconde lo que pueda confundir"): los
    // accesos al motor ejecutivo y a la calculadora UI generaban propuestas
    // por caminos paralelos y el equipo se perdía. Siguen operativos por URL
    // directa para admin; para reexponerlos, env VICKY_COTIZADORAS_ALTERNAS=1.
    (process.env.VICKY_COTIZADORAS_ALTERNAS || "").trim() === "1"
      ? ` · <a href="?key=${encodeURIComponent(key)}&cotcrear=${encodeURIComponent(dealId)}${motorEjec ? "" : "&motor=ejecutivo"}">${motorEjec ? "← usar Vicky clásico (catálogo SMB)" : "usar catálogo comercial completo →"}</a> · <a href="/calculadora-comercial-full.html?deal=${encodeURIComponent(dealId)}&key=${encodeURIComponent(key)}" target="_blank">abrir CALCULADORA comercial (UI) →</a>`
      : ""
  }</div>
  <div class="cols">
    <div class="chatCol card">
      <div id="chatBox">
        <div class="bub bubA"><div>Hola 👋 Vamos a crear la cotización para ${esc(info.accountNombre || info.nombre)}. Dime la dotación (cuántos trabajadores), si lleva reloj de marcaje (y en qué comuna se instalaría), y ${info.rut ? "confirmo el RUT de la ficha" : "el RUT de la empresa"}. Con eso la emito de inmediato, amarrada a esta oportunidad.</div></div>
      </div>
      <div class="fila">
        <textarea id="msg" rows="2" placeholder="Ej: 15 trabajadores, solo app, RUT 76.123.456-7…"></textarea>
        <button id="btnSend" title="Le entrega tu mensaje al agente — al cliente no le llega nada">Enviar mensaje</button>
      </div>
    </div>
    <div class="lado"><div class="card">${fichaHtml}</div></div>
  </div>
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      var DEAL = ${JSON.stringify(dealId)};
      var HIST = [];
      var box = document.getElementById("chatBox");
      var input = document.getElementById("msg");
      var btn = document.getElementById("btnSend");
      function burbuja(clase, texto) {
        var w = document.createElement("div");
        w.className = "bub " + clase;
        var d = document.createElement("div");
        d.textContent = texto;
        w.appendChild(d);
        box.appendChild(w);
        box.scrollTop = box.scrollHeight;
        return w;
      }
      function chip(texto, ok) {
        var c = document.createElement("div");
        var s = document.createElement("span");
        s.className = "chip" + (ok ? "" : " chipErr");
        s.textContent = (ok ? "🔧 " : "⚠️ ") + texto;
        c.appendChild(s);
        box.appendChild(c);
        box.scrollTop = box.scrollHeight;
      }
      async function enviar() {
        var t = input.value.trim();
        if (!t || btn.disabled) return;
        input.value = "";
        burbuja("bubU", t);
        var esperando = burbuja("bubA", "Vicky está trabajando…");
        btn.disabled = true;
        try {
          var res = await fetch(KEYQ + "&accion=${motorEjec ? "cotejec_chat" : "cotcrear_chat"}&deal=" + encodeURIComponent(DEAL), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ historial: HIST, mensaje: t }),
          });
          var j = null;
          try { j = await res.json(); } catch (e) {}
          esperando.remove();
          if (!res.ok || !j || !j.ok) {
            burbuja("bubE", (j && j.error) ? j.error : "Error " + res.status + " — intenta de nuevo.");
            return;
          }
          (j.eventos || []).forEach(function (e) { chip(e.resumen, e.ok); });
          burbuja("bubA", j.reply);
          HIST.push({ role: "user", content: t });
          HIST.push({ role: "assistant", content: j.reply });
          if (HIST.length > 30) HIST = HIST.slice(-30);
          if (j.redirigirA) {
            chip("Abriendo el editor de la cotización nueva…", true);
            setTimeout(function () { window.location.href = j.redirigirA; }, 1800);
          }
        } catch (e2) {
          esperando.remove();
          burbuja("bubE", "No se pudo enviar: " + e2);
        } finally {
          btn.disabled = false;
          input.focus();
        }
      }
      btn.addEventListener("click", enviar);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); }
      });
      input.focus();
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Ficha de la oportunidad elegida (panel del chat de creación). */
function panelDealHtml(info: InfoDeal): string {
  return `<h2 style="margin:0 0 2px;font-size:15px">${esc(info.accountNombre || info.nombre || "Oportunidad")}</h2>
  <div class="sub" style="margin:0 0 10px"><span class="tag">${esc(info.stage || "etapa ?")}</span></div>
  <div style="font-size:13px;line-height:1.7">
    <div><b>Deal:</b> ${esc(info.nombre || "—")}</div>
    <div><b>Dueño:</b> ${esc(info.ownerNombre || "—")}</div>
    <div><b>Contacto:</b> ${esc(info.contactoNombre || "—")}</div>
    <div><b>Teléfono:</b> ${info.telefono ? `+${esc(info.telefono)}` : "sin teléfono (la cotización se emite igual, pero no quedará editable por chat)"}</div>
    <div><b>Email:</b> ${esc(info.email || "—")}</div>
    <div><b>RUT ficha:</b> ${esc(info.rut || "no registrado — pídelo al vendedor")}</div>
  </div>
  <div style="margin-top:10px;font-size:12px"><a href="${ZOHO_CRM_URL}/tab/Potentials/${esc(info.dealId)}" target="_blank" rel="noopener">🔗 Ver el deal en Zoho</a></div>`
}

/** Selector de EMPRESA para crear una propuesta (pedido Lalo 07-ago): los
 * deals de la cartera del vendedor logueado (Administrador ve todos), con
 * búsqueda en vivo. */
async function renderSelectorPropuesta(key: string, quien: string): Promise<Response> {
  const esAdminSel = !quien || quien === "Administrador"
  const deals = (await fetchDealsEquipo().catch(() => [])) as DealEquipo[]
  const filas = deals
    .filter((d) => !/congelad|perdido/i.test(String(d.Stage || "")))
    .filter((d) => esAdminSel || `${d["Owner.first_name"] || ""} ${d["Owner.last_name"] || ""}`.trim() === quien)
    .sort((a, b) => String(a["Account_Name.Account_Name"] || a.Deal_Name || "").localeCompare(String(b["Account_Name.Account_Name"] || b.Deal_Name || ""), "es"))
    .map((d) => {
      const empresa = String(d["Account_Name.Account_Name"] || "").trim() || String(d.Deal_Name || "").trim() || "(sin nombre)"
      const dueno = `${d["Owner.first_name"] || ""} ${d["Owner.last_name"] || ""}`.trim() || "—"
      return `<tr class="filaDeal">
        <td><b>${esc(empresa)}</b><div class="sub" style="margin:0;font-size:12px">${esc(String(d.Deal_Name || ""))}</div></td>
        <td><span class="tag">${esc(String(d.Stage || "—"))}</span></td>
        <td>${esc(dueno)}</td>
        <td style="white-space:nowrap"><a href="?key=${encodeURIComponent(key)}&propcrear=${encodeURIComponent(String(d.id))}">elegir →</a></td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nueva propuesta — elegir empresa</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0;color:#4e4e4e}
  .sub{color:#646464;font-size:13px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-top:14px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  #buscar{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:15px;font-family:inherit}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}">← Volver a gestión</a></p>
  <h1><img src="/gv/logo-full-color.svg" alt="GeoVictoria" style="height:28px;vertical-align:middle;margin-right:10px">Nueva propuesta — ¿para qué empresa?</h1>
  <div class="sub" style="margin-top:4px">${esAdminSel ? "Todas las oportunidades activas." : `Solo tu cartera (${esc(quien)}).`} Escribe para acortar la lista.</div>
  <div class="card">
    <input id="buscar" type="text" placeholder="Busca por empresa, deal o etapa…" autofocus>
    <div style="overflow-x:auto;margin-top:12px"><table>
      <thead><tr><th>Empresa / deal</th><th>Etapa</th><th>Dueño</th><th></th></tr></thead>
      <tbody id="cuerpoDeals">${filas || ""}</tbody>
    </table></div>
    <p class="sub" id="sinResultados" style="display:none;margin:12px 0 0">Ninguna empresa calza con la búsqueda.</p>
    ${filas ? "" : `<p class="sub" style="margin:12px 0 0">No hay oportunidades activas${esAdminSel ? "" : " en tu cartera"}.</p>`}
  </div>
  <script>
    (function () {
      var input = document.getElementById("buscar");
      var filas = Array.prototype.slice.call(document.querySelectorAll("#cuerpoDeals tr"));
      var aviso = document.getElementById("sinResultados");
      input.addEventListener("input", function () {
        var q = input.value.trim().toLowerCase();
        var visibles = 0;
        filas.forEach(function (tr) {
          var ok = !q || tr.textContent.toLowerCase().indexOf(q) !== -1;
          tr.style.display = ok ? "" : "none";
          if (ok) visibles++;
        });
        aviso.style.display = visibles ? "none" : "block";
      });
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Chat de creación de PROPUESTA sobre la empresa elegida (pedido Lalo
 * 07-ago): el vendedor entrega la información — y el guion de la reunión si
 * lo tiene (pegado o adjunto .txt) — y la propuesta con branding GV queda en
 * un link estable, imprimible como PDF. */
async function renderVickyPropuestasCrear(dealId: string, key: string): Promise<Response> {
  const [info, previa] = await Promise.all([infoDeal(dealId), propuestaGuardada(dealId)])
  if (!info) {
    return paginaAviso(
      "Oportunidad no encontrada",
      `<p>No pude leer el deal <b>${esc(dealId)}</b> en Zoho.</p><p><a href="?key=${encodeURIComponent(key)}&propnueva=1">← Volver a elegir empresa</a></p>`,
    )
  }
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vicky Propuestas — ${esc(info.accountNombre || info.nombre)}</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:18px 16px 30px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:19px;margin:0 0 2px;color:#4e4e4e}
  .sub{color:#646464;font-size:12px}
  .cols{display:flex;gap:16px;align-items:flex-start;margin-top:14px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px}
  .lado{width:360px;flex:none;position:sticky;top:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  .chatCol{flex:1;min-width:0;display:flex;flex-direction:column}
  #chatBox{min-height:340px;max-height:60vh;overflow-y:auto;padding:4px 2px}
  .bub{display:flex;margin:6px 0}
  .bub>div{max-width:78%;padding:9px 13px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .bubU{justify-content:flex-end}.bubU>div{background:#FFF8E1;border:1px solid #f3dc9a}
  .bubA>div{background:#ffffff;border:1px solid #e5e7eb}
  .bubE>div{background:#fdecea;border:1px solid #f5c6c0;color:#8a1f11}
  .chip{display:inline-block;margin:4px 0;padding:4px 10px;border-radius:99px;font-size:12px;background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9}
  .chipErr{background:#fdecea;color:#8a1f11;border-color:#f5c6c0}
  .fila{display:flex;gap:8px;margin-top:10px;align-items:flex-end}
  #msg{flex:1;padding:10px 12px;border:1px solid #d0d5db;border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;min-height:44px}
  #btnSend{background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:12px 16px;font-family:${GV_TITLE_FONT};font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
  #btnSend:disabled{opacity:.5;cursor:default}
  .adjunto{font-size:12px;color:#00aff2;cursor:pointer;font-weight:600}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  img.logo{height:26px;vertical-align:middle;margin-right:10px}
  @media (max-width:760px){.cols{flex-direction:column}.lado{width:auto;position:static}}
</style></head><body><div class="wrap">
  <p style="margin:0 0 10px"><a href="?key=${encodeURIComponent(key)}&propnueva=1">← Elegir otra empresa</a></p>
  <h1><img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria">Vicky Propuestas — ${esc(info.accountNombre || info.nombre)}</h1>
  <div class="sub">Cuéntale al agente qué va en la propuesta. Si tienes el guion o la minuta de la reunión, pégalo en el chat (o adjúntalo en .txt) y personaliza con eso. El link de la propuesta es estable: cada versión nueva lo actualiza.</div>
  <div class="cols">
    <div class="chatCol card">
      <div id="chatBox">
        <div class="bub bubA"><div>Hola 👋 Armemos la propuesta para ${esc(info.accountNombre || info.nombre)}. Cuéntame qué le vamos a ofrecer (módulos, marcaje, dotación, precios si van) y, si tienes el guion de la reunión, pégalo aquí — de ahí saco lo que el cliente realmente necesita. Genero la primera versión de inmediato y la pulimos juntas.</div></div>
      </div>
      <div class="fila">
        <textarea id="msg" rows="2" placeholder="Ej: ofréceles asistencia con app para 35 personas… (puedes pegar el guion completo de la reunión)"></textarea>
        <button id="btnSend" title="Le entrega tu mensaje al agente">Enviar mensaje</button>
      </div>
      <div style="margin-top:6px"><label class="adjunto">📎 Adjuntar guion (.txt)<input id="adjunto" type="file" accept=".txt,text/plain" style="display:none"></label> <span class="sub">— para Word: copia y pega el texto en el chat.</span></div>
    </div>
    <div class="lado">
      <div class="card">
        <h2 style="margin:0 0 2px;font-size:15px">${esc(info.accountNombre || info.nombre)}</h2>
        <div class="sub" style="margin:0 0 10px"><span class="tag">${esc(info.stage || "etapa ?")}</span></div>
        <div style="font-size:13px;line-height:1.7">
          <div><b>Deal:</b> ${esc(info.nombre || "—")}</div>
          <div><b>Dueño:</b> ${esc(info.ownerNombre || "—")}</div>
          <div><b>Contacto:</b> ${esc(info.contactoNombre || "—")}${info.email ? ` · ${esc(info.email)}` : ""}</div>
        </div>
        <div id="linkProp" style="margin-top:12px;font-size:13px${previa ? "" : ";display:none"}"><a href="?key=${encodeURIComponent(key)}&prop_ver=${encodeURIComponent(dealId)}" target="_blank">📄 Ver la propuesta actual</a></div>
        <div style="margin-top:8px;font-size:12px"><a href="${ZOHO_CRM_URL}/tab/Potentials/${esc(dealId)}" target="_blank" rel="noopener">🔗 Ver el deal en Zoho</a></div>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      var DEAL = ${JSON.stringify(dealId)};
      var HIST = [];
      var box = document.getElementById("chatBox");
      var input = document.getElementById("msg");
      var btn = document.getElementById("btnSend");
      function burbuja(clase, texto) {
        var w = document.createElement("div");
        w.className = "bub " + clase;
        var d = document.createElement("div");
        d.textContent = texto;
        w.appendChild(d);
        box.appendChild(w);
        box.scrollTop = box.scrollHeight;
        return w;
      }
      function chip(texto, ok) {
        var c = document.createElement("div");
        var s = document.createElement("span");
        s.className = "chip" + (ok ? "" : " chipErr");
        s.textContent = (ok ? "📑 " : "⚠️ ") + texto;
        c.appendChild(s);
        box.appendChild(c);
        box.scrollTop = box.scrollHeight;
      }
      document.getElementById("adjunto").addEventListener("change", function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () {
          input.value = (input.value ? input.value + "\\n\\n" : "") + "GUION DE LA REUNIÓN:\\n" + String(r.result || "").slice(0, 25000);
          input.focus();
        };
        r.readAsText(f);
      });
      async function enviar() {
        var t = input.value.trim();
        if (!t || btn.disabled) return;
        input.value = "";
        burbuja("bubU", t.length > 600 ? t.slice(0, 600) + " […guion adjunto completo]" : t);
        var esperando = burbuja("bubA", "Vicky está armando la propuesta…");
        btn.disabled = true;
        try {
          var res = await fetch(KEYQ + "&accion=propcrear_chat&deal=" + encodeURIComponent(DEAL), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ historial: HIST, mensaje: t }),
          });
          var j = null;
          try { j = await res.json(); } catch (e) {}
          esperando.remove();
          if (!res.ok || !j || !j.ok) {
            burbuja("bubE", (j && j.error) ? j.error : "Error " + res.status + " — intenta de nuevo.");
            return;
          }
          (j.eventos || []).forEach(function (e) { chip(e.resumen, e.ok); });
          burbuja("bubA", j.reply);
          HIST.push({ role: "user", content: t });
          HIST.push({ role: "assistant", content: j.reply });
          if (HIST.length > 30) HIST = HIST.slice(-30);
          if (j.propuestaUrl) {
            document.getElementById("linkProp").style.display = "";
            chip("Lista — ábrela con '📄 Ver la propuesta actual' (se abre en otra pestaña).", true);
          }
        } catch (e2) {
          esperando.remove();
          burbuja("bubE", "No se pudo enviar: " + e2);
        } finally {
          btn.disabled = false;
          input.focus();
        }
      }
      btn.addEventListener("click", enviar);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); }
      });
      input.focus();
    })();
  </script>
</div></body></html>`
  return page(html)
}

/** Página de aviso/error con branding GeoVictoria (pedido Lalo 04-ago): la
 * misma tarjeta centrada de la portada de acceso. El cuerpo llega como HTML
 * ya escapado por el llamador. */
function paginaAviso(titulo: string, cuerpoHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;width:min(92vw,460px);text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.06);box-sizing:border-box}
  .card img{height:34px;margin-bottom:18px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 10px;color:#4e4e4e}
  p{color:#646464;font-size:14px;line-height:1.5;margin:0 0 6px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  pre{text-align:left;background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:10px;font-size:12px;overflow-x:auto;color:#646464}
  code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style></head><body>
  <div class="card">
    <img src="/gv/logo-full-color.svg" alt="GeoVictoria">
    <h1>${esc(titulo)}</h1>
    ${cuerpoHtml}
  </div>
</body></html>`
  return page(html, status)
}

// ── Drill-down de KPIs (pedido Lalo 04-ago): cada número de las tarjetas es
// clickeable y abre la lista de SUS conversaciones (?lista=<bucket>), con los
// mismos filtros globales activos.
const KPI_BUCKETS: Record<string, { titulo: string; pred: (r: Row) => boolean }> = {
  total: { titulo: "Todas las conversaciones", pred: () => true },
  comercial: { titulo: "Intención comercial", pred: (r) => r.grupo === "comercial" },
  soporte: { titulo: "Soporte", pred: (r) => r.grupo === "soporte" },
  no_identificado: { titulo: "No identificado", pred: (r) => r.grupo === "no_identificado" },
  cotizacion: { titulo: "Flujo cotización", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "cotizacion" },
  reunion: { titulo: "Reunión", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "reunion" },
  lead: { titulo: "Lead (callback)", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "lead" },
  crosselling: { titulo: "Crosselling", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "crosselling" },
  solo_dudas: { titulo: "Solo dudas", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "solo_dudas" },
  preform: { titulo: "Vio precio y NO avanzó", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "preform_mostrado" },
  enviada: { titulo: "Cotización enviada", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "cotizacion_enviada" },
  abandonado: { titulo: "Se fue ANTES del precio", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "abandonado" },
}

function renderListaKpi(
  rowsBucket: Row[],
  titulo: string,
  key: string,
  volverQS: string,
  ultimoContactoPorConv: Map<string, string>,
  filaPorContacto: Map<string, FilaListado>,
  formularioSet: Set<string> = new Set(),
): Response {
  const ultimo = (r: Row) => ultimoContactoPorConv.get(r.conversation_id) || ""
  // Más reciente primero: el detalle es una lista de trabajo, no un archivo.
  rowsBucket = [...rowsBucket].sort((a, b) => ultimo(b).localeCompare(ultimo(a)))
  const filas = rowsBucket
    .map((r) => {
      // Ficha del listado comercial (empresa, escalera, dueño, accionable con
      // respaldo determinístico); si el caso no está en ese universo (p. ej.
      // soporte), se muestra lo que aporta el análisis de la conversación.
      const d = digits(r.contact)
      const f = filaPorContacto.get(d)
      const chips = [
        r.motivo_no_cierre ? `<span class="tag" style="background:#fdecea;color:#8a1f11">motivo: ${esc(r.motivo_no_cierre.replace(/_/g, " "))}</span>` : "",
        r.es_cliente_actual ? `<span class="tag" style="background:#e8f5e9;color:#1b5e20">cliente actual</span>` : "",
      ].filter(Boolean).join(" ")
      const estadoHtml = f
        ? `<span class="tag">${esc(f.estado)}</span><div class="sub" style="margin:3px 0 0;font-size:12px">${esc(f.estadoZoho)}</div>`
        : `<span class="tag">${esc((r.cotizacion_outcome || r.sub_bucket || r.grupo || "—").replace(/_/g, " "))}</span>`
      const accionable = (f?.accionable || r.accionable || "").trim() || "—"
      const resumen = (f?.resumen || r.resumen || "").trim()
      return `<tr>
        <td>${esc(f?.empresa || "(por identificar)")}<div class="sub" style="margin:0;font-size:12px">+${esc(d)}</div></td>
        <td style="white-space:nowrap">${fmtSantiago(ultimo(r))}</td>
        <td>${estadoHtml}${chips ? `<div style="margin-top:3px">${chips}</div>` : ""}</td>
        <td style="white-space:nowrap">${chipLlegoPor(formularioSet.has(d))}</td>
        <td>${esc(f?.propietario || "—")}</td>
        <td style="max-width:300px">${esc(accionable)}${resumen ? `<div class="sub" style="margin:3px 0 0;font-size:12px">${esc(resumen)}</div>` : ""}<div style="margin-top:4px"><a href="?key=${encodeURIComponent(key)}&conv=${esc(r.conversation_id)}">ver conversación →</a></div></td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 4px;color:#4e4e4e} .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <p><a href="${volverQS}">← Volver al embudo</a></p>
  <h1>${esc(titulo)}</h1>
  <div class="sub">${rowsBucket.length} conversación${rowsBucket.length === 1 ? "" : "es"} · respeta los filtros activos del embudo (país, fechas, estado, propietario)</div>
  <div class="card">${
    rowsBucket.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Empresa / contacto</th><th>Último contacto</th><th>Estado</th><th title="Cómo llegó el contacto: nos escribió directo por WhatsApp, o entró como lead cargado (formulario web / base) a la cadencia outbound">Llegó por</th><th>Ejecutivo a cargo</th><th>Accionable (Claude)</th></tr></thead><tbody>${filas}</tbody></table></div>`
      : `<p class="sub" style="margin:0">Sin conversaciones en esta categoría con los filtros actuales.</p>`
  }</div>
</div></body></html>`
  return page(html)
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// Vista de detalle de UNA conversación: transcript + ficha del análisis. Se
// abre desde el listado de "Motivos de no-cierre".
async function renderConversation(convId: string, key: string): Promise<Response> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const g = async (path: string): Promise<Record<string, unknown>[]> => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
    return r.ok ? ((await r.json()) as Record<string, unknown>[]) : []
  }
  const [msgs, ana] = await Promise.all([
    g(`vic_v3_messages?conversation_id=eq.${convId}&select=role,content,at&order=at.asc&limit=300`),
    g(`vic_v3_conversation_analysis?conversation_id=eq.${convId}&select=contact,resumen,motivo_no_cierre,sub_bucket,cotizacion_outcome&limit=1`),
  ])
  const a = ana[0] || {}
  // Relativo a la ruta actual: el dash también se sirve proxeado como
  // cotizacion.geovictoria.com/telemarketing (rewrite en el cotizador,
  // Lalo 07-ago) — un path absoluto /api/vic-funnel rompería el volver ahí.
  const back = `?key=${encodeURIComponent(key)}`
  const bubbles = msgs
    .map((m) => {
      const user = m.role === "user"
      const cuando = m.at ? ` · ${fmtSantiago(String(m.at))}` : ""
      return `<div class="msg ${user ? "u" : "a"}"><div class="who">${user ? "Cliente" : "Vicky"}${cuando}</div><div class="txt">${esc(m.content)}</div></div>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversación — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
  a{color:#00aff2;text-decoration:none} a:hover{text-decoration:underline}
  .hd{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .hd b{font-size:15px} .meta{color:#6b7280;font-size:13px;margin-top:4px}
  .chip{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px;margin-right:6px}
  .msg{margin:8px 0;display:flex;flex-direction:column}
  .msg.u{align-items:flex-end} .msg.a{align-items:flex-start}
  .who{font-size:11px;color:#9ca3af;margin:0 6px 2px}
  .txt{max-width:78%;padding:9px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap;word-wrap:break-word}
  .msg.u .txt{background:#d1e7ff} .msg.a .txt{background:#fff;border:1px solid #e5e7eb}
</style></head><body><div class="wrap">
  <p><a href="${back}">← Volver al embudo</a></p>
  <div class="hd">
    <b>Conversación · ${esc(a.contact || "")}</b>
    <div class="meta">
      ${a.sub_bucket ? `<span class="chip">${esc(a.sub_bucket)}</span>` : ""}
      ${a.cotizacion_outcome ? `<span class="chip">${esc(a.cotizacion_outcome)}</span>` : ""}
      ${a.motivo_no_cierre ? `<span class="chip">motivo: ${esc(a.motivo_no_cierre)}</span>` : ""}
    </div>
    ${a.resumen ? `<div class="meta">${esc(a.resumen)}</div>` : ""}
  </div>
  ${bubbles || "<p class='meta'>Sin mensajes.</p>"}
</div></body></html>`
  return page(html)
}

async function kvDel(key: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  }).catch(() => {})
}

/** Nota de gestión en el registro Zoho del contacto: primero el DEAL del
 * puntero de cotización (o la cotización si no hay deal), y como respaldo el
 * LEAD por teléfono. Best-effort: la gestión queda registrada en el dash
 * aunque Zoho falle. */
async function notaZohoGestion(contact: string, nota: string): Promise<boolean> {
  try {
    const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=like.*${contact.slice(-8)}&select=deal_id,quote_id&order=created_at.desc&limit=1`,
      { headers: h, cache: "no-store" },
    )
    const rows = r.ok ? ((await r.json().catch(() => [])) as Array<{ deal_id?: string | null; quote_id?: string | null }>) : []
    const token = await getZohoAccessToken()
    let parentId = String(rows[0]?.deal_id || "")
    let moduleName = "Deals"
    if (!parentId && rows[0]?.quote_id) {
      parentId = String(rows[0].quote_id)
      moduleName = QUOTE_MODULE
    }
    if (!parentId) {
      const s = await fetch(
        `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${encodeURIComponent(`(Phone:equals:+${contact})`)}&fields=id&per_page=1`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
      )
      const sd = s.ok && s.status !== 204 ? ((await s.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }) : {}
      parentId = String(sd?.data?.[0]?.id || "")
      moduleName = "Leads"
    }
    if (!parentId) return false
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Notes`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Note_Title: "Gestión telemarketing (dashboard Vicky)",
            Note_Content: nota,
            Parent_Id: parentId,
            "$se_module": moduleName,
          },
        ],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

// Acciones de la cola (botón ✔/↩): gestionar exige un registro de texto, lo
// guarda en vic_kv (expira en 24 h) y lo deja como NOTA en el registro Zoho
// del contacto; desgestionar borra la marca al instante (deshacer).
/** Login por correo + código (piloto /oportunidades2, Lalo 07-ago): paso 1
 * pide el correo corporativo; paso 2 el código de 6 dígitos que llegó por
 * email. La identidad queda amarrada a la ficha de usuario de Zoho. */
function renderLoginCorreo(paso: "correo" | "codigo", correo = "", error?: string): Response {
  const cuerpo =
    paso === "correo"
      ? `<p class="sub">Ingresa tu correo corporativo y te enviaremos un código de acceso.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <input type="email" name="correo" placeholder="tu.correo@geovictoria.com" value="${esc(correo)}" autofocus autocomplete="email">
    <button type="submit" formaction="?accion=dash_pedir_codigo">Enviarme el código</button>
    <details style="margin-top:16px;text-align:left">
      <summary style="font-size:12px;color:#9ca3af;cursor:pointer;text-align:center">Entrar como administrador</summary>
      <input type="password" name="clave" placeholder="Clave de administrador" style="margin-top:10px" autocomplete="off">
      <button type="submit" formaction="?accion=dash_admin" style="background:#4e4e4e">Entrar como admin</button>
    </details>`
      : `<p class="sub">Te enviamos un código de 6 dígitos a <b>${esc(correo)}</b> (revisa spam si no llega). Vence en 10 minutos.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <input type="hidden" name="correo" value="${esc(correo)}">
    <input type="text" name="codigo" placeholder="123456" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autofocus required autocomplete="one-time-code" style="text-align:center;font-size:22px;letter-spacing:6px">
    <button type="submit" formaction="?accion=dash_entrar">Entrar</button>
    <p style="margin:14px 0 0"><button type="submit" formaction="?accion=dash_pedir_codigo" style="background:none;border:none;color:#00aff2;font-size:13px;cursor:pointer;width:auto;padding:0">Reenviar código</button></p>`
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gestión de oportunidades — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;width:min(92vw,380px);text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.06)}
  .card img{height:34px;margin-bottom:18px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:22px;margin:0 0 6px;color:#4e4e4e}
  p.sub{color:#6b7280;font-size:13px;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;font-family:${GV_BODY_FONT};font-size:15px;margin-bottom:12px;outline-color:#00aff2;background:#fff;color:#4e4e4e}
  button{width:100%;padding:12px;border:0;border-radius:10px;background:#ffbb00;color:#fff;font-family:${GV_TITLE_FONT};font-weight:700;font-size:15px;cursor:pointer}
  button:hover{filter:brightness(.96)}
  .err{color:#b91c1c;font-size:13px;margin:0 0 12px}
</style></head><body>
  <form class="card" method="POST">
    <img src="/gv/logo-full-color.svg" alt="GeoVictoria">
    <h1>Gestión de oportunidades</h1>
    ${cuerpo}
  </form>
</body></html>`
  return page(html, error ? 401 : 200)
}

export async function POST(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const key = (searchParams.get("key") || "").trim()
  const accionPre = (searchParams.get("accion") || "").trim()
  // ── Login por correo + código (piloto /oportunidades2, Lalo 07-ago) ──────
  if (accionPre === "dash_pedir_codigo") {
    const form = new URLSearchParams(await req.text().catch(() => ""))
    const correo = (form.get("correo") || "").trim().toLowerCase().slice(0, 120)
    const { pedirCodigoDash, entradaSinCodigo } = await import("@/lib/dash-login-correo")
    // Excepción operativa (Lalo 07-ago): casillas a las que Zoho no puede
    // mandarles el código (lista de rebotados) entran directo con su
    // identidad — sesión normal, sin verificación.
    const directo = entradaSinCodigo(correo)
    if (directo) {
      const h = new Headers({ "content-type": "text/html; charset=utf-8" })
      h.append("set-cookie", `vic_auth=${authToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
      h.append("set-cookie", `vic_quien=${encodeURIComponent(directo)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
      return new Response(
        `<!doctype html><meta charset="utf-8"><script>location.href = location.pathname</script>`,
        { status: 200, headers: h },
      )
    }
    const r = await pedirCodigoDash(correo)
    if (!r.ok) return renderLoginCorreo("correo", correo, r.error)
    return renderLoginCorreo("codigo", correo)
  }
  if (accionPre === "dash_entrar") {
    const form = new URLSearchParams(await req.text().catch(() => ""))
    const correo = (form.get("correo") || "").trim().toLowerCase().slice(0, 120)
    const codigo = (form.get("codigo") || "").trim().slice(0, 10)
    const { verificarCodigoDash } = await import("@/lib/dash-login-correo")
    const r = await verificarCodigoDash(correo, codigo)
    if (!r.ok) return renderLoginCorreo("codigo", correo, r.error)
    const h = new Headers({ "content-type": "text/html; charset=utf-8" })
    h.append("set-cookie", `vic_auth=${authToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
    h.append("set-cookie", `vic_quien=${encodeURIComponent(r.quien)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
    return new Response(
      `<!doctype html><meta charset="utf-8"><script>location.href = location.pathname</script>`,
      { status: 200, headers: h },
    )
  }
  if (accionPre === "dash_admin") {
    // Entrada de ADMINISTRADOR con clave (sin código por correo). Reemplaza
    // al login legacy de clave compartida + selector de identidad, que quedó
    // sin UI pero seguía vivo como backdoor débil.
    const form = new URLSearchParams(await req.text().catch(() => ""))
    const clave = (form.get("clave") || "").trim()
    if (!ADMIN_CLAVE || clave !== ADMIN_CLAVE) {
      return renderLoginCorreo("correo", "", "Clave de administrador incorrecta.")
    }
    const h = new Headers({ "content-type": "text/html; charset=utf-8" })
    h.append("set-cookie", `vic_auth=${authToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
    h.append("set-cookie", `vic_quien=${encodeURIComponent("Administrador")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`)
    return new Response(
      `<!doctype html><meta charset="utf-8"><script>location.href = location.pathname</script>`,
      { status: 200, headers: h },
    )
  }
  if (!FUNNEL_KEY || key !== FUNNEL_KEY) {
    // Sesión humana por cookie (fuga 07-ago: las páginas de vendedores ya no
    // embeben la llave máquina, así que sus fetch llegan sin ?key=).
    let quienCookie = ""
    try {
      quienCookie = decodeURIComponent(cookieDe(req, "vic_quien") || "")
    } catch {}
    if (!(cookieDe(req, "vic_auth") === authToken() && quienCookie)) {
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "content-type": "application/json" } })
    }
  }
  const accion = accionPre
  // Creación de cotización sobre un deal (no requiere contact: el teléfono
  // sale de la ficha del deal en Zoho).
  if (accion === "cotpreform_chat") {
    // MODO PREFORM (Lalo 07-ago): formal directa desde la conversación.
    const contactP = (searchParams.get("contact") || "").replace(/\D/g, "").trim()
    if (!contactP) {
      return new Response(JSON.stringify({ ok: false, error: "contact faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const bodyP = (await req.json().catch(() => null)) as {
      historial?: Array<{ role?: string; content?: string }>
      mensaje?: string
    } | null
    const mensajeP = String(bodyP?.mensaje || "").trim().slice(0, 4000)
    if (!mensajeP) {
      return new Response(JSON.stringify({ ok: false, error: "mensaje faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const historialP = (Array.isArray(bodyP?.historial) ? bodyP.historial : [])
      .map((m) => ({
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m?.content || ""),
      }))
      .filter((m) => m.content.trim())
      .slice(-30)
    try {
      const r = await chatVickyCotizacionesPreform({ contact: contactP, historial: historialP, mensaje: mensajeP })
      const redirigirA = r.creado
        ? `?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(r.creado.contact)}&cot=${encodeURIComponent(r.creado.quoteId)}`
        : undefined
      return new Response(JSON.stringify({ ok: true, reply: r.reply, eventos: r.eventos, redirigirA }), {
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Búsqueda de deals EN VIVO para el selector (caso FRIOSAN 11-ago: el
  // listado precargado trae los deals con actividad más reciente y el org
  // tiene miles — lo que no está en la ventana se encuentra tecleando: esta
  // acción consulta Zoho directo por nombre de deal o de cuenta).
  if (accion === "cotdeals_buscar") {
    const q = (searchParams.get("q") || "").trim().slice(0, 60)
    if (q.length < 3) {
      return new Response(JSON.stringify({ ok: true, deals: [] }), { headers: { "content-type": "application/json" } })
    }
    try {
      const { fetchZoho } = await import("@/lib/zoho-token")
      const esc2 = q.replace(/'/g, "''")
      // v8: la query junta TRES lookups (Owner, Contact_Name, Account_Name) y
      // COQL v3 topa en 2 relaciones — respondía 400 LIMIT_EXCEEDED desde el
      // día uno y el catch silencioso lo disfrazaba de "sin resultados".
      const r = await fetchZoho(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query:
            `select id, Deal_Name, Stage, Owner.first_name, Owner.last_name, ` +
            `Contact_Name.Phone, Contact_Name.Mobile, Account_Name.Account_Name from Deals ` +
            `where ((Deal_Name like '%${esc2}%' or Account_Name.Account_Name like '%${esc2}%') ` +
            `and Stage not in ('Cierre Perdido', 'Congelado', 'Facturación congelada')) ` +
            `order by Modified_Time desc limit 30`,
        }),
      })
      // Un error de Zoho se DICE (17-ago): devolver lista vacía ante un 401
      // hizo creer al vendedor que el deal no existía y siguió sin deal.
      if (!r.ok && r.status !== 204) {
        const cuerpo = (await r.text().catch(() => "")).slice(0, 300)
        console.error(`[cotdeals_buscar] Zoho ${r.status}: ${cuerpo}`)
        return new Response(JSON.stringify({ ok: false, error: `Zoho respondió ${r.status} (${cuerpo.slice(0, 120)}) — reintenta en unos segundos` }), { status: 502, headers: { "content-type": "application/json" } })
      }
      const rows = r.status !== 204 ? (((await r.json().catch(() => ({}))) as { data?: DealEquipo[] }).data || []) : []
      const deals = rows.map((d) => ({
        id: String(d.id || ""),
        empresa: String(d["Account_Name.Account_Name"] || "").trim() || String(d.Deal_Name || "").trim() || "(sin nombre)",
        deal: String(d.Deal_Name || ""),
        etapa: String(d.Stage || "—"),
        dueno: `${d["Owner.first_name"] || ""} ${d["Owner.last_name"] || ""}`.trim() || "—",
        telefono: String(d["Contact_Name.Mobile"] || d["Contact_Name.Phone"] || "").replace(/\D/g, ""),
      }))
      return new Response(JSON.stringify({ ok: true, deals }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } })
    }
  }

  // ── CALCULADORA COMERCIAL (copia de gv-cotizador en public/, 11-ago) ──
  // Info del deal para el banner de la página.
  if (accion === "cotcalc_info") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const { infoDeal } = await import("@/lib/cotizaciones-editor")
      const info = await infoDeal(dealId)
      if (!info) {
        return new Response(JSON.stringify({ ok: false, error: "deal no encontrado" }), { status: 404, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ ok: true, info: { nombre: info.nombre, accountNombre: info.accountNombre, rut: info.rut, contactoNombre: info.contactoNombre, ownerNombre: info.ownerNombre } }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } })
    }
  }

  // Cotizaciones existentes de un deal (Lalo 11-ago, "¿actualizar o crear
  // nueva?"): el puente de la calculadora las lista ANTES de emitir para que
  // el ejecutivo elija entre versionar una (v2/vN) o crear otra. Las cerradas
  // (Aceptada/Pagada) se muestran deshabilitadas — el endpoint de
  // actualización las rechaza con COTIZACION_CERRADA.
  if (accion === "cotcalc_cotizaciones") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const { fetchZoho } = await import("@/lib/zoho-token")
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const r = await fetchZoho(`${api}/crm/v3/coql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query: `select id, Numero_Cotizacion, Name, Estado_Cotizacion, Version_PDF, PDF_URL, Created_Time from ${QUOTE_MODULE} where Deal_Asociado = ${dealId} order by Created_Time desc limit 20`,
        }),
      })
      // Si Zoho falla acá, decirlo es OBLIGATORIO: una lista vacía falsa hace
      // que el puente emita una cotización NUEVA en vez de versionar (v2/vN)
      // la existente — duplicado directo en el CRM (incidente 17-ago).
      if (!r.ok && r.status !== 204) {
        const cuerpo = (await r.text().catch(() => "")).slice(0, 300)
        console.error(`[cotcalc_cotizaciones] Zoho ${r.status}: ${cuerpo}`)
        return new Response(JSON.stringify({ ok: false, error: `Zoho respondió ${r.status} (${cuerpo.slice(0, 120)}) — reintenta en unos segundos` }), { status: 502, headers: { "content-type": "application/json" } })
      }
      const filas = (((await r.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; Numero_Cotizacion?: string; Name?: string; Estado_Cotizacion?: string; Version_PDF?: number; PDF_URL?: string; Created_Time?: string }>
      }).data || []).map((q) => ({
        id: String(q.id || ""),
        numero: String(q.Numero_Cotizacion || ""),
        nombre: String(q.Name || ""),
        estado: String(q.Estado_Cotizacion || ""),
        version: Number(q.Version_PDF || 1),
        pdfUrl: String(q.PDF_URL || ""),
        fecha: String(q.Created_Time || "").slice(0, 10),
        cerrada: /aceptada|pagada/i.test(String(q.Estado_Cotizacion || "")),
      }))
      return new Response(JSON.stringify({ ok: true, cotizaciones: filas }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } })
    }
  }

  // PDF de una cotización recién emitida (el puente de la calculadora hace
  // polling hasta que el render en segundo plano termina, y ahí lo descarga).
  if (accion === "cotcalc_pdf") {
    const quoteId = (searchParams.get("quote") || "").replace(/\D/g, "").trim()
    if (!quoteId) {
      return new Response(JSON.stringify({ ok: false, error: "quote faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const { fetchZoho } = await import("@/lib/zoho-token")
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const r = await fetchZoho(`${api}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=PDF_URL,Numero_Cotizacion,Version_PDF`)
      const rec = ((await r.json().catch(() => ({}))) as { data?: Array<{ PDF_URL?: string; Numero_Cotizacion?: string; Version_PDF?: number }> }).data?.[0]
      return new Response(JSON.stringify({ ok: true, pdfUrl: String(rec?.PDF_URL || ""), numero: String(rec?.Numero_Cotizacion || ""), version: Number(rec?.Version_PDF || 1) }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } })
    }
  }

  // Emisión desde la calculadora: snapshot de gatherProposalData() → ítems
  // (con verificación de integridad de totales) → create-from-vicky anclado
  // al deal, SIN correo al cliente. La entrega es siempre del ejecutivo.
  if (accion === "cotcalc_emitir") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const body = (await req.json().catch(() => null)) as { data?: Record<string, unknown> } | null
    const data = (body?.data || {}) as import("@/lib/cotizadora-ejecutivos/desde-calculadora").SnapshotCalculadora & { rutEmpresa?: string }
    try {
      const { itemsDesdeSnapshot } = await import("@/lib/cotizadora-ejecutivos/desde-calculadora")
      const r = itemsDesdeSnapshot(data)
      if (!r.ok) {
        return new Response(JSON.stringify({ ok: false, error: r.error }), { status: 400, headers: { "content-type": "application/json" } })
      }
      const { infoDeal } = await import("@/lib/cotizaciones-editor")
      const info = await infoDeal(dealId)
      if (!info) {
        return new Response(JSON.stringify({ ok: false, error: "deal no encontrado — la emisión requiere una oportunidad válida" }), { status: 404, headers: { "content-type": "application/json" } })
      }
      const { getUFActualSafe } = await import("@/lib/tools/generar-link-cotizadora")
      // UF: la que la calculadora mostró (para que el CLP calce con lo que el
      // ejecutivo vio); si la página no la traía, la del día.
      const ufPagina = Number(data.ufValue)
      const ufActual = ufPagina > 1000 ? ufPagina : await getUFActualSafe()
      const totalCLP = Math.round(r.totalUF * ufActual)

      // ── ACTUALIZAR una cotización existente del deal (Lalo 11-ago) ──
      // El ejecutivo eligió versionar (v2/vN) en vez de crear otra: misma
      // tubería del editor (actualizar-cotizacion — reemplaza los ítems,
      // sube Version_PDF, regenera el PDF en segundo plano y NO manda correo).
      // El link de aceptación no cambia. Las Aceptadas las rechaza el
      // endpoint con COTIZACION_CERRADA.
      const actualizarQuoteId = String((body as { actualizarQuoteId?: unknown } | null)?.actualizarQuoteId || "").replace(/\D/g, "")
      if (actualizarQuoteId) {
        const base = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
        const secreto = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
        const respAct = await fetch(`${base}/api/quote-acceptance/actualizar-cotizacion`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(secreto ? { "x-vicky-secret": secreto } : {}) },
          body: JSON.stringify({
            quoteId: actualizarQuoteId,
            resumenCambio: "Actualización desde la calculadora comercial (canal ejecutivo)",
            sinCorreoCliente: true,
            cotizacion: {
              items: r.items,
              ufActual: Number(ufActual.toFixed(2)),
              totalUF: r.totalUF,
              totalCLP,
            },
          }),
          cache: "no-store",
        })
        const dAct = (await respAct.json().catch(() => ({}))) as { ok?: boolean; version?: number; acceptance_url?: string; error?: string }
        if (!respAct.ok || !dAct.ok) {
          return new Response(JSON.stringify({ ok: false, error: String(dAct.error || `la actualización falló (HTTP ${respAct.status})`).slice(0, 300) }), { status: 502, headers: { "content-type": "application/json" } })
        }
        if (info.telefono && dAct.acceptance_url) {
          const { setQuotePointer } = await import("@/lib/supabase-persistence-v3")
          await setQuotePointer(info.telefono, {
            quoteId: actualizarQuoteId,
            dealId: info.dealId,
            acceptanceUrl: String(dAct.acceptance_url || ""),
            pdfUrl: "",
            totalClp: totalCLP,
            totalUf: r.totalUF,
            empresa: (String(data.empresa || "").trim() || info.accountNombre || undefined) as string | undefined,
          }).catch(() => {})
        }
        return new Response(JSON.stringify({
          ok: true,
          actualizada: true,
          quoteId: actualizarQuoteId,
          version: Number(dAct.version || 0),
          acceptanceUrl: String(dAct.acceptance_url || ""),
          totalUF: r.totalUF,
          totalCLP,
        }), { headers: { "content-type": "application/json" } })
      }

      const { formatearRut, rutValido } = await import("@/lib/rut")
      const rutCrudo = String(data.rutEmpresa || info.rut || "").trim()
      if (!rutCrudo || !rutValido(rutCrudo)) {
        return new Response(JSON.stringify({ ok: false, error: `RUT '${rutCrudo || "(vacío)"}' inválido — corrígelo en el campo RUT y reintenta.` }), { status: 400, headers: { "content-type": "application/json" } })
      }
      // Dotación para el deal: la cantidad de la línea de asistencia.
      const lineaAsist = (data.servicios || []).find((s) => /asistencia/i.test(String(s?.nombre || "")))
      const userCount = Number(lineaAsist?.cantidad) > 0 ? Number(lineaAsist?.cantidad) : undefined
      const { postCreateFromVicky } = await import("@/lib/cotizadora-ejecutivos/agente")
      const resp = await postCreateFromVicky({
        sinCorreoCliente: true,
        cliente: {
          empresa: (String(data.empresa || "").trim() || info.accountNombre || info.nombre || "").trim(),
          contacto: (String(data.contacto || "").trim() || info.contactoNombre || "Contacto").trim(),
          contactoEmail: info.email || undefined,
          contactoTelefono: info.telefono || "",
          rutEmpresa: formatearRut(rutCrudo),
          userCount,
          sectorEmpresa: "",
        },
        existing: {
          accountId: info.accountId || undefined,
          contactId: info.contactId || undefined,
          dealId: info.dealId,
          ownerId: info.ownerId || undefined,
        },
        cotizacion: {
          items: r.items,
          subtotalUF: r.subtotalUF,
          ivaUF: r.ivaUF,
          totalUF: r.totalUF,
          ufActual: Number(ufActual.toFixed(2)),
          totalCLP,
        },
      })
      if (!resp.ok) {
        return new Response(JSON.stringify({ ok: false, error: String(resp.error || resp.detail || "la cotizadora rechazó la emisión").slice(0, 300) }), { status: 502, headers: { "content-type": "application/json" } })
      }
      const quoteId = String(resp.quoteId || "")
      if (info.telefono && quoteId) {
        const { setQuotePointer } = await import("@/lib/supabase-persistence-v3")
        await setQuotePointer(info.telefono, {
          quoteId,
          dealId: String(resp.dealId || info.dealId),
          acceptanceUrl: String(resp.acceptanceUrl || ""),
          pdfUrl: String(resp.pdfUrl || ""),
          totalClp: totalCLP,
          totalUf: r.totalUF,
          rut: rutCrudo || undefined,
          empresa: (String(data.empresa || "").trim() || info.accountNombre || undefined) as string | undefined,
        }).catch(() => {})
      }
      return new Response(JSON.stringify({
        ok: true,
        quoteId,
        numero: "",
        acceptanceUrl: String(resp.acceptanceUrl || ""),
        totalUF: r.totalUF,
        totalCLP,
      }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }), { status: 502, headers: { "content-type": "application/json" } })
    }
  }

  if (accion === "cotejec_chat") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const body = (await req.json().catch(() => null)) as {
      historial?: Array<{ role?: string; content?: string }>
      mensaje?: string
    } | null
    const mensaje = String(body?.mensaje || "").trim().slice(0, 4000)
    if (!mensaje) {
      return new Response(JSON.stringify({ ok: false, error: "mensaje faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const historial = (Array.isArray(body?.historial) ? body.historial : [])
      .map((m) => ({
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m?.content || ""),
      }))
      .filter((m) => m.content.trim())
      .slice(-30)
    try {
      const { chatCotizadoraEjecutivos } = await import("@/lib/cotizadora-ejecutivos/agente")
      const r = await chatCotizadoraEjecutivos({ dealId, historial, mensaje })
      const redirigirA = r.creado
        ? `?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(r.creado.contact)}&cot=${encodeURIComponent(r.creado.quoteId)}`
        : undefined
      return new Response(JSON.stringify({ ok: true, reply: r.reply, eventos: r.eventos, redirigirA }), {
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  if (accion === "cotcrear_chat") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const body = (await req.json().catch(() => null)) as {
      historial?: Array<{ role?: string; content?: string }>
      mensaje?: string
    } | null
    const mensaje = String(body?.mensaje || "").trim().slice(0, 4000)
    if (!mensaje) {
      return new Response(JSON.stringify({ ok: false, error: "mensaje faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const historial = (Array.isArray(body?.historial) ? body.historial : [])
      .map((m) => ({
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m?.content || ""),
      }))
      .filter((m) => m.content.trim())
      .slice(-30)
    try {
      const r = await chatVickyCotizacionesCrear({ dealId, historial, mensaje })
      const redirigirA = r.creado
        ? `?key=${encodeURIComponent(key)}&coted=${encodeURIComponent(r.creado.contact)}&cot=${encodeURIComponent(r.creado.quoteId)}`
        : undefined
      return new Response(JSON.stringify({ ok: true, reply: r.reply, eventos: r.eventos, redirigirA }), {
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Chat de PROPUESTAS (pedido Lalo 07-ago): tampoco requiere contact. El
  // mensaje admite guiones de reunión largos (35k).
  if (accion === "propcrear_chat") {
    const dealId = (searchParams.get("deal") || "").replace(/\D/g, "").trim()
    if (!dealId) {
      return new Response(JSON.stringify({ ok: false, error: "deal faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const body = (await req.json().catch(() => null)) as {
      historial?: Array<{ role?: string; content?: string }>
      mensaje?: string
    } | null
    const mensaje = String(body?.mensaje || "").trim().slice(0, 35000)
    if (!mensaje) {
      return new Response(JSON.stringify({ ok: false, error: "mensaje faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const historial = (Array.isArray(body?.historial) ? body.historial : [])
      .map((m) => ({
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m?.content || ""),
      }))
      .filter((m) => m.content.trim())
      .slice(-30)
    let quienPost = ""
    try {
      quienPost = decodeURIComponent(cookieDe(req, "vic_quien") || "")
    } catch {}
    try {
      const r = await chatVickyPropuestas({ dealId, historial, mensaje, quien: quienPost || undefined })
      const propuestaUrl = r.propuestaUrl ? `?key=${encodeURIComponent(key)}&prop_ver=${encodeURIComponent(dealId)}` : undefined
      return new Response(JSON.stringify({ ok: true, reply: r.reply, eventos: r.eventos, propuestaUrl }), {
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  const contact = digits(searchParams.get("contact") || "")
  if (!contact) {
    return new Response(JSON.stringify({ ok: false, error: "contact faltante" }), { status: 400, headers: { "content-type": "application/json" } })
  }
  if (accion === "gestionar") {
    const body = await req.text().catch(() => "")
    const nota = (new URLSearchParams(body).get("nota") || searchParams.get("nota") || "").trim()
    if (!nota) {
      return new Response(JSON.stringify({ ok: false, error: "nota obligatoria" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const expira = new Date(Date.now() + 24 * 3600e3).toISOString()
    await kvSet(`gestion_${contact}`, JSON.stringify({ at: new Date().toISOString(), nota: nota.slice(0, 2000) }), expira)
    const notaOk = await notaZohoGestion(contact, nota)
    return new Response(JSON.stringify({ ok: true, notaZoho: notaOk }), { headers: { "content-type": "application/json" } })
  }
  if (accion === "desgestionar") {
    await kvDel(`gestion_${contact}`)
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
  }
  // Punto 5 (Lalo 08-ago): "ya lo contacté" — registra atención MANUAL del
  // vendedor. Cuenta como contacto real para el candado v3 (silencia los
  // seguimientos de Vicky), el panel de SLA y la válvula de precio. Pensado
  // para vendedores sin WhatsApp espejado (CO/MX/PE y CL sin vincular).
  if (accion === "atendido") {
    if (!contact) {
      return new Response(JSON.stringify({ ok: false, error: "contact requerido" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const quienBody = (() => {
      try { return decodeURIComponent(cookieDe(req, "vic_quien") || "") } catch { return "" }
    })()
    // Deshacer (Lalo 10-ago): la marca es reversible — se borra y Vicky
    // vuelve a hacerle seguimiento a ese contacto.
    if (searchParams.get("deshacer")) {
      await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`atencion_manual_${contact}`)}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      }).catch(() => {})
      await notaZohoGestion(contact, `Registro de contacto DESHECHO desde el dashboard${quienBody ? ` por ${quienBody}` : ""}: Vicky vuelve a hacerle seguimiento automático a este cliente.`).catch(() => false)
      return new Response(JSON.stringify({ ok: true, deshecho: true }), { headers: { "content-type": "application/json" } })
    }
    await kvSet(`atencion_manual_${contact}`, new Date().toISOString())
    await notaZohoGestion(contact, `Contacto manual registrado desde el dashboard${quienBody ? ` por ${quienBody}` : ""}: el vendedor declaró haber atendido a este cliente (los seguimientos automáticos de Vicky quedan en silencio).`).catch(() => false)
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
  }
  // Un turno del chat de Vicky Cotizaciones (pedido Lalo 06-ago). El historial
  // viaja del navegador en cada turno (stateless server-side, como el resto
  // del dashboard); la respuesta trae los eventos de tools y el panel de la
  // cotización re-renderizado para refrescarlo en vivo.
  if (accion === "coted_chat") {
    const body = (await req.json().catch(() => null)) as {
      historial?: Array<{ role?: string; content?: string }>
      mensaje?: string
    } | null
    const mensaje = String(body?.mensaje || "").trim().slice(0, 4000)
    if (!mensaje) {
      return new Response(JSON.stringify({ ok: false, error: "mensaje faltante" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const historial = (Array.isArray(body?.historial) ? body.historial : [])
      .map((m) => ({
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m?.content || ""),
      }))
      .filter((m) => m.content.trim())
      .slice(-30)
    const quoteIdSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim() || undefined
    try {
      const r = await chatVickyCotizaciones({ contact, historial, mensaje, quoteId: quoteIdSel })
      const est = await estadoCotizacion(contact, quoteIdSel).catch(() => null)
      return new Response(
        JSON.stringify({
          ok: true,
          reply: r.reply,
          eventos: r.eventos,
          enviado: r.enviadoAlCliente,
          panelHtml: est ? panelCotizacionHtml(est) : "",
        }),
        { headers: { "content-type": "application/json" } },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Vista previa del PDF (pedido Grey 07-ago, ok Lalo): regenera si hay
  // cambios sin versionar o el PDF quedó atrás de la cotización, y devuelve
  // la URL fresca SIN enviar nada al cliente. Lo que abre esta acción es
  // EXACTAMENTE lo que saldría al apretar cualquiera de los botones de envío
  // (mismo regenerarPdfFresco); un envío posterior sin nuevas ediciones no
  // genera otra versión.
  if (accion === "coted_preview") {
    const quoteIdSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim() || undefined
    try {
      const est = await estadoCotizacion(contact, quoteIdSel).catch(() => null)
      if (!est) {
        return new Response(JSON.stringify({ ok: false, error: "Este contacto no tiene cotización formal registrada." }), { status: 409, headers: { "content-type": "application/json" } })
      }
      const { regenerarPdfFresco, datosDeCotizacion } = await import("@/lib/enviar-cotizacion-wa")
      const fresco = await regenerarPdfFresco(est.puntero.quoteId).catch(() => "")
      // Sin regeneración (PDF al día): la URL autoritativa es la de Zoho — el
      // puntero local puede quedar atrás si una escritura best-effort falló.
      const zoho = fresco ? null : await datosDeCotizacion(est.puntero.quoteId).catch(() => null)
      const pdf = fresco || zoho?.pdfUrl || est.puntero.pdfUrl
      if (!pdf) {
        return new Response(JSON.stringify({ ok: false, error: "La cotización aún no tiene PDF." }), { status: 409, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ ok: true, pdf_url: pdf, regenerado: Boolean(fresco) }), { headers: { "content-type": "application/json" } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Botón "Crear Nota de Venta" del editor (Lalo 12-ago): convierte la COT en
  // NDV real de Creator vía el cotizador (handoff completo del post-pago:
  // numeración NDV-xxx, subforms, tabla de cobro y PDF). No toca al cliente.
  if (accion === "ndv_crear") {
    const quoteIdSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim()
    if (!quoteIdSel) {
      return new Response(JSON.stringify({ ok: false, error: "Falta la cotización (cot)." }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const base = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
      const secreto = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
      const r = await fetch(`${base}/api/creator/crear-ndv-desde-cot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secreto ? { "x-vicky-secret": secreto } : {}) },
        body: JSON.stringify({ quoteId: quoteIdSel }),
        cache: "no-store",
        signal: AbortSignal.timeout(55000),
      })
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
      return new Response(JSON.stringify(j ?? { ok: false, error: `HTTP ${r.status} del cotizador` }), {
        status: r.ok ? 200 : 502,
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Botón "Enviar a cliente por WhatsApp de Vicky" del panel del editor
  // (pedido Lalo 07-ago): manda el PDF vigente + mensaje corto, sin chat.
  if (accion === "coted_enviar") {
    const quoteIdSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim() || undefined
    try {
      const r = await enviarCotizacionAlClienteDirecto(contact, quoteIdSel)
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }
  // Envío desde el WhatsApp del VENDEDOR (pedido Lalo 07-ago): se encola en
  // vic_kv y el worker wa-espejo de esa sesión lo despacha desde el número
  // personal del vendedor. Estados del job: pendiente→enviando→enviado|error.
  if (accion === "coted_enviar_vendedor") {
    const body = (await req.json().catch(() => null)) as { sesion?: string } | null
    const sesion = String(body?.sesion || "").trim()
    if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(sesion)) {
      return new Response(JSON.stringify({ ok: false, error: "sesión inválida" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    let conectado = false
    try {
      conectado = (JSON.parse(await kvGet(`wa_espejo_status_${sesion}`)) as { estado?: string }).estado === "conectado"
    } catch {}
    if (!conectado) {
      return new Response(JSON.stringify({ ok: false, error: "Esa sesión de WhatsApp no está conectada al espejo." }), { status: 409, headers: { "content-type": "application/json" } })
    }
    const quoteIdSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim() || undefined
    const est = await estadoCotizacion(contact, quoteIdSel).catch(() => null)
    if (!est) {
      return new Response(JSON.stringify({ ok: false, error: "Este contacto no tiene cotización formal registrada." }), { status: 409, headers: { "content-type": "application/json" } })
    }
    // MISMO cinturón de frescura que los envíos por Vicky (Lalo 07-ago: "se
    // debe asegurar de que se envíe la última versión confirmada"): si hay
    // cambios sin versionar o el PDF quedó atrás de la cotización, se
    // regenera sincrónico ANTES de encolar; el job viaja con la URL fresca.
    const { regenerarPdfFresco } = await import("@/lib/enviar-cotizacion-wa")
    const pdfFrescoVend = await regenerarPdfFresco(est.puntero.quoteId).catch(() => "")
    const pdfJob = pdfFrescoVend || est.puntero.pdfUrl
    if (!pdfJob) {
      return new Response(JSON.stringify({ ok: false, error: "La cotización no tiene PDF disponible todavía." }), { status: 409, headers: { "content-type": "application/json" } })
    }
    const empresaJob = (est.puntero.empresa || "").trim().replace(/[^\p{L}\p{N} .-]/gu, "")
    const jobId = `wa_envio_${sesion}_${Date.now()}`
    await kvSet(
      jobId,
      JSON.stringify({
        to: contact,
        pdf_url: pdfJob,
        filename: empresaJob ? `Cotizacion GeoVictoria - ${empresaJob}.pdf`.slice(0, 100) : "Cotizacion GeoVictoria.pdf",
        caption: "Hola, te comparto la cotización actualizada de GeoVictoria 📄 Cualquier duda me dices.",
        status: "pendiente",
        quote_id: est.puntero.quoteId,
        at: new Date().toISOString(),
      }),
      new Date(Date.now() + 24 * 3600e3).toISOString(),
    )
    return new Response(JSON.stringify({ ok: true, jobId }), { headers: { "content-type": "application/json" } })
  }
  if (accion === "coted_envio_estado") {
    const body = (await req.json().catch(() => null)) as { jobId?: string } | null
    const jobId = String(body?.jobId || "").trim()
    if (!/^wa_envio_[a-zA-Z0-9_.-]{1,60}_\d+$/.test(jobId)) {
      return new Response(JSON.stringify({ ok: false, error: "jobId inválido" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    let status = ""
    let error = ""
    try {
      const p = JSON.parse(await kvGet(jobId)) as { status?: string; error?: string }
      status = String(p.status || "")
      error = String(p.error || "")
    } catch {}
    return new Response(JSON.stringify({ ok: true, status, error }), { headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { "content-type": "application/json" } })
}

/** Detalle de los KPIs de COTIZACIONES (Cotizaciones en Zoho / Aceptadas):
 * lista de cotizaciones con estado, fechas, ejecutivo y link al chat. */
function renderListaCotizaciones(
  quotes: RawAceptada[],
  titulo: string,
  key: string,
  volverQS: string,
  convPorContacto: Map<string, string>,
  wspSet: Set<string> = new Set(),
  formularioSet: Set<string> = new Set(),
): Response {
  const qs = [...quotes].sort((a, b) => String(b.Created_Time || "").localeCompare(String(a.Created_Time || "")))
  const filas = qs
    .map((q) => {
      const tel = digits(String(q.Tel_fono_Contacto || ""))
      const aceptada = esAceptadaOMas(q)
      const pagada = esPagada(q)
      const estado = pagada ? "Pagada" : String(q.Estado_Cotizacion || "—")
      const fechaPago = aceptada || pagada ? String(q.Fecha_Hora_Cotizacion || q.Modified_Time || "") : ""
      const owner = `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim() || "—"
      const convId = tel ? convPorContacto.get(tel) || "" : ""
      // Links de contexto por empresa (pedido Lalo 10-ago): registro en Zoho
      // (deal si existe, si no la cotización), WhatsApp espejado del vendedor
      // con el cliente y conversación de Vicky con el cliente.
      const zohoUrl = zohoUrlDe(String(q["Deal_Asociado.id"] || "") || null, null, String(q.id || "") || null)
      const links = [
        zohoUrl ? `<a href="${esc(zohoUrl)}" target="_blank" rel="noopener" title="Abrir el registro en Zoho CRM">🔗 Zoho</a>` : "",
        tel && wspSet.has(tel)
          ? `<a href="?key=${encodeURIComponent(key)}&wsp=${encodeURIComponent(tel)}" target="_blank" title="WhatsApp del vendedor con este cliente">📱 wsp vendedor</a>`
          : "",
        convId ? `<a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(convId)}" title="Conversación de Vicky con este cliente">📄 chat Vicky</a>` : "",
      ]
        .filter(Boolean)
        .join(" · ")
      return `<tr>
        <td>${esc(String(q.Numero_Cotizacion || ""))} · <b>${esc(empresaDeQuote(q))}</b><div class="sub" style="margin:0;font-size:12px">${tel ? `+${esc(tel)}` : "sin teléfono"}</div>${links ? `<div style="margin-top:2px;font-size:12px;white-space:nowrap">${links}</div>` : ""}</td>
        <td><span class="tag">${esc(estado)}</span></td>
        <td style="white-space:nowrap">${tel ? chipLlegoPor(formularioSet.has(tel)) : "—"}</td>
        <td style="white-space:nowrap">${fmtSantiago(String(q.Created_Time || ""))}</td>
        <td style="white-space:nowrap">${fechaPago ? fmtSantiago(fechaPago) : "—"}</td>
        <td>${esc(owner)}</td>
        <td>${esc(String(q["Deal_Asociado.Stage"] || "—"))}</td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 4px;color:#4e4e4e} .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <p><a href="${volverQS}">← Volver</a></p>
  <h1>${esc(titulo)}</h1>
  <div class="sub">${qs.length} cotizacion${qs.length === 1 ? "" : "es"} · respeta los filtros activos (país, fechas, estado, propietario)</div>
  <div class="card">${
    qs.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Cotización / contacto</th><th>Estado</th><th title="Cómo llegó el contacto: nos escribió directo por WhatsApp, o entró como lead cargado (formulario web / base) a la cadencia outbound">Llegó por</th><th>Emisión</th><th>Aceptación/pago</th><th>Ejecutivo</th><th>Etapa deal</th></tr></thead><tbody>${filas}</tbody></table></div>`
      : `<p class="sub" style="margin:0">Sin cotizaciones con los filtros actuales.</p>`
  }</div>
</div></body></html>`
  return page(html)
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  let key = (searchParams.get("key") || "").trim()
  // Cronómetro del render (26-ago, "el dash se cae al filtrar"): cada carga
  // deja su duración en el log para cazar los timeouts intermitentes.
  const t0Render = Date.now()
  const finLog = () => {
    const p = new URLSearchParams(searchParams)
    p.delete("key")
    console.log(`[funnel-timing] ${Math.round((Date.now() - t0Render) / 100) / 10}s ${p.toString().slice(0, 200)}`)
  }

  if (!FUNNEL_KEY) {
    return paginaAviso("Falta configurar VIC_FUNNEL_KEY", "<p>Define la variable de entorno <code>VIC_FUNNEL_KEY</code> en Vercel.</p>", 503)
  }
  // Cerrar sesión: limpia las cookies (Path=/ actual y el Path viejo, por si
  // queda una sesión anterior) y recarga por el navegador — mismo patrón
  // proxy-safe del login (el dash también vive en /telemarketing).
  if (searchParams.get("salir")) {
    const h = new Headers({ "content-type": "text/html; charset=utf-8" })
    h.append("set-cookie", "vic_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
    h.append("set-cookie", "vic_quien=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
    h.append("set-cookie", "vic_auth=; Path=/api/vic-funnel; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
    h.append("set-cookie", "vic_quien=; Path=/api/vic-funnel; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
    return new Response(
      `<!doctype html><meta charset="utf-8"><script>location.href = location.pathname</script>`,
      { status: 200, headers: h },
    )
  }
  // Identidad de la sesión (pedido Lalo 07-ago): quién entró por el login.
  // Vendedor → ve SU cartera; "Administrador" → todo. El acceso máquina por
  // ?key= sin cookie (crons, links de correos) no tiene identidad y ve todo.
  let quien = ""
  let quienCookie = ""
  try {
    quienCookie = decodeURIComponent(cookieDe(req, "vic_quien") || "")
  } catch {}
  const sesionHumana = cookieDe(req, "vic_auth") === authToken() && Boolean(quienCookie)
  if (key !== FUNNEL_KEY) {
    if (sesionHumana) key = FUNNEL_KEY
    else {
      // LECTURA DEL PANEL INTERNO (Lalo 19-ago, "al detalle me manda a
      // loguearme"): la cookie vic_inb (sembrada por /inbound?k=) autoriza
      // SIN LOGIN solo las vistas de lectura del panel — drill-downs
      // (inbdet), ver-chat (conv) y la vista inbound. Todo lo demás del
      // dash sigue con el login por correo.
      const pideLectura =
        Boolean((searchParams.get("inbdet") || "").trim()) ||
        Boolean((searchParams.get("conv") || "").replace(/[^a-fA-F0-9-]/g, "").trim()) ||
        // campanas y espejos también son de lectura para el panel interno
        // (Lalo 27-ago: pestañas en el dash nuevo de administrador).
        ["inbound", "campanas", "espejos"].includes((searchParams.get("vista") || "").trim())
      let lecturaOk = false
      if (pideLectura) {
        const tokInb = (() => {
          try { return decodeURIComponent(cookieDe(req, "vic_inb") || "") } catch { return "" }
        })()
        if (tokInb) {
          const esperado = (await kvGet("inbound_link_key")).trim()
          lecturaOk = Boolean(esperado) && tokInb === esperado
        }
      }
      // LOGIN OFICIAL (Lalo 07-ago, piloto aprobado): correo corporativo +
      // código por email, en todas las URLs.
      if (!lecturaOk) return renderLoginCorreo("correo")
      // key queda vacía: los links de estas páginas no exponen la llave.
    }
  }
  // LA COOKIE MANDA SIEMPRE (fuga 07-ago): los links internos llevaban la
  // llave máquina en ?key= y bastaba seguir uno ("Quitar filtros") para que
  // un vendedor perdiera su identidad y viera TODO. Si el navegador tiene
  // sesión humana, la identidad aplica aunque la URL traiga la llave.
  if (sesionHumana) {
    quien = quienCookie
    // Y las páginas de una sesión humana NO exponen la llave máquina en sus
    // links: la cookie autentica cada request (GET y POST). Solo el acceso
    // máquina real (sin cookie) conserva la llave en los links que genera.
    key = ""
  }

  // ── FOTO HORARIA DEL DASH (Lalo 19-ago, "que no demore tanto en cargar") ──
  // Las vistas pesadas SIN filtros se sirven al tiro desde una foto en vic_kv
  // que vic-dash-snap-cron regenera cada hora; el botón "⟳ Actualizar dash"
  // (?fresh=1) computa en vivo. Filtros, drill-downs y sesiones de VENDEDOR
  // (cartera propia) siguen 100% en vivo. La foto se guarda solo desde
  // renders con llave máquina (links con ?key=); al servirla a una sesión
  // humana se le quita la llave de los links (regla anti-fuga 07-ago) — la
  // cookie autentica igual.
  const fresh = searchParams.get("fresh") === "1"
  const vistaSnap = (searchParams.get("vista") || "").trim()
  const esAdminOMaquina = !quien || /admin/i.test(quien)
  // Un parámetro cuenta como NEUTRO si falta o trae su valor por defecto —
  // los links internos SIEMPRE llevan pais=cl y el form de filtros manda
  // desde=&hasta=&estado= vacíos, y eso no puede matar la foto (19-ago,
  // "la página se sigue demorando": la foto solo servía en la URL pelada).
  const paramNeutro = (k: string): boolean => {
    const vals = searchParams.getAll(k)
    switch (k) {
      case "key": case "vista": case "fresh": return true
      case "pais": return vals.every((v) => !v.trim() || v.trim().toLowerCase() === "cl")
      case "origen": return vals.every((v) => !v.trim() || v.trim().toLowerCase() === "vicky")
      case "desde": case "hasta": case "estado": case "prop": return vals.every((v) => !v.trim())
      default: return false
    }
  }
  const snapKey =
    esAdminOMaquina && ["", "gestion", "inbound"].includes(vistaSnap) && [...new Set(searchParams.keys())].every(paramNeutro)
      ? `dash_snap_${vistaSnap === "inbound" ? "inbound" : "main"}`
      : ""
  // ── INBOUND = PANEL INTERNO (Lalo 19-ago): vive en /inbound (URL propia,
  // sin login, sirve la foto). En esta URL solo lo ven la llave máquina
  // (cron de fotos) y los ADMINS (drill-downs al hacer clic desde /inbound);
  // cualquier otra sesión queda fuera.
  const pideInbound = vistaSnap === "inbound" || Boolean((searchParams.get("inbdet") || "").trim())
  if (pideInbound && !esAdminOMaquina) {
    return paginaAviso("Sección no disponible", "<p>Este panel es de gestión interna.</p>", 403)
  }
  // Link del panel interno para la pestaña (solo se muestra a admins).
  const inboundLinkKey = esAdminOMaquina ? (await kvGet("inbound_link_key")).trim() : ""
  // Botón "⟳ Actualizar" (Lalo 19-ago): también fuerza el ANÁLISIS de las
  // conversaciones nuevas antes de computar — espera acotada (12 s): lo normal
  // es un puñado de conversaciones por hora; si tarda más, el cron sigue solo
  // por detrás y la próxima carga ya lo trae.
  if (snapKey && fresh && FUNNEL_KEY) {
    try {
      await fetch(`${new URL(req.url).origin}/api/vic-funnel-cron?key=${encodeURIComponent(FUNNEL_KEY)}&limit=25`, {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      })
    } catch {
      /* timeout esperado con backlog grande: el análisis sigue corriendo solo */
    }
  }
  if (snapKey && !fresh) {
    try {
      const crudo = await kvGet(snapKey)
      const foto = crudo ? (JSON.parse(crudo) as { at?: string; html?: string }) : null
      const edadMs = foto ? Date.now() - Date.parse(String(foto.at || "")) : NaN
      if (foto?.html && Number.isFinite(edadMs) && edadMs < 2 * 3600e3) {
        const pFresh = new URLSearchParams()
        if (key) pFresh.set("key", key)
        if (vistaSnap) pFresh.set("vista", vistaSnap)
        pFresh.set("fresh", "1")
        const mins = Math.max(0, Math.round(edadMs / 60000))
        const banner = `<div style="position:sticky;top:0;z-index:60;background:#fff8e6;border-bottom:1px solid #f2e3b3;padding:6px 14px;font-size:13px;font-weight:600;color:#7a5b00">🕐 Datos de hace ${mins} min (foto horaria) · <a href="?${pFresh.toString()}" style="color:#00aff2">⟳ Actualizar dash</a></div>`
        let htmlFoto = foto.html
        // Anti-fuga: la foto nace de un render máquina (links con la llave);
        // a una sesión de navegador se le sirven links SIN llave.
        if (!key && FUNNEL_KEY) {
          htmlFoto = htmlFoto
            .split(`key=${FUNNEL_KEY}&`).join("")
            .split(`?key=${FUNNEL_KEY}`).join("?")
            .split(`&key=${FUNNEL_KEY}`).join("")
            .split(`value="${FUNNEL_KEY}"`).join('value=""')
        }
        return page(htmlFoto.replace(/<body([^>]*)>/, (_m, a: string) => `<body${a}>${banner}`))
      }
    } catch {
      /* foto ilegible → computar en vivo */
    }
  }

  const conv = (searchParams.get("conv") || "").replace(/[^a-fA-F0-9-]/g, "").trim()
  if (conv) return renderConversation(conv, key)
  const wsp = (searchParams.get("wsp") || "").replace(/\D/g, "").trim()
  if (wsp) return renderWspVendedor(wsp)
  // Editor conversacional de cotizaciones (pedido Lalo 06-ago): el vendedor
  // describe el cambio, Vicky Cotizaciones lo aplica con las tools reales y,
  // con el OK del vendedor, se la manda al cliente por WhatsApp. `cot` fija
  // QUÉ cotización del contacto se edita (búsqueda por número / multi-RUT).
  const coted = (searchParams.get("coted") || "").replace(/\D/g, "").trim()
  const cotSel = (searchParams.get("cot") || "").replace(/\D/g, "").trim()
  if (coted) return renderVickyCotizaciones(coted, key, cotSel)
  // Búsqueda por número de cotización (pedido Lalo 07-ago): COT### → editor.
  const buscarcot = (searchParams.get("buscarcot") || "").trim()
  if (buscarcot) {
    // TELÉFONO (Lalo 07-ago): 9+ dígitos → abrir por contacto (el editor
    // decide solo: formal si hay puntero, modo preform si solo hay chat).
    const soloDigitos = buscarcot.replace(/\D/g, "")
    if (soloDigitos.length >= 9 && !/cot/i.test(buscarcot)) {
      const fonoB = soloDigitos.length === 9 && soloDigitos.startsWith("9") ? `56${soloDigitos}` : soloDigitos
      return new Response(null, { status: 302, headers: { location: `?${new URLSearchParams({ key, coted: fonoB }).toString()}` } })
    }
    try {
      const hallada = await buscarCotizacionPorNumero(buscarcot)
      if (!hallada) {
        return paginaAviso(
          "Cotización no encontrada",
          `<p>No encontré ninguna cotización con el número <b>${esc(buscarcot)}</b> en Zoho. Revisa el número (ej: <code>COT400</code>) e inténtalo de nuevo.</p><p><a href="?key=${encodeURIComponent(key)}&vista=editor">← Volver al editor de cotizaciones</a></p>`,
        )
      }
      const p = new URLSearchParams({ key, coted: hallada.contact })
      if (hallada.conPuntero) p.set("cot", hallada.quoteId)
      return new Response(null, { status: 302, headers: { location: `?${p.toString()}` } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return paginaAviso("Error buscando la cotización", `<p>${esc(msg.slice(0, 200))}</p><p><a href="?key=${encodeURIComponent(key)}&vista=editor">← Volver al editor de cotizaciones</a></p>`, 500)
    }
  }
  // Pestaña "Editor de cotizaciones" (pedido Lalo 07-ago): buscador por número
  // + cotizaciones recientes. Rama temprana: no necesita el pipeline pesado.
  if (searchParams.get("vista") === "editor") return renderEditorCotizaciones(key)
  if (searchParams.get("vista") === "cotfunnel") return renderFunnelCotizaciones(key)
  if (searchParams.get("vista") === "tombolas") return renderAuditoriaTombolas(key, searchParams.get("solo") === "bordes")
  // Crear cotización (pedido Lalo 07-ago): primero se elige a qué oportunidad
  // de Zoho se asigna (lista de deals activos con búsqueda), y luego el chat
  // de creación emite la formal amarrada a ese deal.
  if (searchParams.get("cotnueva")) return renderSelectorDeal(key)
  const cotcrear = (searchParams.get("cotcrear") || "").replace(/\D/g, "").trim()
  // EL CHAT DE CREACIÓN QUEDÓ FUERA DEL FLUJO (Lalo 27-ago, "el chat para
  // cotizar nunca funcionó"): la puerta oficial es la CALCULADORA con el deal
  // anclado (selección de deal → emitir con aceptación online → PDF + link de
  // pago). Los links viejos a cotcrear llegan igual al destino correcto.
  // Para reabrir el chat sin deploy: env VICKY_CHAT_COTIZADOR=1.
  if (cotcrear && (process.env.VICKY_CHAT_COTIZADOR || "").trim() !== "1") {
    return Response.redirect(
      new URL(`/calculadora-comercial.html?deal=${encodeURIComponent(cotcrear)}&key=${encodeURIComponent(key)}`, req.url),
      302,
    )
  }
  if (cotcrear) return renderVickyCotizacionesCrear(cotcrear, key, searchParams.get("motor") === "ejecutivo")
  // Crear PROPUESTAS (pedido Lalo 07-ago): misma estructura que crear
  // cotizaciones — elegir la empresa (cartera del vendedor logueado) y
  // conversar con el agente; el guion de una reunión se pega o adjunta.
  if (searchParams.get("propnueva")) return renderSelectorPropuesta(key, quien)
  const propcrear = (searchParams.get("propcrear") || "").replace(/\D/g, "").trim()
  if (propcrear) return renderVickyPropuestasCrear(propcrear, key)
  const propVer = (searchParams.get("prop_ver") || "").replace(/\D/g, "").trim()
  if (propVer) {
    const p = await propuestaGuardada(propVer)
    if (!p) {
      return paginaAviso(
        "Propuesta no encontrada",
        `<p>Este deal aún no tiene propuesta generada.</p><p><a href="?key=${encodeURIComponent(key)}&propcrear=${encodeURIComponent(propVer)}">➕ Crearla con Vicky Propuestas</a></p>`,
      )
    }
    return page(renderPropuestaHtml(p))
  }

  let rows: Row[]
  let origen: {
    toque0: Set<string>
    sinContactar: number
    asignadosTotal: number
    convertidos: Set<string>
    respondio: Set<string>
  } = {
    toque0: new Set(),
    sinContactar: 0,
    asignadosTotal: 0,
    convertidos: new Set(),
    respondio: new Set(),
  }
  let cierre: {
    total: number
    aceptadas: number
    autonomas: number
    asistidas: number
    sinClasificar: number
    aceptadasList: RawAceptada[]
    todasList: RawAceptada[]
    quotesList: RawAceptada[]
  } | null = null
  let ventasHtml = ""
  // Filtro por PAÍS = canal/línea de Vicky (pedido Lalo 20-jul; PE y MX
  // sumados el 04-ago): cl (default), co, pe o mx. El país de una conversación
  // viene de vic_v3_conversations.country (la línea por la que entró), con
  // respaldo por prefijo telefónico; sus cotizaciones se asocian por
  // formal_quote_id.
  const paisRaw = (searchParams.get("pais") || "cl").toLowerCase()
  const pais: Pais = (paisRaw in PAISES ? paisRaw : "cl") as Pais
  const rango = parseRango(searchParams)
  // Filtros globales de ESTADO y PROPIETARIO (pedido Lalo 03-ago): aplican a
  // TODAS las secciones. El estado/propietario de cada contacto sale de la
  // escalera del listado comercial (universo: últimos 30 días).
  // Multi-selección (pedido Lalo 06-ago): ?estado= y ?prop= pueden repetirse.
  const estadoF = searchParams.getAll("estado").map((s) => s.trim()).filter((s) => ESTADOS_LISTADO.includes(s))
  const propF = searchParams.getAll("prop").map((s) => s.trim()).filter(Boolean)
  // Identidad: un vendedor queda FORZADO a su propia cartera (el select de
  // Propietario ni se muestra); Administrador y acceso máquina ven todo.
  const esAdmin = !quien || quien === "Administrador"
  if (!esAdmin) {
    propF.length = 0
    propF.push(quien)
  }
  // Vista: "gestion" (default, la cola de trabajo), "analisis" (KPIs, Sankey
  // y el resto del embudo) o "inbound" (embudo por cohorte diaria de llegadas
  // inbound, pedido Rodrigo 13-ago) — pestañas arriba a la derecha.
  const vistaParam = searchParams.get("vista")
  // 📋 CARTERA (Lalo 21-ago): página autocontenida — por estado, global, con
  // responsable y próximo paso. Se sirve antes del pipeline pesado del dash.
  if (vistaParam === "cartera") {
    try {
      const qsVolver = (() => { const p = new URLSearchParams({ key, pais }); return p.toString() })()
      const htmlCartera = await renderCartera(quien || "", qsVolver)
      return new Response(htmlCartera, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    } catch (e) {
      console.warn("[vic-funnel] cartera falló:", e instanceof Error ? e.message : e)
      return new Response("La cartera no se pudo calcular — recarga en un momento.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  }
  // 🤝 TRASPASOS (Lalo 02-sep): herramienta de la líder comercial — por
  // ejecutivo, qué le traspasó Vicky y qué sigue sin contactar. Autocontenida
  // y con filtro de fechas propio, igual que la Cartera.
  if (vistaParam === "traspasos") {
    try {
      const qsVolver = (() => { const p = new URLSearchParams({ key, pais }); return p.toString() })()
      const htmlTr = await renderTraspasos(quien || "", qsVolver, searchParams, esAdmin)
      return new Response(htmlTr, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    } catch (e) {
      console.warn("[vic-funnel] traspasos falló:", e instanceof Error ? e.message : e)
      return new Response("El panel de traspasos no se pudo calcular — recarga en un momento.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  }
  // 📅 CIERRE DIARIO (Lalo 02-sep): la foto del día anterior — lo que vendió,
  // lo que no y por qué, las fallas técnicas. Lee la foto guardada, no
  // recalcula: es la misma que sale por correo a las 07:30.
  if (vistaParam === "cierre") {
    try {
      const qsVolver = (() => { const p = new URLSearchParams({ key, pais }); return p.toString() })()
      const htmlC = await renderCierre(qsVolver, searchParams)
      return new Response(htmlC, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    } catch (e) {
      console.warn("[vic-funnel] cierre falló:", e instanceof Error ? e.message : e)
      return new Response("El cierre diario no se pudo mostrar — recarga en un momento.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  }
  // 🪞 ESPEJOS (Lalo 27-ago): monitoreo de sesiones de WhatsApp espejo del
  // equipo comercial — solo ADMINISTRADOR (los links QR que expone permiten
  // vincular la sesión de cualquiera; cada vendedor recibe SU link, no la
  // página completa).
  if (vistaParam === "espejos") {
    try {
      const qsVolver = (() => { const p = new URLSearchParams({ key, pais }); return p.toString() })()
      // Un VENDEDOR logueado ve SOLO su propio espejo (estado + su QR);
      // Administrador y acceso máquina ven el monitoreo completo.
      const htmlEsp = await renderEspejos(qsVolver, esAdmin ? undefined : quien)
      return new Response(htmlEsp, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    } catch (e) {
      console.warn("[vic-funnel] espejos falló:", e instanceof Error ? e.message : e)
      return new Response("El monitoreo de espejos no se pudo calcular — recarga en un momento.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  }
  // 📣 CAMPAÑAS (Lalo 27-ago): panel autocontenido para el equipo —
  // resultados con la cascada de toques + candidatos a la próxima ola
  // (actualizable, filtrable por ejecutivo). Mismo patrón que la Cartera.
  if (vistaParam === "campanas") {
    try {
      const qsVolver = (() => { const p = new URLSearchParams({ key, pais }); return p.toString() })()
      const htmlCamp = await renderPanelCampanas(quien || "", qsVolver, searchParams.get("recalcular") === "1")
      return new Response(htmlCamp, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    } catch (e) {
      console.warn("[vic-funnel] panel campañas falló:", e instanceof Error ? e.message : e)
      return new Response("El panel de campañas no se pudo calcular — recarga en un momento.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  }
  const vista: "gestion" | "analisis" | "inbound" =
    vistaParam === "analisis" ? "analisis" : vistaParam === "inbound" ? "inbound" : "gestion"
  // Filtro de ORIGEN de la cola (Lalo 07-ago): "vicky" (default — lo que está
  // pasando AHORA por WhatsApp) · "zoho" (cartera clásica del equipo) · "todo".
  const origenParam = (searchParams.get("origen") || "").trim()
  const origenF: "vicky" | "zoho" | "todo" = origenParam === "zoho" || origenParam === "todo" ? origenParam : "vicky"
  // Drill-down de un KPI: ?lista=<bucket> abre el detalle de esas conversaciones.
  const listaParam = (searchParams.get("lista") || "").trim()
  // Query string con los filtros vigentes (para los links de los KPIs y el
  // "volver" del detalle, que deben conservar país/fechas/estado/propietario).
  const filtrosQS = (): URLSearchParams => {
    const p = new URLSearchParams({ key, pais })
    if (rango?.desdeStr) p.set("desde", rango.desdeStr)
    if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
    for (const e of estadoF) p.append("estado", e)
    for (const pr of propF) p.append("prop", pr)
    if (origenF !== "vicky") p.set("origen", origenF)
    if (vista !== "gestion") p.set("vista", vista)
    return p
  }
  const hrefLista = (bucket: string) => {
    const p = filtrosQS()
    p.set("lista", bucket)
    return `?${p.toString()}`
  }
  let propietariosAll: string[] = []
  // conversación → fecha del último mensaje (columna "Último contacto" del
  // detalle de KPIs).
  let ultimoMsgPorConv = new Map<string, string>()
  // Conversación más reciente por contacto (todas las conversaciones, no solo
  // el listado comercial vivo): habilita el link "chat Vicky" en los detalles
  // de cotizaciones aunque la conversación ya haya salido del listado.
  let convIdPorContacto = new Map<string, string>()
  // Escalera del listado comercial: también enriquece el detalle de KPIs
  // (empresa, estado, ejecutivo a cargo, accionable).
  let filasListado: FilaListado[] = []
  // Cola de gestión (vista principal) y sus insumos.
  let colaHtml = ""
  let evolucionHtml = ""
  // Dashboard inbound diario (vista=inbound) y el mapa de preforms que
  // necesita (se llena en el bloque del listado comercial).
  let inboundHtml = ""
  let preformAtMap = new Map<string, string>()
  let ejecutivosHtml = ""
  let empresasHtml = ""
  let wspVendedorSet = new Set<string>()
  // Cotización formal vigente por contacto: link para verla y quote_id para
  // editarla con Vicky Cotizaciones (pedido Lalo 06-ago).
  let cotPorContacto = new Map<string, { quoteId: string; ver: string }>()
  let usuariosPorContacto = new Map<string, number>()
  let casosGestion: CasoGestion[] = []
  let nGestionadosCola = 0
  // Canal de llegada por contacto (Rodrigo 17-ago): fila en
  // vic_outbound_cadence = lead cargado (formulario). Se captura ANTES de que
  // los filtros globales intersecten `origen` (atributo por contacto, no KPI).
  let llegoPorFormulario = new Set<string>()
  let gestionados = new Map<string, string>()
  let montosPorContacto = new Map<string, { uf: number | null; clp: number | null }>()
  try {
    const paisesConv = await fetchPaisesConversaciones()
    const [allRows, hard, cierreZoho, origenData, fechasConv, convsListado] = await Promise.all([
      fetchAnalysis(),
      fetchHardSignals(),
      fetchCierreZoho(paisesConv.paisPorQuote, pais, rango),
      fetchOrigenFunnel(pais).catch(() => ({ toque0: new Set<string>(), sinContactar: 0, asignadosTotal: 0, convertidos: new Set<string>(), respondio: new Set<string>(), asignados: new Set<string>(), sinContactarTels: new Set<string>() })),
      // Las fechas de inicio solo hacen falta con el filtro activo.
      rango ? fetchFechasConversaciones() : Promise.resolve(new Map<string, string>()),
      fetchConvsListado().catch(() => [] as ConvListado[]),
    ])
    origen = origenData
    llegoPorFormulario = origenData.toque0
    // SOLO LO QUE VICKY INICIÓ (Lalo 14-ago): los ejecutivos emiten desde el
    // editor a clientes PROPIOS (20 de 29 el 13-ago) y esas cotizaciones
    // nacen igual con Created_By = Vicky, así que inflaban todo el dash —
    // KPIs, evolución, ventas y tasa de cierre. Criterio: la cotización
    // pertenece a Vicky si su contacto tuvo conversación con ella; el resto
    // es cartera del ejecutivo y no cuenta acá. Las cotizaciones SIN teléfono
    // (creadas a mano en el editor) tampoco son de Vicky.
    cierre = cierreZoho ? filtrarCierreAVicky(cierreZoho, convsListado) : cierreZoho
    ultimoMsgPorConv = new Map(
      convsListado.map((c) => [c.id, String(c.updated_at || c.last_user_at || c.started_at || "")]),
    )
    // Viene ordenado por started_at desc: la primera aparición es la
    // conversación más reciente del contacto.
    for (const c of convsListado) {
      const d = digits(c.contact)
      if (d && !convIdPorContacto.has(d)) convIdPorContacto.set(d, c.id)
    }
    // Listado comercial vivo (best-effort: si una pata falla, la sección se
    // arma con lo que haya; jamás bota la página). Se construye ANTES que el
    // resto porque su escalera de estados alimenta los filtros globales.
    try {
      const contactosConocidos = new Set(convsListado.map((c) => digits(c.contact)))
      const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      const [preformData, zohoListado, gestionadosKv, punteros, espejoTels, dealsEquipo] = await Promise.all([
        fetchPreformAts(convsListado),
        fetchZohoListado(
          contactosConocidos,
          (cierre?.todasList || []).map((q) => String(q["Deal_Asociado.id"] || "")).filter(Boolean),
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/vic_kv?key=like.gestion_%25&select=key,value&expires_at=gt.${new Date().toISOString()}&limit=1000`,
          { headers: hSb, cache: "no-store" },
        ).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<Array<{ key: string; value: string }>>,
        fetch(`${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?select=contact,total_uf,total_clp,quote_id,pdf_url,acceptance_url&order=updated_at.desc&limit=1000`, {
          headers: hSb,
          cache: "no-store",
        }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<Array<{ contact: string; total_uf: number | null; total_clp: number | null; quote_id: string | null; pdf_url: string | null; acceptance_url: string | null }>>,
        // Contactos con chat espejado del WhatsApp de algún vendedor (worker
        // wa-espejo) — habilita el link "wsp vendedor" y su último mensaje
        // cuenta como actividad del caso.
        // PAGINADO (bug 13-ago, caso Paola/G&A): PostgREST capa cada request en
        // 1000 filas y la versión anterior (limit=20000 SIN order) traía las
        // 1000 MÁS VIEJAS — la actividad reciente del vendedor no llegaba a la
        // columna. Ahora: orden desc + páginas de 1000 (ventana 35 días) y las
        // LLAMADAS aceptadas del espejo también cuentan como actividad.
        (async () => {
          const out: Array<{ telefono_chat: string; enviado_at: string }> = []
          const desde35 = new Date(Date.now() - 35 * 86400e3).toISOString()
          for (let off = 0; off < 8000; off += 1000) {
            const r = await fetch(
              `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?select=telefono_chat,enviado_at&telefono_chat=not.is.null&es_grupo=eq.false&enviado_at=gte.${desde35}&order=enviado_at.desc&limit=1000&offset=${off}`,
              { headers: hSb, cache: "no-store" },
            )
            const page = r.ok ? ((await r.json().catch(() => [])) as Array<{ telefono_chat: string; enviado_at: string }>) : []
            out.push(...page)
            if (page.length < 1000) break
          }
          const rl = await fetch(
            `${SUPABASE_URL}/rest/v1/vic_wa_espejo_llamadas?select=telefono,at&estado=eq.accept&at=gte.${desde35}&order=at.desc&limit=1000`,
            { headers: hSb, cache: "no-store" },
          )
          const llam = rl.ok ? ((await rl.json().catch(() => [])) as Array<{ telefono: string; at: string }>) : []
          out.push(...llam.map((x) => ({ telefono_chat: x.telefono, enviado_at: x.at })))
          return out
        })().catch(() => [] as Array<{ telefono_chat: string; enviado_at: string }>),
        // Cartera completa del equipo (pedido Lalo 07-ago): todos los deals
        // activos de Zoho, hayan pasado o no por Vicky.
        fetchDealsEquipo().catch(() => [] as DealEquipo[]),
      ])
      const preformAt = preformData.at
      preformAtMap = preformAt
      wspVendedorSet = new Set(espejoTels.map((x) => digits(String(x.telefono_chat || ""))).filter(Boolean))
      const wspUltimoAt = new Map<string, string>()
      for (const x of espejoTels) {
        const t = digits(String(x.telefono_chat || ""))
        if (!t || !x.enviado_at) continue
        const prev = wspUltimoAt.get(t)
        if (!prev || Date.parse(String(x.enviado_at)) > Date.parse(prev)) wspUltimoAt.set(t, String(x.enviado_at))
      }
      // Dotación por contacto: parseo del preform como base; el subform de la
      // cotización (fees) la pisa después porque es la fuente autoritativa.
      usuariosPorContacto = new Map<string, number>(preformData.usuarios)
      gestionados = new Map(gestionadosKv.map((g) => [String(g.key).replace(/^gestion_/, ""), String(g.value || "")]))
      for (const p of punteros) {
        const d = digits(p.contact)
        if (d && !montosPorContacto.has(d)) montosPorContacto.set(d, { uf: p.total_uf, clp: p.total_clp })
        // Primer puntero por contacto = el más reciente (vienen ordenados).
        if (d && p.quote_id && !cotPorContacto.has(d)) {
          cotPorContacto.set(d, { quoteId: String(p.quote_id), ver: String(p.pdf_url || p.acceptance_url || "") })
        }
      }
      // Monto/mes = fee RECURRENTE (pedido Lalo 04-ago): cuando el subform de
      // la cotización está disponible, pisa el total del puntero (que mezcla
      // el fee con compra/envío/instalación del reloj).
      try {
        const fees = await fetchFeesMensuales(
          punteros
            .filter((p) => p.quote_id)
            .map((p) => ({ contact: digits(p.contact), quoteId: String(p.quote_id) })),
        )
        for (const [c, fee] of fees) {
          montosPorContacto.set(c, fee)
          if (fee.usuarios) usuariosPorContacto.set(c, fee.usuarios)
        }
      } catch (e) {
        console.warn("[vic-funnel] fees mensuales fallaron:", e instanceof Error ? e.message : e)
      }
      filasListado = construirListadoComercial({
        quotes: cierre?.todasList || [],
        leads: zohoListado.leads,
        dealsPorId: zohoListado.dealsPorId,
        convs: convsListado,
        preformAt,
        analysisRows: allRows,
        pais,
        dealsEquipo,
      })
      // El WhatsApp del vendedor también es actividad (pedido Lalo 06-ago):
      // el último mensaje espejado con el cliente actualiza el último
      // contacto — y con él la urgencia y el filtro Desde–Hasta.
      for (const f of filasListado) {
        const at = wspUltimoAt.get(digits(f.contacto))
        if (at) f.ultimoContactoIso = maxIso(f.ultimoContactoIso, at)
      }
      // Dotación declarada en el deal (N_Empleados_que_marcan) rellena los
      // huecos de la dotación cotizada — da rango también a los tratos del
      // pipeline que no pasaron por Vicky (columna Usuarios, Rodrigo 12-ago).
      for (const dl of dealsEquipo) {
        let telDl = digits(String(dl["Contact_Name.Mobile"] || dl["Contact_Name.Phone"] || ""))
        if (telDl.length === 9 && telDl.startsWith("9")) telDl = `56${telDl}`
        const n = Number(dl.N_Empleados_que_marcan) || 0
        if (telDl && n > 0 && !usuariosPorContacto.has(telDl)) usuariosPorContacto.set(telDl, n)
      }
      // …y el LEAD también (caso Instituto Nacional de Normalización 19-ago:
      // la derivación guardó 80 trabajadores en el lead, pero sin deal ni
      // cotización la columna quedaba s/d y el >20 no salía a «derivadas»).
      for (const l of zohoListado.leads) {
        let telLd = digits(String(l.Phone || ""))
        if (telLd.length === 9 && telLd.startsWith("9")) telLd = `56${telLd}`
        const n = Number(l.N_Empleados_que_marcan) || 0
        if (telLd && n > 0 && !usuariosPorContacto.has(telLd)) usuariosPorContacto.set(telLd, n)
      }
      evolucionHtml = renderEvolucionDiaria({
        convs: convsListado,
        analysisRows: allRows,
        preformAt,
        quotes: cierre?.todasList || [],
        pais,
        rango,
        key,
      })
      // Panel por ejecutivo: fee recurrente POR COTIZACIÓN pagada (la caché
      // fee_mes_v1_<id> se indexa pasando el id como "contact").
      try {
        const pagadas = (cierre?.todasList || []).filter((q) => q.id && esPagada(q))
        const feesPorQuote = await fetchFeesMensuales(pagadas.map((q) => ({ contact: String(q.id), quoteId: String(q.id) })))
        const qsPanel = (() => {
          const p = new URLSearchParams({ key, pais })
          if (rango?.desdeStr) p.set("desde", rango.desdeStr)
          if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
          for (const e of estadoF) p.append("estado", e)
          for (const pr of propF) p.append("prop", pr)
          return p.toString()
        })()
        ejecutivosHtml = renderTrabajoEjecutivos({
          filas: filasListado,
          quotes: cierre?.todasList || [],
          feesPorQuote,
          usuarios: usuariosPorContacto,
          rango,
          pais,
          qsPanel,
        })
        empresasHtml = renderEmpresasPeriodo({ filas: filasListado, usuarios: usuariosPorContacto, rango, qsPanel })
      } catch (e) {
        console.warn("[vic-funnel] panel ejecutivos falló:", e instanceof Error ? e.message : e)
      }
    } catch (e) {
      console.warn("[vic-funnel] listado comercial falló:", e instanceof Error ? e.message : e)
    }
    // Detalle de una celda del panel por ejecutivo (?ejdet=<dim>&ejec=<nombre>).
    const ejdet = (searchParams.get("ejdet") || "").trim()
    if (ejdet) {
      const ejecQ = (searchParams.get("ejec") || "").trim()
      const enPeriodoEj = (iso: string) => (rango ? enRango(iso, rango) : Date.parse(iso) >= Date.now() - 30 * 864e5)
      const nombreDe = (p: string) => (p && p !== "—" ? p : "(sin ejecutivo)")
      let sub = filasListado.filter((f) => !/perdido/i.test(f.estadoZoho))
      if (ejecQ && ejecQ !== "TOTAL") sub = sub.filter((f) => nombreDe(f.propietario) === ejecQ)
      let dimTxt = "oportunidades vivas"
      if (ejdet === "asignadas") {
        sub = sub.filter((f) => f.primerContactoIso && enPeriodoEj(f.primerContactoIso))
        dimTxt = "asignadas en el período"
      } else if (ejdet.startsWith("seg:")) {
        const s = ejdet.slice(4)
        sub = sub.filter((f) => segmentoDotacion(usuariosPorContacto.get(digits(f.contacto))) === s)
        dimTxt = s === "s/d" ? "empresas sin dato de tamaño" : `empresas de ${s} personas`
      } else if (ejdet.startsWith("etapa:")) {
        const e = ejdet.slice(6)
        sub = sub.filter((f) => f.estado === e)
        dimTxt = `en etapa "${e}"`
      } else if (ejdet === "s2") {
        sub = sub.filter((f) => horasDesdeFila(f) > 2)
        dimTxt = "sin contacto hace más de 2 horas"
      } else if (ejdet === "s5") {
        sub = sub.filter((f) => horasDesdeFila(f) > 5)
        dimTxt = "sin contacto hace más de 5 horas"
      } else if (ejdet === "s24") {
        sub = sub.filter((f) => horasDesdeFila(f) > 24)
        dimTxt = "sin contacto hace más de 1 día"
      } else if (ejdet === "s2d") {
        sub = sub.filter((f) => diasHabilesDesdeFila(f) >= 2)
        dimTxt = "sin contacto hace 2 o más días hábiles"
      }
      const volver = (() => {
        const p = new URLSearchParams({ key, pais, vista: "analisis" })
        if (rango?.desdeStr) p.set("desde", rango.desdeStr)
        if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
        for (const e of estadoF) p.append("estado", e)
        for (const pr of propF) p.append("prop", pr)
        return `?${p.toString()}`
      })()
      return renderDetalleEjecutivo({
        filas: sub,
        titulo: `${ejecQ && ejecQ !== "TOTAL" ? ejecQ : "Todos los ejecutivos"} — ${dimTxt}`,
        key,
        volverQS: volver,
        montos: montosPorContacto,
        usuarios: usuariosPorContacto,
        wspSet: wspVendedorSet,
        pais,
        formularioSet: llegoPorFormulario,
      })
    }
    // Detalle de una celda de "Empresas ingresadas en el período"
    // (?empdet=1&empEtapa=<etapa>&empTramo=<tramo>): mismo universo que la
    // tabla (primer contacto en el período, sin excluir perdidos).
    if ((searchParams.get("empdet") || "").trim()) {
      const etapaQ = (searchParams.get("empEtapa") || "").trim()
      const tramoQ = (searchParams.get("empTramo") || "").trim()
      const enPeriodoEmp = (iso: string) => (rango ? enRango(iso, rango) : Date.parse(iso) >= Date.now() - 30 * 864e5)
      let sub = filasListado.filter((f) => f.primerContactoIso && enPeriodoEmp(f.primerContactoIso))
      if (etapaQ) sub = sub.filter((f) => f.estado === etapaQ)
      if (tramoQ) sub = sub.filter((f) => segmentoDotacion(usuariosPorContacto.get(digits(f.contacto))) === tramoQ)
      const volver = (() => {
        const p = new URLSearchParams({ key, pais, vista: "analisis" })
        if (rango?.desdeStr) p.set("desde", rango.desdeStr)
        if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
        for (const e of estadoF) p.append("estado", e)
        for (const pr of propF) p.append("prop", pr)
        return `?${p.toString()}`
      })()
      const tramoTxt = tramoQ ? (tramoQ === "s/d" ? "sin dato de tamaño" : `${tramoQ} personas`) : ""
      const titulo = `Empresas ingresadas en el período — ${[etapaQ || "todas las etapas", tramoTxt].filter(Boolean).join(" · ")}`
      return renderDetalleEjecutivo({
        filas: sub,
        titulo,
        key,
        volverQS: volver,
        montos: montosPorContacto,
        usuarios: usuariosPorContacto,
        wspSet: wspVendedorSet,
        pais,
        formularioSet: llegoPorFormulario,
      })
    }
    // Dashboard INBOUND DIARIO (Rodrigo 13-ago): embudo por cohorte de llegada
    // + su drill-down (?inbdet=<día|TOTAL>&inbEtapa=<etapa>). Solo se computa
    // cuando la vista lo pide (trae un fetch propio: primera conversación por
    // contacto, paginado).
    const inbdet = (searchParams.get("inbdet") || "").trim()
    if (vista === "inbound" || inbdet) {
      try {
        const primeraVez = await fetchPrimeraConversacion()
        // 💰 PAGOS REALES del canal Vicky (registro venta_dash con pagoIso):
        // se leen ANTES del cómputo porque alimentan la columna Pagada de la
        // tabla (día del PAGO, inbound + outbound) además de la tarjeta de
        // caja. null = lectura fallida → la columna cae al día de aceptación
        // por cotización (solo inbound), como antes.
        let pagosVicky: Array<{ tel: string; t: number; monto: number; txt: string; qid: string }> | null = null
        try {
          const rv = await fetch(
            `${SUPABASE_URL}/rest/v1/vic_kv?select=key,value&key=like.venta_dash_v3_*&limit=3000`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
          )
          const filasKv = rv.ok ? ((await rv.json()) as Array<{ key: string; value: string }>) : []
          if (!rv.ok) throw new Error("kv ventas no disponible")
          const marcaEjec = new Set<string>()
          const telPorQuote = new Map<string, string>()
          // Estado VIGENTE en Zoho: el kv venta_dash arrastró históricamente
          // aceptadas sin pago (caso SYM 19-ago) — solo cuenta como pago lo
          // que HOY es pagada de verdad.
          const pagadasIds = new Set<string>()
          for (const q of cierre?.todasList || []) {
            const qid = String(q.id || "")
            const marca = String(q.Intervenci_n_Humana || "")
            const telQ2 = digits(String(q.Tel_fono_Contacto || ""))
            if (esPagada(q)) pagadasIds.add(qid)
            if (/intervenci/i.test(marca)) marcaEjec.add(qid)
            // Sin marca (histórico): misma regla del embudo — si la
            // conversación nació DESPUÉS de la emisión, la venta no es de
            // Vicky (caso MATER: solo le mandaron el comprobante).
            if (!/100%/.test(marca) && !/intervenci/i.test(marca)) {
              const pMs = Date.parse(primeraVez.get(telQ2) || "")
              const cMs = Date.parse(String(q.Created_Time || ""))
              if (Number.isFinite(cMs) && (!Number.isFinite(pMs) || pMs > cMs + 3600e3)) marcaEjec.add(qid)
            }
            telPorQuote.set(qid, telQ2)
          }
          const finCaja = rango && rango.hastaMs !== Number.MAX_SAFE_INTEGER ? rango.hastaMs : Date.now()
          const iniCaja = rango && rango.desdeMs > 0 ? rango.desdeMs : finCaja - 29 * 864e5
          pagosVicky = []
          for (const row of filasKv) {
            try {
              const v = JSON.parse(row.value) as { empresa?: string; numero?: string; pagoIso?: string; montoClp?: number }
              const qid = String(row.key).replace("venta_dash_v3_", "")
              if (!pagadasIds.has(qid)) continue // aceptada sin pago o fuera del universo
              if (marcaEjec.has(qid)) continue // canal ejecutivo (estampado o sin conversación previa)
              if (/geovictoria|prueba/i.test(String(v.empresa || ""))) continue
              // Fuera del universo del país (p. ej. la venta CO en COP que
              // inflaba la caja CL): si el listado no la conoce, no entra.
              const telQ = telPorQuote.get(qid)
              if (!telQ || paisDeTelefono(telQ) !== pais) continue
              const t = Date.parse(String(v.pagoIso || ""))
              if (!Number.isFinite(t) || t < iniCaja || t > finCaja) continue
              const m = Number(v.montoClp || 0) || 0
              pagosVicky.push({ tel: telQ, t, monto: m, txt: `${v.numero || qid} $${m.toLocaleString("es-CL")}`, qid })
            } catch {
              /* fila corrupta: se salta */
            }
          }
          // Los más RECIENTES primero (19-ago: el pago de ayer quedaba
          // escondido detrás de los 6 más antiguos y parecía no contado).
          pagosVicky.sort((a, b) => b.t - a.t)
        } catch {
          pagosVicky = null
        }
        // ENTRADAS con reactivación 7d (RPC): la definición de "entrante" del
        // panel Bolsa y Foto. Fallback: primera conversación (sin reactivadas).
        let entradas: Array<{ contact: string; at: string }> = []
        try {
          const desdeIso = new Date((rango && rango.desdeMs > 0 ? rango.desdeMs : Date.now() - 29 * 864e5) - 864e5).toISOString()
          const re = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vic_entradas_desde`, {
            method: "POST",
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ desde: desdeIso }),
            cache: "no-store",
          })
          if (re.ok) entradas = (await re.json()) as Array<{ contact: string; at: string }>
        } catch { /* cae al fallback */ }
        if (!entradas.length) entradas = [...primeraVez].map(([contact, at]) => ({ contact, at }))
        const cohortes = computarCohortesInbound({
          entradas,
          primeraVez,
          analysisRows: allRows,
          preformAt: preformAtMap,
          quotes: cierre?.todasList || [],
          toque0: origen.toque0,
          pais,
          rango,
          pagos: pagosVicky ? pagosVicky.map((p) => ({ tel: p.tel, t: p.t, qid: p.qid })) : null,
        })
        if (inbdet) {
          const etapaCruda = (searchParams.get("inbEtapa") || "entrantes").trim()
          // Alias de links viejos (llegaron/comercial/soporte/cobranza/derivada).
          const etapaQ = (ETAPA_ALIAS[etapaCruda] ||
            ((ETAPAS_INBOUND as readonly string[]).includes(etapaCruda) ? etapaCruda : "entrantes")) as EtapaInbound
          const porTelListado = new Map(filasListado.map((f) => [digits(f.contacto), f]))
          const sub: FilaListado[] = []
          const vistos = new Set<string>()
          // En el drill-down de ENTRANTES, la fila mínima muestra la
          // clasificación REAL del contacto si se conoce.
          const clasePorTel = new Map<string, string>()
          if (etapaQ === "entrantes") {
            for (const et of ["ce_sop", "ce_pos", "ce_cob", "ic", "nocal"] as EtapaInbound[]) {
              for (const tels of cohortes.porDia[et].values()) for (const t of tels) clasePorTel.set(t, ETIQUETA_ETAPA_INBOUND[et])
            }
          }
          const fuente: Array<[string, string]> = [...(cohortes.porDia[etapaQ] || new Map<string, Set<string>>())].flatMap(
            ([dia, tels]) => [...tels].map((tel) => [telDeElemento(tel), dia] as [string, string]),
          )
          for (const [tel, dia] of fuente) {
            if (inbdet !== "TOTAL" && dia !== inbdet) continue
            if (vistos.has(tel)) continue
            vistos.add(tel)
            const f = porTelListado.get(tel)
            if (f) {
              sub.push(f)
              continue
            }
            // Contacto fuera del listado comercial vivo (p. ej. conversación
            // antigua sin actividad reciente): fila mínima para no perderlo.
            sub.push({
              empresa: `+${tel}`,
              contacto: tel,
              estado: clasePorTel.get(tel) || ETIQUETA_ETAPA_INBOUND[etapaQ] || etapaQ,
              fechaIso: primeraVez.get(tel) || "",
              estadoZoho: "—",
              propietario: "—",
              primerContactoIso: primeraVez.get(tel) || "",
              convId: convIdPorContacto.get(tel) || "",
              accionable: "—",
              resumen: "",
              lastUserIso: "",
              updatedIso: "",
              ultimoContactoIso: primeraVez.get(tel) || "",
              zohoUrl: "",
            })
          }
          const titulo = `Inbound ${inbdet === "TOTAL" ? "del período" : `del ${inbdet}`} — ${
            etapaQ === "entrantes" ? "entrantes del día" : `${ETIQUETA_ETAPA_INBOUND[etapaQ] || etapaQ}`
          }`
          return renderDetalleEjecutivo({
            filas: sub,
            titulo,
            key,
            volverQS: `?${filtrosQS().toString()}`,
            montos: montosPorContacto,
            usuarios: usuariosPorContacto,
            wspSet: wspVendedorSet,
            pais,
            formularioSet: llegoPorFormulario,
          })
        }
        // 💰 CAJA DEL PERÍODO: misma lectura de pagos que la columna Pagada
        // (leída arriba, antes del cómputo) — tarjeta y tabla siempre calzan.
        const caja = pagosVicky
          ? {
              cantidad: pagosVicky.length,
              monto: pagosVicky.reduce((a, p) => a + p.monto, 0),
              detalle: pagosVicky.slice(0, 8).map((p) => p.txt).join(" · ") + (pagosVicky.length > 8 ? " · …" : ""),
            }
          : undefined
        // Viñetas + detalle EMBEBIDOS: nombres y ficha por teléfono desde el
        // listado comercial — el hover y el clic al detalle no tocan la red.
        const nombresPorTel = new Map<string, string>()
        const detallesPorTel = new Map<string, { e: string; est: string; ej: string; dot: string; ult: string; acc: string; conv: string; z: string }>()
        for (const f of filasListado) {
          const t = digits(f.contacto)
          if (!t || nombresPorTel.has(t)) continue
          nombresPorTel.set(t, f.empresa || `+${t}`)
          detallesPorTel.set(t, {
            e: f.empresa || `+${t}`,
            est: f.estado || "—",
            ej: f.propietario && f.propietario !== "—" ? f.propietario : "—",
            dot: usuariosPorContacto.has(t) ? String(usuariosPorContacto.get(t)) : "s/d",
            ult: f.ultimoContactoIso ? fmtSantiago(f.ultimoContactoIso) : "",
            acc: f.accionable && f.accionable !== "—" ? f.accionable : "",
            conv: f.convId || convIdPorContacto.get(t) || "",
            z: f.zohoUrl || "",
          })
        }
        // Transcripciones EMBEBIDAS (Lalo 19-ago, "ver la transcripción dentro
        // del pop-up"): últimos 30 mensajes (400 chars c/u) de cada contacto
        // del panel, en UNA consulta RPC — el pop-up las abre sin red.
        const transPorTel = new Map<string, Array<[string, string, string]>>()
        try {
          const telsPanel = new Set<string>()
          for (const et of Object.keys(cohortes.porDia) as EtapaInbound[]) {
            for (const tels of cohortes.porDia[et].values()) for (const t of tels) telsPanel.add(telDeElemento(t))
          }
          // LOTES de 25 tels (PostgREST corta cada respuesta en 1000 filas:
          // 30 msgs x 34 tels ya truncaba — bug cazado el 19-ago con
          // exactamente 1000 mensajes embebidos). 4 lotes en paralelo.
          const listaTels = [...telsPanel]
          const lotes: string[][] = []
          for (let i = 0; i < listaTels.length; i += 25) lotes.push(listaTels.slice(i, i + 25))
          for (let i = 0; i < lotes.length; i += 4) {
            await Promise.all(lotes.slice(i, i + 4).map(async (lote) => {
              const rt = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vic_transcripts_de`, {
                method: "POST",
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ tels: lote, nmax: 30 }),
                cache: "no-store",
              }).catch(() => null)
              if (!rt?.ok) return
              const filasT = (await rt.json().catch(() => [])) as Array<{ contact: string; role: string; at: string; content: string }>
              for (const f of filasT) {
                const t = digits(f.contact)
                const arr = transPorTel.get(t) || []
                arr.push([f.role === "user" ? "c" : "v", fmtSantiago(f.at), String(f.content || "")])
                transPorTel.set(t, arr)
              }
            }))
          }
        } catch { /* sin transcripciones: el pop-up muestra solo la ficha */ }
        // 🧲 Leads del formulario de landing (Lalo 21-ago): alimentan la
        // columna "Form Vicky" del Grupo Bolsa y la tabla detalle de abajo.
        const formLeads = inbdet ? [] : await fetchLeadsFormVicky().catch(() => [] as FilaFormVicky[])
        const formPorDia = new Map<string, Array<[string, string]>>()
        // Cruces del embudo web→chat (Lalo 21-ago "OK!"): cuántos del form
        // llegaron al chat, y qué entrantes vinieron del form (por teléfono).
        const formConvPorDia = new Map<string, number>()
        const formConvTels = new Set<string>()
        const formTels = new Set<string>()
        // Origen por contacto (Lalo 26-ago): quien llenó el form queda con la
        // LANDING de su lead; quien llegó por el botón directo cae a "Sitio
        // web" en el render. Un tel con varios fills conserva el primero.
        const origenPorTel = new Map<string, string>()
        // Campaña de marketing del lead (Campaign, ej "Chile-Search-Hardware")
        // para rotular las sub-filas por landing (Lalo 31-ago).
        const campanaPorTel = new Map<string, string>()
        for (const f of formLeads) {
          const ms = Date.parse(String(f.Created_Time || ""))
          if (!Number.isFinite(ms)) continue
          let telForm = digits(String(f.Phone || ""))
          if (/^(56|57|52|51)\1\d{8,12}$/.test(telForm)) telForm = telForm.slice(2)
          const telOk = /^(56|57|52|51)\d{8,12}$/.test(telForm)
          // El set de tels cubre TODO el form (aunque el fill quede fuera del
          // rango visible): un form de ayer con chat de hoy marca igual.
          if (telOk) formTels.add(telForm)
          if (telOk && !origenPorTel.has(telForm)) {
            const lp = String(f.Landing_Page || "").trim().replace(/^https?:\/\/[^/]+/i, "")
            // Categoría de la fuente (Lalo 31-ago, "agrupar pagado vs orgánico"):
            // DB_Source_2 solo trae "Paid Media" o nada (verificado en 91 leads
            // jul-ago), así que refuerza el PAGADO y Lead_Source clasifica el
            // resto: SEO/AI = orgánico, Direct = directo. Va DENTRO de la llave
            // de agrupación: una misma landing con tráfico pagado y orgánico se
            // parte en dos filas — separar eso es justo lo que se quiere medir.
            const db = String(f.DB_Source_2 || "").toLowerCase()
            const src = String(f.Lead_Source || "").toLowerCase()
            const cat = db.includes("paid") || /ads|adwords|paid|meta|facebook|instagram|linkedin/.test(src)
              ? "💰"
              : /seo|organic|org[áa]nico|blog|youtube/.test(src) || src === "ai"
                ? "🌱"
                : /direct/.test(src)
                  ? "🔗"
                  : "❔"
            origenPorTel.set(telForm, `🧲${cat} ${lp || "landing (sin página)"}`)
          }
          // "none"/"(none)" es el relleno de tráfico directo u orgánico en el
          // campo Campaign — no es una campaña, no se rotula.
          const campRaw = String(f.Campaign || "").trim()
          if (telOk && !campanaPorTel.has(telForm) && campRaw && !/^\(?none\)?$/i.test(campRaw)) {
            campanaPorTel.set(telForm, campRaw)
          }
          if (rango && (ms < rango.desdeMs || ms >= rango.hastaMs)) continue
          // Mismo día-Santiago del resto de la tabla (YYYY-MM-DD).
          const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
          const etiqueta = `${f.First_Name || ""} ${f.Last_Name || ""}`.trim() || f.Company || f.Email || "(sin nombre)"
          const arr = formPorDia.get(dia) || []
          arr.push([etiqueta, telOk ? telForm : ""])
          formPorDia.set(dia, arr)
          if (telOk && primeraVez.has(telForm)) {
            formConvPorDia.set(dia, (formConvPorDia.get(dia) || 0) + 1)
            formConvTels.add(telForm)
          }
        }
        // 📋 FORMULARIO WEB · TRAMO VICKY (Lalo 31-ago; redefinida la misma
        // tarde, dos veces): el número grande es TODO lo que le tocó a Vicky
        // (marcas `outb_asignado_`, foto inmutable al asignarse) y el
        // paréntesis desglosa en qué terminó cada lead: ✓ contactado (le
        // salió el toque — fila real en vic_outbound_cadence), ↪ entregado a
        // una SDR sin lograr contacto (marca `outb_regalado_`, con el nombre
        // de quién lo recibió para el detalle al pasar el mouse), ⏳ todavía
        // en reintentos. Días previos a las marcas: respaldo histórico de la
        // cadencia, donde asignado = contactado.
        const outbPorDia = new Map<string, Array<[string, string]>>()
        const outbTocPorDia = new Map<string, number>()
        const outbRegPorDia = new Map<string, number>()
        const outbTels = new Set<string>()
        try {
          const hOut = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          const diaDeMs = (ms: number) =>
            new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
          const [rAsig, rReg, rOut] = await Promise.all([
            fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.outb_asignado_*&select=key,value&limit=4000`, { headers: hOut, cache: "no-store" }),
            fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.outb_regalado_*&select=key,value&limit=4000`, { headers: hOut, cache: "no-store" }),
            fetch(`${SUPABASE_URL}/rest/v1/vic_outbound_cadence?select=contact,started_at,nombre,empresa&order=started_at.desc&limit=4000`, { headers: hOut, cache: "no-store" }),
          ])
          const parsea = (v: string) => { try { return JSON.parse(v) as { at?: string; contact?: string; nombre?: string; empresa?: string; motivo?: string; a?: string } } catch { return {} } }
          const leadDeKey = (k: string) => k.replace(/^outb_(asignado|regalado)_/, "")
          const regalos = new Map<string, { motivo: string; a: string }>()
          for (const fila of rReg.ok ? ((await rReg.json().catch(() => [])) as Array<{ key: string; value: string }>) : []) {
            const d = parsea(fila.value)
            regalos.set(leadDeKey(fila.key), { motivo: String(d.motivo || ""), a: String(d.a || "") })
          }
          const cadencia = rOut.ok
            ? (((await rOut.json().catch(() => [])) as Array<{ contact?: string; started_at?: string; nombre?: string; empresa?: string }>) || [])
            : []
          const telsTocados = new Set(cadencia.map((f) => digits(String(f.contact || ""))))
          const vistos = new Set<string>()
          for (const fila of rAsig.ok ? ((await rAsig.json().catch(() => [])) as Array<{ key: string; value: string }>) : []) {
            const d = parsea(fila.value)
            const tel = digits(String(d.contact || ""))
            const ms = Date.parse(String(d.at || ""))
            if (!tel || !Number.isFinite(ms) || paisDeTelefono(tel) !== pais || isTestContact(tel, metricsContactSet())) continue
            outbTels.add(tel)
            vistos.add(tel)
            if (rango && (ms < rango.desdeMs || ms >= rango.hastaMs)) continue
            const dia = diaDeMs(ms)
            const regalo = regalos.get(leadDeKey(fila.key))
            const base = String(d.empresa || d.nombre || "").trim() || tel
            let etiqueta = `💬 ${base}`
            if (regalo) {
              const sdr = (regalo.a || "").split("@")[0] || "SDR"
              etiqueta = `↪ ${base} → ${sdr}`
              outbRegPorDia.set(dia, (outbRegPorDia.get(dia) || 0) + 1)
            } else if (telsTocados.has(tel)) {
              outbTocPorDia.set(dia, (outbTocPorDia.get(dia) || 0) + 1)
            } else {
              etiqueta = `⏳ ${base}`
            }
            const arr = outbPorDia.get(dia) || []
            arr.push([etiqueta, tel])
            outbPorDia.set(dia, arr)
          }
          // Respaldo histórico: toques previos a la foto (sin marca kv).
          for (const f of cadencia) {
            const tel = digits(String(f.contact || ""))
            const ms = Date.parse(String(f.started_at || ""))
            if (!tel || !Number.isFinite(ms)) continue
            if (vistos.has(tel)) continue
            if (paisDeTelefono(tel) !== pais) continue
            if (isTestContact(tel, metricsContactSet())) continue
            outbTels.add(tel)
            if (rango && (ms < rango.desdeMs || ms >= rango.hastaMs)) continue
            const dia = diaDeMs(ms)
            const arr = outbPorDia.get(dia) || []
            arr.push([`💬 ${String(f.empresa || f.nombre || "").trim() || tel}`, tel])
            outbPorDia.set(dia, arr)
            outbTocPorDia.set(dia, (outbTocPorDia.get(dia) || 0) + 1)
          }
        } catch { /* sin outbound, la columna queda en 0 */ }
        // 📣 CAMPAÑAS COMO ORIGEN (Lalo 27-ago): un entrante que recibió un
        // toque de campaña (WhatsApp/correo/Dapta) en los últimos 14 días es
        // una REACTIVACIÓN de campaña, no "botón directo" — sin esta fila las
        // respuestas de la campaña ensuciaban la lectura del inbound orgánico.
        // El form (🧲) gana: quien llenó el miniform conserva su landing.
        try {
          const hCamp = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          const desdeCamp = new Date(Date.now() - 14 * 86_400_000).toISOString()
          const rCamp = await fetch(
            `${SUPABASE_URL}/rest/v1/vic_campanas?select=contact,evento&evento=in.(enviado,enviado_correo,enviado_dapta)&at=gte.${encodeURIComponent(desdeCamp)}&limit=8000`,
            { headers: hCamp, cache: "no-store" },
          )
          if (rCamp.ok) {
            const evsCamp = ((await rCamp.json().catch(() => [])) as Array<{ contact: string }>) || []
            for (const e of evsCamp) {
              const telCamp = String(e.contact || "").replace(/\D/g, "")
              if (telCamp && !origenPorTel.has(telCamp)) origenPorTel.set(telCamp, "📣 Campaña (reactivación)")
            }
          }
        } catch { /* sin campañas, la clasificación queda como estaba */ }
        // Empresa por cotización para las viñetas del Grupo Foto (elementos
        // tel~quoteId): así el mismo fono con dos cotizaciones nombra ambas.
        // Viñeta = razón social DE LA COTIZACIÓN + número (Lalo 08-sep, caso
        // Lorena: dos empresas con la misma cuenta salían como dos RUT
        // iguales; el nombre de la cuenta ya no manda).
        const nombresQuote = new Map<string, string>()
        for (const q of cierre?.todasList || []) {
          const qid = String(q.id || "")
          const deNombre = String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim()
          const emp = deNombre || String(q["Cuenta_Asociada.Account_Name"] || "").trim()
          const num = String(q.Numero_Cotizacion || "").trim()
          if (qid && (emp || num)) nombresQuote.set(qid, [emp, num].filter(Boolean).join(" · "))
        }
        inboundHtml = renderInboundDiario(cohortes, { rango, qs: filtrosQS().toString(), caja, nombres: nombresPorTel, nombresQuote, detalles: detallesPorTel, trans: transPorTel, formVicky: inbdet ? undefined : formPorDia, formConv: inbdet ? undefined : formConvPorDia, formConvTels: inbdet ? undefined : formConvTels, formTels: inbdet ? undefined : formTels, origenes: inbdet ? undefined : origenPorTel, campanas: inbdet ? undefined : campanaPorTel, outbound: inbdet ? undefined : outbPorDia, outboundToc: inbdet ? undefined : outbTocPorDia, outboundReg: inbdet ? undefined : outbRegPorDia, outboundTels: inbdet ? undefined : outbTels })
        // Tabla detalle del form — solo en la vista completa, no en los
        // drill-downs (inbdet).
        if (!inbdet) inboundHtml += await renderFormLanding(primeraVez, formLeads)
        if (!inbdet) inboundHtml += await renderCampanas()
      } catch (e) {
        console.warn("[vic-funnel] inbound diario falló:", e instanceof Error ? e.message : e)
        inboundHtml = `<div class="card"><h2>📥 Oportunidades inbound por día</h2><p class="sub">No se pudo calcular en este momento — recarga la página.</p></div>`
      }
    }
    propietariosAll = [...new Set(filasListado.map((f) => f.propietario).filter((p) => p && p !== "—"))].sort()
    // Cache para el login ("¿Quién eres?"): mejor esfuerzo, se refresca en
    // cada render con la cartera completa.
    if (propietariosAll.length) {
      void kvSet("dash_propietarios", JSON.stringify(propietariosAll), new Date(Date.now() + 7 * 24 * 3600e3).toISOString())
    }
    // Contactos que pasan el filtro Estado/Propietario (null = sin filtro).
    const coincide = (f: FilaListado) =>
      (!estadoF.length || estadoF.includes(f.estado)) &&
      (!propF.length || propF.includes(f.propietario) || (f.propietarios || []).some((p) => propF.includes(p)))
    const permitidos: Set<string> | null =
      estadoF.length || propF.length
        ? new Set(filasListado.filter(coincide).map((f) => digits(f.contacto)).filter(Boolean))
        : null
    // Filtro Desde–Hasta sobre el listado (pedido Lalo 04-ago): con rango
    // activo se muestran solo los casos con ACTIVIDAD en el período — inicio
    // de conversación, última respuesta del cliente, último mensaje, el
    // evento que definió su estado actual o la última actividad en Zoho
    // (06-ago: una ASIGNACIÓN de trato también es actividad — sin esto, el
    // caso recién asignado a un ejecutivo no aparecía al filtrar por hoy).
    const tuvoActividad = (f: FilaListado) =>
      !rango ||
      [f.primerContactoIso, f.fechaIso, f.lastUserIso, f.updatedIso, f.ultimoContactoIso].some((iso) => iso && enRango(iso, rango))
    // (04-ago: el "Listado comercial vivo" salió de la página — la cola de
    // gestión lo reemplazó con la misma data; renderListadoComercial queda
    // disponible por si se quiere reponer.)
    const filasVisibles = filasListado.filter(
      (f) => coincide(f) && tuvoActividad(f) && (origenF === "todo" || (f.origen || "vicky") === origenF),
    )
    const cola = construirCasosGestion({ filas: filasVisibles, gestionados, montos: montosPorContacto, pais, cots: cotPorContacto, usuarios: usuariosPorContacto, formularioSet: llegoPorFormulario })
    casosGestion = cola.casos
    nGestionadosCola = cola.nGestionados
    const qsDescarga = (() => {
      const p = new URLSearchParams({ key, pais })
      if (rango?.desdeStr) p.set("desde", rango.desdeStr)
      if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
      for (const e of estadoF) p.append("estado", e)
      for (const pr of propF) p.append("prop", pr)
      if (origenF !== "vicky") p.set("origen", origenF)
      return p.toString()
    })()
    // Marcas "ya lo contacté" vigentes: el botón nace en su estado real y
    // permite DESHACER (Lalo 10-ago).
    const atendidosSet = new Set<string>()
    try {
      const claves = casosGestion.slice(0, 300).map((c) => `"atencion_manual_${c.contacto}"`).join(",")
      if (claves) {
        const rows = (await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${claves})&select=key&limit=300`, {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          cache: "no-store",
        }).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ key: string }>
        for (const r of rows) atendidosSet.add(String(r.key).replace("atencion_manual_", ""))
      }
    } catch { /* best-effort: sin marcas el botón sale en su estado por defecto */ }
    colaHtml = renderColaGestion(casosGestion, nGestionadosCola, key, qsDescarga, wspVendedorSet, esAdmin ? "" : quien, atendidosSet)
    // El filtro global re-corta el cierre de Zoho (por teléfono de la
    // cotización) y el funnel por origen (por teléfono del lead/toque).
    if (permitidos && cierre) {
      const enP = (q: RawAceptada) => {
        const t = digits(String(q.Tel_fono_Contacto || ""))
        return Boolean(t) && permitidos.has(t)
      }
      const aceptadasList = cierre.aceptadasList.filter(enP)
      const marca = (q: { Intervenci_n_Humana?: string | null }) => String(q.Intervenci_n_Humana || "").toLowerCase()
      const autonomas = aceptadasList.filter((q) => marca(q).includes("100%")).length
      const asistidas = aceptadasList.filter((q) => marca(q).includes("intervenci")).length
      cierre = {
        total: cierre.quotesList.filter(enP).length,
        aceptadas: aceptadasList.length,
        autonomas,
        asistidas,
        sinClasificar: aceptadasList.length - autonomas - asistidas,
        aceptadasList,
        todasList: cierre.todasList.filter(enP),
        quotesList: cierre.quotesList.filter(enP),
      }
    }
    if (permitidos) {
      const inter = (s: Set<string>) => new Set([...s].filter((x) => permitidos.has(x)))
      const asignadosF = inter(origenData.asignados)
      origen = {
        toque0: inter(origenData.toque0),
        convertidos: inter(origenData.convertidos),
        respondio: inter(origenData.respondio),
        asignadosTotal: asignadosF.size,
        sinContactar: inter(origenData.sinContactarTels).size,
      }
    }
    if (cierre?.aceptadasList?.length) {
      const telPorNumero = new Map<string, string>()
      for (const q of cierre.aceptadasList) {
        const num = String(q.Numero_Cotizacion || "")
        const t = digits(String(q.Tel_fono_Contacto || ""))
        if (num && t) telPorNumero.set(num, t)
      }
      // SOLO pagadas de verdad (caso SYM 19-ago: aceptó online y nunca pagó
      // — la aceptación NO es venta ni entra al registro venta_dash).
      ventasHtml = renderVentasCerradas(
        await construirVentasCerradas(cierre.aceptadasList.filter((q) => esPagada(q))),
        key,
        llegoPorFormulario,
        telPorNumero,
      )
    }
    rows = allRows.filter((r) => {
      if (isTestContact(r.contact)) return false
      // Cada línea de Vicky (CL/CO/PE/MX) muestra SOLO sus conversaciones.
      const d = digits(r.contact)
      const paisRow: Pais =
        paisesConv.paisPorConv.get(r.conversation_id) ||
        paisesConv.paisPorContacto.get(d) ||
        paisDeTelefono(d) ||
        "cl"
      if (paisRow !== pais) return false
      // Filtro global Estado/Propietario: solo contactos del conjunto.
      if (permitidos && !permitidos.has(d)) return false
      // Filtro Desde–Hasta sobre el inicio de la conversación. Una conversación
      // sin fecha conocida se EXCLUYE cuando el filtro está activo: un filtro
      // de fechas no puede mostrar filas de fecha desconocida.
      return !rango || enRango(fechasConv.get(r.conversation_id), rango)
    })
    // Hechos deterministas mandan sobre el LLM: cotización formal enviada y
    // reunión agendada se imponen aunque el modelo no las haya detectado.
    for (const r of rows) {
      const d = digits(r.contact)
      if (hard.quote.has(d)) {
        r.grupo = "comercial"
        r.sub_bucket = "cotizacion"
        r.cotizacion_outcome = "cotizacion_enviada"
        r.motivo_no_cierre = null
      } else if (hard.meeting.has(d)) {
        r.grupo = "comercial"
        r.sub_bucket = "reunion"
        r.cotizacion_outcome = null
        r.motivo_no_cierre = null
      }
    }
  } catch (e) {
    return paginaAviso(
      "Error consultando datos",
      `<p>Vuelve a intentarlo en unos segundos.</p><pre>${esc(String(e).slice(0, 300))}</pre>`,
      500,
    )
  }

  // Vista de detalle de un KPI: usa las MISMAS rows ya filtradas por país,
  // fechas, estado y propietario, más el predicado del bucket.
  // Detalle de los KPIs de cotizaciones (cuentan quotes, no conversaciones).
  if (["zoho_cotizaciones", "zoho_aceptadas", "zoho_aceptadas_solo", "zoho_pagadas"].includes(listaParam || "")) {
    const acc = cierre?.aceptadasList || []
    const quotes =
      listaParam === "zoho_aceptadas" ? acc
      : listaParam === "zoho_aceptadas_solo" ? acc.filter((q) => !esPagada(q))
      : listaParam === "zoho_pagadas" ? acc.filter((q) => esPagada(q))
      : cierre?.quotesList || []
    const titulo =
      listaParam === "zoho_aceptadas" ? "Aceptadas / pagadas"
      : listaParam === "zoho_aceptadas_solo" ? "Aceptadas sin pago"
      : listaParam === "zoho_pagadas" ? "Pagadas"
      : "Cotizaciones en Zoho"
    const convPorContacto = new Map<string, string>()
    for (const f of filasListado) {
      const d = digits(f.contacto)
      if (d && f.convId && !convPorContacto.has(d)) convPorContacto.set(d, f.convId)
    }
    // Contactos fuera del listado comercial vivo (cotizaciones viejas): la
    // conversación sale del mapa global de conversaciones.
    for (const [d, id] of convIdPorContacto) if (!convPorContacto.has(d)) convPorContacto.set(d, id)
    return renderListaCotizaciones(quotes, titulo, key, `?${filtrosQS().toString()}`, convPorContacto, wspVendedorSet, llegoPorFormulario)
  }

  if (listaParam && KPI_BUCKETS[listaParam]) {
    const b = KPI_BUCKETS[listaParam]
    // Ficha más reciente por contacto (filasListado viene ordenado por fecha
    // de último estado, descendente).
    const filaPorContacto = new Map<string, FilaListado>()
    for (const f of filasListado) {
      const d = digits(f.contacto)
      if (d && !filaPorContacto.has(d)) filaPorContacto.set(d, f)
    }
    return renderListaKpi(rows.filter(b.pred), b.titulo, key, `?${filtrosQS().toString()}`, ultimoMsgPorConv, filaPorContacto, llegoPorFormulario)
  }

  // Sin conversaciones ANALIZADAS para el filtro, pero la COLA sí puede tener
  // casos (p. ej. un trato asignado hoy cuya conversación partió antes): en la
  // vista de gestión se sigue de largo y se muestra la cola (06-ago).
  if (rows.length === 0 && !(vista === "gestion" && casosGestion.length > 0)) {
    if (estadoF.length || propF.length) {
      return paginaAviso(
        "Sin conversaciones para este filtro",
        `<p>No hay casos con ${[
          estadoF.length ? `estado <b>${esc(estadoF.join(", "))}</b>` : "",
          propF.length ? `propietario <b>${esc(propF.join(", "))}</b>` : "",
        ].filter(Boolean).join(" y ")} en el período.</p><p><a href="?key=${encodeURIComponent(key)}&pais=${pais}">← Quitar filtros</a></p>`,
      )
    }
    return paginaAviso(
      "Sin análisis todavía",
      "<p>La tabla de análisis está vacía. Corre el cron una vez: <code>/api/vic-funnel-cron?key=&lt;VIC_FUNNEL_KEY&gt;&amp;all=1</code> (puede requerir varias llamadas para el histórico).</p>",
    )
  }

  const n = (pred: (r: Row) => boolean) => rows.filter(pred).length
  const total = rows.length
  const comercial = n((r) => r.grupo === "comercial")
  const soporte = n((r) => r.grupo === "soporte")
  const noId = n((r) => r.grupo === "no_identificado")

  const crosselling = n((r) => r.grupo === "comercial" && r.sub_bucket === "crosselling")
  const lead = n((r) => r.grupo === "comercial" && r.sub_bucket === "lead")
  const reunion = n((r) => r.grupo === "comercial" && r.sub_bucket === "reunion")
  const cotizacion = n((r) => r.grupo === "comercial" && r.sub_bucket === "cotizacion")
  const soloDudas = n((r) => r.grupo === "comercial" && r.sub_bucket === "solo_dudas")

  const cPreform = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "preform_mostrado")
  const cEnviada = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "cotizacion_enviada")
  const cAbandonado = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "abandonado")

  // Modo JSON (?formato=json): expone la cola de gestión y los números clave
  // para consumidores programáticos — hoy, el resumen diario por correo
  // (/api/vic-resumen-diario). Respeta todos los filtros de la URL.
  if ((searchParams.get("formato") || "") === "json") {
    const vieronPrecio = cPreform + cEnviada
    return Response.json({
      pais,
      generado: new Date().toISOString(),
      totales: {
        conversaciones: total,
        comercial,
        flujoCotizacion: cotizacion,
        colaPendiente: casosGestion.filter((c) => !c.gestionado).length,
        gestionados24h: nGestionadosCola,
      },
      cierre: cierre
        ? {
            cotizaciones: cierre.total,
            aceptadas: cierre.aceptadas,
            tasaEndToEnd: (() => {
              const base = [...preformAtMap.values()].filter((at) => !rango || enRango(at, rango)).length
              const pag = cierre.aceptadasList.filter((q) => esPagada(q)).length
              return base ? Math.round((pag / base) * 100) : 0
            })(),
            objetivo: pais === "cl" ? 30 : 10,
          }
        : null,
      casos: casosGestion.filter((c) => !c.gestionado),
    })
  }

  // Descarga de la cola (pedido Lalo 04-ago): ?formato=csv baja un archivo que
  // abre directo en Excel (BOM UTF-8, separador ';' — convención es-CL);
  // ?formato=impresion abre una vista limpia que lanza el diálogo de
  // imprimir/guardar como PDF. Ambas respetan los filtros activos.
  if ((searchParams.get("formato") || "") === "csv") {
    const origin = new URL(req.url).origin
    const celda = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const encabezado = [
      "Tipo de acción", "Empresa", "Teléfono", "Llegó por", "Ejecutivo", "Primer contacto", "Estado",
      "Fecha del estado", "Último contacto", "Estado en Zoho", "Días sin contacto",
      "Urgencia", "Monto/mes", "Accionable", "Resumen", "Gestionado", "Link chat", "Link Zoho",
    ].join(";")
    const filasCsv = casosGestion.map((c) =>
      [
        c.tipoLabel, c.empresa, `+${c.contacto}`, c.esFormulario ? "Formulario" : "WhatsApp", c.propietario,
        fmtSantiago(c.primerContactoIso), c.estado, fmtSantiago(c.fechaEstadoIso),
        fmtSantiago(c.ultimoContactoIso), c.estadoZoho, String(c.diasSinContacto),
        c.urgencia, c.monto, c.accionable, c.resumen, c.gestionado ? "sí" : "no",
        c.convId ? `${origin}/api/vic-funnel?conv=${encodeURIComponent(c.convId)}` : "",
        c.zohoUrl,
      ].map(celda).join(";"),
    )
    const hoyStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date())
    return new Response(`${"\ufeff"}${encabezado}\n${filasCsv.join("\n")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="gestion_vicky_${pais}_${hoyStr}.csv"`,
      },
    })
  }
  if ((searchParams.get("formato") || "") === "impresion") {
    const filtroTxt = [
      `Vicky ${PAISES[pais].nombre}`,
      rango ? `📅 ${rango.etiqueta}` : "últimos 30 días de actividad",
      estadoF.length ? `Estado: ${estadoF.join(", ")}` : "",
      propF.length ? `Propietario: ${propF.join(", ")}` : "",
      `generado ${fmtSantiago(new Date().toISOString())}`,
    ].filter(Boolean).join(" · ")
    const filasImp = casosGestion.map((c) => `<tr>
      <td>${esc(c.tipoLabel)}</td>
      <td><b>${esc(c.empresa)}</b><br>+${esc(c.contacto)}</td>
      <td style="white-space:nowrap">${c.esFormulario ? "📋 Formulario" : "📱 WhatsApp"}</td>
      <td>${esc(c.propietario)}</td>
      <td>${fmtSantiago(c.primerContactoIso)}</td>
      <td>${esc(c.estado)}</td>
      <td>${fmtSantiago(c.ultimoContactoIso || c.fechaEstadoIso)}</td>
      <td>${esc(c.estadoZoho)}</td>
      <td>${esc(c.urgencia)} · ${c.diasSinContacto} d</td>
      <td style="text-align:right;white-space:nowrap">${c.monto}</td>
      <td>${esc(c.accionable)}${c.resumen ? `<br><span class="mini">${esc(c.resumen)}</span>` : ""}${c.gestionado ? `<br><span class="mini">✔ gestionado en las últimas 24 h</span>` : ""}</td>
    </tr>`).join("")
    const htmlImp = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gestión de oportunidades — Vicky</title>
<style>
  ${GV_FONT_CSS}
  @page{size:landscape;margin:10mm}
  body{font-family:${GV_BODY_FONT};margin:16px;color:#4e4e4e}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:18px;margin:0 0 2px}
  .sub{color:#646464;font-size:11px;margin-bottom:10px}
  img{height:24px;vertical-align:middle;margin-right:10px}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #dfe2e7;vertical-align:top}
  th{color:#646464;font-size:10px;border-bottom:2px solid #c9ced4}
  tr{page-break-inside:avoid}
  .mini{color:#8a9099;font-size:9.5px}
</style></head><body>
  <h1><img src="/gv/logo-full-color.svg" alt="GeoVictoria">Gestión de oportunidades — ${casosGestion.length} casos</h1>
  <div class="sub">${esc(filtroTxt)}</div>
  <table><thead><tr><th>Tipo</th><th>Empresa / contacto</th><th>Llegó por</th><th>Ejecutivo</th><th>Primer contacto</th><th>Estado</th><th>Último contacto</th><th>Zoho</th><th>Urgencia</th><th>Monto/mes</th><th>Accionable</th></tr></thead>
  <tbody>${filasImp}</tbody></table>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>`
    return page(htmlImp)
  }

  // ── Funnel por ORIGEN: outbound (leads asignados) vs inbound (llegó solo) ──
  // Etapas alineadas desde "calificado" para comparar lado a lado. Pagadas se
  // cruzan por el teléfono de la cotización; las sin teléfono van a inbound
  // (nacen de conversaciones que el cliente inició).
  const esOutbound = (c: string) => origen.toque0.has(digits(c))
  const obRespondio = [...origen.toque0].filter((c) => origen.respondio.has(c)).length
  const fOb = {
    asignados: origen.asignadosTotal || origen.toque0.size + origen.sinContactar,
    toque0: origen.toque0.size,
    respondio: obRespondio,
    calificado: n((r) => esOutbound(r.contact) && r.sub_bucket === "cotizacion"),
    precio: n((r) => esOutbound(r.contact) && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "cotizacion_enviada")),
    formal: n((r) => esOutbound(r.contact) && r.cotizacion_outcome === "cotizacion_enviada"),
    // Hecho duro de Zoho: leads convertidos a DEAL (se les envió cotización).
    convertido: [...origen.convertidos].filter((c) => esOutbound(c)).length,
    pagada: (cierre?.aceptadasList || []).filter((q) => esOutbound(String(q.Tel_fono_Contacto || ""))).length,
  }
  const fIn = {
    origen: n((r) => !esOutbound(r.contact)),
    calificado: n((r) => !esOutbound(r.contact) && r.sub_bucket === "cotizacion"),
    precio: n((r) => !esOutbound(r.contact) && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "cotizacion_enviada")),
    formal: n((r) => !esOutbound(r.contact) && r.cotizacion_outcome === "cotizacion_enviada"),
    // Leads inbound (formulario) convertidos a deal — mismo hecho duro Zoho.
    convertido: [...origen.convertidos].filter((c) => !esOutbound(c)).length,
    pagada: (cierre?.aceptadasList || []).filter((q) => !esOutbound(String(q.Tel_fono_Contacto || ""))).length,
  }
  const pct2 = (parte: number, base: number) => (base > 0 ? `${Math.round((parte / base) * 100)}%` : "—")
  const filaFunnel = (etapa: string, ob: number | null, obBase: number | null, inb: number | null, inBase: number | null) => `
    <tr>
      <td>${etapa}</td>
      <td style="text-align:right"><b>${ob === null ? "—" : ob}</b></td>
      <td style="color:#6b7280">${ob === null || obBase === null ? "" : pct2(ob, obBase)}</td>
      <td style="text-align:right"><b>${inb === null ? "—" : inb}</b></td>
      <td style="color:#6b7280">${inb === null || inBase === null ? "" : pct2(inb, inBase)}</td>
    </tr>`
  const funnelOrigenHtml = `
  <div class="card"><h2>Funnel por origen <span class="pct" style="font-weight:400">— outbound (leads asignados a Vicky) vs inbound (el cliente llegó solo) · % sobre la etapa anterior</span></h2>
    <table><thead><tr><th>Etapa</th><th style="text-align:right">Outbound</th><th></th><th style="text-align:right">Inbound</th><th></th></tr></thead><tbody>
      ${filaFunnel("Leads asignados / Conversaciones iniciadas", fOb.asignados, null, fIn.origen, null)}
      ${filaFunnel("Toque 0 entregado", fOb.toque0, fOb.asignados, null, null)}
      ${filaFunnel("Respondió", fOb.respondio, fOb.toque0, null, null)}
      ${filaFunnel("Calificado en flujo cotización", fOb.calificado, fOb.respondio, fIn.calificado, fIn.origen)}
      ${filaFunnel("Vio precio", fOb.precio, fOb.calificado, fIn.precio, fIn.calificado)}
      ${filaFunnel("Cotización formal enviada", fOb.formal, fOb.precio, fIn.formal, fIn.precio)}
      ${filaFunnel("Convertido a deal (Zoho)", fOb.convertido, fOb.formal, fIn.convertido, fIn.formal)}
      ${filaFunnel("💰 Pagada", fOb.pagada, fOb.convertido, fIn.pagada, fIn.formal)}
    </tbody></table>
    <div class="sub" style="margin-top:8px">Cierre punta a punta: outbound ${pct2(fOb.pagada, fOb.asignados)} de los leads asignados · inbound ${pct2(fIn.pagada, fIn.origen)} de las conversaciones. Las cotizaciones pagadas sin teléfono registrado se cuentan como inbound.</div>
  </div>`

  // ── Motivos de no-cierre (flujo cotización que no terminó en envío) ──────
  const noCierre = rows.filter(
    (r) => r.sub_bucket === "cotizacion" && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "abandonado"),
  )
  const motivoCount = new Map<string, number>()
  for (const r of noCierre) {
    const m = r.motivo_no_cierre || "sin_motivo"
    motivoCount.set(m, (motivoCount.get(m) || 0) + 1)
  }
  // Orden por frecuencia; cap a 7 nodos + "otros" para mantener legible el Sankey.
  const motivosSorted = [...motivoCount.entries()].sort((a, b) => b[1] - a[1])
  const TOP_MOTIVOS = 7
  const topMotivos = motivosSorted.slice(0, TOP_MOTIVOS).map(([m]) => m)
  const hayOtros = motivosSorted.length > TOP_MOTIVOS
  const motivoBucket = (m: string) => (topMotivos.includes(m) ? m : "otros")

  // Hallazgos auto-detectados: agregados por tipo, con un ejemplo.
  const byTipo = new Map<string, { count: number; ejemplo: string }>()
  for (const r of rows) {
    for (const h of r.hallazgos || []) {
      if (!h || !h.tipo) continue
      const cur = byTipo.get(h.tipo) || { count: 0, ejemplo: h.detalle || "" }
      cur.count++
      if (!cur.ejemplo && h.detalle) cur.ejemplo = h.detalle
      byTipo.set(h.tipo, cur)
    }
  }
  const hallazgosAuto = [...byTipo.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)

  const lastUpdate = rows
    .map((r) => r.analyzed_at || "")
    .filter(Boolean)
    .sort()
    .slice(-1)[0]
  const lastUpdateStr = lastUpdate
    ? new Date(lastUpdate).toLocaleString("es-CL", { timeZone: "America/Santiago" })
    : "—"

  // ── Sankey ──────────────────────────────────────────────────────────────
  // Parte del total de conversaciones, que se abre en los 3 grupos. Comercial
  // se abre en 5 sub-buckets; "Flujo cotización" se abre en 3 estados. Soporte y
  // No identificado son sumideros (reciben flujo de la raíz → rinden su tamaño).
  const labels = [
    /* 0 */ "Conversaciones",
    /* 1 */ "Intención comercial", /* 2 */ "Soporte", /* 3 */ "No identificado",
    /* 4 */ "Crosselling", /* 5 */ "Lead (callback)", /* 6 */ "Reunión", /* 7 */ "Flujo cotización", /* 8 */ "Solo dudas",
    /* 9 */ "Vio precio, no avanzó", /* 10 */ "Cotización enviada", /* 11 */ "Se fue antes del precio",
  ]
  const col = {
    base: "#4e4e4e", com: "#00aff2", sop: "#00838F", noid: "#9aa0a8",
    good: "#2E7D32", best: "#1B5E20", warn: "#F9A825", bad: "#C62828", grey: "#9aa0a8",
  }
  const nodeColor = [
    col.base,
    col.com, col.sop, col.noid,
    col.good, col.warn, col.good, col.com, col.grey,
    col.good, col.best, col.bad,
  ]
  const mk = (s: number, t: number, v: number) => ({ s, t, v })
  const links = [
    mk(0, 1, comercial), mk(0, 2, soporte), mk(0, 3, noId),
    mk(1, 4, crosselling), mk(1, 5, lead), mk(1, 6, reunion), mk(1, 7, cotizacion), mk(1, 8, soloDudas),
    mk(7, 9, cPreform), mk(7, 10, cEnviada), mk(7, 11, cAbandonado),
  ].filter((l) => l.v > 0)

  // 3er nivel: Preform mostrado (9) y Abandonado (11) se abren por motivo de
  // no-cierre. Los nodos de motivo se agregan dinámicamente tras los 12 base.
  const motivoNodeNames = [...topMotivos, ...(hayOtros ? ["otros"] : [])]
  const motivoNodeIndex = new Map<string, number>()
  motivoNodeNames.forEach((m, i) => {
    motivoNodeIndex.set(m, labels.length + i)
    labels.push(m.replace(/_/g, " "))
    nodeColor.push("#A1887F")
  })
  // Cuenta por (estado, motivo) y crea los links estado→motivo.
  const pairCount = new Map<string, number>()
  for (const r of noCierre) {
    const stageNode = r.cotizacion_outcome === "preform_mostrado" ? 9 : 11
    const mNode = motivoNodeIndex.get(motivoBucket(r.motivo_no_cierre || "sin_motivo"))
    if (mNode === undefined) continue
    const key = `${stageNode}|${mNode}`
    pairCount.set(key, (pairCount.get(key) || 0) + 1)
  }
  for (const [key, v] of pairCount) {
    const [s, t] = key.split("|").map(Number)
    links.push(mk(s, t, v))
  }

  const kpiCard = (label: string, value: number | string, color: string, sub?: string, bucket?: string) =>
    `<div class="kpi">${bucket ? `<a href="${hrefLista(bucket)}" title="Ver el detalle" style="text-decoration:none">` : ""}<div class="kpi-v" style="color:${color}${bucket ? ";cursor:pointer" : ""}">${value}</div>${bucket ? "</a>" : ""}<div class="kpi-l">${label}${sub ? ` <span class="pct">${sub}</span>` : ""}</div></div>`

  // ── Flujo cotización y tasa de cierre: se computa una vez y alimenta ambas
  // vistas — el bloque completo va en Análisis; la tarjeta hero de tasa de
  // cierre es lo ÚNICO de KPIs que queda visible en Gestión (Lalo 04-ago).
  let flujoCotizHtml = ""
  let tasaCierreHtml = ""
  // Panel SLA (punto 1, Lalo 08-ago) — solo en la vista de análisis.
  const slaHtml = vista === "analisis" ? await renderPanelSla().catch(() => "") : ""
  const plantillasHtml = vista === "analisis" ? await renderPanelPlantillas().catch(() => "") : ""
  {
    // DENOMINADOR DE LA TASA DE CIERRE (Lalo 14-ago — el dash marcó 300%):
    // antes se usaban los BUCKETS de conversación (cPreform + cEnviada), que
    // se cuentan por fecha de la CONVERSACIÓN mientras las pagadas se cuentan
    // por fecha de PAGO. Con un rango de un día el descalce daba tasas
    // imposibles. Ahora el denominador son las MISMAS series del gráfico y
    // del mismo período: precios mostrados + formales emitidas.
    const preformsPeriodo = [...preformAtMap.values()].filter(
      (at) => !rango || enRango(at, rango),
    ).length
    // Denominador = SOLO los precios mostrados del período (Lalo 14-ago): la
    // formal no entra — quien recibe formal ya vio precio antes, sumarla
    // duplicaría la base.
    const vieronPrecioBase = preformsPeriodo
    const vieronPrecio = cPreform + cEnviada
    const pasoPreform = vieronPrecio ? `${Math.round((cEnviada / vieronPrecio) * 100)}% de los que vieron precio` : ""
    const abandonoPreform = vieronPrecio ? `${Math.round((cPreform / vieronPrecio) * 100)}% de abandono tras ver precio` : ""
    const base = `
    ${kpiCard("Vio precio y NO avanzó", cPreform, col.warn, abandonoPreform || "quedó en preform", "preform")}
    ${kpiCard("Cotización enviada", cEnviada, col.best, pasoPreform, "enviada")}
    ${kpiCard("Se fue ANTES del precio", cAbandonado, col.bad, "sin preform", "abandonado")}`
    if (!cierre) {
      flujoCotizHtml = `<div class="kpis">${base}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Zoho no disponible en esta carga — recarga para ver aceptadas y cierre.</div>`
    } else {
      const tasaAcept = cierre.total ? `${Math.round((cierre.aceptadas / cierre.total) * 100)}%` : ""
      // Tasa de cierre = SOLO PAGADAS del período ÷ vieron precio del período
      // (Rodrigo 13-ago): la aceptación no es plata; sale del numerador.
      const pagadasN = cierre.aceptadasList.filter((q) => esPagada(q)).length
      const endToEnd = vieronPrecioBase ? Math.round((pagadasN / vieronPrecioBase) * 100) : 0
      // Objetivo de cierre POR PAÍS (Lalo 28-jul): Chile 30%; Colombia, Perú y
      // México 10% — los programas nuevos maduran distinto.
      const TARGET_PCT = pais === "cl" ? 30 : 10
      const metaExacta = (TARGET_PCT / 100) * vieronPrecioBase
      const cumpleMeta = vieronPrecioBase > 0 && pagadasN >= metaExacta
      const faltanEnviadas = Math.max(0, Math.ceil(metaExacta - pagadasN))
      const faltanNuevas = Math.max(0, Math.ceil((metaExacta - pagadasN) / (1 - TARGET_PCT / 100)))
      const leyendaObjetivo = cumpleMeta
        ? `${pagadasN} pagadas ÷ ${vieronPrecioBase} precios mostrados · objetivo alcanzado 🎉`
        : `${pagadasN} pagadas ÷ ${vieronPrecioBase} precios mostrados · faltan ${faltanEnviadas} pago${faltanEnviadas === 1 ? "" : "s"} para la meta`
      const colorObjetivo = cumpleMeta ? col.best : col.warn
      const avanceMeta = Math.min(100, Math.round((endToEnd / TARGET_PCT) * 100))
      tasaCierreHtml = vieronPrecioBase
        ? `<div class="kpis"><div class="kpi hero">
        <div class="kpi-v"><span style="color:${colorObjetivo}">${endToEnd}%</span> <span class="hero-meta">de cierre real · objetivo ${TARGET_PCT}%</span></div>
        <div class="hero-bar"><div style="width:${avanceMeta}%;background:${colorObjetivo}"></div></div>
        <div class="kpi-l">${avanceMeta}% del camino al objetivo <span class="pct">${leyendaObjetivo}</span></div>
      </div></div>`
        : ""
      // Separación Aceptada vs Pagada (Rodrigo 13-ago): la aceptación es
      // intención, el pago es plata — cada una con su tarjeta y su detalle.
      const aceptadasSinPago = cierre.aceptadas - pagadasN
      const tasaPagadas = cierre.total ? `${Math.round((pagadasN / cierre.total) * 100)}%` : ""
      flujoCotizHtml = `<div class="kpis">${base}
    ${kpiCard("Cotizaciones en Zoho", cierre.total, col.com, undefined, "zoho_cotizaciones")}
    ${kpiCard("Aceptadas sin pago", aceptadasSinPago, col.warn, tasaAcept ? `${tasaAcept} aceptación total` : undefined, "zoho_aceptadas_solo")}
    ${kpiCard("Pagadas", pagadasN, col.good, tasaPagadas, "zoho_pagadas")}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Nota: el dash cuenta <b>solo lo que Vicky inició</b> — las cotizaciones que los ejecutivos emiten desde el editor a clientes propios (sin conversación con Vicky) quedan fuera de todos estos números (Lalo 14-ago). Los 3 primeros KPI cuentan <b>conversaciones</b>; los de Zoho cuentan <b>cotizaciones</b>. Una conversación puede generar más de una cotización (p. ej. un contacto que cotiza para 2 empresas), por eso pueden diferir levemente.</div>`
    }
  }
  const pct = (x: number) => (total ? `${Math.round((x / total) * 100)}%` : "")

  const html = `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Embudo de conversaciones — Vicky</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1440px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:22px;margin:0 0 4px;color:#4e4e4e}
  .sub{color:#646464;font-size:13px;margin-bottom:20px}
  .kpis{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .kpi{background:#fff;border:1px solid #dfe2e7;border-radius:10px;padding:14px 18px;min-width:120px;flex:1}
  .kpi-v{font-family:${GV_TITLE_FONT};font-size:28px;font-weight:700} .kpi-l{font-size:12px;color:#646464;margin-top:2px}
  .kpi.hero{flex-basis:100%;text-align:center;padding:20px 18px} .kpi.hero .kpi-v{font-size:42px}
  .hero-meta{font-size:17px;font-weight:600;color:#9aa0a8}
  .hero-bar{height:9px;background:#eef0f3;border-radius:5px;max-width:440px;margin:10px auto 6px;overflow:hidden}
  .hero-bar>div{height:100%;border-radius:5px}
  .pct{color:#9aa0a8} .tag{display:inline-block;background:#e6f8fe;color:#4e4e4e;font-size:11px;padding:2px 8px;border-radius:99px}
  .card{background:#fff;border:1px solid #dfe2e7;border-radius:12px;padding:18px;margin-top:18px}
  .card h2{font-family:${GV_TITLE_FONT};font-weight:600;font-size:16px;margin:0 0 12px;color:#4e4e4e}
  #sankey{width:100%;height:480px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:top}
  th{color:#646464;font-weight:700;font-size:12px}
  td.num{text-align:right;font-weight:700;width:64px;color:#646464}
  code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:12px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  .kgroup{font-family:${GV_TITLE_FONT};font-size:11px;font-weight:700;color:#646464;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
  .bars{display:flex;flex-direction:column;gap:8px}
  .bar-row{display:grid;grid-template-columns:160px 1fr 40px;align-items:center;gap:10px;font-size:13px}
  .bar-track{background:#eef0f3;border-radius:6px;height:18px;overflow:hidden}
  .bar-fill{background:#ffbb00;height:100%;border-radius:6px}
  .bar-num{text-align:right;font-weight:700;color:#646464}
  .foot{color:#9aa0a8;font-size:11px;margin-top:24px;text-align:center}
  /* Celular: menos padding, tipografía contenida, tablas con scroll propio e
   * inputs de 16px (evita el zoom automático de iOS al enfocar). */
  @media (max-width:640px){
    .wrap{padding:14px 12px 44px}
    h1{font-size:18px}
    .card{padding:12px;overflow-x:auto}
    .kpi{padding:10px 12px;min-width:100px}
    .kpi-v{font-size:22px}
    .kpi.hero .kpi-v{font-size:30px}
    #sankey{height:340px}
    .bar-row{grid-template-columns:110px 1fr 36px}
    form input[type=date],form select{font-size:16px !important;padding:6px 8px !important}
    form button[type=submit]{font-size:14px !important;padding:8px 16px !important}
  }
</style></head><body><div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:16px"><img src="/gv/logo-full-color.svg" alt="GeoVictoria" style="height:30px"><h1 style="margin:0">${vista === "gestion" ? "Gestión de oportunidades" : vista === "inbound" ? "Inbound diario" : "Análisis y KPIs"}</h1></div>
    ${vista === "inbound" ? "" : `<div style="font-size:14px;white-space:nowrap;display:flex;gap:14px;flex-wrap:wrap">
      ${vista === "gestion" ? `<b>📞 Gestión</b>` : `<a href="?${(() => { const p = filtrosQS(); p.delete("vista"); return p.toString() })()}">📞 Gestión</a>`}
      <a href="?key=${encodeURIComponent(key)}&vista=editor">🧾 Editor de cotizaciones</a>
      <a href="?key=${encodeURIComponent(key)}&vista=cotfunnel">🧭 Funnel cotizaciones</a>
      <a href="?key=${encodeURIComponent(key)}&vista=tombolas">🎰 Auditoría tómbolas</a>
      <a href="?${(() => { const p = filtrosQS(); p.set("vista", "cartera"); return p.toString() })()}">📋 Cartera</a>
      <a href="?${(() => { const p = filtrosQS(); p.set("vista", "traspasos"); return p.toString() })()}">🤝 Traspasos</a>
      <a href="?${(() => { const p = filtrosQS(); p.set("vista", "cierre"); return p.toString() })()}">📅 Cierre diario</a>
      <a href="?${(() => { const p = filtrosQS(); p.set("vista", "campanas"); return p.toString() })()}">📣 Campañas</a>
      ${esAdmin ? `<a href="?${(() => { const p = filtrosQS(); p.set("vista", "espejos"); return p.toString() })()}">🪞 Espejos</a>` : ""}
      ${inboundLinkKey ? `<a href="/inbound?k=${encodeURIComponent(inboundLinkKey)}">📥 Inbound diario</a>` : ""}
      ${vista === "analisis" ? `<b>📊 Análisis y KPIs</b>` : `<a href="?${(() => { const p = filtrosQS(); p.set("vista", "analisis"); return p.toString() })()}">📊 Análisis y KPIs</a>`}
    </div>`}
  </div>
  <div class="sub">${(Object.keys(PAISES) as Pais[]).map((k) => `<a href="?key=${encodeURIComponent(key)}&pais=${k}${vista !== "gestion" ? `&vista=${vista}` : ""}" style="font-weight:${pais === k ? 700 : 400}">${PAISES[k].label}</a>`).join(" | ")}${quien ? ` &nbsp;·&nbsp; 👤 <b>${esc(quien)}</b> <a href="?salir=1" style="font-weight:400">(salir)</a>` : ""}</div>
  <div class="sub" style="margin-top:6px">
    <form method="GET" action="/api/vic-funnel" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="pais" value="${pais}">
      ${vista !== "gestion" ? `<input type="hidden" name="vista" value="${vista}">` : ""}
      <label style="font-size:12px">Desde <input type="date" name="desde" value="${rango ? rango.desdeStr : ""}" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px"></label>
      <label style="font-size:12px">Hasta <input type="date" name="hasta" value="${rango ? rango.hastaStr : ""}" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px"></label>
      <label style="font-size:12px;vertical-align:top" title="Vicky: casos con conversación de WhatsApp (lo accionable ahora). Cartera Zoho: tratos del pipeline que no han pasado por Vicky.">Origen<br><select name="origen" style="font-size:12px;padding:3px 4px;border:1px solid #d0d5db;border-radius:5px;min-width:120px;background:#fff">
        <option value="vicky"${origenF === "vicky" ? " selected" : ""}>🤖 Vicky</option>
        <option value="zoho"${origenF === "zoho" ? " selected" : ""}>🗂 Cartera Zoho</option>
        <option value="todo"${origenF === "todo" ? " selected" : ""}>Todo</option>
      </select></label>
      <label style="font-size:12px">Estado <select name="estado" style="font-size:12px;padding:3px 4px;border:1px solid #d0d5db;border-radius:5px;min-width:130px;background:#fff">
        <option value="">Todos</option>
        ${ESTADOS_LISTADO.map((e) => `<option${estadoF.includes(e) ? " selected" : ""}>${e}</option>`).join("")}
      </select></label>
      ${esAdmin ? `<label style="font-size:12px">Propietario <select name="prop" style="font-size:12px;padding:3px 4px;border:1px solid #d0d5db;border-radius:5px;min-width:150px;background:#fff">
        <option value="">Todos</option>
        ${propietariosAll.map((p) => `<option value="${esc(p)}"${propF.includes(p) ? " selected" : ""}>${esc(p)}</option>`).join("")}
      </select></label>` : ""}
      <button type="submit" style="background:#ffbb00;color:#fff;border:0;border-radius:6px;padding:3px 12px;font-size:12px;font-weight:700;cursor:pointer">Filtrar</button>
      ${rango || estadoF.length || propF.length ? `<a href="?key=${encodeURIComponent(key)}&pais=${pais}" style="font-size:12px">✕ Quitar filtros</a>` : ""}
    </form>
  </div>

  ${vista === "gestion" ? `
  ${colaHtml}
  ` : vista === "inbound" ? `
  ${inboundHtml}
  ` : `
  ${tasaCierreHtml}
  ${evolucionHtml}
  ${slaHtml}
  ${plantillasHtml}
  ${ejecutivosHtml}
  ${empresasHtml}
  <div class="kgroup">Por grupo · suman el total (${total})</div>
  <div class="kpis">
    ${kpiCard("Conversaciones", total, col.base, undefined, "total")}
    ${kpiCard("Intención comercial", comercial, col.com, pct(comercial), "comercial")}
    ${kpiCard("Soporte", soporte, col.sop, pct(soporte), "soporte")}
    ${kpiCard("No identificado", noId, col.noid, pct(noId), "no_identificado")}
  </div>
  <div class="kgroup">Dentro de intención comercial (${comercial})</div>
  <div class="kpis">
    ${kpiCard("Flujo cotización", cotizacion, col.com, undefined, "cotizacion")}
    ${kpiCard("Reunión", reunion, col.good, undefined, "reunion")}
    ${kpiCard("Lead (callback)", lead, col.warn, undefined, "lead")}
    ${kpiCard("Crosselling", crosselling, col.good, undefined, "crosselling")}
    ${kpiCard("Solo dudas", soloDudas, col.grey, undefined, "solo_dudas")}
  </div>
  <div class="kgroup">Flujo cotización y tasa de cierre (${cotizacion} conversaciones · cierre en vivo desde Zoho)</div>
  ${flujoCotizHtml}

  ${ventasHtml}

  <div class="card"><h2>Flujo del embudo</h2><div id="sankey"></div></div>

  <div class="card"><h2>Motivos de no-cierre <span class="pct" style="font-weight:400">— cotizaciones que no terminaron en envío (${noCierre.length})</span></h2>
    ${noCierre.length === 0 ? "<p class='sub'>Sin casos.</p>" : `<div class="bars">
      ${motivosSorted.map(([m, c]) => {
        const w = noCierre.length ? Math.round((c / motivosSorted[0][1]) * 100) : 0
        return `<div class="bar-row"><div>${m.replace(/_/g, " ")}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="bar-num">${c}</div></div>`
      }).join("")}
    </div>
    <div class="kgroup" style="margin-top:18px">Detalle (datos subyacentes)</div>
    <table><thead><tr><th>Motivo</th><th>Etapa</th><th>Qué ocurrió y por qué no avanzó</th><th></th></tr></thead><tbody>
      ${[...noCierre]
        .sort((a, b) => (a.motivo_no_cierre || "~").localeCompare(b.motivo_no_cierre || "~"))
        .map((r) => `<tr>
          <td><b>${esc((r.motivo_no_cierre || "sin motivo").replace(/_/g, " "))}</b></td>
          <td>${r.cotizacion_outcome === "preform_mostrado" ? "Vio precio, no avanzó" : "Se fue antes del precio"}</td>
          <td>${esc(r.resumen || "—")}</td>
          <td><a href="?key=${encodeURIComponent(key)}&conv=${esc(r.conversation_id)}">Ver →</a></td>
        </tr>`)
        .join("")}
    </tbody></table>`}
  </div>

  <div class="card"><h2>Hallazgos auto-detectados (por el análisis)</h2>
    ${hallazgosAuto.length === 0 ? "<p class='sub'>Sin hallazgos aún.</p>" : `<table><thead><tr><th>Patrón</th><th class="num">N°</th><th>Ejemplo</th></tr></thead><tbody>
      ${hallazgosAuto.map(([tipo, v]) => `<tr><td>${tipo.replace(/_/g, " ")}</td><td class="num">${v.count}</td><td>${v.ejemplo}</td></tr>`).join("")}
    </tbody></table>`}
  </div>

  <div class="card"><h2>Mejoras aplicadas al agente (changelog curado)</h2>
    <table><thead><tr><th>Fecha</th><th>Mejora</th><th>Detalle</th></tr></thead><tbody>
      ${CURATED_FINDINGS.map((f) => `<tr><td style="width:8%;white-space:nowrap">${f.fecha}</td><td style="width:30%"><b>${f.titulo}</b></td><td>${f.detalle}</td></tr>`).join("")}
    </tbody></table>
  </div>

  ${funnelOrigenHtml}
  `}

</div>
<script>
  var sankeyDiv = document.getElementById("sankey");
  if (sankeyDiv) {
    var labels = ${JSON.stringify(labels)};
    var nodeColor = ${JSON.stringify(nodeColor)};
    var L = ${JSON.stringify(links)};
    var data = [{
      type: "sankey", orientation: "h",
      node: { label: labels, color: nodeColor, pad: 18, thickness: 18, line: { color: "#fff", width: 1 },
        hovertemplate: "%{label}: %{value}<extra></extra>" },
      link: { source: L.map(function(x){return x.s}), target: L.map(function(x){return x.t}),
        value: L.map(function(x){return x.v}), color: "rgba(47,84,150,0.16)",
        hovertemplate: "%{source.label} → %{target.label}: %{value}<extra></extra>" }
    }];
    Plotly.newPlot("sankey", data, { font: { size: 12 }, margin: { l: 0, r: 0, t: 8, b: 8 } }, { responsive: true, displayModeBar: false });
  }
</script>
</body></html>`

  // Foto del dash: SOLO los renders con llave máquina la guardan (sus links
  // llevan la llave; al servirla a humanos se les quita). El cron horario y
  // cualquier carga máquina la mantienen fresca; un miss se auto-repuebla.
  if (snapKey && key) {
    void kvSet(snapKey, JSON.stringify({ at: new Date().toISOString(), html }))
  }
  finLog()
  return page(html)
}
