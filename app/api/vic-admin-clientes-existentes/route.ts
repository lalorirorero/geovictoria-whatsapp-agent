/**
 * Endpoint ADMIN: GET /api/vic-admin-clientes-existentes?key=&dias=90&dry=1
 *
 * BARRIDO HISTÓRICO del caso 6 (Lalo 08-sep, "lo hiciste con toda la data
 * histórica?"): leads CREADOS POR VICKY en los últimos `dias` cuyo número
 * pertenece a una cuenta que ya es cliente (3. Cliente/Facturando o con
 * usuarios activos). Con dry=1 solo lista; sin dry: el lead vivo pasa a
 * "No Calificado" motivo "Es un usuario" (terminal: jamás se reactiva ni se
 * traspasa), nota en el lead, loop cerrado (cliente_existente) y traspaso
 * activo cerrado. Los convertidos solo se listan (el deal lo revisa el humano).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { detectarClienteExistente } from "@/lib/cliente-existente"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const VICKY_ID = "3525045000484500876"
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const kvSecret = (await getKvValue("followup_cron_secret").catch(() => null)) || ""
  return Boolean(kvSecret && key === kvSecret)
}

async function supa(path: string, init: RequestInit = {}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  }).catch(() => null)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const dias = Math.max(1, Math.min(365, Number(sp.get("dias")) || 90))
  const dry = sp.get("dry") !== "0"
  const max = Math.max(1, Math.min(400, Number(sp.get("max")) || 200))
  const inicio = Date.now()
  const desde = new Date(Date.now() - dias * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  type LeadRow = { id: string; Full_Name?: string; Company?: string; Phone?: string; Lead_Status?: string; Motivo_No_calificado?: string; "Owner.email"?: string; Created_Time?: string; Converted__s?: boolean }
  const leads: LeadRow[] = []
  for (let off = 0; off < max; off += 200) {
    const r = await fetch(`${api}/crm/v8/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, Full_Name, Company, Phone, Lead_Status, Motivo_No_calificado, Owner.email, Created_Time, Converted__s from Leads ` +
          `where (Created_By = '${VICKY_ID}' and Created_Time >= '${desde}') order by Created_Time desc limit ${off}, 200`,
      }),
    })
    if (!r.ok || r.status === 204) break
    const page = (((await r.json().catch(() => ({}))) as { data?: LeadRow[] }).data || [])
    leads.push(...page)
    if (page.length < 200) break
  }
  const hits: Array<Record<string, unknown>> = []
  let revisados = 0
  let marcados = 0
  for (const l of leads) {
    if (Date.now() - inicio > 240_000) break
    const fono = String(l.Phone || "").replace(/\D/g, "")
    if (!/^569\d{8}$/.test(fono)) continue
    revisados++
    const ce = await detectarClienteExistente(fono).catch(() => null)
    if (!ce) continue
    const yaTerminal = /no calificado/i.test(String(l.Lead_Status || "")) && /usuario/i.test(String(l.Motivo_No_calificado || ""))
    const fila = {
      leadId: l.id, nombre: l.Full_Name, company: l.Company, fono, status: l.Lead_Status, motivo: l.Motivo_No_calificado, owner: l["Owner.email"],
      creado: l.Created_Time, convertido: l.Converted__s === true, cuenta: ce.cuentaNombre, estadoCuenta: ce.estado, accion: "",
    }
    if (l.Converted__s) fila.accion = "convertido — revisar deal a mano"
    else if (yaTerminal) fila.accion = "ya estaba No Calificado / Es un usuario"
    else if (dry) fila.accion = "SE MARCARÍA No Calificado / Es un usuario"
    else {
      const put = await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: l.id, Lead_Status: "No Calificado", Motivo_No_calificado: "Es un usuario" }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
      })
      const okPut = put.ok
      await fetch(`${api}/crm/v3/Notes`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ Note_Title: "Cliente existente (barrido Vicky 08-sep)", Note_Content: `El número +${fono} pertenece a la cuenta "${ce.cuentaNombre}" (${ce.estado || "usuarios activos"}): es cliente actual, no prospecto. Marcado No Calificado / Es un usuario. Cualquier gestión va por soporte o por la cuenta.`, Parent_Id: l.id, $se_module: "Leads" }] }),
      }).catch(() => null)
      await supa(`vic_loop?contact=eq.${fono}&estado=eq.activo`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado", motivo_cierre: "cliente_existente" }) })
      await supa(`vic_ptv?contact=eq.${fono}&estado=eq.activo`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
      fila.accion = okPut ? "marcado No Calificado / Es un usuario" : `PUT falló ${put.status}`
      if (okPut) marcados++
    }
    hits.push(fila)
  }
  return NextResponse.json({ ok: true, dry, dias, leadsVicky: leads.length, revisados, clientesExistentes: hits.length, marcados, hits })
}
