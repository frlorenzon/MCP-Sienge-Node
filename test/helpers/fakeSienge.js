/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Sienge de mentira, para os testes.
 *
 * Sobe um servidor HTTP real numa porta efêmera e aponta SIENGE_BASE_URL para
 * ele. Testar contra HTTP de verdade, em vez de trocar `makeRequest` por um
 * dublê, é o que faz o teste cobrir o que mais quebrou neste projeto: a forma
 * exata do corpo enviado, o formato de erro do Sienge, a paginação.
 *
 * As respostas seguem os schemas de `spec/openapi.yaml` — PaginatedResponse
 * com resultSetMetadata + results, e ErrorMessage nos erros.
 */

import http from "node:http";

const RAIZ = new URL("../../", import.meta.url);

/** Envelope paginado do spec, honrando limit/offset e um total declarado. */
export function pagina(itens, url, totalDeclarado) {
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const recorte = itens.slice(offset, offset + limit);
  return JSON.stringify({
    resultSetMetadata: { count: totalDeclarado ?? itens.length, offset, limit },
    results: recorte,
  });
}

/** Corpo de erro no formato ErrorMessage do spec. */
export function erroSienge(status, developerMessage, campos = []) {
  return JSON.stringify({
    status,
    developerMessage,
    clientMessage: "A requisição contém dados inválidos ou incompletos.",
    ...(campos.length ? { errors: campos } : {}),
  });
}

/**
 * Sobe o servidor e configura o ambiente.
 *
 * @param {object} cfg
 * @param {Array} [cfg.centros] centros de custo (obras)
 * @param {Array} [cfg.insumos] insumos do orçamento
 * @param {Array} [cfg.planilha] itens da planilha orçamentária
 * @param {Array} [cfg.itensDeSolicitacao] retorno de /purchase-requests/all/items
 * @param {number} [cfg.totalDeItens] total declarado, para exercitar paginação
 * @param {object} [cfg.cabecalhos] mapa id -> PurchaseRequest
 * @param {function} [cfg.postCabecalho] (corpo) => {status, body} — sobrescreve a criação
 * @param {function} [cfg.postItens] (corpo) => {status, body}
 * @param {object} [cfg.env] variáveis extras
 */
export async function iniciarSienge(cfg = {}) {
  const chamadas = [];
  const recebido = { cabecalho: null, itens: null, autorizacoes: [] };

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://interno");
    chamadas.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");

    const corpo = async () => {
      let bruto = "";
      for await (const pedaco of req) bruto += pedaco;
      return bruto ? JSON.parse(bruto) : null;
    };

    if (req.method === "GET") {
      if (url.pathname.endsWith("/cost-centers")) {
        return res.end(pagina(cfg.centros ?? [], url));
      }
      // Recurso único: a fila resolve a obra por id, não varrendo a lista.
      const centro = url.pathname.match(/\/cost-centers\/(\d+)$/);
      if (centro) {
        const achado = (cfg.centros ?? []).find((c) => String(c.id) === centro[1]);
        if (!achado) {
          res.statusCode = 404;
          return res.end(erroSienge(404, "Centro de custo não encontrado"));
        }
        return res.end(JSON.stringify(achado));
      }
      if (url.pathname.endsWith("/resources")) {
        return res.end(pagina(cfg.insumos ?? [], url));
      }
      if (url.pathname.includes("/sheets/") && url.pathname.endsWith("/items")) {
        return res.end(pagina(cfg.planilha ?? [], url));
      }
      if (url.pathname.endsWith("/purchase-requests/all/items")) {
        return res.end(pagina(cfg.itensDeSolicitacao ?? [], url, cfg.totalDeItens));
      }
      const solicitacao = url.pathname.match(/\/purchase-requests\/(\d+)$/);
      if (solicitacao) {
        const dados = (cfg.cabecalhos ?? {})[solicitacao[1]];
        if (!dados) {
          res.statusCode = 404;
          return res.end(erroSienge(404, "Recurso não encontrado"));
        }
        return res.end(JSON.stringify(dados));
      }
    }

    if (req.method === "POST" || req.method === "PATCH") {
      if (url.pathname.endsWith("/purchase-requests")) {
        recebido.cabecalho = await corpo();
        const r = cfg.postCabecalho
          ? cfg.postCabecalho(recebido.cabecalho)
          : { status: 201, body: { id: 2104 } };
        res.statusCode = r.status;
        return res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      }
      // PATCH de autorização: /authorize na solicitação ou em items/authorize
      const autorizacao = url.pathname.match(/\/purchase-requests\/(\d+)\/(items\/)?authorize$/);
      if (autorizacao) {
        recebido.autorizacoes.push({
          solicitacao: Number(autorizacao[1]),
          escopo: autorizacao[2] ? "itens" : "inteira",
          corpo: await corpo(),
        });
        const r = cfg.patchAutorizar ? cfg.patchAutorizar(Number(autorizacao[1])) : { status: 204 };
        res.statusCode = r.status;
        return res.end(r.body ? (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) : "");
      }
      if (/\/purchase-requests\/\d+\/items$/.test(url.pathname)) {
        recebido.itens = await corpo();
        const r = cfg.postItens ? cfg.postItens(recebido.itens) : { status: 201, body: {} };
        res.statusCode = r.status;
        return res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      }
    }

    res.statusCode = 404;
    res.end(erroSienge(404, `rota não simulada: ${req.method} ${url.pathname}`));
  });

  await new Promise((pronto) => servidor.listen(0, pronto));

  const anterior = { ...process.env };
  Object.assign(process.env, {
    SIENGE_BASE_URL: `http://127.0.0.1:${servidor.address().port}`,
    SIENGE_SUBDOMAIN: "teste",
    SIENGE_API_KEY: "chave-de-teste",
    SIENGE_SOLICITANTE: "FELIPERL",
    ...(cfg.env ?? {}),
  });

  return {
    chamadas,
    recebido,
    /** Quantas vezes um caminho foi chamado — para provar cache e paginação. */
    contar: (trecho) => chamadas.filter((c) => c.includes(trecho)).length,
    async fechar() {
      // Restaura o ambiente: os testes rodam no mesmo processo, e uma variável
      // vazada muda o resultado do teste seguinte.
      for (const chave of Object.keys(process.env)) {
        if (!(chave in anterior)) delete process.env[chave];
      }
      Object.assign(process.env, anterior);
      await new Promise((pronto) => servidor.close(pronto));
    },
  };
}

/**
 * Importa o client com o cache de módulo furado.
 *
 * `purchaseClient.js` guarda o orçamento num Map de escopo de módulo, com TTL
 * de 10 minutos — ótimo em produção, veneno no teste: a planilha do caso
 * anterior sobreviveria para o caso seguinte, que usa a mesma obra. A query
 * na URL força o Node a instanciar o módulo de novo.
 */
let versao = 0;
export function carregarPurchaseClient() {
  // `alvo.href` já é o file:// URL correto. Passar por pathToFileURL(pathname)
  // codificaria o '%' do caminho uma segunda vez — num diretório com espaço,
  // "MCP%20Sienge" vira "MCP%2520Sienge" e o módulo não é encontrado.
  const alvo = new URL("src/client/purchaseClient.js", RAIZ);
  return import(`${alvo.href}?v=${versao++}`);
}
