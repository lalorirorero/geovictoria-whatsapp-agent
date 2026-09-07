/**
 * Catálogo de hardware de marcaje de GeoVictoria.
 *
 * Replica el `catalogoEquipos` del index.html de la cotizadora oficial.
 * Para mantener paridad, los `id` deben coincidir EXACTAMENTE.
 *
 * Política de nomenclatura para Vicky:
 *   - displayName: nombre genérico (lo que Vicky comunica al prospecto)
 *   - modelo: nombre técnico real (lo que se usa internamente y se incluye
 *     en el campo Descripcion_Item del subform de Zoho para transparencia
 *     comercial en el PDF de la cotización formal)
 *
 * Vicky NUNCA debe mencionar marcas ni modelos específicos en la conversación.
 * Solo "reloj control físico" o "aplicación móvil".
 */

/** ARRIENDO POR ZONA (Lalo 13-ago): el envío del arriendo se eliminó — en su
 * lugar el arriendo mensual lleva este recargo POR UNIDAD cuando el punto
 * queda fuera de la Región Metropolitana (SF2A: 0,35 RM / 0,40 regiones). */
export const ARRIENDO_RECARGO_REGIONES_UF = 0.05


import type { Hardware } from "./tipos"

export const CATALOGO_HARDWARE: Hardware[] = [
  // ─── HABILITADO PARA VICKY ──────────────────────────────────────────────
  {
    id: "senseface_2a",
    modelo: "Senseface 2A",
    displayName: "Reloj control físico",
    conexion: "WiFi",
    ventaUF: 6,
    arriendoUF: 0.35,
    descripcion:
      "Reloj control físico de marcaje en punto fijo, conexión WiFi. Según el modelo admite varios métodos de marcaje (clave numérica, reconocimiento facial, huella dactilar, tarjeta de proximidad, código QR y lector de cédula). Funciona SOLO (autónomo), no necesita un computador. Recomendado para puntos de trabajo con más de 10 personas o cuando los empleados no cuentan con smartphone propio.",
    modalidadesDisponibles: ["arriendo","venta"],
    cantidadSugerida: 1,
    requiereInstalacionOnsite: true,
    disponibleParaVicky: true,
  },
  {
    id: "uru4500",
    modelo: "URU4500",
    displayName: "Huellero USB",
    conexion: "USB",
    ventaUF: 3,
    arriendoUF: 0.25,
    descripcion:
      "Lector de huella dactilar USB que se conecta a un computador (PC). Marca por huella. NO es autónomo: necesita un computador disponible y encendido en cada punto donde se marque (el lector va enchufado a ese PC). El cliente lo conecta por su cuenta (plug and play, sin visita técnica de instalación). Alternativa más económica al reloj de pared cuando el punto de marcaje ya tiene un computador. NO sirve para marcar en terreno ni donde no hay PC.",
    modalidadesDisponibles: ["arriendo", "venta"],
    cantidadSugerida: 1,
    requiereInstalacionOnsite: false,
    disponibleParaVicky: true,
  },

  {
    id: "tarjeta_id",
    modelo: "Tarjeta ID",
    displayName: "Tarjeta de proximidad",
    conexion: "-",
    ventaUF: 0.03,
    arriendoUF: 0,
    descripcion:
      "Tarjeta de proximidad para marcar asistencia acercándola al lector del reloj control físico. Se vende por unidad (pago único) y solo acompaña a un reloj — el reloj admite hasta 3.000 tarjetas registradas.",
    modalidadesDisponibles: ["venta"],
    cantidadSugerida: 1,
    requiereInstalacionOnsite: false,
    disponibleParaVicky: true,
    esAccesorio: true,
  },

  // KIT QR (Lalo 07-sep, cierre de objeciones — "el QR es un producto aparte
  // en la calculadora? habría que agregarlo al catálogo de Vicky"): es el
  // bundle de la calculadora comercial de Nacho (KIT_QR_ARRIENDO_UF = 1,8):
  // Senseface 3A + gabinete con lector de CI + lector de código de barras
  // Vuquest 3320g. SOLO ARRIENDO, precio del kit completo por mes. Se
  // comporta como reloj de pared: punto físico, envío bonificado del
  // arriendo, instalación por zona.
  {
    id: "kit_qr",
    modelo: "Kit QR: Senseface 3A + gabinete lector CI + lector Vuquest 3320g",
    displayName: "Reloj con lector QR",
    conexion: "WIFI/LAN",
    ventaUF: 0,
    arriendoUF: 1.8,
    descripcion:
      "Reloj control físico con lector de código QR y de cédula de identidad: la persona marca acercando un QR (impreso o desde su celular) o su carnet, además de rostro, huella o clave. Es un kit de arriendo mensual (reloj + gabinete con lector). Solo en arriendo. Para clientes que piden marcar con QR o con la cédula.",
    modalidadesDisponibles: ["arriendo"],
    cantidadSugerida: 1,
    requiereInstalacionOnsite: true,
    disponibleParaVicky: true,
  },

  // IMPRESORA TÉRMICA DE COMPROBANTES (Lalo 07-sep): accesorio del reloj de
  // pared para el cliente que igual quiere ticket en papel (el comprobante
  // digital al correo ya cumple la norma). Lista de Nacho: SLK-TL202II venta
  // 7 UF / arriendo 1,2 UF. Books: "013 - Impresora Termica (Fiscal)".
  {
    id: "impresora_termica",
    modelo: "SLK-TL202II",
    displayName: "Impresora térmica de comprobantes",
    conexion: "Serial",
    ventaUF: 7,
    arriendoUF: 1.2,
    descripcion:
      "Impresora térmica que se conecta al reloj control físico e imprime un comprobante en papel de cada marca (además del comprobante digital que llega al correo del trabajador). Accesorio: solo acompaña a un reloj de pared, no lleva envío ni instalación propios. Se puede arrendar junto con el reloj o comprar.",
    modalidadesDisponibles: ["arriendo", "venta"],
    cantidadSugerida: 1,
    requiereInstalacionOnsite: false,
    disponibleParaVicky: true,
    esAccesorio: true,
  },

  // ─── DECLARADOS PERO DESHABILITADOS ─────────────────────────────────────
  {
    id: "armorpad",
    modelo: "ARMORPAD",
    displayName: "ARMORPAD",
    conexion: "-",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal robusto para entornos industriales.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "ct58",
    modelo: "CT58",
    displayName: "CT58 (4G/Wifi)",
    conexion: "4G/Wifi",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal con conectividad 4G y Wifi.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_4glan",
    modelo: "IN01-A",
    displayName: "IN01-A (4G/LAN)",
    conexion: "4G/LAN",
    ventaUF: 12,
    arriendoUF: 1.5,
    descripcion: "Terminal IN01-A con conectividad 4G y red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_lan",
    modelo: "IN01-A",
    displayName: "IN01-A (LAN)",
    conexion: "LAN",
    ventaUF: 7,
    arriendoUF: 0.88,
    descripcion: "Terminal IN01-A con red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_lanwifi",
    modelo: "IN01-A",
    displayName: "IN01-A (LAN/WIFI)",
    conexion: "LAN/WIFI",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal IN01-A con LAN y Wifi.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "mb10vl",
    modelo: "MB10-VL",
    displayName: "MB10-VL (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 3.5,
    arriendoUF: 0.5,
    descripcion: "Terminal económico con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "mb560vl",
    modelo: "MB560-vl",
    displayName: "MB560-vl (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Terminal con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "s922",
    modelo: "S922",
    displayName: "S922 (4G)",
    conexion: "4G",
    ventaUF: 20,
    arriendoUF: 2.5,
    descripcion: "Terminal premium con conectividad 4G.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_3a",
    modelo: "Senseface 3A",
    displayName: "Senseface 3A (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 7,
    arriendoUF: 0.65,
    descripcion: "Biométrico facial con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_4a",
    modelo: "Senseface 4A",
    displayName: "Senseface 4A",
    conexion: "-",
    ventaUF: 8.5,
    arriendoUF: 0.75,
    descripcion: "Biométrico facial generación 4A.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_7a",
    modelo: "Senseface 7A",
    displayName: "Senseface 7A (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 10,
    arriendoUF: 0.8,
    descripcion: "Biométrico facial gama alta con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "speedface_v4l",
    modelo: "SpeedFace V4L",
    displayName: "SpeedFace V4L (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Biométrico facial SpeedFace V4L.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "speedface_v5l",
    modelo: "SpeedFace V5L",
    displayName: "SpeedFace V5L (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 12,
    arriendoUF: 1.5,
    descripcion: "Biométrico facial SpeedFace V5L gama alta.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "x628c",
    modelo: "X628-C",
    displayName: "X628-C (LAN)",
    conexion: "LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Terminal con red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
]

/**
 * Reloj de PARED (autónomo, en punto fijo): el único equipo al que pueden
 * acompañar los accesorios (tarjetas, impresora). Excluye accesorios, el
 * hardware plug-and-play (huellero USB) y lo no habilitado para Vicky.
 * Vive acá (y no en index.ts) para que sea testeable sin resolver alias.
 */
export function esRelojDePared(id: string): boolean {
  const h = CATALOGO_HARDWARE.find((x) => x.id === id)
  return Boolean(h && h.disponibleParaVicky && h.esAccesorio !== true && h.requiereInstalacionOnsite !== false)
}
