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
 *
 * A mesma regra vale no tempo, e não só no catálogo: `descarregar_modulos` só
 * aparece quando há algo carregado para descarregar (ver
 * `sincronizarDescarregador`), e uma tool que existe mas está fora do módulo
 * carregado responde com o nome do carregador em vez de um erro de protocolo
 * (ver `instalarDicaDeModulo`).
 */

import { z } from "zod";
import {
  registerTool,
  contarPorTag,
  definirHabilitada,
  enableByTags,
  disableByTags,
  modulosDisponiveis,
  registered,
  toContent,
} from "../registry.js";
import * as tagRegistry from "../modules.js";

/**
 * Módulos carregados nesta sessão. Sob stdio, um processo atende uma sessão —
 * ver a nota sobre escopo em modules.js antes de expor o servidor por HTTP.
 */
let carregados = new Set([tagRegistry.CORE_MODULE]);

/**
 * Handle de `descarregar_modulos`, guardado para ligá-la e desligá-la conforme
 * haja o que descarregar. Ver `sincronizarDescarregador`.
 */
let handleDescarregar = null;

/**
 * Módulos carregados que de fato trazem tools — o que `descarregar_modulos`
 * teria a liberar. O núcleo não conta: é permanente.
 */
function haOQueDescarregar() {
  const disponiveis = contarPorTag();
  return [...carregados].some((m) => m !== tagRegistry.CORE_MODULE && (disponiveis[m] ?? 0) > 0);
}

/**
 * Liga `descarregar_modulos` quando há módulo carregado, desliga quando não há.
 *
 * Com o perfil padrão nada além do núcleo está carregado, e a tool não teria o
 * que fazer — mas a descrição e o inputSchema dela viajariam em todo
 * `tools/list` mesmo assim. É o defeito que o cabeçalho deste arquivo nomeia:
 * pagar contexto para dizer "ainda não".
 *
 * Precisa rodar depois de `enableByTags`/`applyProfile`, que reabilitam por tag
 * e não sabem desta condição — `descarregar_modulos` é do núcleo, então
 * qualquer reafirmação do núcleo a traria de volta.
 */
function sincronizarDescarregador() {
  if (!handleDescarregar) return;
  definirHabilitada(handleDescarregar, haOQueDescarregar());
}

/**
 * Define o recorte inicial, aplicado por index.js a partir de SIENGE_PROFILE.
 * Precisa rodar depois de `applyProfile`, pela razão em `sincronizarDescarregador`.
 */
export function definirModulosCarregados(modulos) {
  carregados = modulos === null ? new Set(Object.keys(tagRegistry.MODULES)) : new Set(modulos);
  sincronizarDescarregador();
}

export function modulosCarregados() {
  return new Set(carregados);
}

/**
 * Registra a tool de carregamento de um módulo.
 *
 * Não recebe descrição: ela é a `chamada` do módulo em modules.js, junto da
 * lista de tools que ele traz. Um lugar só para as duas coisas que precisam
 * andar juntas.
 *
 * @param {object} server
 * @param {string} modulo tag do módulo em modules.js, com tools já registradas
 */
function registrarCarregador(server, modulo) {
  registerTool(server, {
    name: tagRegistry.nomeDoCarregador(modulo),
    description: tagRegistry.MODULES[modulo].chamada,
    handler: async () => {
      // Não há checagem de módulo vazio: `registrarModulos` só chega aqui para
      // módulo que já tem tool registrada. Antes, com o registro escrito à mão,
      // a checagem era o que impedia o modelo de carregar um módulo, receber
      // sucesso e não ganhar ferramenta nenhuma.
      const disponiveis = contarPorTag();
      const jaEstava = carregados.has(modulo);
      carregados.add(modulo);
      enableByTags(new Set([modulo]));
      sincronizarDescarregador();

      // Os nomes, não só a contagem. O servidor emite
      // `notifications/tools/list_changed` ao habilitar, mas nem todo cliente
      // reindexa a lista ao recebê-la — e quando não reindexa, o modelo recebe
      // "2 tools carregadas" e não consegue encontrar nenhuma. Com os nomes
      // exatos em mãos, ele chama direto, sem depender da busca.
      const nomes = [...registered]
        .filter(([, { tags }]) => tags.has(modulo))
        .map(([nome]) => nome)
        .sort();

      return {
        success: true,
        modulo,
        tools: nomes,
        ja_estava_carregado: jaEstava || undefined,
        modulos_carregados: [...carregados].filter((m) => disponiveis[m] > 0).sort(),
        como_usar:
          "Os nomes acima são exatos e já estão ativos. Se a sua lista de " +
          "ferramentas ainda não os mostrar, chame-os pelo nome mesmo — alguns " +
          "clientes demoram a recarregar. Se ainda assim falhar, configure " +
          `SIENGE_PROFILE=${modulo} no servidor: aí o módulo já sobe carregado.`,
      };
    },
  });
}

/**
 * Registra um carregador por módulo que de fato tem tools, mais a tool de
 * descarregamento.
 *
 * ⚠️ Precisa rodar DEPOIS de todo o resto do registro: é `modulosDisponiveis`,
 * lida agora, que decide quais carregadores existem. Chamada antes, não
 * encontraria módulo nenhum e o servidor subiria sem nenhum carregador.
 *
 * É o que faz um módulo novo ficar alcançável no instante em que ganha a
 * primeira tool, sem que alguém precise lembrar de anunciar isso aqui — o
 * esquecimento que deixaria dez tools registradas, desabilitadas e sem caminho
 * de volta.
 */
export function registrarModulos(server) {
  for (const modulo of [...modulosDisponiveis()].sort()) {
    if (modulo !== tagRegistry.CORE_MODULE) registrarCarregador(server, modulo);
  }

  handleDescarregar = registerTool(server, {
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
      // Depois da reafirmação, nunca antes: ela é por tag e traria de volta
      // esta própria tool, que é do núcleo.
      sincronizarDescarregador();

      const disponiveis = contarPorTag();
      return {
        success: true,
        descarregados: [...alvo].sort(),
        modulos_carregados: [...carregados].filter((m) => disponiveis[m] > 0).sort(),
      };
    },
  });

  // O estado inicial sai daqui, e não do registro: `registerTool` sobe toda
  // tool habilitada. index.js chama `definirModulosCarregados` logo em
  // seguida, mas um servidor montado sem essa chamada — em teste, por exemplo
  // — precisa nascer coerente do mesmo jeito.
  sincronizarDescarregador();
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// TOOL FORA DO MÓDULO CARREGADO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * Módulo que traz uma tool, carregada ou não, ou null se ela não pertence a
 * nenhum módulo além do núcleo.
 *
 * Consulta primeiro o registro — que é a verdade sobre este servidor — e cai no
 * catálogo de `modules.js` para os nomes que ainda não foram implementados. A
 * distinção entre os dois casos é o que separa "existe, carregue o módulo" de
 * "não existe nesta versão".
 */
function moduloQueTraz(nome) {
  const tags = registered.get(nome)?.tags ?? tagRegistry.TOOL_TAGS.get(nome);
  return tags ? ([...tags].find((t) => t !== tagRegistry.CORE_MODULE) ?? null) : null;
}

/**
 * O que responder a uma chamada que o carregamento sob demanda torna
 * inalcançável. `null` significa "não é comigo" — a chamada segue seu caminho
 * normal, para o handler ou para o erro do SDK.
 */
function dicaParaToolIndisponivel(nome) {
  if (!nome) return null;
  const registrada = registered.get(nome);

  // Tool registrada e ativa: é uma chamada comum. Responder aqui a
  // sequestraria; qualquer falha dela é do handler ou dos argumentos.
  if (registrada && registrada.handle.enabled !== false) return null;

  // Caso criado por `sincronizarDescarregador`: a tool existe, está desligada
  // de propósito, e não tem módulo a que pertencer.
  if (nome === "descarregar_modulos") {
    return {
      success: false,
      error: "Nada a descarregar — só o núcleo está carregado.",
    };
  }

  const modulo = moduloQueTraz(nome);
  // Nome que não está nem no registro nem no catálogo: erro de digitação ou
  // invenção. O "Tool não encontrada" do SDK já diz isso com precisão, e
  // adivinhar um módulo aqui mandaria o modelo carregar algo à toa.
  if (!modulo) return null;

  if (!registrada) {
    return {
      success: false,
      error: `A tool '${nome}' não existe nesta versão do servidor.`,
      modulo_previsto: modulo,
      como_usar:
        `O catálogo a prevê em '${modulo}', mas ela ainda não foi implementada — ` +
        "carregar o módulo não vai trazê-la. Resolva com as tools que existem.",
    };
  }

  const carregador = tagRegistry.nomeDoCarregador(modulo);
  const temCarregador = registered.has(carregador);
  return {
    success: false,
    error: `A tool '${nome}' existe, mas o módulo '${modulo}' não está carregado.`,
    modulo,
    carregar_com: temCarregador ? carregador : undefined,
    como_usar: temCarregador
      ? `Chame ${carregador} e repita esta chamada em seguida.`
      : `Este servidor não expõe carregador para '${modulo}'. Configure ` +
        `SIENGE_PROFILE=${modulo} no ambiente para que ele suba já carregado.`,
  };
}

/**
 * Faz uma chamada a tool desabilitada responder com o caminho de volta.
 *
 * Sem isto, o SDK devolve `McpError: Tool X disabled` — um erro de protocolo
 * que não diz que a tool existe, em que módulo mora, nem que há um
 * `carregar_<modulo>` para ela. É um beco sem saída no caminho mais provável
 * de acontecer: o modelo viu o nome em `explicar_processo_compras`, ou numa
 * mensagem anterior ao `descarregar_modulos`, e chama direto.
 *
 * Custa zero token por requisição — nada disto aparece em `tools/list`, só na
 * resposta de uma chamada que já tinha falhado.
 *
 * Nada aqui conhece módulo por nome: a dica sai das tags do registro e do
 * catálogo de `modules.js`, então um módulo novo passa a ser sugerido no
 * momento em que ganha a primeira tool, sem tocar neste arquivo.
 *
 * A decisão vem ANTES de delegar, e não de um `catch` em volta. O McpServer
 * não deixa o erro escapar: ele o converte em `{isError: true}` com a mensagem
 * em texto puro. Peneirar aquele resultado exigiria reconhecer a mensagem do
 * SDK por texto — que muda de versão para versão — e correria o risco de
 * responder "carregue o módulo" a uma falha de validação de argumento. O
 * estado do registro responde a mesma pergunta sem adivinhação.
 *
 * ⚠️ Substitui o handler que o McpServer instalou, alcançado por
 * `_requestHandlers` — API interna do SDK. Se uma versão futura mudar essa
 * estrutura, o servidor sobe igual e o cliente volta a receber o erro cru:
 * perde-se a dica, nada quebra. É por isso que a falha aqui é silenciosa e o
 * retorno é booleano, para quem quiser registrar em log.
 *
 * @returns {boolean} se o interceptador foi instalado
 */
export function instalarDicaDeModulo(server) {
  const handlers = server?.server?._requestHandlers;
  const original = handlers?.get?.("tools/call");
  if (typeof original !== "function") return false;

  handlers.set("tools/call", async (request, extra) => {
    const dica = dicaParaToolIndisponivel(request?.params?.name);
    return dica ? toContent(dica) : original(request, extra);
  });
  return true;
}
