/**
 * DESPACHADOR DE CRONES HUÉRFANOS (Lalo 10-ago, "arréglalo").
 *
 * Diagnóstico del 10-ago: `vic-espejo-notas-cron` (creado el 06-ago) nunca se
 * ejecutó. Prueba: al dispararlo a mano creó 64 notas atrasadas de una sola
 * vez, y en 3 horas de logs de Vercel aparece UNA invocación — la mía.
 * `vic-mudos-cron` (creado hoy) está igual. Los dos están declarados en
 * vercel.json, pero el cron scheduler de Vercel corre contra el deployment de
 * PRODUCCIÓN, que en este proyecto es la rama vieja `master`: ahí esos
 * endpoints no existen. Los crones que SÍ laten (callback, loop, ptv,
 * reactivation) los dispara un scheduler externo que apunta al alias de
 * vicky-v3 — y a ese scheduler nadie le agregó los dos nuevos.
 *
 * En vez de depender de que alguien registre cada endpoint nuevo a mano, los
 * crones huérfanos los despacha un cron que SÍ corre: `vic-ptv-cron` (cada 10
 * minutos, verificado en los logs). Cada job lleva su propia cadencia en
 * vic_kv (`huerfano_<nombre>`), se marca ANTES de disparar (dos ticks
 * solapados no lo mandan dos veces) y el disparo es best-effort con timeout
 * corto: la invocación remota es otra función, así que basta con que la
 * petición SALGA — este cron jamás espera a que el otro termine ni se cae si
 * el otro falla.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

/** Endpoints declarados en vercel.json que el scheduler real no dispara. */
export const JOBS_HUERFANOS: Array<{ nombre: string; path: string; cadaMin: number }> = [
  { nombre: "espejo_notas", path: "/api/vic-espejo-notas-cron", cadaMin: 15 },
  { nombre: "mudos", path: "/api/vic-mudos-cron", cadaMin: 30 },
  // (El followup viejo se ELIMINÓ en la demolición de la biblia, 12-ago.)
  { nombre: "outbound", path: "/api/vic-outbound-cadence-cron", cadaMin: 15 },
  // BARRIDO ACELERADO (Lalo 10-ago, "necesito que sea más instantáneo"): los
  // relojes de toques y traspasos son exactos, pero la entrega esperaba el
  // tick externo (loop cada 5', ptv cada 10') — un traspaso de 15' llegaba al
  // minuto 15-25. Ahora vic-callback-cron (cada ~2') también los despacha,
  // con cadencia propia de 2 minutos; el solape con la agenda externa lo
  // resuelve el candado de turno (lib/cron-lock) dentro de cada cron.
  { nombre: "loop_rapido", path: "/api/vic-loop-cron", cadaMin: 2 },
  { nombre: "ptv_rapido", path: "/api/vic-ptv-cron", cadaMin: 2 },
  // Reconciliación CRM por hitos (declarado en vercel.json "15 * * * *" desde
  // el 30-jul pero JAMÁS corrió — scheduler de Vercel muerto y nadie lo agregó
  // acá; detectado 18-ago: al dispararlo a mano sincronizó un preform
  // pendiente). Ventana interna de 2h → la cadencia horaria le sobra.
  { nombre: "crm_hitos", path: "/api/vic-crm-hitos-cron", cadaMin: 60 },
  // Auditoría de tómbolas (Lalo 18-ago): compara la regla de asignación
  // definida vs la que Zoho ejecutó (timeline) y marca casos borde para la
  // pestaña vista=tombolas del dash. Lee ~25 timelines por tick.
  { nombre: "tombola_audit", path: "/api/vic-tombola-audit-cron", cadaMin: 120 },
  // Foto horaria del dash (Lalo 19-ago): regenera las páginas precalculadas
  // (principal + inbound) para que la carga humana sea instantánea.
  { nombre: "dash_snap", path: "/api/vic-dash-snap-cron", cadaMin: 60 },
  // Limpieza/reconciliación de deals (Lalo 20-ago): Amount = recurrente neto
  // de la cotización, pago ⇒ stage ≥ 6, dueño cotización = dueño deal,
  // punteros. Candado semanal por deal → cada tick toca solo lo pendiente.
  { nombre: "deal_limpieza", path: "/api/vic-admin-deal-limpieza?limit=25", cadaMin: 180 },
  // Tareas y llamadas del workflow que quedaron a nombre del robot mientras su
  // lead o trato ya tiene dueño humano (Lalo 29-ago). El traspaso ya las
  // arrastra; esto barre lo arrastrado y los caminos que no pasan por las
  // tómbolas de leads (la Tómbola de Deals, entre otros).
  { nombre: "pendientes_robot", path: "/api/vic-admin-pendientes-robot", cadaMin: 120 },
  // Gestión Vicky en deals de hito sin cotización y en LEADS de Vicky sin
  // convertir (20-ago): mismos veredictos, teléfono del contacto/lead.
  { nombre: "deal_limpieza_hitos", path: "/api/vic-admin-deal-limpieza?gestionhitos=1&limit=15", cadaMin: 360 },
  { nombre: "deal_limpieza_leads", path: "/api/vic-admin-deal-limpieza?gestionleads=1&limit=15", cadaMin: 360 },
  { nombre: "deal_limpieza_origen", path: "/api/vic-admin-deal-limpieza?origen=1&limit=15", cadaMin: 360 },
  // Lector de media del espejo (Lalo 21-ago, "que los chats espejos puedan
  // leer los mismos medios que Vicky"): transcribe audios y describe
  // imágenes/PDF de los WhatsApp de vendedores — los comprobantes por foto
  // dejan de ser invisibles.
  { nombre: "espejo_media", path: "/api/vic-espejo-media-cron?limit=8", cadaMin: 15 },
  // Etapas de deals (pagada→6, onboarding completado→7 Implementando): su
  // "cada hora por Vercel Cron" es el scheduler muerto — garantizado acá.
  { nombre: "deal_stage", path: "/api/vic-deal-stage-cron", cadaMin: 60 },
  // Vigía del auto-onboarding (Lalo 24-ago, caso Bersa/IMP-11175): onboarding
  // "Completado" sin planillas/implementación → re-dispara el cierre al
  // wizard/Zoho Flow (candado 6h por registro, máx 3 intentos).
  { nombre: "ob_vigia", path: "/api/vic-onboarding-vigia", cadaMin: 30 },
  // Cierre diario (Lalo 02-sep, "el dash de mejoras y el correo programado
  // diario"): calcula la foto del día anterior, la deja en vic_kv
  // `foto_dia_<fecha>` (fuente única del panel) y manda el correo. El propio
  // endpoint tiene la ventana 07-10 CL y el candado `cierre_enviado_<fecha>`,
  // así que despacharlo cada 30' solo significa "que no se le pase la hora".
  { nombre: "cierre_diario", path: "/api/vic-cierre-diario?enviar=1", cadaMin: 30 },
  // Vigía del onboarding por chat (Lalo 05-sep, punto 8): el cliente que
  // paga y se calla recibe un toque de Vicky (alta pendiente a las 2 h,
  // capacitación a las 24 h hábiles, nómina el día antes del curso) y el
  // equipo un aviso cuando tampoco eso alcanza. Caso Maquinarias Santa Sara.
  { nombre: "onboarding_toques", path: "/api/vic-onboarding-toques", cadaMin: 30 },
  // NDV confirmada → Implementación del alta por chat (Lalo 07-sep: "la NDV
  // la confirmamos nosotros antes de crear la implementación"). El job nace
  // en el alta y se intenta una vez en línea; acá se empuja cada ~2' hasta
  // que la nota esté confirmada y la implementación enlazada (lib/ndv-alta).
  { nombre: "onb_ndv_imp", path: "/api/vic-onboarding-ndv-imp", cadaMin: 2 },
]

/**
 * Margen = medio tick del cron que despacha (ptv corre cada 10'). Sin él, una
 * cadencia de 15' solo se cumpliría en el tick de los 20' (el de los 10' aún
 * no llega al umbral) y las notas quedarían el doble de viejas. Con 5' de
 * margen, un job de 15' se dispara en el tick de los 10'.
 */
const TOLERANCIA_MS = 5 * 60_000

/** La tolerancia jamás puede superar media cadencia: con jobs de 2-3 minutos,
 * los 5' fijos los harían dispararse en TODOS los ticks. */
function toleranciaDe(cadaMin: number): number {
  return Math.min(TOLERANCIA_MS, (cadaMin * 60_000) / 2)
}

function h(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  }
}

function baseUrl(): string {
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim()
  const actual = (process.env.VERCEL_URL || "").trim()
  // OJO: VERCEL_PROJECT_PRODUCTION_URL apunta al deployment de master viejo,
  // donde estos endpoints no existen. Se usa el deployment ACTUAL (el que
  // está corriendo este cron) — es el de vicky-v3 por construcción.
  if (actual) return `https://${actual}`
  if (prod) return `https://${prod}`
  return "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
}

async function ultimaCorrida(nombre: string): Promise<number> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`huerfano_${nombre}`)}&select=value&limit=1`,
      { headers: h(), cache: "no-store" },
    )
    if (!r.ok) return 0
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string }>
    const t = Date.parse(String(rows[0]?.value || ""))
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

async function marcarCorrida(nombre: string, iso: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...h(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: `huerfano_${nombre}`, value: iso }),
    cache: "no-store",
  }).catch(() => undefined)
}

/**
 * Despacha los crones huérfanos que ya cumplieron su cadencia. Devuelve los
 * nombres disparados en este tick. Nunca lanza: es un pasajero del tick de
 * otro cron y no puede tumbarlo.
 */
export async function despacharHuerfanos(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const ahora = Date.now()
  const iso = new Date(ahora).toISOString()
  const disparados: string[] = []
  for (const job of JOBS_HUERFANOS) {
    try {
      const ultima = await ultimaCorrida(job.nombre)
      if (ultima && ahora - ultima < job.cadaMin * 60_000 - toleranciaDe(job.cadaMin)) continue
      // Marcar ANTES de disparar: si el disparo se pierde, se reintenta en el
      // siguiente ciclo; si se marcara después, dos ticks solapados lo
      // mandarían dos veces (notas duplicadas, correos duplicados).
      await marcarCorrida(job.nombre, iso)
      const url = `${baseUrl()}${job.path}${job.path.includes("?") ? "&" : "?"}key=${encodeURIComponent(CRON_SECRET)}`
      const ctrl = new AbortController()
      const corte = setTimeout(() => ctrl.abort(), 5000)
      await fetch(url, {
        headers: { Authorization: `Bearer ${CRON_SECRET}`, "x-cron-secret": CRON_SECRET },
        cache: "no-store",
        signal: ctrl.signal,
      })
        .catch(() => undefined) // abort esperado: la invocación remota sigue viva
        .finally(() => clearTimeout(corte))
      disparados.push(job.nombre)
    } catch {
      /* best-effort: el siguiente tick reintenta */
    }
  }
  if (disparados.length) console.log(`[huerfanos] despachados: ${disparados.join(", ")}`)
  return disparados
}
