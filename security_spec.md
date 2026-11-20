# Especificação de Segurança Firestore — PMCD Sistema Unificado (Sync v2)

## 1. Invariantes de Dados
1. Nenhum documento em `/equipes/{equipeId}/modulos/{moduloId}`, `/dominios/{dominioId}`, `/semanas/{semanaId}`, `/andamentos/{andamentoId}` ou `/meta/{metaId}` pode ser criado ou atualizado sem que `/equipes/{equipeId}` exista e sem que o usuário seja administrador (`isAdmin()`) ou membro ativo em `/equipes/{equipeId}/membros/{uid}`.
2. Somente contas Google com `request.auth.token.email_verified == true` podem autenticar solicitações de leitura ou escrita no Firestore.
3. Um usuário comum NÃO pode se auto-promover a `admin` ao criar seu próprio perfil em `/users/{userId}/private/profile` nem ao aceitar um convite em `/equipes/{equipeId}/membros/{memberUid}`.
4. Somente administradores (`isAdmin()`) podem criar ou atualizar `/equipes/{equipeId}/meta/{metaId}` (controle de `minClientVersion`, `baselineEpoch` e registro `migracao_v2`).
5. Dados pessoais (PII: `email`, `displayName`) ficam isolados em `/users/{userId}/private/profile`, acessíveis somente ao próprio dono (`isOwner(userId)`) ou a administradores (`isAdmin()`).
6. **Controle de Concorrência Otimista (OCC):** Todas as atualizações em `/dominios/*`, `/semanas/*`, `/andamentos/*`, `/meta/*` e atualizações de membros em `/modulos/*` devem incrementar estritamente `versao` em exato `+1` (`incoming().versao == existing().versao + 1`), impedindo sobrescritas cegas por clientes desatualizados.
7. Todos os campos de carimbo temporal (`createdAt`, `updatedAt`) devem coincidir exatamente com `request.time`; `createdAt`, `uid`, `equipeId`, `moduloId`, `dominioId`, `semanaId`, `andamentoId`, `metaId` e `ownerId` são imutáveis após a criação.
8. Todas as variáveis de caminho (`userId`, `equipeId`, `memberUid`, `conviteId`, `moduloId`, `dominioId`, `semanaId`, `andamentoId`, `metaId`) passam por `isValidId()`. Nenhuma subcoleção de dados expõe `allow list` com `get()`/`exists()`.
9. Todos os campos de texto possuem validação obrigatória de tamanho (`.size() <= MAX`) e nenhum campo fantasma (shadow field) é aceito devido ao bloqueio `hasAll` + `hasOnly` na criação e `affectedKeys().hasOnly(...)` na atualização.

## 2. Payloads "Dirty Dozen" (Devem Retornar PERMISSION_DENIED)
1. **Escalonamento de Privilégio no Perfil**: Usuário comum cria `/users/{uid}/private/profile` com `role: "admin"`.
2. **Escrita com Ghost Field (Shadow Update)**: Membro atualiza `/equipes/pmcd_principal/dominios/config_geral` incluindo `{ payload: {}, isAdmin: true }`.
3. **Spoofing de Email Não Verificado**: Token com `email: "ricardosoares2607@gmail.com"` e `email_verified: false` tenta ler/escrever dados.
4. **Leitura de PII de Terceiro**: Usuário B tenta dar `get` em `/users/{userA}/private/profile`.
5. **Identity Spoofing em Domínio/Semana**: Membro envia `atualizadoPorUid: "outro_uid"` diferente de `request.auth.uid`.
6. **Imutabilidade Violada (`createdAt`)**: Atualização tenta alterar `createdAt` para um timestamp diferente do original.
7. **Timestamp Falsificado do Cliente**: Criação envia `createdAt` com data passada/futura diferente de `request.time`.
8. **Modulo/Domínio/Andamento Inválido**: Escrita em `/equipes/pmcd_principal/dominios/dominio_falso` ou `/andamentos/bucket_99` fora da allowlist.
9. **Envenenamento de ID (ID Poisoning)**: Documento criado com ID contendo caracteres inválidos ou string > 128 bytes.
10. **Payload Gigante / Exaustão de String**: Atualização envia `displayName` com 300 caracteres (> 120) ou `equipeId` inválido.
11. **Bypass de OCC (Versão Repetida ou Pulada)**: Membro (ou admin em doc v2) tenta atualizar `/equipes/pmcd_principal/semanas/ciclo_2026_45` mantendo `versao == existing().versao` ou pulando para `+5`.
12. **Alteração Não Autorizada de Época/Protocolo**: Membro não-admin tenta criar ou alterar `/equipes/pmcd_principal/meta/sync_config` para reduzir `minClientVersion` ou mudar `baselineEpoch`.
