/**
 * La sincronización CRM por hitos respeta el diccionario acordado con
 * marketing (Lalo 30-jul) y sus dos reglas duras:
 *
 *   1. El deal SIEMPRE nace de un lead convertido (nunca deal directo).
 *   2. El stage NUNCA retrocede: cada hito es un PISO — max(actual, piso).
 *
 * Y el origen doble del dato: si el lead ya existe en el CRM (conversación
 * SALIENTE por asignación), se reutiliza y se respeta a su dueño; solo si no
 * existe nada (ENTRANTE) se crea.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PISO_POR_HITO, HITO_POR_TOOL, etapaObjetivo, datosDeToolInput } from "../lib/crm-hitos.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const LOOP = readFileSync(join(RAIZ, "lib/agent-loop.ts"), "utf8")
const HITOS = readFileSync(join(RAIZ, "lib/crm-hitos.ts"), "utf8")

describe("diccionario de hitos → etapa piso", () => {
  test("los pisos son exactamente los acordados con marketing", () => {
    assert.equal(PISO_POR_HITO.intencion, "1. Trato Creado")
    assert.equal(PISO_POR_HITO.reunion_realizada, "2. Primera Reunion Realizada")
    assert.equal(PISO_POR_HITO.discovery, "3. En Levantamiento")
    assert.equal(PISO_POR_HITO.preform, "4. Propuesta Enviada / En Negociación")
    assert.equal(PISO_POR_HITO.aceptada, "6. Listo para Cierre")
    assert.equal(PISO_POR_HITO.onboarding_listo, "7. Implementando")
  })

  test("preform visto EN ADELANTE es Propuesta Enviada (cotizar_referencial incluido)", () => {
    assert.equal(HITO_POR_TOOL.cotizar_referencial, "preform")
    assert.equal(HITO_POR_TOOL.actualizar_cotizacion, "preform")
  })

  test("el comprobante de transferencia es aceptación", () => {
    assert.equal(HITO_POR_TOOL.registrar_comprobante_transferencia, "aceptada")
  })

  test("las tools de soporte NO están en el diccionario", () => {
    assert.equal(HITO_POR_TOOL.derivar_a_soporte, undefined)
    assert.equal(HITO_POR_TOOL.consultar_agente_soporte, undefined)
  })
})

describe("el stage nunca retrocede (cada hito es un piso)", () => {
  test("sube cuando el piso es mayor", () => {
    assert.equal(
      etapaObjetivo("1. Trato Creado", "4. Propuesta Enviada / En Negociación"),
      "4. Propuesta Enviada / En Negociación",
    )
  })

  test("la reunión NO baja un deal que ya vio preform", () => {
    assert.equal(
      etapaObjetivo("4. Propuesta Enviada / En Negociación", "2. Primera Reunion Realizada"),
      null,
    )
  })

  test("misma etapa → no tocar", () => {
    assert.equal(etapaObjetivo("3. En Levantamiento", "3. En Levantamiento"), null)
  })

  test("Cierre Perdido es terminal: ningún hito lo resucita", () => {
    assert.equal(etapaObjetivo("Cierre Perdido", "6. Listo para Cierre"), null)
  })
})

describe("reglas duras del módulo", () => {
  test("está detrás de flag, apagado por defecto", () => {
    assert.match(HITOS, /VICKY_CRM_HITOS_ENABLED/)
  })

  test("el deal nace SOLO por conversión de lead (nunca POST directo a Deals)", () => {
    assert.match(HITOS, /actions\/convert/)
    assert.ok(!/fetch\([^)]*\/crm\/v\d\/Deals`,\s*\{\s*method:\s*"POST"/.test(HITOS))
  })

  test("lead de dueño humano no se convierte sin autorización explícita", () => {
    assert.match(HITOS, /VICKY_CRM_HITOS_CONVERTIR_AJENOS/)
    assert.match(HITOS, /dueño humano/)
  })

  test("teléfonos de prueba jamás crean registros", () => {
    assert.match(HITOS, /VICKY_TELEFONOS_PRUEBA/)
  })

  test("mandatorios de la transición van DENTRO del data (lección del backfill)", () => {
    assert.match(HITOS, /blueprint:\s*\[\{\s*transition_id:\s*trans\.id,\s*data\s*\}\]/)
  })
})

describe("enriquecimiento aditivo con los datos de la conversación (Lalo 30-jul)", () => {
  test("cada tool aporta lo que sabe: empresa, correo, RUT, nombre, empleados", () => {
    assert.deepEqual(datosDeToolInput("cotizar_referencial", { userCount: 12 }), { empleados: 12 })
    assert.deepEqual(
      datosDeToolInput("generar_link_cotizadora", {
        empresa: "AROM SPA",
        contactoEmail: "ana@arom.cl",
        rutEmpresa: "76.123.456-7",
      }),
      { empresa: "AROM SPA", email: "ana@arom.cl", rut: "76.123.456-7", nombre: undefined },
    )
    assert.deepEqual(
      datosDeToolInput("agendar_reunion", { prospectName: "Ana Soto", prospectEmail: "a@b.cl" }),
      { nombre: "Ana Soto", email: "a@b.cl", empresa: undefined, empleados: undefined },
    )
  })

  test("tools sin datos personales no aportan nada (y no rompen)", () => {
    assert.deepEqual(datosDeToolInput("derivar_a_soporte", { motivo: "x" }), {
      nombre: undefined,
      empresa: undefined,
      email: undefined,
      empleados: undefined,
      rut: undefined,
    })
    assert.deepEqual(datosDeToolInput("cotizar_referencial", {}), { empleados: undefined })
  })

  test("los >50 llegan como TEXTO: el parser toma el piso del rango (Lalo 06-ago)", () => {
    // Caso Veltis: "somos en corporativo 300 aprox" se perdía y el deal nacía N=1.
    assert.deepEqual(
      datosDeToolInput("derivar_a_soporte", {
        motivo: "fuera_de_rango_trabajadores",
        nombre: "Fermin Morales",
        email: "fermin.morales@veltislatam.com",
        empresa: "Veltis",
        trabajadores: "somos en corporativo 300 aprox",
      }),
      { nombre: "Fermin Morales", email: "fermin.morales@veltislatam.com", empresa: "Veltis", empleados: 300, rut: undefined },
    )
    // Caso VDZ: "entre 200 y 400" (chat) y "200 - 499" (formulario) → piso.
    assert.equal(datosDeToolInput("agendar_reunion", { trabajadores: "entre 200 y 400" }).empleados, 200)
    assert.equal(datosDeToolInput("agendar_reunion", { trabajadores: "200 - 499 empleados" }).empleados, 200)
    assert.equal(datosDeToolInput("registrar_solicitud_callback", { trabajadores: "más de 100" }).empleados, 101)
    assert.equal(datosDeToolInput("agendar_reunion", { trabajadores: "no sé" }).empleados, undefined)
  })

  test("solo campos vacíos o placeholder — jamás pisar datos existentes", () => {
    assert.match(HITOS, /esPlaceholder\(lead\.company\)/)
    assert.match(HITOS, /datos\.email && !lead\.email/)
    assert.match(HITOS, /por identificar|prospecto whatsapp/i)
  })

  test("el hook del loop pasa el input de la tool y el guard admite datos nuevos", () => {
    assert.match(LOOP, /datosDeToolInput\(toolName, toolInput\)/)
    assert.match(HITOS, /JSON\.stringify\(datos\)/)
  })
})

describe("cableado en el agent-loop", () => {
  test("el hook corre tras el éxito de la tool, best-effort", () => {
    assert.match(LOOP, /HITO_POR_TOOL\[toolName\]/)
    assert.match(LOOP, /void sincronizarHitoCrm\(\s*\n\s*contact,\s*\n\s*HITO_POR_TOOL\[toolName\],/)
  })
})

describe("nota viva de transcripción en el deal", () => {
  test("una sola nota que se actualiza — busca por título antes de crear", () => {
    assert.match(HITOS, /TITULO_NOTA_TRANSCRIPCION = "Transcripción WhatsApp Vicky"/)
    assert.match(HITOS, /startsWith\(TITULO_NOTA_TRANSCRIPCION\)/)
  })

  test("se cablea en los tres caminos con deal (nuevo, convertido y avanzado)", () => {
    const llamadas = HITOS.match(/actualizarNotaTranscripcion\(deal\w*, clean\)/g) || []
    assert.ok(llamadas.length >= 3, `esperaba ≥3 llamadas, hay ${llamadas.length}`)
  })
})

describe("cron de reconciliación (la otra mitad: lo que el trigger no ve)", () => {
  const CRON = readFileSync(join(RAIZ, "app/api/vic-crm-hitos-cron/route.ts"), "utf8")
  const VERCEL = readFileSync(join(RAIZ, "vercel.json"), "utf8")

  test("está agendado en Vercel (minuto 15, sin chocar con los otros crons)", () => {
    assert.match(VERCEL, /"\/api\/vic-crm-hitos-cron"/)
    assert.match(VERCEL, /"15 \* \* \* \*"/)
  })

  test("mismo flag que el trigger y con auth de cron", () => {
    assert.match(CRON, /VICKY_CRM_HITOS_ENABLED/)
    assert.match(CRON, /getFollowupCronSecret|CRON_SECRET/)
  })

  test("detecta preform por señales persistidas y reunión REALIZADA por start_at pasado", () => {
    assert.match(CRON, /pref_escalon|formal_quote_id/)
    assert.match(CRON, /reunion_realizada/)
    assert.match(CRON, /start_at=lte\./)
  })

  test("reusa la MISMA función idempotente del trigger", () => {
    assert.match(CRON, /sincronizarHitoCrm\(contact, hito, datos\)/)
  })
})

describe("anti-duplicados (casos SYDA/Vélez/Catalina/Mayra, 28-30 jul)", () => {
  const ZLEADS = readFileSync(join(RAIZ, "lib/zoho-leads.ts"), "utf8")

  test("createZohoLead tiene candado en vic_kv: reutiliza antes de crear", () => {
    assert.match(ZLEADS, /zoho_lead_\$\{fonoCandado\}/)
    assert.match(ZLEADS, /se reutiliza, no se duplica/)
  })

  test("el candado se cierra apenas existe el lead", () => {
    assert.match(ZLEADS, /setKvValue\(kvKeyLead, leadId\)/)
  })

  test("los +52 quedan con territorio México, nunca Chile", () => {
    assert.match(ZLEADS, /startsWith\("52"\)/)
    assert.match(ZLEADS, /Territorio = "México"/)
  })

  test("las tools que crean su propio lead no dejan que el hook duplique", () => {
    assert.match(HITOS, /TOOLS_QUE_CREAN_SU_LEAD/)
    assert.match(HITOS, /opts\.noCrear/)
    assert.match(LOOP, /noCrear: TOOLS_QUE_CREAN_SU_LEAD\.has\(toolName\)/)
  })

  test("el resolver consulta el candado ANTES del search (que tiene lag)", () => {
    assert.match(HITOS, /getKvValue\(`zoho_lead_\$\{fono\}`\)/)
  })
})
