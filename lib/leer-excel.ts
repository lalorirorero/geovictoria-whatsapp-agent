/**
 * Lector de EXCEL (.xlsx) sin dependencias (25-ago, F2 nómina multi-modal).
 *
 * El pipeline de media del webhook describe imágenes y PDFs con visión, pero
 * un .xlsx es un ZIP binario que la visión no lee — la prueba de Lalo lo
 * mostró: Vicky respondió "¿qué datos vienen en el archivo?". Un xlsx es
 * zip(+XML), así que acá se hace a mano: EOCD → directorio central →
 * inflateRawSync por entrada → sharedStrings + primera hoja → filas de texto.
 *
 * Devuelve la planilla como texto tabular (una línea por fila, columnas
 * separadas por tab) listo para inyectarse a la conversación — el modelo la
 * lee igual que una nómina pegada. Cap defensivo de filas/caracteres.
 */

import { inflateRawSync } from "node:zlib"

const MAX_FILAS = 200
const MAX_CHARS = 8000

/** ¿Los bytes parecen un ZIP? (xlsx/docx/zip parten con PK\x03\x04). */
export function esZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

type Entrada = { nombre: string; data: Buffer }

function descomprimirZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // EOCD (0x06054b50) — buscar desde el final (máx 64KB de comentario).
  let eocd = -1
  const desde = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= desde; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return out
  const total = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // offset del directorio central
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const metodo = buf.readUInt16LE(p + 10)
    const comprimido = buf.readUInt32LE(p + 20)
    const nombreLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const comentLen = buf.readUInt16LE(p + 32)
    const offsetLocal = buf.readUInt32LE(p + 42)
    const nombre = buf.subarray(p + 46, p + 46 + nombreLen).toString("utf8")
    // Header local: saltar su nombre+extra propios (pueden diferir del central).
    if (offsetLocal + 30 <= buf.length && buf.readUInt32LE(offsetLocal) === 0x04034b50) {
      const nl = buf.readUInt16LE(offsetLocal + 26)
      const el = buf.readUInt16LE(offsetLocal + 28)
      const inicio = offsetLocal + 30 + nl + el
      const datos = buf.subarray(inicio, inicio + comprimido)
      try {
        out.set(nombre, metodo === 8 ? inflateRawSync(datos) : Buffer.from(datos))
      } catch {
        /* entrada corrupta: se salta */
      }
    }
    p += 46 + nombreLen + extraLen + comentLen
  }
  return out
}

function desescapar(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
}

/** Textos <t> concatenados dentro de un fragmento XML. */
function textosT(xml: string): string {
  return desescapar(
    [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""),
  )
}

function columnaAIndice(ref: string): number {
  const letras = ref.replace(/\d+$/, "")
  let n = 0
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

/**
 * xlsx → texto tabular (tab-separado, una línea por fila). null si el buffer
 * no es una planilla legible (no-zip, sin hoja, vacía).
 */
export function excelATexto(bytes: Uint8Array): string | null {
  if (!esZip(bytes)) return null
  const zip = descomprimirZip(Buffer.from(bytes))
  const hojaNombre = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort()[0]
  if (!hojaNombre) return null

  const compartidas: string[] = []
  const ss = zip.get("xl/sharedStrings.xml")?.toString("utf8") || ""
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) compartidas.push(textosT(m[1]))

  const hoja = zip.get(hojaNombre)!.toString("utf8")
  const filas: string[] = []
  for (const mRow of hoja.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (filas.length >= MAX_FILAS) break
    const celdas: string[] = []
    // OJO (caso Molinas 07-sep): los atributos van LAZY. Con `[^>]*` codicioso,
    // una celda vacía autocerrada `<c r="C38" s="50" />` se tragaba el `/`, no
    // calzaba `\/>` y seguía hasta el `</c>` de la celda SIGUIENTE: la columna
    // RUT (texto compartido) salía como el índice crudo ("127") en la columna
    // equivocada, y toda la planilla del cliente parecía "sin datos".
    for (const mC of mRow[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = mC[1] || ""
      const cuerpo = mC[2] || ""
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] || ""
      const idx = ref ? columnaAIndice(ref) : celdas.length
      const tipo = /t="([^"]+)"/.exec(attrs)?.[1] || ""
      let valor = ""
      if (tipo === "inlineStr") valor = textosT(cuerpo)
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1] ?? ""
        valor = tipo === "s" ? compartidas[Number(v)] ?? "" : desescapar(v)
      }
      while (celdas.length < idx) celdas.push("")
      celdas[idx] = valor.trim()
    }
    const linea = celdas.join("\t").replace(/\t+$/, "")
    if (linea.trim()) filas.push(linea)
  }
  if (!filas.length) return null
  let texto = filas.join("\n")
  if (texto.length > MAX_CHARS) texto = `${texto.slice(0, MAX_CHARS)}\n[planilla truncada: hay más filas]`
  if (filas.length >= MAX_FILAS) texto += `\n[planilla truncada en ${MAX_FILAS} filas]`
  return texto
}
