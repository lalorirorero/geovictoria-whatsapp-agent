/**
 * Catálogo de servicios asociados de GeoVictoria.
 *
 * Modela DOS grupos de cobro por punto físico:
 *   - Envío del reloj: según modalidad (arriendo/venta) y zona (RM/regiones).
 *     Precio fijo, sin descuento.
 *   - Instalación on-site: tarifa plana por ZONA en 3 tramos (jul-2026), SIN
 *     distinción arriendo/compra y SIN descuento. Se omite si el cliente
 *     auto-instala.
 *
 * Tarifas oficiales (UF por punto):
 *   Envío        — arriendo: RM 0 / región 0,5 · compra: RM 0,5 / región 0,7
 *   Instalación  — RM 1 · intermedia (IV-V-VI: Coquimbo, Valparaíso,
 *                  O'Higgins) 3 · resto de regiones 5
 *
 * IMPORTANTE: editar las tarifas acá y commit & push para actualizar Vicky.
 *
 * INSTALACIÓN BONIFICADA EN ARRIENDO RM (Lalo 07-sep, cierre de objeciones:
 * "si es arriendo en RM es gratis, esa atención debe venderse bien y generar
 * valor al cliente"): con reloj en ARRIENDO y punto en la Región
 * Metropolitana la visita técnica NO se cobra. La tarifa de lista (1 UF)
 * se mantiene como referencia y la línea sale TACHADA con −100% (mismo
 * patrón del envío del arriendo), así el cliente ve el valor que recibe.
 * Venta y regiones siguen cobrando la tabla.
 */

import type { Servicio } from "./tipos"
import type { ZonaInstalacion } from "../geografia"

/**
 * ¿La instalación técnica va bonificada (−100 %) para esta combinación?
 * Hoy: solo arriendo + Región Metropolitana. Único lugar donde vive la regla.
 */
export function esInstalacionBonificada(modalidad: "arriendo" | "venta", zona: ZonaInstalacion): boolean {
  return modalidad === "arriendo" && zona === "RM"
}

export const CATALOGO_SERVICIOS: Servicio[] = [
  {
    id: "envio_reloj",
    nombre: "Envío de reloj",
    descripcion:
      "Despacho del reloj de control al punto del cliente. Cobro único por punto. Precio fijo (no aplica descuento).",
    tarifa: {
      modelo: "modalidad_zona",
      // ARRIENDO SIN ENVÍO (Lalo 13-ago): el despacho va incluido en el
      // arriendo, que ahora se cobra por zona (RM 0,35 / regiones 0,40 —
      // recargo ARRIENDO_RECARGO_REGIONES_UF en los motores). Así muere la
      // línea "Envío de reloj" del arriendo y su explicación. VENTA conserva
      // su envío aparte (la venta es solo a pedido).
      arriendo: { RM: 0.0, region: 0.0 },
      venta: { RM: 0.5, region: 0.7 },
    },
    descontable: false,
    omitirSiAutoInstalada: false,
    obligatoriedad: "obligatoria",
    permiteAutoInstalacion: false,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
  {
    id: "instalacion_reloj",
    nombre: "Instalación de reloj",
    descripcion:
      "Visita técnica para instalación on-site del reloj de control en el punto del cliente. Cobro único por punto.",
    tarifa: {
      modelo: "zona",
      RM: 1.0,
      intermedia: 3.0,
      resto: 5.0,
    },
    descontable: false,
    omitirSiAutoInstalada: true,
    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,
    // Vacío por decisión comercial (jul-2026): la elección de auto-instalar se
    // acepta sin advertencias en el chat (no frenar el cierre con letra chica);
    // las condiciones viven en los términos de la cotización.
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
