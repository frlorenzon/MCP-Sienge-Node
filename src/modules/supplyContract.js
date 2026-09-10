/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo de contratos de suprimentos.
 *
 * Só é importado quando `carregar_contratos` é chamada — é essa a diferença
 * entre o módulo custar tokens e não custar. Nada aqui roda na subida.
 *
 * SEIS TOOLS, E NÃO OITO: as duas filas de autorização (contratos e medições)
 * não têm tool própria. Chamar `contratos_decidir` ou
 * `contratos_decidir_medicoes` SEM alvo já devolve a fila — mesmo desenho de
 * `compras_decidir_solicitacoes`. Uma tool de listagem separada no caminho de
 * "veja e decida" custaria um turno do modelo a cada decisão, e o schema dela
 * pesaria em toda mensagem.
 *
 * As descrições carregam três armadilhas que o modelo não tem como adivinhar,
 * porque elas custam menos aqui do que uma tentativa errada: a identidade do
 * contrato é um PAR, a busca varre uma JANELA de datas, e o número da medição
 * é sequencial POR OBRA.
 */

import {
  listarContratos,
  detalharContrato,
  listarMedicoesDoContrato,
  decidirContratos,
  decidirMedicoes,
  criarMedicaoDeContrato,
} from "../client/supplyContractClient.js";

export const supplyContractModule = {
  tools: [
    {
      name: "contratos_listar",
      description:
        "Lista contratos de suprimentos — o compromisso com o fornecedor que será pago " +
        "por MEDIÇÃO, não por entrega; não confundir com pedido de compra. Filtra por " +
        "obra (nome, não id), período e situação de autorização. A API não lista sem " +
        "período: sem `desde`/`ate` varre os últimos 4 anos, e a resposta diz em `janela` " +
        "o que foi varrido — contrato mais antigo que isso NÃO aparece, e ausente não " +
        "significa inexistente.",
      inputSchema: {
        type: "object",
        properties: {
          obra: { type: "string", description: "nome (ou parte) da obra" },
          desde: { type: "string", description: "início do período, yyyy-MM-dd; 4 anos atrás se omitido" },
          ate: { type: "string", description: "fim do período, yyyy-MM-dd; hoje se omitido" },
          situacao: {
            type: "string",
            enum: ["aguardando", "aprovados", "reprovados", "todos"],
            description: "situação de autorização do contrato",
          },
        },
      },
    },
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
      // O contrato entra em vigor quando é autorizado; daí a mesma cerimônia
      // das decisões de compras — fila real, prévia, confirmação.
      name: "contratos_decidir",
      description:
        "AUTORIZA ou REPROVA contratos de suprimentos — escolha em `decisao`. Vários na " +
        "mesma chamada. Sem `contratos` devolve a fila do que aguarda autorização; " +
        "mostre-a ao usuário antes de decidir. Só decide o que a fila do ERP mostra " +
        "aguardando: contrato já decidido por outra pessoa é recusado, não gravado às " +
        "cegas. Sem `confirmar: true` devolve só a prévia. AS DUAS DECISÕES SÃO " +
        "IRREVERSÍVEIS. O aviso ao responsável só sai se o ERP estiver parametrizado " +
        "para sempre enviar.",
      inputSchema: {
        type: "object",
        properties: {
          contratos: {
            type: "array",
            description: "o que decidir; omita para apenas listar a fila",
            items: {
              type: "object",
              properties: {
                contrato: { type: "string", description: "número do contrato" },
                documento: {
                  type: "string",
                  description: "código do documento; só é preciso se o número repetir na fila",
                },
                observacao: { type: "string", description: "observação gravada junto (até 300 caracteres)" },
              },
              required: ["contrato"],
            },
          },
          decisao: {
            type: "string",
            enum: ["aprovar", "reprovar"],
            description: "aprovar (padrão) ou reprovar",
          },
          observacao: { type: "string", description: "observação aplicada a todos os contratos" },
          confirmar: { type: "boolean", description: "false (padrão) devolve a prévia; true grava no Sienge" },
        },
      },
    },
    {
      name: "contratos_medicoes",
      description:
        "Histórico de medições de um contrato: quanto foi medido, quando, valor, se está " +
        "autorizada e se já foi liberada. Medição é o que transforma o contrato em conta a " +
        "pagar. Com `incluir_liberacao: true` traz também os títulos gerados por cada uma — " +
        "medição sem liberação ainda não virou conta a pagar. O número da medição é " +
        "sequencial POR OBRA: duas obras do mesmo contrato têm, cada uma, a sua medição 1.",
      inputSchema: {
        type: "object",
        properties: {
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CT'" },
          obra: { type: "string", description: "nome (ou parte) da obra" },
          incluir_liberacao: {
            type: "boolean",
            description: "false (padrão); true traz os títulos gerados por cada medição",
          },
        },
      },
    },
    {
      // Schema enxuto de propósito: resolver contrato, obra, planilha e item
      // é trabalho de servidor, que é de graça — o que pesa em toda mensagem é
      // o schema. Por isso a tool fala em nomes e não em ids.
      name: "contratos_criar_medicao",
      description:
        "Cria uma MEDIÇÃO de contrato a partir de NOMES — obra, contrato, item —, " +
        "resolvendo os códigos internamente; não peça nem busque ids. VÁRIOS itens vão em " +
        "`itens` numa chamada só. `vencimento` é obrigatório e não tem padrão: é quando o " +
        "título gerado vence. Sem `confirmar: true` devolve só a prévia; mostre-a, obtenha " +
        "o aval e repita com os MESMOS argumentos mais `confirmar: true`. CRIAR MEDIÇÃO É " +
        "IRREVERSÍVEL — a API não exclui nem altera. O saldo mostrado na prévia é DERIVADO " +
        "da última medição e pode ignorar aditivo posterior; não o trate como saldo " +
        "oficial. NUNCA invente a unidade de medida: omita `quantidade` para descobri-la.",
      inputSchema: {
        type: "object",
        properties: {
          obra: { type: "string", description: "nome (ou parte) da obra do contrato" },
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CT'" },
          unidade_construtiva: {
            type: "string",
            description: "nome da unidade construtiva; dispensável quando a obra tem só uma",
          },
          itens: {
            type: "array",
            description: "o que está sendo medido; uma medição comporta vários itens",
            items: {
              type: "object",
              properties: {
                item: { type: "string", description: "nome do item do contrato, ex: 'alvenaria de bloco'" },
                quantidade: {
                  type: "number",
                  description:
                    "quantidade NA UNIDADE DO ITEM; omita para descobrir qual é essa unidade e o saldo",
                },
              },
              required: ["item"],
            },
          },
          vencimento: { type: "string", description: "vencimento do título gerado, yyyy-MM-dd" },
          data: { type: "string", description: "data da medição, yyyy-MM-dd; hoje se omitida" },
          observacao: { type: "string", description: "observação da medição" },
          nascer_desautorizada: {
            type: "boolean",
            description: "true cria a medição já desautorizada; só use se o usuário pedir",
          },
          confirmar: { type: "boolean", description: "false (padrão) devolve a prévia; true grava no Sienge" },
        },
        required: ["obra", "itens"],
      },
    },
    {
      name: "contratos_decidir_medicoes",
      description:
        "AUTORIZA ou REPROVA medições de contrato — escolha em `decisao`. Várias na mesma " +
        "chamada. Sem `medicoes` devolve a fila do que aguarda autorização; mostre valor e " +
        "contrato ao usuário antes de decidir. Só decide o que a fila do ERP mostra " +
        "aguardando. Sem `confirmar: true` devolve só a prévia. AS DUAS DECISÕES SÃO " +
        "IRREVERSÍVEIS. O número da medição é sequencial POR OBRA: informe `obra` sempre " +
        "que o contrato tiver mais de uma, ou a chamada volta pedindo desambiguação.",
      inputSchema: {
        type: "object",
        properties: {
          medicoes: {
            type: "array",
            description: "o que decidir; omita para apenas listar a fila",
            items: {
              type: "object",
              properties: {
                medicao: { type: "number", description: "número da medição, sequencial por obra" },
                contrato: { type: "string", description: "número do contrato" },
                documento: { type: "string", description: "código do documento, ex: 'CT'" },
                obra: { type: "string", description: "nome (ou parte) da obra" },
                observacao: { type: "string", description: "observação gravada junto (até 300 caracteres)" },
              },
              required: ["medicao"],
            },
          },
          decisao: {
            type: "string",
            enum: ["aprovar", "reprovar"],
            description: "aprovar (padrão) ou reprovar",
          },
          observacao: { type: "string", description: "observação aplicada a todas as medições" },
          confirmar: { type: "boolean", description: "false (padrão) devolve a prévia; true grava no Sienge" },
        },
      },
    },
  ],

  handlers: {
    contratos_listar: listarContratos,
    contratos_detalhar: detalharContrato,
    contratos_decidir: decidirContratos,
    contratos_medicoes: listarMedicoesDoContrato,
    contratos_criar_medicao: criarMedicaoDeContrato,
    contratos_decidir_medicoes: decidirMedicoes,
  },
};
