import { auth } from "../firebase.js";

// Tipos de identificación de Hacienda para el cliente de una factura
export const TIPOS_CEDULA = [
  { id: "01", label: "Física", digitos: [9] },
  { id: "02", label: "Jurídica", digitos: [10] },
  { id: "03", label: "DIMEX", digitos: [11, 12] },
  { id: "04", label: "NITE", digitos: [10] },
];

export const ESTADOS_FACTURA = {
  emitiendo: "Enviando a Hacienda",
  enviado: "Enviado, esperando respuesta",
  aceptado: "Aceptado por Hacienda",
  rechazado: "Rechazado por Hacienda",
  error: "No se pudo enviar",
  faltan_datos: "Faltan datos",
};

// Revisa la cédula según el tipo; devuelve el error o ""
export function errorCedula(tipo, numero) {
  const limpio = String(numero || "").replace(/\D/g, "");
  const regla = TIPOS_CEDULA.find((t) => t.id === tipo);
  if (!regla) return "Escogé el tipo de identificación.";
  if (!regla.digitos.includes(limpio.length)) {
    return `La identificación ${regla.label.toLowerCase()} lleva ${regla.digitos.join(" u ")} dígitos, sin guiones.`;
  }
  return "";
}

// Llama a las funciones de facturación de Vercel con la sesión del usuario
async function llamar(ruta, cuerpo) {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error("No hay sesión activa");
  const token = await usuario.getIdToken();
  const res = await fetch(ruta, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  let datos = {};
  try {
    datos = await res.json();
  } catch {
    datos = { error: `El servidor respondió ${res.status}` };
  }
  if (!res.ok && !datos.estado) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

export const emitirComprobante = (pedidoId) => llamar("/api/facturar", { pedidoId });

export const consultarComprobante = (pedidoId, reenviarCorreo = false) =>
  llamar("/api/estado-factura", { pedidoId, reenviarCorreo });

export const probarFacturacion = () => llamar("/api/probar-facturacion", {});
