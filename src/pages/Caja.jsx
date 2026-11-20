import { useMemo, useState } from "react";
import { actualizar, ahora, confirmar, consultar, crear, nuevoIdDoc, usePolling } from "../lib/api.js";
import { DENOMINACIONES, METODOS_PAGO, MONEDAS, ROL } from "../lib/constants.js";
import { colones } from "../lib/format.js";
import Venta from "../components/Venta.jsx";

const SIMBOLO = { CRC: "₡", USD: "US$", EUR: "€" };
const CLAVE_CAJA = "caja_id";

function formatear(valor, moneda) {
  if (moneda === "CRC") return colones(valor);
  return `${SIMBOLO[moneda]}${(Number(valor) || 0).toFixed(2)}`;
}

function nombreDenominacion(valor, moneda) {
  if (moneda === "CRC") return `₡${valor.toLocaleString("es-CR")}`;
  return `${SIMBOLO[moneda]}${valor}`;
}

// Cada computadora o celular recuerda cuál caja le toca
function cajaDeEsteDispositivo() {
  try {
    return localStorage.getItem(CLAVE_CAJA) || "";
  } catch {
    return "";
  }
}

// Pantalla de caja: el cajero elige su caja, abre turno con fondo inicial,
// cobra con el lector de códigos, ve sus ventas y cierra con el conteo.
// Cada caja tiene su propio cierre.
export default function Caja({ staff }) {
  const esAdmin = staff?.rol === ROL.ADMIN;
  const [cajaId, setCajaId] = useState(cajaDeEsteDispositivo);
  const [fondoTexto, setFondoTexto] = useState("");
  const [nuevaCaja, setNuevaCaja] = useState("");
  const [conteo, setConteo] = useState({});
  const [moneda, setMoneda] = useState("CRC");
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [verCierre, setVerCierre] = useState(false);

  const cajasQ = usePolling(() => consultar("cajas", { orden: [["numero"]] }), [], 60000);
  const todasCajas = cajasQ.datos || [];
  const cajas = todasCajas.filter((c) => c.activa !== false);
  const caja = cajas.find((c) => c.id === cajaId) || null;

  const turnosQ = usePolling(
    () => consultar("turnos", { orden: [["abiertoEn", "desc"]], limite: 200 }),
    [],
    15000
  );
  const turno = caja
    ? (turnosQ.datos || []).find((t) => t.cajaId === caja.id && t.estado === "abierto") || null
    : null;
  const inicioTurno = turno?.abiertoEn instanceof Date ? turno.abiertoEn : null;
  const claveInicio = inicioTurno ? inicioTurno.getTime() : 0;

  // Solo pedidos cobrados desde que abrió el turno
  const pedidosQ = usePolling(
    async () => {
      if (!inicioTurno) return [];
      return consultar("pedidos", { where: [["cobradoEn", ">=", inicioTurno]] });
    },
    [claveInicio],
    20000
  );

  const ventas = useMemo(() => {
    const porMetodo = Object.fromEntries(METODOS_PAGO.map((m) => [m.id, 0]));
    let totalVentas = 0;
    let cantidad = 0;
    if (!caja || !inicioTurno) return { porMetodo, totalVentas, cantidad };
    for (const p of pedidosQ.datos || []) {
      if (p.cajaId !== caja.id || p.estado !== "cobrado") continue;
      if (!(p.cobradoEn instanceof Date) || p.cobradoEn < inicioTurno) continue;
      cantidad += 1;
      totalVentas += Number(p.total) || 0;
      for (const pg of p.pagos || []) {
        porMetodo[pg.metodo] = (porMetodo[pg.metodo] || 0) + (Number(pg.monto) || 0);
      }
    }
    return { porMetodo, totalVentas, cantidad };
  }, [pedidosQ.datos, caja?.id, claveInicio]);

  const fondoInicial = Number(turno?.fondoInicial) || 0;
  // El efectivo esperado es el fondo con el que abrió más lo que se cobró en efectivo
  const esperadoEfectivo = fondoInicial + (ventas.porMetodo.efectivo || 0);

  const denominaciones = DENOMINACIONES[moneda];
  const totalContado = denominaciones.reduce((s, d) => s + d * (Number(conteo[d]) || 0), 0);
  const diferencia = totalContado - esperadoEfectivo;

  function elegirCaja(id) {
    setCajaId(id);
    setMensaje("");
    setError("");
    try {
      localStorage.setItem(CLAVE_CAJA, id);
    } catch {
      /* si el navegador no guarda datos, la caja se vuelve a elegir al recargar */
    }
  }

  function cambiarMoneda(nueva) {
    setMoneda(nueva);
    setConteo({});
  }

  async function agregarCaja() {
    setError("");
    const nombre = nuevaCaja.trim();
    if (!nombre) return setError("Poné el nombre de la caja.");
    const numero = Math.max(0, ...todasCajas.map((c) => Number(c.numero) || 0)) + 1;
    setOcupado(true);
    try {
      await confirmar([
        crear("cajas", nuevoIdDoc(), { nombre, numero, activa: true, creadaEn: ahora() }),
      ]);
      setNuevaCaja("");
      cajasQ.recargar();
    } catch (e) {
      setError("No se pudo agregar la caja: " + e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function crearCuatroCajas() {
    setError("");
    setOcupado(true);
    try {
      await confirmar(
        [1, 2, 3, 4].map((n) =>
          crear("cajas", nuevoIdDoc(), { nombre: `Caja ${n}`, numero: n, activa: true, creadaEn: ahora() })
        )
      );
      cajasQ.recargar();
    } catch (e) {
      setError("No se pudieron crear las cajas: " + e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function abrirTurno() {
    setError("");
    setMensaje("");
    if (!caja) return setError("Elegí la caja de este dispositivo.");
    if (turno) return setError("Esta caja ya tiene un turno abierto.");
    const fondo = Math.round(Number(fondoTexto) || 0);
    if (fondo < 0) return setError("El fondo inicial no puede ser negativo.");

    setOcupado(true);
    try {
      await confirmar([
        crear("turnos", nuevoIdDoc(), {
          cajaId: caja.id,
          cajaNombre: caja.nombre,
          empleadoUid: staff.uid,
          empleadoNombre: staff.nombre || "",
          fondoInicial: fondo,
          estado: "abierto",
          abiertoEn: ahora(),
        }),
      ]);
      setFondoTexto("");
      setMensaje("Turno abierto.");
      turnosQ.recargar();
    } catch (e) {
      setError("No se pudo abrir el turno: " + e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function cerrarTurno() {
    setError("");
    setMensaje("");
    if (!turno || !caja) return;
    if (!confirm(`¿Cerrar la ${caja.nombre}? Se guardará el conteo de este turno.`)) return;

    setOcupado(true);
    try {
      await confirmar([
        crear("cierres", nuevoIdDoc(), {
          fecha: ahora(),
          cajaId: caja.id,
          cajaNombre: caja.nombre,
          terminal: Number(caja.numero) || null,
          turnoId: turno.id,
          moneda,
          empleadoUid: staff.uid,
          empleadoNombre: staff.nombre || "",
          fondoInicial,
          conteo: Object.fromEntries(denominaciones.map((d) => [String(d), Number(conteo[d]) || 0])),
          totalContado,
          esperadoEfectivo: moneda === "CRC" ? esperadoEfectivo : null,
          diferencia: moneda === "CRC" ? diferencia : null,
          totalVentas: ventas.totalVentas,
          porMetodo: ventas.porMetodo,
          cantidadPedidos: ventas.cantidad,
        }),
        actualizar("turnos", turno.id, {
          estado: "cerrado",
          cerradoEn: ahora(),
          totalContado,
          diferencia: moneda === "CRC" ? diferencia : null,
        }),
      ]);
      setConteo({});
      setVerCierre(false);
      setMensaje(`${caja.nombre} cerrada.`);
      turnosQ.recargar();
    } catch (e) {
      setError("No se pudo cerrar la caja: " + e.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className="stack">
      <div className="card">
        <h2>Caja</h2>
        <label>
          <span className="check">Caja de este dispositivo</span>
          <select value={cajaId} onChange={(e) => elegirCaja(e.target.value)}>
            <option value="">Elegí una caja</option>
            {cajas.map((c) => (
              <option key={c.id} value={c.id}>{c.nombre}</option>
            ))}
          </select>
        </label>

        {cajasQ.datos && cajas.length === 0 && (
          <div style={{ marginTop: 12 }}>
            <p>Todavía no hay cajas creadas.</p>
            {esAdmin && (
              <button className="btn primary bloque" disabled={ocupado} onClick={crearCuatroCajas}>
                Crear Caja 1 a Caja 4
              </button>
            )}
          </div>
        )}
      </div>

      {caja && !turno && (
        <div className="card">
          <h3>Abrir turno en {caja.nombre}</h3>
          <label>
            <span className="check">Fondo inicial (₡)</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              placeholder="0"
              value={fondoTexto}
              onChange={(e) => setFondoTexto(e.target.value)}
            />
          </label>
          <button className="btn primary bloque" disabled={ocupado} onClick={abrirTurno}>
            {ocupado ? "Abriendo..." : "Abrir turno"}
          </button>
        </div>
      )}

      {caja && turno && !verCierre && (
        <Venta caja={caja} turno={turno} staff={staff} onVendido={pedidosQ.recargar} />
      )}

      {caja && turno && (
        <>
          <div className="card">
            <h3>Turno de {caja.nombre}</h3>
            <p>Cajero: <strong>{turno.empleadoNombre || "—"}</strong></p>
            <p>Abierto: <strong>{turno.abiertoEn.toLocaleString("es-CR")}</strong></p>
            <p>Fondo inicial: <strong>{colones(fondoInicial)}</strong></p>
            <p>Ventas cobradas: <strong>{ventas.cantidad}</strong></p>
            <p>Total vendido: <strong>{colones(ventas.totalVentas)}</strong></p>
            <table className="tabla">
              <tbody>
                {METODOS_PAGO.map((m) => (
                  <tr key={m.id}>
                    <td>{m.label}</td>
                    <td>{colones(ventas.porMetodo[m.id])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!verCierre && (
              <button className="btn bloque" onClick={() => setVerCierre(true)}>
                Ir al cierre de caja
              </button>
            )}
          </div>

          {verCierre && (
          <div className="card">
            <h3>Conteo para cerrar</h3>
            <label>
              <span className="check">Moneda del conteo</span>
              <select value={moneda} onChange={(e) => cambiarMoneda(e.target.value)}>
                {MONEDAS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>

            <table className="tabla" style={{ marginTop: 12 }}>
              <tbody>
                {denominaciones.map((d) => (
                  <tr key={d}>
                    <td>{nombreDenominacion(d, moneda)}</td>
                    <td>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={conteo[d] ?? ""}
                        onChange={(e) => setConteo({ ...conteo, [d]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p>Total contado: <strong>{formatear(totalContado, moneda)}</strong></p>

            {moneda === "CRC" ? (
              <>
                <p>Efectivo esperado (fondo + cobros en efectivo): <strong>{colones(esperadoEfectivo)}</strong></p>
                <p className={diferencia === 0 ? "ok" : "error"}>Diferencia: {colones(diferencia)}</p>
              </>
            ) : (
              <small>Las ventas se registran en colones, así que aquí no se compara la diferencia.</small>
            )}

            <button className="btn peligro bloque" disabled={ocupado} onClick={cerrarTurno}>
              {ocupado ? "Guardando..." : `Cerrar ${caja.nombre}`}
            </button>
            <button className="btn bloque" disabled={ocupado} onClick={() => setVerCierre(false)}>
              Volver a vender
            </button>
          </div>
          )}
        </>
      )}

      {esAdmin && (
        <div className="card">
          <h3>Administrar cajas</h3>
          <div className="formulario">
            <input
              placeholder="Nombre de la nueva caja"
              value={nuevaCaja}
              onChange={(e) => setNuevaCaja(e.target.value)}
            />
          </div>
          <button className="btn bloque" disabled={ocupado} onClick={agregarCaja}>Agregar caja</button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {mensaje && <p className="ok">{mensaje}</p>}
    </section>
  );
}
