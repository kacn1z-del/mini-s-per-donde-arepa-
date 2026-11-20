import { getApps, initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

// trim(): un espacio pegado al final de una variable en Vercel rompe la conexión
const limpio = (valor) => String(valor || "").trim();

const firebaseConfig = {
  apiKey: limpio(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: limpio(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: limpio(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: limpio(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: limpio(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: limpio(import.meta.env.VITE_FIREBASE_APP_ID),
};

const app = initializeApp(firebaseConfig);

// Solo Auth usa el SDK. Los datos se leen y escriben por la API HTTP de Firestore
// (ver src/lib/api.js), porque el canal del SDK no conecta desde este dispositivo.
export const auth = getAuth(app);

// Segunda conexión, solo para crear cuentas. Crear una cuenta inicia sesión con ella;
// al hacerlo aquí, el administrador no pierde su propia sesión.
function authAltas() {
  const existente = getApps().find((a) => a.name === "altas");
  return getAuth(existente || initializeApp(firebaseConfig, "altas"));
}

// Crea la cuenta de correo y clave y devuelve su uid.
// Si el correo ya tiene cuenta y la clave coincide, devuelve el uid de esa cuenta
// (sirve para volver a darle acceso a alguien que ya existía).
export async function crearCuenta(correo, clave) {
  const authSecundaria = authAltas();
  await setPersistence(authSecundaria, inMemoryPersistence);
  try {
    const cred = await createUserWithEmailAndPassword(authSecundaria, correo, clave);
    return { uid: cred.user.uid, yaExistia: false };
  } catch (e) {
    if (e.code !== "auth/email-already-in-use") throw e;
    try {
      const cred = await signInWithEmailAndPassword(authSecundaria, correo, clave);
      return { uid: cred.user.uid, yaExistia: true };
    } catch {
      throw e;
    }
  } finally {
    await signOut(authSecundaria).catch(() => {});
  }
}
