# MCP Sienge Node

> ⚠️ **ALFA — 0.11.1.** Em reescrita. A arquitetura mudou por inteiro na série 0.7 e
> nomes de tool, formato de retorno e variáveis de ambiente ainda vão mudar sem
> aviso. Compras e contratos já **gravam no ERP**: use primeiro num ambiente de
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
| `SIENGE_PASTA_ANEXOS` | — | pasta onde `contratos_baixar_anexos` salva os arquivos |
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
subida                 3 tools    diagnóstico e autenticação
+ carregar_compras     7 tools    solicitações e pedidos
+ carregar_contratos   7 tools    contratos de suprimentos e medições
```

Para uma operação que sempre usa os mesmos módulos,
`SIENGE_PROFILE=compras,contratos` deixa o recorte pronto na subida, sem
depender do carregamento dinâmico.

> **Se as ferramentas não aparecerem depois de `carregar_compras`**, o cliente
> pode não ter reindexado a lista — o servidor emite a notificação, mas alguns
> clientes demoram a reagir. Isso NÃO quer dizer que as ferramentas não existem
> naquele ambiente: elas estão registradas no servidor e respondem quando
> chamadas pelo nome exato, que a resposta do carregamento devolve. Para evitar
> de vez, pré-carregue: `SIENGE_PROFILE=compras,contratos`.

## Estado

Reescrita em andamento. A 0.7.0 trocou a arquitetura inteira e recomeçou o
catálogo de tools pelo ciclo de compras; a 0.10.0 abriu o de contratos de
suprimentos, que é onde a obra contrata serviço e paga por medição.

| Módulo | Tools | Estado |
|---|---|---|
| `nucleo` | 3 | ✅ diagnóstico e autenticação |
| `compras` | 7 | 🔨 solicitação e pedido; falta cotação e nota fiscal |
| `contratos` | 7 | 🔨 contrato, medição e download de anexo; falta anexar |
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
| `compras_decidir_solicitacoes` | aprova ou reprova itens e solicitações, conferindo antes contra a fila real |
| `compras_pedidos_para_aprovacao` | a fila de pedidos pendentes, com itens e fornecedor resolvidos |
| `compras_decidir_pedidos` | aprova ou reprova pedidos de compra, com o valor na prévia — **não envia e-mail**, ver abaixo |
| `compras_pedidos_pendentes_recebimento` | o que foi aprovado e ainda não chegou |
| `contratos_listar` | contratos de suprimentos por obra, período e situação |
| `contratos_detalhar` | tudo de um contrato numa chamada: fornecedor, valor, prazo, saldo e os itens com preço unitário |
| `contratos_decidir` | autoriza ou reprova contratos, conferindo antes contra a fila real |
| `contratos_baixar_anexos` | salva os anexos do contrato numa pasta local e devolve o caminho |
| `contratos_medicoes` | o histórico de medições, com os títulos gerados por cada uma |
| `contratos_criar_medicao` | mede itens do contrato a partir de nomes, com prévia antes de gravar |
| `contratos_decidir_medicoes` | autoriza ou reprova medições, conferindo antes contra a fila real |
| `carregar_compras` / `carregar_contratos` / `carregar_financeiro` | trazem as tools do módulo |
| `descarregar_modulos` | libera o contexto dos módulos carregados |

### O processo de compras, e o que falta

O Sienge percorre até seis etapas. `compras_processo` descreve todas ao
assistente — inclusive as que este servidor não cobre, para que ele não
prometa o que não faz.

| Etapa | Cobertura |
|---|---|
| 1 · Solicitação | criar ✅ · consultar ❌ |
| 2 · Aprovação da solicitação | fila ✅ · aprovar ✅ · reprovar ✅ |
| 3 · Cotação | ❌ |
| 4 · Pedido de compra | fila ✅ |
| 5 · Aprovação do pedido | fila ✅ · aprovar ✅ · reprovar ✅ |
| 6 · Nota fiscal | pendências ✅ · lançar ❌ |

**As escritas do servidor são seis:** criar solicitação, decidir solicitação,
decidir pedido de compra, decidir contrato, criar medição e decidir medição.
Todo o resto lê.

### O ciclo do contrato de suprimentos

Compra e contrato são caminhos diferentes para gastar dinheiro na obra. A
compra termina numa **entrega**; o contrato, numa **medição** — alguém confere
quanto do serviço foi executado, e é isso que vira conta a pagar.

| Etapa | Cobertura |
|---|---|
| Contrato | consultar ✅ · autorizar ✅ · reprovar ✅ · criar ❌ |
| Anexos do contrato | baixar ✅ · anexar ❌ |
| Medição | consultar ✅ · criar ✅ · autorizar ✅ · reprovar ✅ |
| Liberação (o título a pagar) | consultar ✅ · liberar ❌ — a API não expõe |
| Aditivos | consultar ✅ |

Três coisas deste recurso não se adivinham, e as tools já as tratam por dentro:

- **O contrato não tem id.** A identidade é o par documento + número (`CTS`,
  `325`), e ninguém sabe de cabeça que o documento é `CTS`. As tools aceitam o
  número solto, parte do objeto ou só a obra.
- **Não existe listagem sem período.** Toda busca varre uma janela de 4 anos e
  **diz na resposta** qual janela varreu — ausente na janela não é inexistente.
- **Não existe saldo de item de contrato.** O saldo que a prévia de medição
  mostra é derivado da última medição e vai rotulado como tal; ele ignora
  aditivo posterior, então estourá-lo é aviso, nunca bloqueio.

## Antes de apontar para produção

- **Comece em homologação.** Uma solicitação criada por engano não pode ser
  apagada pela API: o Sienge não expõe `DELETE` de solicitação.
- **A criação não é atômica.** A API grava cabeçalho e itens em dois `POST`.
  Se o segundo falhar, fica uma solicitação sem itens; o retorno diz o id para
  você resolver pela tela.
- **Decidir não tem volta.** A API não expõe endpoint que desfaça uma
  autorização nem uma reprovação. A tool confere contra a fila real e exige
  `confirmar: true`, mas depois de gravado só o ERP resolve. Deixar um item
  sem decisão é legítimo: liste só o que foi decidido.
- **A prévia é o portão.** Sem `confirmar: true`, `compras_criar_solicitacao`
  resolve tudo e devolve o que seria gravado, sem gravar. Confira a unidade de
  medida e o item de orçamento ali — é o último ponto antes do ERP.
- **Aprovar pedido pela API não envia e-mail — bug do Sienge.** Na tela, aprovar
  um pedido dispara os envios parametrizados: a via ao fornecedor, o aviso ao
  usuário do Sienge e o relatório à obra. Pelo endpoint, **nenhum deles sai**,
  mesmo com o envio automático ligado no ERP. Não é configuração faltando nem
  limitação deste servidor: é o endpoint que não executa o gatilho que a tela
  executa. O pedido fica aprovado e ninguém é avisado — combine o envio por
  fora. A tool repete esse aviso em toda resposta de aprovação.
- **Criar medição não tem volta.** A API não expõe exclusão nem alteração de
  medição — criada errada, só a tela do Sienge resolve. `vencimento` não tem
  padrão de propósito: é a data em que o título nasce vencendo, e chutar uma
  data de vencimento é chutar dinheiro.
- **Autorizar contrato ou medição também é definitivo**, pela mesma razão das
  decisões de compra. O aviso ao responsável só sai se o ERP estiver
  parametrizado para sempre enviar.
- **Baixar anexo escreve no seu disco, não no ERP.** Os arquivos vão para
  `SIENGE_PASTA_ANEXOS`, numa subpasta por contrato. A tool grava os bytes como
  vieram e **não lê o conteúdo** — não espere dela um resumo do PDF.
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

121 testes com o runner nativo do Node, sem dependência nenhuma. **Nenhum toca
a API do Sienge** — sobem um servidor HTTP local que responde nos schemas de
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
│   ├── supply-contracts-v1.js
│   ├── supply-contracts-measurements-v1.js
│   ├── building-cost-estimations-v1.js
│   ├── creditor-v1.js
│   └── cost-center-v1.js
├── client/
│   ├── siengeClient.js      o único ponto que fala HTTP com o Sienge —
│   │                        makeRequest para JSON, baixarArquivo para bytes
│   ├── purchaseClient.js    compõe as funções de api/ no que uma pergunta de
│   │                        negócio precisa: resolve nomes, agrupa, projeta
│   └── supplyContractClient.js   idem, para contratos e medições
├── modules/                 o que vira tool: core, purchase, supplyContract,
│                            financial
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
