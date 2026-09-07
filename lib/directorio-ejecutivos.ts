/**
 * FUENTE ÚNICA de teléfonos de ejecutivos (P1 27-ago, recomendación de
 * Rodrigo tras 3 casos de números mezclados — el peor: RCT, donde Vicky
 * presentó el número de la MESA DE AYUDA como si fuera el de Tamara,
 * habiendo dado el correcto minutos antes).
 *
 * Reglas:
 *  - El directorio estático cubre el roster conocido; se EXTIENDE sin deploy
 *    con env VICKY_TELEFONOS_EJECUTIVOS="email:+56 9 ...,email:+56 9 ...".
 *  - `corregirTelefonosEjecutivos` es el cinturón determinista del webhook:
 *    si la respuesta menciona a UN ejecutivo del directorio junto a un número
 *    que NO es el suyo (ni una línea oficial, ni un número que aportó el
 *    cliente), el número se REEMPLAZA por el correcto del directorio.
 *    Puro y testeable: no toca red.
 */

export type FichaEjecutivo = { nombre: string; email: string; telefono: string }

const DIRECTORIO_BASE: FichaEjecutivo[] = [
  { nombre: "Eddyluz Mujica", email: "emujica@geovictoria.com", telefono: "+56 9 3932 1687" },
  { nombre: "Anderson Díaz", email: "adiazg@geovictoria.com", telefono: "+56 9 3937 2058" },
  { nombre: "Tamara Martínez", email: "tmartinezq@geovictoria.com", telefono: "+56 9 3452 9937" },
  { nombre: "Ana Paula López", email: "alopez@geovictoria.com", telefono: "+56 9 6647 4270" },
  { nombre: "Paola Díaz", email: "pdiaz@geovictoria.com", telefono: "+56 9 3932 1686" },
  { nombre: "Aleydis Araque", email: "aaraque@geovictoria.com", telefono: "+56 9 8291 6868" },
  // 07-sep (caso Conbes, VB Lalo "confirmo el arreglo 3"): faltaban tres del
  // roster CL — y el blindaje de soporte inventado reemplazaba sus correos por
  // soporte@ ("su correo es soporte@geovictoria.com" en la reunión de
  // Aracelli). Teléfonos = ficha de usuario de Zoho.
  { nombre: "Aracelli Sepúlveda", email: "asepulveda@geovictoria.com", telefono: "+56 9 3212 5672" },
  { nombre: "Daniela Gálvez", email: "dgalvez@geovictoria.com", telefono: "+56 9 2958 7913" },
  { nombre: "Grey Meléndez", email: "gmelendez@geovictoria.com", telefono: "+56 9 3937 2060" },
  { nombre: "Mónica Mendoza", email: "mmendozav@geovictoria.com", telefono: "+51 962 277 502" },
]

/** Líneas nuestras que SÍ pueden aparecer junto a cualquier nombre (Vicky,
 * soporte, mesa de ayuda). Un número de acá jamás se "corrige". */
export const LINEAS_OFICIALES = new Set([
  "56929649992", // línea Vicky CL (Meta)
  "56967308227", // línea Vicky CL (Botmaker)
  "56927526890",
  "56944013873", // Mesa de Ayuda / soporte (el número del caso RCT)
  "51922067167", // línea Vicky PE
  "573181070737", // línea Vicky CO
])

export function directorioEjecutivos(): FichaEjecutivo[] {
  const filas = [...DIRECTORIO_BASE]
  for (const par of (process.env.VICKY_TELEFONOS_EJECUTIVOS || "").split(",")) {
    const idx = par.indexOf(":")
    if (idx <= 0) continue
    const email = par.slice(0, idx).trim().toLowerCase()
    const telefono = par.slice(idx + 1).trim()
    if (!email || !telefono) continue
    const previa = filas.find((f) => f.email === email)
    if (previa) previa.telefono = telefono
    else filas.push({ nombre: email.split("@")[0], email, telefono })
  }
  return filas
}

const soloDigitos = (s: string): string => s.replace(/\D/g, "")

const normalizar = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()

/** Teléfonos chilenos/latam con formato de presentación (con +56/51/52 o con
 * separadores tipo "9 4401 3873"). A propósito NO matchea RUTs ni cifras
 * pegadas sin prefijo.
 *
 * CICATRIZ (03-sep, casos Ana Delgado COT1151 y Ana María COT1162): sin los
 * bordes `(?<!\d)`/`(?!\d)` el patrón arrancaba DENTRO de un número más
 * largo. Todo id de cotización de Zoho empieza en `35250450006…`, que lleva un
 * "52" en la segunda posición: el regex se comía 13 dígitos del id y los
 * reemplazaba por el teléfono del ejecutivo, dejando el link de pago ROTO
 * (`/q/3+56 9 4401 387368552-…`). Bastaba que el mensaje nombrara a UNA
 * persona del directorio — y los clientes se llaman Ana, Paola, Tamara o
 * Daniela todo el tiempo, así que el nombre del propio cliente lo disparaba. */
const RE_TELEFONO = /(?<!\d)(?:\+?5[126]\s?9?[\s.-]?\d{3,4}[\s.-]?\d{3}[\s.-]?\d{3,4}|\b9[\s.-]\d{4}[\s.-]\d{4}\b)(?!\d)/g

/** Ningún cinturón de teléfonos puede tocar el interior de una URL: ahí viven
 * los ids de cotización y los tokens de pago. Se reemplaza SOLO fuera de los
 * links. */
export function reemplazarFueraDeUrls(
  texto: string,
  re: RegExp,
  reemplazo: (m: string) => string,
): string {
  const URL_RE = /https?:\/\/\S+/g
  let salida = ""
  let ultimo = 0
  for (const url of texto.matchAll(URL_RE)) {
    const i = url.index ?? 0
    salida += texto.slice(ultimo, i).replace(re, (m) => reemplazo(m))
    salida += url[0]
    ultimo = i + url[0].length
  }
  salida += texto.slice(ultimo).replace(re, (m) => reemplazo(m))
  return salida
}

/**
 * Cinturón: corrige números mal atribuidos a ejecutivos del directorio.
 *
 * @param reply respuesta candidata del modelo
 * @param numerosDelCliente dígitos de números que el CLIENTE aportó (su propio
 *        fono + los que escribió en la conversación) — jamás se tocan.
 * @returns reply corregida + detalle de la corrección (para log/aviso)
 */
export function corregirTelefonosEjecutivos(
  reply: string,
  numerosDelCliente: Set<string>,
): { reply: string; correcciones: Array<{ nombre: string; malo: string; bueno: string }> } {
  const texto = normalizar(reply)
  // ¿Qué ejecutivos del directorio están nombrados? Se exige nombre de pila
  // con borde de palabra ("tamara", "eddyluz", "aleydis"…).
  const nombrados = directorioEjecutivos().filter((f) => {
    const pila = normalizar(f.nombre.split(/\s+/)[0])
    return pila.length >= 3 && new RegExp(`\\b${pila}\\b`).test(texto)
  })
  // Solo actúa con UN ejecutivo nombrado: con dos o más no hay forma
  // determinista de saber de quién es cada número — mejor no tocar.
  if (nombrados.length !== 1) return { reply, correcciones: [] }
  const persona = nombrados[0]
  const telPersona = soloDigitos(persona.telefono)
  if (!telPersona) return { reply, correcciones: [] }

  const correcciones: Array<{ nombre: string; malo: string; bueno: string }> = []
  const corregida = reemplazarFueraDeUrls(reply, RE_TELEFONO, (m) => {
    const d = soloDigitos(m)
    if (d.length < 9) return m
    if (d === telPersona || telPersona.endsWith(d) || d.endsWith(telPersona)) return m
    // Línea oficial en contexto de SOPORTE: legítima ("para soporte, la mesa
    // de ayuda: +56 9 4401 3873"). La misma línea SIN ese contexto y junto al
    // nombre de un ejecutivo es exactamente el caso RCT — se corrige.
    if (LINEAS_OFICIALES.has(d) && /mesa de ayuda|soporte|servicio t[eé]cnico/i.test(reply)) return m
    if ([...numerosDelCliente].some((n) => n === d || n.endsWith(d) || d.endsWith(n))) return m
    // Número desconocido junto al nombre de un ejecutivo → se reemplaza por
    // el del directorio (sabemos el correcto: corregir gana a censurar).
    correcciones.push({ nombre: persona.nombre, malo: m, bueno: persona.telefono })
    return persona.telefono
  })
  return { reply: corregida, correcciones }
}
