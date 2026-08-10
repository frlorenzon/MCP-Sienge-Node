/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Agrupamento das tools em módulos, para que o cliente não precise carregar as
 * 108 de uma vez.
 *
 * O catálogo completo custa ~19.000 tokens de contexto em toda requisição,
 * pagos mesmo quando a conversa toca um só assunto. Cada tool recebe a tag do
 * seu módulo (via `registrarTool` em registry.js) e a visibilidade é recortada
 * de duas formas, que se combinam:
 *
 * * estática — `SIENGE_PROFILE` no ambiente fixa os módulos visíveis na subida
 *   do servidor. Funciona em qualquer cliente MCP, porque o recorte já chega
 *   pronto no primeiro `tools/list`. Sem configuração, só o núcleo sobe.
 * * dinâmica — `carregar_<modulo>` liga um módulo no meio da sessão e o SDK
 *   emite `notifications/tools/list_changed`. Depende de o cliente reagir à
 *   notificação; clientes que a ignoram ficam presos ao recorte estático, e
 *   por isso o carregamento nunca remove o que o perfil já liberou.
 *
 * `nucleo` está sempre visível: são as tools de descoberta e diagnóstico, e é
 * por elas que o modelo aprende que os demais módulos existem.
 *
 * Não há módulo de cadastros. Clientes, credores, obras e centros de custo
 * quase nunca são a pergunta — são o join que uma tool de negócio resolve por
 * dentro. Expor 24 tools para consultá-los custaria ~2.500 tokens em toda
 * requisição para entregar o que `compras_pedidos_para_aprovar` já entrega
 * resolvido. Eles vivem em `src/apis/`, que não custa contexto.
 *
 * ⚠️ O recorte dinâmico vale para o processo inteiro: `enable()`/`disable()`
 * do SDK não têm escopo de sessão. Sob transporte stdio isso não faz
 * diferença — um processo atende uma sessão. Passa a fazer se o servidor for
 * exposto por HTTP com múltiplos clientes simultâneos, cenário em que um
 * cliente que carrega um módulo o carrega para todos. Ver
 * `docs/notas-tecnicas.md`.
 */

export const CORE_MODULE = "nucleo";

/**
 * Os módulos, cada um com dois textos que têm leitores diferentes.
 *
 * `descricao` é para quem configura o servidor: explica o recorte que
 * `SIENGE_PROFILE` produz, e não custa contexto nenhum — nunca chega ao modelo.
 *
 * `chamada` é a descrição da tool `carregar_<modulo>`, e é o único texto pelo
 * qual o modelo decide carregar o módulo. Precisa dizer o que vem junto e em
 * que conversa isso serve; é cobrada em toda requisição, então cada palavra
 * paga. Reusar uma pela outra parece economia e não é: a `descricao` não tem a
 * frase-gatilho, e sem ela o módulo fica lá sem ser carregado.
 *
 * `nucleo` não tem `chamada` porque não tem carregador — está sempre visível.
 */
export const MODULES = {
  nucleo: {
    descricao:
      "Descoberta, busca genérica e diagnóstico. Sempre carregado — é o ponto " +
      "de entrada para os demais módulos.",
  },
  compras: {
    descricao:
      "Compras no nível da decisão: fila de pedidos para aprovação já com " +
      "itens, insumos e fornecedores resolvidos, histórico de preço por " +
      "insumo, aprovação de pedidos e solicitações, lançamento de nota. " +
      "Atende a maior parte das perguntas sobre compras sem `compras_api`.",
    chamada:
      "Carrega as ferramentas de compras: fila de pedidos pendentes de aprovação, " +
      "já com itens, insumos, fornecedores e obras resolvidos. Chame quando a " +
      "conversa for sobre pedidos de compra, aprovação ou fornecedores.",
  },
  compras_api: {
    descricao:
      "Compras no nível do endpoint: as consultas 1:1 com a API do Sienge — " +
      "itens avulsos, apropriações, previsões de entrega, anexos, avaliação " +
      "de fornecedor. Carregue só quando `compras` não cobrir o que precisa.",
    chamada:
      "Carrega as consultas 1:1 com a API de compras: itens avulsos, apropriações " +
      "por obra, previsões de entrega, anexos e avaliação de fornecedor. Chame " +
      "quando as ferramentas de compras não cobrirem o detalhe que a pergunta pede.",
  },
  cotacoes: {
    descricao:
      "Cotações de preço e negociação com fornecedores — etapa 3 do processo " +
      "de compras, incluindo o mapa comparativo.",
    chamada:
      "Carrega as ferramentas de cotação de preço: criação, itens, fornecedores " +
      "por item, rodadas de negociação e o mapa comparativo. Chame quando a " +
      "conversa for sobre cotar preço, comparar fornecedores ou negociar.",
  },
  financeiro: {
    descricao:
      "Contas a pagar e a receber por período, busca financeira, resumo de " +
      "dashboard e os workflows de fechamento de título.",
    chamada:
      "Carrega as ferramentas financeiras: contas a pagar e a receber por " +
      "período, busca financeira, resumo de dashboard e fechamento de título. " +
      "Chame quando a conversa for sobre pagamentos, recebimentos, vencimentos " +
      "ou saldo.",
  },
  contratos: {
    descricao:
      "Contratos de fornecimento: itens, aditivos, anexos, medições por obra " +
      "e autorização.",
    chamada:
      "Carrega as ferramentas de contrato de fornecimento: itens, aditivos, " +
      "medições por obra, anexos e autorização. Chame quando a conversa for " +
      "sobre contrato com fornecedor, aditivo ou medição.",
  },
  titulos: {
    descricao:
      "API bill-debt completa de títulos a pagar: inclusão, parcelas, " +
      "impostos, rateio por departamento/obra, pagamento e anexos.",
    chamada:
      "Carrega a API completa de títulos a pagar: inclusão e alteração de " +
      "título, parcelas, impostos, rateio por departamento e por obra, " +
      "informação de pagamento e anexos. Chame quando for preciso montar ou " +
      "alterar um título — para só consultar valores a pagar, financeiro basta.",
  },
};

/** Nome da tool que carrega um módulo. A convenção mora aqui, e só aqui. */
export function nomeDoCarregador(modulo) {
  return `carregar_${modulo}`;
}

// Cada tool aparece exatamente uma vez aqui — a checagem de completude no fim
// deste módulo lança na importação se alguma tool nova ficar sem módulo.
const TOOLS_BY_MODULE = {
  // Os `carregar_<modulo>` não entram aqui à mão: são acrescentados logo
  // abaixo, um por módulo. Escrevê-los seria manter a mesma lista em dois
  // lugares, e é sempre a segunda cópia que alguém esquece de atualizar.
  nucleo: [
    "testar_conexao",
    "chamar_api",
    "listar_endpoints_api",
    "descarregar_modulos",
    "explicar_processo_compras",
    "consultar_cota",
    "verificar_autenticacao",
  ],
  compras: [
    "compras_pedidos_para_aprovar",
    "compras_aprovar_pedidos",
    "compras_historico_preco_insumo",
    "get_sienge_purchase_orders",
    "get_sienge_purchase_requests",
    "validate_purchase_order_company",
    "authorize_purchase_order",
    "disapprove_purchase_order",
    "authorize_purchase_request",
    "disapprove_purchase_request",
    "process_purchase_invoice_pipeline",
  ],
  compras_api: [
    "get_sienge_purchase_order_items",
    "get_sienge_purchase_order_item_delivery_schedules",
    "get_sienge_purchase_order_totalization",
    "get_sienge_purchase_order_item",
    "get_sienge_purchase_order_item_buildings_appropriations",
    "get_sienge_purchase_order_item_purchase_requests",
    "get_sienge_purchase_order_direct_billing",
    "get_sienge_purchase_order_attachments",
    "download_sienge_purchase_order_attachment",
    "insert_sienge_purchase_order_attachment",
    "get_sienge_supplier_evaluation_criteria",
    "evaluate_sienge_purchase_order_supplier",
    "get_sienge_purchase_order_analysis_pdf",
    "get_sienge_purchase_request",
    "get_sienge_purchase_request_item_buildings_appropriations",
    "get_sienge_purchase_request_item_delivery_requirements",
    "get_sienge_purchase_request_attachments",
    "download_sienge_purchase_request_attachment",
    "insert_sienge_purchase_request_attachment",
    "get_sienge_purchase_invoice_items",
    "get_sienge_purchase_invoice_item_buildings_appropriations",
    "get_sienge_purchase_invoices",
    "create_sienge_purchase_invoice",
    "add_items_to_purchase_invoice",
    "get_purchase_invoice_by_sequential",
    "get_sienge_invoice_items",
    "get_sienge_purchase_request_items",
    "create_sienge_purchase_request",
    "add_items_to_purchase_request",
    "authorize_purchase_request_items",
    "authorize_purchase_request_item",
    "disapprove_purchase_request_item",
    "get_sienge_purchase_order_deliveries_attended",
  ],
  cotacoes: [
    "get_sienge_purchase_quotations",
    "create_sienge_purchase_quotation",
    "add_item_to_purchase_quotation",
    "add_purchase_request_item_to_quotation",
    "add_supplier_to_quotation_item",
    "open_quotation_negotiation",
    "update_quotation_negotiation",
    "update_quotation_negotiation_item",
    "authorize_purchase_quotation_negotiation",
    "get_sienge_quotation_comparison_map",
  ],
  financeiro: [
    "get_sienge_accounts_receivable",
    "get_sienge_accounts_receivable_by_bills",
    "get_sienge_bills",
    "get_sienge_accounts_payable_by_bills",
    "search_sienge_financial_data",
    "get_sienge_dashboard_summary",
    "create_purchase_invoice_simple",
    "ap_update_auto_bill_installments",
    "ap_finalize_bill",
    "ap_audit_bill_completeness",
  ],
  contratos: [
    "get_supply_contracts_all",
    "get_supply_contract",
    "get_supply_contract_attachments_all",
    "get_supply_contract_attachment",
    "post_supply_contract_attachment",
    "get_supply_contract_buildings",
    "get_supply_contract_addenda",
    "get_supply_contract_addendum_items",
    "get_supply_contract_items",
    "get_supply_contract_item_purchase_requests",
    "authorize_supply_contract",
    "disapprove_supply_contract",
  ],
  titulos: [
    "billdebt_get_bills_by_change_date",
    "billdebt_get_bill",
    "billdebt_insert_bill",
    "billdebt_update_bill",
    "billdebt_insert_electronic_invoice_bill",
    "billdebt_get_installments",
    "billdebt_update_installments_batch",
    "billdebt_update_installment",
    "billdebt_get_taxes",
    "billdebt_get_budget_categories",
    "billdebt_get_departments_cost",
    "billdebt_update_departments_cost",
    "billdebt_get_buildings_cost",
    "billdebt_update_buildings_cost",
    "billdebt_list_payment_forms",
    "billdebt_set_payment_information",
    "billdebt_get_payment_information",
    "billdebt_insert_attachment",
    "billdebt_get_attachments",
    "billdebt_download_attachment",
    "billdebt_get_units",
    "billdebt_update_units",
  ],
};

// Tools que respondem a mais de um assunto. `create_purchase_invoice_simple`
// mora no bloco financeiro, mas quem trabalha só com compras também precisa dela.
const CROSS_TAGS = {
  create_purchase_invoice_simple: ["compras"],
};

// Todo carregador é do núcleo — precisa estar visível justamente quando o
// módulo dele não está. `tagsFor` cairia em `nucleo` de qualquer forma, pelo
// caminho dos nomes desconhecidos, mas aí o acerto seria por acidente: o
// carregador não apareceria em `toolsIn('nucleo')` nem na contagem do catálogo.
for (const modulo of Object.keys(MODULES)) {
  if (modulo !== CORE_MODULE) TOOLS_BY_MODULE[CORE_MODULE].push(nomeDoCarregador(modulo));
}

export const TOOL_TAGS = new Map();
for (const [module, names] of Object.entries(TOOLS_BY_MODULE)) {
  for (const name of names) {
    TOOL_TAGS.set(name, new Set([module, ...(CROSS_TAGS[name] || [])]));
  }
}

// Aliases aceitos em SIENGE_PROFILE para "carregue tudo" e "carregue só o núcleo".
const ALL_ALIASES = new Set(["all", "tudo", "*", "completo", "full"]);
// Em português e em inglês: o projeto tem nomes nas duas línguas, e quem
// escreve `minimal` está pedindo a mesma coisa que quem escreve `mínimo`.
const CORE_ALIASES = new Set([
  "minimo",
  "mínimo",
  "minimal",
  "min",
  "minimum",
  "lazy",
  "nucleo",
  "núcleo",
  "core",
]);

/**
 * Tags de uma tool. Tool fora do catálogo cai em `nucleo` — sempre visível,
 * porque esconder uma tool que ninguém mapeou a tornaria inalcançável.
 */
export function tagsFor(toolName) {
  return TOOL_TAGS.get(toolName) ?? new Set([CORE_MODULE]);
}

/** Quantas tools cada módulo carrega. */
export function toolCounts() {
  return Object.fromEntries(
    Object.entries(TOOLS_BY_MODULE).map(([module, names]) => [module, names.length])
  );
}

export function toolsIn(module) {
  return TOOLS_BY_MODULE[module] ?? [];
}

/**
 * Separa nomes de módulo válidos dos desconhecidos, sem lançar exceção.
 *
 * Devolve `{validos, desconhecidos}` para que quem chama decida entre avisar
 * e abortar — o perfil estático avisa e segue, as tools dinâmicas recusam.
 */
export function normalize(requested) {
  const validos = new Set();
  const desconhecidos = [];
  for (const item of requested || []) {
    const nome = (item || "").trim().toLowerCase();
    if (!nome) continue;
    if (CORE_ALIASES.has(nome)) validos.add(CORE_MODULE);
    else if (nome in MODULES) validos.add(nome);
    else desconhecidos.push(item);
  }
  return { validos, desconhecidos };
}

/**
 * Interpreta o valor de SIENGE_PROFILE.
 *
 * Devolve `{modulos, avisos}`, em que `modulos === null` significa "sem
 * recorte, todas as tools visíveis" — o comportamento de quem não configurou
 * nada. `nucleo` é acrescentado a qualquer recorte.
 */
export function parseProfile(raw) {
  const texto = (raw || "").trim();
  // Sem configuração, só o núcleo. O padrão antigo — tudo visível — cobrava o
  // catálogo inteiro de quem nunca pediu por ele, e tornava as tools de
  // carregamento decorativas: não há o que carregar se já está tudo carregado.
  if (!texto) return { modulos: new Set([CORE_MODULE]), avisos: [] };

  const itens = texto.replace(/;/g, ",").split(",");
  if (itens.some((p) => ALL_ALIASES.has(p.trim().toLowerCase()))) {
    return { modulos: null, avisos: [] };
  }

  const { validos, desconhecidos } = normalize(itens);
  const avisos = desconhecidos.map(
    (d) =>
      `SIENGE_PROFILE: módulo desconhecido '${d}' ignorado. ` +
      `Válidos: ${Object.keys(MODULES).sort().join(", ")}.`
  );
  if (validos.size === 0) {
    // Cai no padrão, não em "tudo". Um valor não reconhecido é quase sempre
    // erro de digitação de quem queria restringir — abrir o catálogo inteiro
    // daria a esse engano mais acesso e mais custo do que não ter configurado
    // nada, que é falhar na direção errada.
    avisos.push(
      "SIENGE_PROFILE: nenhum módulo válido — subindo apenas com o núcleo, " +
        "que é o padrão. Use 'all' para carregar tudo."
    );
    return { modulos: new Set([CORE_MODULE]), avisos };
  }
  return { modulos: new Set([...validos, CORE_MODULE]), avisos };
}

/**
 * Um módulo sem descrição, um módulo sem chamada, ou uma tool em dois módulos
 * é erro de programação: lança na importação em vez de esconder tools
 * silenciosamente em produção.
 */
function assertCatalogoConsistente() {
  const semDescricao = Object.keys(TOOLS_BY_MODULE).filter((m) => !(m in MODULES));
  if (semDescricao.length) {
    throw new Error(`Módulos sem descrição em MODULES: ${semDescricao.sort().join(", ")}`);
  }

  // Sem `chamada` não há o que escrever na descrição do carregador, e o módulo
  // subiria com as tools registradas, desabilitadas e inalcançáveis — sem erro,
  // sem log, sem teste vermelho. É o modo de falha que mais custa caro aqui,
  // porque só aparece como "o modelo nunca usa essas tools".
  const semChamada = Object.entries(MODULES)
    .filter(([m, def]) => m !== CORE_MODULE && !def?.chamada)
    .map(([m]) => m);
  if (semChamada.length) {
    throw new Error(
      `Módulos sem 'chamada' em MODULES: ${semChamada.sort().join(", ")}. ` +
        "É a descrição da tool carregar_<modulo> — sem ela o módulo fica inalcançável."
    );
  }

  const vistas = new Set();
  for (const [module, names] of Object.entries(TOOLS_BY_MODULE)) {
    const repetidas = names.filter((n) => vistas.has(n));
    if (repetidas.length) {
      throw new Error(`Tools em mais de um módulo (${module}): ${repetidas.sort().join(", ")}`);
    }
    for (const n of names) vistas.add(n);
  }
}

assertCatalogoConsistente();
