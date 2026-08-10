# Notas técnicas

Decisões que não são óbvias na leitura do código, e o motivo de cada uma.

---

## Convenção de nomes das tools

Os nomes são em **português**, e são um dos três únicos campos que chegam ao
modelo — junto de `description` e `inputSchema`. Nome de função, arquivo,
JSDoc e comentário não chegam: renomeie à vontade lá dentro, sem consequência
para o comportamento.

Três padrões, cada um com uma razão:

| Padrão | Exemplo | Quando |
|---|---|---|
| `verbo_objeto` | `testar_conexao`, `consultar_cota` | infraestrutura e diagnóstico |
| `dominio_acao_objeto` | `compras_aprovar_pedidos` | tools de negócio — o prefixo agrupa o módulo |
| `carregar_<modulo>` | `carregar_compras` | carregadores; o nome é o contrato |

O prefixo de domínio nas tools de negócio não é decoração: com dezenas delas,
é o que deixa visível a qual módulo cada uma pertence sem precisar ler a
descrição.

Até a v0.4.0 metade dos nomes estava em inglês (`get_auth_info`,
`sienge_api_call`), herança do servidor de origem. Isso não quebrava nada — a
decisão do modelo se apoia na descrição —, mas custava previsibilidade: ao
procurar "a tool de conexão", não havia como saber se o prefixo seria `test_`
ou `testar_`. A v0.5.0 padronizou.

---

## A regra do catálogo: nada chega ao modelo sem filtro

**Nenhuma resposta pode citar uma tool sem antes conferir se ela está
registrada.** É a regra mais importante deste documento, e a única que já foi
violada três vezes.

### Por que existe

`contract/catalogo-tools.json` lista 105 tools; o servidor implementa 9. O
catálogo é **roadmap**, não promessa — mas todo artefato que o consulta trata
seus nomes como se existissem, porque foi assim que ele nasceu: exportado de um
servidor onde todas existiam de fato.

O sintoma é sempre o mesmo, e é caro. O modelo lê "use `authorize_purchase_order`"
numa resposta que o próprio servidor devolveu, sai procurando, não encontra — e
**insiste**, porque a instrução veio de dentro. Do lado de quem usa, isso parece
o assistente se perdendo. Não é: é obediência a uma fonte errada.

### Os três casos

| Onde | O que prometia | Corrigido em |
|---|---|---|
| `list_sienge_entities` | 7 de 9 tools recomendadas não existiam | a tool acabou removida |
| `list_sienge_modules` / `enable_sienge_modules` | 8 módulos, dos quais 7 vazios; "carregar" respondia `success: true` com zero tools novas | filtro por `contarPorTag()` |
| `explicar_processo_compras` | 37 de 38 tools inexistentes, com `"cobertura_mcp": "completa"` em toda etapa | filtro contra `registered` |

Três formas diferentes, uma causa só.

### Como aplicar

Toda resposta que cite nomes de tool cruza a lista com `registered`, de
`src/registry.js`, e separa em três destinos — porque cada um pede uma reação
diferente do modelo:

```js
const agora        = previstas.filter((t) => visiveis.has(t));
const aposCarregar = previstas.filter((t) => !visiveis.has(t) && registradas.has(t));
const inexistentes = previstas.filter((t) => !registradas.has(t));
```

- **chamável agora** → vai na resposta
- **existe, atrás de um `carregar_<modulo>`** → vai com `como_habilitar`, dizendo
  qual carregador chamar
- **não implementada** → **sai da resposta**, e o item ganha um caminho
  alternativo (`chamar_api`, ou "faça no próprio Sienge")

Note a distinção entre `visiveis` e `registradas`: uma tool desabilitada pelo
perfil existe e é alcançável; uma que nunca foi implementada, não. Confundir as
duas manda o modelo carregar um módulo que não vai trazer nada.

Sumir com o nome não basta: um campo do tipo `por_onde_comecar` que aponte para
tool inexistente precisa ser **removido**, senão continua dirigindo a busca.

### O que também não pode passar

Rótulos de cobertura herdados. `"cobertura_mcp": "completa"` era um texto fixo
no JSON — verdadeiro no servidor de origem, falso aqui. Qualquer campo que
**afirme** capacidade precisa ser calculado no momento da resposta, nunca lido
de um artefato.

### Como isso é travado

Cada caso tem teste de regressão que percorre a resposta e exige que todo nome
citado exista em `registered` — ver `test/nucleo.test.js`. Ao criar uma tool que
devolva nomes de outras tools, escreva o teste junto: é ele que impede o quarto
caso.

---

## O carregamento dinâmico depende do cliente reindexar

`carregar_<modulo>` habilita as tools e o SDK emite
`notifications/tools/list_changed` — verificado: duas notificações por
carregamento, e um `tools/list` seguinte já traz as tools novas.

O que o servidor não controla é o outro lado. Clientes que fazem busca
semântica sobre o catálogo mantêm um índice próprio, e nem todos o reconstroem
ao receber a notificação. Quando isso acontece, o sintoma é confuso: o
carregamento responde com sucesso, as tools estão ativas no servidor, e o
modelo não consegue encontrá-las na busca. Foi relatado como *"o módulo foi
carregado mas a ferramenta não aparece"*.

Duas mitigações, ambas no que o servidor pode fazer:

**A resposta traz os nomes, não só a contagem.** Antes dizia
`tools_disponiveis: 2`; agora devolve `tools: ["compras_aprovar_pedidos",
"compras_pedidos_para_aprovar"]`. Com o nome exato em mãos, o modelo chama
direto, sem depender da busca ter reindexado.

**E diz o que fazer se ainda assim falhar**: configurar `SIENGE_PROFILE` com o
módulo. O recorte estático é resolvido na subida e chega pronto no primeiro
`tools/list`, sem depender de notificação nenhuma.

Para uma operação que sempre usa os mesmos módulos, o perfil estático é a
opção mais previsível — o carregamento dinâmico existe para a conversa que
muda de assunto, não para o uso corrente.

---

## O campo que o SDK injeta e não precisa ser enviado

O SDK anexa `execution: { taskSupport: "forbidden" }` a toda tool registrada,
sem que `registerTool` ofereça como desligar. São 40 caracteres por tool em
**toda** resposta de `tools/list` — 108 tokens com 10 tools, 324 com 30.

O valor é redundante. O próprio spec do protocolo diz, no comentário do campo:
*"If not present, defaults to forbidden"*. E o cliente do SDK só age quando o
valor é `required` ou `optional`: ausente e `forbidden` seguem o mesmo caminho.

Por isso `registry.js` faz `handle.execution = undefined` depois de registrar.
Não é hack semântico — é deixar de enviar o padrão explicitamente.

Se uma versão futura do SDK mudar essa estrutura, o campo volta a aparecer:
perde-se a economia, nada quebra. Coberto por teste em
`test/serializacao.test.js`.

Nota de medição: `title`, `annotations` e `_meta` também aparecem no objeto,
mas custam **zero** — são `undefined` e somem no `JSON.stringify`. Só o
`execution` tem valor concreto.

---

## Escrita em lote: prévia informada e falha parcial visível

`compras_aprovar_pedidos` autoriza vários pedidos numa chamada. Três decisões
que não são óbvias:

**A prévia busca dados, e por isso custa chamadas.** Ela devolve fornecedor,
obra, valor e contagem de itens de cada pedido — não só os ids. Confirmar uma
aprovação vendo apenas `[123, 456]` é o mesmo que não confirmar; o gate viraria
um clique. As chamadas extras são o preço de a confirmação ser informada.

**A execução é sequencial.** Paralelizar economizaria segundos e custaria
clareza: quando algo falha no meio do lote, o que importa é saber exatamente o
que foi aprovado e o que não foi. Com escrita, essa resposta vale mais que a
latência — e o volume é de dezenas, não de milhares.

**Nunca aborta no primeiro erro.** Um pedido que falha não impede os seguintes,
e a resposta separa `aprovados` de `falharam`. Interromper deixaria o lote num
estado que ninguém pediu e que ninguém sabe qual é.

O teto de 50 por chamada não é limitação técnica: é o ponto em que a prévia
deixa de ser conferível por uma pessoa.

`PUT .../authorize` é usado quando não há observação, `PATCH` quando há — é o
que o spec do Sienge exige. A diferença importa para o retry: PUT está entre os
métodos idempotentes e é repetido em falha de rede (autorizar duas vezes deixa
o pedido no mesmo estado); PATCH não é, então uma falha ambígua com observação
volta como `estado_incerto`, dizendo para consultar o ERP antes de repetir.

---

## Retry: quando repetir é seguro

Um timeout não diz se a requisição chegou. Repetir um `POST` cujo timeout
ocorreu **depois** de o Sienge processar o pedido cria nota fiscal, título ou
parcela duplicados — e o ERP não tem como saber que era a mesma operação.

A regra em `src/http/client.js`:

- **Métodos idempotentes** (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) são
  sempre repetidos. Repetir não muda o resultado.
- **`POST`/`PATCH`** só são repetidos quando a falha prova que a requisição não
  foi entregue: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`,
  `UND_ERR_CONNECT_TIMEOUT`. São erros da fase de conexão, antes de qualquer
  byte sair.
- **`ECONNRESET`, `EPIPE` e timeout ficam de fora** de propósito: podem ocorrer
  depois do envio, e nesse caso o servidor pode ter processado.

No caso ambíguo a resposta volta com `error: "Ambiguous Failure"` e uma
mensagem que diz explicitamente para consultar o estado no Sienge antes de
tentar de novo — em vez de silenciosamente arriscar a duplicata.

`HTTP 429` é repetido em qualquer método: a requisição foi rejeitada sem ser
processada.

---

## HTTP 429 significa duas coisas diferentes

O Sienge usa o mesmo código para excesso momentâneo e para cota diária
esgotada. A diferença importa: no primeiro caso esperar resolve, no segundo só
o dia seguinte resolve, e insistir é tempo jogado fora.

`src/utils/apiQuota.js` mantém um contador local por dia e por trilha
(REST/BULK). Quando o contador indica esgotamento, o cliente HTTP para de
repetir e devolve o diagnóstico correspondente.

A contagem é **local e aproximada**: enxerga só as chamadas deste servidor.
Outros clientes com as mesmas credenciais consomem a mesma cota sem passar por
aqui. Orienta decisão; nunca bloqueia uma chamada.

---

## Recorte de módulos vale para o processo

`enable_sienge_modules` e `disable_sienge_modules` usam `enable()`/`disable()`
do SDK, que não têm escopo de sessão — o efeito é do processo inteiro.

Sob transporte stdio isso não faz diferença: um processo atende uma sessão.
Passa a fazer se o servidor for exposto por HTTP com múltiplos clientes
simultâneos, cenário em que um cliente que carrega um módulo o carrega para
todos. Antes de expor por HTTP, o estado de módulos ativos precisa migrar para
o escopo da sessão.

O recorte estático via `SIENGE_PROFILE` não tem esse problema: é resolvido na
subida e vale para o processo por definição.

---

## O gate de confirmação é verificado no registro

Uma tool de escrita que esquece de declarar `confirm` no `inputSchema` perderia
o gate inteiro sem nenhum sinal: o handler embrulhado nunca receberia o
parâmetro, e o modelo não teria como enviá-lo.

Argumentos desestruturados não são inspecionáveis em tempo de execução, então
`registerTool()` confere o `inputSchema` quando a tool é marcada com
`requiresConfirm: true`, e lança na subida do servidor. É o tipo de defeito que
não pode chegar a produção.

---

## `fetchAllPaginated` devolve objeto de erro, não lista

Em caso de falha da API, `src/http/paginate.js` devolve
`{success: false, error, message}` em vez de um array. Quem chama precisa testar
`Array.isArray()` antes de tratar o retorno como coleção — é o que
`src/api/entities.js` faz.

Candidato a uniformização quando todos os módulos estiverem implementados e
cobertos por teste.

---

## A chave de retorno de `getBills` é `bills`

`src/workflows/discovery.js` procura os títulos sob a chave `bills`. Se
`getBills` devolvesse a genérica `results`, o resultado não seria um erro — seria
uma lista vazia com `success: true`, indistinguível de "não há títulos no
período". Falha silenciosa é pior que falha ruidosa; há teste de regressão para
esta.

---

## Log nunca escreve em stdout

Sob transporte stdio, stdout é o canal do protocolo MCP: qualquer byte fora do
lugar corrompe a sessão. O log vai para arquivo (`SIENGE_MCP_LOG_FILE` ou
`~/.sienge-mcp/sienge-mcp.log`) e stderr recebe cópia apenas de `warn` e
`error`, que é o que o cliente MCP costuma mostrar.

O mesmo vale para o banner de inicialização: vira `logger.info`, não `print`.

---

## Datas usam o fuso local, não UTC

`new Date().toISOString()` é UTC. Usá-lo faria a cota diária virar no horário
errado e uma licença expirar até três horas antes no Brasil.

`apiQuota` e `licensing` montam a data local explicitamente (`hojeISO()`).

---

## Estado fica no diretório do usuário

`~/.sienge-mcp/` (ou `SIENGE_MCP_HOME`), nunca derivado da localização do
pacote nem do diretório de trabalho.

Derivar de `import.meta.url` quebra assim que o pacote é instalado via npm:
aponta para dentro de `node_modules`, que pode nem ser gravável. Derivar do
diretório de trabalho faz o destino depender de onde o cliente MCP subiu o
processo.

A trilha de auditoria (`audit.log`) nunca é truncada nem rotacionada — é
evidência de quem alterou o quê no ERP. O log de diagnóstico
(`sienge-mcp.log`) rotaciona por tamanho e pode ser descartado.
