/**
 * Lector de Excel sin dependencias (lib/leer-excel.ts): una celda VACÍA
 * autocerrada delante de una celda de texto compartido no puede tragarse a la
 * siguiente. Caso real Molinas 07-sep: la columna RUT de una nómina de 18
 * personas se leyó como "127…144" (índices de sharedStrings) y Vicky le dijo al
 * cliente tres veces que su planilla venía sin datos.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { deflateRawSync } from "node:zlib"
import { excelATexto } from "../lib/leer-excel.ts"

function crc32(buf: Buffer): number {
  let c: number, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP mínimo (deflate) con las entradas dadas — suficiente para el lector. */
function zip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, "utf8")
    const data = deflateRawSync(raw)
    const n = Buffer.from(name, "utf8")
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28)
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += local.length + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(centrals.length / 2, 8); eocd.writeUInt16LE(centrals.length / 2, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]))
}

test("una celda vacía autocerrada no se traga la celda de texto siguiente (caso Molinas)", () => {
  const shared = ["28519426-1", "ana@x.cl", "Ana", "Pérez"]
  const ss =
    '<?xml version="1.0"?><sst>' + shared.map((t) => `<si><t>${t}</t></si>`).join("") + "</sst>"
  // B vacía autocerrada, C = RUT (shared 0), D = correo, E = nombres, F = apellidos
  const hoja =
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="1"><c r="B1" s="36" /><c r="C1" s="36" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c>' +
    '<c r="E1" t="s"><v>2</v></c><c r="F1" t="s"><v>3</v></c><c r="G1" s="8" /></row>' +
    "</sheetData></worksheet>"
  const texto = excelATexto(zip({ "xl/sharedStrings.xml": ss, "xl/worksheets/sheet1.xml": hoja }))
  assert.ok(texto, "debe leer la hoja")
  const cols = texto!.split("\n")[0].split("\t")
  assert.equal(cols[2], "28519426-1", `la columna C debe traer el RUT, no el índice: ${JSON.stringify(cols)}`)
  assert.deepEqual(cols.slice(3, 6), ["ana@x.cl", "Ana", "Pérez"])
})
