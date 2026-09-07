/**
 * ESQUEMA DE OPERACIÓN — las definiciones que el relator necesita para dejar
 * la plataforma configurada en la capacitación (lista de Ignacio Salinas,
 * 07-sep, vía Lalo). Módulo PURO: solo tipos, la lista de preguntas y los
 * textos; el estado vive en vic_kv y lo administra el canal.
 *
 * REGLA (Lalo 07-sep): NO es obligatorio. Vicky lo ofrece UNA vez como
 * mensaje informativo ("ten a mano estas definiciones para tu capacitación")
 * y registra lo que el cliente quiera contar; lo que no responda, lo ve con
 * el relator. Nada de esto bloquea la nómina, la capacitación ni el cierre.
 */

export const PREGUNTAS_ESQUEMA = [
  { id: "periodoPago", corta: "Período de pago", pregunta: "¿Cuál es el período de fecha de pago (mensual, quincenal, semanal) y qué día cierra?" },
  { id: "permisosGoceJustificanHoras", corta: "Permisos con goce", pregunta: "¿Los permisos con goce de sueldo justifican las horas no trabajadas?" },
  { id: "descuentoAtrasoAdelanto", corta: "Descuento atraso / adelanto", pregunta: "¿Se descuenta el atraso a la entrada y el adelanto a la salida?" },
  { id: "colacion", corta: "Colación", pregunta: "¿Cómo es la colación (minutos, horario) y se descuenta si se pasan del tiempo?" },
  { id: "ausenciaSinPermisoNiMarca", corta: "Ausencias", pregunta: "¿Un turno sin permiso y sin marca se considera ausencia?" },
  { id: "compensaAtrasosConSalidas", corta: "Atrasos vs salidas tardías", pregunta: "¿Los atrasos se compensan con salidas más tarde?" },
  { id: "compensaAdelantosConEntradas", corta: "Adelantos vs entradas tempranas", pregunta: "¿Los adelantos de salida se compensan con entradas más temprano?" },
  { id: "compensacionExtrasPeriodo", corta: "Extras: diaria o semanal", pregunta: "¿La compensación de horas extras se calcula por día o por semana?" },
  { id: "extrasTodasAl50", corta: "Recargo de extras", pregunta: "¿Todas las horas extras van al 50 % o hay otros recargos?" },
  { id: "trabajanFeriados", corta: "Feriados", pregunta: "¿Trabajan los feriados? ¿Cómo se pagan?" },
] as const

export type IdPreguntaEsquema = (typeof PREGUNTAS_ESQUEMA)[number]["id"]

/** Respuestas TAL CUAL las dio el cliente (texto libre, sin normalizar). */
export type EsquemaOperacion = Partial<Record<IdPreguntaEsquema, string>> & {
  /** Comentario libre del cliente sobre su operación que no calce en las 10. */
  nota?: string
  /** true cuando el cliente dijo explícitamente que prefiere verlo en la capacitación. */
  loVeEnCapacitacion?: boolean
  /** ISO de la última actualización (lo pone el canal). */
  actualizadoAt?: string
}

export function esquemaVacio(): EsquemaOperacion {
  return {}
}

/** Fusiona lo nuevo sobre lo guardado: un campo vacío NUNCA pisa uno respondido. */
export function fusionarEsquema(previo: EsquemaOperacion, nuevo: EsquemaOperacion): EsquemaOperacion {
  const out: EsquemaOperacion = { ...previo }
  for (const p of PREGUNTAS_ESQUEMA) {
    const v = String(nuevo[p.id] ?? "").trim()
    if (v) out[p.id] = v
  }
  const nota = String(nuevo.nota ?? "").trim()
  if (nota) out.nota = previo.nota && previo.nota !== nota ? `${previo.nota}\n${nota}` : nota
  if (nuevo.loVeEnCapacitacion === true) out.loVeEnCapacitacion = true
  return out
}

export function respondidasEsquema(e: EsquemaOperacion): (typeof PREGUNTAS_ESQUEMA)[number][] {
  return PREGUNTAS_ESQUEMA.filter((p) => String(e[p.id] ?? "").trim())
}

export function pendientesEsquema(e: EsquemaOperacion): (typeof PREGUNTAS_ESQUEMA)[number][] {
  return PREGUNTAS_ESQUEMA.filter((p) => !String(e[p.id] ?? "").trim())
}

/** Texto para la nota de la implementación: qué se respondió y qué no. */
export function resumenEsquema(e: EsquemaOperacion): string {
  const resp = respondidasEsquema(e)
  const pend = pendientesEsquema(e)
  const lineas: string[] = []
  lineas.push(`Definiciones para la capacitación: ${resp.length}/${PREGUNTAS_ESQUEMA.length} respondidas por chat`)
  for (const p of resp) lineas.push(`  ✅ ${p.corta}: ${String(e[p.id]).trim()}`)
  if (e.nota) lineas.push(`  • Otros: ${e.nota}`)
  if (pend.length) {
    lineas.push(
      `  ❌ Por definir en la capacitación${e.loVeEnCapacitacion ? " (el cliente prefirió verlo ahí)" : ""}: ` +
        pend.map((p) => p.corta).join(" · "),
    )
  }
  return lineas.join("\n")
}

/**
 * El mensaje informativo (UNA sola vez, no insiste). Sin nombres de personas
 * salvo el relator, que el cliente ya conoce por la capacitación.
 */
export function mensajeInvitacionEsquema(nombreRelator?: string): string {
  const quien = nombreRelator ? `con ${nombreRelator}` : "con tu relator"
  return (
    `Para que tu capacitación ${quien} salga con la plataforma ya ajustada a tu operación, ayuda tener a mano estas definiciones:\n` +
    PREGUNTAS_ESQUEMA.map((p, i) => `${i + 1}. ${p.pregunta}`).join("\n") +
    `\n\nNo es obligatorio: si quieres me cuentas ahora las que tengas claras y se las dejo anotadas al relator; las demás las ven juntos en la sesión.`
  )
}

/** Bloque para el system prompt: estado + regla de uso (no bloqueante). */
export function bloquePromptEsquema(e: EsquemaOperacion, opts: { yaOfrecido: boolean; nombreRelator?: string }): string {
  const resp = respondidasEsquema(e)
  const pend = pendientesEsquema(e)
  const estado =
    resp.length === 0
      ? "Ninguna respondida todavía."
      : `Respondidas: ${resp.map((p) => p.corta).join(", ")}.` + (pend.length ? ` Faltan: ${pend.map((p) => p.corta).join(", ")}.` : " Todas respondidas.")
  return (
    "\n# Definiciones para la capacitación (OPCIONAL, informativo)\n" +
    "Existen 10 definiciones de su operación que el relator usará en la capacitación (período de pago, " +
    "permisos con goce, descuento de atrasos/adelantos, colación, ausencias, compensaciones, horas " +
    "extras, feriados). Regla: NO son obligatorias y NUNCA bloquean nada. " +
    (opts.yaOfrecido
      ? "Ya se le ofrecieron: no vuelvas a mandarlas completas. Si el cliente responde alguna espontáneamente, guárdala."
      : "Ofrécelas UNA sola vez, en un mensaje aparte, cuando la nómina ya esté resuelta (cargada o dejada para después) " +
        "o cuando la capacitación quede agendada, con la tool registrar_esquema_operacion(ofrecer=true), que te devuelve el " +
        "texto exacto a enviar. No insistas después.") +
    " Cada respuesta que dé el cliente (aunque sea una sola, o parcial) → registrar_esquema_operacion con el texto TAL CUAL. " +
    "Si dice que prefiere verlo en la capacitación, regístralo con loVeEnCapacitacion=true y no insistas.\n" +
    `Estado: ${estado}` +
    (opts.nombreRelator ? ` Relator: ${opts.nombreRelator}.` : "")
  )
}
