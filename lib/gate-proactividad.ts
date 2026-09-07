/**
 * GATE CENTRAL DE PROACTIVIDAD — Fase 2 de la biblia (12-ago-2026).
 *
 * UN solo candado por el que pasa TODO envío de WhatsApp al cliente, instalado
 * en el cuello de botella real (los helpers de lib/botmaker-push-v3.ts, que
 * hasta hoy no validaban nada — el barrido del 12-ago encontró que cada
 * máquina implementaba, o no, sus propios filtros, y de ahí nacen las
 * pisadas: chequeos 9h sobre loops vivos, plantillas duplicadas, envíos
 * fuera de horario, rescates manuales encima de la cadencia).
 *
 * MODO SOMBRA (default): el gate evalúa y REGISTRA lo que habría bloqueado
 * (vic_kv `gatelog_*`, TTL 7 días) pero deja pasar TODO — cero cambio de
 * comportamiento. El encendido real (GATE_ENFORCE=1) es decisión de Lalo con
 * los números de la sombra en la mano (compuerta D3 del plan).
 *
 * Reglas que evalúa (la biblia, sección "Proactividad: una sola máquina"):
 *   1. opt-out / perdido / soporte / rechazo → nunca más proactividad.
 *   2. contacto interno (testContactSet) → la maquinaria no le habla.
 *   3. ventana 9-21 hora local del contacto.
 *   4. anti-ráfaga: otro envío al mismo contacto hace <10 min.
 *   5. anti-repetición: la MISMA plantilla dos veces seguidas al contacto.
 *
 * Qué NO evalúa: envíos REACTIVOS (el cliente habló hace <30 min — es su
 * turno, la conversación manda) y números internos del equipo. El traspaso
 * (presentación) y el chequeo 9h cruzan el gate como toda proactividad: si
 * la sombra muestra que los frenaría mal, se ajusta ANTES de encender.
 *
 * Fail-open TOTAL: cualquier error de red/base deja pasar el envío y no
 * lanza — el gate jamás degrada una conversación (principio 24-jul).
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""

const RAFAGA_MIN = Number(process.env.GATE_RAFAGA_MIN || 10)
const REACTIVO_MIN = Number(process.env.GATE_REACTIVO_MIN || 30)

/**
 * Sello del anti-repetición de plantillas (31-ago): lo llama el push DESPUÉS
 * de que Botmaker aceptó el envío. Solo un envío que salió de verdad quema la
 * plantilla para ese contacto (48 h); un intento fallido puede reintentarse.
 */
export async function sellarPlantillaEnviada(contact: string, plantilla: string): Promise<void> {
  const clean = String(contact || "").replace(/\D/g, "")
  if (!clean || !plantilla) return
  // TTL 20h, no 48 (31-ago, caso SOUTH TRADE): la cadencia post-aceptación
  // manda la MISMA plantilla (vicky_loop_pago) a +60min, +24h y +72h — con
  // 48h de marca, el toque de las 24h moría SIEMPRE en plantilla_repetida.
  // 20h sigue atrapando el duplicado real (dos máquinas el mismo día) sin
  // pisar una cadencia diaria legítima; la ráfaga corta la cubre gate_last_.
  await supa(`vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        key: `gate_tpl_${clean}`,
        value: plantilla,
        expires_at: new Date(Date.now() + 20 * 3600e3).toISOString(),
      },
    ]),
  }).catch(() => undefined)
}

export type GateDecision = {
  /** true = el envío procede (en sombra SIEMPRE true). */
  permitir: boolean
  /** Lo que el gate habría bloqueado (vacío = envío limpio). */
  motivos: string[]
  /** true = evaluado como turno reactivo (exento de reglas de proactividad). */
  reactivo: boolean
}

function enforceActivo(): boolean {
  return (process.env.GATE_ENFORCE || "").trim() === "1"
}

/**
 * ENCENDIDO del gate (Lalo 29-ago, cierre de la lista de Rodrigo): env
 * GATE_ENFORCE=1 o vic_kv `gate_enforce`="on" (apagable sin deploy). Los
 * PROBADORES internos (metricsContactSet: Lalo/Rodrigo) quedan exentos del
 * bloqueo — para ellos el gate sigue en sombra y las pruebas no se frenan.
 */
async function enforceEncendido(): Promise<boolean> {
  if (enforceActivo()) return true
  try {
    const rows = (await supa(`vic_kv?key=eq.gate_enforce&select=value&limit=1`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as Array<{ value?: string }>
    return String(rows[0]?.value || "").trim() === "on"
  } catch {
    return false
  }
}

function gateApagado(): boolean {
  return (process.env.GATE_PROACTIVIDAD_OFF || "").trim() === "1"
}

async function supa(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
}

/** Hora local 9-21 del contacto por prefijo discable (56/57/52/51). */
function enVentanaHoraria(contact: string): boolean {
  const d = contact.replace(/\D/g, "")
  const tz = d.startsWith("57")
    ? "America/Bogota"
    : d.startsWith("52")
      ? "America/Mexico_City"
      : d.startsWith("51")
        ? "America/Lima"
        : "America/Santiago"
  try {
    const h = Number(
      new Intl.DateTimeFormat("es-CL", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()),
    )
    return h >= 9 && h < 21
  } catch {
    return true
  }
}

/**
 * Evalúa el gate para un envío al cliente. En sombra devuelve permitir=true
 * SIEMPRE y registra los motivos; con GATE_ENFORCE=1 devuelve permitir=false
 * cuando hay motivos (y el helper no envía).
 */
export async function evaluarGateProactividad(
  contact: string,
  opts: {
    tipo: "texto" | "plantilla" | "media"
    plantilla?: string
    /**
     * Envío TRANSACCIONAL (07-sep, caso TESLA AUSTRAL): el cliente acaba de
     * PAGAR y el mensaje es la consecuencia directa de su acción (bienvenida
     * post-pago, formulario de alta). No es proactividad comercial: el gate
     * lo registra (sello + bitácora) pero JAMÁS lo bloquea. Sin esto, el
     * anti-ráfaga bloqueó 3 veces el formulario de alta porque la
     * presentación del traspaso había salido 8 minutos antes, y un cliente
     * que pagó se quedó sin su cuenta hasta que alguien lo re-disparó a mano.
     */
    transaccional?: boolean
  } = { tipo: "texto" },
): Promise<GateDecision> {
  const pasa: GateDecision = { permitir: true, motivos: [], reactivo: false }
  if (gateApagado()) return pasa
  const clean = (contact || "").replace(/\D/g, "")
  // Solo teléfonos de cliente discables; internos e IDs anónimos pasan de largo.
  if (!/^(56|57|52|51)\d{8,12}$/.test(clean)) return pasa
  // Números internos de aviso del equipo: no son clientes, el gate no opina.
  const internos = new Set(
    [process.env.QUOTE_NOTIFY_TO, process.env.VICKY_REPORT_PHONE]
      .map((n) => (n || "").trim().replace(/\D/g, ""))
      .filter(Boolean),
  )
  if (internos.has(clean)) return pasa
  if (!SUPABASE_URL || !SUPABASE_KEY) return pasa

  try {
    const { isTestContact, testContactSet } = await import("./funnel-analysis")
    const motivos: string[] = []

    // Conversación: ¿turno reactivo? ¿cerrada por opt-out/perdido?
    const conv = (await supa(
      `vic_v3_conversations?contact=eq.${clean}&select=last_user_at,followup_closed_reason&limit=1`,
    )
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as Array<{ last_user_at?: string | null; followup_closed_reason?: string | null }>
    const lastUserMs = conv[0]?.last_user_at ? new Date(conv[0].last_user_at).getTime() : 0
    if (lastUserMs && Date.now() - lastUserMs < REACTIVO_MIN * 60e3) {
      // El cliente habló hace poco: es su turno — el gate no opina.
      return { permitir: true, motivos: [], reactivo: true }
    }

    const reason = String(conv[0]?.followup_closed_reason || "")
    if (["opt_out", "perdido", "soporte", "rechazo"].includes(reason)) {
      motivos.push(`cerrado_${reason}`)
    }

    if (isTestContact(clean, testContactSet())) motivos.push("contacto_interno")
    if (!enVentanaHoraria(clean)) motivos.push("fuera_de_9_21")

    // Anti-ráfaga y anti-repetición (kv propios del gate, TTL corto).
    const kvRows = (await supa(
      `vic_kv?key=in.("gate_last_${clean}","gate_tpl_${clean}")&select=key,value,expires_at`,
    )
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as Array<{ key: string; value: string; expires_at?: string | null }>
    const vivo = (k: string) => {
      const row = kvRows.find((r) => r.key === k)
      if (!row) return null
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null
      return row.value
    }
    const ultimoEnvio = Number(vivo(`gate_last_${clean}`) || 0)
    // Anti-ráfaga con excepción de TURNO (hallazgo de la sombra 13-ago): las
    // burbujas de una misma respuesta salen con segundos de diferencia y no
    // son ráfaga — solo cuenta como pisada un envío entre 90s y 10 min del
    // anterior (dos máquinas distintas tocando al mismo contacto).
    const delta = ultimoEnvio ? Date.now() - ultimoEnvio : 0
    if (ultimoEnvio && delta > 90e3 && delta < RAFAGA_MIN * 60e3) motivos.push("rafaga_10min")
    if (opts.tipo === "plantilla" && opts.plantilla && vivo(`gate_tpl_${clean}`) === opts.plantilla) {
      motivos.push("plantilla_repetida")
    }

    // Sello del envío (se estampa SIEMPRE que el envío vaya a salir — en
    // sombra todo sale, así que se estampa acá; con enforce, solo si pasa).
    // Probadores internos (Lalo/Rodrigo, metricsContactSet): jamás se les
    // bloquea — sus pruebas necesitan ráfagas que a un cliente real no le
    // haríamos. Para ellos el gate queda en sombra permanente.
    const { metricsContactSet } = await import("./funnel-analysis")
    const esProbadorInterno = isTestContact(clean, metricsContactSet())
    const bloquear = !esProbadorInterno && !opts.transaccional && (await enforceEncendido()) && motivos.length > 0
    if (!bloquear) {
      void supa(`vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([
          {
            key: `gate_last_${clean}`,
            value: String(Date.now()),
            expires_at: new Date(Date.now() + 2 * 3600e3).toISOString(),
          },
          // OJO (31-ago, caso de los 8 leads regalados): la marca de plantilla
          // ya NO se estampa acá — estampar al EVALUAR condenaba por 48h a
          // todo envío que después fallara (la marca quedaba y cada reintento
          // moría en plantilla_repetida). Ahora la estampa el push cuando el
          // envío efectivamente SALIÓ (sellarPlantillaEnviada, llamada desde
          // sendBotmakerTemplate).
        ]),
      }).catch(() => undefined)
    }

    // Registro de sombra: solo cuando HAY motivos (los envíos limpios no
    // interesan y el volumen se mantiene chico).
    if (motivos.length > 0) {
      void supa(`vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: `gatelog_${Date.now()}_${clean}`,
          value: JSON.stringify({
            c: clean,
            tipo: opts.tipo,
            tpl: opts.plantilla || undefined,
            motivos,
            enforce: bloquear,
            probador: esProbadorInterno || undefined,
            transaccional: opts.transaccional || undefined,
            at: new Date().toISOString(),
          }),
          expires_at: new Date(Date.now() + 7 * 86400e3).toISOString(),
        }),
      }).catch(() => undefined)
      console.warn(
        `[gate-proactividad] ${clean} (${opts.tipo}${opts.plantilla ? `:${opts.plantilla}` : ""}) → ${
          bloquear ? "BLOQUEADO" : opts.transaccional ? "transaccional, pasa" : "sombra"
        }: ${motivos.join(", ")}`,
      )
    }

    return { permitir: !bloquear, motivos, reactivo: false }
  } catch {
    return pasa // fail-open: el gate jamás tumba un envío por error propio
  }
}
