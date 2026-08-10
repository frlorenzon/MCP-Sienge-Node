/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Carregamento de módulos sob demanda.
 *
 * Uma tool por módulo, sem parâmetro, em vez de uma tool genérica que recebe
 * o nome do módulo. A diferença não é estética: com nomes próprios, a lista de
 * ferramentas já é o catálogo — o modelo lê `carregar_compras` e sabe o que
 * faz, sem precisar de uma consulta prévia para descobrir que módulos existem.
 * E a descrição faz trabalho dobrado, porque o texto que explica o módulo é o
 * mesmo que leva o modelo a chamá-lo.
 *
 * Só existe tool para módulo que tem tools. Anunciar `carregar_financeiro`
 * antes de haver algo em financeiro seria pagar contexto para dizer "ainda
 * não" — o mesmo defeito que a checagem de módulos vazios corrigiu antes.
 */

import { z } from "zod";
import { registerTool, contarPorTag, enableByTags, disableByTags } from "../registry.js";
import * as tagRegistry from "../modules.js";

/**
 * Módulos carregados nesta sessão. Sob stdio, um processo atende uma sessão —
 * ver a nota sobre escopo em modules.js antes de expor o servidor por HTTP.
 */
let carregados = new Set([tagRegistry.CORE_MODULE]);

/** Define o recorte inicial, aplicado por index.js a partir de SIENGE_PROFILE. */
export function definirModulosCarregados(modulos) {
  carregados = modulos === null ? new Set(Object.keys(tagRegistry.MODULES)) : new Set(modulos);
}

export function modulosCarregados() {
  return new Set(carregados);
}

/**
 * Registra a tool de carregamento de um módulo.
 *
 * @param {object} server
 * @param {string} modulo tag do módulo em modules.js
 * @param {string} descricao o que o módulo traz — é o que o modelo lê para decidir
 */
function registrarCarregador(server, modulo, descricao) {
  registerTool(server, {
    name: `carregar_${modulo}`,
    description: descricao,
    handler: async () => {
      const disponiveis = contarPorTag();
      const quantas = disponiveis[modulo] ?? 0;
      if (quantas === 0) {
        return {
          success: false,
          error: `O módulo '${modulo}' não tem tools nesta versão do servidor.`,
        };
      }

      const jaEstava = carregados.has(modulo);
      carregados.add(modulo);
      enableByTags(new Set([modulo]));

      return {
        success: true,
        modulo,
        tools_disponiveis: quantas,
        ja_estava_carregado: jaEstava || undefined,
        modulos_carregados: [...carregados].filter((m) => disponiveis[m] > 0).sort(),
      };
    },
  });
}

export function registrarModulos(server) {
  registrarCarregador(
    server,
    "compras",
    "Carrega as ferramentas de compras: fila de pedidos pendentes de aprovação, " +
      "já com itens, insumos, fornecedores e obras resolvidos. Chame quando a " +
      "conversa for sobre pedidos de compra, aprovação ou fornecedores."
  );

  registerTool(server, {
    name: "descarregar_modulos",
    description:
      "Descarrega módulos já carregados, liberando o contexto que as tools deles " +
      "ocupam nas próximas mensagens. Útil numa conversa longa que mudou de " +
      "assunto. O núcleo nunca é descarregado.",
    inputSchema: {
      modulos: z
        .array(z.string())
        .describe("nomes dos módulos, como aparecem em `modulos_carregados`"),
    },
    handler: async ({ modulos }) => {
      const { validos, desconhecidos } = tagRegistry.normalize(modulos);
      if (desconhecidos.length) {
        return {
          success: false,
          error: `Módulo desconhecido: ${desconhecidos.join(", ")}`,
          modulos_carregados: [...carregados].sort(),
        };
      }

      const alvo = new Set([...validos].filter((m) => m !== tagRegistry.CORE_MODULE));
      if (alvo.size === 0) {
        return {
          success: false,
          error: `Nada a descarregar — '${tagRegistry.CORE_MODULE}' é permanente.`,
        };
      }

      carregados = new Set([...carregados].filter((m) => !alvo.has(m)));
      disableByTags(alvo);
      // Tools com mais de uma tag seriam derrubadas junto pelo passo acima;
      // reafirmar o que continua ativo as traz de volta.
      if (carregados.size) enableByTags(carregados);

      const disponiveis = contarPorTag();
      return {
        success: true,
        descarregados: [...alvo].sort(),
        modulos_carregados: [...carregados].filter((m) => disponiveis[m] > 0).sort(),
      };
    },
  });
}
