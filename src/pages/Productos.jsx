import { useState } from "react";
import { actualizar, ahora, confirmar, consultar, crear, nuevoIdDoc, usePolling } from "../lib/api.js";
import { COLORES_PRODUCTO, TARIFAS_IMPUESTO, TIPO_PRODUCTO } from "../lib/constants.js";
import { colones } from "../lib/format.js";

const FORM_VACIO = {
  nombre: "",
  codigoBarras: "",
  categoria: "",
  precio: "",
  posicion: "",
  unidad: "Unidades",
  cabys: "",
  tarifaCodigo: "08",
  color: COLORES_PRODUCTO[0],
  stockActual: "",
  stockMinimo: "",
  controlaStock: false,
};

export default function Productos() {
  const [form, setForm] = useState(FORM_VACIO);
  const [editandoId, setEditandoId] = useState(null);
  const [msg, setMsg] = useState("");

  const productosQ = usePolling(() => consultar("productos", { orden: [["posicion"]] }), [], 15000);
  const productos = productosQ.datos || [];

  const bajoMinimo = productos.filter(
    (p) =>
      p.activo !== false &&
      p.controlaStock &&
      Number(p.stockActual) <= Number(p.stockMinimo)
  );

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function editar(p) {
    setEditandoId(p.id);
    setForm({
      ...FORM_VACIO,
      nombre: p.nombre || "",
      codigoBarras: p.codigoBarras || "",
      categoria: p.categoria || "",
      precio: String(p.precio ?? ""),
      posicion: String(p.posicion ?? ""),
      unidad: p.unidad || "Unidades",
      cabys: p.cabys || "",
      tarifaCodigo: p.tarifaCodigo || "08",
      color: p.color || COLORES_PRODUCTO[0],
      stockActual: String(p.stockActual ?? ""),
      stockMinimo: String(p.stockMinimo ?? ""),
      controlaStock: !!p.controlaStock,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function limpiar() {
    setEditandoId(null);
    setForm(FORM_VACIO);
  }

  async function guardarProducto(e) {
    e.preventDefault();
    setMsg("");
    const codigoBarras = form.codigoBarras.replace(/\s/g, "");
    const repetido = codigoBarras
      ? productos.find((p) => p.id !== editandoId && String(p.codigoBarras || "") === codigoBarras)
      : null;
    if (repetido) {
      setMsg(`Error: ese código de barras ya lo tiene "${repetido.nombre}".`);
      return;
    }
    const data = {
      nombre: form.nombre.trim(),
      codigoBarras,
      categoria: form.categoria.trim() || "Otros",
      precio: Number(form.precio) || 0,
      tipo: TIPO_PRODUCTO.VENTA,
      posicion: Number(form.posicion) || 0,
      unidad: form.unidad,
      cabys: form.cabys.trim(),
      tarifaCodigo: form.tarifaCodigo,
      color: form.color,
      stockActual: Number(form.stockActual) || 0,
      stockMinimo: Number(form.stockMinimo) || 0,
      controlaStock: form.controlaStock,
    };
    try {
      if (editandoId) {
        await confirmar([actualizar("productos", editandoId, data)]);
      } else {
        await confirmar([
          crear("productos", nuevoIdDoc(), { ...data, activo: true, creadoEn: ahora() }),
        ]);
      }
      setMsg("Producto guardado.");
      limpiar();
      productosQ.recargar();
    } catch (err) {
      setMsg("Error: " + err.message);
    }
  }

  async function toggleActivo(p) {
    try {
      await confirmar([actualizar("productos", p.id, { activo: !(p.activo !== false) })]);
      productosQ.recargar();
    } catch (err) {
      setMsg("Error: " + err.message);
    }
  }

  return (
    <div className="stack">
      {msg && <p className={msg.startsWith("Error") ? "error" : "ok"}>{msg}</p>}

      <section className="card">
        <h2>{editandoId ? "Editar producto" : "Nuevo producto"}</h2>
        <form onSubmit={guardarProducto} className="stack">
          <div className="formulario">
            <input placeholder="Nombre" value={form.nombre} onChange={(e) => set("nombre", e.target.value)} required />
            <input
              inputMode="numeric"
              placeholder="Código de barras (escanear o escribir)"
              value={form.codigoBarras}
              onChange={(e) => set("codigoBarras", e.target.value)}
              onKeyDown={(e) => {
                // El lector manda Enter al final; no debe guardar el formulario
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <input placeholder="Categoría (ej. Licores, Cervezas, Abarrotes)" value={form.categoria} onChange={(e) => set("categoria", e.target.value)} />
            <input type="number" min="0" placeholder="Precio ₡" value={form.precio} onChange={(e) => set("precio", e.target.value)} required />
            <input type="number" placeholder="Orden en lista" value={form.posicion} onChange={(e) => set("posicion", e.target.value)} />
            <input placeholder="Unidad (Unidades, Kg, Litros…)" value={form.unidad} onChange={(e) => set("unidad", e.target.value)} />
            <input placeholder="Código CABYS" value={form.cabys} onChange={(e) => set("cabys", e.target.value)} />
            <select value={form.tarifaCodigo} onChange={(e) => set("tarifaCodigo", e.target.value)}>
              {TARIFAS_IMPUESTO.map((t) => (
                <option key={t.codigo} value={t.codigo}>{t.label}</option>
              ))}
            </select>
            <div className="colores">
              {COLORES_PRODUCTO.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={"color-op" + (form.color === c ? " sel" : "")}
                  style={{ background: c }}
                  onClick={() => set("color", c)}
                  aria-label={"Color " + c}
                />
              ))}
            </div>
            <input type="number" step="any" placeholder="Stock actual" value={form.stockActual} onChange={(e) => set("stockActual", e.target.value)} />
            <input type="number" step="any" placeholder="Stock mínimo" value={form.stockMinimo} onChange={(e) => set("stockMinimo", e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={form.controlaStock} onChange={(e) => set("controlaStock", e.target.checked)} />
              Descuenta su propio stock al vender
            </label>
          </div>

          <div className="acciones">
            {editandoId && <button type="button" className="btn" onClick={limpiar}>Cancelar</button>}
            <button className="btn primary">{editandoId ? "Guardar cambios" : "Crear producto"}</button>
          </div>
        </form>
      </section>

      {bajoMinimo.length > 0 && (
        <section className="card">
          <h2>Stock bajo</h2>
          {bajoMinimo.map((p) => (
            <p key={p.id} className="error">
              {p.nombre}: quedan {p.stockActual} (mínimo {p.stockMinimo})
            </p>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Productos</h2>
        <table className="tabla">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Código</th>
              <th>Precio</th>
              <th>Stock</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {productos.map((p) => {
              const bajo = p.controlaStock && Number(p.stockActual) <= Number(p.stockMinimo);
              return (
                <tr key={p.id} style={{ opacity: p.activo === false ? 0.5 : 1 }}>
                  <td>
                    <span className="color-dot" style={{ background: p.color || "#8f7c68" }} />
                    {p.nombre}
                  </td>
                  <td>{p.codigoBarras || "—"}</td>
                  <td>{colones(p.precio)}</td>
                  <td className={bajo ? "error" : ""}>{p.controlaStock ? p.stockActual : "—"}</td>
                  <td>
                    <button className="btn" onClick={() => editar(p)}>Editar</button>{" "}
                    <button className="btn" onClick={() => toggleActivo(p)}>
                      {p.activo === false ? "Activar" : "Desactivar"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
