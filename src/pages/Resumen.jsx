import { useMemo } from "react";
import { consultar, usePolling } from "../lib/api.js";
import { ESTADO_PEDIDO, METODOS_PAGO } from "../lib/constants.js";
import { colones, inicioDelDia } from "../lib/format.js";

export default function Resumen() {
  // Ventas cobradas desde medianoche
  const cobradosQ = usePolling(
    () => consultar("pedidos", { where: [["cobradoEn", ">=", inicioDelDia()]] }),
    [],
    20000
  );

  const stats = useMemo(() => {
    const cobrados = (cobradosQ.datos || []).filter((p) => p.estado === ESTADO_PEDIDO.COBRADO);
    const porMetodo = Object.fromEntries(METODOS_PAGO.map((m) => [m.id, 0]));
    const productos = {};
    let totalVentas = 0;

    for (const p of cobrados) {
      totalVentas += Number(p.total) || 0;
      for (const pg of p.pagos || []) {
        porMetodo[pg.metodo] = (porMetodo[pg.metodo] || 0) + (Number(pg.monto) || 0);
      }
      for (const i of p.items || []) {
        const clave = i.nombre || "Sin nombre";
        productos[clave] = (productos[clave] || 0) + (Number(i.cantidad) || 0);
      }
    }

    const topProductos = Object.entries(productos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return {
      cantidad: cobrados.length,
      totalVentas,
      ticketPromedio: cobrados.length ? totalVentas / cobrados.length : 0,
      porMetodo,
      topProductos,
    };
  }, [cobradosQ.datos]);

  const cargando = cobradosQ.datos === null && !cobradosQ.error;

  return (
    <section className="stack">
      <div>
        <h2>Resumen del día</h2>
        <p>Lo cobrado desde hoy a las 00:00.</p>
      </div>

      {cargando && <p className="cargando">Cargando resumen...</p>}
      {cobradosQ.error && <p className="error">{cobradosQ.error}</p>}

      <div className="metricas">
        <div className="metrica">
          <span className="metrica__label">Ventas de hoy</span>
          <span className="metrica__valor">{colones(stats.totalVentas)}</span>
        </div>
        <div className="metrica">
          <span className="metrica__label">Ventas cobradas</span>
          <span className="metrica__valor">{stats.cantidad}</span>
        </div>
        <div className="metrica">
          <span className="metrica__label">Venta promedio</span>
          <span className="metrica__valor">{colones(stats.ticketPromedio)}</span>
        </div>
      </div>

      <div className="card">
        <h3>Ventas por método de pago</h3>
        <table className="tabla">
          <tbody>
            {METODOS_PAGO.map((m) => (
              <tr key={m.id}>
                <td>{m.label}</td>
                <td>{colones(stats.porMetodo[m.id])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Más vendidos hoy</h3>
        {stats.topProductos.length === 0 ? (
          <p>Todavía no hay ventas cobradas hoy.</p>
        ) : (
          <table className="tabla">
            <tbody>
              {stats.topProductos.map(([nombre, cantidad]) => (
                <tr key={nombre}>
                  <td>{nombre}</td>
                  <td>{cantidad} uds.</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
