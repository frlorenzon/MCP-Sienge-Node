/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo 'cadastros' — 24 tools.
 *
 * ⚠️ ESQUELETO GERADO por scripts/generate-schemas.js a partir do catálogo de
 * referência. Os schemas e as descrições estão prontos e conferem com a
 * especificação (`npm run check` verifica). Os handlers são TODO.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest, makeSiengeBulkRequest } from "../http/client.js";
import { cacheGet, cacheSet } from "../http/cache.js";
import { fetchAllPaginated } from "../http/paginate.js";

export function registrarCadastros(server) {
  registerTool(server, {
    name: "get_sienge_customers",
    description:
      "Busca clientes cadastrados no Sienge.\n" +
      "\n" +
      "⚠️ A API de clientes NÃO tem busca por nome. `search` é aplicado no\n" +
      "cliente, sobre os registros lidos — um cliente fora da página não aparece,\n" +
      "e o retorno declara isso em `busca_por_nome.ressalva`. Para busca\n" +
      "conclusiva use `cpf` ou `cnpj`, que o servidor filtra.",
    inputSchema: {
      search: z.string().describe("filtro por nome aplicado localmente (ver ressalva acima)").nullish(),
      cpf: z.string().nullish(),
      cnpj: z.string().nullish(),
      only_active: z.boolean().describe("True traz só clientes ativos").nullish(),
      enterprise_id: z.number().int().describe("restringe a um empreendimento").nullish(),
      modified_after: z.string().describe("só clientes alterados a partir da data (yyyy-MM-dd),\nútil para sincronização incremental").nullish(),
      limit: z.number().int().default(50),
      offset: z.number().int().default(0),
      fetch_all: z.boolean().describe("varre todas as páginas em vez de uma só").default(false),
      max_records: z.number().int().nullish(),
    },
    handler: async ({ search, cpf, cnpj, only_active, enterprise_id, modified_after, limit, offset, fetch_all, max_records }) => {
      // TODO: implementar — ver a especificação de get_sienge_customers no catálogo
      throw new Error("get_sienge_customers ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_creditors",
    description:
      "Busca credores/fornecedores cadastrados no Sienge.\n" +
      "\n" +
      "Diferente de clientes, esta API filtra por texto no servidor: `search`\n" +
      "procura em nome, nome fantasia ou código do credor, então não encontrar é\n" +
      "conclusivo.",
    inputSchema: {
      search: z.string().describe("nome, nome fantasia ou código — filtrado pelo servidor").nullish(),
      cpf: z.string().describe("CPF sem máscara").nullish(),
      cnpj: z.array(z.string()).describe("lista de CNPJs sem máscara; resolve vários credores numa chamada").nullish(),
      limit: z.number().int().default(50),
      offset: z.number().int().default(0),
      fetch_all: z.boolean().describe("varre todas as páginas em vez de uma só").default(false),
      max_records: z.number().int().nullish(),
    },
    handler: async ({ search, cpf, cnpj, limit, offset, fetch_all, max_records }) => {
      // TODO: implementar — ver a especificação de get_sienge_creditors no catálogo
      throw new Error("get_sienge_creditors ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_projects",
    description:
      "Busca empreendimentos/obras cadastrados no Sienge, opcionalmente filtrando por empresa.",
    inputSchema: {
      company_id: z.number().int().nullish(),
      limit: z.number().int().default(100),
    },
    handler: async ({ company_id, limit }) => {
      // TODO: implementar — ver a especificação de get_sienge_projects no catálogo
      throw new Error("get_sienge_projects ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_payment_categories",
    description:
      "Lista as categorias de plano financeiro (payment categories) cadastradas no Sienge.",
    inputSchema: {
      limit: z.number().int().default(200),
    },
    handler: async ({ limit }) => {
      // TODO: implementar — ver a especificação de get_sienge_payment_categories no catálogo
      throw new Error("get_sienge_payment_categories ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_cost_centers",
    description:
      "Lista os centros de custo cadastrados no Sienge, ordenados por código.",
    inputSchema: {
      limit: z.number().int().default(200),
      offset: z.number().int().default(0),
    },
    handler: async ({ limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_cost_centers no catálogo
      throw new Error("get_sienge_cost_centers ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_enterprise_groupings",
    description:
      "Busca os agrupamentos de unidades de um empreendimento.\n" +
      "\n" +
      "O parâmetro limit é aceito por compatibilidade de assinatura, mas a\n" +
      "consulta subjacente não pagina — retorna sempre a lista completa.",
    inputSchema: {
      enterprise_id: z.number().int(),
      limit: z.number().int().default(100),
    },
    handler: async ({ enterprise_id, limit }) => {
      // TODO: implementar — ver a especificação de get_sienge_enterprise_groupings no catálogo
      throw new Error("get_sienge_enterprise_groupings ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_customer",
    description:
      "Consulta os dados completos de um cliente pelo id.",
    inputSchema: {
      customer_id: z.number().int(),
    },
    handler: async ({ customer_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_customer no catálogo
      throw new Error("get_sienge_customer ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_customer_attachments",
    description:
      "Lista os anexos de um cliente.",
    inputSchema: {
      customer_id: z.number().int(),
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ customer_id, limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_customer_attachments no catálogo
      throw new Error("get_sienge_customer_attachments ainda não implementada");
    },
  });

  registerTool(server, {
    name: "download_sienge_customer_attachment",
    description:
      "Baixa um anexo de cliente, retornando o conteúdo em Base64.",
    inputSchema: {
      customer_id: z.number().int(),
      attachment_id: z.number().int(),
    },
    handler: async ({ customer_id, attachment_id }) => {
      // TODO: implementar — ver a especificação de download_sienge_customer_attachment no catálogo
      throw new Error("download_sienge_customer_attachment ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_creditor",
    description:
      "Consulta os dados completos de um credor pelo id.",
    inputSchema: {
      creditor_id: z.number().int(),
    },
    handler: async ({ creditor_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_creditor no catálogo
      throw new Error("get_sienge_creditor ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_creditor_bank_information",
    description:
      "Lista as contas bancárias cadastradas de um credor.",
    inputSchema: {
      creditor_id: z.number().int(),
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ creditor_id, limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_creditor_bank_information no catálogo
      throw new Error("get_sienge_creditor_bank_information ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_creditor_pix_keys",
    description:
      "Lista as chaves Pix cadastradas de um credor.\n" +
      "\n" +
      "Consulte antes de definir Pix como forma de pagamento: confere se a chave\n" +
      "a ser usada é a que consta no cadastro do credor.",
    inputSchema: {
      creditor_id: z.number().int(),
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ creditor_id, limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_creditor_pix_keys no catálogo
      throw new Error("get_sienge_creditor_pix_keys ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_enterprise",
    description:
      "Consulta os dados de um empreendimento pelo id.",
    inputSchema: {
      enterprise_id: z.number().int(),
    },
    handler: async ({ enterprise_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_enterprise no catálogo
      throw new Error("get_sienge_enterprise ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_cost_center",
    description:
      "Consulta os dados de um centro de custo pelo id.",
    inputSchema: {
      cost_center_id: z.number().int(),
    },
    handler: async ({ cost_center_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_cost_center no catálogo
      throw new Error("get_sienge_cost_center ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_cost_center_available",
    description:
      "Verifica se um centro de custo está disponível para uso.",
    inputSchema: {
      cost_center_id: z.number().int(),
    },
    handler: async ({ cost_center_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_cost_center_available no catálogo
      throw new Error("get_sienge_cost_center_available ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_cost_center_register_settings",
    description:
      "Consulta os parâmetros de cadastro imediato de um centro de custo.",
    inputSchema: {
      cost_center_id: z.number().int(),
    },
    handler: async ({ cost_center_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_cost_center_register_settings no catálogo
      throw new Error("get_sienge_cost_center_register_settings ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_payment_category",
    description:
      "Consulta uma conta do plano financeiro pelo código.\n" +
      "\n" +
      "O código é string, como \"2010101\" — é o mesmo valor usado em\n" +
      "paymentCategoriesId nas apropriações de título.",
    inputSchema: {
      payment_categories_id: z.string(),
    },
    handler: async ({ payment_categories_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_payment_category no catálogo
      throw new Error("get_sienge_payment_category ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_units",
    description:
      "Lista unidades imobiliárias — apartamentos, lotes, salas.\n" +
      "\n" +
      "Não confundir com as unidades construtivas das apropriações de obra\n" +
      "(buildingUnitId) nem com unidades de medida.",
    inputSchema: {
      enterprise_id: z.number().int().nullish(),
      name: z.string().describe("filtro por nome, aplicado pelo servidor").nullish(),
      commercial_stock: z.string().nullish(),
      additional_data: z.string().describe("\"ALL\" traz os dados complementares e aumenta bastante\na resposta; \"NONE\" omite").nullish(),
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ enterprise_id, name, commercial_stock, additional_data, limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_units no catálogo
      throw new Error("get_sienge_units ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_unit",
    description:
      "Consulta os dados de uma unidade imobiliária pelo id.",
    inputSchema: {
      unit_id: z.number().int(),
    },
    handler: async ({ unit_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_unit no catálogo
      throw new Error("get_sienge_unit ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_unit_groupings",
    description:
      "Lista os agrupamentos aos quais uma unidade pertence.",
    inputSchema: {
      unit_id: z.number().int(),
    },
    handler: async ({ unit_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_unit_groupings no catálogo
      throw new Error("get_sienge_unit_groupings ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_unit_characteristics",
    description:
      "Lista o catálogo de características de unidade.",
    inputSchema: {
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_unit_characteristics no catálogo
      throw new Error("get_sienge_unit_characteristics ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_unit_situations",
    description:
      "Lista o catálogo de situações de unidade.",
    inputSchema: {
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_unit_situations no catálogo
      throw new Error("get_sienge_unit_situations ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_unit_evaluations",
    description:
      "Lista as avaliações registradas de uma unidade.",
    inputSchema: {
      unit_id: z.number().int(),
    },
    handler: async ({ unit_id }) => {
      // TODO: implementar — ver a especificação de get_sienge_unit_evaluations no catálogo
      throw new Error("get_sienge_unit_evaluations ainda não implementada");
    },
  });

  registerTool(server, {
    name: "get_sienge_customer_types",
    description:
      "Lista os tipos de cliente cadastrados.\n" +
      "\n" +
      "Diferente de /customers, esta API filtra por `description` no servidor.",
    inputSchema: {
      description: z.string().nullish(),
      limit: z.number().int().default(100),
      offset: z.number().int().default(0),
    },
    handler: async ({ description, limit, offset }) => {
      // TODO: implementar — ver a especificação de get_sienge_customer_types no catálogo
      throw new Error("get_sienge_customer_types ainda não implementada");
    },
  });
}
