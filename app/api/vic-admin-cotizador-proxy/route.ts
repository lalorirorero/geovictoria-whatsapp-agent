/**
 * Endpoint ADMIN: GET /api/vic-admin-cotizador-proxy?ruta=/api/...
 *
 * Puente de SOLO LECTURA hacia el cotizador. Existe porque los endpoints de
 * diagnóstico de ese repo se autentican con `VICKY_COTIZADORA_SECRET`, que
 * vive en el env del agente y no se puede leer desde fuera (es `sensitive` en
 * Vercel). Sin esto, cada consulta de diagnóstico exige un deploy allá.
 *
 * GET únicamente, host fijo y ruta acotada a /api/: no muta nada por sí mismo.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const COTIZADOR = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || "").trim()
  const kv = await getFollowupCronSecret().catch(() => "")
  if (!key || (key !== CRON_SECRET && key !== kv)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const ruta = (sp.get("ruta") || "").trim()
  if (!/^\/api\/[A-Za-z0-9/_?&=%.:+-]*$/.test(ruta)) {
    return NextResponse.json({ ok: false, error: "ruta inválida" }, { status: 400 })
  }
  const r = await fetch(`${COTIZADOR}${ruta}`, {
    headers: { "x-vicky-secret": SECRET, Accept: "application/json" },
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  return new NextResponse(cuerpo, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "x-upstream-status": String(r.status) },
  })
}

// POST acotado a una ALLOWLIST de endpoints admin del cotizador (24-ago,
// caso Vista Kennedy: la NDV falló en emisión Y aceptación porque el deal no
// tenía cuenta; reparada la cadena, recrearla exige el POST autenticado de
// crear-ndv-desde-cot y el secreto no sale de Vercel). Mismo auth que el GET.
const POST_PERMITIDOS = new Set([
  "/api/creator/crear-ndv-desde-cot",
  "/api/payments/reconcile-pending",
  // Correo al cliente con el PDF actualizado (campaña 10%, 26-ago): permite
  // el retro-envío manual para aceptaciones previas al cableado automático.
  "/api/quote-acceptance/send-reactivation-email",
  // Aplicación manual de descuento (campaña 10%, 26-ago): los casos de canal
  // ejecutivo que el vigía cierra a propósito se resuelven por orden humana.
  "/api/quote-acceptance/descuento-ejecutivo",
  // Link del auto-onboarding por quoteId (27-ago, caso Cafetería Aragón: la
  // bienvenida post-pago murió fuera de ventana y hubo que recuperar el link
  // a mano para entregarlo por el ejecutivo). Idempotente en el cotizador.
  "/api/quote-acceptance/onboarding-link",
  // Barrido de correos de cotización pendientes (01-sep, regla Lalo "si el
  // correo existe, el correo sale"): disparo manual del cron determinista.
  "/api/quote-acceptance/correos-pendientes",
  // NDV del alta por chat (07-sep): convertir+confirmar con la empresa creada
  // y enlazar la Referencia NDV — reintento manual del job de lib/ndv-alta.
  "/api/creator/ndv-alta-chat",
])

export async function POST(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || "").trim()
  const kv = await getFollowupCronSecret().catch(() => "")
  if (!key || (key !== CRON_SECRET && key !== kv)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const ruta = (sp.get("ruta") || "").trim()
  if (!POST_PERMITIDOS.has(ruta)) {
    return NextResponse.json({ ok: false, error: "ruta no permitida para POST" }, { status: 400 })
  }
  const body = await req.text().catch(() => "")
  const r = await fetch(`${COTIZADOR}${ruta}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET, Accept: "application/json" },
    body: body || "{}",
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  return new NextResponse(cuerpo, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "x-upstream-status": String(r.status) },
  })
}
