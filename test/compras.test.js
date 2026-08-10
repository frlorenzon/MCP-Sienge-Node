/**
 * A camada de intenção de compras e o modo profundo.
 *
 * O que se verifica aqui não é "chamou a API", e sim que a travessia produz a
 * projeção certa — catálogos laterais sem repetição, alertas nos pedidos certos,
 * ordem de leitura — e que o modo profundo não vira porta de escrita.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.SIENGE_MCP_HOME = "/tmp/sienge-mcp-test";
process.env.SIENGE_API_KEY = "chave-de-teste";
process.env.SIENGE_SUBDOMAIN = "empresa";
// As tools do modo profundo só são registradas quando ele está habilitado.
process.env.SIENGE_DEEP_MODE = "on";
process.env.SIENGE_PROFILE = "compras";

const purchaseApproval = await import("../src/workflows/purchaseApproval.js");

/**
 * make_request falso que responde por rota, no formato do envelope da camada
 * HTTP. Registra as chamadas para que o teste possa afirmar quantas foram.
 */
function requestFalso(rotas) {
  const chamadas = [];
  const fn = async (method, endpoint) => {
    chamadas.push(`${method} ${endpoint}`);
    for (const [padrao, data] of Object.entries(rotas)) {
      if (new RegExp(`^${padrao}$`).test(endpoint)) {
        return { success: true, data, latency_ms: 1, request_id: "t" };
      }
    }
    return { success: false, error: "HTTP 404", message: `sem rota falsa para ${endpoint}` };
  };
  fn.chamadas = chamadas;
  return fn;
}

const paginado = (results, extra = {}) => ({
  results,
  resultSetMetadata: { count: results.length, offset: 0, limit: 100, ...extra },
});

test("fila de aprovação resolve nomes e monta catálogos laterais", async () => {
  const req = requestFalso({
    "/purchase-orders": paginado([
      { purchaseOrderId: 1, date: "2026-07-01", supplierId: 10, buildingId: 20 },
      { purchaseOrderId: 2, date: "2026-07-02", supplierId: 10, buildingId: 20 },
    ]),
    "/purchase-orders/1/items": paginado([
      { productId: 100, quantity: 2, unitPrice: 50, unitOfMeasure: "UN", totalPrice: 100, resourceDescription: "Cimento CP-II" },
    ]),
    "/purchase-orders/2/items": paginado([
      { productId: 100, quantity: 1, unitPrice: 50, unitOfMeasure: "UN", totalPrice: 50, resourceDescription: "Cimento CP-II" },
    ]),
    "/creditors/10": { id: 10, name: "FORNECEDOR ALFA LTDA" },
    "/cost-centers/20": { id: 20, name: "OBRA CENTRO" },
  });

  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});

  assert.equal(r.success, true);
  assert.equal(r.totais.pedidos, 2);
  assert.equal(r.totais.valor, 150);

  // O ponto do desenho: fornecedor e obra citados por dois pedidos são
  // resolvidos UMA vez, e escritos uma vez só nos catálogos laterais.
  assert.deepEqual(r.fornecedores, { 10: "FORNECEDOR ALFA LTDA" });
  assert.deepEqual(r.obras, { 20: "OBRA CENTRO" });
  assert.deepEqual(r.insumos, { 100: "Cimento CP-II" });

  const chamadasDeCredor = req.chamadas.filter((c) => c.includes("/creditors/")).length;
  assert.equal(chamadasDeCredor, 1, "o mesmo fornecedor não pode ser buscado duas vezes");

  // Nas linhas, só os ids — o nome está no catálogo lateral.
  assert.equal(r.pedidos[0].fornecedor, 10);
  assert.equal(r.pedidos[0].itens[0].insumo, 100);
});

test("alerta de preço acima do menor do lote", async () => {
  const req = requestFalso({
    "/purchase-orders": paginado([
      { purchaseOrderId: 1, supplierId: 10, buildingId: 20 },
      { purchaseOrderId: 2, supplierId: 10, buildingId: 20 },
    ]),
    "/purchase-orders/1/items": paginado([
      { productId: 100, quantity: 1, unitPrice: 100, totalPrice: 100 },
    ]),
    // 50% acima do menor preço do mesmo insumo neste lote
    "/purchase-orders/2/items": paginado([
      { productId: 100, quantity: 1, unitPrice: 150, totalPrice: 150, itemNumber: 1 },
    ]),
    "/creditors/10": { id: 10, name: "ALFA" },
    "/cost-centers/20": { id: 20, name: "OBRA" },
  });

  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  const caro = r.pedidos.find((p) => p.pedido === 2);
  assert.ok(
    caro.alertas.some((a) => /acima do menor preço do lote/.test(a)),
    `esperava alerta de preço, veio: ${JSON.stringify(caro.alertas)}`
  );
  // Quem tem alerta vem primeiro: é a ordem em que um comprador olha a fila.
  assert.equal(r.pedidos[0].pedido, 2);
});

test("valor acima do limiar vira alerta", async () => {
  const req = requestFalso({
    "/purchase-orders": paginado([{ purchaseOrderId: 1, supplierId: 10, buildingId: 20 }]),
    "/purchase-orders/1/items": paginado([
      { productId: 1, quantity: 1, unitPrice: 999999, totalPrice: 999999 },
    ]),
    "/creditors/10": { id: 10, name: "ALFA" },
    "/cost-centers/20": { id: 20, name: "OBRA" },
  });
  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  assert.ok(r.pedidos[0].alertas.some((a) => /acima do limiar/.test(a)));
});

test("fornecedor não encontrado é sinalizado, não silenciado", async () => {
  const req = requestFalso({
    "/purchase-orders": paginado([{ purchaseOrderId: 1, supplierId: 99, buildingId: 20 }]),
    "/purchase-orders/1/items": paginado([{ productId: 1, quantity: 1, unitPrice: 10 }]),
    "/cost-centers/20": { id: 20, name: "OBRA" },
    // /creditors/99 não existe nas rotas — a busca falha
  });
  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  assert.ok(r.pedidos[0].alertas.some((a) => /fornecedor não encontrado/.test(a)));
});

test("pedido cujos itens falharam não some — entra em pedidos_nao_lidos", async () => {
  const req = requestFalso({
    "/purchase-orders": paginado([
      { purchaseOrderId: 1, supplierId: 10, buildingId: 20 },
      { purchaseOrderId: 2, supplierId: 10, buildingId: 20 },
    ]),
    "/purchase-orders/1/items": paginado([{ productId: 1, quantity: 1, unitPrice: 10 }]),
    // /purchase-orders/2/items falha
    "/creditors/10": { id: 10, name: "ALFA" },
    "/cost-centers/20": { id: 20, name: "OBRA" },
  });
  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  assert.equal(r.pedidos_nao_lidos.length, 1);
  assert.match(r.cobertura, /não tiveram os itens lidos/);
});

test("fila vazia responde sem gastar chamada de item", async () => {
  const req = requestFalso({ "/purchase-orders": paginado([]) });
  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  assert.equal(r.success, true);
  assert.equal(r.totais.pedidos, 0);
  assert.equal(req.chamadas.length, 1);
});

test("diagnóstico denuncia nome de campo que não existe no DTO", async () => {
  // Se a API renomear os campos, a leitura defensiva devolve null e o dado
  // "some". O diagnóstico é o que transforma isso num erro visível.
  const req = requestFalso({
    "/purchase-orders": paginado([{ purchaseOrderId: 1, supplierId: 10, buildingId: 20 }]),
    "/purchase-orders/1/items": paginado([
      { codigoDoInsumo: 1, quantidade: 2, valorUnitario: 10 },
    ]),
    "/creditors/10": { id: 10, name: "ALFA" },
    "/cost-centers/20": { id: 20, name: "OBRA" },
  });
  const r = await purchaseApproval.analisarPedidosParaAprovacao(req, {}, {});
  assert.ok(r._diagnostico, "campos irreconhecíveis precisam ser denunciados");
  assert.deepEqual(r._diagnostico.campos_reais_do_item, [
    "codigoDoInsumo",
    "quantidade",
    "valorUnitario",
  ]);
  assert.match(r._diagnostico.acao_nome, /Acrescente o nome correto/);
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// MODO PROFUNDO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

async function servidorEmMemoria() {
  const { buildServer } = await import("../src/index.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { server } = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client };
}

test("sienge_api_call exige deep_mode — o schema barra antes do handler", async () => {
  const { client } = await servidorEmMemoria();
  try {
    // O SDK reporta falha de validação em `isError`, não como exceção.
    for (const args of [{ path: "/creditors" }, { path: "/creditors", deep_mode: false }]) {
      const r = await client.callTool({ name: "sienge_api_call", arguments: args });
      assert.equal(r.isError, true, `aceitou ${JSON.stringify(args)}`);
      assert.match(r.content[0].text, /deep_mode/);
    }
  } finally {
    await client.close();
  }
});

test("sienge_api_call não aceita path fora do formato", async () => {
  const { client } = await servidorEmMemoria();
  try {
    for (const path of [
      "https://api.sienge.com.br/creditors",
      "creditors",
      "/creditors?limit=10",
      // Sairia do prefixo /{subdominio}/public/api/v1 e atingiria outra rota
      // do mesmo host: `fetch` normaliza o caminho antes de enviar.
      "/../../etc/passwd",
      "/purchase-orders/../../admin",
    ]) {
      const r = JSON.parse(
        (
          await client.callTool({
            name: "sienge_api_call",
            arguments: { path, deep_mode: true },
          })
        ).content[0].text
      );
      assert.equal(r.success, false, `aceitou path inválido: ${path}`);
      assert.equal(r.error, "Path inválido");
    }
  } finally {
    await client.close();
  }
});

test("sienge_api_call não expõe escrita", async () => {
  // Uma tool genérica que aceitasse POST contornaria o gate de confirmação:
  // um path adivinhado poderia criar título ou nota sem ninguém conferir.
  const { client } = await servidorEmMemoria();
  try {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "sienge_api_call");
    const params = Object.keys(t.inputSchema.properties);
    assert.ok(!params.includes("method"), "não pode haver escolha de método HTTP");
    assert.ok(!params.includes("body"), "não pode haver corpo de requisição");
    assert.match(t.description, /Só leitura/);
  } finally {
    await client.close();
  }
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// APROVAÇÃO EM LOTE
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// O que se protege aqui não é o caminho feliz: é que nada seja aprovado sem
// confirmação, que uma falha no meio do lote não esconda o que foi feito, e
// que o estado incerto seja dito em voz alta.

const purchaseOrders = await import("../src/apis/purchase-orders.js");

test("nada é autorizado sem confirm — a primeira chamada só devolve a prévia", async () => {
  const req = requestFalso({
    "/purchase-orders/1": { purchaseOrderId: 1, date: "2026-07-01", supplierId: 10, buildingId: 20 },
    "/purchase-orders/1/items": paginado([{ productId: 1, quantity: 2, unitPrice: 500, totalPrice: 1000 }]),
    "/creditors/10": { id: 10, name: "FORNECEDOR ALFA" },
    "/cost-centers/20": { id: 20, name: "OBRA CENTRO" },
  });

  const previa = await purchaseApproval.previaDeAprovacao(req, {}, [1]);
  assert.equal(previa.linhas.length, 1);
  assert.equal(previa.linhas[0].fornecedor, "FORNECEDOR ALFA", "prévia cega não é confirmação");
  assert.equal(previa.linhas[0].obra, "OBRA CENTRO");
  assert.equal(previa.total, 1000);

  // Nenhuma escrita aconteceu ao montar a prévia.
  const escritas = req.chamadas.filter((c) => /^(PUT|PATCH|POST|DELETE)/.test(c));
  assert.deepEqual(escritas, [], `a prévia escreveu: ${escritas.join(", ")}`);
});

test("falha no meio do lote não esconde o que já foi aprovado", async () => {
  const chamadas = [];
  const req = async (metodo, endpoint) => {
    chamadas.push(`${metodo} ${endpoint}`);
    if (endpoint.includes("/2/")) {
      return { success: false, error: "HTTP 409", message: "Pedido já autorizado" };
    }
    return { success: true, data: null, status_code: 204 };
  };

  const r = await purchaseApproval.aprovarPedidosEmLote(req, [1, 2, 3]);

  assert.equal(r.success, false, "lote com falha não é sucesso");
  assert.deepEqual(r.aprovados, [1, 3], "os outros precisam ter sido aprovados");
  assert.equal(r.falharam.length, 1);
  assert.equal(r.falharam[0].pedido, 2);
  assert.match(r.falharam[0].erro, /já autorizado/);
  assert.equal(chamadas.length, 3, "não pode abortar no primeiro erro");
});

test("falha ambígua é dita em voz alta, não tratada como erro comum", async () => {
  // Sem resposta do Sienge, a autorização pode ter sido aplicada. Repetir às
  // cegas é o que não pode acontecer.
  const req = async () => ({
    success: false,
    error: "Ambiguous Failure",
    message: "PUT falhou sem resposta do Sienge",
  });

  const r = await purchaseApproval.aprovarPedidosEmLote(req, [7]);
  assert.equal(r.falharam[0].estado_incerto, true);
  assert.match(r.atencao_estado_incerto, /PODE ter sido aplicada/);
  assert.match(r.atencao_estado_incerto, /Consulte o estado/);
});

test("autorização sem observação usa PUT; com observação, PATCH", async () => {
  // PUT é idempotente e a camada HTTP o repete em falha de rede; PATCH não.
  const chamadas = [];
  const req = async (metodo, endpoint, opts) => {
    chamadas.push({ metodo, endpoint, body: opts?.jsonData });
    return { success: true, data: null };
  };

  await purchaseOrders.autorizarPedido(req, 42);
  assert.equal(chamadas[0].metodo, "PUT");
  assert.equal(chamadas[0].body, undefined);

  await purchaseOrders.autorizarPedido(req, 42, "aprovado em reunião");
  assert.equal(chamadas[1].metodo, "PATCH");
  assert.deepEqual(chamadas[1].body, { observation: "aprovado em reunião" });
});

test("observação é truncada em 300 caracteres, não rejeitada", async () => {
  const chamadas = [];
  const req = async (m, e, opts) => {
    chamadas.push(opts?.jsonData);
    return { success: true, data: null };
  };
  await purchaseOrders.autorizarPedido(req, 1, "x".repeat(400));
  assert.equal(chamadas[0].observation.length, 300);
});

test("a tool recusa lote acima do teto, com o motivo", async () => {
  const { client } = await servidorEmMemoria();
  try {
    const r = JSON.parse(
      (
        await client.callTool({
          name: "compras_aprovar_pedidos",
          arguments: { pedidos: Array.from({ length: 51 }, (_, i) => i + 1), confirm: true },
        })
      ).content[0].text
    );
    assert.equal(r.success, false);
    assert.match(r.error, /excedem o máximo de 50/);
    assert.match(r.error, /conferível por/, "o motivo do limite precisa estar dito");
  } finally {
    await client.close();
  }
});

test("lista vazia é recusada em vez de reportar sucesso vazio", async () => {
  const { client } = await servidorEmMemoria();
  try {
    const r = JSON.parse(
      (await client.callTool({ name: "compras_aprovar_pedidos", arguments: { pedidos: [] } }))
        .content[0].text
    );
    assert.equal(r.success, false);
    assert.match(r.error, /ao menos um pedido/);
  } finally {
    await client.close();
  }
});

test("a tool declara confirm no schema — sem isso o gate seria decorativo", async () => {
  const { client } = await servidorEmMemoria();
  try {
    const t = (await client.listTools()).tools.find((x) => x.name === "compras_aprovar_pedidos");
    assert.ok(t, "a tool precisa estar registrada com o módulo compras carregado");
    assert.ok("confirm" in t.inputSchema.properties);
    assert.match(t.description, /IRREVERSÍVEL/);
  } finally {
    await client.close();
  }
});
