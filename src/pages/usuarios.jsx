import { useState } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth, crearCuenta } from "../firebase.js";
import { actualizar, ahora, confirmar, consultar, crear, leerDoc, usePolling } from "../lib/api.js";
import { ROL } from "../lib/constants.js";

const ROLES = [
  { id: ROL.CAJA, label: "Cajero" },
  { id: ROL.ADMIN, label: "Administrador" },
];

const nombreRol = (id) => ROLES.find((r) => r.id === id)?.label || id || "—";

const FORM_VACIO = { nombre: "", correo: "", clave: "", rol: ROL.CAJA };

// Mensajes de Firebase en palabras
function explicar(e) {
  switch (e?.code) {
    case "auth/email-already-in-use":
      return "Ese correo ya tiene cuenta con otra clave. Usá otro correo o la clave que ya tenía.";
    case "auth/invalid-email":
      return "El correo no es válido.";
    case "auth/weak-password":
      return "La clave debe tener al menos 6 caracteres.";
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
      return "Firebase no permite crear cuentas. En Firebase → Authentication → Método de acceso, activá Correo/contraseña.";
    case "auth/network-request-failed":
      return "Sin conexión. Revisá el internet e intentá de nuevo.";
    default:
      return e?.message || "Error desconocido.";
  }
}

// El administrador crea las cuentas de cajeros y administradores con correo y clave,
// les cambia el rol y las desactiva.
export default function Usuarios({ staff }) {
  const [form, setForm] = useState(FORM_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  const usuariosQ = usePolling(() => consultar("staff"), [], 30000);
  const usuarios = [...(usuariosQ.datos || [])].sort((a, b) =>
    String(a.nombre || a.email || "").localeCompare(String(b.nombre || b.email || ""))
  );
  const adminsActivos = usuarios.filter((u) => u.rol === ROL.ADMIN && u.activo !== false);

  function avisar(ok, texto) {
    setMensaje(ok ? texto : "");
    setError(ok ? "" : texto);
  }

  async function agregar(e) {
    e.preventDefault();
    const nombre = form.nombre.trim();
    const correo = form.correo.trim().toLowerCase();
    if (!nombre) return avisar(false, "Poné el nombre.");
    if (!correo) return avisar(false, "Poné el correo.");
    if (form.clave.length < 6) return avisar(false, "La clave debe tener al menos 6 caracteres.");

    setGuardando(true);
    setMensaje("");
    setError("");
    try {
      const { uid, yaExistia } = await crearCuenta(correo, form.clave);
      const datos = { nombre, email: correo, rol: form.rol, activo: true, uid };
      const perfil = await leerDoc("staff", uid);
      if (perfil) {
        await confirmar([actualizar("staff", uid, datos)]);
      } else {
        await confirmar([crear("staff", uid, { ...datos, creadoEn: ahora() })]);
      }
      setForm(FORM_VACIO);
      avisar(
        true,
        `${nombre} ya puede entrar como ${nombreRol(form.rol).toLowerCase()} con ${correo}` +
          (yaExistia ? " (la cuenta ya existía y se volvió a activar)." : ".")
      );
      usuariosQ.recargar();
    } catch (err) {
      avisar(false, "No se pudo crear el usuario: " + explicar(err));
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarRol(u, rol) {
    if (u.id === staff.uid && rol !== ROL.ADMIN) {
      return avisar(false, "No podés quitarte a vos mismo el rol de administrador.");
    }
    try {
      await confirmar([actualizar("staff", u.id, { rol })]);
      avisar(true, `${u.nombre || u.email} ahora es ${nombreRol(rol).toLowerCase()}.`);
      usuariosQ.recargar();
    } catch (err) {
      avisar(false, "No se pudo cambiar el rol: " + explicar(err));
    }
  }

  async function cambiarActivo(u) {
    const activar = u.activo === false;
    if (!activar) {
      if (u.id === staff.uid) return avisar(false, "No podés desactivar tu propia cuenta.");
      if (u.rol === ROL.ADMIN && adminsActivos.length <= 1) {
        return avisar(false, "Tiene que quedar al menos un administrador activo.");
      }
      if (!confirm(`¿Desactivar a ${u.nombre || u.email}? Ya no va a poder entrar al sistema.`)) return;
    }
    try {
      await confirmar([actualizar("staff", u.id, { activo: activar })]);
      avisar(true, `${u.nombre || u.email} quedó ${activar ? "activo" : "desactivado"}.`);
      usuariosQ.recargar();
    } catch (err) {
      avisar(false, "No se pudo cambiar: " + explicar(err));
    }
  }

  async function enviarCambioClave(u) {
    if (!u.email) return avisar(false, "Ese usuario no tiene correo guardado.");
    try {
      await sendPasswordResetEmail(auth, u.email);
      avisar(true, `Se envió a ${u.email} un correo para poner una clave nueva. Que revise también el spam.`);
    } catch (err) {
      avisar(false, "No se pudo enviar el correo: " + explicar(err));
    }
  }

  return (
    <section className="stack">
      <div>
        <h2>Usuarios</h2>
        <p>Cuentas para entrar al sistema con correo y clave.</p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Agregar usuario</h3>
        <form onSubmit={agregar} className="stack">
          <div className="formulario">
            <input
              placeholder="Nombre"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            />
            <input
              type="email"
              autoCapitalize="none"
              autoComplete="off"
              placeholder="Correo"
              value={form.correo}
              onChange={(e) => setForm({ ...form, correo: e.target.value })}
            />
            <input
              type="text"
              autoCapitalize="none"
              autoComplete="new-password"
              placeholder="Clave (mínimo 6 caracteres)"
              value={form.clave}
              onChange={(e) => setForm({ ...form, clave: e.target.value })}
            />
            <select value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>
          <button className="btn primary bloque" disabled={guardando}>
            {guardando ? "Creando..." : "Crear usuario"}
          </button>
        </form>
        <p style={{ marginTop: 10 }}>
          <small>
            Cajero: vende y cierra su caja. Administrador: además maneja productos, inventario,
            reportes y usuarios. Anotá la clave y dásela a la persona.
          </small>
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {mensaje && <p className="ok">{mensaje}</p>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Usuarios ({usuarios.length})</h3>
        {usuariosQ.error && <p className="error">{usuariosQ.error}</p>}
        {usuariosQ.datos && usuarios.length === 0 && <p>Todavía no hay usuarios.</p>}
        {usuarios.map((u) => (
          <div key={u.id} className="item" style={{ cursor: "default", opacity: u.activo === false ? 0.6 : 1 }}>
            <div className="item-linea">
              <span>
                {u.nombre || "Sin nombre"}
                {u.id === staff.uid ? " (vos)" : ""}
              </span>
              <small>{u.activo === false ? "Desactivado" : nombreRol(u.rol)}</small>
            </div>
            <small>{u.email || "Sin correo guardado"}</small>
            <div className="formulario" style={{ marginTop: 8 }}>
              <select value={u.rol || ""} onChange={(e) => cambiarRol(u, e.target.value)}>
                {!ROLES.some((r) => r.id === u.rol) && <option value={u.rol || ""}>{u.rol || "Sin rol"}</option>}
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="acciones">
              <button className="btn" disabled={!u.email} onClick={() => enviarCambioClave(u)}>
                Cambiar clave
              </button>
              <button className={"btn" + (u.activo === false ? " primary" : " peligro")} onClick={() => cambiarActivo(u)}>
                {u.activo === false ? "Activar" : "Desactivar"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
