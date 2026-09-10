/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Cliente HTTP da API do Sienge.
 *
 * `makeRequest` é o único lugar que fala HTTP com o Sienge — o equivalente ao
 * `make_request` injetado nas funções de `sienge_mcp/api/*.py`. As funções em
 * `src/api/*.js` (uma por endpoint, traduzidas de lá) chamam esta função em
 * vez de usar `fetch` direto; é isso que mantém autenticação, URL base e
 * tratamento de erro num lugar só.
 */

import { resolveAuth, baseUrl } from "../config.js";

/**
 * @param {string} method GET, POST, PUT, PATCH ou DELETE
 * @param {string} path caminho a partir de /public/api/v1, com a barra inicial — ex. "/purchase-orders"
 * @param {object} [opcoes]
 * @param {Record<string, unknown>} [opcoes.params] query string; chaves nulas são omitidas
 * @param {unknown} [opcoes.body] corpo da requisição, serializado como JSON
 * @returns {Promise<{success: boolean, status_code?: number, data?: unknown, error?: string, message?: string}>}
 */
/**
 * Credencial + URL montada, ou o motivo de não dar para chamar.
 *
 * Extraído de `makeRequest` para `baixarArquivo` usar a MESMA montagem: a URL
 * base, o subdomínio e o jeito de serializar a query são exatamente o que não
 * pode divergir entre os dois caminhos.
 */
function preparar(path, params) {
  const auth = resolveAuth();
  if (!auth.ok) {
    return {
      erro: {
        success: false,
        error: "AuthNotConfigured",
        message: "Nenhuma credencial configurada. Use verificar_autenticacao para detalhes.",
      },
    };
  }

  const subdominio = (process.env.SIENGE_SUBDOMAIN || "").trim();
  if (!subdominio) {
    return {
      erro: {
        success: false,
        error: "SubdomainNotConfigured",
        message: "SIENGE_SUBDOMAIN não configurado — ele compõe a URL de toda chamada.",
      },
    };
  }

  const url = new URL(`${baseUrl()}/${subdominio}/public/api/v1${path}`);
  for (const [chave, valor] of Object.entries(params ?? {})) {
    if (valor === null || valor === undefined) continue;
    // Um parâmetro de múltiplos valores (ex. cnpj) vira cnpj=X&cnpj=Y — uma
    // entrada por item, não um único valor colado com vírgula.
    if (Array.isArray(valor)) {
      for (const item of valor) url.searchParams.append(chave, String(item));
    } else {
      url.searchParams.set(chave, String(valor));
    }
  }

  return { auth, url };
}

export async function makeRequest(method, path, { params, body } = {}) {
  const preparado = preparar(path, params);
  if (preparado.erro) return preparado.erro;
  const { auth, url } = preparado;

  try {
    const resposta = await fetch(url, {
      method,
      headers: {
        ...auth.headers,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const status_code = resposta.status;
    const texto = await resposta.text();

    // A API responde JSON, mas um proxy com erro pode responder HTML — tentar
    // desserializar isso lançaria dentro do próprio caminho de erro.
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch {
        dados = texto.slice(0, 500);
      }
    }

    if (!resposta.ok) {
      // O Sienge responde erro no formato ErrorMessage do spec:
      // { status, clientMessage, developerMessage, errors: [{field, message}] }.
      // NÃO existe campo `message` — ler por ele devolvia undefined e caía no
      // statusText, transformando um "campo X ausente" detalhado num
      // "Bad Request" sem informação. `errors` é o que diz QUAL campo.
      const corpo = dados && typeof dados === "object" && !Array.isArray(dados) ? dados : {};
      const camposInvalidos = Array.isArray(corpo.errors) ? corpo.errors : [];

      return {
        success: false,
        status_code,
        error: `HTTP_${status_code}`,
        message:
          corpo.developerMessage ||
          corpo.clientMessage ||
          resposta.statusText ||
          `A API respondeu ${status_code}.`,
        // clientMessage é o texto para o usuário final; developerMessage já foi
        // para `message`. Só acompanha quando acrescenta algo.
        ...(corpo.clientMessage && corpo.clientMessage !== corpo.developerMessage
          ? { client_message: corpo.clientMessage }
          : {}),
        ...(camposInvalidos.length ? { campos_invalidos: camposInvalidos } : {}),
        // Resposta que não é JSON (proxy devolvendo HTML, por exemplo) já vem
        // como texto recortado — preservar ajuda a diagnosticar.
        ...(typeof dados === "string" ? { corpo_bruto: dados } : {}),
      };
    }

    return { success: true, status_code, data: dados };
  } catch (err) {
    return { success: false, error: err.name, message: err.message };
  }
}

export async function testarConexao() {
  const inicio = Date.now();
  const resposta = await makeRequest("GET", "/customers", { params: { limit: 1 } });
  const latency_ms = Date.now() - inicio;

  if (!resposta.success) {
    return {
      success: false,
      status_code: resposta.status_code,
      latency_ms,
      message:
        resposta.status_code === 401 || resposta.status_code === 403
          ? "Credencial rejeitada pela API — confira SIENGE_API_KEY ou usuário/senha."
          : resposta.status_code === 404
            ? "Endereço não encontrado — confira SIENGE_SUBDOMAIN."
            : resposta.message,
    };
  }

  return {
    success: true,
    message: "Conexão com a API do Sienge estabelecida.",
    auth_method: resolveAuth().method,
    status_code: resposta.status_code,
    latency_ms,
  };
}

/**
 * Baixa um arquivo — a resposta que `makeRequest` não sabe ler.
 *
 * `makeRequest` desserializa tudo como JSON e recorta o texto em 500
 * caracteres quando não consegue: um PDF passando por lá vira lixo silencioso.
 * Por isso este caminho existe à parte, e devolve BYTES.
 *
 * Não grava nada. Quem decide onde salvar é a camada de cima — aqui só se
 * busca, porque escrever em disco é decisão de negócio (a pasta vem de
 * configuração) e não pertence ao cliente HTTP.
 *
 * O erro continua sendo lido no formato `ErrorMessage` do Sienge: um 404 de
 * anexo responde JSON mesmo quando a rota promete octet-stream, e tratá-lo
 * como binário esconderia a mensagem que diz o que faltou.
 *
 * @param {string} path caminho a partir de /public/api/v1
 * @param {object} [opcoes]
 * @param {Record<string, unknown>} [opcoes.params] query string
 * @returns {Promise<{success: boolean, bytes?: Buffer, content_type?: string,
 *   nome_sugerido?: string｜null, status_code?: number, error?: string, message?: string}>}
 */
export async function baixarArquivo(path, { params } = {}) {
  const preparado = preparar(path, params);
  if (preparado.erro) return preparado.erro;
  const { auth, url } = preparado;

  try {
    const resposta = await fetch(url, {
      method: "GET",
      headers: {
        ...auth.headers,
        // O spec oferece octet-stream ou, com Accept text/plain, o mesmo
        // arquivo em base64. Pedimos o binário: base64 infla 33% e ainda
        // precisaria ser decodificado aqui.
        Accept: "application/octet-stream, application/json;q=0.5, */*;q=0.1",
      },
    });

    const status_code = resposta.status;

    if (!resposta.ok) {
      // Mesmo formato de erro do resto da API — ver o comentário em
      // `makeRequest`. Não existe campo `message` no ErrorMessage do Sienge.
      const texto = await resposta.text();
      let corpo = {};
      try {
        const lido = JSON.parse(texto);
        if (lido && typeof lido === "object" && !Array.isArray(lido)) corpo = lido;
      } catch {
        corpo = {};
      }

      return {
        success: false,
        status_code,
        error: `HTTP_${status_code}`,
        message:
          corpo.developerMessage ||
          corpo.clientMessage ||
          resposta.statusText ||
          `A API respondeu ${status_code}.`,
        ...(corpo.clientMessage && corpo.clientMessage !== corpo.developerMessage
          ? { client_message: corpo.clientMessage }
          : {}),
        ...(Array.isArray(corpo.errors) && corpo.errors.length
          ? { campos_invalidos: corpo.errors }
          : {}),
      };
    }

    const bytes = Buffer.from(await resposta.arrayBuffer());

    return {
      success: true,
      status_code,
      bytes,
      content_type: resposta.headers.get("content-type"),
      nome_sugerido: nomeDoContentDisposition(resposta.headers.get("content-disposition")),
    };
  } catch (err) {
    return { success: false, error: err.name, message: err.message };
  }
}

/**
 * Nome do arquivo anunciado pelo servidor, quando ele anuncia.
 *
 * Duas formas convivem no cabeçalho: `filename="x.pdf"` e a versão com
 * charset, `filename*=UTF-8''x%20y.pdf`. A segunda vem percent-encoded e tem
 * precedência — é a que preserva acento, e nome de anexo em português tem.
 */
function nomeDoContentDisposition(cabecalho) {
  if (!cabecalho) return null;

  const comCharset = cabecalho.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
  if (comCharset) {
    try {
      return decodeURIComponent(comCharset[1].trim());
    } catch {
      return comCharset[1].trim();
    }
  }

  const simples = cabecalho.match(/filename="?([^";]+)"?/);
  return simples ? simples[1].trim() : null;
}
