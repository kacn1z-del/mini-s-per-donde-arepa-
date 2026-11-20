// api/probar-facturacion.js
//
// Revisa la configuración de facturación sin emitir nada: variables de Vercel,
// llave criptográfica y usuario de Hacienda. Solo para administradores.
//
// POST /api/probar-facturacion

import { signAndEncode } from '@dojocoding/hacienda-sdk'
import { armarComprobante, emisorDesdeEntorno } from '../lib/comprobante.js'
import { autenticar } from '../lib/firestore-servidor.js'
import { ambiente, probarUsuario } from '../lib/hacienda.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Método no permitido' })
  }

  let perfil
  try {
    ;({ perfil } = await autenticar(req))
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message })
  }
  if (perfil.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' })

  const pasos = []
  const paso = (nombre, ok, detalle = '') => pasos.push({ nombre, ok, detalle })

  paso('Ambiente', true, ambiente() === 'production' ? 'Producción (comprobantes reales)' : 'Pruebas (sandbox de Hacienda)')

  let emisor = null
  try {
    emisor = emisorDesdeEntorno()
    paso('Datos del negocio', true, `${emisor.nombre} · cédula ${emisor.cedula} · régimen ${emisor.regimen} · actividad ${emisor.actividad}`)
  } catch (e) {
    paso('Datos del negocio', false, e.message)
  }

  if (emisor) {
    try {
      const prueba = armarComprobante(
        {
          items: [{ productoId: 'p', nombre: 'Prueba', precio: 1130, cantidad: 1, unidad: 'Unidades' }],
          pagos: [{ metodo: 'efectivo', monto: 1130 }],
        },
        { p: { cabys: '2403000000000', tarifaCodigo: '08' } },
        emisor,
        { consecutivo: 1, terminal: 1 }
      )
      const p12 = Buffer.from(String(process.env.HACIENDA_P12_BASE64 || ''), 'base64')
      if (!p12.length) throw new Error('Falta HACIENDA_P12_BASE64.')
      await signAndEncode(prueba.xml, p12, String(process.env.HACIENDA_P12_PIN || ''))
      paso('Llave criptográfica y PIN', true, 'Firma un comprobante de prueba (no se envía).')
    } catch (e) {
      paso('Llave criptográfica y PIN', false, e.message)
    }
  }

  try {
    await probarUsuario()
    paso('Usuario de Hacienda', true, `Hacienda aceptó ${process.env.HACIENDA_AUTH_USER}.`)
  } catch (e) {
    paso('Usuario de Hacienda', false, e.message)
  }

  const correo = Boolean(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASSWORD)
  paso('Correo a clientes (opcional)', correo, correo ? `Se envía desde ${process.env.EMAIL_SMTP_USER}.` : 'Sin configurar: no se mandan comprobantes por correo.')

  const listo = pasos.filter((p) => p.nombre !== 'Correo a clientes (opcional)').every((p) => p.ok)
  return res.status(200).json({ listo, pasos })
}
