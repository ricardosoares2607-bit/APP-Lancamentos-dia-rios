# Especificação de Segurança Firestore — PMCD Sistema Unificado

## 1. Invariantes de Dados
1. Nenhum documento em `/equipes/{equipeId}/modulos/{moduloId}` pode ser criado ou atualizado sem que `/equipes/{equipeId}` exista e sem que o usuário seja administrador ou membro ativo em `/equipes/{equipeId}/membros/{uid}`.
2. Somente contas Google com `request.auth.token.email_verified == true` podem autenticar solicitações de leitura ou escrita no Firestore.
3. Um usuário comum NÃO pode se auto-promover a `admin` ao criar seu próprio perfil em `/users/{userId}/private/profile` nem ao aceitar um convite em `/equipes/{equipeId}/membros/{memberUid}`.
4. Dados pessoais (PII: `email`, `displayName`) ficam isolados em `/users/{userId}/private/profile`, acessíveis somente ao próprio dono (`isOwner(userId)`) ou a administradores (`isAdmin()`).
5. Todos os campos de carimbo temporal (`createdAt`, `updatedAt`) devem coincidir exatamente com `request.time`; `createdAt`, `uid`, `equipeId`, `moduloId` e `ownerId` são imutáveis após a criação.
6. Todas as variáveis de caminho (`userId`, `equipeId`, `memberUid`, `conviteId`, `moduloId`) passam por `isValidId()`.
7. Todos os campos de texto possuem validação obrigatória de tamanho (`.size() <= MAX`) e nenhum campo fantasma (shadow field) é aceito devido ao bloqueio `hasAll` + `hasOnly` na criação e `affectedKeys().hasOnly(...)` na atualização.

## 2. Payloads "Dirty Dozen" (Devem Retornar PERMISSION_DENIED)
1. **Escalonamento de Privilégio no Perfil**: Usuário comum cria `/users/{uid}/private/profile` com `role: "admin"`.
2. **Escrita com Ghost Field (Shadow Update)**: Membro atualiza `/equipes/pmcd_principal/modulos/pmcd_principal` incluindo `{ payload: {}, isAdmin: true }`.
3. **Spoofing de Email Não Verificado**: Token com `email: "ricardosoares2607@gmail.com"` e `email_verified: false` tenta ler/escrever dados.
4. **Leitura de PII de Terceiro**: Usuário B tenta dar `get` em `/users/{userA}/private/profile`.
5. **Identity Spoofing em Módulo**: Membro envia `atualizadoPorUid: "outro_uid"` diferente de `request.auth.uid`.
6. **Imutabilidade Violada (`createdAt`)**: Atualização tenta alterar `createdAt` para um timestamp diferente do original.
7. **Timestamp Falsificado do Cliente**: Criação envia `createdAt` com data passada/futura diferente de `request.time`.
8. **Modulo Inválido**: Escrita em `/equipes/pmcd_principal/modulos/modulo_inexistente` com `moduloId` fora da allowlist.
9. **Envenenamento de ID (ID Poisoning)**: Documento criado com ID contendo `/` ou espaços ou string > 128 bytes.
10. **Payload Gigante / Exaustão de String**: Atualização envia `displayName` com 500 caracteres (> 120) ou `nome` da equipe > 120 chars.
11. **Auto-Convite / Forjamento de Membro**: Usuário não convidado e não-admin tenta criar `/equipes/pmcd_principal/membros/{uid}`.
12. **Listagem Não Autorizada**: Usuário não-admin tenta executar `list` em `/equipes/pmcd_principal/membros` ou `/users`.
