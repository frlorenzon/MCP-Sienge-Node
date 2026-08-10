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
        "SIENGE_DEEP_MODE": "off",
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
deve chamar `testar_conexao` e responder com a latência. Se a
autenticação estiver incompleta, `verificar_autenticacao` diz o que falta sem gastar
chamada na API.

## Configuração

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SIENGE_SUBDOMAIN` | ✅ | subdomínio da empresa; compõe a URL de toda chamada |
| `SIENGE_API_KEY` | uma das duas | Bearer Token |
| `SIENGE_USERNAME` + `SIENGE_PASSWORD` | uma das duas | Basic Auth |
| `SIENGE_PROFILE` | — | recorte inicial. **Vazio = só o núcleo** (padrão); `all` carrega tudo; ou fixe os módulos: `compras,financeiro`. Valor não reconhecido cai no padrão |
| `SIENGE_DEEP_MODE` | — | acesso direto aos endpoints. **Desligado por padrão, e a instalação normal não precisa dele** |
| `SIENGE_MCP_API_PACKAGE` | — | pacote contratado, para calcular o saldo diário de cota |
| `SIENGE_MCP_LICENSE_KEY` | — | licença; sem ela o servidor funciona e avisa uma vez por sessão |

## Onde ficam os arquivos

O servidor grava três coisas em disco. Por padrão, tudo em **`~/.sienge-mcp/`**
— o diretório do usuário, nunca a pasta do pacote (que pode nem ser gravável
depois de instalado via npm) nem o diretório de trabalho (que depende de onde o
cliente MCP subiu o processo).

| Arquivo | O que é | Cresce? |
|---|---|---|
| `audit.log` | uma linha JSON por operação de **escrita** no ERP: quem, quando, qual tool, qual payload | **nunca é truncado** — é evidência |
| `sienge-mcp.log` | diagnóstico: requisições, retentativas, erros | rotaciona a cada 5 MB, pode ser descartado |
| `api-quota.json` | contador do consumo de cota do dia | some na virada do dia |

Para mudar o diretório inteiro, defina `SIENGE_MCP_HOME` no `env` da
configuração. Ou aponte cada arquivo em separado, quando a trilha de auditoria
precisa ir para outro lugar — um volume com backup, por exemplo:

| Variável | Padrão |
|---|---|
| `SIENGE_MCP_HOME` | `~/.sienge-mcp` |
| `SIENGE_MCP_AUDIT_LOG` | `<home>/audit.log` |
| `SIENGE_MCP_LOG_FILE` | `<home>/sienge-mcp.log` |
| `SIENGE_MCP_QUOTA_COUNTER` | `<home>/api-quota.json` |
| `SIENGE_MCP_LOG_LEVEL` | `INFO` — use `DEBUG` para investigar |

O servidor **nunca escreve em stdout**: sob transporte stdio, stdout é o canal
do protocolo MCP e um byte fora do lugar corromperia a sessão. Avisos e erros
saem em stderr, que é o que o cliente costuma mostrar.

### Ajuste fino

Raramente necessárias, mas existem:

| Variável | Padrão | Para quê |
|---|---|---|
| `SIENGE_BASE_URL` | `https://api.sienge.com.br` | trocar o host da API |
| `REQUEST_TIMEOUT` | `30` | segundos por requisição |
| `SIENGE_COMPRAS_VALOR_ALERTA` | `50000` | acima disso, o pedido ganha alerta de valor |
| `SIENGE_COMPRAS_TOLERANCIA_PRECO` | `0.20` | quanto um item pode passar do menor preço do lote antes de virar alerta |
| `SIENGE_COMPRAS_CONCORRENCIA` | `6` | requisições em paralelo na varredura; o freio existe porque a cota é diária |

Lista completa das variáveis em [`.env.example`](.env.example).

## Como o catálogo é carregado

O servidor sobe com **6 tools e ~780 tokens** de contexto. As demais entram sob
demanda:

```
subida                       6 tools    ~780 tokens
+ carregar_compras           8 tools  ~1.560 tokens
```

Com o modo profundo habilitado — que é exceção — somam-se duas tools e ~535
tokens.

Isso importa porque o catálogo é reenviado a cada mensagem. Carregar as 105
tools de uma vez custaria ~19.000 tokens em toda requisição, mesmo numa
conversa que toca um assunto só.

Para uma operação que sempre usa os mesmos módulos, `SIENGE_PROFILE=compras`
deixa o recorte pronto na subida, sem depender do carregamento dinâmico.

> **Se as ferramentas não aparecerem depois de `carregar_compras`**, o cliente
> pode não ter reindexado a lista — o servidor emite a notificação, mas alguns
> clientes demoram a reagir. A resposta do carregamento traz os nomes exatos,
> que podem ser chamados diretamente. Para evitar de vez, configure
> `SIENGE_PROFILE=compras`: aí o módulo já sobe carregado.

`SIENGE_PROFILE` não é obrigatório: sem ele o servidor já sobe no mínimo.
`minimo`, `minimal`, `min`, `core` e `nucleo` são sinônimos desse padrão, e um
valor não reconhecido também cai nele — restringir por engano é preferível a
abrir o catálogo inteiro por causa de um typo. Para carregar tudo, é preciso
dizer `all` explicitamente.

## Estado

**Núcleo e a primeira tool de compras implementados** — 10 das 106 tools do
catálogo, com toda a infraestrutura compartilhada pronta.

| Módulo | Tools | Estado |
|---|---|---|
| `nucleo` | 8 | ✅ implementado |
| `compras` | 2 de 11 | 🔨 em andamento |
| `compras_api` | 33 | coberto por `chamar_api` |
| `titulos`, `financeiro`, `contratos`, `cotacoes` | 54 | pendente |

### As tools de hoje

Nomes em português, em três padrões: `verbo_objeto` para infraestrutura,
`dominio_acao` para negócio, `carregar_<modulo>` para os carregadores.

| Tool | O que faz |
|---|---|
| `testar_conexao` | testa a credencial contra a API |
| `verificar_autenticacao` | qual mecanismo está configurado, sem chamar a API |
| `consultar_cota` | consumo e saldo das cotas REST e BULK do dia |
| `explicar_processo_compras` | o processo de compras de ponta a ponta |
| `carregar_compras` | traz as ferramentas de compras |
| `descarregar_modulos` | libera o contexto de módulos já carregados |
| `listar_endpoints_api` | quais endpoints existem, por recurso — só com `SIENGE_DEEP_MODE=on` |
| `chamar_api` | chama um endpoint direto — só com `SIENGE_DEEP_MODE=on` |
| `compras_pedidos_para_aprovar` | a fila de aprovação resolvida numa chamada |
| `compras_aprovar_pedidos` | autoriza pedidos em lote — prévia primeiro, execução só com `confirm` |

## Modo profundo — desligado, e é para continuar assim

> ⚠️ **Recurso de exceção.** Vem desligado e a instalação normal não precisa
> dele. Ligue apenas se uma consulta específica não tiver tool que a cubra, e
> considere desligar de volta depois.

O uso corrente é pelas tools de negócio: elas resolvem o join no servidor,
custam dezenas de vezes menos chamadas e têm comportamento testado. O modo
profundo dá ao assistente leitura de **todos** os endpoints declarados com a
credencial configurada — é acesso amplo, sem normalização e sem as validações
que as tools específicas fazem.

Três razões para deixá-lo desligado:

- **Cota** — uma varredura mal-encaminhada consome o orçamento diário da API
- **Previsibilidade** — a resposta é o que a API der, crua
- **Contexto** — desligado, as duas tools não são registradas e não custam os
  ~535 tokens

Desligado é o padrão: basta não definir `SIENGE_DEEP_MODE`.

<details>
<summary>Se precisar mesmo habilitar</summary>

```json
{
  "mcpServers": {
    "sienge": {
      "command": "npx",
      "args": ["-y", "mcp-sienge-node"],
      "env": {
        "SIENGE_API_KEY": "sua-chave",
        "SIENGE_SUBDOMAIN": "sua-empresa",
        "SIENGE_DEEP_MODE": "on"
      }
    }
  }
}
```

Não confunda com o parâmetro `deep_mode: true`, descrito adiante: **esta
variável é você decidindo se a porta existe; o parâmetro é o modelo declarando
que está atravessando de propósito.** Os dois são necessários.

</details>

### Como funciona, quando habilitado

A API do Sienge tem centenas de endpoints. Criar uma tool para cada um
custaria dezenas de milhares de tokens de contexto **em toda mensagem** — e a
maioria nunca seria usada. As tools de negócio cobrem o dia a dia; o modo
profundo cobre o resto, com duas ferramentas em vez de um catálogo.

**1. Descobrir o endpoint.** `listar_endpoints_api` responde em dois níveis,
para que o modelo pague só pelo que consultar:

```
listar_endpoints_api()
→ recursos: bills, cost-centers, creditors, customers, customer-types,
            enterprises, payment-categories, purchase-orders, units

listar_endpoints_api({ recurso: "purchase-orders" })
→ GET /purchase-orders
  GET /purchase-orders/{id}/items
  GET /purchase-orders/{id}/attachments
  … +12
```

Recursos com armadilha trazem uma `nota`. Consultar `customers`, por exemplo,
avisa antes de você errar:

> Não há busca por nome: a API filtra apenas por cpf, cnpj e datas. Para achar
> um cliente pelo nome, pagine ou use o documento.

**2. Chamar.** `chamar_api` executa:

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
- **Modo profundo opcional** — quando habilitado, `chamar_api` alcança 59
  endpoints da API por ~535 tokens, no lugar dos milhares que uma tool por
  endpoint custaria
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
    ├── deep.js         listar_endpoints_api + chamar_api
    └── compras.js      camada de intenção de compras
```

O desenho central: `tools/` é a superfície MCP e **custa tokens em toda
requisição**; `apis/` é tradução de endpoint e **não custa nada**. Toda lógica
que puder descer para `apis/` ou `workflows/` deve descer.

E uma regra que já foi violada três vezes, documentada em
[notas técnicas](docs/notas-tecnicas.md): **nenhuma resposta pode citar uma tool
sem antes conferir se ela está registrada.** O catálogo tem 105 nomes e o
servidor implementa 9 — citar os outros faz o modelo procurar o que o próprio
servidor prometeu e não tem.

### Adicionando um endpoint

Cada arquivo de `src/apis/` declara em `ENDPOINTS` os paths que cobre. Depois
de acrescentar um:

```bash
npm run endpoints
```

Isso regenera `contract/endpoints.json`, que é o que `listar_endpoints_api`
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
