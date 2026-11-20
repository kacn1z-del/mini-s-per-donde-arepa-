// lib/firestore-servidor.js
//
// Acceso a Firestore desde las funciones de Vercel usando la sesión de quien
// llama (su token de Firebase). Las reglas de Firestore deciden qué puede
// hacer, igual que en la página: no hace falta una cuenta de servicio.

const proyecto = () => String(process.env.VITE_FIREBASE_PROJECT_ID || '').trim()
const raiz = () => `projects/${proyecto()}/databases/(default)/documents`
const base = () => `https://firestore.googleapis.com/v1/${raiz()}`

function aValor(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (typeof v === 'string') return { stringValue: v }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aValor) } }
  if (typeof v === 'object') return { mapValue: { fields: aCampos(v) } }
  return { stringValue: String(v) }
}

function aCampos(obj) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, aValor(v)])
  )
}

function deValor(v) {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return new Date(v.timestampValue)
  if ('stringValue' in v) return v.stringValue
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deValor)
  if ('mapValue' in v) return deCampos(v.mapValue.fields || {})
  return null
}

function deCampos(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, deValor(v)]))
}

// uid del token. La firma la comprueba Firestore en cada lectura: un token
// falso o vencido no puede leer nada.
function uidDelToken(token) {
  try {
    const carga = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return carga.user_id || carga.sub || null
  } catch {
    return null
  }
}

export function crearCliente(token) {
  async function pedir(url, { method = 'GET', body } = {}) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const texto = await res.text()
    const json = texto ? JSON.parse(texto) : {}
    if (!res.ok) {
      const error = new Error(json.error?.message || `Firestore respondió ${res.status}`)
      error.status = res.status
      throw error
    }
    return json
  }

  async function leer(ruta) {
    try {
      const doc = await pedir(`${base()}/${ruta}`)
      return { datos: deCampos(doc.fields), version: doc.updateTime }
    } catch (e) {
      if (e.status === 404) return { datos: null, version: null }
      throw e
    }
  }

  // Cambia solo los campos indicados. Con "version" falla si el documento
  // cambió desde que se leyó (para no pisar cambios de otra caja).
  async function actualizar(ruta, campos, { version, crearSiNoExiste = false } = {}) {
    const write = {
      update: { name: `${raiz()}/${ruta}`, fields: aCampos(campos) },
      updateMask: { fieldPaths: Object.keys(campos).map((k) => '`' + k.replace(/`/g, '\\`') + '`') },
    }
    if (version) write.currentDocument = { updateTime: version }
    else if (!crearSiNoExiste) write.currentDocument = { exists: true }
    else write.currentDocument = { exists: false }
    await pedir(`${base().replace(/\/documents$/, '')}/documents:commit`, { method: 'POST', body: { writes: [write] } })
  }

  return { leer, actualizar }
}

// Comprueba la sesión y que el usuario sea personal activo. Devuelve { uid, perfil, db }.
export async function autenticar(req) {
  const encabezado = req.headers.authorization || ''
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : ''
  const uid = token && uidDelToken(token)
  if (!uid) {
    const e = new Error('Falta la sesión. Volvé a entrar al sistema.')
    e.status = 401
    throw e
  }
  const db = crearCliente(token)
  let perfil
  try {
    perfil = (await db.leer(`staff/${uid}`)).datos
  } catch (err) {
    const e = new Error('La sesión no es válida o venció. Volvé a entrar.')
    e.status = 401
    throw e
  }
  if (!perfil || perfil.activo === false) {
    const e = new Error('Este usuario no tiene permiso.')
    e.status = 403
    throw e
  }
  return { uid, perfil, db }
}

// Toma el siguiente número de un contador sin repetirlo entre cajas.
export async function siguienteConsecutivo(db, clave) {
  for (let intento = 0; intento < 8; intento++) {
    const { datos, version } = await db.leer('facturacion/consecutivos')
    const siguiente = (Number(datos?.[clave]) || 0) + 1
    try {
      if (version) await db.actualizar('facturacion/consecutivos', { [clave]: siguiente }, { version })
      else await db.actualizar('facturacion/consecutivos', { [clave]: siguiente }, { crearSiNoExiste: true })
      return siguiente
    } catch (e) {
      // Otra caja tomó un número al mismo tiempo: se vuelve a leer
      if (e.status === 409 || e.status === 400 || /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 200))
        continue
      }
      throw e
    }
  }
  throw new Error('No se pudo reservar el consecutivo. Intentá de nuevo.')
}
