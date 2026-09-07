/**
 * Datos del CLIENTE que ya viven en la conversación (nombre, empresa, correo,
 * dotación y RUT), para que el CRM no nazca ciego.
 *
 * Caso Conbes/Aracelli + Diego/Aleydis (07-sep): el traspaso del reloj creaba
 * el lead como "Prospecto WhatsApp / Por identificar" aunque el chat ya tenía
 * 30 personas y RUT desde dos horas antes, y lo clasificaba "sin calificar".
 * El extractor es el mismo del enriquecedor del ptv-cron (Haiku + validador de
 * RUT sobre lo que escribió el cliente), compartido acá para usarlo ANTES de
 * crear el lead y no después.
 */
import type { DatosConversacion } from "./crm-hitos"

export async function extraerDatosLeadDeChat(
  dialogo: string,
  apiKey: string,
): Promise<{ nombre?: string; empresa?: string; email?: string; trabajadores?: number } | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system:
          "Extrae datos del CLIENTE desde una conversación de ventas por WhatsApp. Responde SOLO un JSON válido con esta forma exacta: " +
          '{"nombre": string|null, "empresa": string|null, "email": string|null, "trabajadores": number|null}. ' +
          "Reglas: usa ÚNICAMENTE lo que el CLIENTE dijo explícitamente (nunca inventes ni infieras del contexto de Vicky); " +
          "nombre = nombre de la persona (no de la empresa); trabajadores = cantidad de personas de su empresa si la dijo; " +
          "null en todo campo que no aparezca claro. Sin texto adicional fuera del JSON.",
        messages: [{ role: "user", content: dialogo }],
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => ({}))) as { content?: Array<{ text?: string }> }
    const texto = data?.content?.[0]?.text || ""
    const m = texto.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0]) as Record<string, unknown>
    return {
      nombre: typeof j.nombre === "string" && j.nombre.trim() ? j.nombre.trim() : undefined,
      empresa: typeof j.empresa === "string" && j.empresa.trim() ? j.empresa.trim() : undefined,
      email: typeof j.email === "string" && /@/.test(j.email) ? j.email.trim() : undefined,
      trabajadores: typeof j.trabajadores === "number" && j.trabajadores > 0 ? j.trabajadores : undefined,
    }
  } catch {
    return null
  }
}

export type DatosDelChat = DatosConversacion & { rutEnChat: boolean; tieneAlgo: boolean }

/**
 * Lee los últimos 40 mensajes de la conversación y devuelve lo que el cliente
 * ya dijo. El RUT NO se le pide al modelo: sale del validador de dígito
 * verificador sobre los mensajes del CLIENTE (incluye descripciones de fotos,
 * que van como mensaje del cliente). `soloSiHayRut` evita la llamada al
 * modelo cuando no hay RUT (el webhook lo consulta en cada turno).
 */
export async function datosDelChat(contact: string, opts: { soloSiHayRut?: boolean } = {}): Promise<DatosDelChat> {
  const clean = (contact || "").replace(/\D/g, "")
  const vacio: DatosDelChat = { rutEnChat: false, tieneAlgo: false }
  try {
    const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
    const historial = await fetchHistoryV3(clean, 40)
    const filas = historial.filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
    const soloCliente = filas
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .join("\n")
    if (!soloCliente.trim()) return vacio
    let rut: string | undefined
    if (clean.startsWith("56")) {
      const { rutEnTexto } = await import("./empresas-sii")
      rut = rutEnTexto(soloCliente) || undefined
    }
    if (opts.soloSiHayRut && !rut) return vacio
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    const dialogo = filas
      .map((m) => `${m.role === "user" ? "CLIENTE" : "VICKY"}: ${String(m.content || "").slice(0, 300)}`)
      .join("\n")
      .slice(0, 6000)
    const ex = apiKey ? await extraerDatosLeadDeChat(dialogo, apiKey) : null
    const out: DatosDelChat = {
      nombre: ex?.nombre,
      empresa: ex?.empresa,
      email: ex?.email,
      empleados: ex?.trabajadores,
      rut,
      rutEnChat: Boolean(rut),
      tieneAlgo: Boolean(rut || ex?.nombre || ex?.empresa || ex?.trabajadores || ex?.email),
    }
    return out
  } catch (e) {
    console.warn(`[extraer-datos-chat] ${clean}:`, e instanceof Error ? e.message : e)
    return vacio
  }
}
