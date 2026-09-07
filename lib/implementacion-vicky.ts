/**
 * IMPLEMENTACIÓN AUTOMÁTICA DEL ALTA POR CHAT (Lalo, 03-sep).
 *
 * "La empresa se crea automáticamente y además se desprende una
 * implementación. Creémosla nosotros, no por Zoho Flow: no habrá duplicidad
 * porque en este caso no hay wizard de auto-onboarding."
 *
 * DOS CAMINOS QUE NO SE PISAN. Las ventas que pasan por el WIZARD generan su
 * implementación desde el Zoho Flow, nacen como `GV Portal` y se reparten
 * solas entre el equipo de ese pipeline (Ortega / González / Bahamondes).
 * El alta POR CHAT no pasa por el wizard, así que ahí no nace nada: esta
 * función llena ese hueco creando la implementación `GV Avanzado`, que es la
 * que llevan Diego Alegre e Ignacio Salinas.
 *
 * TÓMBOLA. Las 11 GV Avanzado del mes se crearon a mano y quedaron 8 para
 * Ignacio y 3 para Diego. Acá se reparten por turno alternado en vic_kv.
 * OJO con la cuenta de Ignacio: `productmanager@geovictoria.pro` es
 * COMPARTIDA y hace de default del módulo, así que el Owner por sí solo no
 * distingue "le tocó a Ignacio" de "no la tomó nadie". Por eso se escribe
 * SIEMPRE `Jefe_de_Proyectos` + `Correo_Jefe_de_Proyectos`: ese par es lo que
 * hace la asignación legible, y es justo lo que hoy el humano pone a mano.
 *
 * Todo best-effort: si Zoho falla, el alta de la empresa NO se cae — el
 * cliente ya pagó y ya tiene su cuenta. Queda aviso interno para crearla a
 * mano.
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

/** Relatores de GV Avanzado. La cuenta de Ignacio es compartida a propósito. */
export const RELATORES_GV_AVANZADO = [
  { nombre: "Diego Alegre", email: "dalegre@geovictoria.com", zohoId: "3525045000451232212" },
  // OJO (05-sep, prueba E1): el id que estaba acá, 3525045000440597415, es el
  // usuario "Product Manager" (productmanager@geovictoria.pro, la cuenta
  // COMPARTIDA). Por eso las implementaciones "de Ignacio" caían ahí aunque el
  // PUT del Owner respondiera ok. El id real de Ignacio sale de sus propias
  // implementaciones (IMP-11320, Owner "Ignacio Salinas").
  { nombre: "Ignacio Salinas", email: "isalinas@geovictoria.com", zohoId: "3525045000655559002" },
] as const

/** Turno alternado, persistido — sobrevive a los reinicios de instancia. */
export async function siguienteRelator(): Promise<(typeof RELATORES_GV_AVANZADO)[number]> {
  try {
    const raw = (await getKvValue("tombola_implementacion_rr")) || ""
    const idx = (Number(raw) || 0) % RELATORES_GV_AVANZADO.length
    await setKvValue("tombola_implementacion_rr", String(idx + 1)).catch(() => {})
    return RELATORES_GV_AVANZADO[idx]
  } catch {
    return RELATORES_GV_AVANZADO[0]
  }
}

/**
 * LO QUE LA VENTA YA SABE Y LA IMPLEMENTACIÓN NO RECIBÍA (05-sep, brecha
 * medida contra las 12 GV Avanzado humanas de ago-sep): Cliente, Contacto,
 * Ej. Comercial y Cantidad de usuarios los llenan 12 de 12; la nuestra nacía
 * con los cuatro vacíos aunque el puntero de cotización del contacto tiene
 * la cuenta, el contacto y el deal, y el deal tiene dueño y dotación. Y
 * `Correo_solicitante` llevaba el correo del COMPRADOR: en las humanas es el
 * del ejecutivo que pidió la implementación. Best-effort: si Zoho no
 * responde, la implementación nace igual, solo más pobre.
 */
export async function contextoImplementacionDesdeVenta(contact: string): Promise<Partial<DatosImplementacion>> {
  const out: Partial<DatosImplementacion> = {}
  try {
    const { getQuotePointers } = await import("./supabase-persistence-v3")
    const punteros = await getQuotePointers((contact || "").replace(/\D/g, "")).catch(() => [])
    const p = punteros.find((x) => (x.quoteId || "").trim())
    if (!p) return out
    out.quoteId = p.quoteId
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}` }
    const modulo = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const rq = await fetch(`${API()}/crm/v3/${modulo}/${p.quoteId}?fields=Cuenta_Asociada,Contacto_Asociado,Deal_Asociado,Owner,Detalle_Items_Cotizacion`, { headers: H, cache: "no-store" })
    const q = ((await rq.json().catch(() => ({}))) as {
      data?: Array<{
        Cuenta_Asociada?: { id?: string }
        Contacto_Asociado?: { id?: string }
        Deal_Asociado?: { id?: string }
        Owner?: { id?: string; email?: string }
        Detalle_Items_Cotizacion?: Array<{
          Codigo_Item?: string | null
          Categoria_Item?: string | null
          Cantidad?: number | null
          Es_Recurrente?: boolean | null
          Subtotal_CLP?: number | null
        }>
      }>
    }).data?.[0]
    // Método de marcaje y cantidad de relojes: las GV Avanzado humanas llenan
    // M_doto_Marcaje (APP/Box/WEB/Call) y Cantidad_de_equipos cuando hay reloj
    // (12 de 12 revisadas 05-sep); la nuestra nacía muda y el relator no sabía
    // que venían 2 relojes con instalación técnica (caso E7). Se deriva de las
    // líneas de la cotización: equipos biométricos (sin accesorios) → Box.
    const filas = Array.isArray(q?.Detalle_Items_Cotizacion) ? q.Detalle_Items_Cotizacion : []
    const relojes = filas
      .filter((f) => /equipos biom/i.test(String(f.Categoria_Item || "")) && !/tarjeta/i.test(String(f.Codigo_Item || "")))
      .reduce((acc, f) => acc + Math.max(0, Number(f.Cantidad) || 0), 0)
    if (filas.length) {
      out.metodoMarcaje = relojes > 0 ? ["APP", "Box"] : ["APP"]
      // 0 explícito cuando no hay reloj: las humanas escriben Cantidad_de_equipos
      // aunque sea 0 (brecha medida 07-sep contra 12 GV Avanzado).
      out.equipos = relojes
      // Facturación mensual del cliente en CLP NETO = suma de las líneas
      // recurrentes de la cotización pagada (plan + arriendos). Es lo que las
      // humanas escriben en Facturaci_n_Cliente (10 de 12), con moneda CLP.
      const mensualClp = filas
        .filter((f) => f.Es_Recurrente === true)
        .reduce((acc, f) => acc + Math.max(0, Number(f.Subtotal_CLP) || 0), 0)
      if (mensualClp > 0) out.facturacionMensualClp = Math.round(mensualClp)
    }
    if (q?.Cuenta_Asociada?.id) out.accountId = String(q.Cuenta_Asociada.id)
    if (q?.Contacto_Asociado?.id) out.contactId = String(q.Contacto_Asociado.id)
    const dealId = String(q?.Deal_Asociado?.id || p.dealId || "")
    let owner = q?.Owner
    if (dealId) {
      out.dealId = dealId
      const rd = await fetch(`${API()}/crm/v3/Deals/${dealId}?fields=Owner,N_Empleados_que_marcan`, { headers: H, cache: "no-store" })
      const d = ((await rd.json().catch(() => ({}))) as {
        data?: Array<{ Owner?: { id?: string; email?: string }; N_Empleados_que_marcan?: number | string }>
      }).data?.[0]
      if (d?.Owner?.id) owner = d.Owner
      const n = Number(d?.N_Empleados_que_marcan)
      if (Number.isFinite(n) && n > 0) out.usuarios = n
    }
    const correo = String(owner?.email || "").toLowerCase()
    const esRobot = !correo || /vicky@|info@geovictoria/.test(correo)
    // Ej. Comercial solo si es una persona; el robot no es un ejecutivo.
    if (owner?.id && !esRobot) out.ejComercialId = String(owner.id)
    out.correoSolicitante = esRobot ? "vicky@geovictoria.com" : correo
  } catch (e) {
    console.warn("[implementacion] contexto desde la venta falló:", e instanceof Error ? e.message : e)
  }
  return out
}

export type DatosImplementacion = {
  razonSocial: string
  rut?: string
  accountId?: string
  contactId?: string
  dealId?: string
  quoteId?: string
  ndvId?: string
  usuarios?: number
  equipos?: number
  metodoMarcaje?: string[]
  correoSolicitante?: string
  ejComercialId?: string
  comentarios?: string
  /** Id de la empresa en la plataforma (GV Avanzado), el que devolvió la API del alta. */
  companyId?: string
  /** Facturación mensual del cliente, CLP neto (suma de recurrentes de la cotización pagada). */
  facturacionMensualClp?: number
  /** Se_debe_planificar_turnos_GV: "Sí" (default humano, 11/12) o "No sé". */
  planificaTurnos?: "Sí" | "No sé"
  /** Tipo_de_Planificaci_n: "Fijo" si el chat dejó planificaciones; si no, "Desconocido". */
  tipoPlanificacion?: "Fijo" | "Desconocido"
}

/**
 * BRECHAS DE CREACIÓN (07-sep, tabla contra 12 GV Avanzado humanas — artifact
 * 5956710a): las humanas escriben al crear, además de lo anterior, turnos /
 * tipo de planificación / semáforo Verde / facturación mensual CLP + moneda /
 * cantidad de equipos aunque sea 0. La de Vicky nacía sin los seis y el
 * Score_Proyecto quedaba en 5 contra 11. Orden de Lalo: "cierra la brecha y
 * déjalo implementado para las siguientes".
 */
export function camposBrechaCreacion(d: Pick<DatosImplementacion, "equipos" | "facturacionMensualClp" | "planificaTurnos" | "tipoPlanificacion">): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Se_debe_planificar_turnos_GV: d.planificaTurnos || "Sí",
    Tipo_de_Planificaci_n: d.tipoPlanificacion || "Desconocido",
    Sem_foro_Implementaci_n: "Verde",
    Cantidad_de_equipos: typeof d.equipos === "number" ? d.equipos : 0,
  }
  if (typeof d.facturacionMensualClp === "number" && d.facturacionMensualClp > 0) {
    out.Facturaci_n_Cliente = d.facturacionMensualClp
    out.Moneda_Facturaci_n_Futura = "CLP"
  }
  return out
}

/**
 * Completa en una implementación YA creada los campos de creación que estén
 * vacíos (retroactivo: IMP-11424 TESLA, IMP-11428 Molinas). No pisa nada que
 * un humano haya escrito. Devuelve qué escribió.
 */
export async function completarBrechasCreacion(
  implementacionId: string,
  contact: string,
): Promise<{ ok: boolean; escritos: string[]; error?: string }> {
  try {
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const campos = "Se_debe_planificar_turnos_GV,Tipo_de_Planificaci_n,Sem_foro_Implementaci_n,Facturaci_n_Cliente,Moneda_Facturaci_n_Futura,Cantidad_de_equipos,Tiene_Hardware"
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}?fields=${campos}`, { headers: H, cache: "no-store" })
    const actual = ((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0] || {}
    const ctx = await contextoImplementacionDesdeVenta(contact)
    let planificaTurnos: "Sí" | "No sé" | undefined
    let tipoPlanificacion: "Fijo" | "Desconocido" | undefined
    try {
      const { claveConfiguracion } = await import("./onboarding/fase")
      const raw = await getKvValue(claveConfiguracion((contact || "").replace(/\D/g, "")))
      const cfg = raw ? (JSON.parse(raw) as { planificaciones?: unknown[] }) : null
      if (Array.isArray(cfg?.planificaciones) && cfg!.planificaciones!.length > 0) {
        planificaTurnos = "Sí"
        tipoPlanificacion = "Fijo"
      }
    } catch {
      /* sin config: defaults */
    }
    const propuestos = camposBrechaCreacion({
      equipos: ctx.equipos,
      facturacionMensualClp: ctx.facturacionMensualClp,
      planificaTurnos,
      tipoPlanificacion,
    })
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(propuestos)) {
      const vigente = actual[k]
      const vacio = vigente === null || vigente === undefined || vigente === ""
      if (vacio) data[k] = v
    }
    if (typeof ctx.equipos === "number" && (actual.Tiene_Hardware === null || actual.Tiene_Hardware === undefined)) {
      data.Tiene_Hardware = ctx.equipos > 0
    }
    if (!Object.keys(data).length) return { ok: true, escritos: [] }
    const put = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [data], trigger: ["blueprint"] }),
    })
    if (!put.ok) {
      const cuerpo = await put.text().catch(() => "")
      return { ok: false, escritos: [], error: `${put.status} ${cuerpo.slice(0, 300)}` }
    }
    return { ok: true, escritos: Object.keys(data) }
  } catch (e) {
    return { ok: false, escritos: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Crea la implementación en Zoho. Devuelve el id, o "" si no se pudo (el
 * llamador avisa al equipo, nunca rompe el alta).
 *
 * Los campos son los que el humano llena AL CREAR (verificados contra
 * IMP-11320); todo lo de ejecución —fechas y relatores de capacitación,
 * semáforo, avances, `Confirmo_Creación_Empresa`— se llena DESPUÉS y va nulo.
 */
export async function crearImplementacionGvAvanzado(
  d: DatosImplementacion,
): Promise<{ id: string; numero?: string; relator: { nombre: string; email: string } } | null> {
  if (!d.razonSocial) return null
  const relator = await siguienteRelator()
  const registro: Record<string, unknown> = {
    Name: `ASISTENCIA - ${d.razonSocial}`.slice(0, 120),
    Plataforma: "GV Avanzado",
    // Sin partner (Lalo 07-sep, caso Maquinarias): el picklist trae "Nubox"
    // como valor por defecto y toda implementación creada por API nacía como
    // si viniera de ese partner. Se manda explícitamente vacío.
    Partner_Account: null,
    Tipo_de_Ingreso: "Telemarketing",
    Tipo_de_Cliente: "SMB",
    Tipo_de_Implementaci_n: "Standard",
    Servicios_a_Impementar: ["Asistencia"],
    Pa_s: "Chile",
    Territorio_Cliente: "Chile",
    Es_un_ingreso_nuevo: "Sí",
    Se_debe_realizar_capacitaci_n: "Sí",
    // El alta por chat crea la empresa en la plataforma en el mismo acto, así
    // que esto ya está resuelto cuando nace la implementación.
    Se_debe_crear_empresa: "No",
    // OJO: el Owner NO se puede fijar al CREAR — un workflow del módulo lo
    // pisa y todo cae en la cuenta compartida (verificado 03-sep: IMP-11377
    // nació con Owner=Diego en el payload y quedó en productmanager@). Se
    // asigna en un PUT posterior con trigger ["blueprint"], que sí lo
    // respeta. Por eso las 8 implementaciones "de Ignacio" del mes están en
    // esa cuenta: no se las asignaron, el workflow las mandó ahí.
    Jefe_de_Proyectos: relator.nombre,
    Correo_Jefe_de_Proyectos: relator.email,
  }
  // RUT_Empresa_Account NO se escribe: es derivado de la Cuenta (probado
  // 03-sep, quedó null aunque se mandara). Llega solo al asociar el Cliente.
  if (d.accountId) registro.Cliente = { id: d.accountId }
  if (d.contactId) registro.Contacto = { id: d.contactId }
  if (d.ndvId) registro.Nota_de_Venta_Asociada = { id: d.ndvId }
  if (d.usuarios && d.usuarios > 0) registro.Cantidad_de_Usuarios_a_Implementar = d.usuarios
  // Turnos / tipo de planificación / semáforo / facturación CLP / equipos (0
  // incluido): lo que las humanas escriben al crear y la nuestra no traía.
  Object.assign(registro, camposBrechaCreacion(d))
  registro.Tiene_Hardware = (typeof d.equipos === "number" ? d.equipos : 0) > 0
  if (d.metodoMarcaje?.length) registro.M_doto_Marcaje = d.metodoMarcaje
  if (d.correoSolicitante) registro.Correo_solicitante = d.correoSolicitante
  if (d.ejComercialId) registro.Ej_Comercial = { id: d.ejComercialId }
  registro.Comentarios = d.comentarios || "Alta creada por Vicky (chat, sin wizard). Empresa ya creada en la plataforma."
  // ID de la empresa en GV Avanzado (Lalo 05-sep): es el dato que después
  // necesitan la nota de venta ("Creada en Plataforma" + NOMBRE-RUT-ID) y
  // facturación. Numeración de la plataforma NUEVA — no confundir con el
  // Id_Empresa de "Empresas en GeoVictoria", que es de la plataforma antigua.
  if (d.companyId && /^\d+$/.test(String(d.companyId))) registro.ID_Empresa_GV = String(d.companyId)

  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${API()}/crm/v3/Implementaciones`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      // trigger con blueprint: sin él los registros quedan desenganchados de
      // la banda de etapas (regla del 21-ago, reclamo de Aleydis).
      body: JSON.stringify({ data: [registro], trigger: ["workflow", "blueprint"] }),
    })
    const body = (await r.json().catch(() => ({}))) as {
      data?: Array<{ code?: string; details?: { id?: string }; message?: string }>
    }
    const fila = body?.data?.[0]
    if (!r.ok || fila?.code !== "SUCCESS" || !fila?.details?.id) {
      console.warn(`[implementacion] no se creó: ${JSON.stringify(body).slice(0, 300)}`)
      return null
    }
    // Segundo paso: el dueño. Sin esto la tómbola no se ve en el Owner y todo
    // queda con cara de "sin asignar".
    const dueno = await fetch(`${API()}/crm/v3/Implementaciones/${fila.details.id}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ Owner: { id: relator.zohoId } }],
        trigger: ["blueprint"],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    }).catch(() => null)
    if (!dueno?.ok) {
      console.warn(`[implementacion] ${fila.details.id}: no se pudo asignar a ${relator.email} — queda en la cuenta compartida`)
    }
    // El NÚMERO (IMP-xxxxx) lo genera Zoho al crear y no viene en la
    // respuesta: hay que releerlo. Lo necesita el formulario de Bookings, que
    // exige "Numero de implementacion" como campo obligatorio — sin él la
    // reserva de la capacitación se rechaza. Best-effort: si la relectura
    // falla, la implementación igual quedó creada.
    let numero = ""
    try {
      const rr = await fetch(`${API()}/crm/v3/Implementaciones/${fila.details.id}?fields=N_Implementacion`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      if (rr.ok) {
        const jj = (await rr.json()) as { data?: Array<{ N_Implementacion?: string }> }
        numero = String(jj?.data?.[0]?.N_Implementacion || "")
      }
    } catch {
      /* sin número: el agendamiento lo pedirá por otra vía */
    }
    // La COTIZACIÓN también debe saber de esta implementación (05-sep, caso
    // Maquinarias: COT1245 quedó "Pago Pendiente" y sin Implementación
    // asociada porque el cierre del wizard, que es quien estampa eso, no corre
    // en el alta por chat). Mismo valor que deja el wizard: "Cerrada".
    if (d.quoteId) {
      await fetch(`${API()}/crm/v3/Cotizaciones_GeoVictoria/${d.quoteId}`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          data: [{
            Implementaci_n_Asociada: { id: fila.details.id },
            Onboarding_Status: "Cerrada",
            ...(d.ndvId ? { Nota_de_Venta: { id: d.ndvId } } : {}),
          }],
        }),
      }).catch(() => null)
    }
    console.log(`[implementacion] creada ${fila.details.id}${numero ? ` (${numero})` : ""} para ${d.razonSocial} → ${relator.nombre}`)
    return {
      id: fila.details.id,
      numero: numero || undefined,
      relator: { nombre: relator.nombre, email: relator.email },
    }
  } catch (e) {
    console.warn("[implementacion] excepción:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Deja la capacitación agendada ESCRITA en la implementación, con la misma
 * convención que usa el auto-onboarding: `Estado_Curso_1_SMB` en
 * "Autoagendamiento" (verificado en IMP-11366 del wizard, 03-sep). Así el
 * equipo de implementación ve las capacitaciones que agenda Vicky exactamente
 * igual que las que agenda el formulario, sin aprender nada nuevo.
 *
 * Best-effort: la cita YA está tomada en Bookings y el cliente ya la tiene
 * confirmada — si el CRM falla, lo que se pierde es el reflejo, no la hora.
 */
/**
 * CAPACITACIÓN AGENDADA ⇒ "2. En Planificación" (05-sep, brecha de correos).
 *
 * En una implementación humana el jefe de proyectos mueve la etapa a
 * "2. En Planificación" cuando deja planificado el curso, y ESO es lo que
 * dispara en Zoho los dos correos del momento: "¡Bienvenido a GeoVictoria!
 * Tu primer desafío es…" al CLIENTE (regla "Bienvenida Geoavanzado":
 * presentación del jefe, URL de ingreso advanced.geovictoria.com, manual del
 * administrador) y el aviso de cambio de etapa al equipo. La de Vicky se
 * quedaba en "1. En Traspaso" para siempre y el cliente nunca recibía nada de
 * eso. Vicky no manda correo propio: mueve la etapa y Zoho hace lo mismo que
 * para cualquier cliente humano — una sola fuente, cero duplicación.
 *
 * Los humanos lo hacen editando el campo (crm_ui), no por blueprint; acá va
 * con trigger workflow+blueprint porque los correos SON workflows.
 */
export async function pasarAEnPlanificacion(implementacionId: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ Etapa_Implementaci_n: "2. En Planificación" }],
        trigger: ["workflow", "blueprint"],
      }),
    })
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "")
      console.warn(`[implementacion] ${implementacionId} no pasó a En Planificación: ${r.status} ${cuerpo.slice(0, 300)}`)
      return false
    }
    console.log(`[implementacion] ${implementacionId} → 2. En Planificación (Zoho manda el Bienvenido al cliente)`)
    return true
  } catch (e) {
    console.warn("[implementacion] excepción pasando a En Planificación:", e instanceof Error ? e.message : e)
    return false
  }
}

/** Offset de America/Santiago en la fecha dada, como "-04:00" / "-03:00". */
function offsetChile(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", timeZoneName: "longOffset" }).formatToParts(d)
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-4"
  const mm = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
  if (!mm) return "-04:00"
  return `${mm[1]}${mm[2].padStart(2, "0")}:${mm[3] || "00"}`
}

export async function registrarCurso1Agendado(
  implementacionId: string,
  d: { desdeBookings: string; relator: string },
): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    // "10-Sep-2026 16:00:00" → "2026-09-10T16:00:00-04:00" (hora de Chile).
    const MESES: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    }
    const m = d.desdeBookings.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2}):\d{2}$/)
    if (!m) return false
    // OFFSET REAL DE CHILE EN ESA FECHA (05-sep): antes iba "-04:00" fijo y el
    // 9 de septiembre Chile ya está en horario de verano (-03:00) — la reserva
    // era a las 09:00 y la Implementación decía 10:00. Se calcula con la zona.
    const pared = `${m[3]}-${MESES[m[2]] || "01"}-${m[1]}T${m[4]}:00`
    const iso = `${pared}${offsetChile(new Date(`${pared}Z`))}`
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Fecha_y_Hora_Curso_1: iso,
            Relator_Curso_1: d.relator,
            Estado_Curso_1_SMB: "Autoagendamiento",
            // Zoho rechaza el ISO con milisegundos y "Z" ("2026-09-05T03:15:00.123Z"
            // → 400 INVALID_DATA). Descubierto en la prueba E2E del 05-sep: la
            // reserva en Bookings salía bien y el reflejo en la Implementación
            // moría acá. Formato aceptado: sin milisegundos y con offset.
            Fecha_hora_agendamiento_Curso_1: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
          },
        ],
        trigger: ["blueprint"],
      }),
    })
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "")
      console.warn(`[implementacion] no se pudo escribir el Curso 1 en ${implementacionId}: ${r.status} ${cuerpo.slice(0, 300)}`)
      return false
    }
    return true
  } catch (e) {
    console.warn("[implementacion] excepción escribiendo el Curso 1:", e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * El cliente CANCELÓ su Curso 1 desde el chat: la Implementación suelta la
 * fecha, el relator y el estado de autoagendamiento (E11 05-sep: la reserva
 * salía de Bookings pero la IMP seguía diciendo "martes 14:30 con Diego" y el
 * relator se presentaba a una sesión que no existía). La etapa no retrocede.
 */
export async function limpiarCurso1Agendado(implementacionId: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Fecha_y_Hora_Curso_1: null,
            Relator_Curso_1: null,
            Estado_Curso_1_SMB: null,
            Fecha_hora_agendamiento_Curso_1: null,
          },
        ],
        trigger: ["blueprint"],
      }),
    })
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "")
      console.warn(`[implementacion] no se pudo limpiar el Curso 1 en ${implementacionId}: ${r.status} ${cuerpo.slice(0, 300)}`)
      return false
    }
    return true
  } catch (e) {
    console.warn("[implementacion] excepción limpiando el Curso 1:", e instanceof Error ? e.message : e)
    return false
  }
}
