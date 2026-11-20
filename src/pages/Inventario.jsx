import { useMemo, useRef, useState } from "react";
import {
  actualizar,
  ahora,
  confirmar,
  consultar,
  crear,
  incremento,
  nuevoIdDoc,
  usePolling,
} from "../lib/api.js";
import { COLORES_PRODUCTO, TIPO_PRODUCTO } from "../lib/constants.js";
import { colones, horaCorta } from "../lib/format.js";

const TIPOS_MOVIMIENTO = [
  { id: "entrada", label: "Entrada", ayuda: "Suma al stock (mercadería que llega)." },
  { id: "salida", label: "Salida", ayuda: "Resta del stock (merma, vencido, quebrado, consumo)." },
  { id: "conteo", label: "Conteo físico", ayuda: "Poné lo que contaste y el stock queda en ese número." },
];

const NUEVO_VACIO = { nombre: "", categoria: "", precio: "", unidad: "Unidades", stockActual: "", stockMinimo: "" };

const soloDigitos = (texto) => String(texto || "").replace(/\s/g, "");
const numero = (valor) => Number(valor) || 0;

// Inventario del minisúper: buscar o escanear por código de barras,
// ver existencias y registrar entradas, salidas y conteos.
export default function Inventario({ staff }) {
  const [busqueda, setBusqueda] = useState("");
  const [categoria, setCategoria] = useState("");
  const [soloBajos, setSoloBajos] = useState(false);
  const [seleccionadoId, setSeleccionadoId] = useState(null);
  const [tipo, setTipo] = useState("entrada");
  const [cantidad, setCantidad] = useState("");
  const [nota, setNota] = useState("");
  const [codigoEdit, setCodigoEdit] = useState("");
  const [codigoNuevo, setCodigoNuevo] = useState(""); // código escaneado que no existe
  const [nuevo, setNuevo] = useState(NUEVO_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const buscador = useRef(null);

  const productosQ = usePolling(() => consultar("productos", { orden: [["nombre"]] }), [], 20000);
  const movimientosQ = usePolling(
    () => consultar("movimientos", { orden: [["fecha", "desc"]], limite: 30 }),
    [],
    30000
  );

  const productos = (productosQ.datos || []).filter((p) => p.activo !== false);
  const seleccionado = productos.find((p) => p.id === seleccionadoId) || null;
  const nombrePorId = useMemo(
    () => Object.fromEntries((productosQ.datos || []).map((p) => [p.id, p.nombre])),
    [productosQ.datos]
  );

  const categorias = useMemo(
    () => [...new Set(productos.map((p) => p.categoria || "Otros"))].sort((a, b) => a.localeCompare(b)),
    [productos]
  );

  const esBajo = (p) => p.controlaStock && numero(p.stockActual) <= numero(p.stockMinimo);

  const resumen = useMemo(() => {
    const conStock = productos.filter((p) => p.controlaStock);
    return {
      total: productos.length,
      bajos: conStock.filter(esBajo).length,
      sinCodigo: productos.filter((p) => !p.codigoBarras).length,
      valor: conStock.reduce((s, p) => s + Math.max(numero(p.stockActual), 0) * numero(p.precio), 0),
    };
  }, [productos]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (categoria && (p.categoria || "Otros") !== categoria) return false;
      if (soloBajos && !esBajo(p)) return false;
      if (!q) return true;
      return (
        (p.nombre || "").toLowerCase().includes(q) ||
        String(p.codigoBarras || "").includes(soloDigitos(q))
      );
    });
  }, [productos, busqueda, categoria, soloBajos]);

  function limpiarAvisos() {
    setMensaje("");
    setError("");
  }

  function elegir(p) {
    limpiarAvisos();
    setSeleccionadoId(p.id);
    setCodigoEdit(p.codigoBarras || "");
    setCodigoNuevo("");
    setCantidad("");
    setNota("");
    setTipo("entrada");
  }

  function cerrarPanel() {
    setSeleccionadoId(null);
    setCodigoNuevo("");
    setNuevo(NUEVO_VACIO);
    buscador.current?.focus();
  }

  // El lector de códigos escribe el número y manda Enter
  function alBuscar(e) {
    e.preventDefault();
    limpiarAvisos();
    const texto = busqueda.trim();
    if (!texto) return;

    const codigo = soloDigitos(texto);
    const exacto = productos.find((p) => String(p.codigoBarras || "") === codigo);
    if (exacto) {
      elegir(exacto);
      setBusqueda("");
      return;
    }
    if (visibles.length === 1) {
      elegir(visibles[0]);
      setBusqueda("");
      return;
    }
    // Un número largo que no existe se toma como código de barras nuevo
    if (/^\d{6,}$/.test(codigo)) {
      setSeleccionadoId(null);
      setCodigoNuevo(codigo);
      setNuevo(NUEVO_VACIO);
      setBusqueda("");
    }
  }

  function codigoRepetido(codigo, exceptoId) {
    return (productosQ.datos || []).find(
      (p) => p.id !== exceptoId && String(p.codigoBarras || "") === codigo
    );
  }

  async function guardarCodigo() {
    limpiarAvisos();
    const codigo = soloDigitos(codigoEdit);
    const repetido = codigo && codigoRepetido(codigo, seleccionado.id);
    if (repetido) return setError(`Ese código ya lo tiene "${repetido.nombre}".`);

    setGuardando(true);
    try {
      await confirmar([actualizar("productos", seleccionado.id, { codigoBarras: codigo })]);
      setMensaje(codigo ? "Código de barras guardado." : "Código de barras quitado.");
      productosQ.recargar();
    } catch (e) {
      setError("No se pudo guardar el código: " + e.message);
    } finally {
      setGuardando(false);
    }
  }

  async function registrarMovimiento() {
    limpiarAvisos();
    const valor = Number(cantidad);
    if (cantidad === "" || !Number.isFinite(valor) || valor < 0 || (tipo !== "conteo" && valor === 0)) {
      return setError("Poné una cantidad válida.");
    }

    const actual = numero(seleccionado.stockActual);
    const cambio = tipo === "entrada" ? valor : tipo === "salida" ? -valor : valor - actual;
    if (cambio === 0) return setMensaje("El stock ya está en ese número; no hubo cambio.");

    setGuardando(true);
    try {
      // El producto empieza a controlar stock en cuanto se le registra inventario
      const cambiosProducto = { stockActual: incremento(cambio) };
      if (!seleccionado.controlaStock) cambiosProducto.controlaStock = true;

      await confirmar([
        actualizar("productos", seleccionado.id, cambiosProducto),
        crear("movimientos", nuevoIdDoc(), {
          productoId: seleccionado.id,
          cantidad: cambio,
          motivo: tipo === "conteo" ? "conteo físico" : tipo,
          nota: nota.trim(),
          uid: staff?.uid ?? null,
          empleadoNombre: staff?.nombre || "",
          fecha: ahora(),
        }),
      ]);
      setMensaje(`${seleccionado.nombre}: stock ${actual} → ${actual + cambio}.`);
      setCantidad("");
      setNota("");
      productosQ.recargar();
      movimientosQ.recargar();
      buscador.current?.focus();
    } catch (e) {
      setError("No se pudo registrar: " + e.message);
    } finally {
      setGuardando(false);
    }
  }

  async function crearProducto(e) {
    e.preventDefault();
    limpiarAvisos();
    if (!nuevo.nombre.trim()) return setError("Poné el nombre del producto.");
    const repetido = codigoRepetido(codigoNuevo, null);
    if (repetido) return setError(`Ese código ya lo tiene "${repetido.nombre}".`);

    setGuardando(true);
    try {
      const id = nuevoIdDoc();
      const stockInicial = numero(nuevo.stockActual);
      const escrituras = [
        crear("productos", id, {
          nombre: nuevo.nombre.trim(),
          categoria: nuevo.categoria.trim() || "Otros",
          precio: numero(nuevo.precio),
          tipo: TIPO_PRODUCTO.VENTA,
          posicion: 0,
          unidad: nuevo.unidad.trim() || "Unidades",
          cabys: "",
          tarifaCodigo: "08",
          color: COLORES_PRODUCTO[0],
          codigoBarras: codigoNuevo,
          stockActual: stockInicial,
          stockMinimo: numero(nuevo.stockMinimo),
          controlaStock: true,
          activo: true,
          creadoEn: ahora(),
        }),
      ];
      if (stockInicial !== 0) {
        escrituras.push(
          crear("movimientos", nuevoIdDoc(), {
            productoId: id,
            cantidad: stockInicial,
            motivo: "inventario inicial",
            nota: "",
            uid: staff?.uid ?? null,
            empleadoNombre: staff?.nombre || "",
            fecha: ahora(),
          })
        );
      }
      await confirmar(escrituras);
      setMensaje(`Producto "${nuevo.nombre.trim()}" creado con el código ${codigoNuevo}.`);
      setCodigoNuevo("");
      setNuevo(NUEVO_VACIO);
      productosQ.recargar();
      movimientosQ.recargar();
      buscador.current?.focus();
    } catch (err) {
      setError("No se pudo crear: " + err.message);
    } finally {
      setGuardando(false);
    }
  }

  const ayudaTipo = TIPOS_MOVIMIENTO.find((t) => t.id === tipo)?.ayuda;

  return (
    <section className="stack">
      <div>
        <h2>Inventario</h2>
        <p>Escaneá el código de barras o buscá por nombre para ver y ajustar existencias.</p>
      </div>

      <div className="metricas" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        <div className="metrica">
          <span className="metrica__label">Productos</span>
          <span className="metrica__valor">{resumen.total}</span>
        </div>
        <div className="metrica">
          <span className="metrica__label">Bajo mínimo</span>
          <span className="metrica__valor">{resumen.bajos}</span>
        </div>
        <div className="metrica">
          <span className="metrica__label">Sin código de barras</span>
          <span className="metrica__valor">{resumen.sinCodigo}</span>
        </div>
        <div className="metrica">
          <span className="metrica__label">Valor a precio de venta</span>
          <span className="metrica__valor">{colones(resumen.valor)}</span>
        </div>
      </div>

      <div className="card">
        <form onSubmit={alBuscar} className="pago-fila">
          <input
            ref={buscador}
            autoFocus
            inputMode="search"
            placeholder="Escanear código o escribir nombre"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
          <button className="btn primary">Buscar</button>
        </form>

        <div className="chips" style={{ marginTop: 12 }}>
          <button className={"chip" + (!categoria ? " activo" : "")} onClick={() => setCategoria("")}>
            Todas
          </button>
          {categorias.map((c) => (
            <button
              key={c}
              className={"chip" + (categoria === c ? " activo" : "")}
              onClick={() => setCategoria(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={soloBajos} onChange={(e) => setSoloBajos(e.target.checked)} />
          Ver solo los que están bajo el mínimo
        </label>

        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
        {mensaje && <p className="ok" style={{ marginTop: 12 }}>{mensaje}</p>}
      </div>

      {codigoNuevo && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Producto nuevo · código {codigoNuevo}</h3>
          <p>Ese código no está registrado. Completá los datos para agregarlo al inventario.</p>
          <form onSubmit={crearProducto} className="stack" style={{ marginTop: 12 }}>
            <div className="formulario">
              <input placeholder="Nombre" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} required />
              <input placeholder="Categoría (ej. Licores, Cervezas, Abarrotes)" value={nuevo.categoria} onChange={(e) => setNuevo({ ...nuevo, categoria: e.target.value })} />
              <input type="number" min="0" placeholder="Precio ₡" value={nuevo.precio} onChange={(e) => setNuevo({ ...nuevo, precio: e.target.value })} required />
              <input placeholder="Unidad (Unidades, Kg, Litros…)" value={nuevo.unidad} onChange={(e) => setNuevo({ ...nuevo, unidad: e.target.value })} />
              <input type="number" step="any" min="0" placeholder="Stock actual" value={nuevo.stockActual} onChange={(e) => setNuevo({ ...nuevo, stockActual: e.target.value })} />
              <input type="number" step="any" min="0" placeholder="Stock mínimo" value={nuevo.stockMinimo} onChange={(e) => setNuevo({ ...nuevo, stockMinimo: e.target.value })} />
            </div>
            <div className="acciones">
              <button type="button" className="btn" onClick={cerrarPanel}>Cancelar</button>
              <button className="btn primary" disabled={guardando}>
                {guardando ? "Guardando..." : "Crear producto"}
              </button>
            </div>
          </form>
        </div>
      )}

      {seleccionado && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{seleccionado.nombre}</h3>
          <p>
            {seleccionado.categoria || "Otros"} · {colones(seleccionado.precio)} · Stock actual:{" "}
            <strong className={esBajo(seleccionado) ? "error" : ""}>
              {seleccionado.controlaStock ? numero(seleccionado.stockActual) : "sin control"}
            </strong>{" "}
            {seleccionado.unidad || ""} · Mínimo: {numero(seleccionado.stockMinimo)}
          </p>

          <h3>Código de barras</h3>
          <div className="pago-fila">
            <input
              inputMode="numeric"
              placeholder="Escanear o escribir el código"
              value={codigoEdit}
              onChange={(e) => setCodigoEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  guardarCodigo();
                }
              }}
            />
            <button className="btn" disabled={guardando} onClick={guardarCodigo}>Guardar código</button>
          </div>

          <h3>Movimiento de inventario</h3>
          <div className="chips">
            {TIPOS_MOVIMIENTO.map((t) => (
              <button key={t.id} className={"chip" + (tipo === t.id ? " activo" : "")} onClick={() => setTipo(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <p style={{ margin: "8px 0" }}><small>{ayudaTipo}</small></p>
          <div className="formulario">
            <input
              type="number"
              step="any"
              min="0"
              inputMode="decimal"
              placeholder={tipo === "conteo" ? "Cantidad contada" : "Cantidad"}
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
            />
            <input placeholder="Nota (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} />
          </div>
          <div className="acciones">
            <button className="btn" onClick={cerrarPanel}>Cerrar</button>
            <button className="btn primary" disabled={guardando} onClick={registrarMovimiento}>
              {guardando ? "Guardando..." : "Registrar"}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Existencias ({visibles.length})</h3>
        {productosQ.error && <p className="error">{productosQ.error}</p>}
        {productosQ.datos && visibles.length === 0 && <p>No hay productos con ese filtro.</p>}
        {visibles.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="tabla">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Stock</th>
                  <th>Mínimo</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((p) => (
                  <tr key={p.id} onClick={() => elegir(p)} style={{ cursor: "pointer" }}>
                    <td>
                      <strong>{p.nombre}</strong>
                      <br />
                      <small>{p.codigoBarras || "Sin código"}</small>
                      <br />
                      <small>{p.categoria || "Otros"} · {colones(p.precio)}</small>
                    </td>
                    <td className={esBajo(p) ? "error" : ""}>
                      {p.controlaStock ? numero(p.stockActual) : "—"}
                    </td>
                    <td>{p.controlaStock ? numero(p.stockMinimo) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Últimos movimientos</h3>
        {(movimientosQ.datos || []).length === 0 && <p>Todavía no hay movimientos.</p>}
        {(movimientosQ.datos || []).length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="tabla">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Producto</th>
                  <th>Cantidad</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {movimientosQ.datos.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.fecha instanceof Date ? `${m.fecha.toLocaleDateString("es-CR")} ${horaCorta(m.fecha)}` : "—"}
                    </td>
                    <td>{nombrePorId[m.productoId] || "Producto borrado"}</td>
                    <td className={numero(m.cantidad) < 0 ? "error" : "ok"}>
                      {numero(m.cantidad) > 0 ? "+" : ""}{numero(m.cantidad)}
                    </td>
                    <td>
                      {m.motivo || "—"}
                      {m.nota ? ` · ${m.nota}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
