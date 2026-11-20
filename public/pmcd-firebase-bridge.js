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
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
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
export const SYNC_PROTOCOL_VERSION = 2;
const CLOCK_OFFSET_STORAGE_KEY = 'pmcd_clock_offset_ms_v2';

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
const _moduloVersoes = new Map();
const _docV2Versoes = new Map();
const _profileEnsuredUids = new Set();
let _quotaBloqueadaAte = 0;
let _serverClockOffsetMs = 0;

try {
  const savedOffset = Number(localStorage.getItem(CLOCK_OFFSET_STORAGE_KEY));
  if (Number.isFinite(savedOffset) && Math.abs(savedOffset) < 7 * 24 * 60 * 60 * 1000) {
    _serverClockOffsetMs = Math.round(savedOffset);
  }
} catch (e) {}

function updateServerClockOffsetFromCommit(clientMidMs, serverTsValue) {
  try {
    if (!serverTsValue || typeof serverTsValue.toMillis !== 'function') return;
    const srvMs = serverTsValue.toMillis();
    if (!Number.isFinite(srvMs) || !Number.isFinite(clientMidMs)) return;
    const sample = Math.round(srvMs - clientMidMs);
    if (Math.abs(sample) > 7 * 24 * 60 * 60 * 1000) return;
    _serverClockOffsetMs = _serverClockOffsetMs === 0 ? sample : Math.round(_serverClockOffsetMs * 0.4 + sample * 0.6);
    try {
      localStorage.setItem(CLOCK_OFFSET_STORAGE_KEY, String(_serverClockOffsetMs));
    } catch (e) {}
  } catch (e) {}
}

export function getServerNowMs() {
  return Math.round(Date.now() + _serverClockOffsetMs);
}

function recordRemoteDocClockSample(docData, fromCache, readMidMs = null) {
  try {
    if (!docData || typeof docData !== 'object') return;
    if (!fromCache && docData.updatedAt && typeof docData.updatedAt.toMillis === 'function') {
      const refMs = Number(readMidMs) || Date.now();
      updateServerClockOffsetFromCommit(refMs, docData.updatedAt);
    }
    const maxDocTs = Math.max(
      Number(docData.atualizadoEmMs) || 0,
      Number(docData.payload?._ts) || 0,
      Number(docData.payload?.timestamp) || 0
    );
    if (maxDocTs > 0 && typeof window !== 'undefined' && window.PmcdSyncEngine?.observeRemoteTs) {
      window.PmcdSyncEngine.observeRemoteTs(maxDocTs);
    }
  } catch (e) {}
}

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

export function isQuotaError(err) {
  const msg = String((err && (err.code || err.message)) || err || '').toLowerCase();
  return msg.includes('quota') || msg.includes('resource-exhausted') || msg.includes('free daily read units');
}

export function registerQuotaErrorIfAny(err) {
  if (isQuotaError(err)) {
    _quotaBloqueadaAte = Date.now() + 10 * 60 * 1000;
    return true;
  }
  return false;
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
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
    return;
  }
  try {
    await getDocFromServer(doc(_db, 'test', 'connection'));
  } catch (error) {
    registerQuotaErrorIfAny(error);
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

async function ensureUserPrivateProfile(user, role) {
  if (_profileEnsuredUids.has(user.uid)) return;
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
    _profileEnsuredUids.add(user.uid);
  } catch (err) {
    if (!registerQuotaErrorIfAny(err)) {
      handleFirestoreError(err, OperationType.WRITE, profilePath);
    }
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
  const cacheKey = `pmcd_ws_bootstrapped_v1_${user.uid}`;

  if (isBootstrapAdmin) {
    let jaValidado = false;
    try { jaValidado = localStorage.getItem(cacheKey) === '1'; } catch (e) {}
    if (jaValidado) {
      return { autorizado: true, role: 'admin', motivo: 'ok', email, uid: user.uid, nome: displayName };
    }
  }

  let adminExists = false;
  if (!isBootstrapAdmin) {
    const adminPath = `admins/${user.uid}`;
    try {
      const admSnap = await getDoc(doc(_db, 'admins', user.uid));
      adminExists = admSnap.exists();
    } catch (err) {
      if (registerQuotaErrorIfAny(err)) {
        return { autorizado: true, role: 'editor', motivo: 'quota_cache', email, uid: user.uid, nome: displayName };
      }
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
      if (!registerQuotaErrorIfAny(err)) {
        handleFirestoreError(err, OperationType.WRITE, equipePath);
      }
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
      try { localStorage.setItem(cacheKey, '1'); } catch (e) {}
    } catch (err) {
      if (!registerQuotaErrorIfAny(err)) {
        handleFirestoreError(err, OperationType.WRITE, membroPath);
      }
    }

    return { autorizado: true, role: 'admin', motivo: 'ok', email, uid: user.uid, nome: displayName };
  }

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

function getDocIdFieldForSubcol(subcol) {
  if (subcol === 'dominios') return 'dominioId';
  if (subcol === 'semanas') return 'semanaId';
  if (subcol === 'andamentos') return 'andamentoId';
  if (subcol === 'meta') return 'metaId';
  return 'moduloId';
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
  try {
    _db = initializeFirestore(
      _app,
      { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
      _config.firestoreDatabaseId
    );
  } catch (cacheErr) {
    console.warn('[PMCD Firestore] Fallback para cache em memória:', cacheErr);
    _db = getFirestore(_app, _config.firestoreDatabaseId);
  }
  _auth = getAuth(_app);

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

  const observeDocGeneric = (subcol, docId, onData, onError) => {
    const cacheKey = `${subcol}/${docId}`;
    const path = `equipes/${EQUIPE_PADRAO_ID}/${cacheKey}`;
    if (!_currentUser || !_accessInfo.autorizado) {
      return () => {};
    }
    const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, subcol, docId);
    let serverConfirmado = false;
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.metadata?.fromCache) {
          serverConfirmado = true;
        }
        if (!snap.exists()) {
          if (snap.metadata?.fromCache && !serverConfirmado) {
            if (Date.now() < _quotaBloqueadaAte) {
              if (typeof onError === 'function') {
                onError(new Error('Quota exceeded: cota diária de leitura atingida temporariamente.'));
              }
              return;
            }
            getDocFromServer(ref)
              .then((srvSnap) => {
                serverConfirmado = true;
                if (srvSnap.exists()) {
                  const sd = srvSnap.data() || {};
                  if (Number(sd.versao) > 0) {
                    if (subcol === 'modulos') _moduloVersoes.set(docId, Number(sd.versao));
                    else _docV2Versoes.set(cacheKey, Number(sd.versao));
                  }
                  onData(sd, srvSnap);
                } else {
                  if (subcol === 'modulos') _moduloVersoes.delete(docId);
                  else _docV2Versoes.delete(cacheKey);
                  onData(null, srvSnap);
                }
              })
              .catch((err) => {
                registerQuotaErrorIfAny(err);
                if ((isQuotaError(err) || isPermissionError(err)) && typeof onError === 'function') {
                  onError(err);
                }
              });
            return;
          }
          if (!snap.metadata?.fromCache) {
            if (subcol === 'modulos') _moduloVersoes.delete(docId);
            else _docV2Versoes.delete(cacheKey);
          }
          onData(null, snap);
          return;
        }
        const d = snap.data() || {};
        recordRemoteDocClockSample(d, Boolean(snap.metadata?.fromCache), Date.now());
        if (Number(d.versao) > 0) {
          if (subcol === 'modulos') _moduloVersoes.set(docId, Number(d.versao));
          else _docV2Versoes.set(cacheKey, Number(d.versao));
        }
        onData(d, snap);
      },
      (error) => {
        registerQuotaErrorIfAny(error);
        try {
          handleFirestoreError(error, OperationType.GET, path);
        } catch (wrapped) {
          if (typeof onError === 'function') onError(wrapped, error);
        }
      }
    );
    return unsub;
  };

  const getDocGeneric = async (subcol, docId, preferServer = false, manual = false) => {
    const cacheKey = `${subcol}/${docId}`;
    const path = `equipes/${EQUIPE_PADRAO_ID}/${cacheKey}`;
    if (!_currentUser || !_accessInfo.autorizado) return null;
    if (preferServer && !manual && Date.now() < _quotaBloqueadaAte) {
      throw new Error('Quota exceeded: cota diária de leitura atingida temporariamente.');
    }
    const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, subcol, docId);
    try {
      const readStartMs = Date.now();
      let snap = null;
      if (preferServer && Date.now() >= _quotaBloqueadaAte) {
        snap = await getDocFromServer(ref);
        _quotaBloqueadaAte = 0;
      } else {
        snap = await getDoc(ref);
        if (!snap.exists() && Date.now() >= _quotaBloqueadaAte) {
          try {
            snap = await getDocFromServer(ref);
            _quotaBloqueadaAte = 0;
          } catch (srvErr) {
            registerQuotaErrorIfAny(srvErr);
          }
        }
      }
      if (snap && snap.exists()) {
        const d = snap.data() || {};
        recordRemoteDocClockSample(d, Boolean(snap.metadata?.fromCache), Math.round((readStartMs + Date.now()) / 2));
        if (Number(d.versao) > 0) {
          if (subcol === 'modulos') _moduloVersoes.set(docId, Number(d.versao));
          else _docV2Versoes.set(cacheKey, Number(d.versao));
        }
        return d;
      }
      if (snap && !snap.metadata?.fromCache) {
        if (subcol === 'modulos') _moduloVersoes.delete(docId);
        else _docV2Versoes.delete(cacheKey);
      }
      return null;
    } catch (error) {
      registerQuotaErrorIfAny(error);
      if (preferServer) {
        try {
          const cached = await getDoc(ref);
          if (cached.exists()) return cached.data();
        } catch (e) {}
      }
      handleFirestoreError(error, OperationType.GET, path);
    }
  };

  // Gravação transacional com OCC estrito e reconciliação automática dentro da transação
  const commitDocV2 = async (subcol, docId, buildPayloadFn, options = {}) => {
    const cacheKey = `${subcol}/${docId}`;
    const path = `equipes/${EQUIPE_PADRAO_ID}/${cacheKey}`;
    if (!_currentUser || !_accessInfo.autorizado) {
      throw new Error('Usuário Google não autenticado ou sem acesso à equipe.');
    }
    const manual = Boolean(options.manual);
    if (!manual && Date.now() < _quotaBloqueadaAte) {
      throw new Error('Quota exceeded: envio pausado temporariamente após atingir a cota diária do Firestore.');
    }

    const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, subcol, docId);
    const idField = getDocIdFieldForSubcol(subcol);
    const emailAtual = String(_currentUser.email || '').toLowerCase().slice(0, 200);
    const baselineEpoch = Math.max(0, Math.trunc(Number(options.baselineEpoch) || 1));

    const tStart = Date.now();
    let result = null;
    try {
      result = await runTransaction(_db, async (tx) => {
        const snap = await tx.get(ref);
        const remoteDoc = snap.exists() ? (snap.data() || null) : null;
        const remoteVersao = remoteDoc ? (Number(remoteDoc.versao) || 1) : 0;

        const decision = typeof buildPayloadFn === 'function'
          ? buildPayloadFn(remoteDoc, remoteVersao)
          : { payload: buildPayloadFn };

        if (!decision || decision.skip) {
          return {
            skipped: true,
            reason: decision?.reason || 'noop',
            versao: remoteVersao,
            remoteDoc
          };
        }

        const payloadLimpo = sanitizeForFirestore(decision.payload) || {};
        const approxBytes = new Blob([JSON.stringify(payloadLimpo)]).size;
        if (approxBytes > 950000) {
          throw new Error(`Tamanho dos dados (${Math.round(approxBytes / 1024)} KB) excede o limite de 950 KB por documento.`);
        }

        const tsMs = Number(decision.atualizadoEmMs) || getServerNowMs();

        if (!snap.exists()) {
          const novoDoc = {
            equipeId: EQUIPE_PADRAO_ID,
            [idField]: docId,
            payload: payloadLimpo,
            versao: 1,
            syncProtocolVersion: SYNC_PROTOCOL_VERSION,
            baselineEpoch,
            atualizadoEmMs: tsMs,
            atualizadoPorUid: _currentUser.uid,
            atualizadoPorEmail: emailAtual,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          tx.set(ref, novoDoc);
          return { skipped: false, versao: 1, atualizadoEmMs: tsMs, payload: payloadLimpo };
        } else {
          const novaVersao = remoteVersao + 1;
          tx.update(ref, {
            payload: payloadLimpo,
            versao: novaVersao,
            syncProtocolVersion: SYNC_PROTOCOL_VERSION,
            baselineEpoch,
            atualizadoEmMs: tsMs,
            atualizadoPorUid: _currentUser.uid,
            atualizadoPorEmail: emailAtual,
            updatedAt: serverTimestamp()
          });
          return { skipped: false, versao: novaVersao, atualizadoEmMs: tsMs, payload: payloadLimpo };
        }
      });

      const tEnd = Date.now();
      _quotaBloqueadaAte = 0;

      if (result && !result.skipped) {
        if (result.versao) _docV2Versoes.set(cacheKey, Number(result.versao));
        // Amostra o carimbo do servidor sem fazer leitura extra online (usa cache local pós-commit)
        getDoc(ref).then((postSnap) => {
          if (postSnap.exists() && !postSnap.metadata?.hasPendingWrites) {
            updateServerClockOffsetFromCommit(Math.round((tStart + tEnd) / 2), postSnap.data()?.updatedAt);
          }
        }).catch(() => {});
      } else if (result?.remoteDoc?.updatedAt) {
        updateServerClockOffsetFromCommit(Math.round((tStart + tEnd) / 2), result.remoteDoc.updatedAt);
      }

      return result;
    } catch (error) {
      registerQuotaErrorIfAny(error);
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  };

  return {
    ready: () => readyPromise,
    getState: () => getStateSnapshot(),
    getSyncProtocolVersion: () => SYNC_PROTOCOL_VERSION,
    getServerNowMs: () => getServerNowMs(),
    getClockOffsetMs: () => _serverClockOffsetMs,
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
          await signInWithRedirect(_auth, provider);
          return { ...getStateSnapshot(), redirecting: true };
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
    isQuotaPaused: () => Date.now() < _quotaBloqueadaAte,
    isQuotaError: (err) => isQuotaError(err),
    getQuotaUpgradeUrl: () => {
      const pid = _config?.projectId || 'youthful-progress-qds98';
      const dbid = _config?.firestoreDatabaseId || 'ai-studio-pmcdsistemaacela-40647833-ee8c-4a9c-8e9e-b08c8d3db22c';
      return `https://console.firebase.google.com/project/${pid}/firestore/databases/${dbid}/data?openUpgradeDialog=true`;
    },

    // ============ API GRANULAR v2 (OCC + Clock Skew + Época) ============
    observeDocV2: observeDocGeneric,
    getDocV2: getDocGeneric,
    commitDocV2,
    getSyncConfig: (preferServer = false, manual = false) =>
      getDocGeneric('meta', 'sync_config', preferServer, manual),
    observeSyncConfig: (onData, onError) =>
      observeDocGeneric('meta', 'sync_config', onData, onError),
    getMigrationMeta: () => getDocGeneric('meta', 'migracao_v2', false, false),
    publishBaselineEpoch: async ({ checksum = '', minClientVersion = SYNC_PROTOCOL_VERSION, nextEpoch = null } = {}) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/meta/sync_config`;
      if (!_currentUser || _accessInfo.role !== 'admin') {
        throw new Error('Somente o administrador da equipe pode publicar uma Base Oficial.');
      }
      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'meta', 'sync_config');
      const emailAtual = String(_currentUser.email || '').toLowerCase().slice(0, 200);
      const tsMs = getServerNowMs();
      try {
        const res = await runTransaction(_db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            const ep = nextEpoch && Number(nextEpoch) >= 1 ? Math.trunc(Number(nextEpoch)) : Math.max(2, Math.trunc(tsMs / 1000));
            tx.set(ref, {
              equipeId: EQUIPE_PADRAO_ID,
              metaId: 'sync_config',
              minClientVersion: Math.max(SYNC_PROTOCOL_VERSION, Math.trunc(Number(minClientVersion) || SYNC_PROTOCOL_VERSION)),
              baselineEpoch: ep,
              migratedFromLegacyV1: true,
              sourceChecksum: String(checksum || '').slice(0, 128),
              versao: 1,
              atualizadoEmMs: tsMs,
              atualizadoPorUid: _currentUser.uid,
              atualizadoPorEmail: emailAtual,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            return { baselineEpoch: ep, versao: 1 };
          } else {
            const prev = snap.data() || {};
            const prevEp = Number(prev.baselineEpoch) || 1;
            const ep = nextEpoch && Number(nextEpoch) > prevEp
              ? Math.trunc(Number(nextEpoch))
              : Math.max(prevEp + 1, Math.trunc(tsMs / 1000));
            const novaVersao = (Number(prev.versao) || 1) + 1;
            tx.update(ref, {
              minClientVersion: Math.max(SYNC_PROTOCOL_VERSION, Math.trunc(Number(minClientVersion) || SYNC_PROTOCOL_VERSION)),
              baselineEpoch: ep,
              migratedFromLegacyV1: true,
              sourceChecksum: String(checksum || prev.sourceChecksum || '').slice(0, 128),
              versao: novaVersao,
              atualizadoEmMs: tsMs,
              atualizadoPorUid: _currentUser.uid,
              atualizadoPorEmail: emailAtual,
              updatedAt: serverTimestamp()
            });
            return { baselineEpoch: ep, versao: novaVersao };
          }
        });
        _quotaBloqueadaAte = 0;
        return res;
      } catch (error) {
        registerQuotaErrorIfAny(error);
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    },
    markMigrationCompleted: async (checksum = '', baselineEpoch = 1) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/meta/migracao_v2`;
      if (!_currentUser || _accessInfo.role !== 'admin') return null;
      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'meta', 'migracao_v2');
      const emailAtual = String(_currentUser.email || '').toLowerCase().slice(0, 200);
      const tsMs = getServerNowMs();
      try {
        return await runTransaction(_db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            tx.set(ref, {
              equipeId: EQUIPE_PADRAO_ID,
              metaId: 'migracao_v2',
              minClientVersion: SYNC_PROTOCOL_VERSION,
              baselineEpoch: Math.max(1, Math.trunc(Number(baselineEpoch) || 1)),
              migratedFromLegacyV1: true,
              sourceChecksum: String(checksum || '').slice(0, 128),
              versao: 1,
              atualizadoEmMs: tsMs,
              atualizadoPorUid: _currentUser.uid,
              atualizadoPorEmail: emailAtual,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            return { versao: 1, migratedFromLegacyV1: true };
          }
          const prev = snap.data() || {};
          if (prev.migratedFromLegacyV1 && prev.sourceChecksum === String(checksum || '').slice(0, 128)) {
            return prev;
          }
          const novaVersao = (Number(prev.versao) || 1) + 1;
          tx.update(ref, {
            minClientVersion: SYNC_PROTOCOL_VERSION,
            baselineEpoch: Math.max(1, Math.trunc(Number(baselineEpoch) || 1)),
            migratedFromLegacyV1: true,
            sourceChecksum: String(checksum || '').slice(0, 128),
            versao: novaVersao,
            atualizadoEmMs: tsMs,
            atualizadoPorUid: _currentUser.uid,
            atualizadoPorEmail: emailAtual,
            updatedAt: serverTimestamp()
          });
          return { versao: novaVersao, migratedFromLegacyV1: true };
        });
      } catch (error) {
        registerQuotaErrorIfAny(error);
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    },

    // ============ API LEGADA PROTEGIDA POR TRANSAÇÃO OCC ============
    observeModulo: (moduloId, onData, onError) =>
      observeDocGeneric('modulos', moduloId, onData, onError),
    getModuloOnce: (moduloId) =>
      getDocGeneric('modulos', moduloId, false, false),
    getModuloFromServer: (moduloId, manual = false) =>
      getDocGeneric('modulos', moduloId, true, manual),
    saveModulo: async (moduloId, payloadBruto, atualizadoEmMs = null, manual = false, mergeOnConflictFn = null) => {
      const path = `equipes/${EQUIPE_PADRAO_ID}/modulos/${moduloId}`;
      if (!_currentUser || !_accessInfo.autorizado) {
        throw new Error('Usuário Google não autenticado ou sem acesso à equipe.');
      }
      if (!manual && Date.now() < _quotaBloqueadaAte) {
        throw new Error('Quota exceeded: envio pausado temporariamente após atingir a cota diária do Firestore.');
      }

      const ref = doc(_db, 'equipes', EQUIPE_PADRAO_ID, 'modulos', moduloId);
      const emailAtual = String(_currentUser.email || '').toLowerCase().slice(0, 200);
      const tStart = Date.now();

      try {
        const res = await runTransaction(_db, async (tx) => {
          const snap = await tx.get(ref);
          const remoteDoc = snap.exists() ? (snap.data() || null) : null;
          let finalPayload = payloadBruto;
          if (remoteDoc && typeof mergeOnConflictFn === 'function') {
            finalPayload = mergeOnConflictFn(payloadBruto, remoteDoc);
            if (finalPayload && finalPayload.__skipWrite) {
              return { skipped: true, versao: Number(remoteDoc.versao) || 1 };
            }
          }
          const payloadLimpo = sanitizeForFirestore(finalPayload) || {};
          const approxBytes = new Blob([JSON.stringify(payloadLimpo)]).size;
          if (approxBytes > 950000) {
            throw new Error(`Tamanho dos dados (${Math.round(approxBytes / 1024)} KB) excede o limite de 950 KB por documento.`);
          }
          const tsMs = Number(atualizadoEmMs) || getServerNowMs();

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
            const prevVersao = Number(remoteDoc?.versao) || 1;
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
        const tEnd = Date.now();
        _quotaBloqueadaAte = 0;
        if (res?.versao) _moduloVersoes.set(moduloId, Number(res.versao));
        getDoc(ref).then((postSnap) => {
          if (postSnap.exists() && !postSnap.metadata?.hasPendingWrites) {
            updateServerClockOffsetFromCommit(Math.round((tStart + tEnd) / 2), postSnap.data()?.updatedAt);
          }
        }).catch(() => {});
        return res;
      } catch (error) {
        registerQuotaErrorIfAny(error);
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
