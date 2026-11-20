// lib/hacienda.js
//
// Conexión con la API de comprobantes de Hacienda (TRIBU-CR, v4.4):
// token, envío y consulta de estado. Mismo método que funciona en Los Pirchas.

export function ambiente() {
  return String(process.env.HACIENDA_ENVIRONMENT || 'sandbox').trim() === 'production' ? 'production' : 'sandbox'
}

const URL_API = {
  sandbox: 'https://api-sandbox.comprobanteselectronicos.go.cr/recepcion/v1',
  production: 'https://api.comprobanteselectronicos.go.cr/recepcion/v1',
}

const URL_TOKEN = {
  sandbox: 'https://idp.comprobanteselectronicos.go.cr/auth/realms/rut-stag/protocol/openid-connect/token',
  production: 'https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token',
}

const CLIENTE = { sandbox: 'api-stag', production: 'api-prod' }

let tokenGuardado = null
let tokenVence = 0

async function token() {
  if (tokenGuardado && Date.now() < tokenVence) return tokenGuardado
  const usuario = String(process.env.HACIENDA_AUTH_USER || '').trim()
  const clave = String(process.env.HACIENDA_PASSWORD || '')
  if (!usuario || !clave) throw new Error('Faltan HACIENDA_AUTH_USER o HACIENDA_PASSWORD en Vercel.')

  const amb = ambiente()
  const res = await fetch(URL_TOKEN[amb], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: CLIENTE[amb], username: usuario, password: clave }).toString(),
  })
  if (!res.ok) {
    const texto = await res.text().catch(() => '')
    throw new Error(
      `Hacienda no aceptó el usuario y clave de comprobantes (${res.status}). ` +
        `Revisá HACIENDA_AUTH_USER y HACIENDA_PASSWORD. ${texto.slice(0, 200)}`
    )
  }
  const datos = await res.json()
  tokenGuardado = datos.access_token
  tokenVence = Date.now() + (Number(datos.expires_in || 280) - 30) * 1000
  return tokenGuardado
}

export async function enviar({ clave, fecha, emisor, receptor, xmlFirmadoBase64 }) {
  const cuerpo = {
    clave,
    fecha: fecha.toISOString(),
    emisor: { tipoIdentificacion: emisor.tipoCedula, numeroIdentificacion: emisor.cedula },
    comprobanteXml: xmlFirmadoBase64,
  }
  if (receptor?.cedula) {
    cuerpo.receptor = { tipoIdentificacion: receptor.tipo || '01', numeroIdentificacion: String(receptor.cedula).replace(/\D/g, '') }
  }
  const res = await fetch(`${URL_API[ambiente()]}/recepcion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  if (res.status === 201 || res.status === 202) return
  const detalle = res.headers.get('x-error-cause') || (await res.text().catch(() => ''))
  // Ya se había recibido esa clave: se sigue con la consulta de estado
  if (res.status === 400 && /ya fue recibido|already/i.test(detalle)) return
  throw new Error(`Hacienda no recibió el comprobante (${res.status}): ${detalle}`.slice(0, 500))
}

// Devuelve { estado: 'aceptado' | 'rechazado' | 'procesando', motivo, respuestaXml }
export async function consultar(clave) {
  const res = await fetch(`${URL_API[ambiente()]}/recepcion/${clave}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  })
  if (res.status === 404) return { estado: 'procesando' }
  if (!res.ok) throw new Error(`No se pudo consultar el estado en Hacienda (${res.status}).`)
  const datos = await res.json()
  const ind = String(datos['ind-estado'] || '').toLowerCase()
  const respuestaXml = datos['respuesta-xml'] || null
  if (ind === 'aceptado') return { estado: 'aceptado', respuestaXml }
  if (ind === 'rechazado') {
    let motivo = 'Rechazado por Hacienda'
    try {
      const xml = Buffer.from(respuestaXml, 'base64').toString('utf8')
      const m = xml.match(/<DetalleMensaje>([\s\S]*?)<\/DetalleMensaje>/i)
      if (m) motivo = m[1].trim().slice(0, 1000)
    } catch {
      // se deja el motivo genérico
    }
    return { estado: 'rechazado', motivo, respuestaXml }
  }
  return { estado: 'procesando' }
}

// Espera un rato la respuesta de Hacienda; si no llega, queda "enviado"
export async function esperarRespuesta(clave, msMax = 15000) {
  const limite = Date.now() + msMax
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 2500))
    try {
      const r = await consultar(clave)
      if (r.estado !== 'procesando') return r
    } catch {
      // se reintenta en la siguiente vuelta
    }
  }
  return { estado: 'procesando' }
}

// Solo pide el token: sirve para comprobar el usuario y la clave de Hacienda
export async function probarUsuario() {
  tokenGuardado = null
  await token()
}
