import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actualizar, ahora, confirmar, consultar, crear, incremento, leerDoc, nuevoIdDoc, usePolling } from "../lib/api.js";
import { emitirComprobante, errorCedula, TIPOS_CEDULA } from "../lib/facturacion.js";
import { ESTADO_PEDIDO, METODOS_PAGO } from "../lib/constants.js";
import { colones, nuevoId } from "../lib/format.js";
import Ticket, { subtotalItem, textoCantidad } from "./Ticket.jsx";

// Espera después de la última tecla antes de agregar solo un código conocido.
// El lector escribe todo el código en pocos milisegundos; así no se corta un código largo.
const ESPERA_ESCANEO_MS = 150;

// Billetes para cobrar rápido en efectivo
const BILLETES = [1000, 2000, 5000, 10000, 20000];

const CLIENTE_VACIO = { factura: false, tipo: "01", cedula: "", nombre: "", correo: "" };

const normalizar = (texto) => String(texto || "").trim().toLowerCase();
const numero = (valor) => Number(String(valor ?? "").replace(",", ".")) || 0;

function leerCarrito(clave) {
  try {
    const guardado = JSON.parse(localStorage.getItem(clave) || "[]");
    return Array.isArray(guardado) ? guardado : [];
  } catch {
    return [];
  }
}

// Pantalla de venta de la caja: se escanea el código de barras (o se busca por nombre),
// se arma la compra, se cobra y se imprime el comprobante. Descuenta el inventario.
export default function Venta({ caja, turno, staff, onVendido }) {
  const claveCarrito = `carrito_${caja.id}`;
  const [carrito, setCarrito] = useState(() => leerCarrito(claveCarrito));
  const [entrada, setEntrada] = useState("");
  const [resultados, setResultados] = useState([]);
  const [pesando, setPesando] = useState(null); // { producto } mientras se pide el peso
  const [peso, setPeso] = useState("");
  const [ultimoId, setUltimoId] = useState(null);
  const [cobrando, setCobrando] = useState(false);
  const [metodo, setMetodo] = useState("efectivo");
  const [recibido, setRecibido] = useState("");
  const [pagosMixtos, setPagosMixtos] = useState([]);
  const [cliente, setCliente] = useState(CLIENTE_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [ticket, setTicket] = useState(null); // { venta, fecha, factura }
  const [error, setError] = useState("");
  const escaner = useRef(null);
  const campoPeso = useRef(null);
  const temporizador = useRef(null);

  // ¿Está encendida la facturación electrónica? (la enciende el admin en Facturación)
  const facturacionQ = usePolling(() => leerDoc("configuracion", "facturacion"), [], 60000);
  const facturacionActiva = !!facturacionQ.datos?.activa;

  const productosQ = usePolling(() => consultar("productos", { orden: [["nombre"]] }), [], 30000);
  const productos = useMemo(
    () => (productosQ.datos || []).filter((p) => p.activo !== false),
    [productosQ.datos]
  );
  const porCodigo = useMemo(() => {
    const mapa = {};
    for (const p of productos) if (p.codigoBarras) mapa[String(p.codigoBarras)] = p;
    return mapa;
  }, [productos]);
  const porId = useMemo(() => Object.fromEntries(productos.map((p) => [p.id, p])), [productos]);

  const total = carrito.reduce((s, i) => s + subtotalItem(i), 0);
  const articulos = carrito.reduce((s, i) => s + (i.unidad === "Kg" ? 1 : Number(i.cantidad) || 0), 0);

  // El carrito se guarda en este dispositivo para no perder la compra si se recarga la página
  useEffect(() => {
    try {
      localStorage.setItem(claveCarrito, JSON.stringify(carrito));
    } catch {
      /* sin almacenamiento: el carrito vive solo en memoria */
    }
  }, [carrito, claveCarrito]);

  useEffect(() => {
    if (pesando) campoPeso.current?.focus();
  }, [pesando]);

  useEffect(() => () => clearTimeout(temporizador.current), []);

  // Si lo escrito es un código de barras registrado, se agrega solo, sin tocar Agregar ni Enter
  function alEscribir(valor) {
    setEntrada(valor);
    clearTimeout(temporizador.current);
    const codigo = valor.replace(/\s/g, "");
    if (!/^\d{6,}$/.test(codigo)) return;
    const producto = porCodigo[codigo];
    if (!producto) return;
    temporizador.current = setTimeout(() => {
      setEntrada("");
      agregar(producto, 0);
    }, ESPERA_ESCANEO_MS);
  }

  function enfocarEscaner() {
    setTimeout(() => escaner.current?.focus(), 0);
  }

  function agregar(producto, cantidad) {
    setError("");
    setResultados([]);
    if (!(Number(producto.precio) > 0)) {
      setError(`"${producto.nombre}" no tiene precio. El administrador lo pone en Inventario.`);
      return enfocarEscaner();
    }
    // Lo que se vende por kilo necesita el peso
    if (producto.unidad === "Kg" && !cantidad) {
      setPesando({ producto });
      setPeso("");
      return;
    }

    const cant = cantidad || 1;
    if (producto.unidad === "Kg") {
      const id = nuevoId();
      setCarrito((c) => [
        ...c,
        {
          id,
          productoId: producto.id,
          nombre: producto.nombre,
          precio: Number(producto.precio),
          cantidad: Math.round(cant * 1000) / 1000,
          unidad: "Kg",
        },
      ]);
      setUltimoId(id);
    } else {
      // El mismo producto escaneado otra vez suma a su línea
      const existente = carrito.find((i) => i.productoId === producto.id && i.unidad !== "Kg");
      if (existente) {
        setCarrito((c) => c.map((i) => (i.id === existente.id ? { ...i, cantidad: i.cantidad + cant } : i)));
        setUltimoId(existente.id);
      } else {
        const id = nuevoId();
        setCarrito((c) => [
          ...c,
          {
            id,
            productoId: producto.id,
            nombre: producto.nombre,
            precio: Number(producto.precio),
            cantidad: cant,
            unidad: producto.unidad || "Unidades",
          },
        ]);
        setUltimoId(id);
      }
    }
    enfocarEscaner();
  }

  // El lector de códigos escribe el número y manda Enter.
  // "3*código" agrega 3 unidades de una vez.
  function alEscanear(e) {
    e.preventDefault();
    clearTimeout(temporizador.current);
    setError("");
    let texto = entrada.trim();
    setEntrada("");
    if (!texto) return;

    let cantidad = 0;
    const multiplicador = texto.match(/^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/);
    if (multiplicador) {
      cantidad = numero(multiplicador[1]);
      texto = multiplicador[2].trim();
    }

    const codigo = texto.replace(/\s/g, "");
    const encontrado =
      porCodigo[codigo] || productos.find((p) => normalizar(p.nombre) === normalizar(texto));
    if (encontrado) return agregar(encontrado, cantidad);

    if (/^\d{6,}$/.test(codigo)) {
      setResultados([]);
      setError(`El código ${codigo} no está registrado. El administrador lo agrega en Inventario.`);
      return enfocarEscaner();
    }

    const q = normalizar(texto);
    const coincidencias = productos.filter((p) => normalizar(p.nombre).includes(q)).slice(0, 8);
    if (coincidencias.length === 1) return agregar(coincidencias[0], cantidad);
    if (coincidencias.length === 0) {
      setResultados([]);
      setError(`No hay productos que digan "${texto}".`);
      return enfocarEscaner();
    }
    setResultados(coincidencias);
  }

  function confirmarPeso(e) {
    e.preventDefault();
    const kilos = numero(peso);
    if (!(kilos > 0)) return setError("Poné el peso en kilos, por ejemplo 0.750");
    const producto = pesando.producto;
    setPesando(null);
    agregar(producto, kilos);
  }

  function cambiarCantidad(id, delta) {
    setCarrito((c) =>
      c
        .map((i) => (i.id === id ? { ...i, cantidad: i.cantidad + delta } : i))
        .filter((i) => i.cantidad > 0)
    );
    enfocarEscaner();
  }

  function quitar(id) {
    setCarrito((c) => c.filter((i) => i.id !== id));
    enfocarEscaner();
  }

  function cancelarVenta() {
    if (!carrito.length) return;
    if (!confirm("¿Borrar todos los productos de esta compra?")) return;
    setCarrito([]);
    setError("");
    enfocarEscaner();
  }

  function abrirCobro() {
    setError("");
    if (!carrito.length) return setError("Escaneá al menos un producto.");
    setMetodo("efectivo");
    setRecibido("");
    setCliente(CLIENTE_VACIO);
    setPagosMixtos([
      { metodo: "efectivo", monto: "" },
      { metodo: "tarjeta", monto: "" },
    ]);
    setCobrando(true);
  }

  // Pagos según el método elegido
  const recibidoNum = Math.round(numero(recibido));
  const sumaMixta = pagosMixtos.reduce((s, p) => s + Math.round(numero(p.monto)), 0);
  let pagos = [];
  let vuelto = 0;
  let listo = false;
  if (metodo === "mixto") {
    pagos = pagosMixtos
      .map((p) => ({ metodo: p.metodo, monto: Math.round(numero(p.monto)) }))
      .filter((p) => p.monto > 0);
    listo = total > 0 && sumaMixta === total;
  } else if (metodo === "efectivo") {
    pagos = [{ metodo: "efectivo", monto: total }];
    // Si no se escribe lo recibido, se toma como pago exacto
    vuelto = recibido === "" ? 0 : recibidoNum - total;
    listo = total > 0 && (recibido === "" || recibidoNum >= total);
  } else {
    pagos = [{ metodo, monto: total }];
    listo = total > 0;
  }

  // Datos del cliente para la factura electrónica (opcionales)
  function datosCliente() {
    const correo = cliente.correo.trim().toLowerCase();
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return { error: "El correo del cliente no es válido." };
    if (!cliente.factura) return { valor: correo ? { correo } : null };
    const problema = errorCedula(cliente.tipo, cliente.cedula);
    if (problema) return { error: problema };
    if (!cliente.nombre.trim()) return { error: "Poné el nombre del cliente para la factura." };
    return {
      valor: {
        tipo: cliente.tipo,
        cedula: cliente.cedula.replace(/\D/g, ""),
        nombre: cliente.nombre.trim(),
        correo: correo || null,
      },
    };
  }

  async function confirmarCobro() {
    if (!listo || guardando) return;
    setError("");
    const datos = facturacionActiva ? datosCliente() : { valor: null };
    if (datos.error) return setError(datos.error);
    setGuardando(true);

    const idVenta = nuevoIdDoc();
    const items = carrito.map((i) => ({ ...i, precio: Number(i.precio), cantidad: Number(i.cantidad) }));
    const venta = {
      tipo: "venta",
      estado: ESTADO_PEDIDO.COBRADO,
      items,
      total,
      pagos,
      recibido: metodo === "efectivo" && recibido !== "" ? recibidoNum : 0,
      vuelto: metodo === "efectivo" && recibido !== "" ? vuelto : 0,
      cajaId: caja.id,
      cajaNombre: caja.nombre,
      turnoId: turno.id,
      empleadoUid: staff?.uid ?? null,
      empleadoNombre: staff?.nombre || turno.empleadoNombre || "",
      cliente: datos.valor,
      creadoEn: ahora(),
      cobradoEn: ahora(),
    };

    // Inventario: se descuenta una vez por producto
    const porProducto = {};
    for (const i of items) {
      const prod = porId[i.productoId];
      if (!prod?.controlaStock) continue;
      porProducto[i.productoId] = (porProducto[i.productoId] || 0) + i.cantidad;
    }
    const escrituras = [crear("pedidos", idVenta, venta)];
    for (const [productoId, cantidad] of Object.entries(porProducto)) {
      const descuento = Math.round(cantidad * 1000) / 1000;
      escrituras.push(
        actualizar("productos", productoId, { stockActual: incremento(-descuento) }),
        crear("movimientos", nuevoIdDoc(), {
          productoId,
          cantidad: -descuento,
          motivo: "venta",
          pedidoId: idVenta,
          cajaId: caja.id,
          uid: staff?.uid ?? null,
          empleadoNombre: venta.empleadoNombre,
          fecha: ahora(),
        })
      );
    }

    try {
      await confirmar(escrituras);
      setTicket({ venta: { ...venta, id: idVenta }, fecha: new Date(), factura: facturacionActiva ? { estado: "emitiendo" } : null });
      if (facturacionActiva) {
        // Se envía a Hacienda sin hacer esperar a la cajera; el comprobante se actualiza al llegar la respuesta
        const actualizarFactura = (factura) =>
          setTicket((t) => (t && t.venta.id === idVenta ? { ...t, factura } : t));
        emitirComprobante(idVenta)
          .then(actualizarFactura)
          .catch((e) => actualizarFactura({ estado: "error", error: e.message }));
      }
      setCarrito([]);
      setCobrando(false);
      setResultados([]);
      onVendido?.();
      productosQ.recargar();
    } catch (e) {
      setError("No se pudo cobrar: " + e.message);
    } finally {
      setGuardando(false);
    }
  }

  function siguienteCliente() {
    setTicket(null);
    enfocarEscaner();
  }

  const billetes = BILLETES.filter((b) => b >= total);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Venta · {caja.nombre}</h3>

      <form onSubmit={alEscanear} className="pago-fila">
        <input
          ref={escaner}
          autoFocus
          autoComplete="off"
          inputMode="search"
          placeholder="Escanear código o escribir nombre"
          value={entrada}
          onChange={(e) => alEscribir(e.target.value)}
          disabled={cobrando || !!pesando || !!ticket}
        />
        <button className="btn primary" disabled={cobrando || !!pesando || !!ticket}>Agregar</button>
      </form>
      <p style={{ marginTop: 6 }}>
        <small>
          Al escanear se agrega solo. Para varias unidades: 6*código y Enter. Lo que se vende por kilo pide el peso.
        </small>
      </p>

      {productosQ.error && <p className="error">{productosQ.error}</p>}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}

      {resultados.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p><small>Tocá el producto:</small></p>
          {resultados.map((p) => (
            <div key={p.id} className="item" onClick={() => agregar(p)}>
              <div className="item-linea">
                <span>{p.nombre}</span>
                <span>
                  {Number(p.precio) > 0 ? colones(p.precio) : "sin precio"}
                  {p.unidad === "Kg" ? "/kg" : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {pesando && (
        <form onSubmit={confirmarPeso} className="item sel" style={{ marginTop: 10, cursor: "default" }}>
          <p>
            <strong>{pesando.producto.nombre}</strong> · {colones(pesando.producto.precio)}/kg
          </p>
          <div className="pago-fila" style={{ marginTop: 8 }}>
            <input
              ref={campoPeso}
              type="number"
              step="any"
              min="0"
              inputMode="decimal"
              placeholder="Peso en kg (ej. 0.750)"
              value={peso}
              onChange={(e) => setPeso(e.target.value)}
            />
            <button className="btn primary">Agregar</button>
          </div>
          {numero(peso) > 0 && (
            <p style={{ marginTop: 6 }}>
              Subtotal: <strong>{colones(numero(peso) * pesando.producto.precio)}</strong>
            </p>
          )}
          <div className="acciones">
            <button type="button" className="btn" onClick={() => { setPesando(null); enfocarEscaner(); }}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div style={{ marginTop: 14 }}>
        {carrito.length === 0 && <p>Escaneá el primer producto.</p>}
        {carrito.map((i) => {
          const prod = porId[i.productoId];
          const sinStock = prod?.controlaStock && Number(prod.stockActual) < i.cantidad;
          return (
            <div key={i.id} className={"item" + (i.id === ultimoId ? " sel" : "")} style={{ cursor: "default" }}>
              <div className="item-linea">
                <span>{i.nombre}</span>
                <strong>{colones(subtotalItem(i))}</strong>
              </div>
              <small>
                {textoCantidad(i)} × {colones(i.precio)}
                {i.unidad === "Kg" ? "/kg" : ""}
                {sinStock ? ` · inventario: ${Number(prod.stockActual)}` : ""}
              </small>
              <div className="item-acciones">
                {i.unidad !== "Kg" && (
                  <>
                    <button className="btn" aria-label="Quitar una" onClick={() => cambiarCantidad(i.id, -1)}>−</button>
                    <strong style={{ minWidth: 28, textAlign: "center" }}>{i.cantidad}</strong>
                    <button className="btn" aria-label="Agregar una" onClick={() => cambiarCantidad(i.id, 1)}>+</button>
                  </>
                )}
                <button className="btn peligro" aria-label="Quitar producto" style={{ marginLeft: "auto" }} onClick={() => quitar(i.id)}>
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="total">
        <span>{articulos} {articulos === 1 ? "artículo" : "artículos"}</span>
        <strong>{colones(total)}</strong>
      </div>

      <div className="acciones">
        <button className="btn" disabled={!carrito.length} onClick={cancelarVenta}>Cancelar venta</button>
        <button className="btn primary" disabled={!carrito.length} onClick={abrirCobro} style={{ flex: 1 }}>
          Cobrar {colones(total)}
        </button>
      </div>

      {/* Las ventanas van sobre toda la página: dentro de la tarjeta quedarían tapadas */}
      {cobrando && createPortal(
        <div className="modal-fondo">
          <div className="modal card">
            <h2>Cobrar</h2>
            <p className="total-grande">{colones(total)}</p>

            <div className="chips">
              {METODOS_PAGO.map((m) => (
                <button key={m.id} className={"chip" + (metodo === m.id ? " activo" : "")} onClick={() => setMetodo(m.id)}>
                  {m.label}
                </button>
              ))}
              <button className={"chip" + (metodo === "mixto" ? " activo" : "")} onClick={() => setMetodo("mixto")}>
                Mixto
              </button>
            </div>

            {metodo === "efectivo" && (
              <>
                <label>
                  <span className="check">Recibido (vacío = monto exacto)</span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    autoFocus
                    placeholder={String(total)}
                    value={recibido}
                    onChange={(e) => setRecibido(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        confirmarCobro();
                      }
                    }}
                  />
                </label>
                <div className="chips">
                  {billetes.map((b) => (
                    <button key={b} className="chip" onClick={() => setRecibido(String(b))}>
                      {colones(b)}
                    </button>
                  ))}
                </div>
                {recibido !== "" && (
                  <p className={recibidoNum >= total ? "ok" : "error"} style={{ fontSize: 22 }}>
                    {recibidoNum >= total
                      ? `Vuelto: ${colones(recibidoNum - total)}`
                      : `Faltan ${colones(total - recibidoNum)}`}
                  </p>
                )}
              </>
            )}

            {metodo === "mixto" && (
              <>
                {pagosMixtos.map((p, idx) => (
                  <div className="pago-fila" key={idx}>
                    <select
                      value={p.metodo}
                      onChange={(e) =>
                        setPagosMixtos((prev) => prev.map((x, j) => (j === idx ? { ...x, metodo: e.target.value } : x)))
                      }
                    >
                      {METODOS_PAGO.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      placeholder="Monto"
                      value={p.monto}
                      onChange={(e) =>
                        setPagosMixtos((prev) => prev.map((x, j) => (j === idx ? { ...x, monto: e.target.value } : x)))
                      }
                    />
                  </div>
                ))}
                <p className={sumaMixta === total ? "ok" : "error"}>
                  Pagado {colones(sumaMixta)} ·{" "}
                  {sumaMixta < total
                    ? `Faltan ${colones(total - sumaMixta)}`
                    : sumaMixta > total
                      ? `Sobran ${colones(sumaMixta - total)}`
                      : "Cuadra"}
                </p>
              </>
            )}

            {(metodo === "tarjeta" || metodo === "sinpe") && (
              <p>Confirmá que el pago de {colones(total)} entró antes de cobrar.</p>
            )}

            {facturacionActiva && (
              <div className="stack" style={{ gap: 8 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cliente.factura}
                    onChange={(e) => setCliente({ ...cliente, factura: e.target.checked })}
                  />
                  Factura a nombre del cliente (con cédula)
                </label>
                {cliente.factura && (
                  <div className="formulario">
                    <select value={cliente.tipo} onChange={(e) => setCliente({ ...cliente, tipo: e.target.value })}>
                      {TIPOS_CEDULA.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <input
                      inputMode="numeric"
                      placeholder="Número de identificación, sin guiones"
                      value={cliente.cedula}
                      onChange={(e) => setCliente({ ...cliente, cedula: e.target.value })}
                    />
                    <input
                      placeholder="Nombre o razón social"
                      value={cliente.nombre}
                      onChange={(e) => setCliente({ ...cliente, nombre: e.target.value })}
                    />
                  </div>
                )}
                <input
                  type="email"
                  autoCapitalize="none"
                  placeholder="Correo del cliente para enviarle el comprobante (opcional)"
                  value={cliente.correo}
                  onChange={(e) => setCliente({ ...cliente, correo: e.target.value })}
                />
              </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="acciones">
              <button className="btn" disabled={guardando} onClick={() => { setCobrando(false); enfocarEscaner(); }}>
                Volver
              </button>
              <button className="btn primary" disabled={!listo || guardando} onClick={confirmarCobro}>
                {guardando ? "Cobrando..." : "Confirmar cobro"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {ticket &&
        createPortal(
          <Ticket venta={ticket.venta} fecha={ticket.fecha} factura={ticket.factura} onCerrar={siguienteCliente} />,
          document.body
        )}
    </div>
  );
}
