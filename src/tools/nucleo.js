/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * As tools do módulo `nucleo` — descoberta, busca genérica e diagnóstico.
 *
 * Este módulo está sempre visível: é por ele que o modelo descobre que os
 * demais existem. As descrições aqui não são documentação — são o texto que o
 * modelo lê para decidir qual tool chamar, e por isso cada palavra pesa.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { fastConnectionProbe } from "../http/client.js";
import { getAuthInfo } from "../config.js";
import * as apiQuota from "../utils/apiQuota.js";
import * as connection from "../workflows/connection.js";
import { describePurchaseProcess } from "../knowledge/purchaseProcess.js";

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// REGISTRO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export function registrarNucleo(server) {
  // ---------- Diagnóstico ----------

  registerTool(server, {
    name: "test_sienge_connection",
    description:
      "Testa se as credenciais autenticam de fato contra a API do Sienge, com uma " +
      "chamada real de baixo custo. Use para diagnosticar falha de conexão ou " +
      "credencial; para apenas ver qual mecanismo está configurado, sem chamar a " +
      "API, use get_auth_info.",
    // Latência e id da requisição são o resultado desta tool, não ruído de
    // diagnóstico a ser podado.
    manterMetadados: true,
    handler: () =>
      connection.testSiengeConnection(fastConnectionProbe, {
        SIENGE_API_KEY: process.env.SIENGE_API_KEY,
        SIENGE_USERNAME: process.env.SIENGE_USERNAME,
        SIENGE_PASSWORD: process.env.SIENGE_PASSWORD,
      }),
  });

  registerTool(server, {
    name: "get_auth_info",
    description:
      "Mostra qual mecanismo de autenticação está configurado (Bearer Token ou " +
      "Basic Auth) e se as credenciais estão completas. Não chama a API — para " +
      "verificar se elas de fato funcionam, use test_sienge_connection.",
    handler: async () => getAuthInfo(),
  });

  registerTool(server, {
    name: "get_sienge_api_quota",
    // Os números por pacote saíram daqui de propósito: a resposta traz a tabela
    // completa em `pacotes_disponiveis`, e mantê-los também na descrição é
    // pagá-los em toda requisição para entregar o que a chamada já entrega.
    description:
      "Mostra o consumo e o saldo das cotas diárias da API do Sienge, que são duas " +
      "e independentes: REST, larga, e BULK, estreita. Contas a pagar, contas a " +
      "receber e itens de nota em volume consomem BULK, e é ela que esgota " +
      "primeiro. Consulte antes de uma sequência dessas consultas. O saldo só é " +
      "calculado com SIENGE_MCP_API_PACKAGE configurada.",
    handler: async () => apiQuota.situacaoDasCotas(),
  });

  // ---------- Conhecimento ----------

  registerTool(server, {
    name: "describe_purchase_process",
    description:
      // Os dois exemplos concretos no fim custam ~35 tokens e ficam de
      // propósito: são eles que fazem o modelo chamar esta tool ANTES de
      // errar. Uma tool de conhecimento que não é invocada no momento certo
      // custa contexto e não entrega nada.
      "Explica o processo de compras do Sienge de ponta a ponta: as 5 etapas, quais\n" +
      "são opcionais, os caminhos válidos e os limites da API.\n\n" +
      "Consulte ANTES de responder qualquer pergunta sobre solicitações, cotações,\n" +
      "pedidos de compra ou aprovações. Evita os erros mais comuns — procurar preço\n" +
      "numa solicitação de compra, que não tem preço, ou supor que todo pedido\n" +
      "nasceu de uma solicitação.",
    handler: () => describePurchaseProcess(),
  });

  // ---------- Busca e paginação ----------
  //
  // Não há tool para listar as entidades consultáveis: a informação que ela
  // daria — o alcance da busca em cada entidade — já viaja no resultado de
  // search_sienge_data e get_sienge_data_paginated, anexada a cada resposta.
  // Chega no momento em que importa, sem depender de o modelo lembrar de
  // consultar um catálogo antes, e sem custar contexto em toda requisição.

  // ---------- Módulos de tools ----------

}
