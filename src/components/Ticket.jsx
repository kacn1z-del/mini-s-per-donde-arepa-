import { METODOS_PAGO } from "../lib/constants.js";
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

// Arma el texto del ticket para mandarlo por correo
function textoTicket({ negocio, venta, fecha }) {
  const lineas = [
    negocio.nombre,
    `${venta.cajaNombre || "Caja"} · ${fecha.toLocaleString("es-CR")}`,
    `Atendió: ${venta.empleadoNombre || "—"}`,
    "",
  ];
  for (const i of venta.items || []) {
    lineas.push(`${textoCantidad(i)} x ${i.nombre}  ${colones(subtotalItem(i))}`);
  }
  lineas.push("", `TOTAL: ${colones(venta.total)}`);
  for (const p of venta.pagos || []) lineas.push(`${nombreMetodo(p.metodo)}: ${colones(p.monto)}`);
  if (venta.recibido) lineas.push(`Recibido: ${colones(venta.recibido)}`, `Vuelto: ${colones(venta.vuelto)}`);
  lineas.push("", negocio.leyenda);
  return lineas.join("\n");
}

// Comprobante de una venta de caja (no es factura electrónica)
export default function Ticket({ venta, fecha, onCerrar }) {
  const negocio = useNegocio();
  const items = venta.items || [];
  const correo = enlaceCorreo(`Comprobante ${negocio.nombre}`, textoTicket({ negocio, venta, fecha }));

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
          <div className="centro detalle">Comprobante de venta · no es factura electrónica</div>
        </div>

        <div className="acciones no-imprimir">
          <button className="btn" onClick={() => window.print()}>Imprimir</button>
          <a className="btn" href={correo}>Correo</a>
          <button className="btn primary" autoFocus onClick={onCerrar}>Siguiente cliente</button>
        </div>
      </div>
    </div>
  );
}
