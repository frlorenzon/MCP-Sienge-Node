/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo de compras.
 *
 * Este arquivo só é importado quando `carregar_compras` é chamada — é essa a
 * diferença entre o módulo custar tokens e não custar. Nada aqui roda na
 * subida do servidor.
 */

import {
  listarPedidosParaAprovacao,
  listarPedidosPendentesRecebimento,
  listarSolicitacoesParaAprovacao,
  criarSolicitacaoDeCompra,
} from "../client/purchaseClient.js";
import { descreverProcessoDeCompras } from "../knowledge/purchaseProcess.js";

export const purchaseModule = {
  tools: [
    {
      // Sem parâmetros de propósito: quem lê só uma etapa volta a cometer
      // exatamente os erros que o módulo existe pra evitar — os enganos vêm
      // de não saber a ORDEM, não de não conhecer uma etapa isolada.
      name: "compras_processo",
      description:
        "O processo de compras do Sienge em seis etapas: o que acontece em cada " +
        "uma, em que ordem, de quem é a vez e o que este servidor NÃO cobre. Não " +
        "chama a API. Consulte antes de interpretar, explicar ou agir sobre " +
        "qualquer registro de compras — em especial quando faltar preço, quando um " +
        "pedido não tiver solicitação por trás, ou quando algo estiver parado " +
        "aguardando aprovação.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      // Schema enxuto de propósito: ele custa tokens em TODA requisição,
      // enquanto o trabalho de resolver os nomes é de graça, porque roda no
      // servidor. Daí a tool aceitar os nomes que a pessoa fala e não pedir
      // nenhum id — resolver obra, insumo, detalhe e item de orçamento numa
      // sequência de tools faria cada passo reenviar a conversa inteira.
      name: "compras_criar_solicitacao",
      description:
        "Cria uma solicitação de compra (etapa 1) a partir de NOMES — obra, insumo, " +
        "detalhe e itens de orçamento —, resolvendo todos os códigos internamente. " +
        "Não peça ids ao usuário nem os busque com outras tools. UMA solicitação " +
        "comporta VÁRIOS insumos: mande todos em `itens` numa chamada só, nunca uma " +
        "chamada por insumo — isso criaria várias solicitações soltas. Sem " +
        "confirmar: true ela apenas devolve a prévia, sem gravar; mostre a prévia, " +
        "obtenha o aval do usuário e chame de novo com os MESMOS argumentos mais " +
        "confirmar: true. Nome ambíguo ou dado faltando volta com todas as " +
        "pendências de uma vez, cada uma dizendo a qual item pertence. NUNCA invente " +
        "a unidade de medida: chame sem quantidade e a tool responde em que unidade " +
        "cada insumo é solicitado. Criar NÃO aprova.",
      inputSchema: {
        type: "object",
        properties: {
          obra: { type: "string", description: "nome (ou parte) da obra" },
          itens: {
            type: "array",
            description: "os insumos pedidos; uma solicitação comporta vários",
            items: {
              type: "object",
              properties: {
                insumo: { type: "string", description: "nome do insumo, ex: 'tubo de esgoto'" },
                quantidade: {
                  type: "number",
                  description:
                    "quantidade NA UNIDADE DO INSUMO; omita para descobrir qual é essa unidade",
                },
                detalhe: { type: "string", description: "detalhe do insumo, ex: '2\"'" },
                unidade: {
                  type: "string",
                  description:
                    "unidade em que você entendeu a quantidade; divergindo do cadastro, vira aviso",
                },
                apropriacoes: {
                  type: "array",
                  description: "rateio só deste item; omita para usar o da solicitação",
                  items: {
                    type: "object",
                    properties: {
                      item: { type: "string" },
                      percentual: { type: "number" },
                    },
                    required: ["item", "percentual"],
                  },
                },
                observacao: { type: "string" },
              },
              required: ["insumo"],
            },
          },
          apropriacoes: {
            type: "array",
            description:
              "rateio por item de orçamento, somando 100, válido para todos os itens que " +
              "não trouxerem o seu",
            items: {
              type: "object",
              properties: {
                item: { type: "string", description: "nome do item de orçamento" },
                percentual: { type: "number" },
              },
              required: ["item", "percentual"],
            },
          },
          unidade_construtiva: {
            type: "number",
            description: "código da unidade construtiva; 1 (custo de obra) se omitido",
          },
          dias_para_entrega: {
            type: "number",
            description: "prazo da necessidade de entrega; 7 dias se omitido",
          },
          observacao: { type: "string", description: "observação da solicitação" },
          confirmar: {
            type: "boolean",
            description: "false (padrão) devolve a prévia; true grava no Sienge",
          },
        },
        required: ["obra", "itens"],
      },
    },
    {
      name: "compras_solicitacoes_para_aprovacao",
      description:
        "Lista as SOLICITAÇÕES de compra pendentes de aprovação (etapa 2 do " +
        "processo), agrupadas por solicitação, com obra, solicitante, data e os " +
        "itens pendentes de cada uma já resolvidos. Solicitação é o pedido INTERNO " +
        "de quem precisa do insumo, sem preço; não confundir com o PEDIDO DE COMPRA, " +
        "a ordem ao fornecedor, que é compras_pedidos_para_aprovacao. A aprovação no " +
        "Sienge é item a item: cada entrada é uma solicitação com ao menos um item " +
        "pendente, e os itens listados são só os que faltam decidir. NÃO há preço " +
        "nesta etapa — a solicitação registra insumo, quantidade e unidade, não valor.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "compras_pedidos_para_aprovacao",
      description:
        "Lista os PEDIDOS de compra pendentes de aprovação — a ordem ao fornecedor, " +
        "com preço e condições (etapa 5). Para a solicitação interna que antecede o " +
        "pedido, sem preço, use compras_solicitacoes_para_aprovacao. " +
        "Filtra por (authorized: false, " +
        "descartando os já reprovados), com os itens e o fornecedor de cada pedido já " +
        "resolvidos — não é preciso chamar nada mais pra ver o que está sendo comprado " +
        "e de quem. A limitação é que o pedido a ser aprovado deve estar entre os 100 ultimos pedidos.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "compras_pedidos_pendentes_recebimento",
      description:
        "Lista os pedidos de compra já aprovados que ainda faltam ser entregues " +
        "(total ou parcialmente), com itens, fornecedor e obra de cada pedido já " +
        "resolvidos. EXIGE obra ou fornecedor por NOME (não ID) — ao menos um dos " +
        "dois; sem isso a busca varreria centenas de pedidos. Se o nome bater em mais " +
        "de uma obra/fornecedor, a tool devolve os candidatos em vez de escolher um " +
        "sozinha — peça pra escolher e chame de novo com o nome mais específico. Item " +
        "é opcional, se somado a um dos dois: busca textual (ex: 'argamassa' encontra " +
        "'Argamassa de Reboco', 'Argamassa Colante' etc.) que descarta pedidos sem " +
        "nenhum item batendo.",
      inputSchema: {
        type: "object",
        properties: {
          building: { type: "string", description: "nome (ou parte) da obra" },
          supplier: { type: "string", description: "nome (ou parte) do fornecedor" },
          item: { type: "string", description: "busca textual no nome ou detalhe do insumo" },
        },
      },
    },
  ],

  handlers: {
    compras_processo: descreverProcessoDeCompras,
    compras_criar_solicitacao: criarSolicitacaoDeCompra,
    compras_solicitacoes_para_aprovacao: listarSolicitacoesParaAprovacao,
    compras_pedidos_para_aprovacao: listarPedidosParaAprovacao,
    compras_pedidos_pendentes_recebimento: listarPedidosPendentesRecebimento,
  },
};
