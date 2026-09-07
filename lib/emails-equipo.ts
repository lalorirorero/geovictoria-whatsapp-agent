/**
 * Correos del EQUIPO (usuarios activos de Zoho CRM) — lista blanca del
 * blindaje de soporte inventado.
 *
 * Caso Conbes / Aracelli (07-sep): `blindarSoporteInventado` reemplaza por
 * soporte@ todo correo @geovictoria.com que no esté en `directorioEjecutivos()`,
 * y el directorio estático no tenía a Aracelli (ni a Daniela ni a Grey) — la
 * reunión salió con "su correo es soporte@geovictoria.com". Con esto, el
 * correo de cualquier persona real de la organización pasa; solo los
 * inventados caen a soporte@.
 *
 * Cache en memoria (6 h) con respaldo en vic_kv (24 h) para no pegarle a
 * Zoho en cada turno. Fail-open: sin Zoho ni kv, devuelve vacío y el
 * directorio estático sigue mandando (comportamiento anterior).
 */
import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

const KV_KEY = "emails_equipo_zoho"
const TTL_MEMORIA_MS = 6 * 3600e3
let cache: { at: number; emails: string[] } | null = null

async function leerDeZoho(): Promise<string[]> {
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const out = new Set<string>()
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(`${api}/crm/v3/users?type=ActiveUsers&page=${page}&per_page=200`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!r.ok || r.status === 204) break
    const j = (await r.json().catch(() => ({}))) as {
      users?: Array<{ email?: string }>
      info?: { more_records?: boolean }
    }
    for (const u of j.users || []) {
      const e = String(u.email || "").trim().toLowerCase()
      if (e.endsWith("@geovictoria.com")) out.add(e)
    }
    if (!j.info?.more_records) break
  }
  return [...out]
}

export async function emailsEquipoZoho(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MEMORIA_MS) return new Set(cache.emails)
  try {
    const crudo = await getKvValue(KV_KEY).catch(() => null)
    if (crudo) {
      const j = JSON.parse(crudo) as { at?: string; emails?: string[] }
      const edad = Date.now() - Date.parse(String(j.at || 0))
      if (Array.isArray(j.emails) && j.emails.length && edad < 24 * 3600e3) {
        cache = { at: Date.now(), emails: j.emails }
        return new Set(j.emails)
      }
    }
  } catch {
    /* sin kv: se consulta Zoho */
  }
  try {
    const emails = await leerDeZoho()
    if (emails.length) {
      cache = { at: Date.now(), emails }
      await setKvValue(KV_KEY, JSON.stringify({ at: new Date().toISOString(), emails })).catch(() => {})
    }
    return new Set(emails)
  } catch (e) {
    console.warn("[emails-equipo] Zoho no respondió; la lista blanca queda con el directorio estático:", e instanceof Error ? e.message : e)
    return new Set()
  }
}
