/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Modo profundo — acesso direto aos endpoints da API do Sienge.
 *
 * As tools de intenção respondem perguntas de negócio e cobrem o dia a dia.
 * Estas cobrem o resto: o endpoint específico que nenhuma delas previu, sem que
 * seja preciso carregar uma tool para cada recurso da API. Duas tools no lugar
 * de um catálogo inteiro — a diferença é de milhares de tokens em toda
 * requisição.
 *
 * O par é deliberado. `sienge_api_endpoints` responde "qual é o path", e só
 * cobra pelo recurso consultado; `sienge_api_call` executa. Sem a primeira, a
 * segunda só serviria a quem já conhece a API de cor — o modelo não tem como
 * abrir a documentação no meio de uma chamada.
 *
 * Três restrições dão a isto um custo aceitável:
 *
 * 1. **Só leitura.** Aceita apenas GET. Escrever no ERP por uma tool genérica
 *    contornaria o gate de confirmação e a validação que as tools específicas
 *    fazem — um POST montado a partir de um path adivinhado pode criar título,
 *    nota ou pagamento sem que ninguém tenha conferido nada.
 *
 * 2. **`deep_mode: true` obrigatório.** O parâmetro força o modelo a declarar
 *    que está saindo da camada de intenção de propósito. Sem ele, esta tool
 *    viraria o caminho de menor resistência e as tools de intenção — que
 *    existem justamente porque custam menos chamadas — deixariam de ser usadas.
 *
 * 3. **Path validado.** Formato fechado e sem segmentos `..`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest, makeSiengeBulkRequest } from "../http/client.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));

/** Inventário gerado por scripts/build-endpoints.js a partir de src/apis/. */
const INVENTARIO = JSON.parse(
  fs.readFileSync(path.join(aqui, "../../contract/endpoints.json"), "utf8")
);

/**
 * Paths precisam ser relativos à raiz da API; barra inicial obrigatória.
 *
 * O ponto é aceito porque aparece em identificadores, mas `..` é recusado à
 * parte: a URL final é montada por concatenação, e `fetch` normaliza o caminho
 * antes de enviar. Um `/../..` escaparia do prefixo
 * `/{subdominio}/public/api/v1` e atingiria outra rota do mesmo host.
 */
const PATH_VALIDO = /^\/[A-Za-z0-9\-_/{}.]*$/;
const PATH_COM_SUBIDA = /(^|\/)\.\.(\/|$)/;

/** Recurso-raiz de um path: "/purchase-orders/1/items" → "purchase-orders". */
function recursoDe(p) {
  return p.split("/")[1] ?? "";
}

export function registrarDeep(server) {
  registerTool(server, {
    name: "sienge_api_endpoints",
    description:
      "Lista os endpoints da API do Sienge conhecidos por este servidor, para " +
      "montar uma chamada com sienge_api_call.\n\n" +
      "Sem argumento, devolve só os nomes dos recursos. Com `recurso`, devolve os " +
      "endpoints daquele recurso — consulte assim para não pagar o inventário " +
      "inteiro por um caminho só.",
    inputSchema: {
      recurso: z
        .string()
        .nullish()
        .describe('nome do recurso, sem barra — ex: "purchase-orders", "bills"'),
    },
    handler: async ({ recurso }) => {
      if (!recurso) {
        return {
          success: true,
          recursos: Object.keys(INVENTARIO).sort(),
          observacao:
            "Chame de novo com `recurso` para ver os endpoints de um deles. " +
            "Só há aqui o que este servidor cobre — a API do Sienge tem mais.",
        };
      }

      const chave = recurso.replace(/^\//, "");
      const encontrado = INVENTARIO[chave];
      if (!encontrado) {
        return {
          success: false,
          error: `Recurso '${recurso}' não está no inventário`,
          recursos: Object.keys(INVENTARIO).sort(),
        };
      }
      // A `nota` só existe nos recursos com armadilha — tipicamente o que a
      // API não filtra. Chega aqui, no momento em que o modelo está montando
      // a chamada, e não depois de um resultado vazio que ele interpretaria
      // como "não existe".
      return {
        success: true,
        recurso: chave,
        endpoints: encontrado.endpoints,
        nota: encontrado.nota ?? null,
      };
    },
  });

  registerTool(server, {
    name: "sienge_api_call",
    description:
      "Chama um endpoint da API do Sienge diretamente, para leituras que as tools " +
      "de negócio não cobrem — anexos, apropriações, previsões de entrega e afins.\n\n" +
      "Só leitura (GET). Antes de usar, verifique se existe tool específica para o " +
      "que precisa: elas resolvem o join no servidor e custam muito menos chamadas. " +
      "Esta é o caminho para o caso não previsto, não o atalho para o caso comum.\n\n" +
      "Use sienge_api_endpoints para descobrir o path. Se errar, a resposta sugere " +
      "os endpoints daquele recurso.\n\n" +
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
    handler: async ({ path: rota, params, bulk = false }) => {
      if (!PATH_VALIDO.test(rota) || PATH_COM_SUBIDA.test(rota)) {
        return {
          success: false,
          error: "Path inválido",
          message:
            `'${rota}' não é um endpoint válido. Use um caminho relativo começando ` +
            'com barra, como "/purchase-orders/123/items". URL completa, query string ' +
            "embutida e segmentos '..' não são aceitos — os parâmetros de query vão " +
            "em `params`.",
        };
      }

      const requisitar = bulk ? makeSiengeBulkRequest : makeSiengeRequest;
      const resposta = await requisitar("GET", rota, { params: params ?? undefined });

      const base = {
        ...resposta,
        endpoint: rota,
        modo: bulk ? "bulk-data v1" : "v1",
      };

      // Um 404 quase sempre é path errado, não recurso inexistente. Devolver os
      // endpoints conhecidos daquele recurso transforma o erro em acerto na
      // próxima tentativa, sem custar uma consulta prévia em toda chamada.
      if (!resposta.success && resposta.status_code === 404) {
        const conhecido = INVENTARIO[recursoDe(rota)];
        if (conhecido) {
          return {
            ...base,
            endpoints_conhecidos: conhecido.endpoints,
            sugestao: `Confira o path contra os endpoints de '${recursoDe(rota)}' acima.`,
          };
        }
        return {
          ...base,
          recursos_conhecidos: Object.keys(INVENTARIO).sort(),
          sugestao: "Use sienge_api_endpoints para ver os endpoints de um recurso.",
        };
      }

      if (resposta.success) {
        base.aviso =
          "Resposta crua da API, sem normalização. Se esta consulta virar rotina, " +
          "vale uma tool específica para ela.";
      }
      return base;
    },
  });
}
