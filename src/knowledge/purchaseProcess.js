/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * O processo de compras do Sienge, descrito para o assistente.
 *
 * Este módulo não chama a API. Ele existe porque as tools, isoladas, não
 * contam a ordem em que as coisas acontecem — e um assistente que não conhece
 * o processo erra de formas específicas e previsíveis: procura preço numa
 * solicitação (que não tem preço), supõe que todo pedido nasce de uma
 * solicitação, ou trata a aprovação como consequência automática do cadastro.
 *
 * O conteúdo é conhecimento de negócio informado pelo operador do ERP,
 * complementado pelo que as especificações publicadas confirmam. Onde algo não
 * foi verificado, está marcado como tal — ver LIMITACOES.
 *
 * `cobertura_mcp` descreve ESTE servidor, o Node, e não a versão Python: a
 * maior parte das etapas ainda não tem tool aqui. Manter isso honesto é o que
 * impede o assistente de prometer uma ação que não consegue executar.
 */

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// ETAPAS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export const ETAPAS = [
  {
    etapa: 1,
    nome: "Solicitação de Compra",
    api: "purchase-requests-v1",
    o_que_e:
      "Alguém pede um ou mais insumos ou serviços. Registra o que se precisa e " +
      "quanto, não quanto custa. Uma solicitação carrega VÁRIOS itens: é " +
      "cabeçalho mais lista, e cada item tem seu insumo, quantidade e " +
      "apropriação.",
    atencao:
      "NÃO existe preço nesta etapa, porque ainda não houve cotação. Há apenas " +
      "quantidade e unidade de medida. Se o usuário pedir valores de uma " +
      "solicitação, explique que o preço só aparece a partir da cotação ou do " +
      "pedido. O campo estimatedPrice, quando preenchido, é estimativa do " +
      "solicitante — não é preço negociado.",
    tools: ["compras_criar_solicitacao"],
    por_onde_comecar:
      "compras_criar_solicitacao cria a solicitação a partir de NOMES: obra, " +
      "insumo, detalhe do insumo e itens de orçamento da apropriação. Ela " +
      "resolve todos os códigos internamente — não peça ids ao usuário. Sem " +
      "confirmar:true devolve só a prévia, sem gravar. Insumo e detalhe são " +
      "coisas distintas: 'tubo de esgoto' é o insumo e '2\"' é o detalhe dele. " +
      "Quando o usuário pedir mais de um insumo, mande TODOS em `itens` na " +
      "mesma chamada — uma chamada por insumo criaria uma solicitação solta " +
      "para cada um, em vez de uma solicitação com vários itens.",
    cobertura_mcp: "parcial",
    observacao_cobertura:
      "Criar está coberto. CONSULTAR solicitação existente não: " +
      "buscarSolicitacao e buscarItensDeSolicitacoes existem em " +
      "api/purchase-requests-v1.js mas não são tool — para ver solicitações, " +
      "hoje só a fila da etapa 2. " +
      "A criação NÃO é atômica: a API grava cabeçalho e itens em dois POSTs, e " +
      "se o segundo falhar sobra uma solicitação sem itens, que só se resolve " +
      "pela tela — não há DELETE de solicitação.",
  },
  {
    etapa: 2,
    nome: "Aprovação da Solicitação",
    api: "purchase-requests-v1",
    o_que_e: "A solicitação é autorizada, item a item ou inteira.",
    atencao:
      "É um passo próprio e explícito: cadastrar uma solicitação não a aprova. " +
      "A API permite aprovar a solicitação inteira, um subconjunto de itens ou " +
      "um item isolado, e também reprovar. Como a aprovação é item a item, uma " +
      "solicitação pode estar parcialmente aprovada — não trate 'aprovada' como " +
      "estado único da solicitação.",
    tools: ["compras_solicitacoes_para_aprovacao", "compras_decidir_solicitacoes"],
    por_onde_comecar:
      "compras_decidir_solicitacoes faz tudo: chamada sem argumentos devolve a " +
      "fila de pendentes; com 'solicitacoes' aprova ou reprova, conforme " +
      "'decisao'. Atinge um ou mais itens (liste em 'itens') ou a solicitação " +
      "inteira (omita 'itens'), e aceita várias solicitações numa chamada só. " +
      "Ela SEMPRE confere contra a fila real antes de gravar: id já decidido " +
      "por outra pessoa é recusado. NUNCA decida sem mostrar antes o que está " +
      "pendente. compras_solicitacoes_para_aprovacao continua útil para só " +
      "olhar a fila. NÃO decidir também é uma saída: liste em 'itens' só o que " +
      "o usuário decidiu e o resto continua aguardando, o que é estado normal " +
      "do processo. Omitir 'itens' decide TODOS os pendentes da solicitação.",
    cobertura_mcp: "completa",
    observacao_cobertura:
      "Aprovar e reprovar estão cobertos, na solicitação inteira ou item a " +
      "item. AS DUAS DECISÕES SÃO IRREVERSÍVEIS: a API não expõe endpoint que " +
      "desfaça autorização nem reprovação.",
  },
  {
    etapa: 3,
    nome: "Cotação de Preços",
    api: "purchase-quotations-v1",
    o_que_e:
      "A solicitação vai a mercado: fornecedores são consultados, negociações " +
      "são registradas e comparadas. É aqui que o preço entra no processo.",
    atencao:
      "ETAPA OPCIONAL — pode ser pulada. Não presuma que todo pedido passou por " +
      "cotação.",
    tools: [],
    cobertura_mcp: "ausente",
  },
  {
    etapa: 4,
    nome: "Pedido de Compra",
    api: "purchase-orders-v1",
    o_que_e:
      "A ordem da empresa para que um fornecedor fature um produto ou serviço. " +
      "Aqui existem preço, fornecedor e condições.",
    atencao:
      "Pode nascer de uma solicitação, de uma cotação, ou de nada — ver " +
      "sequencias. Não suponha que exista uma solicitação por trás.",
    tools: ["compras_pedidos_para_aprovacao"],
    por_onde_comecar:
      "Para listar ou analisar pedidos pendentes, use " +
      "compras_pedidos_para_aprovacao: ela traz pedido, itens e fornecedor " +
      "resolvidos numa chamada só. A limitação dela é a janela — o pedido " +
      "precisa estar entre os 100 últimos.",
    cobertura_mcp: "parcial",
    observacao_cobertura:
      "Só a fila de pendentes de aprovação está exposta como tool. " +
      "Apropriações de obra, previsões de entrega, anexos e item avulso " +
      "existem em api/purchase-orders-v1.js mas ainda não viraram tool.",
  },
  {
    etapa: 5,
    nome: "Aprovação do Pedido de Compra",
    api: "purchase-orders-v1",
    o_que_e: "O pedido é autorizado e passa a valer como compromisso de compra.",
    atencao:
      "Assume compromisso financeiro. Analisar não é aprovar: " +
      "compras_pedidos_para_aprovacao apenas monta a fila, e a decisão sobre " +
      "cada pedido é do usuário. É também o gatilho da notificação ao " +
      "fornecedor dentro do ERP — ver limitacoes.",
    tools: [],
    cobertura_mcp: "ausente",
    observacao_cobertura:
      "NÃO há tool de aprovação neste servidor. As funções autorizarPedido e " +
      "reprovarPedido existem em api/purchase-orders-v1.js, mas não estão " +
      "publicadas como tool — o assistente não consegue aprovar nem reprovar. " +
      "Diga isso ao usuário em vez de tentar; a aprovação é pelo ERP.",
  },
  {
    etapa: 6,
    nome: "Entrada da Nota Fiscal",
    api: "purchase-invoices-v1",
    o_que_e:
      "O insumo chega. Alguém confere fisicamente a quantidade e a qualidade " +
      "dos itens recebidos, verifica se a nota fiscal está em conformidade com " +
      "o pedido de compra e, se estiver tudo correto, lança a nota no sistema.",
    atencao:
      "A CONFERÊNCIA É FÍSICA e acontece FORA do sistema. É a única etapa do " +
      "processo que o assistente não tem como executar nem verificar: só quem " +
      "está no recebimento sabe se a mercadoria chegou certa. NUNCA trate uma " +
      "nota como lançável presumindo que a conferência foi feita. " +
      "Lançar a nota é também o ponto em que a compra vira dívida: o Sienge " +
      "gera automaticamente o título no contas a pagar. Divergência entre nota " +
      "e pedido (quantidade, preço, fornecedor) INTERROMPE o processo e volta " +
      "para tratativa humana — não ajuste os números para fazer fechar.",
    como_vincular_a_nota_ao_pedido: {
      resumo:
        "O cabeçalho da nota NÃO referencia o pedido — não há campo para isso. " +
        "O vínculo é feito item a item, e na granularidade da ENTREGA PREVISTA: " +
        "item da nota ↔ entrega prevista de um item de um pedido.",
      campos_por_linha: {
        purchaseOrderId: "qual pedido",
        itemNumber: "qual item daquele pedido",
        deliveryScheduleNumber: "qual entrega prevista daquele item",
        deliveredQuantity: "quanto desta entrega a nota cobre",
      },
      onde:
        "POST /purchase-invoices/{sequentialNumber}/items/purchase-orders" +
        "/delivery-schedules — nunca no POST do cabeçalho.",
      como_descobrir: [
        "itemNumber vem de GET /purchase-orders/{id}/items",
        "deliveryScheduleNumber vem de " +
          "GET /purchase-orders/{id}/items/{itemNumber}/delivery-schedules",
        "openQuantity, nessa mesma consulta, mostra o saldo ainda não faturado",
      ],
      observacoes: [
        "Uma nota pode atender entregas de VÁRIOS pedidos: deliveriesOrder é " +
          "uma lista e cada linha traz seu próprio purchaseOrderId.",
        "Um item de pedido pode ser entregue em partes, cada parte numa nota " +
          "diferente; deliveredQuantity permite atender uma entrega parcialmente.",
        "keepBalance decide se o saldo restante do pedido segue aberto.",
        "Depois de criada, ler os itens da nota NÃO devolve o pedido de origem. " +
          "Para o caminho inverso existe GET /purchase-orders/{id}/deliveries-attended.",
        "O preço não é informado no lançamento: vem do item do pedido.",
      ],
    },
    tools: ["compras_pedidos_pendentes_recebimento"],
    por_onde_comecar:
      "compras_pedidos_pendentes_recebimento mostra o que já foi aprovado e " +
      "ainda não chegou — é a visão de saldo em aberto, não o lançamento. " +
      "Ela exige obra ou fornecedor por NOME.",
    cobertura_mcp: "parcial",
    observacao_cobertura:
      "Só a consulta de pendências está exposta. NÃO existe tool que lance " +
      "nota fiscal neste servidor; o lançamento é pelo ERP.",
  },
];

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// COMO AS ETAPAS SE ENCADEIAM NO TEMPO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export const ENCADEAMENTO = {
  regra:
    "Cada etapa é executada por uma pessoa diferente, em um momento diferente. " +
    "O processo é assíncrono e as responsabilidades são segregadas — quem " +
    "solicita não é quem aprova, quem cota não é quem autoriza o pedido.",
  consequencias: [
    "NÃO encadeie etapas automaticamente. Concluir a etapa 1 não autoriza " +
      "executar a 2. Cada uma é uma decisão de outra pessoa, em outro momento.",
    "Um registro parado aguardando aprovação é estado NORMAL do processo, não " +
      "erro nem pendência a ser resolvida pelo assistente. Uma solicitação " +
      "cadastrada há dias e ainda não aprovada não indica falha.",
    "Ao concluir uma etapa, informe qual é a próxima e de quem é a vez — não " +
      "prossiga por conta própria.",
    "O usuário que conversa com você provavelmente atua em UMA etapa. Não " +
      "presuma que ele tem alçada para as demais.",
    "Como há intervalo entre as etapas, dados mudam entre elas. Reconsulte o " +
      "estado atual antes de agir sobre um registro criado anteriormente, em " +
      "vez de confiar no que foi lido antes.",
  ],
};

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// CAMINHOS VÁLIDOS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export const SEQUENCIAS = [
  {
    sequencia: "1 → 2 → 3 → 4 → 5 → 6",
    nome: "Fluxo completo",
    quando:
      "Compra planejada que passa por cotação de preços. A etapa 6 acontece " +
      "quando a mercadoria chega, o que pode levar dias ou semanas.",
  },
  {
    sequencia: "1 → 2 → 4 → 5 → 6",
    nome: "Sem cotação",
    quando:
      "A solicitação vira pedido direto, sem ir a mercado — fornecedor já " +
      "definido, contrato vigente ou valor que não justifica cotar.",
  },
  {
    sequencia: "4 → 5 → 6",
    nome: "Compra urgente",
    quando:
      "Emergência: o pedido é criado direto, sem solicitação e sem cotação. " +
      "É um caminho legítimo — a ausência de solicitação não indica erro nem " +
      "dado faltando.",
  },
];

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// LIMITAÇÕES
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export const LIMITACOES = [
  {
    assunto: "Envio de e-mail ao fornecedor",
    situacao:
      "Nenhuma das APIs de compras publicadas expõe endpoint de envio de " +
      "e-mail. Dentro do ERP, aprovar o pedido dispara e-mail ao fornecedor e " +
      "aos destinatários configurados nos parâmetros do centro de custo.",
    status: "NÃO VERIFICADO",
    observacao:
      "Não se sabe se aprovar via API dispara a mesma notificação que aprovar " +
      "pela tela, já que é o mesmo sistema por trás. Isso é testável: aprove um " +
      "pedido pela API e confira se o e-mail saiu. Até a confirmação, não " +
      "afirme ao usuário que o e-mail foi enviado nem que deixou de ser.",
  },
  {
    assunto: "PDF do pedido para envio ao fornecedor",
    situacao:
      "Não há endpoint que gere o documento do pedido de compra para envio. " +
      "Existe GET /purchase-orders/{id}/analysis/pdf, mas ele gera o relatório " +
      "de ANÁLISE do pedido — documento interno de conferência, não a via do " +
      "fornecedor.",
    status: "CONFIRMADO NO SPEC",
    observacao:
      "Se o usuário quiser mandar o pedido ao fornecedor, o caminho é o ERP. " +
      "Não ofereça o analysis/pdf como substituto sem explicar a diferença.",
  },
  {
    assunto: "Cobertura deste servidor MCP",
    situacao:
      "Das seis etapas, as etapas 1, 2, 4 e 6 têm tool. As de ESCRITA são duas, " +
      "ambas na solicitação: criar (etapa 1) e decidir, aprovando ou reprovando " +
      "(etapa 2). As demais são consulta: a fila de pedidos a aprovar e os " +
      "pedidos pendentes de recebimento. Cotar, aprovar pedido e lançar nota " +
      "fiscal são pelo ERP.",
    status: "CONFIRMADO NO CÓDIGO",
    observacao:
      "O assistente cria, aprova e reprova solicitação, mas NÃO cota, NÃO aprova " +
      "pedido e NÃO lança nota fiscal por aqui. Quando o usuário pedir uma " +
      "dessas ações, diga que o caminho é o ERP em vez de procurar uma tool que " +
      "não existe.",
  },
];

export const ERROS_COMUNS = [
  "Procurar preço em solicitação de compra — nesta etapa só há quantidade e unidade.",
  "Supor que todo pedido de compra veio de uma solicitação; compras urgentes começam no pedido.",
  "Tratar cadastro como aprovação; aprovar é sempre um passo separado e explícito.",
  "Afirmar que a aprovação via API enviou e-mail ao fornecedor — isso não foi verificado.",
  "Oferecer o relatório de análise como se fosse a via do pedido para o fornecedor.",
  "Encadear etapas sozinho: cada uma é decisão de outra pessoa, em outro momento.",
  "Tratar registro aguardando aprovação como problema — é estado normal do processo.",
  "Tratar nota fiscal como lançável sem confirmar que a conferência física foi feita.",
  "Ajustar quantidade ou preço da nota para 'fechar' com o pedido; divergência para o processo.",
  "Prometer uma ação de escrita: este servidor só consulta compras — ver limitacoes.",
];

/** Devolve o processo de compras do Sienge: etapas, caminhos válidos e limitações. */
export async function descreverProcessoDeCompras() {
  return {
    success: true,
    resumo:
      "Compras no Sienge percorrem até seis etapas: solicitação, aprovação da " +
      "solicitação, cotação (opcional), pedido de compra, aprovação do pedido e " +
      "entrada da nota fiscal quando a mercadoria chega. " +
      "Nem toda compra passa por todas — ver sequencias. Cada etapa é feita por " +
      "uma pessoa diferente, em momento diferente — ver encadeamento.",
    etapas: ETAPAS,
    encadeamento: ENCADEAMENTO,
    sequencias: SEQUENCIAS,
    limitacoes: LIMITACOES,
    erros_comuns: ERROS_COMUNS,
  };
}
