/**
 * Cron del onboarding por chat: NDV confirmada → Implementación enlazada.
 * Ver lib/ndv-alta.ts. Despachado por JOBS_HUERFANOS cada ~2 minutos; cada
 * tick empuja los jobs vivos (`onb_ndvimp_<contacto>`) una pasada.
 *
 * Auth: Bearer/`?key` = CRON_SECRET, o x-cron-secret = vic_kv followup_cron_secret.
 * `?contact=569…` fuerza una pasada de un solo contacto (diagnóstico).
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { contactosConJobNdvImp, procesarNdvImp } from "@/lib/ndv-alta"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (CRON_SECRET && (bearer === CRON_SECRET || key === CRON_SECRET || xcron === CRON_SECRET)) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && (xcron === kv || key === kv)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const uno = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  const contactos = uno ? [uno] : await contactosConJobNdvImp()
  const inicio = Date.now()
  const resultados: Array<{ contact: string; estado: string; ndv?: string; imp?: string }> = []
  for (const c of contactos.slice(0, 10)) {
    if (Date.now() - inicio > 100_000) break
    const r = await procesarNdvImp(c)
    resultados.push({ contact: c, estado: r.estado, ndv: r.job?.ndv?.idNdv, imp: r.job?.impNumero || r.job?.impId })
  }
  return NextResponse.json({ ok: true, jobs: contactos.length, procesados: resultados.length, resultados })
}
