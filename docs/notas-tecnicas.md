# Notas técnicas

Decisões que não são óbvias na leitura do código, e o motivo de cada uma.

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
