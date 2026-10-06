Validado em Node.js v24.15.0.

- 12 testes passaram, zero falhas, via `node --test test/api.test.js`.
- Testes HTTP reais com bancos isolados: autenticação, autorização, filtros, homebrews, preparação, migrações, persistência, CORS, limites e validação.
- 391 magias comparadas com o SQLite original: nomes, níveis, componentes, tempo de conjuração, alcance, duração e descrições idênticos.
- Servidor iniciado e `GET /api/health` respondeu 200 com banco versão 2.
- Nenhuma conta fictícia foi criada no banco de trabalho.
