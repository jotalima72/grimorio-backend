# Backend — Render + Supabase

Este diretório é um projeto independente. O frontend tem seu próprio repositório. Use Node 24 (versão em `.node-version`).

## 1. Supabase

Crie um projeto e, no painel **Connect**, copie a URI de **Session pooler**, porta **5432**. Essa conexão atende ao processo Node persistente no Render e funciona com IPv4. Postgres.js é o driver; PostgreSQL é o banco.

Substitua a senha na URI. Se houver caracteres especiais, codifique somente a senha com percent-encoding. Guarde a URI em `DATABASE_URL` no Render, nunca no Git ou no frontend. Não é necessária uma chave `anon` ou `service_role`.

A aplicação cria um schema privado `grimorio`, migrações, tabelas, índices, triggers e o catálogo original com 391 magias e 987 vínculos de classes. Não adicione `grimorio` aos schemas expostos da Data API do Supabase: todo acesso ocorre pela API autenticada do backend.

A primeira inicialização aplica as migrações em uma transação. As próximas conferem versão e checksum, sem duplicar o catálogo. Não edite uma migração já aplicada. Esta preparação cria um banco novo; contas, personagens e homebrews do SQLite local **não são transferidos automaticamente**.

## 2. Git

Crie um repositório vazio para o backend. Dentro desta pasta:

```powershell
git add .
git commit -m "Prepara API para Render e PostgreSQL"
git remote add origin https://github.com/SEU-USUARIO/SEU-REPO-BACKEND.git
git push -u origin main
```

O repositório local já foi inicializado. `.env`, bancos locais e `node_modules` são ignorados. Inclua `package-lock.json`.

## 3. Render

Use **New > Blueprint** e selecione o repositório: `render.yaml` configura um Web Service gratuito. Alternativamente, crie um Web Service Node manualmente:

| Configuração | Valor |
| --- | --- |
| Root Directory | vazio (repositório só do backend) |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Plan | Free |

Variáveis:

| Variável | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DATABASE_URL` | URI secreta do Session pooler do Supabase |
| `DATABASE_SSL` | `require` |
| `DATABASE_POOL_MAX` | `5` |
| `CORS_ORIGINS` | `https://SEU-FRONTEND.vercel.app` |
| `SESSION_TTL_HOURS` | `168` |

O Render fornece `PORT` automaticamente. `CORS_ORIGINS` aceita origens exatas, sem barra final, separadas por vírgula. Para domínio próprio ou um preview autorizado da Vercel, acrescente a origem exata. Não use `*`.

Depois do deploy, abra `https://SEU-BACKEND.onrender.com/api/health`. Configure `VITE_API_BASE=https://SEU-BACKEND.onrender.com/api` na Vercel.

## Desenvolvimento e verificação

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Sem `DATABASE_URL`, o modo desenvolvimento continua usando SQLite. Com a variável, usa PostgreSQL. Produção exige PostgreSQL e CORS explícito. Para PostgreSQL local sem TLS, use `DATABASE_SSL=disable`; no Supabase, mantenha `require`.

`npm run db:migrate` aplica/verifica as migrações separadamente. `npm test` executa o contrato HTTP em SQLite e PostgreSQL embarcado (PGlite), além de verificar migração repetível, rollback e igualdade de todo o texto do catálogo. Esses testes não acessam o Supabase. `npm run check` verifica a sintaxe.

O Render gratuito suspende o serviço após 15 minutos sem tráfego. A primeira requisição pode demorar enquanto o serviço reinicia; o frontend aguarda até 90 segundos. Os dados permanecem no Supabase, independentemente do disco efêmero do Render.

Referências: [conexão Postgres.js no Supabase](https://supabase.com/docs/guides/database/postgres-js), [limitações do Render gratuito](https://render.com/docs/free).
