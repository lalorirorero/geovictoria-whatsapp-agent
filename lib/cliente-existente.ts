/**
 * CLIENTE EXISTENTE (Lalo 08-sep, caso Samuel/Onecup: "estamos fallando al
 * crear leads que son usuarios"). Un número que pertenece a una cuenta que ya
 * es cliente (Estado_Cuenta "3. Cliente/Facturando" o con usuarios activos)
 * es SOPORTE/POSTVENTA, no venta: no nace lead, no se traspasa a calificación
 * ni a telemarketing, y Vicky lo atiende con los canales de soporte. Solo si
 * pide EXPLÍCITAMENTE ampliar (más usuarios/equipos) se cotiza como cliente
 * actual. Señal = la CUENTA en Zoho, no el contacto (Vicky crea un contacto
 * para todo prospecto cotizado, así que "tiene contacto" no dice nada).
 * Cache vic_kv `cliente_existente_<fono>` 24 h ("no" también se cachea).
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export type ClienteExistente = {
  cuentaId: string
  cuentaNombre: string
  estado: string
  usuariosActivos: boolean
}

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const TTL_MS = 24 * 3600_000

export function claveClienteExistente(fono: string): string {
  return `cliente_existente_${fono}`
}

export async function detectarClienteExistente(contact: string): Promise<ClienteExistente | null> {
  const fono = (contact || "").replace(/\D/g, "")
  if (!fono || !/^569\d{8}$/.test(fono)) return null
  try {
    const raw = await getKvValue(claveClienteExistente(fono))
    if (raw) {
      const c = JSON.parse(raw) as Partial<ClienteExistente> & { no?: boolean; at?: string }
      const edad = c.at ? Date.now() - new Date(c.at).getTime() : Number.POSITIVE_INFINITY
      if (edad < TTL_MS) {
        if (c.no) return null
        if (c.cuentaId) return { cuentaId: c.cuentaId, cuentaNombre: c.cuentaNombre || "", estado: c.estado || "", usuariosActivos: Boolean(c.usuariosActivos) }
      }
    }
  } catch { /* sin cache legible: se consulta */ }
  let hit: ClienteExistente | null = null
  try {
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}` }
    const r = await fetch(`${API()}/crm/v3/Contacts/search?phone=${fono}&per_page=5`, { headers: H, cache: "no-store" })
    const contactos = r.ok && r.status !== 204
      ? (((await r.json().catch(() => ({}))) as { data?: Array<{ Account_Name?: { id?: string; name?: string } | null }> }).data || [])
      : []
    const cuentas = [...new Set(contactos.map((c) => String(c.Account_Name?.id || "")).filter(Boolean))].slice(0, 3)
    for (const id of cuentas) {
      const ga = await fetch(`${API()}/crm/v3/Accounts/${id}?fields=Account_Name,Estado_Cuenta,Empresa_con_usuarios_activos,UsuariosActivos`, { headers: H, cache: "no-store" })
      if (ga.status !== 200) continue
      const a = ((await ga.json().catch(() => ({}))) as { data?: Array<{ Account_Name?: string; Estado_Cuenta?: string | null; Empresa_con_usuarios_activos?: boolean; UsuariosActivos?: number | null }> }).data?.[0]
      if (!a) continue
      const estado = String(a.Estado_Cuenta || "").trim()
      const activos = a.Empresa_con_usuarios_activos === true || Number(a.UsuariosActivos || 0) > 0
      if (estado.startsWith("3.") || activos) {
        hit = { cuentaId: id, cuentaNombre: String(a.Account_Name || ""), estado, usuariosActivos: activos }
        break
      }
    }
  } catch (e) {
    console.warn(`[cliente-existente] ${fono}: consulta falló (se asume prospecto):`, e instanceof Error ? e.message : e)
    return null
  }
  await setKvValue(claveClienteExistente(fono), JSON.stringify(hit ? { ...hit, at: new Date().toISOString() } : { no: true, at: new Date().toISOString() })).catch(() => {})
  return hit
}

/** Texto para el prompt de Vicky cuando el número es de un cliente actual. */
export function directivaClienteExistente(c: ClienteExistente): string {
  return (
    `\n\n[CLIENTE EXISTENTE — obligatorio] Este número pertenece a la cuenta "${c.cuentaNombre}", que YA es cliente de GeoVictoria` +
    `${c.estado ? ` (${c.estado})` : ""}. Trátalo como SOPORTE / POSTVENTA: no lo trates como prospecto, no cotices por iniciativa tuya, ` +
    `no lo derives a calificación ni a un ejecutivo comercial y no prometas que "un ejecutivo lo llamará". Si trae un problema de uso ` +
    `(reloj, marcaciones, app, accesos, facturación) usa consultar_agente_soporte y entrégale los canales oficiales de soporte. ` +
    `SOLO si pide EXPLÍCITAMENTE ampliar su servicio (más usuarios, otro reloj, otro módulo) cotízalo como cliente actual.`
  )
}
