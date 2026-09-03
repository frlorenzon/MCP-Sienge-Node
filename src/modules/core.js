/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Núcleo — o único módulo que sobe junto com o servidor e nunca é
 * descarregado. É onde moram as tools de diagnóstico: sem elas carregadas por
 * padrão, uma configuração errada deixaria o servidor sem nada capaz de dizer
 * o que está errado.
 *
 * CONTRATO DE MÓDULO, o mesmo para todos:
 *
 *   tools    — o que entra no `tools/list` enquanto o módulo está carregado.
 *              `inputSchema` é JSON Schema, que é o que trafega no protocolo.
 *   handlers — mapa nome → função. Recebe os argumentos já conferidos contra o
 *              schema pelo roteador e devolve um objeto comum; embrulhar isso
 *              no envelope do MCP é trabalho do roteador, não daqui.
 *
 * O roteador recusa a carga de um módulo que declare uma tool sem handler, ou
 * uma tool cujo nome já venha de outro módulo.
 */

import { getAuthInfo } from "../config.js";
import { testarConexao } from "../client/siengeClient.js";

const SUBIU_EM = Date.now();

export const coreModule = {
  tools: [
    {
      name: "status_servidor",
      description:
        "Informa que o servidor MCP do Sienge está no ar e há quanto tempo. " +
        "Use para confirmar que a conexão com o servidor funciona.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "testar_conexao",
      description:
        "Testa se as credenciais autenticam de fato contra a API do Sienge, com uma " +
        "chamada real de baixo custo. Use para diagnosticar falha de conexão ou " +
        "credencial; para apenas ver qual mecanismo está configurado, sem chamar a " +
        "API, use verificar_autenticacao.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "verificar_autenticacao",
      description:
        "Mostra qual mecanismo de autenticação está configurado (Bearer Token ou " +
        "Basic Auth) e se as credenciais estão completas. Não chama a API — para " +
        "verificar se elas de fato funcionam, use testar_conexao.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  handlers: {
    async status_servidor() {
      return {
        success: true,
        servidor: "Sienge API Integration 🏗️ - Node",
        no_ar_ha_segundos: Math.round((Date.now() - SUBIU_EM) / 1000),
      };
    },
    testar_conexao: testarConexao,
    async verificar_autenticacao() {
      const info = getAuthInfo();
      return { success: info.configured, ...info };
    },
  },
};
