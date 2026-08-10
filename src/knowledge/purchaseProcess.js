/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * O processo de compras do Sienge, descrito para o modelo.
 *
 * Não chama a API: é conhecimento de domínio, e é o que evita os erros mais
 * caros — procurar preço numa solicitação de compra (que não tem preço) ou
 * supor que todo pedido nasceu de uma solicitação.
 *
 * ⚠️ O conteúdo de `purchaseProcess.json` descreve o processo **e** cita as
 * tools que o atendem. As duas coisas envelhecem em ritmos diferentes: o
 * processo do ERP é estável, a lista de tools muda a cada versão deste
 * servidor. Citar uma tool que não existe é pior do que não citar nenhuma —
 * o modelo sai procurando, não acha, e insiste, porque foi o próprio servidor
 * que a prometeu.
 *
 * Por isso a lista de tools de cada etapa é filtrada em tempo de execução
 * contra o que está de fato registrado, e a cobertura é recalculada a partir
 * disso. O texto do processo passa intacto.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));

const CONHECIMENTO = JSON.parse(
  fs.readFileSync(path.join(aqui, "purchaseProcess.json"), "utf8")
);

/**
 * Recorta uma etapa para o que este servidor realmente oferece.
 *
 * `cobertura_mcp` deixa de ser um rótulo fixo herdado e passa a dizer a
 * verdade sobre a etapa: quantas das tools previstas existem aqui, e por onde
 * ir quando não existe nenhuma.
 */
function recortarEtapa(etapa, visiveis, registradas, comoCarregar) {
  const previstas = etapa.tools ?? [];
  // Três destinos possíveis, e a diferença importa: o que se pode chamar
  // agora, o que existe mas está atrás de um `carregar_<modulo>`, e o que
  // simplesmente não foi implementado nesta versão.
  const agora = previstas.filter((t) => visiveis.has(t));
  const aposCarregar = previstas.filter((t) => !visiveis.has(t) && registradas.has(t));
  const inexistentes = previstas.filter((t) => !registradas.has(t));

  const recortada = { ...etapa, tools: agora };

  if (aposCarregar.length) {
    recortada.tools_apos_carregar = aposCarregar;
    const carregadores = [...new Set(aposCarregar.map((t) => comoCarregar.get(t)))].filter(Boolean);
    if (carregadores.length) {
      recortada.como_habilitar = `Chame ${carregadores.join(" ou ")} para ter estas.`;
    }
  }

  const alcancaveis = agora.length + aposCarregar.length;

  if (alcancaveis === 0) {
    recortada.cobertura_mcp = "sem tool dedicada nesta versão";
    recortada.como_fazer =
      "Não há tool específica para esta etapa aqui. Consulte a API diretamente " +
      "com sienge_api_endpoints e sienge_api_call — exigem SIENGE_DEEP_MODE=on " +
      "na configuração do servidor. Operações de escrita não têm caminho: " +
      "precisam ser feitas no próprio Sienge.";
    // `por_onde_comecar` aponta para uma tool que não existe: seguiria mandando
    // o modelo atrás dela.
    delete recortada.por_onde_comecar;
  } else if (inexistentes.length) {
    recortada.cobertura_mcp = `parcial — ${alcancaveis} de ${previstas.length} tools`;
  } else {
    recortada.cobertura_mcp = "completa";
  }

  return recortada;
}

/**
 * @param {{visiveis: Set<string>, registradas: Set<string>, comoCarregar?: Map<string,string>}} [estado]
 *   `visiveis` são as tools chamáveis agora; `registradas` inclui as que estão
 *   atrás de um `carregar_<modulo>`. Sem o argumento devolve o conhecimento
 *   cru — útil para inspecionar a especificação, não para responder ao modelo.
 */
export async function describePurchaseProcess(estado = null) {
  if (!estado) return CONHECIMENTO;

  const { visiveis, registradas = visiveis, comoCarregar = new Map() } = estado;

  const etapas = (CONHECIMENTO.etapas ?? []).map((e) =>
    recortarEtapa(e, visiveis, registradas, comoCarregar)
  );
  const cobertas = etapas.filter(
    (e) => e.tools.length > 0 || e.tools_apos_carregar?.length
  ).length;

  return {
    ...CONHECIMENTO,
    etapas,
    aviso_de_cobertura:
      `Esta versão do servidor tem tools para ${cobertas} das ${etapas.length} ` +
      "etapas. As demais só são alcançáveis pela API direta (sienge_api_call, " +
      "que exige SIENGE_DEEP_MODE=on na configuração) ou pelo próprio Sienge. " +
      "As listas de `tools` abaixo já refletem o que existe — não procure por " +
      "nomes que não estejam nelas.",
  };
}
