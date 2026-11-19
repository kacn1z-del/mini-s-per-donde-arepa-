import { useState } from "react";
import { borrar, confirmar, consultar } from "../lib/api.js";
import { ESTADO_PEDIDO } from "../lib/constants.js";

// Colecciones que entran en el respaldo
const COLECCIONES = [
  "productos",
  "mesas",
  "salones",
  "observaciones",
  "pedidos",
  "reservas",
  "movimientos",
  "compras",
  "cierres",
  "fichajes",
  "empleados",
  "configuracion",
];

// Máximo de escrituras por batch en Firestore
const LOTE = 400;

function fechaArchivo() {
  return new Date().toISOString().slice(0, 10);
}

function aFecha(valor) {
  if (!valor) return null;
  return valor instanceof Date ? valor : new Date(valor);
}

export default function Mantenimiento() {
  const [descargando, setDescargando] = useState(false);
  const [respaldoHecho, setRespaldoHecho] = useState(false);
  const [antesDe, setAntesDe] = useState("");
  const [candidatos, setCandidatos] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  async function descargarRespaldo() {
    setError("");
    setMensaje("");
    setDescargando(true);
    try {
      const datos = { fecha: new Date().toISOString(), colecciones: {} };
      for (const coleccion of COLECCIONES) {
        datos.colecciones[coleccion] = await consultar(coleccion);
      }

      const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `respaldo-${fechaArchivo()}.json`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setRespaldoHecho(true);
      setMensaje("Respaldo descargado. Guardalo en un lugar seguro antes de limpiar.");
    } catch (e) {
      setError("No se pudo generar el respaldo: " + e.message);
    } finally {
      setDescargando(false);
    }
  }

  async function buscarViejos() {
    setError("");
    setMensaje("");
    setCandidatos(null);
    if (!antesDe) return setError("Escogé la fecha de corte.");

    const corte = new Date(antesDe + "T00:00:00");
    setBuscando(true);
    try {
      const pedidos = await consultar("pedidos");
      const viejos = pedidos.filter((p) => {
        const creado = aFecha(p.creadoEn);
        const cerrado = p.estado === ESTADO_PEDIDO.COBRADO || p.estado === ESTADO_PEDIDO.ANULADO;
        return cerrado && creado && creado < corte;
      });
      setCandidatos(viejos);
      if (!viejos.length) setMensaje("No hay pedidos cobrados o anulados antes de esa fecha.");
    } catch (e) {
      setError("No se pudo buscar: " + e.message);
    } finally {
      setBuscando(false);
    }
  }

  async function limpiarViejos() {
    setError("");
    setMensaje("");
    if (!respaldoHecho) return setError("Primero descargá el respaldo en esta sesión.");
    if (!candidatos || !candidatos.length) return setError("Buscá los pedidos primero.");

    setBorrando(true);
    try {
      for (let i = 0; i < candidatos.length; i += LOTE) {
        const lote = candidatos.slice(i, i + LOTE);
        await confirmar(lote.map((p) => borrar("pedidos", p.id)));
      }
      setMensaje(`Se borraron ${candidatos.length} pedidos.`);
      setCandidatos(null);
    } catch (e) {
      setError("Se detuvo la limpieza: " + e.message);
    } finally {
      setBorrando(false);
    }
  }

  return (
    <section className="stack">
      <div>
        <h2>Mantenimiento</h2>
        <p>Respaldo de datos y limpieza de pedidos viejos. Solo administrador.</p>
      </div>

      <div className="card">
        <h3>1. Respaldo</h3>
        <p>Descarga un archivo JSON con productos, mesas, pedidos, cierres, empleados, fichajes y configuración.</p>
        <button className="btn primary bloque" disabled={descargando} onClick={descargarRespaldo}>
          {descargando ? "Preparando respaldo..." : "Descargar respaldo"}
        </button>
      </div>

      <div className="card">
        <h3>2. Limpiar pedidos viejos</h3>
        <p>Borra solo pedidos cobrados o anulados creados antes de la fecha. Requiere haber descargado el respaldo en esta sesión.</p>

        <label>
          <span className="check">Fecha de corte (se borra lo anterior)</span>
          <input type="date" value={antesDe} onChange={(e) => { setAntesDe(e.target.value); setCandidatos(null); }} />
        </label>

        <button className="btn bloque" disabled={buscando || borrando} onClick={buscarViejos}>
          {buscando ? "Buscando..." : "Buscar pedidos"}
        </button>

        {candidatos && candidatos.length > 0 && (
          <>
            <p>Se encontraron {candidatos.length} pedidos para borrar.</p>
            <button className="btn primary bloque" disabled={!respaldoHecho || borrando} onClick={limpiarViejos}>
              {borrando ? "Borrando..." : `Borrar ${candidatos.length} pedidos`}
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {mensaje && <p>{mensaje}</p>}
    </section>
  );
}
