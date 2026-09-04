# MCP Sienge Node

> ⚠️ **ALFA — 0.7.1.** Em reescrita. A arquitetura mudou por inteiro na série 0.7 e
> nomes de tool, formato de retorno e variáveis de ambiente ainda vão mudar sem
> aviso. O módulo de compras já grava no ERP: use primeiro num ambiente de
> homologação, e leia a seção [Antes de apontar para produção](#antes-de-apontar-para-produção).

Servidor [MCP](https://modelcontextprotocol.io) para a API do
[Sienge](https://www.sienge.com.br) — expõe consultas e operações do ERP como
ferramentas que um assistente de IA pode chamar.

JavaScript puro (ESM), sem etapa de build e sem dependência além do SDK do MCP.

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
        "SIENGE_SUBDOMAIN": "sua-empresa"
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

Outros clientes MCP (Claude Code, Cursor, Zed) usam o mesmo formato de
`command`/`args`/`env`, em arquivo próprio.

### Verificando que funcionou

Depois de reiniciar, peça ao assistente: *"testa a conexão com o Sienge"*. Ele
deve chamar `testar_conexao` e responder com a latência. Se a autenticação
estiver incompleta, `verificar_autenticacao` diz o que falta sem gastar chamada
na API.

## Configuração

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SIENGE_SUBDOMAIN` | ✅ | subdomínio da empresa; compõe a URL de toda chamada |
| `SIENGE_API_KEY` | uma das duas | Bearer Token |
| `SIENGE_USERNAME` + `SIENGE_PASSWORD` | uma das duas | Basic Auth |
| `SIENGE_PROFILE` | — | módulos carregados já na subida. Vazio = só o núcleo |
| `SIENGE_BASE_URL` | — | trocar o host da API |

### Para criar solicitações de compra

A criação exige dados que não saem da credencial nem do pedido do usuário. São
constantes da instalação, então ficam no ambiente e não custam nada no schema
das tools:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SIENGE_SOLICITANTE` | ✅ | usuário do Sienge que **assina** a solicitação |
| `SIENGE_CADASTRANTE` | — | quem **registra**, se for diferente de quem assina. Vazio = o solicitante |
| `SIENGE_NIVEL_APROPRIACAO` | — | nível da EAP em que a obra apropria: `02.032` é nível 2. Vazio = todos |
| `SIENGE_DEPARTAMENTO` | — | preencha se o Sienge recusar a criação citando o departamento |
| `SIENGE_CATEGORIA` | — | idem, para a categoria |

`SIENGE_NIVEL_APROPRIACAO` merece atenção: sem ele, um item de orçamento de
qualquer profundidade vira alvo de apropriação, e apropriar no nível errado é
erro de cadastro. Com ele, a lista de itens candidatos encolhe a ponto de o
assistente escolher sozinho e só confirmar com você.

Lista completa e comentada em [`.env.example`](.env.example).

## Como o catálogo é carregado

O catálogo de tools é reenviado ao modelo a cada mensagem, então tool parada é
custo recorrente. O servidor sobe só com o núcleo, e os módulos entram sob
demanda:

```
subida               3 tools    diagnóstico e autenticação
+ carregar_compras   5 tools    solicitações e pedidos
```

Para uma operação que sempre usa os mesmos módulos, `SIENGE_PROFILE=compras`
deixa o recorte pronto na subida, sem depender do carregamento dinâmico.

> **Se as ferramentas não aparecerem depois de `carregar_compras`**, o cliente
> pode não ter reindexado a lista — o servidor emite a notificação, mas alguns
> clientes demoram a reagir. A resposta do carregamento traz os nomes exatos,
> que podem ser chamados diretamente. Para evitar de vez, use
> `SIENGE_PROFILE=compras`.

## Estado

Reescrita em andamento. A 0.7.0 trocou a arquitetura inteira e recomeçou o
catálogo de tools pelo ciclo de compras.

| Módulo | Tools | Estado |
|---|---|---|
| `nucleo` | 3 | ✅ diagnóstico e autenticação |
| `compras` | 5 | 🔨 solicitação e pedido; falta cotação e nota fiscal |
| `financeiro` | 1 | ⚠️ apenas um esqueleto de teste, não lê nada do ERP |

### As tools de hoje

| Tool | O que faz |
|---|---|
| `status_servidor` | confirma que o servidor está no ar e há quanto tempo |
| `testar_conexao` | testa a credencial contra a API, com uma chamada barata |
| `verificar_autenticacao` | qual mecanismo está configurado, sem chamar a API |
| `compras_processo` | o processo de compras de ponta a ponta, e o que este servidor **não** cobre |
| `compras_criar_solicitacao` | cria uma solicitação, com vários itens, a partir de nomes e com prévia antes de gravar |
| `compras_solicitacoes_para_aprovacao` | a fila de solicitações pendentes, agrupada por solicitação |
| `compras_pedidos_para_aprovacao` | a fila de pedidos pendentes, com itens e fornecedor resolvidos |
| `compras_pedidos_pendentes_recebimento` | o que foi aprovado e ainda não chegou |
| `carregar_compras` / `carregar_financeiro` | trazem as tools do módulo |
| `descarregar_modulos` | libera o contexto dos módulos carregados |

### O processo de compras, e o que falta

O Sienge percorre até seis etapas. `compras_processo` descreve todas ao
assistente — inclusive as que este servidor não cobre, para que ele não
prometa o que não faz.

| Etapa | Cobertura |
|---|---|
| 1 · Solicitação | criar ✅ · consultar ❌ |
| 2 · Aprovação da solicitação | fila ✅ · aprovar ❌ |
| 3 · Cotação | ❌ |
| 4 · Pedido de compra | fila ✅ |
| 5 · Aprovação do pedido | ❌ |
| 6 · Nota fiscal | pendências ✅ · lançar ❌ |

**A criação de solicitação é a única escrita do servidor.** Todo o resto lê.

## Antes de apontar para produção

- **Comece em homologação.** Uma solicitação criada por engano não pode ser
  apagada pela API: o Sienge não expõe `DELETE` de solicitação.
- **A criação não é atômica.** A API grava cabeçalho e itens em dois `POST`.
  Se o segundo falhar, fica uma solicitação sem itens; o retorno diz o id para
  você resolver pela tela.
- **A prévia é o portão.** Sem `confirmar: true`, `compras_criar_solicitacao`
  resolve tudo e devolve o que seria gravado, sem gravar. Confira a unidade de
  medida e o item de orçamento ali — é o último ponto antes do ERP.
- **Não há trilha de auditoria.** A versão anterior gravava um log de escrita;
  essa parte ainda não foi reescrita.

## Desenvolvimento

```bash
git clone https://github.com/frlorenzon/MCP-Sienge-Node.git
cd MCP-Sienge-Node
npm install
cp .env.example .env   # preencha as credenciais
npm start
```

### Testes

```bash
npm test
```

49 testes com o runner nativo do Node, sem dependência nenhuma. **Nenhum toca a
API do Sienge** — sobem um servidor HTTP local que responde nos schemas de
`spec/openapi.yaml`, então rodam offline e não consomem cota.

Testar contra HTTP de verdade, em vez de dublar `makeRequest`, é o que faz a
suíte cobrir o que mais quebrou neste projeto: o corpo exato enviado ao ERP, o
formato de erro do Sienge e a paginação. Cada caso corresponde a um defeito que
já aconteceu contra o Sienge real.

### Estrutura

```
src/
├── index.js                 bootstrap stdio
├── config.js                credenciais e resolução de auth
├── toolsGroupRouter.js      tools/list, tools/call e carregamento sob demanda
├── api/                     um arquivo por recurso REST do Sienge
│   ├── purchase-requests-v1.js
│   ├── purchase-orders-v1.js
│   ├── building-cost-estimations-v1.js
│   ├── creditor-v1.js
│   └── cost-center-v1.js
├── client/
│   ├── siengeClient.js      o único ponto que fala HTTP com o Sienge
│   └── purchaseClient.js    compõe as funções de api/ no que uma pergunta de
│                            negócio precisa: resolve nomes, agrupa, projeta
├── modules/                 o que vira tool: core, purchase, financial
└── knowledge/               o processo de compras (conhecimento, não API)

spec/openapi.yaml            a especificação publicada do Sienge
test/                        Sienge falso + os casos
```

Três camadas, e a divisão importa por causa do custo: **`modules/` é a
superfície MCP e custa tokens em toda requisição; `api/` e `client/` não custam
nada.** Toda lógica que puder descer, desce — é por isso que
`compras_criar_solicitacao` aceita "tubo de esgoto" e "instalações
hidráulicas" em vez de ids: resolver nomes dentro do servidor é de graça,
enquanto fazer o modelo encadear quatro tools para descobrir os mesmos ids
reenvia a conversa inteira a cada passo.

### Sobre `spec/openapi.yaml`

Cópia local da especificação do Sienge, com a procedência em
[`spec/README.md`](spec/README.md). Sem ela, nome de campo vira palpite — e
palpite falha em silêncio: um filtro inexistente é ignorado pelo servidor, um
campo com nome errado volta `undefined`, e o resultado sai vazio sem erro
nenhum. Confira ali antes de escrever qualquer coisa em `src/api/`.

## Licença

[PolyForm Noncommercial 1.0.0](LICENSE) — uso livre para fins não comerciais.
Para uso comercial, contate o autor.
