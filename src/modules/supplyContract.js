/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo de contratos de suprimentos.
 *
 * Só é importado quando `carregar_contratos` é chamada — é essa a diferença
 * entre o módulo custar tokens e não custar. Nada aqui roda na subida.
 *
 * QUATRO TOOLS, cada uma pedida explicitamente, e o `client/` faz mais que
 * isso. É deliberado: cada tool declarada custa descrição + inputSchema em
 * TODA mensagem, enquanto uma função de client parada não custa nada. Prontas
 * no client e ainda sem tool: listar contratos, histórico de medições, criar
 * medição e autorizar/reprovar medição. As escritas não sobem sem pedido.
 *
 * As descrições carregam as armadilhas que o modelo não tem como adivinhar,
 * porque elas custam menos aqui do que uma tentativa errada: a identidade do
 * contrato é um PAR (documento + número) e a busca varre uma JANELA de datas.
 */

import {
  detalharContrato,
  baixarAnexosDoContrato,
  listarContratosPendentesDeAprovacao,
  decidirContratos,
} from "../client/supplyContractClient.js";

export const supplyContractModule = {
  tools: [
    {
      // A tool que responde "me dê informações do contrato X da obra Y":
      // fornecedor, itens com preço unitário, valor, prazo e saldo, numa
      // chamada só. Cada um desses vem de um endpoint diferente do Sienge, e
      // encadeá-los como tools separadas reenviaria a conversa a cada passo.
      name: "contratos_detalhar",
      description:
        "Informações completas de UM contrato de suprimentos, numa chamada só: fornecedor " +
        "resolvido pelo nome, VALOR do contrato (material + mão de obra), PRAZO (início, " +
        "fim e dias restantes), SALDO, obras, unidades construtivas e os ITENS de cada " +
        "planilha com PREÇO UNITÁRIO e total. Aceita o número do contrato, parte do objeto " +
        "('instalações hidrossanitárias') ou só a obra — resolve o par documento+contrato " +
        "internamente; não peça nem busque ids. A busca varre os últimos 4 anos por " +
        "padrão, porque a API não lista contratos sem período: se não achar, a resposta " +
        "traz os contratos DA JANELA para você escolher, e `desde` amplia. Ambíguo, " +
        "devolve os candidatos com o par de cada um. Use `incluir_itens: false` só quando " +
        "a pergunta não envolver os itens.",
      inputSchema: {
        type: "object",
        properties: {
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CT'; dispensa a varredura" },
          obra: { type: "string", description: "nome (ou parte) da obra" },
          incluir_itens: { type: "boolean", description: "true (padrão) traz os itens de cada planilha" },
          incluir_aditivos: { type: "boolean", description: "false (padrão); true traz os aditivos" },
        },
      },
    },
    {
      // Grava em DISCO, não no ERP. Por isso não tem `confirmar`: a regra da
      // prévia protege contra escrita irreversível no Sienge, e apagar um
      // arquivo desfaz isto aqui. O que a descrição precisa deixar claro é o
      // contrário — que ela NÃO lê o arquivo, só o entrega.
      name: "contratos_baixar_anexos",
      description:
        "Baixa os anexos de um contrato e os SALVA em disco, na pasta configurada em " +
        "SIENGE_PASTA_ANEXOS, dentro de uma subpasta '<DOCUMENTO-NÚMERO> - <fornecedor>'. " +
        "Baixa TODOS os anexos de uma vez; use `anexos` só para escolher alguns. Ao " +
        "responder, DIGA em que pasta os arquivos foram salvos e ofereça `abrir_pasta` " +
        "(link) e `comando_para_abrir` (uma linha de terminal que abre o Finder/Explorer " +
        "ali) — é assim que o usuário chega nos arquivos. NÃO abre nem lê o conteúdo: o servidor grava os " +
        "bytes como vieram, então não prometa resumir, extrair ou interpretar o que está " +
        "dentro. Um anexo que falhe não impede os outros — a resposta lista o que salvou e " +
        "o que não.",
      inputSchema: {
        type: "object",
        properties: {
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CTS'" },
          obra: { type: "string", description: "nome (ou parte) da obra" },
          anexos: {
            type: "array",
            description: "números dos anexos a baixar; omita para baixar todos",
            items: { type: "number" },
          },
        },
      },
    },
    {
      // Leitura separada da escrita de propósito: "quais contratos estão
      // pendentes?" é uma pergunta, e uma tool chamada "aprovar" faz o modelo
      // hesitar em usá-la só para responder. Tudo que se precisa para decidir
      // vem numa chamada — fornecedor, valor, prazo, motivo, itens, aditivo.
      name: "contratos_pendentes_aprovacao",
      description:
        "Lista os contratos de suprimentos e ADITIVOS pendentes de aprovação, com tudo o que " +
        "se precisa para decidir numa chamada só: fornecedor, obra, VALOR, PRAZO, o MOTIVO de " +
        "estar pendente (ex: valor acima da alçada do usuário), os ITENS com preço unitário e, " +
        "quando for aditivo, o que o aditivo mais recente mudou. Não chame outras tools para " +
        "completar a lista — ela já vem completa. `obra` filtra por nome. " +
        "Só aparece o que ainda está para decidir: ficam de fora os REPROVADOS, CONCLUÍDOS, " +
        "REVOGADOS e os com cadastro em inclusão — se perguntarem por um deles, ele existe, só " +
        "não está para decisão. A API não indica qual aditivo está pendente: 'aditivos.recentes' é o " +
        "mais recente de cada obra, não uma confirmação.",
      inputSchema: {
        type: "object",
        properties: {
          obra: { type: "string", description: "nome (ou parte) da obra; omita para todas" },
        },
      },
    },
    {
      // Aprovar e reprovar na MESMA tool, escolhidos em `decisao` — mesmo desenho
      // de compras_decidir_pedidos. As duas passam pela mesma conferência contra
      // a fila, porque o risco é o mesmo: nenhuma das duas tem volta.
      //
      // Sem `todos: true`, e isso é a regra de segurança: "aprova todos" vira a
      // lista que o assistente acabou de mostrar. Um atalho decidiria também o
      // contrato que entrou na fila depois da listagem, sem ninguém ter olhado.
      name: "contratos_decidir",
      description:
        "APROVA ou REPROVA contratos de suprimentos e aditivos pendentes — escolha em " +
        "`decisao`. Liste em `contratos` o que o usuário decidiu, como aparece na fila " +
        "('CTS/524'). Para \"aprova todos\", passe TODOS os contratos da lista que você " +
        "mostrou — nunca decida o que o usuário não viu. Use contratos_pendentes_aprovacao " +
        "antes, se a lista ainda não foi mostrada. Ao reprovar, peça o motivo e grave em " +
        "`observacao`. Sem `confirmar: true` devolve só a prévia com o valor somado; mostre-a " +
        "e repita com os MESMOS argumentos. AS DUAS DECISÕES SÃO IRREVERSÍVEIS. A resposta " +
        "traz `continuam_pendentes`: diga ao usuário o que ficou de fora.",
      inputSchema: {
        type: "object",
        properties: {
          contratos: {
            type: "array",
            description: "referências como aparecem na fila, ex: ['CTS/524', 'CTS/568']",
            items: { type: "string" },
          },
          decisao: {
            type: "string",
            enum: ["aprovar", "reprovar"],
            description: "aprovar (padrão) ou reprovar",
          },
          observacao: {
            type: "string",
            description: "gravada junto de cada decisão (até 300 caracteres); ao reprovar, o motivo",
          },
          confirmar: { type: "boolean", description: "false (padrão) devolve a prévia; true grava no Sienge" },
        },
        required: ["contratos"],
      },
    },
  ],

  handlers: {
    contratos_detalhar: detalharContrato,
    contratos_baixar_anexos: baixarAnexosDoContrato,
    contratos_pendentes_aprovacao: listarContratosPendentesDeAprovacao,
    contratos_decidir: decidirContratos,
  },
};
