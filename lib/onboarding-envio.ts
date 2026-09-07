/**
 * Entrega del mensaje de arranque del onboarding.
 *
 * VIVE APARTE DE onboarding-canal.ts A PROPÓSITO: ese módulo importa
 * `dispatchTool` de ./tools, y ./tools importa registrar-comprobante, que a su
 * vez necesita esta función. El ciclo rompía `next build` con un
 * "Cannot access before initialization" que ni tsc ni los tests veían — solo
 * aparece al armar el grafo real del bundle. Acá no hay nada de ./tools, así
 * que el ciclo no existe.
 */

import { getKvValue, getLastUserAt } from "./supabase-persistence-v3"
import { sendBotmakerMessage, sendBotmakerTemplate } from "./botmaker-push-v3"
import {
  PLANTILLA_ALTA_FLOW_CL,
  PLANTILLA_ONBOARDING_CL,
  paramsPlantillaAltaFlow,
  paramsPlantillaOnboarding,
  renderPlantillaOnboarding,
} from "./onboarding/plantilla"

// El kickoff del alta es TRANSACCIONAL (07-sep, caso TESLA AUSTRAL): el
// cliente acaba de pagar y este mensaje es la consecuencia directa. El gate de
// proactividad lo registra pero no lo bloquea — el anti-ráfaga (la presentación
// del traspaso salió minutos antes) dejó a un pagador sin formulario de alta.
const TRANSACCIONAL = { transaccional: true } as const

/**
 * Entrega el kickoff del onboarding respetando la ventana de 24 h de WhatsApp.
 *
 * Dentro de ventana: texto libre, con el mensaje completo.
 * Fuera de ventana: el texto libre moriría en silencio, así que va la plantilla
 * HSM — que no lleva el alta, solo reabre la ventana. Cuando el cliente
 * responde, el webhook lo encuentra en fase onboarding y el agente sigue.
 *
 * Devuelve cómo salió, para que el llamador lo registre en el historial solo
 * cuando corresponda (la plantilla no es el mensaje de Vicky).
 */
export async function entregarKickoffOnboarding(
  contact: string,
  empresa?: string,
  rut?: string,
  nombreCliente?: string,
): Promise<{ via: "texto" | "plantilla" | "flow" | "fallo"; texto: string }> {
  // ALTA POR FORMULARIO (28-ago): con el gate encendido, el kickoff es la
  // plantilla con botón FLOW (alta_cuenta_v2_flow) — dentro o fuera de
  // ventana da igual, las plantillas entran siempre. Gate en vic_kv para
  // encender SIN deploy recién cuando Meta apruebe la clv4 (una plantilla
  // PENDING se "acepta" y se bota — cicatriz 25-ago). Si el envío falla,
  // sigue el camino clásico conversacional: nadie se queda sin alta.
  const flowOn = ((await getKvValue("alta_flow_kickoff").catch(() => null)) || "").trim() === "on"
  if (flowOn) {
    const params = paramsPlantillaAltaFlow(nombreCliente, empresa)
    // HÍBRIDO POR VENTANA (Lalo 28-ago): con ventana VENCIDA (designado frío)
    // el botón FLOW directo abre un formulario cuyo cierre no puede retomar el
    // chat (Meta 131047) — va la plantilla QUICK-REPLY: su tap es mensaje del
    // usuario (abre ventana) y el intent de Botmaker manda el flow en sesión
    // con identificación garantizada. Gate vic_kv `alta_qr_intent` = "on"
    // (recién cuando el bloque #altaflow→v3 esté cableado en Botmaker); sin
    // gate o si la QR falla, cae a la plantilla FLOW de siempre.
    const ultimoMsg = await getLastUserAt(contact).catch(() => null)
    const ventanaViva = !!ultimoMsg && Date.now() - ultimoMsg.getTime() < 23 * 3600e3
    const qrOn = ((await getKvValue("alta_qr_intent").catch(() => null)) || "").trim() === "on"
    if (!ventanaViva && qrOn) {
      // SIEMBRA de variables alta_* ANTES de la plantilla (28-ago noche): el
      // tap del botón dispara el intent #altaflow directo en Botmaker (no pasa
      // por este webhook), así que el bloque interpola ${alta_*} — que deben
      // estar sembradas de antes. trigger-intent exige un intent: se usa el
      // flujo VACÍO #setvars (no manda mensajes; solo aplica las variables).
      try {
        const { triggerBotmakerIntent } = await import("./botmaker-push-v3")
        const { getFollowupCronSecret } = await import("./supabase-persistence-v3")
        const secreto = await getFollowupCronSecret()
        const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
        const r = await fetch(`${base}/api/vic-onboarding-flow?key=${encodeURIComponent(secreto)}&contact=${contact}`, { cache: "no-store" })
        const prefill = ((await r.json().catch(() => ({}))) as { prefill?: Record<string, unknown> }).prefill || {}
        const v = (k: string) => String(prefill[k] ?? "")
        await triggerBotmakerIntent(contact, "#setvars", {
          // Primer nombre para personalizar el MENSAJE del bloque (la entrega
          // del formulario saluda por nombre — doble paso con progresión, no eco).
          alta_nombre: (v("admin_nombre").trim().split(/\s+/)[0] || "").trim(),
          alta_razon: v("razon_social"),
          alta_rut: v("rut_empresa"),
          alta_giro: v("giro"),
          alta_direccion: v("direccion"),
          alta_comuna: v("comuna"),
          alta_campos: String(prefill["mostrar_campos_empresa"] !== false),
          alta_fono: contact,
        })
      } catch (e) {
        console.warn(`[onboarding-envio] siembra de variables alta_* falló para ${contact}:`, e instanceof Error ? e.message : e)
      }
      const { PLANTILLA_ALTA_QR_CL } = await import("./onboarding/plantilla")
      const okQr = await sendBotmakerTemplate(contact, PLANTILLA_ALTA_QR_CL.name, params, undefined, TRANSACCIONAL).catch(() => false)
      if (okQr) return { via: "flow", texto: "" }
      console.warn(`[onboarding-envio] plantilla QR falló para ${contact}; se intenta la plantilla FLOW`)
    }
    const okFlow = await sendBotmakerTemplate(contact, PLANTILLA_ALTA_FLOW_CL.name, params, undefined, TRANSACCIONAL).catch(() => false)
    if (okFlow) return { via: "flow", texto: "" }
    console.warn(`[onboarding-envio] plantilla flow falló para ${contact}; kickoff clásico de respaldo`)
  }
  const params = paramsPlantillaOnboarding(empresa, rut)
  const texto = renderPlantillaOnboarding(params)

  const ultimo = await getLastUserAt(contact).catch(() => null)
  const abierta = !!ultimo && Date.now() - ultimo.getTime() < 24 * 3600e3
  if (abierta) {
    const ok = await sendBotmakerMessage(contact, texto, undefined, TRANSACCIONAL).catch(() => false)
    if (ok) return { via: "texto", texto }
    // La ventana pudo cerrarse entre la consulta y el envío: se reintenta por
    // plantilla antes de darlo por perdido.
  }
  const ok = await sendBotmakerTemplate(
    contact,
    PLANTILLA_ONBOARDING_CL.name,
    params,
    undefined,
    TRANSACCIONAL,
  ).catch(() => false)
  return { via: ok ? "plantilla" : "fallo", texto }
}
