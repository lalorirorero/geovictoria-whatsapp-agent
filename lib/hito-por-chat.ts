/**
 * HITO DE INTENCIÓN SIN TOOL (arreglo 2, VB Lalo 07-sep).
 *
 * En el guion consultivo 21+ Vicky conversa varios turnos sin llamar ninguna
 * tool, y los hitos del CRM solo se disparaban con tools: un cliente con
 * dotación y RUT dados a las 07:55 (Conbes) no existía en Zoho a las 10:00,
 * y el traspaso del reloj lo creó ciego y lo entregó a las SDR. Acá, apenas
 * el chat tiene un RUT válido del cliente, se dispara el hito "intencion" con
 * lo que ya dijo (nombre/empresa/dotación/correo/RUT): la escalera del CRM
 * decide sola — RUT + >20 → deal + Tómbola Deals; ≤20 → lead pre-formal con
 * Vicky (el deal nace con la formal, regla intacta).
 *
 * Una sola vez por conversación (candado kv `hito_chat_<fono>`). Best-effort:
 * jamás toca la respuesta al cliente.
 */
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export async function hitoIntencionDesdeChat(contact: string): Promise<"disparado" | "sin_rut" | "ya" | "omitido"> {
  const clean = (contact || "").replace(/\D/g, "")
  if (!clean.startsWith("56")) return "omitido"
  const candado = `hito_chat_${clean}`
  try {
    if (await getKvValue(candado)) return "ya"
    const { datosDelChat } = await import("./extraer-datos-chat")
    const datos = await datosDelChat(clean, { soloSiHayRut: true })
    if (!datos.rut) return "sin_rut"
    await setKvValue(candado, new Date().toISOString()).catch(() => {})
    const { sincronizarHitoCrm } = await import("./crm-hitos")
    await sincronizarHitoCrm(clean, "intencion", {
      nombre: datos.nombre,
      empresa: datos.empresa,
      email: datos.email,
      rut: datos.rut,
      empleados: datos.empleados,
    })
    console.log(
      `[hito-por-chat] ${clean}: hito intencion por RUT en el chat (empleados=${datos.empleados ?? "?"}, empresa=${datos.empresa || "?"})`,
    )
    return "disparado"
  } catch (e) {
    console.warn(`[hito-por-chat] ${clean}:`, e instanceof Error ? e.message : e)
    return "omitido"
  }
}
