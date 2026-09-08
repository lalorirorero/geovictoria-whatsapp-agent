/**
 * PLANILLAS DEL WIZARD → IMPLEMENTACIÓN (Lalo 08-sep, caso Haus IMP-11441).
 *
 * Cuando la configuración se cierra por chat, el wizard genera los dos Excel
 * (usuarios + planificaciones) y dispara su Zoho Flow — pero ese Flow NO
 * encuentra la Implementación que nosotros creamos al alta (GV Avanzado), así
 * que la IMP quedaba SIN planillas. Las implementaciones nacidas del wizard
 * las llevan como nota "planillas" con los dos archivos adjuntos (IMP-11176).
 * Acá se replica ese formato: se bajan los Excel de la sesión del wizard (URL
 * firmada 14 d) y se suben como adjuntos de una nota en la IMP. Idempotente
 * por nombre de archivo (kv `onb_planillas_imp_`). Best-effort: nunca lanza.
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { clavePlanillasImp } from "./onboarding/fase"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const WIZARD_URL = (process.env.VICKY_ONBOARDING_WIZARD_URL || "https://onboarding.geovictoria.com").trim().replace(/\/+$/, "")
export const TITULO_NOTA_PLANILLAS = "Planillas de ingreso (Vicky)"

export type PlanillaWizard = { tipo: "usuarios" | "planificaciones"; filename: string; url: string }
type Registro = { impId: string; notaId: string; archivos: string[] }

/** Excel disponibles en la sesión del wizard del contacto (vacío si nunca se cerró). */
export async function planillasDeSesionWizard(contact: string): Promise<PlanillaWizard[]> {
  const token = (await getKvValue(`onboarding_wizard_token_${contact}`).catch(() => null)) || ""
  if (!token) return []
  try {
    const r = await fetch(`${WIZARD_URL}/api/onboarding/${encodeURIComponent(token)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return []
    const ses = (await r.json().catch(() => ({}))) as { formData?: Record<string, unknown> }
    const fd = (ses.formData || {}) as {
      excelUrls?: Partial<Record<"usuarios" | "planificaciones", { filename?: string; url?: string }>>
      excelUrlUsuarios?: string
      excelUrlPlanificaciones?: string
    }
    const out: PlanillaWizard[] = []
    for (const tipo of ["usuarios", "planificaciones"] as const) {
      const url = String(fd.excelUrls?.[tipo]?.url || (tipo === "usuarios" ? fd.excelUrlUsuarios : fd.excelUrlPlanificaciones) || "").trim()
      if (!url) continue
      const filename =
        String(fd.excelUrls?.[tipo]?.filename || "").trim() || decodeURIComponent(url.split("?")[0].split("/").pop() || `${tipo}.xlsx`)
      out.push({ tipo, filename, url })
    }
    return out
  } catch {
    return []
  }
}

async function subirAdjuntoNota(token: string, notaId: string, impId: string, buf: ArrayBuffer, filename: string): Promise<boolean> {
  const form = new FormData()
  form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  let r = await fetch(`${API()}/crm/v3/Notes/${notaId}/Attachments`, { method: "POST", headers: H, body: form, cache: "no-store" })
  if (r.ok) return true
  const detalle = await r.text().catch(() => "")
  console.warn(`[imp-planillas] adjunto a nota ${notaId} falló ${r.status}: ${detalle.slice(0, 200)} — reintento sobre la IMP`)
  const form2 = new FormData()
  form2.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
  r = await fetch(`${API()}/crm/v3/Implementaciones/${impId}/Attachments`, { method: "POST", headers: H, body: form2, cache: "no-store" })
  if (!r.ok) console.warn(`[imp-planillas] adjunto a IMP ${impId} falló ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return r.ok
}

/**
 * Deja las planillas del wizard en la Implementación (nota + adjuntos).
 * Devuelve qué archivos quedaron (nuevos + ya estaban) y nunca lanza.
 */
export async function adjuntarPlanillasImplementacion(
  contact: string,
  impId: string,
  empresa: string,
  detalle = "",
): Promise<{ ok: boolean; archivos: string[]; nuevos: string[]; notaId?: string; motivo?: string }> {
  const fono = (contact || "").replace(/\D/g, "")
  try {
    const planillas = await planillasDeSesionWizard(fono)
    if (!planillas.length) return { ok: false, archivos: [], nuevos: [], motivo: "sin planillas en la sesión del wizard (configuración no cerrada)" }
    let reg: Registro | null = null
    try {
      const raw = await getKvValue(clavePlanillasImp(fono))
      reg = raw ? (JSON.parse(raw) as Registro) : null
    } catch {
      reg = null
    }
    if (reg && reg.impId !== impId) reg = null
    const yaEstan = new Set(reg?.archivos || [])
    const pendientes = planillas.filter((p) => !yaEstan.has(p.filename))
    if (!pendientes.length) return { ok: true, archivos: [...yaEstan], nuevos: [], notaId: reg?.notaId }

    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    let notaId = reg?.notaId || ""
    if (!notaId) {
      const contenido =
        `Planillas generadas desde la configuración que el cliente hizo por chat con Vicky (mismo formato del wizard de auto-onboarding). ` +
        `Adjuntas: ${planillas.map((p) => p.filename).join(" · ")}.\n` +
        `Sirven para cargar usuarios, turnos y planificaciones en la capacitación — el alta por chat NO crea usuarios en la plataforma.` +
        (detalle ? `\n\n${detalle}` : "")
      const r = await fetch(`${API()}/crm/v3/Notes`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ Note_Title: `${TITULO_NOTA_PLANILLAS} · ${empresa || fono}`.slice(0, 120), Note_Content: contenido.slice(0, 60000), Parent_Id: impId, $se_module: "Implementaciones" }],
        }),
      })
      const j = (await r.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
      notaId = j?.data?.[0]?.details?.id || ""
      if (!notaId) return { ok: false, archivos: [...yaEstan], nuevos: [], motivo: `no se pudo crear la nota (${r.status})` }
    }
    const nuevos: string[] = []
    for (const p of pendientes) {
      try {
        const d = await fetch(p.url, { cache: "no-store", signal: AbortSignal.timeout(20_000) })
        if (!d.ok) {
          console.warn(`[imp-planillas] descarga ${p.filename} falló ${d.status}`)
          continue
        }
        const buf = await d.arrayBuffer()
        if (!buf.byteLength) continue
        if (await subirAdjuntoNota(token, notaId, impId, buf, p.filename)) nuevos.push(p.filename)
      } catch (e) {
        console.warn(`[imp-planillas] ${p.filename}:`, e instanceof Error ? e.message : e)
      }
    }
    const archivos = [...new Set([...yaEstan, ...nuevos])]
    await setKvValue(clavePlanillasImp(fono), JSON.stringify({ impId, notaId, archivos } satisfies Registro)).catch(() => {})
    if (nuevos.length) console.log(`[imp-planillas] IMP ${impId}: adjuntos ${nuevos.join(", ")} (nota ${notaId})`)
    return { ok: archivos.length > 0, archivos, nuevos, notaId, motivo: nuevos.length ? undefined : "descarga o subida fallida" }
  } catch (e) {
    console.warn("[imp-planillas] excepción:", e instanceof Error ? e.message : e)
    return { ok: false, archivos: [], nuevos: [], motivo: e instanceof Error ? e.message : String(e) }
  }
}
