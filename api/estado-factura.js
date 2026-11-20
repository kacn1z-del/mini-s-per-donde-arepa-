// api/estado-factura.js
//
// Consulta en Hacienda el estado de un comprobante ya enviado y lo guarda.
// Si quedó aceptado y el cliente dejó correo, se lo manda.
//
// POST /api/estado-factura   body: { "pedidoId": "...", "reenviarCorreo": false }

import { emisorDesdeEntorno } from '../lib/comprobante.js'
import { autenticar } from '../lib/firestore-servidor.js'
import { consultar } from '../lib/hacienda.js'
import { enviarCorreoComprobante } from '../lib/correo-factura.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Método no permitido' })
  }

  let db
  try {
    ;({ db } = await autenticar(req))
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message })
  }

  const { pedidoId, reenviarCorreo = false } = req.body || {}
  if (!pedidoId) return res.status(400).json({ error: 'Falta pedidoId' })
  const ruta = `pedidos/${pedidoId}`

  try {
    const { datos: venta } = await db.leer(ruta)
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' })
    if (!venta.facturaClave || !venta.facturaEnviada) {
      return res.status(409).json({ error: 'Esta venta todavía no se ha enviado a Hacienda.' })
    }

    let estado = venta.facturaEstado
    let respuestaXml = venta.facturaRespuestaXml || null
    let motivo = venta.facturaError || null

    if (estado !== 'aceptado' && estado !== 'rechazado') {
      const r = await consultar(venta.facturaClave)
      estado = r.estado === 'procesando' ? 'enviado' : r.estado
      respuestaXml = r.respuestaXml || respuestaXml
      motivo = r.estado === 'rechazado' ? r.motivo : null
      await db.actualizar(ruta, { facturaEstado: estado, facturaRespuestaXml: respuestaXml, facturaError: motivo })
    }

    let correo = null
    const debeEnviar = estado === 'aceptado' && venta.cliente?.correo && (reenviarCorreo || !venta.facturaCorreoEnviado)
    if (debeEnviar) {
      try {
        correo = await enviarCorreoComprobante({ venta: { ...venta, facturaRespuestaXml: respuestaXml }, emisor: emisorDesdeEntorno() })
      } catch (e) {
        correo = { enviado: false, motivo: e.message }
      }
      await db.actualizar(ruta, { facturaCorreoEnviado: correo.enviado, facturaCorreoMotivo: correo.motivo || null })
    }

    return res.status(200).json({ estado, clave: venta.facturaClave, consecutivo: venta.facturaConsecutivo, motivo, correo })
  } catch (e) {
    console.error('Error consultando estado', pedidoId, e)
    return res.status(500).json({ error: e.message })
  }
}
