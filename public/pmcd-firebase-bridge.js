import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

export const ADMIN_BOOTSTRAP_EMAIL = 'ricardosoares2607@gmail.com';
export const EQUIPE_PADRAO_ID = 'pmcd_principal';

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
};

let _app = null;
let _auth = null;
let _db = null;
let _config = null;
let _currentUser = null;
let _authResolved = false;
let _accessInfo = { autorizado: false, role: 'none', motivo: 'nao_autenticado', email: '', uid: '' };
const _authListeners = new Set();
const _accessInFlight = new Map();

function buildAuthInfo(user) {
  return {
    userId: user?.uid || null,
    email: user?.email || null,
    emailVerified: user?.emailVerified ?? null,
    isAnonymous: user?.isAnonymous ?? null,
    tenantId: user?.tenantId || null,
    providerInfo: (user?.providerData || []).map((provider) => ({
      providerId: provider.providerId || null,
      email: provider.email || null
    }))
  };
}

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: buildAuthInfo(_auth?.currentUser || _currentUser),
    operationType,
    path: path ?? null
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function isPermissionError(err) {
  const msg = String((err && (err.code || err.message)) || err || '').toLowerCase();
  return msg.includes('permission') || msg.includes('missing or insufficient') || msg.includes('unauthorized');
}

export function formatarErroGoogleAuth(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (code === 'auth/unauthorized-domain') {
    return {
      code,
      mensagem: `Domínio "${host || 'atual'}" não autorizado no Firebase Auth. Como o app está publicado fora do AI Studio (ex.: GitHub Pages), abra o Console do Firebase (${_config?.projectId || 'youthful-progress-qds98'}) → Authentication → Settings → Authorized domains e adicione "${host}".`
    };
  }
  if (code === 'auth/popup-blocked') {
    return {
      code,
      mensagem: 'O navegador bloqueou a janela de login do Google. Libere pop-ups para este site ou tente novamente para usar o redirecionamento.'
    };
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return {
      code,
      mensagem: 'A janela de login com Google foi fechada antes de concluir.'
    };
  }
  if (code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/web-storage-unsupported') {
    return {
      code,
      mensagem: 'Este navegador/atalho está bloqueando o login por pop-up ou cookies/armazenamento. Tente abrir o link diretamente no Google Chrome ou Safari.'
    };
  }
  if (code === 'auth/network-request-failed') {
    return {
      code,
      mensagem: 'Falha de rede ao conectar com o Google. Verifique a internet deste aparelho e tente novamente.'
    };
  }
  return {
    code: code || 'auth/unknown',
    mensagem: msg || 'Não foi possível concluir o login com Google neste aparelho.'
  };
}

export function sanitizeEmailId(email) {
  return String(email || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

export function sanitizeForFirestore(value, depth = 0) {
  if (depth > 30) return null;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'function') return undefined;
  if (typeof HTMLElement !== 'undefined' && (value instanceof HTMLElement || value instanceof Node)) {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const outArr = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (Array.isArray(item)) {
        outArr.push({ _items: sanitizeForFirestore(item, depth + 1) || [] });
      } else {
        const sanitized = sanitizeForFirestore(item, depth + 1);
        outArr.push(sanitized === undefined ? null : sanitized);
      }
    }
    return outArr;
  }
  if (typeof value === 'object') {
    const outObj = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = String(keys[i]);
      if (!k || k.startsWith('__')) continue;
      const v = sanitizeForFirestore(value[k], depth + 1);
      if (v !== undefined) {
        outObj[k] = v;
      }
    }
    return outObj;
  }
  return undefined;
}

async function testConnection() {
  try {
    await getDocFromServer(doc(_db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

async function ensureUserPrivateProfile(user, role) {
  const profilePath = `users/${user.uid}/private/profile`;
  const ref = doc(_db, 'users', user.uid, 'private', 'profile');
  try {
    const snap = await getDoc(ref);
    const displayName = String(user.displayName || user.email || 'Agente').slice(0, 120);
    const email = String(user.email || '').toLowerCase().slice(0, 200);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email,
        displayName,
        role: role === 'admin' ? 'admin' : 'editor',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else if (snap.data()?.displayName !== displayName) {
      await updateDoc(ref, {
        displayName,
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, profilePath);
  }
}

async function ensureWorkspaceAndAccess(user) {
  const key = user?.uid || 'anon';
  if (_accessInFlight.has(key)) {
    return _accessInFlight.get(key);
  }
  const promise = _runEnsureWorkspaceAndAccess(user).finally(() => {
    _accessInFlight.delete(key);
  });
  _accessInFlight.set(key, promise);
  return promise;
}

async function _runEnsureWorkspaceAndAccess(user) {
  if (!user || !user.emailVerified) {
    return {
      autorizado: false,
      role: 'none',
      motivo: user ? 'email_nao_verificado' : 'nao_autenticado',
      email: user?.email || '',
      uid: user?.uid || ''
    };
  }

  const email = String(user.email || '').trim().toLowerCase();
  const displayName = String(user.displayName || email.split('@')[0] || 'Usuário').slice(0, 120);
  const isBootstrapAdmin = email === ADMIN_BOOTSTRAP_EMAIL;

  let adminExists = false;
  if (!isBootstrapAdmin) {
    const adminPath = `admins/${user.uid}`;
    try {
      const admSnap = await getDoc(doc(_db, 'admins', user.uid));
      adminExists = admSnap.exists();
    } catch (err) {
      if (!isPermissionError(err)) {
        handleFirestoreError(err, OperationType.GET, adminPath);
      }
    }
  }

  const isUserAdmin = isBootstrapAdmin || adminExists;
  const equipeRef = doc(_db, 'equipes', EQUIPE_PADRAO_ID);
  const equipePath = `equipes/${EQUIPE_PADRAO_ID}`;
  const membroRef = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'membros', user.uid);
  const membroPath = `equipes/${EQUIPE_PADRAO_ID}/membros/${user.uid}`;

  if (isUserAdmin) {
    try {
      await ensureUserPrivateProfile(user, 'admin');
    } catch (e) {
      console.warn('[PMCD Firestore] Aviso ao gravar perfil privado:', e);
    }

    try {
      const eqSnap = await getDoc(equipeRef);
      if (!eqSnap.exists()) {
        await setDoc(equipeRef, {
          nome: 'Equipe PMCD Principal',
          ownerId: user.uid,
          ownerEmail: email.slice(0, 200),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, equipePath);
    }

    try {
      const memSnap = await getDoc(membroRef);
      if (!memSnap.exists()) {
        await setDoc(membroRef, {
          uid: user.uid,
          equipeId: EQUIPE_PADRAO_ID,
          email: email.slice(0, 200),
          nome: displayName,
          role: 'admin',
          ativo: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, membroPath);
    }

    return { autorizado: true, role: 'admin', motivo: 'ok', email, uid: user.uid, nome: displayName };
  }

  // Usuário não-admin: verifica se já é membro ativo ou possui convite ativo por e-mail
  let memSnap = null;
  try {
    memSnap = await getDoc(membroRef);
  } catch (err) {
    if (!isPermissionError(err)) {
      handleFirestoreError(err, OperationType.GET, membroPath);
    }
  }

  if (memSnap && memSnap.exists()) {
    const md = memSnap.data();
    if (md?.ativo === true) {
      try {
        await ensureUserPrivateProfile(user, md.role === 'admin' ? 'admin' : 'editor');
      } catch (e) {}
      return {
        autorizado: true,
        role: md.role === 'admin' ? 'admin' : 'editor',
        motivo: 'ok',
        email,
        uid: user.uid,
        nome: md.nome || displayName
      };
    }
    return { autorizado: false, role: 'none', motivo: 'acesso_desativado', email, uid: user.uid, nome: displayName };
  }

  const conviteId = sanitizeEmailId(email);
  const convitePath = `equipes/${EQUIPE_PADRAO_ID}/convites/${conviteId}`;
  let convSnap = null;
  try {
    convSnap = await getDoc(doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'convites', conviteId));
  } catch (err) {
    if (!isPermissionError(err)) {
      handleFirestoreError(err, OperationType.GET, convitePath);
    }
  }

  if (convSnap && convSnap.exists() && convSnap.data()?.ativo === true) {
    const conv = convSnap.data();
    const roleConvidado = conv.role === 'admin' ? 'admin' : 'editor';
    try {
      await ensureUserPrivateProfile(user, 'editor');
    } catch (e) {}
    try {
      await setDoc(membroRef, {
        uid: user.uid,
        equipeId: EQUIPE_PADRAO_ID,
        email: email.slice(0, 200),
        nome: String(conv.nome || displayName).slice(0, 120),
        role: roleConvidado,
        ativo: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, membroPath);
    }
    return {
      autorizado: true,
      role: roleConvidado,
      motivo: 'ok',
      email,
      uid: user.uid,
      nome: conv.nome || displayName
    };
  }

  return { autorizado: false, role: 'none', motivo: 'sem_permissao_equipe', email, uid: user.uid, nome: displayName };
}

function notifyAuthListeners() {
  const payload = getStateSnapshot();
  _authListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error('[PMCD AuthListener]', e);
    }
  });
}

function getStateSnapshot() {
  return {
    ready: true,
    authResolved: _authResolved,
    user: _currentUser,
    access: { ..._accessInfo }
  };
}

async function init() {
  if (_db && _auth) return buildApi();

  const configUrls = ['./firebase-applet-config.json', '../firebase-applet-config.json'];
  let loadedConfig = null;
  let lastStatus = 0;
  for (const url of configUrls) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      lastStatus = resp.status;
      if (resp.ok) {
        loadedConfig = await resp.json();
        break;
      }
    } catch (e) {}
  }
  if (!loadedConfig) {
    throw new Error(`Falha ao carregar firebase-applet-config.json (HTTP ${lastStatus || 'erro'})`);
  }
  _config = loadedConfig;
  _app = initializeApp(_config);
  _db = getFirestore(_app, _config.firestoreDatabaseId);
  _auth = getAuth(_app);

  // Processa retorno caso este aparelho tenha usado fallback por redirect
  getRedirectResult(_auth).catch((err) => {
    console.warn('[PMCD Redirect Auth]', err);
  });

  testConnection();

  await new Promise((resolve) => {
    let first = true;
    onAuthStateChanged(_auth, async (user) => {
      _currentUser = user || null;
      if (user) {
        try {
          _accessInfo = await ensureWorkspaceAndAccess(user);
        } catch (e) {
          console.error('[PMCD] Erro ao validar acesso na nuvem:', e);
          _accessInfo = {
            autorizado: false,
            role: 'none',
            motivo: isPermissionError(e) ? 'permission_denied' : 'erro_validacao',
            email: user.email || '',
            uid: user.uid || ''
          };
        }
      } else {
        _accessInfo = { autorizado: false, role: 'none', motivo: 'nao_autenticado', email: '', uid: '' };
      }
      _authResolved = true;
      notifyAuthListeners();
      if (first) {
        first = false;
        resolve();
      }
    });
  });

  return buildApi();
}

function buildApi() {
  const readyPromise = Promise.resolve(true);

  return {
    ready: () => readyPromise,
    getState: () => getStateSnapshot(),
    onAuthChange: (cb) => {
      if (typeof cb !== 'function') return () => {};
      _authListeners.add(cb);
      if (_authResolved) {
        try { cb(getStateSnapshot()); } catch (e) {}
      }
      return () => _authListeners.delete(cb);
    },
    formatarErroAuth: (err) => formatarErroGoogleAuth(err),
    signInWithGoogle: async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        const cred = await signInWithPopup(_auth, provider);
        _currentUser = cred.user;
        _accessInfo = await ensureWorkspaceAndAccess(cred.user);
        _authResolved = true;
        notifyAuthListeners();
        return getStateSnapshot();
      } catch (err) {
        const code = String(err?.code || '');
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          try {
            await signInWithRedirect(_auth, provider);
            return { ...getStateSnapshot(), redirecting: true };
          } catch (redirErr) {
            throw redirErr;
          }
        }
        throw err;
      }
    },
    switchGoogleAccount: async () => {
      try {
        if (_auth?.currentUser) {
          await signOut(_auth);
        }
      } catch (e) {}
      _currentUser = null;
      _accessInfo = { autorizado: false, role: 'none', motivo: 'nao_autenticado', email: '', uid: '' };
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        const cred = await signInWithPopup(_auth, provider);
        _currentUser = cred.user;
        _accessInfo = await ensureWorkspaceAndAccess(cred.user);
        _authResolved = true;
        notifyAuthListeners();
        return getStateSnapshot();
      } catch (err) {
        const code = String(err?.code || '');
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(_auth, provider);
          return { ...getStateSnapshot(), redirecting: true };
        }
        throw err;
      }
    },
    signOutGoogle: async () => {
      await signOut(_auth);
      _currentUser = null;
      _accessInfo = { autorizado: false, role: 'none', motivo: 'nao_autenticado', email: '', uid: '' };
      notifyAuthListeners();
    },
    observeModulo: (moduloId, onData, onError) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/modulos/${moduloId}`;
      if (!_currentUser || !_accessInfo.autorizado) {
        return () => {};
      }
      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'modulos', moduloId);
      return onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) {
            onData(null, snap);
            return;
          }
          const d = snap.data() || {};
          onData(d, snap);
        },
        (error) => {
          try {
            handleFirestoreError(error, OperationType.GET, path);
          } catch (wrapped) {
            if (typeof onError === 'function') onError(wrapped, error);
          }
        }
      );
    },
    getModuloOnce: async (moduloId) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/modulos/${moduloId}`;
      if (!_currentUser || !_accessInfo.autorizado) return null;
      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'modulos', moduloId);
      try {
        const snap = await getDoc(ref);
        return snap.exists() ? snap.data() : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, path);
      }
    },
    saveModulo: async (moduloId, payloadBruto, atualizadoEmMs = Date.now()) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/modulos/${moduloId}`;
      if (!_currentUser || !_accessInfo.autorizado) {
        throw new Error('Usuário Google não autenticado ou sem acesso à equipe.');
      }
      const payloadLimpo = sanitizeForFirestore(payloadBruto) || {};
      const approxBytes = new Blob([JSON.stringify(payloadLimpo)]).size;
      if (approxBytes > 950000) {
        throw new Error(`Tamanho dos dados (${Math.round(approxBytes / 1024)} KB) excede o limite de 950 KB por documento.`);
      }

      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'modulos', moduloId);
      const emailAtual = String(_currentUser.email || '').toLowerCase().slice(0, 200);
      const tsMs = Number(atualizadoEmMs) || Date.now();

      try {
        return await runTransaction(_db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            tx.set(ref, {
              equipeId: EQUIPE_PADRAO_ID,
              moduloId,
              payload: payloadLimpo,
              versao: 1,
              atualizadoEmMs: tsMs,
              atualizadoPorUid: _currentUser.uid,
              atualizadoPorEmail: emailAtual,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            return { versao: 1, atualizadoEmMs: tsMs };
          } else {
            const prevVersao = Number(snap.data()?.versao) || 1;
            const novaVersao = prevVersao + 1;
            tx.update(ref, {
              payload: payloadLimpo,
              versao: novaVersao,
              atualizadoEmMs: tsMs,
              atualizadoPorUid: _currentUser.uid,
              atualizadoPorEmail: emailAtual,
              updatedAt: serverTimestamp()
            });
            return { versao: novaVersao, atualizadoEmMs: tsMs };
          }
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    },
    listarConvitesGoogle: async () => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/convites`;
      if (!_currentUser || _accessInfo.role !== 'admin') return [];
      try {
        const snap = await getDocs(collection(_db, 'equipes', EQUIPE_PADRAO_ID, 'convites'));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    },
    salvarConviteGoogle: async ({ email, nome, role = 'editor', ativo = true }) => {
      const emailNorm = String(email || '').trim().toLowerCase().slice(0, 200);
      if (!emailNorm || !emailNorm.includes('@')) {
        throw new Error('Informe um endereço de e-mail Google válido.');
      }
      const conviteId = sanitizeEmailId(emailNorm);
      const path = `equipes/${EQUIPE_PADRAO_ID}/convites/${conviteId}`;
      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'convites', conviteId);
      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            equipeId: EQUIPE_PADRAO_ID,
            email: emailNorm,
            nome: String(nome || emailNorm.split('@')[0]).trim().slice(0, 120),
            role: role === 'admin' ? 'admin' : 'editor',
            ativo: ativo !== false,
            createdBy: _currentUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        } else {
          await updateDoc(ref, {
            email: emailNorm,
            nome: String(nome || snap.data()?.nome || emailNorm.split('@')[0]).trim().slice(0, 120),
            role: role === 'admin' ? 'admin' : 'editor',
            ativo: ativo !== false,
            updatedAt: serverTimestamp()
          });
        }
        return conviteId;
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    },
    removerConviteGoogle: async (conviteId) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/convites/${conviteId}`;
      try {
        await deleteDoc(doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'convites', conviteId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, path);
      }
    }
  };
}

const initPromise = init().then((api) => {
  window.PmcdFirebase = api;
  window.dispatchEvent(new CustomEvent('pmcd-firebase-ready', { detail: api }));
  return api;
}).catch((err) => {
  console.error('[PMCD Firebase Init Erro]', err);
  window.PmcdFirebaseInitError = err;
  throw err;
});

window.__pmcdBridgeInitPromise = initPromise;
window.PmcdFirebaseReady = initPromise;
window.obterPmcdFirebase = () => initPromise;
if (typeof window.__resolvePmcdFirebaseReady === 'function') {
  initPromise.then(window.__resolvePmcdFirebaseReady).catch((err) => {
    if (typeof window.__rejectPmcdFirebaseReady === 'function') window.__rejectPmcdFirebaseReady(err);
  });
}
