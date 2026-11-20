// lib/correo-factura.js
//
// Manda al cliente su comprobante aceptado por Hacienda: el detalle en el
// correo y, adjuntos, el XML firmado y la respuesta de Hacienda.

import nodemailer from 'nodemailer'

const colones = (n) =>
  '₡' + Number(n || 0).toLocaleString('es-CR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const escapar = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

let transporte = null
function getTransporte() {
  if (!transporte) {
    transporte = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASSWORD },
    })
  }
  return transporte
}

export async function enviarCorreoComprobante({ venta, emisor }) {
  const para = venta.cliente?.correo
  if (!para) return { enviado: false, motivo: 'La venta no tiene correo del cliente.' }
  if (!process.env.EMAIL_SMTP_USER || !process.env.EMAIL_SMTP_PASSWORD) {
    return { enviado: false, motivo: 'Faltan EMAIL_SMTP_USER y EMAIL_SMTP_PASSWORD en Vercel.' }
  }

  const tipo = venta.facturaTipo === 'factura' ? 'Factura electrónica' : 'Tiquete electrónico'
  const nombreNegocio = emisor.nombreComercial || emisor.nombre
  const filas = (venta.items || [])
    .map((i) => {
      const cantidad = i.unidad === 'Kg' ? `${Number(i.cantidad).toFixed(3)} kg` : i.cantidad
      const subtotal = Math.round(Number(i.precio) * Number(i.cantidad))
      return `<tr><td>${escapar(cantidad)} × ${escapar(i.nombre)}</td><td style="text-align:right">${colones(subtotal)}</td></tr>`
    })
    .join('')

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px">
      <h2 style="margin:0">${escapar(nombreNegocio)}</h2>
      <p>${tipo} N.º ${escapar(venta.facturaConsecutivo)}<br>
      Clave: <span style="font-family:monospace;font-size:12px">${escapar(venta.facturaClave)}</span></p>
      <table style="width:100%;border-collapse:collapse">${filas}</table>
      <p style="font-size:18px"><strong>Total: ${colones(venta.total)}</strong></p>
      <p style="color:#555;font-size:12px">Adjuntamos el comprobante electrónico (XML) y la respuesta de aceptación del Ministerio de Hacienda.</p>
    </div>`

  const adjuntos = [
    { filename: `${venta.facturaClave}.xml`, content: Buffer.from(venta.facturaXml, 'base64'), contentType: 'application/xml' },
  ]
  if (venta.facturaRespuestaXml) {
    adjuntos.push({
      filename: `${venta.facturaClave}-respuesta.xml`,
      content: Buffer.from(venta.facturaRespuestaXml, 'base64'),
      contentType: 'application/xml',
    })
  }

  await getTransporte().sendMail({
    from: `"${nombreNegocio.replace(/"/g, '')}" <${process.env.EMAIL_SMTP_USER}>`,
    replyTo: emisor.correo,
    to: para,
    subject: `${tipo} ${venta.facturaConsecutivo} · ${nombreNegocio}`,
    html,
    attachments: adjuntos,
  })
  return { enviado: true }
}
