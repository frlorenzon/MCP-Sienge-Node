# Conector Sienge para IA — servidor MCP

**Servidor MCP ([Model Context Protocol](https://modelcontextprotocol.io)) que
conecta o Claude — Claude Code, Claude Desktop ou qualquer cliente MCP — à API
do [Sienge](https://www.sienge.com.br), o ERP de construção civil e incorporação
da Softplan.** Integração **não oficial**, escrita por quem usa o ERP.

Compras, contratos de suprimentos e medições viram ferramentas que o assistente
chama direto: consultar um contrato com valor, prazo e saldo, baixar os anexos,
ver a fila de aprovação, criar uma solicitação de compra. Tudo **em português e
por nome** — "obra iu.06", "tubo de esgoto", "instalações hidrossanitárias" —,
com os códigos internos resolvidos dentro do servidor.

```bash
npx -y mcp-sienge-node
```

JavaScript puro (ESM), sem etapa de build e sem dependência além do SDK do MCP.

> ⚠️ **ALFA — 0.12.2.** Em reescrita. A arquitetura mudou por inteiro na série 0.7 e
> nomes de tool, formato de retorno e variáveis de ambiente ainda vão mudar sem
> aviso. O módulo de compras já **grava no ERP**: use primeiro num ambiente de
> homologação, e leia a seção [Antes de apontar para produção](#antes-de-apontar-para-produção).

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
+ carregar_contratos   2 tools    contratos de suprimentos
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
| `contratos` | 2 | 🔨 consulta e anexos; o resto do ciclo está pronto em `client/`, sem tool |
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
| `contratos_detalhar` | tudo de um contrato numa chamada: fornecedor, valor, prazo, saldo e os itens com preço unitário |
| `contratos_baixar_anexos` | salva os anexos do contrato numa pasta local e devolve o caminho |
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

As escritas desta etapa são três: criar solicitação, decidir solicitação e
decidir pedido de compra.

### O ciclo do contrato de suprimentos

**Outro módulo, outro ciclo** — `contratos_*`, carregado à parte por
`carregar_contratos`, sem nenhuma dependência de compras. Não é a continuação
do processo de compra: é o caminho alternativo. A compra termina numa
**entrega**; o contrato, numa **medição** — alguém confere quanto do serviço
foi executado, e é isso que vira conta a pagar.

O módulo expõe **duas tools**: `contratos_detalhar` e
`contratos_baixar_anexos`. O resto do ciclo já está implementado e testado em
`client/supplyContractClient.js`, sem tool declarada — porque tool parada custa
tokens em toda mensagem, e porque três dessas funções gravam no ERP.

| Etapa | Client | Tool |
|---|---|---|
| Contrato — consultar | ✅ | ✅ `contratos_detalhar` |
| Contrato — listar por obra e período | ✅ | — |
| Anexos — baixar | ✅ | ✅ `contratos_baixar_anexos` |
| Anexos — anexar | ❌ | — |
| Contrato — autorizar e reprovar | ✅ | — ✏️ grava |
| Medição — consultar | ✅ | — |
| Medição — criar | ✅ | — ✏️ grava |
| Medição — autorizar e reprovar | ✅ | — ✏️ grava |
| Liberação (o título a pagar) | ✅ consultar · ❌ liberar — a API não expõe | — |
| Aditivos — consultar | ✅ | — |

Três coisas deste recurso não se adivinham, e as tools já as tratam por dentro:

- **O contrato não tem id.** A identidade é o par documento + número (`CTS`,
  `325`), e ninguém sabe de cabeça que o documento é `CTS`. As tools aceitam o
  número solto, parte do objeto ou só a obra.
- **Não existe listagem sem período.** Toda busca varre uma janela de 4 anos e
  **diz na resposta** qual janela varreu — ausente na janela não é inexistente.
- **Não existe saldo de item de contrato.** O saldo que a prévia de medição
  mostra é derivado da última medição e vai rotulado como tal; ele ignora
  aditivo posterior, então estourá-lo é aviso, nunca bloqueio.

**Nenhuma escrita de contrato está exposta como tool hoje** — as três existem
no client e esperam ser pedidas. As escritas ativas do servidor continuam sendo
as três de compras.

## Como `contratos_detalhar` resolve um contrato

Vale abrir esta, porque quase tudo que ela faz existe para contornar um jeito
de a resposta sair errada **sem erro nenhum**.

A informação está espalhada por cinco endpoints: o cabeçalho num, o saldo
noutro, o fornecedor no cadastro de credores, as obras num terceiro, os itens
num quarto — e os itens ainda vivem por planilha. Encadear isso como tools
faria **cada passo reenviar a conversa inteira** ao modelo. Por isso é uma
chamada só, e a tradução acontece no servidor, onde é de graça.

**1 · De quem estamos falando.** O contrato não tem id: a identidade é o par
documento + número (`CTS`, `325`), e ninguém sabe de cabeça que o documento é
`CTS`. Quatro caminhos, do mais barato ao mais caro:

| Você informa | O que acontece |
|---|---|
| documento **e** número | um GET direto, confirma que existe |
| só o número | varre a janela e casa pelo número |
| um texto (`"instalações hidrossanitárias"`) | varre a janela e casa pelo objeto |
| só a obra | varre a janela dela; havendo um contrato só, resolve |

A obra vem antes, por nome, descartando os cadastros marcados "NÃO USAR" —
obra desativada que a conta mantém por histórico.

**2 · A janela.** A API não lista contrato sem período; não existe "todos". A
varredura usa **4 anos até hoje e devolve, na resposta, qual janela varreu**.
Sem isso, "não achei" vira "não existe", que é outra coisa — a mensagem diz
onde olhou e que `desde` amplia.

**3 · Quando o nome não casa, a tool não adivinha.** O nome do cadastro
raramente é o nome que a pessoa usa: em produção, "instalações
hidrossanitárias" está gravado como *"SERVIÇO DE INSTALAÇÃO HIDRAULICA,
ESGOTO, GÁS E INCÊNDIO"*. Isso é sinonímia de obra, não de grafia, e nenhuma
regra de texto liga os dois sem chutar. Então a resposta traz **os contratos da
janela ordenados por relevância**, cada um com o seu par — a obra IU.06 tem 75
contratos em quatro anos, e ordenar por data escondia justamente o certo.

**4 · O cabeçalho é buscado de novo**, mesmo quando o passo 1 já achou o
contrato na listagem: só o GET de um contrato devolve `materialBalance` e
`laborBalance`. A listagem não traz saldo.

**5 · A obra tem dois ids, e o óbvio é o errado.**
`/supply-contracts/buildings` devolve `buildingID` (interno) e
`buildingIdView` (código no Sienge). Só o View é aceito nos demais endpoints:

```
/supply-contracts/items?buildingId=21   → 404 "Obra 21 não encontrada"
/supply-contracts/all?buildingId=21     → 200 com 85 contratos de OUTRA obra
/supply-contracts/all?buildingId=20     → 200 com os 75 contratos certos
```

O 404 aparece; os 85 contratos errados, não. Conferido contra produção — é a
única falha aqui capaz de produzir uma resposta confiante e completamente
errada.

**6 · Os itens saem por planilha** (obra × unidade construtiva); não existe
"todos os itens do contrato". `incluir_itens: false` corta essas N chamadas
quando a pergunta não envolve item.

### O que a tool calcula, porque o Sienge não devolve pronto

O ERP guarda material e mão de obra sempre separados — eles medem e pagam
separado. Ninguém pergunta assim.

| Campo | De onde sai |
|---|---|
| `valor_total` | material + mão de obra |
| `saldo_total` | saldo de material + saldo de mão de obra |
| `prazo` | início, fim e `dias_restantes` (negativo se já venceu) |
| `precoUnitario` | preço de material + de mão de obra, por item |
| `valorTotal` | quantidade × preço unitário |
| `mensuravel` | derivado: item sem `resourceId` nem `workItemId` é agrupador |

Uma regra atravessa todas: **ausência não vira zero**. `saldo_total` some da
resposta quando a API não mandou o campo, em vez de virar `0` — saldo zero é
"acabou", saldo ausente é "não sei", e a listagem nunca traz saldo.

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

120 testes com o runner nativo do Node, sem dependência nenhuma. **Nenhum toca
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
