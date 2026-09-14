# spec/

Cópia local da especificação OpenAPI das APIs públicas do Sienge.

## Por que uma cópia no repositório

Cada arquivo em `src/api/` é a tradução de um recurso da API do Sienge, e a
fidelidade dessa tradução é a única coisa que separa uma tool que funciona de
uma que inventa campo. Sem o spec por perto, nome de campo vira palpite — e
palpite falha em silêncio: o filtro inexistente é ignorado pelo servidor, o
campo com nome errado volta `undefined`, e o resultado sai vazio sem erro
nenhum. Foi o que aconteceu com `withOpenQuantity` e com `openQuantity` em
`purchase-requests-v1.js`, herdados do port Python: nenhum dos dois existe.

Com o arquivo aqui, conferir um nome é um `grep`, não uma ida à rede.

## Procedência

| | |
|---|---|
| Origem | `https://api.sienge.com.br/v1/docs/docs/openapi.yaml` |
| Baixado em | 2026-09-03 |
| `last-modified` | Thu, 27 Aug 2026 01:37:31 GMT |
| `etag` | `"6a8f94db-266369"` |
| Tamanho | 2 515 817 bytes |
| Versão | OpenAPI 3.1.1 — 291 paths, 1113 schemas |

A URL não é óbvia: a página em `https://api.sienge.com.br/v1/docs/` é uma SPA
que só monta o conteúdo no navegador, e o `docs` aparece duplicado no caminho
do arquivo. Tentar `/v1/docs/openapi.yaml` devolve HTTP 200 com o `index.html`
da SPA, não o spec — um 200 enganoso, que parece sucesso.

## Atualizar

```bash
curl -o spec/openapi.yaml https://api.sienge.com.br/v1/docs/docs/openapi.yaml
```

Confira o `etag` contra a tabela acima antes de substituir; se for igual, nada
mudou. Depois de atualizar, vale reconferir os schemas que `src/api/` já
consome — em especial os nomes de campo lidos direto, sem lista de candidatos.

## Grafias erradas conhecidas

O spec grafa alguns campos de forma irregular, e o servidor espera a grafia
irregular. São preservadas no código de propósito:

| Onde | Grafia do spec | Grafia esperada |
|---|---|---|
| `PurchaseRequest` (corpo do POST) | `departamentId` | `departmentId` |
| `PurchaseRequest` (resposta) | `consitent` | `consistent` |
| `PurchaseRequestItemInsert` | `buildingsApropriations` | `buildingsAppropriations` |
| `PurchaseOrderItem` | `sheduledQuantity` | `scheduledQuantity` |

Note que `buildingsApropriations` vale para o **payload**; a **rota** de
consulta usa a grafia correta, `buildings-appropriations`.

## Onde o spec e a produção discordam

Divergências que o arquivo NÃO registra — descobertas chamando o tenant real.
Aqui não é grafia irregular do spec: é o spec dizendo uma coisa e o servidor
respondendo outra.

| Onde | O spec diz | A produção responde |
|---|---|---|
| `BuildingDTO` (`/supply-contracts/buildings`) | `buildingId`, `costCenterId`, `departmentId` | `buildingID`, `costCenterID`, `departmentID` |
| `ConstructUnitDTO.status` | `L` / `B` | `RELEASED` |
| filtro `consistency` em `/supply-contracts/all` | `N` = inconsistente | `N` devolve **nada**; os contratos com `consistent: false` estão em `I` (inclusão) |
| filtro `authorization` em `/supply-contracts/all` | `N` = aguardando, `S` = reprovados | `N` traz os **reprovados junto** — eles aparecem em `N` e em `S`. Quem separa é `statusApproval=A` |

E uma que não é de nome, mas de **valor**: `BuildingDTO` traz `buildingID`
(interno) e `buildingIdView` (código da obra no Sienge), e é o **View** que
todos os outros endpoints aceitam no parâmetro `buildingId` — apesar de o spec
descrever esse parâmetro como "identificador (interno) da obra". Conferido no
contrato CTS/325 da obra iU.06:

```
GET /supply-contracts/items?buildingId=21   → 404 "Obra 21 não encontrada"
GET /supply-contracts/all?buildingId=21     → 200 com 85 contratos de OUTRA obra
GET /supply-contracts/all?buildingId=20     → 200 com os 75 contratos certos
```

O 404 aparece; os 85 contratos errados, não. É o mesmo id de `/cost-centers`.
Tratado em `client/supplyContractClient.js`, na função `idDaObra`.
