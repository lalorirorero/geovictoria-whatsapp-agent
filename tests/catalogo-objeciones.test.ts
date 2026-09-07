/**
 * CIERRE DE OBJECIONES (Lalo 07-sep): lo que se agregó al catálogo de Vicky
 * para dejar de derivar — kit QR, impresora térmica, tarjetas con confianza —
 * y la instalación técnica bonificada cuando el reloj va en ARRIENDO en la
 * Región Metropolitana ("si es arriendo en RM es gratis").
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { CATALOGO_HARDWARE, esRelojDePared } from "../lib/catalogo/hardware.ts"

const getHardwareDisponibleParaVicky = (id: string) => CATALOGO_HARDWARE.find((h) => h.id === id && h.disponibleParaVicky) || null
const getHardwareDisponiblesParaVicky = () => CATALOGO_HARDWARE.filter((h) => h.disponibleParaVicky)
import { esInstalacionBonificada, CATALOGO_SERVICIOS } from "../lib/catalogo/servicios.ts"

describe("catálogo · kit QR e impresora térmica", () => {
  test("kit_qr existe, solo arriendo, 1,8 UF/mes, y es reloj de pared", () => {
    const k = getHardwareDisponibleParaVicky("kit_qr")
    assert.ok(k, "kit_qr habilitado para Vicky")
    assert.deepEqual(k!.modalidadesDisponibles, ["arriendo"])
    assert.equal(k!.arriendoUF, 1.8)
    assert.equal(k!.ventaUF, 0)
    assert.equal(esRelojDePared("kit_qr"), true)
  })
  test("impresora_termica es accesorio con venta 7 / arriendo 1,2 y no es reloj", () => {
    const i = getHardwareDisponibleParaVicky("impresora_termica")
    assert.ok(i)
    assert.equal(i!.esAccesorio, true)
    assert.equal(i!.ventaUF, 7)
    assert.equal(i!.arriendoUF, 1.2)
    assert.equal(esRelojDePared("impresora_termica"), false)
  })
  test("tarjeta_id sigue siendo accesorio y el huellero USB no cuenta como reloj de pared", () => {
    assert.equal(getHardwareDisponibleParaVicky("tarjeta_id")?.esAccesorio, true)
    assert.equal(esRelojDePared("tarjeta_id"), false)
    assert.equal(esRelojDePared("uru4500"), false)
    assert.equal(esRelojDePared("senseface_2a"), true)
    assert.equal(esRelojDePared("armorpad"), false, "deshabilitado para Vicky")
  })
  test("los ids habilitados son exactamente los esperados", () => {
    const ids = getHardwareDisponiblesParaVicky().map((h) => h.id).sort()
    assert.deepEqual(ids, ["impresora_termica", "kit_qr", "senseface_2a", "tarjeta_id", "uru4500"])
  })
})

describe("instalación bonificada · arriendo en RM", () => {
  test("solo arriendo + RM va sin costo", () => {
    assert.equal(esInstalacionBonificada("arriendo", "RM"), true)
    assert.equal(esInstalacionBonificada("venta", "RM"), false)
    assert.equal(esInstalacionBonificada("arriendo", "intermedia"), false)
    assert.equal(esInstalacionBonificada("arriendo", "resto"), false)
    assert.equal(esInstalacionBonificada("venta", "resto"), false)
  })
  test("la tarifa de lista de instalación RM sigue en 1 UF (es la referencia tachada)", () => {
    const inst = CATALOGO_SERVICIOS.find((s) => s.id === "instalacion_reloj")!
    assert.equal(inst.tarifa.modelo, "zona")
    if (inst.tarifa.modelo === "zona") {
      assert.equal(inst.tarifa.RM, 1)
      assert.equal(inst.tarifa.intermedia, 3)
      assert.equal(inst.tarifa.resto, 5)
    }
  })
})
