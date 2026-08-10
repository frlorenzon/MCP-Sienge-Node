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
import * as tagRegistry from "../modules.js";
import * as connection from "../workflows/connection.js";
import { describePurchaseProcess } from "../knowledge/purchaseProcess.js";
import { contarPorTag, enableByTags, disableByTags, registered } from "../registry.js";

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// MÓDULOS ATIVOS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// Sob stdio, um processo atende uma sessão — o estado de módulos ativos pode
// morar no processo. Ver a nota de divergência em modules.js antes de expor
// este servidor por HTTP.

let modulosAtivos = null;

/** Define o recorte inicial, aplicado por index.js a partir de SIENGE_PROFILE. */
export function definirModulosAtivos(modulos) {
  modulosAtivos = modulos === null ? new Set(Object.keys(tagRegistry.MODULES)) : new Set(modulos);
}

/**
 * Só entram no resumo os módulos que têm tools registradas. Listar um módulo
 * vazio faria o modelo carregá-lo, receber sucesso e não ganhar ferramenta
 * nenhuma — pior que não anunciá-lo.
 */
function resumoModulos(ativos) {
  const disponiveis = contarPorTag();
  return Object.entries(tagRegistry.MODULES)
    .filter(([nome]) => disponiveis[nome] > 0)
    .map(([nome, descricao]) => ({
      modulo: nome,
      descricao,
      tools: disponiveis[nome],
      carregado: ativos.has(nome),
    }));
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// REGISTRO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export function registrarNucleo(server, { perfilConfigurado }) {
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

  registerTool(server, {
    name: "list_sienge_modules",
    description:
      "Lista os módulos de tools deste servidor e quais estão carregados agora.\n\n" +
      "Consulte esta tool quando a operação que você precisa fazer no Sienge não\n" +
      "tiver uma tool correspondente na lista disponível: o servidor carrega o\n" +
      "catálogo por módulo para economizar contexto, então a tool provavelmente\n" +
      "existe mas está fora do recorte atual. `enable_sienge_modules` carrega o\n" +
      "módulo que faltar.",
    handler: async () => {
      const disponiveis = contarPorTag();
      const previstos = Object.keys(tagRegistry.MODULES).filter((m) => !disponiveis[m]);
      const resumo = resumoModulos(modulosAtivos);
      const carregados = [...modulosAtivos].filter((m) => disponiveis[m] > 0).sort();

      return {
        success: true,
        modulos: resumo,
        carregados,
        perfil_configurado:
          perfilConfigurado === null ? "todos" : [...perfilConfigurado].sort(),
        observacao:
          "Use enable_sienge_modules para carregar um módulo. O módulo " +
          `'${tagRegistry.CORE_MODULE}' está sempre carregado.`,
        // Sem isto, um módulo previsto mas ainda não implementado seria
        // indistinguível de um que simplesmente não existe — e o modelo
        // insistiria em carregá-lo.
        ...(previstos.length
          ? {
              modulos_previstos: previstos.sort(),
              aviso_de_versao:
                `Esta versão do servidor implementa ${resumo.length} de ` +
                `${Object.keys(tagRegistry.MODULES).length} módulos. Os listados em ` +
                "`modulos_previstos` ainda não têm tools e não podem ser carregados.",
            }
          : {}),
      };
    },
  });

  registerTool(server, {
    name: "enable_sienge_modules",
    description:
      "Carrega as tools de um ou mais módulos do Sienge nesta sessão.\n\n" +
      "Módulos: cadastros (clientes, credores, empreendimentos, centros de custo,\n" +
      "unidades), compras (solicitações, pedidos e notas fiscais de compra),\n" +
      "cotacoes (cotações e negociação), financeiro (contas a pagar/receber e\n" +
      "dashboard), contratos (contratos de fornecimento), titulos (API bill-debt\n" +
      "de títulos a pagar).\n\n" +
      "As tools carregadas passam a aparecer na lista de ferramentas disponíveis.\n" +
      "Carregue os módulos de que precisa de uma vez só — cada módulo carregado\n" +
      "ocupa contexto pelo resto da conversa.",
    inputSchema: { modules: z.array(z.string()) },
    handler: async ({ modules }) => {
      const { validos, desconhecidos } = tagRegistry.normalize(modules);
      if (desconhecidos.length) {
        return {
          success: false,
          error: `Módulo desconhecido: ${desconhecidos.join(", ")}`,
          modulos_validos: Object.keys(tagRegistry.MODULES).sort(),
        };
      }
      if (validos.size === 0) {
        return { success: false, error: "Informe ao menos um módulo em `modules`." };
      }

      // Um módulo previsto no catálogo mas sem tools registradas seria
      // "carregado" com sucesso e não traria ferramenta alguma. Recusar é o
      // que impede o modelo de insistir numa capacidade que esta versão do
      // servidor não tem.
      const disponiveis = contarPorTag();
      const semTools = [...validos].filter((m) => !disponiveis[m]);
      if (semTools.length) {
        return {
          success: false,
          error:
            `Módulo não disponível nesta versão do servidor: ${semTools.sort().join(", ")}. ` +
            "Está previsto no catálogo, mas ainda não tem tools implementadas.",
          modulos_disponiveis: Object.keys(disponiveis).sort(),
        };
      }

      modulosAtivos = new Set([...modulosAtivos, ...validos]);
      enableByTags(validos);

      return {
        success: true,
        carregados_agora: [...validos].sort(),
        tools_adicionadas: [...validos].reduce((soma, m) => soma + (disponiveis[m] ?? 0), 0),
        modulos_carregados: [...modulosAtivos].filter((m) => disponiveis[m] > 0).sort(),
      };
    },
  });

  registerTool(server, {
    name: "disable_sienge_modules",
    description:
      "Descarrega as tools de um ou mais módulos do Sienge nesta sessão, liberando\n" +
      "o contexto que elas ocupavam.\n\n" +
      "O módulo 'nucleo' não pode ser descarregado — é por ele que os demais\n" +
      "voltam a ser carregados.",
    inputSchema: { modules: z.array(z.string()) },
    handler: async ({ modules }) => {
      const { validos, desconhecidos } = tagRegistry.normalize(modules);
      if (desconhecidos.length) {
        return {
          success: false,
          error: `Módulo desconhecido: ${desconhecidos.join(", ")}`,
          modulos_validos: Object.keys(tagRegistry.MODULES).sort(),
        };
      }

      const alvo = new Set([...validos].filter((m) => m !== tagRegistry.CORE_MODULE));
      if (alvo.size === 0) {
        return {
          success: false,
          error: `Nada a descarregar — '${tagRegistry.CORE_MODULE}' é permanente.`,
        };
      }

      modulosAtivos = new Set([...modulosAtivos].filter((m) => !alvo.has(m)));
      disableByTags(alvo);
      // Tools com mais de uma tag (ex.: create_purchase_invoice_simple, em
      // financeiro e compras) seriam derrubadas junto pelo passo acima.
      // Reafirmar os módulos que continuam ativos as traz de volta, porque a
      // última regra de visibilidade é a que vale.
      if (modulosAtivos.size) enableByTags(modulosAtivos);

      return {
        success: true,
        descarregados: [...alvo].sort(),
        modulos_carregados: [...modulosAtivos].sort(),
      };
    },
  });

  return registered;
}
