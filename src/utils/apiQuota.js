/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Contagem de uso das cotas diárias da API do Sienge.
 *
 * O Sienge limita requisições **por dia**, e em duas trilhas separadas, com
 * volumes muito diferentes por pacote contratado:
 *
 *     pacote        REST/dia    BULK/dia
 *     Free               100          10
 *     Start            1.000          20
 *     Special          2.500          50
 *     Essencial        5.000         100
 *     Enterprise      10.000         200
 *     Ultimate        75.000      28.800
 *
 * A trilha BULK é a apertada. Num pacote Start, uma consulta de panorama
 * financeiro com os dois lados consome 10% do dia inteiro; cinco delas consomem
 * metade. Não é uma questão de desempenho — é orçamento.
 *
 * Ao atingir o limite, a API responde **HTTP 429**. O mesmo código é usado para
 * excesso momentâneo e para cota diária esgotada, e a diferença importa: no
 * primeiro caso esperar resolve, no segundo só o dia seguinte resolve.
 *
 * Configure `SIENGE_MCP_API_PACKAGE` com o nome do seu pacote para que o saldo
 * seja calculado. Sem isso, o uso é contado e reportado, mas sem limite de
 * referência — não há como inventar qual plano está contratado.
 *
 * **A contagem é local e aproximada.** Enxerga apenas as chamadas deste
 * servidor: integrações e outros clientes com as mesmas credenciais consomem a
 * mesma cota sem passar por aqui. Orienta decisão; nunca bloqueia uma chamada.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveFile } from "./paths.js";

export const ARQUIVO_ENV_VAR = "SIENGE_MCP_QUOTA_COUNTER";
export const PACOTE_ENV_VAR = "SIENGE_MCP_API_PACKAGE";

export const REST = "rest";
export const BULK = "bulk";

/** Limites diários por pacote, conforme a tabela de pacotes de APIs do Sienge. */
export const PACOTES = {
  free: { [REST]: 100, [BULK]: 10 },
  start: { [REST]: 1000, [BULK]: 20 },
  special: { [REST]: 2500, [BULK]: 50 },
  essencial: { [REST]: 5000, [BULK]: 100 },
  enterprise: { [REST]: 10000, [BULK]: 200 },
  ultimate: { [REST]: 75000, [BULK]: 28800 },
};

// O Sienge nomeia o pacote em português; quem escreve em inglês erra por um
// "a". Aceitar o apelido evita que um typo desligue o acompanhamento sem aviso.
const APELIDOS = { essential: "essencial" };

// A partir de quanto o aviso deixa de ser informativo e vira alerta.
const FRACAO_DE_ALERTA = 0.7;

/** Data local no formato YYYY-MM-DD — o dia da virada da cota é o do usuário, não UTC. */
function hojeISO() {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${agora.getFullYear()}-${mes}-${dia}`;
}

/** Nome do pacote configurado, se reconhecido. */
export function pacote() {
  let nome = (process.env[PACOTE_ENV_VAR] || "").trim().toLowerCase();
  nome = APELIDOS[nome] ?? nome;
  return nome in PACOTES ? nome : null;
}

/** Como o pacote está configurado, incluindo valor não reconhecido. */
export function configuracao() {
  const bruto = (process.env[PACOTE_ENV_VAR] || "").trim();
  const reconhecido = pacote();
  if (reconhecido) {
    return { configurado: true, pacote: reconhecido, limites: PACOTES[reconhecido] };
  }
  if (bruto) {
    return {
      configurado: false,
      valor_informado: bruto,
      erro:
        `${PACOTE_ENV_VAR}='${bruto}' não é um pacote conhecido. ` +
        `Use um de: ${Object.keys(PACOTES).join(", ")}.`,
    };
  }
  return {
    configurado: false,
    erro:
      `${PACOTE_ENV_VAR} não definida. Configure com o pacote contratado ` +
      `(${Object.keys(PACOTES).join(", ")}) para acompanhar o saldo diário.`,
  };
}

/** Limite diário da trilha, ou null quando o pacote não está configurado. */
export function limite(trilha) {
  const atual = pacote();
  return atual ? PACOTES[atual][trilha] : null;
}

function caminho() {
  return resolveFile(ARQUIVO_ENV_VAR, "api-quota.json");
}

function ler() {
  try {
    const dados = JSON.parse(fs.readFileSync(caminho(), "utf8"));
    if (dados.dia === hojeISO()) return dados;
  } catch {
    // arquivo ausente, ilegível ou de outro dia — recomeça o contador
  }
  return { dia: hojeISO(), [REST]: 0, [BULK]: 0 };
}

/** Soma `quantidade` chamadas à trilha, no dia corrente. Nunca lança. */
export function registrar(trilha, quantidade = 1) {
  try {
    const dados = ler();
    dados[trilha] = Number(dados[trilha] || 0) + quantidade;
    const destino = caminho();
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, JSON.stringify(dados), "utf8");
  } catch {
    // contagem é best-effort
  }
}

/** Situação da cota de hoje para a trilha, para acompanhar o resultado. */
export function saldo(trilha) {
  const usadas = Number(ler()[trilha] || 0);
  const teto = limite(trilha);

  if (teto === null) {
    const config = configuracao();
    return {
      trilha,
      usadas_hoje: usadas,
      limite_diario: null,
      observacao: config.erro,
      valor_informado: config.valor_informado,
    };
  }

  const restantes = Math.max(teto - usadas, 0);
  let aviso = null;
  if (usadas >= teto) {
    aviso =
      `Cota ${trilha.toUpperCase()} de hoje provavelmente esgotada (${usadas} de ${teto}). ` +
      "A API responde 429 nesse estado, e esperar não resolve: o limite é diário.";
  } else if (usadas >= teto * FRACAO_DE_ALERTA) {
    aviso =
      `Restam ~${restantes} de ${teto} chamadas ${trilha.toUpperCase()} hoje. ` +
      "Estreite o período e evite repetir a mesma consulta.";
  }

  return {
    trilha,
    usadas_hoje: usadas,
    limite_diario: teto,
    restantes,
    pacote: pacote(),
    aviso,
  };
}

/** Explica um 429 conforme o consumo registrado da trilha. */
export function diagnosticoDe429(trilha) {
  const situacao = saldo(trilha);
  const teto = situacao.limite_diario;
  const usadas = situacao.usadas_hoje;

  if (teto === null) {
    return (
      "HTTP 429: pode ser excesso momentâneo ou cota diária esgotada. " +
      `Defina ${PACOTE_ENV_VAR} para distinguir os dois casos.`
    );
  }
  if (usadas >= teto) {
    return (
      `HTTP 429 com ${usadas} de ${teto} chamadas ${trilha.toUpperCase()} registradas hoje: ` +
      "a cota diária está esgotada. Repetir não resolve — o limite só reabre no " +
      "próximo dia. Use as rotas da outra trilha, se houver equivalente."
    );
  }
  return (
    `HTTP 429 com ${usadas} de ${teto} chamadas ${trilha.toUpperCase()} hoje. O contador local ` +
    "não indica esgotamento, então provavelmente é excesso momentâneo — ou há outro " +
    "cliente consumindo a mesma cota."
  );
}

/** Panorama das duas trilhas, para consultar antes de uma consulta cara. */
export function situacaoDasCotas() {
  const config = configuracao();
  return {
    success: true,
    pacote: config,
    pacotes_disponiveis: Object.fromEntries(
      Object.entries(PACOTES).map(([nome, limites]) => [
        nome,
        { rest_por_dia: limites[REST], bulk_por_dia: limites[BULK] },
      ])
    ),
    rest: saldo(REST),
    bulk: saldo(BULK),
    observacao:
      "Contagem local: só enxerga as chamadas deste servidor. Outros clientes com " +
      "as mesmas credenciais consomem a mesma cota sem serem contados. O contador " +
      "zera na virada do dia.",
  };
}
