// lib/comprobante.js
//
// Convierte una venta de la caja (colección "pedidos") en el XML de un
// comprobante electrónico v4.4, listo para firmar y enviar a Hacienda.
//
// - Sin datos del cliente: Tiquete Electrónico (04), venta a consumidor final.
// - Con cédula del cliente: Factura Electrónica (01).
//
// Los precios de la caja YA INCLUYEN el IVA. En régimen tradicional se separa
// el impuesto de cada línea según la tarifa del producto. En régimen
// simplificado no se cobra IVA en las líneas (como Los Pirchas, aceptado por Hacienda).

import {
  buildClave,
  buildFacturaXml,
  buildTiqueteXml,
  calculateInvoiceSummary,
  calculateLineItemTotals,
  DocumentType,
  Situation,
} from '@dojocoding/hacienda-sdk'

// Porcentaje de cada código de tarifa de IVA de Hacienda
const TARIFAS = {
  '01': 0,
  '02': 1,
  '03': 2,
  '04': 4,
  '05': 0,
  '06': 4,
  '07': 8,
  '08': 13,
  '09': 0.5,
  '10': 0,
  '11': 0,
}

// Medios de pago v4.4 (SINPE Móvil tiene código propio desde la 4.4)
const MEDIOS_PAGO = {
  efectivo: '01',
  tarjeta: '02',
  sinpe: '06',
}

const redondear5 = (n) => Math.round(n * 100000) / 100000

// Datos del emisor que se configuran en Vercel
export function emisorDesdeEntorno(env = process.env) {
  const faltan = [
    'HACIENDA_CEDULA',
    'HACIENDA_TIPO_CEDULA',
    'FACTURACION_NOMBRE',
    'FACTURACION_EMAIL',
    'FACTURACION_ACTIVIDAD',
    'FACTURACION_PROVINCIA',
    'FACTURACION_CANTON',
    'FACTURACION_DISTRITO',
    'FACTURACION_SENAS',
  ].filter((k) => !String(env[k] || '').trim())
  if (faltan.length) throw new Error('Faltan variables de facturación en Vercel: ' + faltan.join(', '))

  const cedula = env.HACIENDA_CEDULA.replace(/\D/g, '')
  return {
    cedula,
    tipoCedula: env.HACIENDA_TIPO_CEDULA.trim(), // 01 física, 02 jurídica
    nombre: env.FACTURACION_NOMBRE.trim(),
    nombreComercial: (env.FACTURACION_NOMBRE_COMERCIAL || '').trim() || undefined,
    correo: env.FACTURACION_EMAIL.trim(),
    actividad: env.FACTURACION_ACTIVIDAD.trim(),
    provincia: env.FACTURACION_PROVINCIA.trim(),
    canton: env.FACTURACION_CANTON.trim().padStart(2, '0'),
    distrito: env.FACTURACION_DISTRITO.trim().padStart(2, '0'),
    senas: env.FACTURACION_SENAS.trim(),
    // Identificación de quien hizo el sistema; si no se pone, la del propio emisor
    proveedorSistemas: (env.HACIENDA_PROVEEDOR_SISTEMAS || '').replace(/\D/g, '') || cedula,
    // "general" (tradicional, con IVA) o "simplificado"
    regimen: (env.FACTURACION_REGIMEN || 'general').trim().toLowerCase(),
    sucursal: (env.FACTURACION_SUCURSAL || '001').trim().padStart(3, '0'),
  }
}

// Revisa la venta antes de intentar armar el comprobante
export function problemasDeVenta(venta, productos) {
  const problemas = []
  if (!venta.items?.length) problemas.push('La venta no tiene productos.')
  for (const item of venta.items || []) {
    const prod = productos[item.productoId] || {}
    const cabys = String(prod.cabys || item.cabys || '').replace(/\D/g, '')
    if (cabys.length !== 13) problemas.push(`"${item.nombre}" no tiene código CABYS de 13 dígitos.`)
  }
  return problemas
}

/**
 * @param {object} venta    documento de "pedidos"
 * @param {object} productos  mapa productoId -> producto (para CABYS y tarifa actuales)
 * @param {object} emisor   resultado de emisorDesdeEntorno()
 * @param {object} opciones { consecutivo, terminal, fecha, rechazado }
 *   rechazado: { clave, tipoDoc, fecha } del comprobante rechazado que este sustituye
 *   clave: la de un intento anterior con el mismo número (para no generar otra)
 */
export function armarComprobante(venta, productos, emisor, { consecutivo, terminal, fecha = new Date(), rechazado = null, clave: claveAnterior = null }) {
  const cliente = venta.cliente || null
  const esFactura = Boolean(cliente?.cedula)
  const tipoDoc = esFactura ? '01' : '04'
  const simplificado = emisor.regimen === 'simplificado'

  const lineas = venta.items.map((item, idx) => {
    const prod = productos[item.productoId] || {}
    const codigoTarifa = simplificado ? '01' : String(prod.tarifaCodigo || item.tarifaCodigo || '08')
    const tarifa = TARIFAS[codigoTarifa] ?? 13
    const cantidad = Number(item.cantidad)
    // El precio de la caja trae el IVA incluido: se separa la base
    const precioSinIva = redondear5(Number(item.precio) / (1 + tarifa / 100))
    return {
      numeroLinea: idx + 1,
      codigoCabys: String(prod.cabys || item.cabys).replace(/\D/g, ''),
      cantidad,
      unidadMedida: item.unidad === 'Kg' ? 'Kg' : 'Unid',
      detalle: String(item.nombre).slice(0, 200),
      precioUnitario: precioSinIva,
      esServicio: false,
      impuesto: [{ codigo: '01', codigoTarifaIVA: codigoTarifa, tarifa }],
    }
  })

  const calculadas = lineas.map(calculateLineItemTotals)
  const resumen = calculateInvoiceSummary(calculadas)

  if (simplificado) {
    // Régimen simplificado: el total va como "no sujeto" y sin impuesto
    // (misma forma que un comprobante de Los Pirchas aceptado por Hacienda).
    const total = calculadas.reduce((s, l) => s + l.montoTotalLinea, 0)
    Object.assign(resumen, {
      totalMercanciasGravadas: 0,
      totalMercanciasExentas: 0,
      totalMercExonerada: 0,
      totalMercNoSujeta: total,
      totalGravado: 0,
      totalExento: 0,
      totalExonerado: 0,
      totalNoSujeto: total,
      totalVenta: total,
      totalVentaNeta: total,
      totalDesgloseImpuesto: [{ codigo: '01', codigoTarifaIVA: '01', totalMontoImpuesto: 0 }],
      totalImpuesto: 0,
      totalComprobante: total,
    })
  }

  // Medios de pago: en el mismo orden y montos que se cobraron en la caja.
  // Se ajusta el último para que cuadre exacto con el total del comprobante.
  const pagos = (venta.pagos || []).filter((p) => Number(p.monto) > 0)
  const medioPago = pagos.map((p) => ({
    tipoMedioPago: MEDIOS_PAGO[p.metodo] || '99',
    totalMedioPago: Number(p.monto),
  }))
  if (!medioPago.length) medioPago.push({ tipoMedioPago: '01', totalMedioPago: resumen.totalComprobante })
  const sumaPagos = medioPago.reduce((s, p) => s + p.totalMedioPago, 0)
  medioPago[medioPago.length - 1].totalMedioPago = redondear5(
    medioPago[medioPago.length - 1].totalMedioPago + (resumen.totalComprobante - sumaPagos)
  )
  resumen.medioPago = medioPago

  const clave = claveAnterior || buildClave({
    date: fecha,
    taxpayerId: emisor.cedula,
    documentType: esFactura ? DocumentType.FACTURA_ELECTRONICA : DocumentType.TIQUETE_ELECTRONICO,
    sequence: consecutivo,
    situation: Situation.NORMAL,
    branch: emisor.sucursal,
    pos: String(terminal).padStart(5, "0"),
  })

  // Consecutivo de 20 dígitos: sucursal(3) + terminal(5) + tipo(2) + número(10)
  const numeroConsecutivo =
    emisor.sucursal + String(terminal).padStart(5, '0') + tipoDoc + String(consecutivo).padStart(10, '0')

  const base = {
    clave,
    proveedorSistemas: emisor.proveedorSistemas,
    codigoActividadEmisor: emisor.actividad,
    numeroConsecutivo,
    fechaEmision: fecha.toISOString(),
    emisor: {
      nombre: emisor.nombre,
      identificacion: { tipo: emisor.tipoCedula, numero: emisor.cedula },
      nombreComercial: emisor.nombreComercial,
      ubicacion: {
        provincia: emisor.provincia,
        canton: emisor.canton,
        distrito: emisor.distrito,
        otrasSenas: emisor.senas,
      },
      correoElectronico: emisor.correo,
    },
    condicionVenta: '01', // contado
    detalleServicio: calculadas,
    resumenFactura: resumen,
  }

  // v4.4 (noviembre 2026): código 16 = sustituye un comprobante rechazado
  if (rechazado?.clave) {
    base.informacionReferencia = [
      {
        tipoDoc: rechazado.tipoDoc,
        numero: rechazado.clave,
        fechaEmision: new Date(rechazado.fecha).toISOString(),
        codigo: '16',
        razon: 'Sustituye comprobante electrónico rechazado',
      },
    ]
  }

  let xml
  if (esFactura) {
    base.receptor = {
      nombre: String(cliente.nombre || 'Cliente').slice(0, 100),
      identificacion: { tipo: cliente.tipo || '01', numero: String(cliente.cedula).replace(/\D/g, '') },
      correoElectronico: cliente.correo || undefined,
    }
    xml = buildFacturaXml(base)
  } else {
    xml = buildTiqueteXml(base)
  }

  return { xml, clave, numeroConsecutivo, tipo: esFactura ? 'factura' : 'tiquete', totalComprobante: resumen.totalComprobante }
}
