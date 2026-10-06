# API do preparador de magias

Backend Node.js com PostgreSQL (Postgres.js) em produção e SQLite opcional em desenvolvimento. Implementa o contrato do modelo do banco. O catálogo inicial contém 391 magias, oito escolas, oito classes e 987 vínculos. Usuários e personagens são criados pela API.

## Iniciar

Requisito: **Node.js 24 ou superior**. Execute `npm ci` para instalar as dependências. Veja [DEPLOY.md](DEPLOY.md) para publicação no Render com Supabase.

Na pasta deste backend:

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

A API fica em `http://127.0.0.1:3001`. Verifique `GET /api/health`. Para desenvolvimento, use `npm run dev`; para os testes, `npm test`.

O primeiro início cria `data/magias.sqlite`, importa o catálogo e aplica a migração de sessões. Inícios seguintes preservam todos os registros. Não se executa o seed novamente. Caminhos de banco relativos são resolvidos a partir desta pasta, mesmo quando o comando é executado em outro diretório.

Para usar uma cópia do banco já entregue, coloque-a em `data/magias.sqlite` antes do primeiro início, ou configure `DATABASE_PATH` com seu caminho absoluto. O banco versão 1 recebe apenas a migração de sessões para a versão 2. Faça backup antes de apontar a API para um banco que já contenha seus personagens. O backend não modifica o arquivo original do catálogo fora de sua configuração.

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de rede |
| `DATABASE_URL` | vazio | URI PostgreSQL; obrigatória em produção |
| `DATABASE_SSL` | `require` | TLS no PostgreSQL; `disable` apenas para banco local |
| `DATABASE_POOL_MAX` | `5` | Máximo de conexões PostgreSQL |
| `DATABASE_PATH` | `data/magias.sqlite` | Banco local quando não há `DATABASE_URL` |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origens exatas do frontend, separadas por vírgula |
| `SESSION_TTL_HOURS` | `168` | Validade da sessão, em horas |

Para React em outra porta, acrescente a origem correspondente ao CORS. O deploy no Render usa HTTPS no proxy da plataforma. O limite de tentativas usa o endereço da conexão e não confia em `X-Forwarded-For`; com proxy, o limite é compartilhado pelo endereço do proxy até configurar esse comportamento explicitamente.

## Convenções

- JSON em UTF-8; requisições com corpo usam `Content-Type: application/json`.
- Respostas de sucesso: `{ "data": ... }`. Listas de magias também incluem `meta` com `total`, `limit` e `offset`.
- Respostas de erro: `{ "error": { "code": "...", "message": "..." } }`.
- Erros de validação retornam `400`; falta de sessão, `401`; edição proibida de conteúdo compartilhado, `403`; registro inexistente ou privado de outro usuário, `404`; conflito, `409`; magia inelegível para o personagem, `422`.
- Campos desconhecidos são rejeitados no corpo. IDs e nível usam números inteiros, não strings.
- Texto das magias não passa por trim nem reformatação: espaços, vírgulas e quebras de linha são preservados. Somente `search_name` é normalizado para busca.
- Rotas públicas: health, cadastro e login. Todas as outras exigem `Authorization: Bearer <token>`.
- Sem cookies: o frontend envia explicitamente o token. Senhas usam scrypt com salt individual; o banco guarda apenas o hash do token da sessão. Sessões duram sete dias por padrão, sobrevivem ao reinício e são revogadas no logout.
- Limite conjunto de 30 chamadas de cadastro/login por endereço a cada 15 minutos. É um limite em memória, reiniciado junto com o processo; não é distribuído entre várias instâncias.
- Corpos de até 256 KiB. Descrições de até 120 mil caracteres. A API não recebe upload de imagem; `imagePath` é uma referência `https://...` ou `/images/...`, opcional.

## Autenticação

```http
POST /api/auth/register
Content-Type: application/json

{"name":"João","email":"joao@example.com","password":"Uma-senha-longa-e-unica-1"}
```

Cadastro retorna `201`. Login usa `POST /api/auth/login` com `email` e `password` e retorna `200`. Ambos devolvem:

```json
{
  "data": {
    "user": { "id": 1, "name": "João", "email": "joao@example.com" },
    "token": "token-opaco-da-sessao",
    "tokenType": "Bearer",
    "expiresAt": "data-em-UTC"
  }
}
```

Senhas devem ter entre 8 e 256 caracteres, incluindo pelo menos uma letra maiúscula, uma letra minúscula e um número. `GET /api/auth/me` retorna a conta autenticada. `POST /api/auth/logout` revoga a sessão usada na requisição e retorna `204` sem corpo.

## Personagens

| Método e rota | Resultado |
| --- | --- |
| `GET /api/characters` | Personagens do usuário, com `preparedCount` |
| `POST /api/characters` | Cria personagem, retorna `201` |
| `GET /api/characters/:id` | Dados do personagem próprio |
| `PATCH /api/characters/:id` | Edita nome, nível e/ou classe |
| `DELETE /api/characters/:id` | Exclui personagem e preparações; retorna `204` |

Criação: `{ "name": "Meu clérigo", "classId": 2, "level": 3 }`. `level` é opcional, padrão 1; aceita 1 a 20. IDs de classe devem vir de `GET /api/classes`, sem assumir valores fixos.

Edição aceita `name`, `level`, `classId` e `clearPrepared`. Trocar a classe com magias preparadas retorna `409 PREPARED_SPELLS_EXIST`. A confirmação explícita é:

```json
{ "classId": 3, "clearPrepared": true }
```

A limpeza e a troca são uma transação. Alterar apenas nome/nível não remove preparações. `clearPrepared` sozinho não é uma operação válida.

## Catálogo e cards

`GET /api/spells?name=&schoolId=&classId=&characterId=&limit=&offset=`

Todos os filtros são opcionais e combináveis. `name` busca um trecho, ignorando acentos e maiúsculas. `%` e `_` são tratados como caracteres literais. `schoolId` filtra a escola; `classId`, os vínculos acessíveis da classe. `limit` tem padrão 100 e máximo 500; `offset` começa em zero.

Com `characterId`, cada resultado também inclui `canPrepare` e `isPrepared`, calculados para o personagem autenticado. A classe selecionada como filtro não altera a elegibilidade do personagem.

A listagem retorna:

```json
{
  "data": [{
    "id": 2,
    "name": "Acudir os Moribundos",
    "level": 0,
    "schoolId": 2,
    "school": "Necromancia",
    "sourceId": 1,
    "source": "5.5-Livro de magias",
    "sourceKind": "book",
    "ownerUserId": null
  }],
  "meta": { "total": 391, "limit": 100, "offset": 0 }
}
```

`GET /api/spells/:id` fornece os campos acima mais `components`, `castingTime`, `range`, `duration`, `description`, `imagePath`, `sourcePage`, `createdAt`, `updatedAt` e `classes` (array com `id`, `name` e `sourceId`). Esse é o conteúdo do card. Dados JSON de auditoria da importação não são expostos.

## Adicionar e editar homebrews

`POST /api/spells` cria uma magia **sempre como homebrew do usuário autenticado**. O servidor escolhe a coleção homebrew, criando-a quando necessário. Não recebe `ownerUserId`, `sourceId` ou `kind` do cliente.

```json
{
  "name": "Chama Azul",
  "level": 1,
  "schoolId": 6,
  "components": "V, S",
  "castingTime": "Ação",
  "range": "18 metros",
  "duration": "Instantânea",
  "description": "Texto completo, com a redação desejada.",
  "imagePath": null,
  "classIds": [1, 5]
}
```

Os IDs do exemplo são ilustrativos: consulte as escolas e classes. `classIds` e `imagePath` são opcionais; os demais campos são obrigatórios. `level` aceita 0 a 9. A magia e todos os vínculos são criados juntos na mesma transação; todas as classes precisam estar acessíveis ao usuário.

`PATCH /api/spells/:id` aceita qualquer subconjunto dos campos de conteúdo acima, exceto `classIds`. Somente uma magia homebrew do próprio usuário pode ser editada. Para adicionar classes a uma magia existente, use a rota de vínculos abaixo.

## Escolas, origens e classes

| Método e rota | Uso |
| --- | --- |
| `GET /api/schools` | Oito escolas existentes |
| `GET /api/sources` | Origens compartilhadas e do próprio usuário |
| `POST /api/sources` | Cria origem privada |
| `GET /api/classes` | Classes compartilhadas e do próprio usuário |
| `POST /api/classes` | Cria classe em origem própria |
| `POST /api/classes/:id/spells` | Acrescenta magia existente à lista da classe |

Origem: `{ "name": "Meu compêndio", "kind": "compendium", "reference": "Referência opcional" }`. `kind` pode ser `compendium` ou `homebrew`; a autoria sempre vem da sessão. Uma origem criada pela API é privada. Importações compartilhadas ficam fora destas rotas de usuário.

Classe: `{ "name": "Tecnomante", "sourceId": 2 }`. Omitir `sourceId` usa a coleção homebrew do usuário. Uma origem compartilhada não pode ser usada para gravar novos registros pelas rotas de usuário.

Vínculo: `{ "spellId": 2, "sourceId": 2 }`. Omitir `sourceId` usa a coleção homebrew do usuário. A classe e a magia podem ser do livro, de um compêndio acessível ou do usuário; a origem do novo vínculo precisa ser do próprio usuário. Repetir o mesmo vínculo retorna o existente (`200`); criar retorna `201`.

Uma extensão homebrew de magia do livro é visível somente ao dono da extensão. O texto e a origem da magia do livro permanecem intactos.

## Preparar magias

| Método e rota | Uso |
| --- | --- |
| `GET /api/characters/:id/prepared-spells` | Lista as preparadas com conteúdo completo e `preparedAt` |
| `PUT /api/characters/:id/prepared-spells/:spellId` | Prepara, com corpo vazio ou `{}` |
| `DELETE /api/characters/:id/prepared-spells/:spellId` | Desprepara e retorna `204` |

`PUT` é idempotente: repetir a preparação não duplica a magia. O backend resolve um vínculo acessível com a classe do personagem e os triggers validam a operação novamente. `DELETE` também é idempotente.

As seleções são independentes por personagem. Não há regras automáticas de limite de magias preparadas, espaços de magia ou elegibilidade por nível nesta versão, como definido no modelo inicial.

## Organização e testes

- `src/server.js`: configuração, inicialização e encerramento do servidor.
- `src/app.js`: rotas, autorização, respostas HTTP e CORS.
- `src/database.js`: abertura do SQLite, migrações e transações.
- `src/auth.js`: senhas e sessões.
- `src/validation.js`: validação de entrada e erros.
- `database/`: schema inicial, carga e migração das sessões.
- `test/api.test.js`: testes reais via HTTP em bancos isolados, além de persistência em arquivos temporários.
- `requests.http`: exemplos de chamadas para clientes HTTP compatíveis.

Os testes cobrem cadastro/login/logout, expiração, isolamento entre usuários, preservação de texto, filtros, criação/edição homebrew, extensão de listas de classes, conflitos, preparação idempotente, troca de classe, exclusão, CORS, limites e migrações. Nenhum teste grava no banco de trabalho.

Referências usadas: [SQLite nativo no Node.js](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [scrypt e comparação de hashes](https://nodejs.org/api/crypto.html), [chaves estrangeiras no SQLite](https://www.sqlite.org/foreignkeys.html).
