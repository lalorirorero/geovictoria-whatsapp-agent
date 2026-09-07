/**
 * ADMIN — insight de la conversación en la Implementación (07-sep).
 *
 * GET ?key=<cron>&contact=569XXXXXXXX[&imp=<id>][&completar=1]
 *   · Regenera la nota "Insight de la conversación (Vicky)" y los campos
 *     Detalles / Dolor_levantado_con_Cliente / Comentarios_adicionales /
 *     Conversaci_n_Whatsapp de la implementación del contacto (force: sin
 *     debounce).
 *   · completar=1: además rellena los campos de CREACIÓN que las humanas
 *     traen y una IMP nacida antes del 07-sep no (turnos, tipo de
 *     planificación, semáforo, facturación CLP, moneda, equipos), SOLO donde
 *     estén vacíos.
 * Sirve para el relleno retroactivo (IMP-11428 Molinas) y para re-sincronizar
 * a mano cuando haga falta.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { sincronizarInsightImplementacion } from "@/lib/implementacion-insight"
import { completarBrechasCreacion } from "@/lib/implementacion-vicky"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  if (!entregado) return false
  if (CRON_SECRET && entregado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && entregado === kv
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const contact = (sp.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta ?contact=" }, { status: 400 })
  const imp = (sp.get("imp") || "").replace(/\D/g, "") || undefined
  const insight = await sincronizarInsightImplementacion(contact, { force: true, implementacionId: imp })
  let brechas: unknown = undefined
  if (sp.get("completar") === "1" && (imp || insight.implementacionId)) {
    brechas = await completarBrechasCreacion(String(imp || insight.implementacionId), contact)
  }
  return NextResponse.json({ ok: insight.ok, insight, brechas })
}
