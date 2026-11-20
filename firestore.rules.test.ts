// Phase 0 Security Test Specification for PMCD Firestore Rules (Sync v2)
// Verifies that all Dirty Dozen adversarial payloads are rejected with PERMISSION_DENIED.

export const DIRTY_DOZEN_CASES = [
  {
    id: 1,
    name: 'Privilege escalation on own private profile creation',
    path: 'users/user_b/private/profile',
    auth: { uid: 'user_b', email: 'agente@gmail.com', email_verified: true },
    op: 'create',
    payload: { uid: 'user_b', email: 'agente@gmail.com', displayName: 'Agente', role: 'admin', createdAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 2,
    name: 'Shadow update with ghost field on dominio document',
    path: 'equipes/pmcd_principal/dominios/config_geral',
    auth: { uid: 'member_1', email: 'agente@gmail.com', email_verified: true },
    op: 'update',
    payload: { payload: {}, versao: 2, syncProtocolVersion: 2, baselineEpoch: 1, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'member_1', isAdmin: true, updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 3,
    name: 'Email spoofing with email_verified = false',
    path: 'equipes/pmcd_principal/dominios/config_geral',
    auth: { uid: 'attacker', email: 'ricardosoares2607@gmail.com', email_verified: false },
    op: 'get',
    payload: null,
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 4,
    name: 'PII blanket read attempt against another user private profile',
    path: 'users/user_a/private/profile',
    auth: { uid: 'user_b', email: 'agente@gmail.com', email_verified: true },
    op: 'get',
    payload: null,
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 5,
    name: 'Identity spoofing via atualizadoPorUid mismatch in semana document',
    path: 'equipes/pmcd_principal/semanas/ciclo_2026_45',
    auth: { uid: 'member_1', email: 'agente@gmail.com', email_verified: true },
    op: 'update',
    payload: { payload: {}, versao: 2, syncProtocolVersion: 2, baselineEpoch: 1, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'admin_uid', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 6,
    name: 'Immutability violation attempting to alter createdAt',
    path: 'equipes/pmcd_principal/modulos/pmcd_principal',
    auth: { uid: 'member_1', email: 'agente@gmail.com', email_verified: true },
    op: 'update',
    payload: { createdAt: 'CLIENT_FAKE_TIME', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 7,
    name: 'Forged client timestamp instead of request.time on create',
    path: 'users/user_b/private/profile',
    auth: { uid: 'user_b', email: 'agente@gmail.com', email_verified: true },
    op: 'create',
    payload: { uid: 'user_b', email: 'agente@gmail.com', displayName: 'Agente', role: 'editor', createdAt: 1600000000000, updatedAt: 1600000000000 },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 8,
    name: 'Arbitrary andamentoId outside enum allowlist',
    path: 'equipes/pmcd_principal/andamentos/andamento_falso',
    auth: { uid: 'ricardo_uid', email: 'ricardosoares2607@gmail.com', email_verified: true },
    op: 'create',
    payload: { equipeId: 'pmcd_principal', andamentoId: 'andamento_falso', payload: {}, versao: 1, syncProtocolVersion: 2, baselineEpoch: 1, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'ricardo_uid', createdAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 9,
    name: 'ID poisoning with invalid length > 128 on semana',
    path: `equipes/pmcd_principal/semanas/${'a'.repeat(140)}`,
    auth: { uid: 'ricardo_uid', email: 'ricardosoares2607@gmail.com', email_verified: true },
    op: 'create',
    payload: { equipeId: 'pmcd_principal', semanaId: 'a'.repeat(140), payload: {}, versao: 1, syncProtocolVersion: 2, baselineEpoch: 1, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'ricardo_uid', createdAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 10,
    name: 'String size exhaustion > 120 chars on displayName',
    path: 'users/user_b/private/profile',
    auth: { uid: 'user_b', email: 'agente@gmail.com', email_verified: true },
    op: 'create',
    payload: { uid: 'user_b', email: 'agente@gmail.com', displayName: 'X'.repeat(300), role: 'editor', createdAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 11,
    name: 'OCC violation: stale or non-sequential versao increment on semana update',
    path: 'equipes/pmcd_principal/semanas/ciclo_2026_45',
    auth: { uid: 'member_1', email: 'agente@gmail.com', email_verified: true },
    op: 'update',
    existing: { versao: 5 },
    payload: { payload: {}, versao: 5, syncProtocolVersion: 2, baselineEpoch: 1, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'member_1', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 12,
    name: 'Non-admin attempting to alter sync_config minClientVersion or baselineEpoch',
    path: 'equipes/pmcd_principal/meta/sync_config',
    auth: { uid: 'member_1', email: 'agente@gmail.com', email_verified: true },
    op: 'update',
    payload: { minClientVersion: 1, baselineEpoch: 99, versao: 2, atualizadoEmMs: 1700000000000, atualizadoPorUid: 'member_1', updatedAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED'
  }
];
