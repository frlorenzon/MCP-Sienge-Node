# MCP Sienge Node

Servidor [MCP](https://modelcontextprotocol.io) para a API do
[Sienge](https://www.sienge.com.br) — expõe consultas e operações do ERP como
ferramentas que um assistente de IA pode chamar.

JavaScript puro (ESM), sem etapa de build.

```bash
npx -y mcp-sienge-node
```

## Instalação no Claude Desktop

Edite o arquivo de configuração:

| Sistema | Caminho |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "sienge": {
      "command": "npx",
      "args": ["-y", "mcp-sienge-node"],
      "env": {
        "SIENGE_USERNAME": "seu-usuario",
        "SIENGE_PASSWORD": "sua-senha",
        "SIENGE_SUBDOMAIN": "sua-empresa",
        "SIENGE_MCP_API_PACKAGE": "start"
      }
    }
  }
}
```

**Reinicie o Claude Desktop depois de salvar** — ele lê esse arquivo só na
inicialização, e fechar a janela não encerra o processo. Use Cmd+Q (macOS) ou
saia pela bandeja (Windows).

Se preferir Bearer Token no lugar de usuário e senha, troque as duas primeiras
variáveis por `"SIENGE_API_KEY": "sua-chave"`. `SIENGE_SUBDOMAIN` é sempre
necessário: ele compõe a URL de toda chamada.

<details>
<summary>Configuração completa, com todas as variáveis</summary>

```json
{
  "mcpServers": {
    "sienge": {
      "command": "npx",
      "args": ["-y", "mcp-sienge-node"],
      "env": {
        "SIENGE_API_KEY": "sua-chave",
        "SIENGE_SUBDOMAIN": "sua-empresa",
        "SIENGE_PROFILE": "compras",
        "SIENGE_MCP_API_PACKAGE": "start",
        "SIENGE_MCP_LICENSE_KEY": "sua-licenca",
        "SIENGE_MCP_LOG_LEVEL": "INFO",
        "REQUEST_TIMEOUT": "30"
      }
    }
  }
}
```

</details>

Outros clientes MCP (Claude Code, Cursor, Zed) usam o mesmo formato de
`command`/`args`/`env`, em arquivo próprio.

### Verificando que funcionou

Depois de reiniciar, peça ao assistente: *"testa a conexão com o Sienge"*. Ele
deve chamar `test_sienge_connection` e responder com a latência. Se a
autenticação estiver incompleta, `get_auth_info` diz o que falta sem gastar
chamada na API.

## Configuração

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SIENGE_SUBDOMAIN` | ✅ | subdomínio da empresa; compõe a URL de toda chamada |
| `SIENGE_API_KEY` | uma das duas | Bearer Token |
| `SIENGE_USERNAME` + `SIENGE_PASSWORD` | uma das duas | Basic Auth |
| `SIENGE_PROFILE` | — | recorte inicial. **Vazio = só o núcleo** (padrão); `all` carrega tudo; ou fixe: `compras,financeiro` |
| `SIENGE_MCP_API_PACKAGE` | — | pacote contratado, para calcular o saldo diário de cota |
| `SIENGE_MCP_LICENSE_KEY` | — | licença; sem ela o servidor funciona e avisa uma vez por sessão |

Lista completa, incluindo caminhos de log e auditoria, em
[`.env.example`](.env.example).

## Como o catálogo é carregado

O servidor sobe com **8 tools e ~1.300 tokens** de contexto. As demais entram
sob demanda:

```
subida             8 tools   ~1.300 tokens
carregar_compras   9 tools   ~1.700 tokens
```

Isso importa porque o catálogo é reenviado a cada mensagem. Carregar as 105
tools de uma vez custaria ~19.000 tokens em toda requisição, mesmo numa
conversa que toca um assunto só.

Para uma operação que sempre usa os mesmos módulos, `SIENGE_PROFILE=compras`
deixa o recorte pronto na subida, sem depender do carregamento dinâmico.

## Estado

**Núcleo e a primeira tool de compras implementados** — 9 das 105 tools do
catálogo, com toda a infraestrutura compartilhada pronta.

| Módulo | Tools | Estado |
|---|---|---|
| `nucleo` | 8 | ✅ implementado |
| `compras` | 1 de 10 | 🔨 em andamento |
| `compras_api` | 33 | coberto por `sienge_api_call` |
| `titulos`, `financeiro`, `contratos`, `cotacoes` | 54 | pendente |

### As tools de hoje

| Tool | O que faz |
|---|---|
| `test_sienge_connection` | testa a credencial contra a API |
| `get_auth_info` | qual mecanismo está configurado, sem chamar a API |
| `get_sienge_api_quota` | consumo e saldo das cotas REST e BULK do dia |
| `describe_purchase_process` | o processo de compras de ponta a ponta |
| `carregar_compras` | traz as ferramentas de compras |
| `descarregar_modulos` | libera o contexto de módulos já carregados |
| `sienge_api_endpoints` | quais endpoints existem, por recurso |
| `sienge_api_call` | chama um endpoint direto (só leitura, exige `deep_mode`) |
| `compras_pedidos_para_aprovar` | a fila de aprovação resolvida numa chamada |

## Modo profundo

A API do Sienge tem centenas de endpoints. Criar uma tool para cada um
custaria dezenas de milhares de tokens de contexto **em toda mensagem** — e a
maioria nunca seria usada. As tools de negócio cobrem o dia a dia; o modo
profundo cobre o resto, com duas ferramentas em vez de um catálogo.

### Como funciona

**1. Descobrir o endpoint.** `sienge_api_endpoints` responde em dois níveis,
para que o modelo pague só pelo que consultar:

```
sienge_api_endpoints()
→ recursos: bills, cost-centers, creditors, customers, customer-types,
            enterprises, payment-categories, purchase-orders, units

sienge_api_endpoints({ recurso: "purchase-orders" })
→ GET /purchase-orders
  GET /purchase-orders/{id}/items
  GET /purchase-orders/{id}/attachments
  … +12
```

Recursos com armadilha trazem uma `nota`. Consultar `customers`, por exemplo,
avisa antes de você errar:

> Não há busca por nome: a API filtra apenas por cpf, cnpj e datas. Para achar
> um cliente pelo nome, pagine ou use o documento.

**2. Chamar.** `sienge_api_call` executa:

```json
{
  "path": "/purchase-orders/12345/attachments",
  "params": { "limit": 50 },
  "deep_mode": true
}
```

Se o path estiver errado, o 404 já vem com os endpoints conhecidos daquele
recurso — o modelo erra uma vez e acerta na seguinte, sem precisar consultar
antes.

### Os parâmetros

| Parâmetro | | O que faz |
|---|---|---|
| `path` | obrigatório | endpoint relativo, começando com barra: `/creditors/45` |
| `deep_mode` | **obrigatório, sempre `true`** | ver abaixo |
| `params` | opcional | query string, incluindo `limit`/`offset` |
| `bulk` | opcional | usa a API bulk-data em vez da v1 |

### Por que `deep_mode` é obrigatório

Não é burocracia. Sem ele, esta tool seria o caminho de menor resistência: o
modelo a usaria para tudo, e as tools de negócio — que existem justamente
porque resolvem o join no servidor e custam **dezenas de vezes menos chamadas**
— deixariam de ser chamadas.

Exigir `deep_mode: true` força uma declaração explícita de que se está saindo
da camada de intenção de propósito. A validação acontece no schema, antes do
handler: uma chamada sem o parâmetro é recusada pelo protocolo.

Na prática, isso significa que o assistente precisa "decidir" descer ao nível
cru, em vez de escorregar para lá.

### Duas restrições

**Só leitura.** Aceita apenas GET — não há parâmetro de método nem de corpo.
Escrever no ERP por uma tool genérica contornaria o gate de confirmação e a
validação das tools específicas: um POST montado a partir de um path adivinhado
poderia criar título, nota ou pagamento sem ninguém ter conferido nada.
Operações de escrita são sempre tools próprias, com prévia e confirmação.

**Path validado.** Formato fechado, e segmentos `..` são recusados — a URL é
montada por concatenação e seria normalizada pelo `fetch`, então `/../..`
escaparia do prefixo da API e alcançaria outra rota do mesmo host.

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
- **Modo profundo** — `sienge_api_call` alcança 59 endpoints da API por ~535
  tokens, no lugar dos milhares que uma tool por endpoint custaria
- **Licenciamento Ed25519 offline**, com `node:crypto`, sem dependência externa

## Desenvolvimento

```bash
git clone https://github.com/frlorenzon/MCP-Sienge-Node.git
cd MCP-Sienge-Node
npm install
cp .env.example .env   # preencha as credenciais
npm start
```

### Verificação

Nenhum dos comandos toca a API — rodam offline e não consomem cota.

```bash
npm test
```

Comportamento, com `fetch` dublado: política de retry, tradução de erro,
diagnóstico de 429, carregamento de módulos, licenciamento, serialização e a
travessia da fila de aprovação. Sobe o servidor como subprocesso para testar o
handshake real.

```bash
npm run check
```

Confere as tools implementadas contra `contract/catalogo-tools.json`: nome,
descrição, tipo, obrigatoriedade, default e descrição de cada parâmetro. Pega o
defeito que não quebra teste nenhum e muda todas as chamadas — um default
trocado, uma descrição perdida.

`npm run check -- --pendentes` lista o que falta implementar, por módulo.

### Estrutura

```
src/
├── index.js            bootstrap stdio + perfil estático
├── config.js           credenciais e resolução de auth
├── registry.js         registro de tools: licença, auditoria, tags, envelope MCP
├── modules.js          catálogo dos 7 módulos e as 105 tools
├── confirmation.js     gate de confirmação para operações de alto impacto
├── licensing.js        validação Ed25519 offline
├── http/
│   ├── client.js       núcleo HTTP: retry, backoff, 429, auditoria
│   ├── errors.js       catálogo de erros conhecidos do Sienge
│   ├── cache.js        TTL em memória
│   └── paginate.js     varredura limit/offset
├── utils/              paths, logger, auditoria, cotas
├── apis/               tradução da API: um arquivo por recurso do Sienge,
│   ├── _helpers.js     com o nome do recurso. Não custa contexto — existe
│   ├── purchase-orders.js   para as tools comporem sem repetir código, e
│   ├── creditors.js    cada módulo declara os ENDPOINTS que cobre.
│   ├── customers.js
│   ├── cost-centers.js
│   ├── enterprises.js
│   ├── units.js
│   ├── payment-categories.js
│   ├── customer-types.js
│   └── bills.js
├── workflows/
│   ├── connection.js   diagnóstico de conectividade
│   └── purchaseApproval.js  travessia da fila de aprovação
├── knowledge/          processo de compras (conhecimento, não API)
└── tools/
    ├── nucleo.js       diagnóstico e conhecimento
    ├── modulos.js      carregar_compras, descarregar_modulos
    ├── deep.js         sienge_api_endpoints + sienge_api_call
    └── compras.js      camada de intenção de compras
```

O desenho central: `tools/` é a superfície MCP e **custa tokens em toda
requisição**; `apis/` é tradução de endpoint e **não custa nada**. Toda lógica
que puder descer para `apis/` ou `workflows/` deve descer.

### Adicionando um endpoint

Cada arquivo de `src/apis/` declara em `ENDPOINTS` os paths que cobre. Depois
de acrescentar um:

```bash
npm run endpoints
```

Isso regenera `contract/endpoints.json`, que é o que `sienge_api_endpoints`
responde ao modelo e o que um 404 usa para sugerir o path certo. `npm test`
falha se um módulo chamar um path que não declarou, ou se o inventário ficar
para trás.

### Adicionando uma tool

```bash
node scripts/generate-schemas.js titulos --out src/tools/titulos.js
```

Gera as tools do módulo com os schemas Zod completos, defaults e descrições —
restam os handlers, marcados com `TODO`. Depois de escrevê-los, `npm run check`
confirma que a interface não divergiu da especificação.

Não há módulo de cadastros: clientes, credores e obras são o *join* que uma
tool de negócio resolve por dentro, não a pergunta. Eles vivem em `src/apis/`,
que não custa contexto.

## Licença

[PolyForm Noncommercial 1.0.0](LICENSE) — uso livre para fins não comerciais.
Para uso comercial, contate o autor.
