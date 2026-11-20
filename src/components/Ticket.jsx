import { METODOS_PAGO } from "../lib/constants.js";
import { ESTADOS_FACTURA, TIPOS_CEDULA } from "../lib/facturacion.js";
import { colones, enlaceCorreo } from "../lib/format.js";
import { useNegocio } from "../lib/negocio.js";

const ESTILOS = `
.ticket-imprimible {
  font-family: monospace;
  font-size: 12px;
  background: #fff;
  color: #000;
  padding: 8px;
  width: 72mm;
  max-width: 100%;
  margin: 0 auto;
}
.ticket-imprimible table { width: 100%; border-collapse: collapse; }
.ticket-imprimible td { padding: 2px 0; vertical-align: top; }
.ticket-imprimible .r { text-align: right; white-space: nowrap; }
.ticket-imprimible .centro { text-align: center; }
.ticket-imprimible .detalle { font-size: 11px; }
.ticket-imprimible .clave { font-size: 10px; word-break: break-all; }
.ticket-imprimible hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
@media print {
  body * { visibility: hidden; }
  .ticket-imprimible, .ticket-imprimible * { visibility: visible; }
  .ticket-imprimible {
    position: fixed;
    left: 0;
    top: 0;
    width: 72mm;
    margin: 0;
  }
  .no-imprimir { display: none !important; }
}
`;

function nombreMetodo(id) {
  return METODOS_PAGO.find((m) => m.id === id)?.label || id;
}

// Cantidad para mostrar: 3 decimales en productos por kilo, enteros en el resto
export function textoCantidad(item) {
  const cantidad = Number(item.cantidad) || 0;
  if (item.unidad === "Kg") return `${cantidad.toFixed(3)} kg`;
  return String(cantidad);
}

export function subtotalItem(item) {
  return Math.round((Number(item.precio) || 0) * (Number(item.cantidad) || 0));
}

const nombreTipoCedula = (id) => TIPOS_CEDULA.find((t) => t.id === id)?.label || "";

function tituloComprobante(factura, venta) {
  if (!factura) return "";
  return venta.cliente?.cedula ? "Factura electrónica" : "Tiquete electrónico";
}

// Arma el texto del ticket para mandarlo por correo
function textoTicket({ negocio, venta, fecha, factura }) {
  const lineas = [
    negocio.nombre,
    `${venta.cajaNombre || "Caja"} · ${fecha.toLocaleString("es-CR")}`,
    `Atendió: ${venta.empleadoNombre || "—"}`,
  ];
  if (factura?.consecutivo) {
    lineas.push(`${tituloComprobante(factura, venta)} N.º ${factura.consecutivo}`, `Clave: ${factura.clave}`);
  }
  lineas.push("");
  for (const i of venta.items || []) {
    lineas.push(`${textoCantidad(i)} x ${i.nombre}  ${colones(subtotalItem(i))}`);
  }
  lineas.push("", `TOTAL: ${colones(venta.total)}`);
  for (const p of venta.pagos || []) lineas.push(`${nombreMetodo(p.metodo)}: ${colones(p.monto)}`);
  if (venta.recibido) lineas.push(`Recibido: ${colones(venta.recibido)}`, `Vuelto: ${colones(venta.vuelto)}`);
  lineas.push("", negocio.leyenda);
  return lineas.join("\n");
}

// Comprobante de una venta de caja. Con la facturación encendida muestra el
// tiquete o factura electrónica (consecutivo, clave y estado en Hacienda).
export default function Ticket({ venta, fecha, factura = null, onCerrar }) {
  const negocio = useNegocio();
  const items = venta.items || [];
  const correo = enlaceCorreo(`Comprobante ${negocio.nombre}`, textoTicket({ negocio, venta, fecha, factura }));
  const estadoTexto = factura ? ESTADOS_FACTURA[factura.estado] || factura.estado : "";

  return (
    <div className="modal-fondo">
      <div className="modal card">
        <style>{ESTILOS}</style>

        <div className="ticket-imprimible">
          <div className="centro"><strong>{negocio.nombre}</strong></div>
          {negocio.direccion && <div className="centro">{negocio.direccion}</div>}
          {negocio.cedulaJuridica && <div className="centro">Céd. jur.: {negocio.cedulaJuridica}</div>}
          {negocio.telefono && <div className="centro">Tel.: {negocio.telefono}</div>}
          <div className="centro">
            {venta.cajaNombre || "Caja"} · {fecha.toLocaleString("es-CR")}
          </div>
          <div>Atendió: {venta.empleadoNombre || "—"}</div>

          {factura && (
            <>
              <hr />
              <div className="centro"><strong>{tituloComprobante(factura, venta)}</strong></div>
              {factura.consecutivo && <div className="centro">N.º {factura.consecutivo}</div>}
              {factura.clave && <div className="clave">Clave: {factura.clave}</div>}
              {venta.cliente?.cedula && (
                <div>
                  Cliente: {venta.cliente.nombre}
                  <div className="detalle">
                    Céd. {nombreTipoCedula(venta.cliente.tipo).toLowerCase()} {venta.cliente.cedula}
                  </div>
                </div>
              )}
            </>
          )}

          <hr />

          <table>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.nombre}
                    <div className="detalle">
                      {textoCantidad(i)} × {colones(i.precio)}
                      {i.unidad === "Kg" ? "/kg" : ""}
                    </div>
                  </td>
                  <td className="r">{colones(subtotalItem(i))}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <hr />

          <table>
            <tbody>
              <tr>
                <td><strong>TOTAL</strong></td>
                <td className="r"><strong>{colones(venta.total)}</strong></td>
              </tr>
              {(venta.pagos || []).map((p, idx) => (
                <tr key={idx}>
                  <td>{nombreMetodo(p.metodo)}</td>
                  <td className="r">{colones(p.monto)}</td>
                </tr>
              ))}
              {venta.recibido > 0 && (
                <>
                  <tr>
                    <td>Recibido</td>
                    <td className="r">{colones(venta.recibido)}</td>
                  </tr>
                  <tr>
                    <td><strong>Vuelto</strong></td>
                    <td className="r"><strong>{colones(venta.vuelto)}</strong></td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          <hr />

          <div className="centro">{negocio.leyenda}</div>
          {!factura && <div className="centro detalle">Comprobante de venta · no es factura electrónica</div>}
        </div>

        {factura && (
          <p className={"no-imprimir " + (factura.estado === "aceptado" ? "ok" : factura.estado === "emitiendo" || factura.estado === "enviado" ? "" : "error")}>
            {estadoTexto}
            {factura.estado === "emitiendo" ? "…" : ""}
            {factura.motivo || factura.error ? ` · ${factura.motivo || factura.error}` : ""}
            {factura.correo?.enviado ? " · Correo enviado al cliente" : ""}
            {["error", "rechazado", "faltan_datos"].includes(factura.estado) && (
              <small style={{ display: "block" }}>La venta quedó guardada. El administrador lo reintenta en Facturación.</small>
            )}
          </p>
        )}

        <div className="acciones no-imprimir">
          <button className="btn" onClick={() => window.print()}>Imprimir</button>
          <a className="btn" href={correo}>Correo</a>
          <button className="btn primary" autoFocus onClick={onCerrar}>Siguiente cliente</button>
        </div>
      </div>
    </div>
  );
}
