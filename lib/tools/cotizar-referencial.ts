/**
 * Tool: cotizar_referencial
 *
 * Calcula un estimado mensual referencial para empresas de 1 a 50 trabajadores.
 *
 * Para cada módulo y cantidad de usuarios, busca el tier correcto en el
 * catálogo (vía obtenerTierAplicable). Si un módulo no tiene tier para
 * ese rango (ej. Reporte para 3 personas), la cotización emite advertencia
 * y omite ese módulo sin fallar la respuesta entera.
 *
 * Si un producto no existe en el catálogo o no tiene disponibleParaVicky=true,
 * la tool falla con error legible. Eso garantiza la premisa rectora:
 *   "Solo se cotiza lo que existe en el catálogo Y está habilitado."
 *
 * Instalación de hardware:
 *   Cuando la cotización incluye hardware, las tools requieren el array
 *   `puntosInstalacion`. Cada punto se clasifica vía `clasificarUbicacion`
 *   (RM vs regiones) y se inyecta como línea adicional con la tarifa
 *   correspondiente. Si el prospecto declina la instalación (autoInstalada=true),
 *   no se cobra pero se agregan las advertencias declaradas en el catálogo
 *   de servicios.
 *
 * Formato del mensajeParaProspecto:
 *   - Se separa en dos secciones: "Resumen mensual recurrente" (módulos +
 *     hardware en arriendo) y "Pago único" (hardware en compra + instalaciones).
 *   - Cada sección tiene su propio subtotal, IVA, total y equivalente CLP.
 *   - Si solo hay items recurrentes (ej. solo app móvil), la sección "Pago
 *     único" se omite por completo.
 *   - Decimales: subtotales/totales redondean a 1 decimal (sin .0 si queda
 *     entero). Precios unitarios mantienen precisión natural sin ceros
 *     trailing innecesarios.
 *   - NO incluye el sufijo "[tier X-Y usuarios]" — esa info queda solo en
 *     items[].tierAplicado del objeto retornado, para uso interno/debug.
 */

import {
  ARRIENDO_RECARGO_REGIONES_UF,
  getModuloDisponibleParaVicky,
  getModulosDisponiblesParaVicky,
  getHardwareDisponibleParaVicky,
  getHardwareDisponiblesParaVicky,
  getServiciosAplicablesConHardware,
  obtenerPrecioServicio,
  obtenerTierAplicable,
  validarRangoModulo,
  esRelojDePared,
} from "@/lib/catalogo"
import { clasificarUbicacion } from "@/lib/geografia"
import { esInstalacionBonificada } from "@/lib/catalogo/servicios"
import { consolidarLineasIguales } from "./generar-link-cotizadora"
import { getUFActual } from "@/lib/uf"

const IVA_RATE = 0.19
const SCOPE_MAX_USUARIOS = 50

// ─── Schema de la tool ───────────────────────────────────────────────────
export const cotizarReferencialSchema = {
  name: "cotizar_referencial",
  description:
    "Calcula un estimado mensual referencial en UF y CLP para una empresa de 1 a 50 trabajadores, según los módulos de software y el hardware de marcaje que el prospecto haya elegido. Úsalo cuando ya tengas userCount confirmado y al menos un módulo o hardware definido. Si la cotización incluye hardware, también requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un reloj). Si el prospecto tiene más de 50 trabajadores, NO uses esta tool — deriva a soporte con derivar_a_soporte.",
  input_schema: {
    type: "object" as const,
    properties: {
      userCount: {
        type: "number" as const,
        description: "Cantidad de trabajadores (debe estar entre 1 y 50 inclusive).",
        minimum: 1,
        maximum: SCOPE_MAX_USUARIOS,
      },
      modulos: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "Lista de IDs de módulos de software a incluir. El catálogo disponible se le pasa en el system prompt. Siempre debe incluirse 'asistencia' como base.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: {
              type: "string" as const,
              description:
                "ID del hardware del catálogo (ej. 'senseface_2a'). Solo se aceptan productos habilitados para Vicky.",
            },
            cantidad: {
              type: "number" as const,
              description: "Cantidad de unidades. Default 1 si no se especifica.",
              minimum: 1,
              maximum: 10,
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "POR DEFECTO 'arriendo'. El reloj se cotiza SIEMPRE arrendado; usa 'venta' ÚNICAMENTE si el cliente pidió COMPRARLO de forma explícita en la conversación. Nunca elijas 'venta' por tu cuenta, ni para comparar, ni porque el cliente pregunte cuánto vale el reloj. Ante la duda, omite el campo.",
            },
          },
          required: ["id"],
        },
        description:
          "Lista opcional de hardware de marcaje a incluir. Si el prospecto no menciona necesidad de dispositivo físico, dejar vacío.",
      },
      evidenciaEleccionReloj: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (copiada literal de su mensaje, sin parafrasear ni corregir) donde eligió el reloj o el mixto — ej: 'me interesa con ambos', 'quiero el reloj', 'la primera opción'. El sistema verifica que exista palabra por palabra en la conversación; sin esa cita la cotización con hardware se rechaza. Si el cliente aún no ha elegido, NO cotices con hardware: pregúntale el marcaje.",
      },
      evidenciaUbicacion: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (literal) donde dijo la comuna/ubicación del punto — ej: 'no disculpa es para olmué', 'estamos en Renca'. Sin esa cita (o sin que la comuna aparezca en sus mensajes) la cotización con hardware se rechaza.",
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: {
              type: "string" as const,
              description:
                "Ubicación del punto donde se instalará el reloj, tal como la entregó el prospecto. Puede ser una comuna ('Las Condes', 'Concepción'), una región ('Metropolitana', 'Biobío'), un ordinal ('novena región', 'IX'), un número ('región 13'), o un alias ('RM', 'Santiago'). La tool clasifica internamente si es RM o regiones para aplicar la tarifa correcta. Pregunta esto al prospecto, no lo asumas por contexto.",
            },
            autoInstalada: {
              type: "boolean" as const,
              description:
                "true si el prospecto decidió instalar el reloj por su cuenta (no se cobra la instalación, pero el envío se cobra igual; se incluyen advertencias). false si la instalación la realiza GeoVictoria (recomendado).",
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad del reloj de ESTE punto ('arriendo' o 'venta'). Define la tarifa de envío e instalación del punto. Si toda la cotización es de una sola modalidad, puedes omitirlo (se infiere del hardware); si hay relojes en arriendo Y compra en distintos puntos, indícalo por punto.",
            },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description:
          "Lista de puntos físicos donde se instalará hardware. OBLIGATORIO si la cotización incluye al menos un hardware. El envío y la instalación se cobran por punto (un punto con 2 relojes tiene un solo envío y una sola instalación). Si la cotización no incluye hardware, omitir.",
      },
    },
    required: ["userCount", "modulos"],
  },
}

// ─── Tipos de resultado ──────────────────────────────────────────────────
export type ItemCotizacion = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string // ej. "11-20 usuarios" — uso interno, NO se muestra al prospecto
  /** Bonificación por línea (100 = sin costo, se muestra tachada). */
  descuentoPct?: number
}

export type PuntoInstalacionInput = {
  ubicacion: string
  autoInstalada: boolean
  /** Modalidad del reloj del punto. Si se omite, se infiere del hardware. */
  modalidad?: "arriendo" | "venta"
}

export type CotizacionResultado =
  | {
      ok: true
      userCount: number
      items: ItemCotizacion[]
      // Totales globales (suma de recurrente + único). Se mantienen por
      // compatibilidad con consumidores externos que ya leen estos campos.
      subtotalUF: number
      ivaUF: number
      totalUF: number
      ufActual: number
      totalCLP: number
      // Totales separados por sección (nuevos)
      subtotalRecurrenteUF: number
      ivaRecurrenteUF: number
      totalRecurrenteUF: number
      totalRecurrenteCLP: number
      subtotalUnicoUF: number
      ivaUnicoUF: number
      totalUnicoUF: number
      totalUnicoCLP: number
      resumenLegible: string
      mensajeParaProspecto: string
      advertencias: string[]
    }
  | { ok: false; error: string }

// ─── UF actual: fuente única compartida (lib/uf.ts) ──────────────────────
// getUFActual se importa de @/lib/uf para que estimado, negociación y
// cotización formal usen el MISMO valor (con caché) en una conversación.

// ─── Helpers de formato ─────────────────────────────────────────────────
// Formato chileno: "." separador de miles, "," separador decimal.
// Ej: 40522.38 → "40.522,38"; 3.5 con 1 decimal → "3,5".
function fmtNumCL(n: number, decimals: number): string {
  const [entero, dec] = n.toFixed(decimals).split(".")
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return dec ? `${conMiles},${dec}` : conMiles
}

// Formato para UF (regla unificada acordada con Rodrigo):
//   - Hasta 2 decimales (redondeo).
//   - Si queda entero, sin decimales.
//   - Sin ceros trailing innecesarios.
//   - Coma decimal (formato chileno).
// Ej: 5 → "5"; 0.07 → "0,07"; 0.35 → "0,35"; 3.5 → "3,5";
//     3.85 → "3,85"; 0.7315 → "0,73"; 4.5815 → "4,58"; 7.0 → "7"; 6.961 → "6,96".
function fmtUF(n: number): string {
  const rounded = Math.round(n * 100) / 100
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  const s = fmtNumCL(rounded, 2)
  return s.replace(/0+$/, "").replace(/,$/, "")
}

// Precio UNITARIO: hasta 3 decimales para que "cantidad × unitario = subtotal"
// calce a la vista. Los tramos de asistencia 0,055 / 0,065 se redondeaban a
// 0,06 / 0,07 con fmtUF y la multiplicación no cuadraba con el subtotal real
// (ej: 46 × 0,06 = 2,76 ≠ 2,53). Mismo formato chileno, sin ceros trailing.
function fmtUFUnit(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  const s = fmtNumCL(rounded, 3)
  return s.replace(/0+$/, "").replace(/,$/, "")
}

// ─── Clasificación de modalidad → sección del preform ────────────────────
type Seccion = "recurrente" | "unico"

function seccionDe(modalidad: string): Seccion {
  if (modalidad === "Fijo" || modalidad === "Por usuario" || modalidad === "Arriendo mensual") {
    return "recurrente"
  }
  // "Venta única", "Cobro único"
  return "unico"
}

// ─── Formato de cada item según su modalidad ─────────────────────────────
function formatItem(i: ItemCotizacion): string {
  if (i.modalidad === "Fijo") {
    return `- ${i.nombre}: ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Por usuario") {
    return `- ${i.nombre}: ${i.cantidad} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Arriendo mensual") {
    return `- ${i.nombre}: ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Venta única") {
    return `- ${i.nombre} (compra): ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF`
  }
  if (i.modalidad === "Cobro único") {
    if (i.cantidad > 1) {
      return `- ${i.nombre} × ${i.cantidad}: ${i.cantidad} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF`
    }
    return `- ${i.nombre}: ${fmtUF(i.subtotalUF)} UF`
  }
  return `- ${i.nombre}: ${i.cantidad} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF`
}

// ─── Implementación ──────────────────────────────────────────────────────
export async function cotizarReferencial(args: {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
}): Promise<CotizacionResultado> {
  const { userCount, modulos, hardware = [], puntosInstalacion = [] } = args
  const advertencias: string[] = []

  // ── Validación de rango ──
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return {
      ok: false,
      error: `userCount=${userCount} fuera de rango. Esta tool cubre empresas de 1 a ${SCOPE_MAX_USUARIOS} trabajadores. Para empresas más grandes, deriva con derivar_a_soporte motivo "fuera_de_rango_trabajadores".`,
    }
  }

  // ── Procesar módulos ──
  const items: ItemCotizacion[] = []

  // Forzar inclusión de 'asistencia' como base
  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]

  for (const moduloId of modulosConBase) {
    const modulo = getModuloDisponibleParaVicky(moduloId)
    if (!modulo) {
      const todosDisponibles = getModulosDisponiblesParaVicky().map((m) => m.id)
      return {
        ok: false,
        error: `Módulo '${moduloId}' no está disponible para cotización por Vicky. Módulos habilitados: ${todosDisponibles.join(", ")}.`,
      }
    }

    // Validar rango (mínimos globales + cobertura de tiers)
    const rangoError = validarRangoModulo(modulo, userCount)
    if (rangoError) {
      advertencias.push(rangoError)
      continue
    }

    // Obtener tier aplicable
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) {
      advertencias.push(`No se encontró tier aplicable para ${modulo.nombre} con ${userCount} trabajadores.`)
      continue
    }

    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotalUF =
      tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF

    items.push({
      tipo: "modulo",
      id: modulo.id,
      nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitarioUF: tier.precioUF,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
    })
  }

  // ── Procesar hardware ──
  // ACCESORIOS (tarjetas de proximidad, 01-sep): venta única que acompaña al
  // reloj — no cuenta para puntos/envío/instalación y sola no se cotiza.
  const hayAccesorios = hardware.some((hw) => getHardwareDisponibleParaVicky(hw.id)?.esAccesorio === true)
  const hardwareEquipos = hardware.filter((hw) => getHardwareDisponibleParaVicky(hw.id)?.esAccesorio !== true)
  if (hayAccesorios && !hardwareEquipos.some((hw) => esRelojDePared(hw.id))) {
    return {
      ok: false,
      error:
        "Los accesorios (tarjetas de proximidad, impresora térmica) solo acompañan a un reloj control físico de pared. " +
        "Cotízalos junto al reloj, o agrega el reloj a la configuración.",
    }
  }
  // Los accesorios con arriendo disponible (impresora) siguen la modalidad
  // del reloj: si el reloj va arrendado, el accesorio también (Lalo 07-sep).
  const relojEnArriendo = hardwareEquipos.some((hw) => (hw.modalidad ?? "arriendo") === "arriendo")
  let hayHardware = false
  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) {
      const disponibles = getHardwareDisponiblesParaVicky().map((h) => h.id)
      return {
        ok: false,
        error: `Hardware '${hw.id}' no está disponible para cotización por Vicky. ${disponibles.length > 0 ? `Hardware habilitado: ${disponibles.join(", ")}.` : "No hay hardware habilitado actualmente."}`,
      }
    }

    const esAccesorio = dispositivo.esAccesorio === true
    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadAccesorio: "arriendo" | "venta" =
      relojEnArriendo && dispositivo.modalidadesDisponibles.includes("arriendo") ? "arriendo" : "venta"
    const modalidadElegida: "arriendo" | "venta" = hw.modalidad ?? (esAccesorio ? modalidadAccesorio : "arriendo")

    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return {
        ok: false,
        error: `El ${dispositivo.displayName} no está disponible en modalidad '${modalidadElegida}'. Modalidades disponibles: ${dispositivo.modalidadesDisponibles.join(", ")}.`,
      }
    }

    const precioUnitario =
      modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF

    if (precioUnitario === 0) {
      return {
        ok: false,
        error: `${dispositivo.displayName} no tiene precio en modalidad '${modalidadElegida}' (valor 0).`,
      }
    }

    items.push({
      tipo: "hardware",
      id: dispositivo.id,
      nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitarioUF: precioUnitario,
      subtotalUF: Number((cantidad * precioUnitario).toFixed(3)),
    })
    // Los accesorios no gatillan puntos/envío/instalación: viajan con el reloj.
    if (!esAccesorio) hayHardware = true

    if (!esAccesorio && cantidad > dispositivo.cantidadSugerida) {
      advertencias.push(
        `Para ${dispositivo.displayName} se está cotizando ${cantidad} unidades. La cotizadora oficial puede aplicar precios distintos a las unidades adicionales (descuento promo aplica solo a las primeras unidades).`
      )
    }
  }

  // ── Procesar puntos de instalación ──
  if (hayHardware) {
    if (puntosInstalacion.length === 0) {
      return {
        ok: false,
        error:
          "La cotización incluye hardware pero no se entregó 'puntosInstalacion'. " +
          "Por cada punto físico donde se instalará un reloj, debes pasar { ubicacion, autoInstalada }. " +
          "Si el prospecto aún no ha entregado la ubicación, pregúntale la comuna o región antes de cotizar.",
      }
    }

    for (const punto of puntosInstalacion) {
      const c = clasificarUbicacion(punto.ubicacion)
      if (c.tipo === "no_clasificable") {
        return {
          ok: false,
          error:
            `No pude clasificar la ubicación '${punto.ubicacion}' (${c.razon}). ` +
            `Pregúntale al prospecto la comuna o región específica donde se instalará el reloj ` +
            `y vuelve a llamar la tool.`,
        }
      }
    }

    const modalidadesHw = new Set(
      hardwareEquipos.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"),
    )
    const modalidadUniforme: "arriendo" | "venta" | null =
      modalidadesHw.size === 1 ? [...modalidadesHw][0] : null

    // Hardware plug-and-play (huellero USB): no requiere visita técnica de
    // instalación on-site. Si TODO el hardware de la cotización es de este tipo,
    // el servicio de instalación no se cobra (el envío sí se mantiene: el equipo
    // se despacha igual). Un reloj de pared mezclado reactiva la instalación.
    const soloHardwareSinInstalacion =
      hardwareEquipos.length > 0 &&
      hardwareEquipos.every((hw) => getHardwareDisponibleParaVicky(hw.id)?.requiereInstalacionOnsite === false)

    const serviciosAplicables = getServiciosAplicablesConHardware()
    for (const punto of puntosInstalacion) {
      const clasificacion = clasificarUbicacion(punto.ubicacion)
      if (clasificacion.tipo === "no_clasificable") continue

      if (!clasificacion.reconocida) {
        advertencias.push(
          `Ubicación '${punto.ubicacion}' no reconocida en la lista oficial. ` +
          `Se aplicó tarifa de regiones por defecto. El ejecutivo confirmará la ubicación exacta al revisar la cotización.`,
        )
      }

      const modalidadPunto = punto.modalidad ?? modalidadUniforme
      if (!modalidadPunto) {
        return {
          ok: false,
          error:
            "La cotización tiene relojes en arriendo Y en compra, así que necesito la modalidad de cada punto. " +
            "Vuelve a llamar la tool indicando `modalidad` ('arriendo' o 'venta') en cada entrada de puntosInstalacion.",
        }
      }

      const zonaPunto = clasificacion.zonaInstalacion
      for (const servicio of serviciosAplicables) {
        if ((punto.autoInstalada || soloHardwareSinInstalacion) && servicio.omitirSiAutoInstalada) {
          if (punto.autoInstalada) {
            for (const adv of servicio.advertenciasAutoInstalacion) {
              advertencias.push(`Auto-instalación en ${punto.ubicacion}: ${adv}`)
            }
          }
          continue
        }
        const precioUF = obtenerPrecioServicio(servicio, zonaPunto, modalidadPunto)
        if (precioUF <= 0) continue
        // INSTALACIÓN BONIFICADA — arriendo en RM (Lalo 07-sep): la visita
        // técnica va sin costo; la línea muestra la tarifa de lista tachada.
        const bonificada =
          servicio.id === "instalacion_reloj" && esInstalacionBonificada(modalidadPunto, zonaPunto)
        items.push({
          tipo: "servicio",
          id: servicio.id,
          nombre: `${servicio.nombre} (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitarioUF: precioUF,
          subtotalUF: bonificada ? 0 : Number(precioUF.toFixed(3)),
          ...(bonificada ? { descuentoPct: 100 } : {}),
        })
      }
    }

    // ── ARRIENDO POR ZONA (Lalo 13-ago) ──
    // El envío del arriendo murió (tarifa 0 en el catálogo): en su lugar el
    // arriendo mensual se cobra por zona — 0,35 UF en RM y 0,40 UF en
    // regiones (recargo ARRIENDO_RECARGO_REGIONES_UF por unidad). Con puntos
    // en zonas mixtas, la línea de arriendo se divide (n unidades RM + m
    // unidades regiones). La VENTA no cambia (conserva su envío aparte).
    const zonasPuntos = puntosInstalacion
      .map((p) => clasificarUbicacion(p.ubicacion))
      .filter((c) => c.tipo !== "no_clasificable")
      .map((c) => (c.zonaInstalacion === "RM" ? "rm" : "regiones"))
    const puntosRegiones = zonasPuntos.filter((z) => z === "regiones").length
    if (puntosRegiones > 0) {
      for (let ix = items.length - 1; ix >= 0; ix--) {
        const it = items[ix]
        if (it.tipo !== "hardware" || it.modalidad !== "Arriendo mensual") continue
        // Los accesorios en arriendo (impresora) no llevan recargo de zona.
        if (getHardwareDisponibleParaVicky(it.id)?.esAccesorio === true) continue
        const enRegiones = Math.min(it.cantidad, puntosRegiones)
        const enRM = it.cantidad - enRegiones
        const precioReg = Number((it.precioUnitarioUF + ARRIENDO_RECARGO_REGIONES_UF).toFixed(3))
        if (enRM <= 0) {
          it.precioUnitarioUF = precioReg
          it.subtotalUF = Number((it.cantidad * precioReg).toFixed(3))
        } else {
          it.cantidad = enRM
          it.subtotalUF = Number((enRM * it.precioUnitarioUF).toFixed(3))
          items.splice(ix + 1, 0, {
            ...it,
            cantidad: enRegiones,
            precioUnitarioUF: precioReg,
            subtotalUF: Number((enRegiones * precioReg).toFixed(3)),
            nombre: `${it.nombre} (regiones)`,
          })
        }
      }
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: "No hay items válidos para cotizar. Verificá que los IDs sean correctos y estén habilitados.",
    }
  }

  // ── Totales globales (compatibilidad) ──
  const subtotalUF = items.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActual()
  const totalCLP = Math.round(totalUF * ufActual)

  // ── Totales separados por sección ──
  // Consolidar líneas idénticas ANTES de mostrar (feedback 16-jul, caso Putre:
  // 4 relojes imprimían 8 líneas repetidas de envío/instalación). Mismo
  // consolidador que usa la cotización formal — cero drift.
  const itemsConsolidados = consolidarLineasIguales(items)
  const itemsRecurrentes = itemsConsolidados.filter((i) => seccionDe(i.modalidad) === "recurrente")
  const itemsUnicos = itemsConsolidados.filter((i) => seccionDe(i.modalidad) === "unico")

  const subtotalRecurrenteUF = itemsRecurrentes.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaRecurrenteUF = subtotalRecurrenteUF * IVA_RATE
  const totalRecurrenteUF = subtotalRecurrenteUF + ivaRecurrenteUF
  const totalRecurrenteCLP = Math.round(totalRecurrenteUF * ufActual)

  const subtotalUnicoUF = itemsUnicos.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUnicoUF = subtotalUnicoUF * IVA_RATE
  const totalUnicoUF = subtotalUnicoUF + ivaUnicoUF
  const totalUnicoCLP = Math.round(totalUnicoUF * ufActual)

  // ── Construir mensaje canónico en secciones ──
  // Este string es la ÚNICA fuente de verdad para comunicar precios al usuario.
  // Vicky copia este bloque tal cual al prospecto. Si cambia el formato
  // (descuentos, planes anuales, etc.), se modifica acá y se propaga a todas
  // las superficies que consuman esta tool.
  const partes: string[] = []

  // Micro-plan: 1 trabajador que marca. El plan base cubre 2 usuarios (el que
  // marca + 1 administrador). Se aclara en el mensaje para que el prospecto
  // entienda el alcance de la tarifa especial.
  const esMicroPlan =
    userCount === 1 && items.some((i) => i.id === "asistencia" && i.modalidad === "Fijo")

  if (itemsRecurrentes.length > 0) {
    partes.push("Resumen mensual recurrente:")
    partes.push("")
    partes.push(itemsRecurrentes.map(formatItem).join("\n"))
    partes.push("")
    // La línea que calcula el IVA solo NUNCA va (Eduardo 14-ago). El SUBTOTAL
    // sin IVA vuelve, pero solo con DOS O MÁS líneas: ahí suma —deja ver cómo
    // se llega al total—; con una sola línea es repetir el mismo número.
    if (itemsRecurrentes.length >= 2) {
      partes.push(`Subtotal sin IVA: ${fmtUF(subtotalRecurrenteUF)} UF`)
    }
    // UF PRIMERO, pesos entre paréntesis (Eduardo 18-ago: "siempre la UF y
    // luego el precio entre paréntesis"). Sin el valor de la UF del día
    // (Eduardo 17-ago): el tipo de cambio agrega ruido, el aprox. basta.
    partes.push(`Total mensual con IVA: ${fmtUF(totalRecurrenteUF)} UF (aprox. $${fmtNumCL(totalRecurrenteCLP, 0)})`)
    if (esMicroPlan) {
      partes.push("")
      partes.push(
        "Este plan base cubre 2 usuarios: el trabajador que marca + 1 administrador para gestionar la plataforma.",
      )
    }
  }

  if (itemsUnicos.length > 0) {
    if (partes.length > 0) partes.push("")
    partes.push("Pago único:")
    partes.push("")
    partes.push(itemsUnicos.map(formatItem).join("\n"))
    partes.push("")
    if (itemsUnicos.length >= 2) {
      partes.push(`Subtotal sin IVA: ${fmtUF(subtotalUnicoUF)} UF`)
    }
    partes.push(`Total único con IVA: ${fmtUF(totalUnicoUF)} UF (aprox. $${fmtNumCL(totalUnicoCLP, 0)})`)
  }

  // Aclaración de base: dejar SIN AMBIGÜEDAD (1) qué se paga al aceptar —el
  // pago inicial = pago único + primer mes por adelantado— y (2) cómo sigue el
  // cobro desde el segundo mes: un plan mensual recurrente. Cubrimos los dos
  // casos: con pago único (hardware/instalación) y sin él (solo plan, ej. app).
  if (itemsUnicos.length > 0 && itemsRecurrentes.length > 0) {
    // Burbuja propia (Lalo 13-ago): el "Al aceptar pagas…" va como mensaje
    // aparte de WhatsApp, no pegado al desglose.
    partes.push("")
    partes.push("[---]")
    partes.push("")
    partes.push(
      `Al aceptar pagas el pago inicial de ${fmtUF(totalUnicoUF + totalRecurrenteUF)} UF (aprox. $${fmtNumCL(
        totalUnicoCLP + totalRecurrenteCLP,
        0,
      )}): incluye el pago único (equipos e instalación) + el primer mes del plan por adelantado.`,
    )

    // CERRAR > TICKET (dirección comercial 16-jul): cuando la instalación pesa
    // en el pago inicial (zonas intermedias/extremas o varios puntos), se
    // muestran PROACTIVAMENTE los caminos más livianos — auto-instalación con
    // el ahorro CUANTIFICADO, y el marcaje sin reloj — antes de que el monto
    // enfríe al prospecto. Determinista (calculado aquí, no por el modelo).
    const instalacionUF = itemsConsolidados
      .filter((i) => i.tipo === "servicio" && /instalaci/i.test(i.nombre))
      .reduce((sum, i) => sum + i.subtotalUF, 0)
    if (instalacionUF >= 3) {
      const ahorroConIvaUF = instalacionUF * (1 + IVA_RATE)
      const ahorroCLP = Math.round(ahorroConIvaUF * ufActual)
      const inicialLivianoUF = totalUnicoUF + totalRecurrenteUF - ahorroConIvaUF
      const inicialLivianoCLP = totalUnicoCLP + totalRecurrenteCLP - ahorroCLP
      // Burbuja aparte (Rodrigo 09-ago, "este mensaje es demasiado largo"):
      // el marcador [---] corta el WhatsApp en dos — el resumen con el pago
      // inicial primero, las alternativas livianas como mensaje propio. El
      // pipeline de salida ya lo convierte en mensajes separados con cadencia.
      partes.push("")
      partes.push("[---]")
      partes.push("")
      partes.push(
        `💡 Para partir más liviano tienes dos alternativas:`,
      )
      partes.push(
        `- Auto-instalación: ustedes montan los relojes (los guiamos paso a paso) y el pago inicial baja a ${fmtUF(inicialLivianoUF)} UF (aprox. $${fmtNumCL(inicialLivianoCLP, 0)}) — se ahorran ${fmtUF(ahorroConIvaUF)} UF (aprox. $${fmtNumCL(ahorroCLP, 0)}).`,
      )
      partes.push(
        `- Marcaje sin reloj: con la app incluida en el plan (biometría facial y georeferenciación; cada persona marca desde su propio celular o desde el celular del supervisor), sin equipos que comprar ni instalar. Pídeme esa opción y te la muestro.`,
      )
    }
  }
  // SIN PAGOS ÚNICOS NO SE HABLA DE "PAGO INICIAL" (Eduardo 14-ago): si todo
  // es recurrente (plan y/o arriendo), el primer mes es EXACTAMENTE la
  // mensualidad — repetir la misma cifra como "pago inicial" solo confunde y
  // hace parecer que hay un cobro extra. El pago inicial se muestra únicamente
  // cuando hay algo one-shot (compra de reloj, envío, instalación), que es
  // cuando de verdad difiere del mensual.

  // DISCLAIMER DE INSTALACIÓN — DETERMINISTA (Lalo 13-ago, caso Rodrigo: el
  // modelo lo omitió aunque el prompt lo pedía). Siempre que la cotización
  // lleva RELOJ y la instalación NO viene cotizada (auto-instalación, el
  // supuesto por defecto de la biblia), el disclaimer sale EN LA TOOL como
  // burbuja aparte — aclarar que instala el cliente, con el técnico como
  // opción de cobro, no depende del criterio del modelo.
  const hayReloj = itemsConsolidados.some((i) => i.tipo === "hardware")
  const instalacionCotizada = itemsConsolidados.some(
    (i) => i.tipo === "servicio" && /instalaci/i.test(i.nombre),
  )
  // Hardware 100% plug-and-play (huellero USB): no existe instalación técnica
  // que ofrecer — el disclaimer no aplica.
  const todoPlugAndPlay =
    hardware.length > 0 &&
    hardware.every((hw) => getHardwareDisponibleParaVicky(hw.id)?.requiereInstalacionOnsite === false)
  // Precio de la instalación técnica opcional (misma tabla por zona que usaría
  // la cotización con autoInstalada=false). Se calcula acá arriba porque lo
  // usan DOS textos: el disclaimer clásico y la Opción 1 del doble valor.
  let instalacionTecnicoUF = 0
  let puntosInstalacionGratis = 0
  const instalacionPorPunto: Array<{ ubicacion: string; uf: number }> = []
  if (hayReloj && !instalacionCotizada && !todoPlugAndPlay) {
    try {
      const mods = new Set(hardware.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"))
      const modU: "arriendo" | "venta" = mods.size === 1 ? [...mods][0] : "arriendo"
      const serviciosInstalacion = getServiciosAplicablesConHardware().filter(
        (s) => s.omitirSiAutoInstalada,
      )
      for (const punto of puntosInstalacion) {
        const c = clasificarUbicacion(punto.ubicacion)
        if (c.tipo === "no_clasificable") continue
        const modP = punto.modalidad ?? modU
        // Arriendo en RM: el técnico va sin costo (Lalo 07-sep) — cuenta
        // como punto bonificado, no como monto.
        if (esInstalacionBonificada(modP, c.zonaInstalacion)) {
          puntosInstalacionGratis += 1
          continue
        }
        let ufPunto = 0
        for (const s of serviciosInstalacion) {
          ufPunto += obtenerPrecioServicio(s, c.zonaInstalacion, modP)
        }
        instalacionTecnicoUF += ufPunto
        if (ufPunto > 0) instalacionPorPunto.push({ ubicacion: punto.ubicacion, uf: ufPunto })
      }
    } catch {
      instalacionTecnicoUF = 0 // sin precio calculable: cae al texto genérico
    }
  }
  const instalacionGratisTotal =
    puntosInstalacionGratis > 0 && puntosInstalacionGratis >= puntosInstalacion.length
  const instalacionCotizadaBonificada = itemsConsolidados.some(
    (i) => i.tipo === "servicio" && /instalaci/i.test(i.nombre) && Number(i.descuentoPct) >= 100,
  )
  if (hayReloj && !instalacionCotizada && !todoPlugAndPlay) {
    partes.push("")
    partes.push("[---]")
    partes.push("")
    if (instalacionGratisTotal) {
      partes.push(
        "📌 La instalación por nuestro equipo técnico va INCLUIDA sin costo (arriendo en la Región Metropolitana). Así funciona: pagas, tu cuenta queda activa dentro de 24 horas hábiles y tu equipo ya puede marcar con la app; el reloj se despacha apenas se confirma el pago y el equipo técnico te contacta para agendar la visita. Si prefieres montarlo tú, es simple y te guiamos paso a paso — tú eliges.",
      )
    } else if (instalacionTecnicoUF > 0) {
      const instCLP = Math.round(instalacionTecnicoUF * (1 + IVA_RATE) * ufActual)
      partes.push(
        `📌 La instalación del reloj viene considerada por tu cuenta: es simple y te guiamos paso a paso. Tu cuenta queda activa dentro de 24 horas hábiles del pago, así que tu equipo parte marcando con la app mientras el reloj va en camino. Si prefieres que la instale nuestro equipo técnico, tiene un cobro único de ${fmtUF(instalacionTecnicoUF)} UF + IVA (aprox. $${fmtNumCL(instCLP, 0)}) — me dices y te lo agrego.`,
      )
    } else {
      partes.push(
        "📌 La instalación del reloj viene considerada por tu cuenta: es simple y te guiamos paso a paso. Tu cuenta queda activa dentro de 24 horas hábiles del pago, así que tu equipo parte marcando con la app mientras el reloj va en camino. Si prefieres que la instale nuestro equipo técnico, tiene un cobro único según la comuna — me dices y te lo agrego.",
      )
    }
  }

  let mensajeParaProspecto = partes.join("\n")

  // ── DOBLE VALOR DETERMINISTA (Lalo 13-ago: "No me dio opción 1 y opción 2") ──
  // Con reloj en la cotización, la TOOL compone las dos opciones tituladas y
  // la pregunta final — el modelo solo pega. Antes esto era una regla del
  // prompt y el modelo la saltaba (caso real 13-ago 12:42). SIEMPRE, aunque
  // el cliente haya pedido reloj explícito: la Opción 2 sin reloj se muestra
  // igual (decisión comercial: tasa de cierre > ticket). La llamada interna
  // sin hardware no recursa (entra por la rama sin reloj).
  if (hayReloj) {
    try {
      const alternativa = await cotizarReferencial({ userCount, modulos })
      if (alternativa.ok) {
        // TEXTOS DE EDUARDO (17-ago, pantallazo): las opciones son COMPACTAS —
        // un titular con la recomendación, el mensual con IVA y una línea de
        // uso; el desglose completo queda para la cotización formal. Antes la
        // Opción 1 embebía el preform entero y el mensaje se hacía eterno.
        const mods = new Set(hardware.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"))
        const modalidadLabel =
          mods.size === 1 ? (mods.has("venta") ? "Reloj en venta" : "Reloj en arriendo") : "Reloj"
        const personas = userCount === 1 ? "1 persona" : `${userCount} personas`

        // La frase de instalación se adapta al caso real: auto-instalado con
        // técnico opcional (el común), instalación ya cotizada, o equipo
        // plug-and-play (huellero USB) donde no existe instalación técnica.
        // FRASE DE INSTALACIÓN (formato Eduardo 18-ago): oración propia
        // "El reloj es autoinstalable. Si prefieres que nosotros lo
        // instalemos, tiene un costo único adicional de X UF + IVA."
        let fraseInstalacion = ""
        if (instalacionCotizada) {
          fraseInstalacion = instalacionCotizadaBonificada
            ? "La instalación por nuestro equipo técnico va incluida sin costo (arriendo en la Región Metropolitana)."
            : "En este caso la instalación por nuestro equipo técnico ya viene incluida."
        } else if (instalacionGratisTotal) {
          fraseInstalacion =
            "La instalación por nuestro equipo técnico va incluida sin costo (arriendo en la Región Metropolitana); si prefieres, el reloj también es autoinstalable."
        } else if (!todoPlugAndPlay) {
          // CON monto (Eduardo 17-ago, segunda vuelta): la comuna ya es
          // conocida en este punto — la tool exige puntosInstalacion con
          // hardware — así que la tarifa es real, no una estimación. El
          // genérico queda solo para comunas que no clasifican.
          // DESGLOSE con 2+ relojes (Eduardo 17-ago, caso Rodrigo): "6 UF" a
          // secas escondía que eran 1 UF Providencia + 5 UF Talcahuano. Con un
          // solo punto el total sigue solo, sin desglose.
          if (instalacionTecnicoUF > 0 && instalacionPorPunto.length >= 2) {
            const partesInst = instalacionPorPunto.map(
              (pp, i) => `${fmtUF(pp.uf)} UF + IVA ${i === 0 ? "por la" : "la"} de ${pp.ubicacion}`,
            )
            fraseInstalacion = `Los relojes son autoinstalables. Si prefieres que nosotros los instalemos, tiene un costo único adicional de ${partesInst.join(" y ")}.`
          } else {
            fraseInstalacion =
              instalacionTecnicoUF > 0
                ? `El reloj es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de ${fmtUF(instalacionTecnicoUF)} UF + IVA.`
                : "El reloj es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional según la comuna."
          }
        }

        // PRECIO EN UF PRIMERO (Eduardo 18-ago, reemplaza el "$X al mes, IVA
        // incluido" del 17-ago): el mensual va en UF + IVA con el equivalente
        // en pesos como aproximación, y una línea fija explica que el cobro
        // es en UF (el valor en pesos varía mes a mes). El valor de la UF del
        // día sigue SIN mostrarse (regla 17-ago intacta).
        const lineasOpcion1 = [
          `1 - Para ${personas} te recomiendo ${modalidadLabel} + App:`,
          `💰 ${fmtUF(subtotalRecurrenteUF)} UF + IVA al mes (aprox. $${fmtNumCL(totalRecurrenteCLP, 0)}).`,
          ``,
          `El cobro se realiza en UF, por lo que el valor en pesos puede variar mes a mes.`,
          ``,
          `Tus trabajadores pueden marcar desde el reloj o desde el celular, como les acomode.`,
        ]
        if (fraseInstalacion) lineasOpcion1.push(fraseInstalacion)
        // El pago único inicial (envío / equipo en venta) NO estaba en el
        // pantallazo, pero ocultarlo dejaría la única cifra del preform
        // incompleta y la formal lo cobraría "por sorpresa". Una línea corta.
        if (totalUnicoCLP > 0) {
          lineasOpcion1.push(
            `Se suma un pago inicial único de ${fmtUF(subtotalUnicoUF)} UF + IVA (aprox. $${fmtNumCL(totalUnicoCLP, 0)}).`,
          )
        }

        // LA ALTERNATIVA TIENE QUE DECIR EN QUÉ ES MEJOR (03-sep, caso Juan
        // Pablo/COT1148, reloj en VENTA): con el reloj comprado no hay
        // arriendo, así que el mensual de las dos opciones es EL MISMO — y
        // Vicky igual anunciaba la segunda como "una alternativa más
        // económica" con la cifra idéntica al lado. Al cliente le quedaban dos
        // opciones que valen lo mismo y una etiqueta que no se sostiene,
        // cuando lo que de verdad cambia es que la app sola no tiene el pago
        // inicial (en su caso, $325.908). Ahora el encabezado se elige por lo
        // que la alternativa REALMENTE ahorra: mensualidad, entrada, o ambas.
        const ahorraMensual = alternativa.subtotalRecurrenteUF < subtotalRecurrenteUF - 0.001
        const ahorraEntrada = totalUnicoCLP > 0
        const encabezadoAlternativa = ahorraMensual
          ? "2.- Una alternativa más económica sería si marcan solo mediante nuestra app:"
          : ahorraEntrada
            ? "2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):"
            : "2.- También puedes partir marcando solo con nuestra app:"
        mensajeParaProspecto = [
          ...lineasOpcion1,
          "",
          "[---]",
          "",
          encabezadoAlternativa,
          `💰 ${fmtUF(alternativa.subtotalRecurrenteUF)} UF + IVA al mes (aprox. $${fmtNumCL(alternativa.totalRecurrenteCLP, 0)}).`,
          "",
          "[---]",
          "",
          "Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.",
        ].join("\n")
      }
    } catch { /* sin alternativa: queda el mensaje simple */ }
  }

  // resumenLegible (uso interno del modelo) usa el mismo formato — una sola
  // fuente de verdad para que no haya inconsistencias entre lo que ve el
  // modelo internamente y lo que comunica al prospecto.
  const resumenLegible = mensajeParaProspecto

  return {
    ok: true,
    userCount,
    items,
    subtotalUF: Number(subtotalUF.toFixed(3)),
    ivaUF: Number(ivaUF.toFixed(3)),
    totalUF: Number(totalUF.toFixed(3)),
    ufActual: Number(ufActual.toFixed(2)),
    totalCLP,
    subtotalRecurrenteUF: Number(subtotalRecurrenteUF.toFixed(3)),
    ivaRecurrenteUF: Number(ivaRecurrenteUF.toFixed(3)),
    totalRecurrenteUF: Number(totalRecurrenteUF.toFixed(3)),
    totalRecurrenteCLP,
    subtotalUnicoUF: Number(subtotalUnicoUF.toFixed(3)),
    ivaUnicoUF: Number(ivaUnicoUF.toFixed(3)),
    totalUnicoUF: Number(totalUnicoUF.toFixed(3)),
    totalUnicoCLP,
    resumenLegible,
    mensajeParaProspecto,
    advertencias,
  }
}
