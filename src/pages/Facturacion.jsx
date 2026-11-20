import { useMemo, useState } from "react";
import { actualizar, ahora, confirmar, consultar, crear, leerDoc, usePolling } from "../lib/api.js";
import { colones, horaCorta } from "../lib/format.js";
import {
  consultarComprobante,
  emitirComprobante,
  ESTADOS_FACTURA,
  probarFacturacion,
} from "../lib/facturacion.js";

const hoyIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const CON_PROBLEMA = ["error", "rechazado", "faltan_datos"];
const VIEJO_MS = 2 * 60 * 1000;

// "emitiendo" de hace rato quiere decir que el intento se cortó
function estadoDe(v) {
  if (v.facturaEstado === "emitiendo" && Date.now() - new Date(v.facturaIntentoEn || 0).getTime() > VIEJO_MS) {
    return "error";
  }
  return v.facturaEstado || "sin_enviar";
}

const FILTROS = [
  { id: "problemas", label: "Con problemas", incluye: (e) => CON_PROBLEMA.includes(e) || e === "sin_enviar" },
  { id: "enviado", label: "Esperando respuesta", incluye: (e) => e === "enviado" || e === "emitiendo" },
  { id: "aceptado", label: "Aceptados", incluye: (e) => e === "aceptado" },
  { id: "todos", label: "Todos", incluye: () => true },
];

// Facturación electrónica: encenderla, revisar la configuración y dar
// seguimiento a los comprobantes de cada venta.
export default function Facturacion() {
  const [desde, setDesde] = useState(hoyIso());
  const [filtro, setFiltro] = useState("problemas");
  const [ocupado, setOcupado] = useState(null); // id de la venta o "todo"
  const [prueba, setPrueba] = useState(null);
  const [probando, setProbando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  const configQ = usePolling(() => leerDoc("configuracion", "facturacion"), [], 60000);
  const config = configQ.datos;
  const activa = !!config?.activa;
  const activadaEn = config?.activadaEn instanceof Date ? config.activadaEn : null;

  const ventasQ = usePolling(
    () => consultar("pedidos", { where: [["cobradoEn", ">=", new Date(desde + "T00:00:00")]] }),
    [desde],
    30000
  );

  // Solo cuentan las ventas desde que se encendió la facturación
  const ventas = useMemo(
    () =>
      (ventasQ.datos || [])
        .filter((v) => v.estado === "cobrado" && v.cobradoEn instanceof Date)
        .filter((v) => v.facturaEstado || (activadaEn && v.cobradoEn >= activadaEn))
        .sort((a, b) => b.cobradoEn - a.cobradoEn),
    [ventasQ.datos, activadaEn]
  );

  const conteo = useMemo(() => {
    const c = {};
    for (const f of FILTROS) c[f.id] = ventas.filter((v) => f.incluye(estadoDe(v))).length;
    return c;
  }, [ventas]);

  const filtroActual = FILTROS.find((f) => f.id === filtro);
  const visibles = ventas.filter((v) => filtroActual.incluye(estadoDe(v)));
  const pendientes = ventas.filter((v) => ["sin_enviar", "error", "faltan_datos", "rechazado"].includes(estadoDe(v)));

  function avisar(ok, texto) {
    setMensaje(ok ? texto : "");
    setError(ok ? "" : texto);
  }

  async function cambiarActiva() {
    const encender = !activa;
    if (encender && !confirm("¿Encender la facturación electrónica? Cada venta nueva se va a enviar a Hacienda.")) return;
    try {
      const datos = { activa: encender };
      if (encender && !activadaEn) datos.activadaEn = ahora();
      const existe = await leerDoc("configuracion", "facturacion");
      await confirmar([existe ? actualizar("configuracion", "facturacion", datos) : crear("configuracion", "facturacion", datos)]);
      avisar(true, encender ? "Facturación electrónica encendida." : "Facturación electrónica apagada.");
      configQ.recargar();
    } catch (e) {
      avisar(false, "No se pudo cambiar: " + e.message);
    }
  }

  async function probar() {
    setProbando(true);
    setPrueba(null);
    try {
      setPrueba(await probarFacturacion());
    } catch (e) {
      setPrueba({ listo: false, pasos: [{ nombre: "Conexión con el servidor", ok: false, detalle: e.message }] });
    } finally {
      setProbando(false);
    }
  }

  async function emitir(v) {
    setOcupado(v.id);
    try {
      const r = await emitirComprobante(v.id);
      avisar(r.estado === "aceptado" || r.estado === "enviado", `Venta de ${colones(v.total)}: ${ESTADOS_FACTURA[r.estado] || r.estado}${r.motivo || r.error ? " · " + (r.motivo || r.error) : ""}`);
    } catch (e) {
      avisar(false, e.message);
    } finally {
      setOcupado(null);
      ventasQ.recargar();
    }
  }

  async function revisar(v, reenviarCorreo = false) {
    setOcupado(v.id);
    try {
      const r = await consultarComprobante(v.id, reenviarCorreo);
      const correo = r.correo ? (r.correo.enviado ? " · correo enviado" : ` · correo no enviado: ${r.correo.motivo}`) : "";
      avisar(r.estado !== "rechazado", `${ESTADOS_FACTURA[r.estado] || r.estado}${r.motivo ? " · " + r.motivo : ""}${correo}`);
    } catch (e) {
      avisar(false, e.message);
    } finally {
      setOcupado(null);
      ventasQ.recargar();
    }
  }

  async function emitirPendientes() {
    if (!pendientes.length) return;
    if (!confirm(`¿Enviar a Hacienda ${pendientes.length} ventas pendientes, una por una?`)) return;
    setOcupado("todo");
    let ok = 0;
    for (const v of pendientes) {
      try {
        const r = await emitirComprobante(v.id);
        if (r.estado === "aceptado" || r.estado === "enviado") ok += 1;
      } catch {
        // queda con su error para revisarla aparte
      }
    }
    setOcupado(null);
    ventasQ.recargar();
    avisar(ok === pendientes.length, `Se enviaron ${ok} de ${pendientes.length}. Las demás quedan en "Con problemas".`);
  }

  return (
    <section className="stack">
      <div>
        <h2>Facturación electrónica</h2>
        <p>Tiquetes y facturas electrónicas de cada venta, enviados a Hacienda (versión 4.4).</p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Estado</h3>
        <p>
          {activa ? (
            <strong className="ok">Encendida</strong>
          ) : (
            <strong className="error">Apagada</strong>
          )}
          {activadaEn ? ` · desde ${activadaEn.toLocaleDateString("es-CR")}` : ""}
        </p>
        <p style={{ marginTop: 6 }}>
          <small>
            Encendida, cada venta se envía sola a Hacienda al cobrar: tiquete electrónico, o factura si la cajera
            pone la cédula del cliente. Antes de encenderla, tocá "Probar configuración".
          </small>
        </p>
        <div className="acciones">
          <button className="btn" disabled={probando} onClick={probar}>
            {probando ? "Probando..." : "Probar configuración"}
          </button>
          <button className={"btn " + (activa ? "peligro" : "primary")} onClick={cambiarActiva}>
            {activa ? "Apagar" : "Encender"}
          </button>
        </div>

        {prueba && (
          <div style={{ marginTop: 12 }}>
            {prueba.pasos.map((p) => (
              <p key={p.nombre} className={p.ok ? "ok" : "error"} style={{ marginBottom: 6 }}>
                {p.ok ? "✓" : "✗"} {p.nombre}
                {p.detalle && <small style={{ display: "block", fontWeight: 500, color: "var(--ink-600)" }}>{p.detalle}</small>}
              </p>
            ))}
            <p className={prueba.listo ? "ok" : "error"}>
              {prueba.listo ? "Todo listo para facturar." : "Hay que corregir lo marcado con ✗ en las variables de Vercel."}
            </p>
          </div>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {mensaje && <p className="ok">{mensaje}</p>}

      <div className="card">
        <div className="formulario">
          <label>
            <span className="check">Ventas desde</span>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </label>
        </div>
        <div className="chips" style={{ marginTop: 12 }}>
          {FILTROS.map((f) => (
            <button key={f.id} className={"chip" + (filtro === f.id ? " activo" : "")} onClick={() => setFiltro(f.id)}>
              {f.label} ({conteo[f.id] || 0})
            </button>
          ))}
        </div>
        {activa && pendientes.length > 0 && (
          <button className="btn primary bloque" disabled={!!ocupado} onClick={emitirPendientes}>
            {ocupado === "todo" ? "Enviando..." : `Enviar las ${pendientes.length} pendientes`}
          </button>
        )}
      </div>

      <div className="card">
        {ventasQ.error && <p className="error">{ventasQ.error}</p>}
        {ventasQ.datos && visibles.length === 0 && <p>No hay ventas en esta lista.</p>}
        {visibles.map((v) => {
          const estado = estadoDe(v);
          const textoEstado = estado === "sin_enviar" ? "Sin enviar" : ESTADOS_FACTURA[estado] || estado;
          const tipo = v.facturaTipo === "factura" || v.cliente?.cedula ? "Factura" : "Tiquete";
          return (
            <div key={v.id} className="item" style={{ cursor: "default" }}>
              <div className="item-linea">
                <span>
                  {tipo} · {colones(v.total)}
                </span>
                <small className={estado === "aceptado" ? "ok" : CON_PROBLEMA.includes(estado) || estado === "sin_enviar" ? "error" : ""}>
                  {textoEstado}
                </small>
              </div>
              <small>
                {v.cobradoEn.toLocaleDateString("es-CR")} {horaCorta(v.cobradoEn)} · {v.cajaNombre || "Caja"} · {v.empleadoNombre || "—"}
                {v.cliente?.nombre ? ` · ${v.cliente.nombre}` : ""}
                {v.facturaConsecutivo ? ` · N.º ${v.facturaConsecutivo}` : ""}
                {v.facturaAmbiente === "sandbox" ? " · PRUEBAS" : ""}
              </small>
              {v.facturaError && estado !== "aceptado" && (
                <p className="error" style={{ fontSize: 13, marginTop: 4 }}>{v.facturaError}</p>
              )}
              {v.facturaCorreoMotivo && <p style={{ fontSize: 13, marginTop: 4 }}>Correo: {v.facturaCorreoMotivo}</p>}
              <div className="acciones">
                {["sin_enviar", "error", "faltan_datos", "rechazado"].includes(estado) && (
                  <button className="btn primary" disabled={!!ocupado || !activa} onClick={() => emitir(v)}>
                    {ocupado === v.id ? "Enviando..." : estado === "sin_enviar" ? "Enviar a Hacienda" : "Reintentar"}
                  </button>
                )}
                {estado === "enviado" && (
                  <button className="btn" disabled={!!ocupado} onClick={() => revisar(v)}>
                    {ocupado === v.id ? "Consultando..." : "Consultar estado"}
                  </button>
                )}
                {estado === "aceptado" && v.cliente?.correo && (
                  <button className="btn" disabled={!!ocupado} onClick={() => revisar(v, true)}>
                    {ocupado === v.id ? "Enviando..." : "Reenviar correo"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Para que Hacienda acepte</h3>
        <p>
          <small>
            Cada producto vendido necesita su código CABYS de 13 dígitos y su tarifa de IVA (en Inventario o
            Productos). Si falta, la venta queda en "Faltan datos" y se reintenta después de completarlo.
          </small>
        </p>
      </div>
    </section>
  );
}
