(function (global) {
  'use strict';

  const SYNC_PROTOCOL_VERSION = 2;
  const BUCKET_COUNT = 4;
  const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  const SYNC_QUEUE_STORAGE_KEY = 'pmcd_sync_queue_v2';
  const DEVICE_EPOCH_STORAGE_KEY = 'pmcd_device_epoch_v2';
  const LEGACY_ARCHIVE_STORAGE_KEY = 'pmcd_legacy_pre_epoch_archive_v1';

  function cloneDeep(v) {
    if (v === undefined || v === null) return v;
    return JSON.parse(JSON.stringify(v));
  }

  const LAST_MONOTONIC_TS_KEY = 'pmcd_last_monotonic_ts_v2';
  let _lastMonotonicTsMs = 0;
  try {
    const savedMono = Number(localStorage.getItem(LAST_MONOTONIC_TS_KEY)) || 0;
    if (Number.isFinite(savedMono) && savedMono > 0) _lastMonotonicTsMs = Math.trunc(savedMono);
  } catch (e) {}

  function serverNowMs() {
    try {
      if (global.PmcdFirebase && typeof global.PmcdFirebase.getServerNowMs === 'function') {
        return global.PmcdFirebase.getServerNowMs();
      }
    } catch (e) {}
    try {
      const off = Number(localStorage.getItem('pmcd_clock_offset_ms_v2')) || 0;
      return Math.round(Date.now() + off);
    } catch (e) {}
    return Date.now();
  }

  function observeRemoteTs(ts) {
    const n = toMs(ts, 0);
    if (n > _lastMonotonicTsMs) {
      _lastMonotonicTsMs = n;
      try { localStorage.setItem(LAST_MONOTONIC_TS_KEY, String(_lastMonotonicTsMs)); } catch (e) {}
    }
    return _lastMonotonicTsMs;
  }

  function monotonicNowMs(minFloor = 0) {
    const base = serverNowMs();
    const floor = Math.max(toMs(minFloor, 0), _lastMonotonicTsMs);
    const next = Math.max(base, floor + 1);
    _lastMonotonicTsMs = next;
    try { localStorage.setItem(LAST_MONOTONIC_TS_KEY, String(next)); } catch (e) {}
    return next;
  }

  function toMs(v, fallback = 0) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
      const p = Date.parse(v);
      if (Number.isFinite(p) && p >= 0) return p;
    }
    return fallback;
  }

  function isRecordDeleted(rec) {
    return Boolean(rec && (rec._deleted === true || rec.removido === true || rec._pinnedTombstone === true));
  }

  function isPinnedTombstone(rec) {
    return Boolean(rec && rec._pinnedTombstone === true);
  }

  function hasNonEmptyValue(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'object') return false;
    return String(v).trim() !== '';
  }

  function boletimImovelTemDados(im) {
    if (!im || typeof im !== 'object') return false;
    return hasNonEmptyValue(im.rua) || hasNonEmptyValue(im.numero) || hasNonEmptyValue(im.comp) ||
      hasNonEmptyValue(im.seq) || hasNonEmptyValue(im.tipo);
  }

  function sanitizeDocIdPart(s) {
    return String(s || 'x').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'x';
  }

  function semanaDocId(atividade, ano, semanaKey) {
    const at = atividade === 'liraa' ? 'liraa' : 'ciclo';
    const an = String(ano || new Date().getFullYear()).replace(/[^0-9]/g, '').slice(0, 4) || '0000';
    const sk = sanitizeDocIdPart(semanaKey);
    return `${at}_${an}_${sk}`.slice(0, 64);
  }

  function bucketIndexForQuarteirao(qKey) {
    const str = String(qKey || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % BUCKET_COUNT;
  }

  function andamentoBucketId(atividade, idx) {
    const at = atividade === 'liraa' ? 'liraa' : 'ciclo';
    const b = Math.max(0, Math.min(BUCKET_COUNT - 1, Number(idx) || 0));
    return `${at}_b${b}`;
  }

  function fnv1aHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function computeEstadoChecksum(est) {
    if (!est || typeof est !== 'object') return '00000000';
    const countSem = (col) => {
      if (!col || typeof col !== 'object') return [];
      return Object.keys(col).sort().map((sk) => {
        const s = col[sk];
        if (!s || isRecordDeleted(s)) return `${sk}:DEL`;
        let nonEmpty = 0;
        if (s.dias) {
          Object.keys(s.dias).forEach((dk) => {
            const ags = s.dias[dk]?.agentes || [];
            ags.forEach((a) => {
              if (!a || isRecordDeleted(a) || !a.valores) return;
              Object.keys(a.valores).forEach((vk) => {
                if (hasNonEmptyValue(a.valores[vk])) nonEmpty++;
              });
            });
          });
        }
        return `${sk}:${nonEmpty}`;
      });
    };
    const core = {
      sc: countSem(est.semanas),
      sl: countSem(est.semanasLiraa),
      ag: (est.configEquipe?.agentes || []).filter((a) => a && !isRecordDeleted(a)).length,
      pr: (est.programacao || []).filter((p) => p && !isRecordDeleted(p)).length,
      rc: (est.relatoriosCampo || []).filter((r) => r && !isRecordDeleted(r)).length,
      ql: (est.quarteiroesLiraaTabela?.linhas || []).filter((l) => l && l.isSel).length
    };
    return fnv1aHash(JSON.stringify(core));
  }

  // ============ FILA OFFLINE PERSISTENTE (syncQueue) ============
  function readSyncQueue() {
    try {
      const raw = localStorage.getItem(SYNC_QUEUE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeSyncQueue(q) {
    try {
      localStorage.setItem(SYNC_QUEUE_STORAGE_KEY, JSON.stringify(q || {}));
    } catch (e) {}
  }

  function enqueueSyncOp(scope, subcol, docId, dirtyMeta = {}) {
    if (!scope || !subcol || !docId) return;
    const key = `${scope}:${subcol}:${docId}`;
    const q = readSyncQueue();
    const prev = q[key] || {};
    const now = serverNowMs();
    const mergedKeys = Array.from(new Set([...(prev.dirtyKeys || []), ...(dirtyMeta.dirtyKeys || [])])).slice(0, 200);
    q[key] = {
      key,
      scope,
      subcol,
      docId,
      dirtyKeys: mergedKeys,
      updatedAtMs: Math.max(Number(prev.updatedAtMs) || 0, Number(dirtyMeta.updatedAtMs) || now),
      enqueuedAtMs: prev.enqueuedAtMs || now
    };
    writeSyncQueue(q);
    return q[key];
  }

  function dequeueSyncOpIfUnchanged(scope, subcol, docId, committedOpTsMs) {
    const key = `${scope}:${subcol}:${docId}`;
    const q = readSyncQueue();
    const cur = q[key];
    if (!cur) return false;
    if ((Number(cur.updatedAtMs) || 0) <= (Number(committedOpTsMs) || 0)) {
      delete q[key];
      writeSyncQueue(q);
      return true;
    }
    return false;
  }

  function listPendingSyncOps(scope = null) {
    const q = readSyncQueue();
    return Object.values(q)
      .filter((item) => item && (!scope || item.scope === scope))
      .sort((a, b) => (Number(a.enqueuedAtMs) || 0) - (Number(b.enqueuedAtMs) || 0));
  }

  function clearPendingSyncOps(scope = null) {
    if (!scope) {
      writeSyncQueue({});
      return;
    }
    const q = readSyncQueue();
    Object.keys(q).forEach((k) => {
      if (q[k]?.scope === scope) delete q[k];
    });
    writeSyncQueue(q);
  }

  // ============ CONTROLE DE ÉPOCA / MARCO ZERO ============
  function getDeviceEpoch() {
    try {
      return Math.max(0, Math.trunc(Number(localStorage.getItem(DEVICE_EPOCH_STORAGE_KEY)) || 0));
    } catch (e) {
      return 0;
    }
  }

  function setDeviceEpoch(epoch) {
    try {
      localStorage.setItem(DEVICE_EPOCH_STORAGE_KEY, String(Math.max(0, Math.trunc(Number(epoch) || 0))));
    } catch (e) {}
  }

  function archiveLegacyStorageBeforeEpochReset(remoteEpoch, reason = 'epoch_upgrade') {
    const keysToSnapshot = [
      'lancamentos_campo_v27',
      'diario_producao_v1',
      'diario_liraa_producao_v1',
      'pmcd_liraa_indices_formulario_v1',
      'LIRAA_FORM_DATA_STORAGE',
      'diario_status_quarteiroes_v1',
      'diario_liraa_status_quarteiroes_v1'
    ];
    try {
      const snap = {
        archivedAt: new Date().toISOString(),
        remoteEpoch,
        reason,
        data: {}
      };
      keysToSnapshot.forEach((k) => {
        try {
          const val = localStorage.getItem(k);
          if (val) snap.data[k] = val;
        } catch (e) {}
      });
      if (Object.keys(snap.data).length > 0) {
        const json = JSON.stringify(snap);
        if (json.length < 2500000) {
          localStorage.setItem(LEGACY_ARCHIVE_STORAGE_KEY, json);
        }
      }
      // Limpa flags pendentes pré-época para impedir sobrescrita da base oficial
      localStorage.removeItem(SYNC_QUEUE_STORAGE_KEY);
      localStorage.removeItem('pmcd_andamento_pendente_sync_v1');
      localStorage.removeItem('pmcd_andamento_liraa_pendente_sync_v1');
      try {
        const rawMain = localStorage.getItem('lancamentos_campo_v27');
        if (rawMain) {
          const parsed = JSON.parse(rawMain);
          if (parsed && typeof parsed === 'object') {
            parsed._pendenteSync = false;
            localStorage.setItem('lancamentos_campo_v27', JSON.stringify(parsed));
          }
        }
      } catch (e) {}
    } catch (e) {}
  }

  function checkEpochCompatibility(syncConfigDoc) {
    if (!syncConfigDoc || typeof syncConfigDoc !== 'object') {
      return { compatible: true, epochResetRequired: false, remoteEpoch: Math.max(1, getDeviceEpoch() || 1), minClientVersion: SYNC_PROTOCOL_VERSION };
    }
    const minClient = Math.max(1, Math.trunc(Number(syncConfigDoc.minClientVersion) || 1));
    if (SYNC_PROTOCOL_VERSION < minClient) {
      return { compatible: false, epochResetRequired: false, remoteEpoch: Number(syncConfigDoc.baselineEpoch) || 1, minClientVersion: minClient };
    }
    const remoteEpoch = Math.max(1, Math.trunc(Number(syncConfigDoc.baselineEpoch) || 1));
    const localEpoch = getDeviceEpoch();
    if (localEpoch > 0 && remoteEpoch > localEpoch) {
      return { compatible: true, epochResetRequired: true, remoteEpoch, minClientVersion: minClient };
    }
    if (localEpoch === 0 && syncConfigDoc.migratedFromLegacyV1 && remoteEpoch > 1) {
      // Primeira vez que aparelho antigo (sem pmcd_device_epoch_v2) encontra uma Base Oficial publicada (> 1)
      return { compatible: true, epochResetRequired: true, remoteEpoch, minClientVersion: minClient };
    }
    if (localEpoch === 0) {
      setDeviceEpoch(remoteEpoch);
    }
    return { compatible: true, epochResetRequired: false, remoteEpoch, minClientVersion: minClient };
  }

  // ============ MERGE DE ARRAYS COM TOMBSTONES ============
  function mergeArrayByIdWithTombstones(localArr, remoteArr, options = {}) {
    const idField = options.idField || 'id';
    const tsField = options.tsField || 'atualizadoEm';
    const matchByNameFallback = Boolean(options.matchByNameFallback);
    const now = serverNowMs();
    const map = new Map();

    const findExistingKey = (item) => {
      if (!item || typeof item !== 'object') return null;
      const id = item[idField] ? String(item[idField]) : '';
      if (id && map.has(id)) return id;
      if (matchByNameFallback && item.nome) {
        const norm = String(item.nome).trim().toLowerCase();
        for (const [k, existing] of map.entries()) {
          if (existing && existing.nome && String(existing.nome).trim().toLowerCase() === norm) {
            return k;
          }
        }
      }
      return id || null;
    };

    const upsert = (item, fromRemote) => {
      if (!item || typeof item !== 'object') return;
      const key = findExistingKey(item);
      if (!key) return;
      const copy = cloneDeep(item);
      if (!copy[idField]) copy[idField] = key;
      const itemTs = Math.max(
        toMs(copy[tsField], 0),
        toMs(copy._deletedAtMs, 0),
        toMs(copy._ts, 0)
      );
      const prev = map.get(key);
      if (!prev) {
        map.set(key, copy);
        return;
      }
      if (isPinnedTombstone(copy) && !isPinnedTombstone(prev)) {
        map.set(key, copy);
        return;
      }
      if (isPinnedTombstone(prev) && !isPinnedTombstone(copy)) {
        return;
      }
      const prevTs = Math.max(
        toMs(prev[tsField], 0),
        toMs(prev._deletedAtMs, 0),
        toMs(prev._ts, 0)
      );
      if (itemTs > prevTs) {
        map.set(key, copy);
      } else if (itemTs === prevTs) {
        // Em empate exato, tombstone ou versão remota vence de forma determinística
        const itemDel = isRecordDeleted(copy);
        const prevDel = isRecordDeleted(prev);
        if (itemDel && !prevDel) {
          map.set(key, copy);
        } else if (fromRemote && itemDel === prevDel) {
          map.set(key, copy);
        }
      }
    };

    (Array.isArray(localArr) ? localArr : []).forEach((it) => upsert(it, false));
    (Array.isArray(remoteArr) ? remoteArr : []).forEach((it) => upsert(it, true));

    return Array.from(map.values()).filter((it) => {
      if (!isRecordDeleted(it)) return true;
      if (isPinnedTombstone(it)) return true;
      const delAt = toMs(it._deletedAtMs || it[tsField], now);
      return (now - delAt) < TOMBSTONE_RETENTION_MS;
    });
  }

  // ============ MERGE GRANULAR DE SEMANA EPIDEMIOLÓGICA ============
  function maxTsInSemana(sem) {
    if (!sem || typeof sem !== 'object') return 0;
    let maxT = Math.max(toMs(sem._ts, 0), toMs(sem._deletedAtMs, 0));
    if (sem._cabTs && typeof sem._cabTs === 'object') {
      Object.values(sem._cabTs).forEach((t) => { maxT = Math.max(maxT, toMs(t, 0)); });
    }
    if (sem._rodTs && typeof sem._rodTs === 'object') {
      Object.values(sem._rodTs).forEach((t) => { maxT = Math.max(maxT, toMs(t, 0)); });
    }
    if (sem.dias && typeof sem.dias === 'object') {
      Object.keys(sem.dias).forEach((dk) => {
        const d = sem.dias[dk];
        if (!d) return;
        maxT = Math.max(maxT, toMs(d._ts, 0));
        if (d._fieldTs) {
          Object.values(d._fieldTs).forEach((t) => { maxT = Math.max(maxT, toMs(t, 0)); });
        }
        (d.agentes || []).forEach((ag) => {
          if (!ag) return;
          maxT = Math.max(maxT, toMs(ag._ts, 0), toMs(ag._deletedAtMs, 0));
          if (ag._valoresTs) {
            Object.values(ag._valoresTs).forEach((t) => { maxT = Math.max(maxT, toMs(t, 0)); });
          }
        });
      });
    }
    if (sem.resumo && typeof sem.resumo === 'object') {
      maxT = Math.max(maxT, toMs(sem.resumo._ts, 0));
      if (sem.resumo._valoresTs && typeof sem.resumo._valoresTs === 'object') {
        Object.values(sem.resumo._valoresTs).forEach((t) => { maxT = Math.max(maxT, toMs(t, 0)); });
      }
    }
    return maxT;
  }

  function mergeSemanaPayload(localSem, remoteSem, opcoes = {}) {
    if (!remoteSem || typeof remoteSem !== 'object') return cloneDeep(localSem);
    if (!localSem || typeof localSem !== 'object') return cloneDeep(remoteSem);

    const locDel = isRecordDeleted(localSem);
    const remDel = isRecordDeleted(remoteSem);
    const locDelTs = locDel ? toMs(localSem._deletedAtMs || localSem._ts, 0) : 0;
    const remDelTs = remDel ? toMs(remoteSem._deletedAtMs || remoteSem._ts, 0) : 0;
    const locDataTs = maxTsInSemana(localSem);
    const remDataTs = maxTsInSemana(remoteSem);

    if (locDel && remDel) {
      return locDelTs >= remDelTs ? cloneDeep(localSem) : cloneDeep(remoteSem);
    }
    if (locDel && locDelTs >= remDataTs) {
      return cloneDeep(localSem);
    }
    if (remDel && remDelTs >= locDataTs) {
      return cloneDeep(remoteSem);
    }

    const res = cloneDeep(remoteSem);
    res._deleted = false;
    delete res._deletedAtMs;
    delete res._deletedByUid;
    res._ts = Math.max(locDataTs, remDataTs);

    const locBaseTs = toMs(localSem._ts, 0);
    const remBaseTs = toMs(remoteSem._ts, 0);

    // 1. Cabeçalho campo a campo
    res.cabecalho = res.cabecalho || {};
    res._cabTs = { ...(remoteSem._cabTs || {}) };
    const locCab = localSem.cabecalho || {};
    const locCabTs = localSem._cabTs || {};
    Object.keys(locCab).forEach((k) => {
      const tL = toMs(locCabTs[k], (k in locCab) ? locBaseTs : 0);
      const hasR = (k in res.cabecalho) || res._cabTs[k] !== undefined;
      const tR = hasR ? toMs(res._cabTs[k], remBaseTs) : 0;
      const temL = hasNonEmptyValue(locCab[k]);
      const temR = hasNonEmptyValue(res.cabecalho[k]);
      if (tL > tR || (tL === tR && temL && !temR)) {
        res.cabecalho[k] = locCab[k];
        res._cabTs[k] = tL;
      } else if (hasR) {
        res._cabTs[k] = tR;
      }
    });

    // 2. Rodapé campo a campo
    res.rodape = res.rodape || {};
    res._rodTs = { ...(remoteSem._rodTs || {}) };
    const locRod = localSem.rodape || {};
    const locRodTs = localSem._rodTs || {};
    Object.keys(locRod).forEach((k) => {
      const tL = toMs(locRodTs[k], (k in locRod) ? locBaseTs : 0);
      const hasR = (k in res.rodape) || res._rodTs[k] !== undefined;
      const tR = hasR ? toMs(res._rodTs[k], remBaseTs) : 0;
      const temL = hasNonEmptyValue(locRod[k]);
      const temR = hasNonEmptyValue(res.rodape[k]);
      if (tL > tR || (tL === tR && temL && !temR)) {
        res.rodape[k] = locRod[k];
        res._rodTs[k] = tL;
      } else if (hasR) {
        res._rodTs[k] = tR;
      }
    });

    // 3. Dias da semana
    const dias = ['segunda', 'terca', 'quarta', 'quinta', 'sexta'];
    res.dias = res.dias || {};
    const locDias = localSem.dias || {};
    dias.forEach((dk) => {
      const dL = locDias[dk];
      const dR = res.dias[dk];
      if (!dL) return;
      if (!dR) {
        res.dias[dk] = cloneDeep(dL);
        return;
      }
      dR._fieldTs = { ...(dR._fieldTs || {}) };
      const dLBase = toMs(dL._ts, locBaseTs);
      const dRBase = toMs(dR._ts, remBaseTs);
      ['data', 'programados', '_dataConfirmada'].forEach((fk) => {
        if (dL[fk] === undefined) return;
        const tL = toMs(dL._fieldTs?.[fk], dLBase);
        const hasR = dR[fk] !== undefined || dR._fieldTs?.[fk] !== undefined;
        const tR = hasR ? toMs(dR._fieldTs?.[fk], dRBase) : 0;
        const temL = hasNonEmptyValue(dL[fk]) || dL[fk] === true;
        const temR = hasNonEmptyValue(dR[fk]) || dR[fk] === true;
        if (tL > tR || (tL === tR && temL && !temR)) {
          dR[fk] = dL[fk];
          dR._fieldTs[fk] = tL;
        }
      });

      // Agentes no dia: merge por ID/nome + timestamp por célula
      const agsR = Array.isArray(dR.agentes) ? dR.agentes : [];
      const agsL = Array.isArray(dL.agentes) ? dL.agentes : [];
      agsL.forEach((agL) => {
        if (!agL) return;
        let agR = agsR.find((a) => a && ((agL.id && a.id === agL.id) || (agL.nome && a.nome && a.nome.trim().toLowerCase() === agL.nome.trim().toLowerCase())));
        if (!agR) {
          agsR.push(cloneDeep(agL));
          return;
        }
        const aLTs = toMs(agL._ts, dLBase);
        const aRTs = toMs(agR._ts, dRBase);
        const agLDel = isRecordDeleted(agL);
        const agRDel = isRecordDeleted(agR);
        const agLDelTs = agLDel ? toMs(agL._deletedAtMs, aLTs) : 0;
        const agRDelTs = agRDel ? toMs(agR._deletedAtMs, aRTs) : 0;
        if (agLDel && (agLDelTs > Math.max(aRTs, agRDelTs) || (agLDelTs === Math.max(aRTs, agRDelTs) && !agRDel))) {
          agR._deleted = true;
          agR._deletedAtMs = agLDelTs;
        } else if (!agLDel && agRDel && aLTs > agRDelTs) {
          agR._deleted = false;
          delete agR._deletedAtMs;
        }
        if (aLTs > aRTs) {
          if (agL.nome) agR.nome = agL.nome;
          if (agL.ativo !== undefined) agR.ativo = agL.ativo;
          agR._ts = aLTs;
        }
        agR.valores = agR.valores || {};
        agR._valoresTs = { ...(agR._valoresTs || {}) };
        const vL = agL.valores || {};
        const vLTs = agL._valoresTs || {};
        Object.keys(vL).forEach((vk) => {
          const tCellL = toMs(vLTs[vk], aLTs);
          const hasR = (vk in agR.valores) || agR._valoresTs[vk] !== undefined;
          const tCellR = hasR ? toMs(agR._valoresTs[vk], aRTs) : 0;
          const temL = hasNonEmptyValue(vL[vk]);
          const temR = hasNonEmptyValue(agR.valores[vk]);
          // Preserva célula apagada intencionalmente se tCellL > tCellR
          if (tCellL > tCellR || (tCellL === tCellR && temL && !temR)) {
            agR.valores[vk] = vL[vk];
            agR._valoresTs[vk] = tCellL;
          } else if (hasR && agR._valoresTs[vk] === undefined && tCellR > 0) {
            agR._valoresTs[vk] = tCellR;
          }
        });
      });
      dR.agentes = agsR;
      dR._ts = Math.max(dLBase, dRBase);
    });

    if (localSem.resumo && typeof localSem.resumo === 'object') {
      if (!res.resumo || typeof res.resumo !== 'object') {
        res.resumo = cloneDeep(localSem.resumo);
      } else {
        const rLBase = toMs(localSem.resumo._ts, locBaseTs);
        const rRBase = toMs(res.resumo._ts, remBaseTs);
        res.resumo.valores = { ...(res.resumo.valores || {}) };
        res.resumo._valoresTs = { ...(res.resumo._valoresTs || {}) };
        const lVals = localSem.resumo.valores || {};
        const lValsTs = localSem.resumo._valoresTs || {};
        Object.keys(lVals).forEach((vk) => {
          const tL = toMs(lValsTs[vk], rLBase);
          const hasR = (vk in res.resumo.valores) || res.resumo._valoresTs[vk] !== undefined;
          const tR = hasR ? toMs(res.resumo._valoresTs[vk], rRBase) : 0;
          const temL = hasNonEmptyValue(lVals[vk]);
          const temR = hasNonEmptyValue(res.resumo.valores[vk]);
          if (tL > tR || (tL === tR && temL && !temR)) {
            res.resumo.valores[vk] = lVals[vk];
            res.resumo._valoresTs[vk] = tL;
          } else if (hasR && res.resumo._valoresTs[vk] === undefined && tR > 0) {
            res.resumo._valoresTs[vk] = tR;
          }
        });
        res.resumo._ts = Math.max(rLBase, rRBase);
      }
    }

    if (localSem.ano && (!res.ano || locBaseTs > remBaseTs)) res.ano = localSem.ano;
    if (localSem.atividade && !res.atividade) res.atividade = localSem.atividade;
    return res;
  }

  // ============ MERGE DE DOMÍNIO: CONFIG_GERAL ============
  function mergeConfigGeralPayload(localCfg, remoteCfg) {
    if (!remoteCfg || typeof remoteCfg !== 'object') return cloneDeep(localCfg);
    if (!localCfg || typeof localCfg !== 'object') return cloneDeep(remoteCfg);

    const res = cloneDeep(remoteCfg);
    const tsL = toMs(localCfg._ts, 0);
    const tsR = toMs(remoteCfg._ts, 0);

    // 1. configEquipe
    if (localCfg.configEquipe) {
      if (!res.configEquipe) {
        res.configEquipe = cloneDeep(localCfg.configEquipe);
      } else {
        const eqL = localCfg.configEquipe;
        const eqR = res.configEquipe;
        const eqLTs = toMs(eqL._ts, tsL);
        const eqRTs = toMs(eqR._ts, tsR);
        eqR._fieldTs = { ...(eqR._fieldTs || {}) };
        ['bairro', 'estrato', 'equipe', 'supervisor', 'responsavel'].forEach((fk) => {
          if (eqL[fk] === undefined) return;
          const fL = toMs(eqL._fieldTs?.[fk], eqLTs);
          const hasR = (fk in eqR) || eqR._fieldTs?.[fk] !== undefined;
          const fR = hasR ? toMs(eqR._fieldTs?.[fk], eqRTs) : 0;
          if (fL > fR || (fL === fR && hasNonEmptyValue(eqL[fk]) && !hasNonEmptyValue(eqR[fk]))) {
            eqR[fk] = eqL[fk];
            eqR._fieldTs[fk] = fL;
          }
        });
        eqR.agentes = mergeArrayByIdWithTombstones(eqL.agentes, eqR.agentes, {
          idField: 'id',
          tsField: 'atualizadoEm',
          matchByNameFallback: true
        });
        eqR._ts = Math.max(eqLTs, eqRTs);
      }
    }

    // 2. configEstrato
    if (localCfg.configEstrato) {
      if (!res.configEstrato) {
        res.configEstrato = cloneDeep(localCfg.configEstrato);
      } else {
        const esL = localCfg.configEstrato;
        const esR = res.configEstrato;
        const esLTs = toMs(esL._ts, tsL);
        const esRTs = toMs(esR._ts, tsR);
        esR._fieldTs = { ...(esR._fieldTs || {}) };
        Object.keys(esL).forEach((fk) => {
          if (fk === '_ts' || fk === '_fieldTs') return;
          const fL = toMs(esL._fieldTs?.[fk], esLTs);
          const hasR = (fk in esR) || esR._fieldTs?.[fk] !== undefined;
          const fR = hasR ? toMs(esR._fieldTs?.[fk], esRTs) : 0;
          if (fL > fR || (fL === fR && hasNonEmptyValue(esL[fk]) && !hasNonEmptyValue(esR[fk]))) {
            esR[fk] = esL[fk];
            esR._fieldTs[fk] = fL;
          }
        });
        esR._ts = Math.max(esLTs, esRTs);
      }
    }

    // 3. ciclosConfig (mapa por ano_ciclo_atividade)
    res.ciclosConfig = { ...(res.ciclosConfig || {}) };
    const ccL = localCfg.ciclosConfig || {};
    Object.keys(ccL).forEach((ck) => {
      const cL = ccL[ck];
      const cR = res.ciclosConfig[ck];
      if (!cR || toMs(cL?._ts, tsL) > toMs(cR?._ts, tsR)) {
        res.ciclosConfig[ck] = cloneDeep(cL);
      }
    });

    // 4. programacao & usuariosPermitidos com tombstones
    res.programacao = mergeArrayByIdWithTombstones(localCfg.programacao, res.programacao, { tsField: 'atualizadoEm' });
    res.usuariosPermitidos = mergeArrayByIdWithTombstones(localCfg.usuariosPermitidos, res.usuariosPermitidos, { tsField: 'atualizadoEm' });

    // 5. semanasInativas
    res.semanasInativas = { ...(res.semanasInativas || {}) };
    const siL = localCfg.semanasInativas || {};
    Object.keys(siL).forEach((sk) => {
      const vL = siL[sk];
      const vR = res.semanasInativas[sk];
      const tL = vL && typeof vL === 'object' ? toMs(vL.atualizadoEm, tsL) : (vL ? 1 : 0);
      const tR = vR && typeof vR === 'object' ? toMs(vR.atualizadoEm, tsR) : (vR ? 1 : 0);
      if (!vR || tL > tR) res.semanasInativas[sk] = cloneDeep(vL);
    });

    // 6. semanasIndex (mapa de documentos em /semanas/{semanaDocId})
    res.semanasIndex = { ...(res.semanasIndex || {}) };
    const idxL = localCfg.semanasIndex || {};
    Object.keys(idxL).forEach((semDocId) => {
      const eL = idxL[semDocId];
      const eR = res.semanasIndex[semDocId];
      if (!eR || toMs(eL?._ts, 0) > toMs(eR?._ts, 0)) {
        res.semanasIndex[semDocId] = cloneDeep(eL);
      }
    });

    // 7. indicesLiraaForm & quarteiroesLiraaTabela por timestamp
    if (localCfg.indicesLiraaForm) {
      const tL = toMs(localCfg.indicesLiraaForm.atualizadoEm, tsL);
      const tR = toMs(res.indicesLiraaForm?.atualizadoEm, tsR);
      if (!res.indicesLiraaForm || tL > tR) {
        res.indicesLiraaForm = cloneDeep(localCfg.indicesLiraaForm);
      }
    }
    if (localCfg.quarteiroesLiraaTabela) {
      const tL = toMs(localCfg.quarteiroesLiraaTabela.atualizadoEm, tsL);
      const tR = toMs(res.quarteiroesLiraaTabela?.atualizadoEm, tsR);
      if (!res.quarteiroesLiraaTabela || tL > tR) {
        res.quarteiroesLiraaTabela = cloneDeep(localCfg.quarteiroesLiraaTabela);
      }
    }

    // 8. ciclo e cicloLiraa cabeçalho/rodapé consolidados
    ['ciclo', 'cicloLiraa'].forEach((ck) => {
      if (localCfg[ck]) {
        if (!res[ck]) res[ck] = cloneDeep(localCfg[ck]);
        else {
          const tL = toMs(localCfg[ck]._ts, tsL);
          const tR = toMs(res[ck]._ts, tsR);
          if (tL > tR) res[ck] = cloneDeep(localCfg[ck]);
        }
      }
    });

    res._ts = Math.max(tsL, tsR);
    return res;
  }

  // ============ MERGE DE DOMÍNIO: RELATÓRIOS E RESUMO DE RECONHECIMENTO ============
  function resumoLinhaTemDados(row) {
    if (!row || typeof row !== 'object') return false;
    return hasNonEmptyValue(row.r) || hasNonEmptyValue(row.c) || hasNonEmptyValue(row.tb) ||
      hasNonEmptyValue(row.pe) || hasNonEmptyValue(row.o) ||
      hasNonEmptyValue(row.R) || hasNonEmptyValue(row.C) || hasNonEmptyValue(row.TB) ||
      hasNonEmptyValue(row.PE) || hasNonEmptyValue(row.O);
  }

  function mergeResumoTabela(locArr, remArr, tLBase, tRBase) {
    if (!Array.isArray(locArr) && !Array.isArray(remArr)) return undefined;
    const len = Math.max(Array.isArray(locArr) ? locArr.length : 0, Array.isArray(remArr) ? remArr.length : 0);
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const rL = Array.isArray(locArr) ? locArr[i] : null;
      const rR = Array.isArray(remArr) ? remArr[i] : null;
      if (!rR && rL) { out[i] = cloneDeep(rL); continue; }
      if (!rL && rR) { out[i] = cloneDeep(rR); continue; }
      if (!rL && !rR) { out[i] = { quarteirao: String(i + 1), r: '', c: '', tb: '', pe: '', o: '' }; continue; }
      const tsL = Math.max(toMs(rL._ts, 0), toMs(rL.atualizadoEmMs, 0), toMs(rL._clearedAtMs, 0)) || tLBase;
      const tsR = Math.max(toMs(rR._ts, 0), toMs(rR.atualizadoEmMs, 0), toMs(rR._clearedAtMs, 0)) || tRBase;
      const clrL = toMs(rL._clearedAtMs, 0);
      const clrR = toMs(rR._clearedAtMs, 0);
      const temL = resumoLinhaTemDados(rL);
      const temR = resumoLinhaTemDados(rR);
      if (tsL > tsR) {
        out[i] = cloneDeep(rL);
      } else if (tsR > tsL) {
        out[i] = cloneDeep(rR);
      } else if (clrL >= tsR && !temL) {
        out[i] = cloneDeep(rL);
      } else if (clrR >= tsL && !temR) {
        out[i] = cloneDeep(rR);
      } else if (temL && !temR) {
        out[i] = cloneDeep(rL);
      } else {
        out[i] = cloneDeep(rR);
      }
    }
    return out;
  }

  function mergeResumoReconhecimentoObj(locRec, remRec) {
    if (!remRec || typeof remRec !== 'object') return cloneDeep(locRec);
    if (!locRec || typeof locRec !== 'object') return cloneDeep(remRec);

    const res = cloneDeep(remRec);
    const tLBase = toMs(locRec.atualizadoEmMs || locRec.timestamp || locRec._ts, 0);
    const tRBase = toMs(remRec.atualizadoEmMs || remRec.timestamp || remRec._ts, 0);

    res.cabecalho = { ...(res.cabecalho || {}) };
    res._cabTs = { ...(remRec._cabTs || {}) };
    const locCab = locRec.cabecalho || {};
    const locCabTs = locRec._cabTs || {};
    Object.keys(locCab).forEach((k) => {
      const fL = toMs(locCabTs[k], tLBase);
      const hasR = (k in res.cabecalho) || res._cabTs[k] !== undefined;
      const fR = hasR ? toMs(res._cabTs[k], tRBase) : 0;
      if (fL > fR || (fL === fR && hasNonEmptyValue(locCab[k]) && !hasNonEmptyValue(res.cabecalho[k]))) {
        res.cabecalho[k] = locCab[k];
        res._cabTs[k] = fL;
      }
    });

    if (Array.isArray(locRec.tabela1) || Array.isArray(remRec.tabela1)) {
      res.tabela1 = mergeResumoTabela(locRec.tabela1, remRec.tabela1, tLBase, tRBase);
    }
    if (Array.isArray(locRec.tabela2) || Array.isArray(remRec.tabela2)) {
      res.tabela2 = mergeResumoTabela(locRec.tabela2, remRec.tabela2, tLBase, tRBase);
    }

    if (locRec.dadosFormulariosResumo && typeof locRec.dadosFormulariosResumo === 'object') {
      res.dadosFormulariosResumo = { ...(res.dadosFormulariosResumo || {}) };
      Object.keys(locRec.dadosFormulariosResumo).forEach((rk) => {
        const vL = locRec.dadosFormulariosResumo[rk];
        const vR = res.dadosFormulariosResumo[rk];
        if (!vR) {
          res.dadosFormulariosResumo[rk] = cloneDeep(vL);
          return;
        }
        const fL = toMs(vL && (vL._ts || vL.atualizadoEmMs), tLBase);
        const fR = toMs(vR && (vR._ts || vR.atualizadoEmMs), tRBase);
        if (fL > fR || (fL === fR && resumoLinhaTemDados(vL) && !resumoLinhaTemDados(vR))) {
          res.dadosFormulariosResumo[rk] = cloneDeep(vL);
        }
      });
    }

    if (locRec.mapaQuarteiroes && typeof locRec.mapaQuarteiroes === 'object') {
      res.mapaQuarteiroes = { ...(res.mapaQuarteiroes || {}) };
      Object.keys(locRec.mapaQuarteiroes).forEach((qk) => {
        const vL = locRec.mapaQuarteiroes[qk];
        const vR = res.mapaQuarteiroes[qk];
        if (!vR) {
          res.mapaQuarteiroes[qk] = cloneDeep(vL);
          return;
        }
        const qL = toMs(vL && (vL.atualizadoEmMs || vL._ts), tLBase);
        const qR = toMs(vR && (vR.atualizadoEmMs || vR._ts), tRBase);
        if (qL > qR) res.mapaQuarteiroes[qk] = cloneDeep(vL);
      });
    }

    // Quarteirões e demais metadados do resumo de reconhecimento
    Object.keys(locRec).forEach((k) => {
      if (['cabecalho', '_cabTs', 'tabela1', 'tabela2', 'dadosFormulariosResumo', 'mapaQuarteiroes', 'atualizadoEmMs', 'timestamp', '_ts'].includes(k)) return;
      const vL = locRec[k];
      const vR = res[k];
      if (vR === undefined || vR === null) {
        res[k] = cloneDeep(vL);
        return;
      }
      if (typeof vL === 'object' && typeof vR === 'object') {
        const qL = toMs(vL.atualizadoEmMs || vL._ts, tLBase);
        const qR = toMs(vR.atualizadoEmMs || vR._ts, tRBase);
        if (qL > qR) res[k] = cloneDeep(vL);
      } else if (tLBase > tRBase) {
        res[k] = cloneDeep(vL);
      }
    });

    res.atualizadoEmMs = Math.max(tLBase, tRBase);
    res.timestamp = res.atualizadoEmMs;
    res._ts = res.atualizadoEmMs;
    return res;
  }

  function mergeRelatoriosEResumoPayload(localRel, remoteRel) {
    if (!remoteRel || typeof remoteRel !== 'object') return cloneDeep(localRel);
    if (!localRel || typeof localRel !== 'object') return cloneDeep(remoteRel);

    const res = cloneDeep(remoteRel);
    const tsL = toMs(localRel._ts, 0);
    const tsR = toMs(remoteRel._ts, 0);

    res.relatoriosCampo = mergeArrayByIdWithTombstones(localRel.relatoriosCampo, res.relatoriosCampo, {
      idField: 'id',
      tsField: 'atualizadoEm'
    });

    res.resumoReconhecimento = mergeResumoReconhecimentoObj(localRel.resumoReconhecimento, res.resumoReconhecimento);
    res.resumoReconhecimentoLiraa = mergeResumoReconhecimentoObj(localRel.resumoReconhecimentoLiraa, res.resumoReconhecimentoLiraa);

    res.quarteiroesConcluidos = { ...(res.quarteiroesConcluidos || {}) };
    const qcL = localRel.quarteiroesConcluidos || {};
    Object.keys(qcL).forEach((qk) => {
      const rL = qcL[qk];
      const rR = res.quarteiroesConcluidos[qk];
      if (!rR) {
        res.quarteiroesConcluidos[qk] = cloneDeep(rL);
        return;
      }
      const tL = toMs(rL.atualizadoEm || rL._ts, tsL);
      const tR = toMs(rR.atualizadoEm || rR._ts, tsR);
      if (tL > tR) {
        res.quarteiroesConcluidos[qk] = cloneDeep(rL);
      }
    });

    res._ts = Math.max(tsL, tsR);
    return res;
  }

  // ============ MERGE DE ANDAMENTO DOS QUARTEIRÕES (META & BOLETINS BUCKETS) ============
  function mergeAndamentoMetaPayload(localMeta, remoteMeta) {
    if (!remoteMeta || typeof remoteMeta !== 'object') return cloneDeep(localMeta);
    if (!localMeta || typeof localMeta !== 'object') return cloneDeep(remoteMeta);

    const res = cloneDeep(remoteMeta);
    const tsL = toMs(localMeta.timestamp || localMeta._ts, 0);
    const tsR = toMs(remoteMeta.timestamp || remoteMeta._ts, 0);

    // 1. Semanas (diário semanal) com timestamp por célula/data + tombstone
    const mapSem = new Map();
    const semRemArr = Array.isArray(remoteMeta.semanas) ? remoteMeta.semanas : [];
    const semLocArr = Array.isArray(localMeta.semanas) ? localMeta.semanas : [];
    semRemArr.forEach((s) => { if (s && s.id !== undefined) mapSem.set(Number(s.id), cloneDeep(s)); });
    semLocArr.forEach((sl) => {
      if (!sl || sl.id === undefined) return;
      const id = Number(sl.id);
      const sr = mapSem.get(id);
      if (!sr) {
        mapSem.set(id, cloneDeep(sl));
        return;
      }
      const slDel = isRecordDeleted(sl);
      const srDel = isRecordDeleted(sr);
      const slTs = toMs(sl._ts, tsL);
      const srTs = toMs(sr._ts, tsR);
      if (slDel && (toMs(sl._deletedAtMs, slTs) > Math.max(srTs, toMs(sr._deletedAtMs, 0)) || (toMs(sl._deletedAtMs, slTs) === Math.max(srTs, toMs(sr._deletedAtMs, 0)) && !srDel))) {
        mapSem.set(id, cloneDeep(sl));
        return;
      }
      if (srDel && toMs(sr._deletedAtMs, srTs) >= Math.max(slTs, toMs(sl._deletedAtMs, 0))) {
        return;
      }
      sr._deleted = false;
      delete sr._deletedAtMs;
      if (slTs > srTs && sl.titulo) sr.titulo = sl.titulo;

      sr.valores = sr.valores || {};
      sr.valoresTs = { ...(sr.valoresTs || {}) };
      const locVals = sl.valores || {};
      const locValsTs = sl.valoresTs || {};
      Object.keys(locVals).forEach((vk) => {
        const cL = toMs(locValsTs[vk], slTs);
        const hasR = (vk in sr.valores) || sr.valoresTs[vk] !== undefined;
        const cR = hasR ? toMs(sr.valoresTs[vk], srTs) : 0;
        const temL = hasNonEmptyValue(locVals[vk]);
        const temR = hasNonEmptyValue(sr.valores[vk]);
        if (cL > cR || (cL === cR && temL && !temR)) {
          sr.valores[vk] = locVals[vk];
          sr.valoresTs[vk] = cL;
        }
      });

      const maxD = Math.max(Array.isArray(sl.datas) ? sl.datas.length : 0, Array.isArray(sr.datas) ? sr.datas.length : 0);
      sr.datas = Array.isArray(sr.datas) ? sr.datas : [];
      sr.datasTs = Array.isArray(sr.datasTs) ? sr.datasTs : [];
      for (let i = 0; i < maxD; i++) {
        const dl = Array.isArray(sl.datas) ? (sl.datas[i] || '') : '';
        const dr = sr.datas[i] || '';
        const tDL = toMs(Array.isArray(sl.datasTs) ? sl.datasTs[i] : 0, slTs);
        const tDR = toMs(sr.datasTs[i], srTs);
        if (tDL > tDR || (tDL === tDR && hasNonEmptyValue(dl) && !hasNonEmptyValue(dr))) {
          sr.datas[i] = dl;
          sr.datasTs[i] = tDL;
        }
      }
      sr._ts = Math.max(slTs, srTs);
    });
    res.semanas = Array.from(mapSem.values()).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

    // 2. statusQuarteiroes com suporte a formato objeto {valor, atualizadoEm} e string legado
    res.statusQuarteiroes = { ...(res.statusQuarteiroes || {}) };
    res._statusTs = { ...(res._statusTs || {}) };
    const locStatus = localMeta.statusQuarteiroes || {};
    const locStatusTs = localMeta._statusTs || {};
    Object.keys(locStatus).forEach((qk) => {
      const tL = toMs(locStatusTs[qk], tsL);
      const tR = toMs(res._statusTs[qk], tsR);
      if (!(qk in res.statusQuarteiroes) || tL > tR) {
        res.statusQuarteiroes[qk] = cloneDeep(locStatus[qk]);
        res._statusTs[qk] = tL;
      }
    });

    // 3. Seleção LIRAa com tombstones por quarteirão (_liraaSelMap)
    const selMap = { ...(res._liraaSelMap || {}) };
    const normalizeIntoSelMap = (arr, mapObj, baseT) => {
      if (mapObj && typeof mapObj === 'object') {
        Object.keys(mapObj).forEach((q) => {
          const entry = mapObj[q];
          if (!entry) return;
          const tE = toMs(entry.atualizadoEm, baseT);
          const cur = selMap[q];
          if (!cur || tE > toMs(cur.atualizadoEm, 0)) {
            selMap[q] = { sel: Boolean(entry.sel), atualizadoEm: tE };
          }
        });
      } else if (Array.isArray(arr)) {
        arr.forEach((q) => {
          const qs = String(q);
          if (!selMap[qs] || baseT > toMs(selMap[qs].atualizadoEm, 0)) {
            selMap[qs] = { sel: true, atualizadoEm: baseT };
          }
        });
      }
    };
    normalizeIntoSelMap(remoteMeta.liraaSelecionados, remoteMeta._liraaSelMap, tsR);
    normalizeIntoSelMap(localMeta.liraaSelecionados, localMeta._liraaSelMap, tsL);
    res._liraaSelMap = selMap;
    res.liraaSelecionados = Object.keys(selMap).filter((q) => selMap[q] && selMap[q].sel === true);

    // 4. Paginas, cabeçalhos, rodapés e subformulários (resumo, bases, coflagrados)
    ['paginas', 'cabecalhos', 'rodapes'].forEach((sec) => {
      const lObj = localMeta[sec] || {};
      const rObj = res[sec] || {};
      const lTsMap = localMeta[`_${sec}Ts`] || {};
      const rTsMap = { ...(res[`_${sec}Ts`] || {}) };
      Object.keys(lObj).forEach((k) => {
        const fL = toMs(lTsMap[k], tsL);
        const fR = toMs(rTsMap[k], tsR);
        if (!(k in rObj) || fL > fR) {
          rObj[k] = cloneDeep(lObj[k]);
          rTsMap[k] = fL;
        }
      });
      res[sec] = rObj;
      res[`_${sec}Ts`] = rTsMap;
    });

    res.dadosSecoes = res.dadosSecoes || {};
    const lSec = localMeta.dadosSecoes || {};
    ['resumo', 'bases', 'coflagrados'].forEach((sec) => {
      const lData = lSec[sec] || {};
      const rData = res.dadosSecoes[sec] || {};
      const lTsMap = lData._tsMap || {};
      const rTsMap = { ...(rData._tsMap || {}) };
      const out = { ...(rData || {}) };
      Object.keys(lData).forEach((k) => {
        if (k === '_tsMap') return;
        const rowLTs = lData[k] && typeof lData[k] === 'object' ? Math.max(toMs(lData[k]._ts, 0), toMs(lData[k]._clearedAtMs, 0), toMs(lData[k].atualizadoEmMs, 0)) : 0;
        const rowRTs = out[k] && typeof out[k] === 'object' ? Math.max(toMs(out[k]._ts, 0), toMs(out[k]._clearedAtMs, 0), toMs(out[k].atualizadoEmMs, 0)) : 0;
        const fL = Math.max(toMs(lTsMap[k], 0), rowLTs) || tsL;
        const hasR = (k in out) || rTsMap[k] !== undefined;
        const fR = hasR ? (Math.max(toMs(rTsMap[k], 0), rowRTs) || tsR) : 0;
        if (!hasR || fL > fR || (fL === fR && rowLTs > 0 && rowLTs === toMs(lData[k]?._clearedAtMs, 0))) {
          out[k] = cloneDeep(lData[k]);
          rTsMap[k] = fL;
        }
      });
      out._tsMap = rTsMap;
      res.dadosSecoes[sec] = out;
    });

    res.timestamp = Math.max(tsL, tsR);
    res._ts = res.timestamp;
    return res;
  }

  function mergeQuarteiraoBoletim(locQ, remQ) {
    if (!remQ || typeof remQ !== 'object') return cloneDeep(locQ);
    if (!locQ || typeof locQ !== 'object') return cloneDeep(remQ);

    const locDel = isRecordDeleted(locQ);
    const remDel = isRecordDeleted(remQ);
    const locBase = toMs(locQ._ts, 0);
    const remBase = toMs(remQ._ts, 0);
    const locDelTs = locDel ? toMs(locQ._deletedAtMs, locBase) : 0;
    const remDelTs = remDel ? toMs(remQ._deletedAtMs, remBase) : 0;

    if (locDel && (locDelTs > Math.max(remBase, remDelTs) || (locDelTs === Math.max(remBase, remDelTs) && !remDel))) return cloneDeep(locQ);
    if (remDel && remDelTs >= Math.max(locBase, locDelTs)) return cloneDeep(remQ);

    const out = cloneDeep(remQ);
    out._deleted = false;
    delete out._deletedAtMs;

    // Mescla célula a célula de imóveis usando _imoveisTs
    out.imoveis = { ...(out.imoveis || {}) };
    out._imoveisTs = { ...(out._imoveisTs || {}) };
    const locIm = locQ.imoveis || {};
    const locImTs = locQ._imoveisTs || {};
    Object.keys(locIm).forEach((ik) => {
      const tL = toMs(locImTs[ik], locBase);
      const hasR = (ik in out.imoveis) || out._imoveisTs[ik] !== undefined;
      const tR = hasR ? toMs(out._imoveisTs[ik], remBase) : 0;
      const temL = boletimImovelTemDados(locIm[ik]);
      const temR = boletimImovelTemDados(out.imoveis[ik]);
      if (tL > tR || (tL === tR && temL && !temR)) {
        out.imoveis[ik] = locIm[ik];
        out._imoveisTs[ik] = tL;
      }
    });

    ['cabecalho', 'rodape', 'resumo'].forEach((sec) => {
      if (!locQ[sec]) return;
      if (!out[sec]) {
        out[sec] = cloneDeep(locQ[sec]);
        return;
      }
      const tL = toMs(locQ[`_${sec}Ts`], locBase);
      const tR = toMs(out[`_${sec}Ts`], remBase);
      if (tL > tR) {
        out[sec] = cloneDeep(locQ[sec]);
        out[`_${sec}Ts`] = tL;
      }
    });

    if (locQ.paginasExtra !== undefined) {
      const tL = toMs(locQ._paginasTs, locBase);
      const tR = toMs(out._paginasTs, remBase);
      if (tL > tR) {
        out.paginasExtra = locQ.paginasExtra;
        out._paginasTs = tL;
      }
    }

    out._ts = Math.max(locBase, remBase);
    return out;
  }

  function mergeAndamentoBucketPayload(localBucket, remoteBucket) {
    if (!remoteBucket || typeof remoteBucket !== 'object') return cloneDeep(localBucket);
    if (!localBucket || typeof localBucket !== 'object') return cloneDeep(remoteBucket);

    const out = cloneDeep(remoteBucket);
    out.porQuarteirao = { ...(out.porQuarteirao || {}) };
    const locPorQ = localBucket.porQuarteirao || {};
    Object.keys(locPorQ).forEach((qk) => {
      out.porQuarteirao[qk] = mergeQuarteiraoBoletim(locPorQ[qk], out.porQuarteirao[qk]);
    });
    out._ts = Math.max(toMs(localBucket._ts, 0), toMs(remoteBucket._ts, 0));
    return out;
  }

  global.PmcdSyncEngine = {
    SYNC_PROTOCOL_VERSION,
    BUCKET_COUNT,
    TOMBSTONE_RETENTION_MS,
    SYNC_QUEUE_STORAGE_KEY,
    DEVICE_EPOCH_STORAGE_KEY,
    LEGACY_ARCHIVE_STORAGE_KEY,
    cloneDeep,
    serverNowMs,
    monotonicNowMs,
    observeRemoteTs,
    toMs,
    isRecordDeleted,
    isPinnedTombstone,
    hasNonEmptyValue,
    boletimImovelTemDados,
    semanaDocId,
    bucketIndexForQuarteirao,
    andamentoBucketId,
    fnv1aHash,
    computeEstadoChecksum,
    readSyncQueue,
    writeSyncQueue,
    enqueueSyncOp,
    dequeueSyncOpIfUnchanged,
    listPendingSyncOps,
    clearPendingSyncOps,
    getDeviceEpoch,
    setDeviceEpoch,
    archiveLegacyStorageBeforeEpochReset,
    checkEpochCompatibility,
    mergeArrayByIdWithTombstones,
    mergeSemanaPayload,
    mergeConfigGeralPayload,
    mergeResumoReconhecimentoObj,
    mergeRelatoriosEResumoPayload,
    mergeAndamentoMetaPayload,
    mergeQuarteiraoBoletim,
    mergeAndamentoBucketPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
