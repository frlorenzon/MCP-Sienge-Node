/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Modo profundo — acesso direto aos endpoints da API do Sienge.
 *
 * As tools de intenção respondem perguntas de negócio e cobrem o dia a dia.
 * Esta cobre o resto: o endpoint específico que nenhuma delas previu, sem que
 * seja preciso implementar e carregar uma tool para cada um dos ~130 recursos
 * da API. Uma tool no lugar de um catálogo inteiro — a diferença é de milhares
 * de tokens em toda requisição.
 *
 * Duas restrições dão a ela um custo aceitável:
 *
 * 1. **Só leitura.** Aceita apenas GET. Escrever no ERP por uma tool genérica
 *    contornaria o gate de confirmação e a validação que as tools específicas
 *    fazem — um POST montado a partir de um path adivinhado pode criar título,
 *    nota ou pagamento sem que ninguém tenha conferido nada. Operações de
 *    escrita continuam sendo tools próprias, com confirmação explícita.
 *
 * 2. **`deep_mode: true` obrigatório.** Não é burocracia: o parâmetro força o
 *    modelo a declarar que está saindo da camada de intenção de propósito.
 *    Sem ele, esta tool viraria o caminho de menor resistência e as tools de
 *    intenção — que existem justamente porque custam menos chamadas — deixariam
 *    de ser usadas.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest, makeSiengeBulkRequest } from "../http/client.js";

/**
 * Paths precisam ser relativos à raiz da API; barra inicial obrigatória.
 *
 * O ponto é aceito porque aparece em identificadores (documentos, versões),
 * mas `..` é recusado à parte: a URL final é montada por concatenação, e
 * `fetch` normaliza o caminho antes de enviar. Um `/../..` escaparia do
 * prefixo `/{subdominio}/public/api/v1` e atingiria outra rota do mesmo host —
 * não é travessia de sistema de arquivos, mas é sair do escopo declarado.
 */
const PATH_VALIDO = /^\/[A-Za-z0-9\-_/{}.]*$/;
const PATH_COM_SUBIDA = /(^|\/)\.\.(\/|$)/;

export function registrarDeep(server) {
  registerTool(server, {
    name: "sienge_api_call",
    description:
      "Chama um endpoint da API do Sienge diretamente, para leituras que as tools " +
      "de negócio não cobrem — anexos, apropriações, previsões de entrega, " +
      "avaliação de fornecedor e afins.\n\n" +
      "Só leitura (GET). Antes de usar, verifique se existe tool específica para o " +
      "que precisa: elas resolvem o join no servidor e custam muito menos chamadas. " +
      "Esta é o caminho para o caso não previsto, não o atalho para o caso comum.\n\n" +
      "`path` é relativo à raiz da API e começa com barra: \"/purchase-orders/123/items\", " +
      "\"/creditors/45\", \"/cost-centers\". A documentação dos endpoints está em " +
      "https://api.sienge.com.br/docs.\n\n" +
      "Exige deep_mode: true.",
    inputSchema: {
      path: z
        .string()
        .describe('endpoint relativo, começando com barra — ex: "/purchase-orders/123/items"'),
      params: z
        .record(z.string(), z.any())
        .nullish()
        .describe("parâmetros de query, incluindo limit/offset quando o endpoint pagina"),
      bulk: z
        .boolean()
        .default(false)
        .describe(
          "usa a API bulk-data em vez da v1. A cota BULK é diária e estreita (10 a 200/dia) — só use quando o endpoint exigir"
        ),
      deep_mode: z
        .literal(true)
        .describe(
          "confirma que a chamada crua é intencional e que nenhuma tool específica cobre o caso"
        ),
    },
    handler: async ({ path, params, bulk = false }) => {
      if (!PATH_VALIDO.test(path) || PATH_COM_SUBIDA.test(path)) {
        return {
          success: false,
          error: "Path inválido",
          message:
            `'${path}' não é um endpoint válido. Use um caminho relativo começando ` +
            'com barra, como "/purchase-orders/123/items". URL completa, query string ' +
            "embutida e segmentos '..' não são aceitos — os parâmetros de query vão " +
            "em `params`.",
        };
      }

      const requisitar = bulk ? makeSiengeBulkRequest : makeSiengeRequest;
      const resposta = await requisitar("GET", path, { params: params ?? undefined });

      // O envelope da camada HTTP traz `data` cru. Reetiquetar para deixar
      // explícito de onde veio: uma resposta desta tool não passou por
      // nenhuma normalização, e quem a lê precisa saber disso.
      return {
        ...resposta,
        endpoint: path,
        modo: bulk ? "bulk-data v1" : "v1",
        aviso:
          "Resposta crua da API, sem normalização. Se esta consulta virar " +
          "rotina, vale uma tool específica para ela.",
      };
    },
  });
}
