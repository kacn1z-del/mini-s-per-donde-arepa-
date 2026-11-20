// api/facturar.js
//
// Emite ante Hacienda el comprobante electrónico de una venta de la caja.
// Lo llama la caja apenas se cobra, y el admin para reintentar.
//
// POST /api/facturar   body: { "pedidoId": "..." }   (con la sesión del usuario)

import { signAndEncode } from '@dojocoding/hacienda-sdk'
import { armarComprobante, emisorDesdeEntorno, problemasDeVenta } from '../lib/comprobante.js'
import { autenticar, siguienteConsecutivo } from '../lib/firestore-servidor.js'
import { ambiente, enviar, esperarRespuesta } from '../lib/hacienda.js'
import { enviarCorreoComprobante } from '../lib/correo-factura.js'

// Estados en que la venta ya tiene comprobante en Hacienda
const YA_ENVIADA = ['enviado', 'aceptado']
const BLOQUEO_MS = 2 * 60 * 1000

function responder(res, status, datos) {
  return res.status(status).json(datos)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return responder(res, 405, { error: 'Método no permitido' })
  }

  let db
  try {
    ;({ db } = await autenticar(req))
  } catch (e) {
    return responder(res, e.status || 401, { error: e.message })
  }

  const { pedidoId } = req.body || {}
  if (!pedidoId) return responder(res, 400, { error: 'Falta pedidoId' })
  const ruta = `pedidos/${pedidoId}`

  try {
    const config = (await db.leer('configuracion/facturacion')).datos || {}
    if (!config.activa) return responder(res, 409, { error: 'La facturación electrónica está apagada.' })

    const { datos: venta, version } = await db.leer(ruta)
    if (!venta) return responder(res, 404, { error: 'Venta no encontrada' })
    if (venta.estado !== 'cobrado') return responder(res, 409, { error: 'Solo se facturan ventas cobradas.' })
    if (YA_ENVIADA.includes(venta.facturaEstado)) {
      return responder(res, 200, { estado: venta.facturaEstado, clave: venta.facturaClave, consecutivo: venta.facturaConsecutivo, tipo: venta.facturaTipo })
    }

    // Ya llegó a Hacienda en un intento que se cortó después: no se emite otro, solo se consulta
    if (venta.facturaEnviada && venta.facturaClave && venta.facturaEstado !== 'rechazado') {
      await db.actualizar(ruta, { facturaEstado: 'enviado', facturaError: null }, { version })
      return responder(res, 200, { estado: 'enviado', clave: venta.facturaClave, consecutivo: venta.facturaConsecutivo, tipo: venta.facturaTipo })
    }

    // Evita que dos pantallas emitan la misma venta a la vez
    const enCurso = venta.facturaEstado === 'emitiendo' && Date.now() - new Date(venta.facturaIntentoEn || 0).getTime() < BLOQUEO_MS
    if (enCurso) return responder(res, 409, { error: 'Esta venta ya se está enviando a Hacienda.' })
    try {
      await db.actualizar(ruta, { facturaEstado: 'emitiendo', facturaIntentoEn: new Date() }, { version })
    } catch {
      return responder(res, 409, { error: 'La venta cambió mientras se facturaba. Intentá de nuevo.' })
    }

    const emisor = emisorDesdeEntorno()

    // Productos actuales (CABYS y tarifa)
    const productos = {}
    for (const id of [...new Set((venta.items || []).map((i) => i.productoId))]) {
      productos[id] = (await db.leer(`productos/${id}`)).datos || {}
    }
    const problemas = problemasDeVenta(venta, productos)
    if (problemas.length) {
      await db.actualizar(ruta, { facturaEstado: 'faltan_datos', facturaError: problemas.join(' ') })
      return responder(res, 422, { estado: 'faltan_datos', error: problemas.join(' ') })
    }

    // Terminal = número de la caja (cada caja lleva su propia numeración)
    const caja = venta.cajaId ? (await db.leer(`cajas/${venta.cajaId}`)).datos : null
    const terminal = Math.max(1, Math.min(99999, Number(caja?.numero) || 1))
    const esFactura = Boolean(venta.cliente?.cedula)
    const tipoDoc = esFactura ? '01' : '04'

    // Si un intento anterior se cortó antes de llegar a Hacienda, se reusa su número.
    // Si fue rechazado, se emite uno nuevo que lo sustituye.
    const reusar = venta.facturaEstado === 'error' && venta.facturaNumero && venta.facturaTipoDoc === tipoDoc && venta.facturaTerminal === terminal && !venta.facturaEnviada
    const numero = reusar ? venta.facturaNumero : await siguienteConsecutivo(db, `${ambiente()}_${tipoDoc}_${emisor.sucursal}_${terminal}`)
    const fecha = reusar && venta.facturaFecha ? new Date(venta.facturaFecha) : new Date()
    const rechazado = venta.facturaEstado === 'rechazado' && venta.facturaClave
      ? { clave: venta.facturaClave, tipoDoc: venta.facturaTipoDoc || '04', fecha: venta.facturaFecha || fecha }
      : null

    const comprobante = armarComprobante(venta, productos, emisor, {
      consecutivo: numero,
      terminal,
      fecha,
      rechazado,
      clave: reusar ? venta.facturaClave : null,
    })

    // Se guarda el número antes de enviar: si algo falla, el reintento usa el mismo
    await db.actualizar(ruta, {
      facturaNumero: numero,
      facturaTerminal: terminal,
      facturaTipoDoc: tipoDoc,
      facturaTipo: comprobante.tipo,
      facturaFecha: fecha,
      facturaClave: comprobante.clave,
      facturaConsecutivo: comprobante.numeroConsecutivo,
      facturaAmbiente: ambiente(),
      facturaEnviada: false,
      facturaError: null,
      facturaRechazadaAnterior: rechazado?.clave || null,
    })

    const p12 = Buffer.from(String(process.env.HACIENDA_P12_BASE64 || ''), 'base64')
    if (!p12.length) throw new Error('Falta HACIENDA_P12_BASE64 (la llave criptográfica) en Vercel.')
    const xmlFirmado = await signAndEncode(comprobante.xml, p12, String(process.env.HACIENDA_P12_PIN || ''))

    await enviar({ clave: comprobante.clave, fecha, emisor, receptor: venta.cliente, xmlFirmadoBase64: xmlFirmado })
    await db.actualizar(ruta, { facturaEstado: 'enviado', facturaEnviada: true, facturaXml: xmlFirmado })

    // Se espera unos segundos la respuesta; si tarda, se consulta después
    const respuesta = await esperarRespuesta(comprobante.clave, 12000)
    const final = {
      facturaEstado: respuesta.estado === 'procesando' ? 'enviado' : respuesta.estado,
      facturaRespuestaXml: respuesta.respuestaXml || null,
      facturaError: respuesta.estado === 'rechazado' ? respuesta.motivo : null,
    }
    await db.actualizar(ruta, final)

    let correo = null
    if (final.facturaEstado === 'aceptado' && venta.cliente?.correo) {
      try {
        correo = await enviarCorreoComprobante({
          venta: { ...venta, facturaTipo: comprobante.tipo, facturaClave: comprobante.clave, facturaConsecutivo: comprobante.numeroConsecutivo, facturaXml: xmlFirmado, facturaRespuestaXml: final.facturaRespuestaXml },
          emisor,
        })
      } catch (e) {
        correo = { enviado: false, motivo: e.message }
      }
      await db.actualizar(ruta, { facturaCorreoEnviado: correo.enviado, facturaCorreoMotivo: correo.motivo || null })
    }

    return responder(res, 200, {
      estado: final.facturaEstado,
      clave: comprobante.clave,
      consecutivo: comprobante.numeroConsecutivo,
      tipo: comprobante.tipo,
      motivo: final.facturaError,
      correo,
    })
  } catch (e) {
    console.error('Error facturando', pedidoId, e)
    try {
      await db.actualizar(ruta, { facturaEstado: 'error', facturaError: String(e.message || e).slice(0, 1000) })
    } catch {
      // si ni siquiera se puede guardar el error, se devuelve igual
    }
    return responder(res, 500, { estado: 'error', error: e.message })
  }
}
