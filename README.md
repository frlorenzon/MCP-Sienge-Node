# MCP Sienge Node

Servidor [MCP](https://modelcontextprotocol.io) para a API do
[Sienge](https://www.sienge.com.br) — expõe consultas e operações do ERP como
ferramentas que um assistente de IA pode chamar.

JavaScript puro (ESM), sem etapa de build. `node src/index.js` e pronto.

## Estado

**Módulo `nucleo` implementado** — 10 das 131 tools do catálogo, com toda a
infraestrutura compartilhada pronta.

| Módulo | Tools | Estado |
|---|---|---|
| `nucleo` | 10 | ✅ implementado |
| `cadastros` | 24 | esqueleto gerado |
| `compras` + `compras_api` | 44 | pendente |
| `titulos`, `financeiro`, `contratos`, `cotacoes` | 54 | pendente |

## O que já funciona

- **Autenticação** Bearer Token ou Basic Auth, resolvida por chamada
- **Retry consciente de idempotência** — um timeout em `POST` nunca vira nota
  fiscal duplicada; ver [notas técnicas](docs/notas-tecnicas.md)
- **Cotas diárias REST e BULK** contadas localmente, com diagnóstico que
  distingue excesso momentâneo de cota esgotada
- **Erros do Sienge traduzidos em ação** — cada mensagem conhecida vira uma
  sugestão concreta do que fazer em seguida
- **Trilha de auditoria** de toda operação de escrita, em arquivo separado que
  nunca é truncado
- **Gate de confirmação** para operações de alto impacto: a primeira chamada
  devolve uma prévia, e só executa com `confirm: true`
- **Catálogo por módulo** — carregar as 131 tools de uma vez custa ~22.500
  tokens de contexto em toda requisição; `SIENGE_PROFILE` e
  `enable_sienge_modules` recortam isso
- **Licenciamento Ed25519 offline**, com `node:crypto`, sem dependência externa

## Uso

```bash
npm install
cp .env.example .env   # preencha as credenciais
npm start
```

Registro no cliente MCP: ver `.mcp.json`.

### Configuração essencial

| Variável | Para quê |
|---|---|
| `SIENGE_API_KEY` **ou** `SIENGE_USERNAME`+`SIENGE_PASSWORD` | autenticação |
| `SIENGE_SUBDOMAIN` | subdomínio da empresa, compõe a URL de toda chamada |
| `SIENGE_PROFILE` | recorte do catálogo: vazio/`all`, `minimo`, ou `compras,financeiro` |
| `SIENGE_MCP_API_PACKAGE` | pacote contratado, para calcular o saldo diário |

Lista completa em `.env.example`.

## Verificação

Nenhum dos dois comandos toca a API — rodam offline e não consomem cota.

```bash
npm run check
```

Sobe o servidor em memória, pede `tools/list` e confere contra
`contract/catalogo-tools.json`: nome, descrição, tipo, obrigatoriedade, default
e descrição de cada parâmetro. Pega o defeito que não quebra teste nenhum e
muda todas as chamadas — um default trocado, uma descrição perdida.

`npm run check -- --pendentes` lista o que falta implementar, por módulo.

```bash
npm test
```

Comportamento, com `fetch` dublado: política de retry, tradução de erro,
diagnóstico de 429, recorte por módulos, licenciamento e tools de descoberta.

## Implementando um módulo

O catálogo já especifica schema e descrição de todas as tools, então o
esqueleto sai pronto:

```bash
node scripts/generate-schemas.js cadastros --out src/tools/cadastros.js
```

Gera as 24 tools de `cadastros` com os schemas Zod completos, defaults e
descrições — restam os handlers, marcados com `TODO`. Depois de escrevê-los,
`npm run check` confirma que a interface não divergiu da especificação.

`node scripts/generate-schemas.js --list` mostra os módulos disponíveis.

## Estrutura

```
src/
├── index.js            bootstrap stdio + perfil estático
├── config.js           credenciais e resolução de auth
├── registry.js         registro de tools: licença, auditoria, tags, envelope MCP
├── modules.js          catálogo dos 8 módulos e as 131 tools
├── confirmation.js     gate de confirmação para operações de alto impacto
├── licensing.js        validação Ed25519 offline
├── http/
│   ├── client.js       núcleo HTTP: retry, backoff, 429, auditoria
│   ├── errors.js       catálogo de erros conhecidos do Sienge
│   ├── cache.js        TTL em memória
│   └── paginate.js     varredura limit/offset
├── utils/
│   ├── paths.js        ~/.sienge-mcp
│   ├── logger.js       diagnóstico (nunca em stdout)
│   ├── audit.js        trilha de escritas (AsyncLocalStorage)
│   └── apiQuota.js     cotas REST/BULK diárias
├── api/
│   ├── _restHelpers.js padrões de listagem e cache
│   └── entities.js     as 5 consultas de que o núcleo depende
├── workflows/
│   └── discovery.js    busca, catálogo e paginação
├── knowledge/          processo de compras (conhecimento, não API)
└── tools/
    ├── nucleo.js       as 10 tools sempre visíveis
    └── cadastros.js    esqueleto, ainda não registrado
```

## Licença

[PolyForm Noncommercial 1.0.0](LICENSE) — uso livre para fins não comerciais.
Para uso comercial, contate o autor.
