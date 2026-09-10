/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo de contratos de suprimentos.
 *
 * Só é importado quando `carregar_contratos` é chamada — é essa a diferença
 * entre o módulo custar tokens e não custar. Nada aqui roda na subida.
 *
 * DUAS TOOLS, e o `client/` faz muito mais que isso. É deliberado: cada tool
 * declarada custa descrição + inputSchema em TODA mensagem, enquanto uma
 * função de client parada não custa nada. Já estão prontas e cobertas por
 * teste, esperando serem pedidas — listar contratos, histórico de medições,
 * autorizar/reprovar contrato, criar medição, autorizar/reprovar medição, em
 * `client/supplyContractClient.js`. Expor cada uma é acrescentar uma entrada
 * aqui; as três últimas GRAVAM no ERP e não sobem sem alguém ter pedido.
 *
 * As descrições carregam as armadilhas que o modelo não tem como adivinhar,
 * porque elas custam menos aqui do que uma tentativa errada: a identidade do
 * contrato é um PAR (documento + número) e a busca varre uma JANELA de datas.
 */

import {
  detalharContrato,
  baixarAnexosDoContrato,
} from "../client/supplyContractClient.js";

export const supplyContractModule = {
  tools: [
    {
      // A tool que responde "me dê informações do contrato X da obra Y":
      // fornecedor, itens com preço unitário, valor, prazo e saldo, numa
      // chamada só. Cada um desses vem de um endpoint diferente do Sienge, e
      // encadeá-los como tools separadas reenviaria a conversa a cada passo.
      name: "contratos_detalhar",
      description:
        "Informações completas de UM contrato de suprimentos, numa chamada só: fornecedor " +
        "resolvido pelo nome, VALOR do contrato (material + mão de obra), PRAZO (início, " +
        "fim e dias restantes), SALDO, obras, unidades construtivas e os ITENS de cada " +
        "planilha com PREÇO UNITÁRIO e total. Aceita o número do contrato, parte do objeto " +
        "('instalações hidrossanitárias') ou só a obra — resolve o par documento+contrato " +
        "internamente; não peça nem busque ids. A busca varre os últimos 4 anos por " +
        "padrão, porque a API não lista contratos sem período: se não achar, a resposta " +
        "traz os contratos DA JANELA para você escolher, e `desde` amplia. Ambíguo, " +
        "devolve os candidatos com o par de cada um. Use `incluir_itens: false` só quando " +
        "a pergunta não envolver os itens.",
      inputSchema: {
        type: "object",
        properties: {
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CT'; dispensa a varredura" },
          obra: { type: "string", description: "nome (ou parte) da obra" },
          incluir_itens: { type: "boolean", description: "true (padrão) traz os itens de cada planilha" },
          incluir_aditivos: { type: "boolean", description: "false (padrão); true traz os aditivos" },
        },
      },
    },
    {
      // Grava em DISCO, não no ERP. Por isso não tem `confirmar`: a regra da
      // prévia protege contra escrita irreversível no Sienge, e apagar um
      // arquivo desfaz isto aqui. O que a descrição precisa deixar claro é o
      // contrário — que ela NÃO lê o arquivo, só o entrega.
      name: "contratos_baixar_anexos",
      description:
        "Baixa os anexos de um contrato e os SALVA em disco, na pasta configurada em " +
        "SIENGE_PASTA_ANEXOS, dentro de uma subpasta '<DOCUMENTO-NÚMERO> - <fornecedor>'. " +
        "Baixa TODOS os anexos de uma vez; use `anexos` só para escolher alguns. Ao " +
        "responder, DIGA em que pasta os arquivos foram salvos e ofereça `abrir_pasta` " +
        "(link) e `comando_para_abrir` (uma linha de terminal que abre o Finder/Explorer " +
        "ali) — é assim que o usuário chega nos arquivos. NÃO abre nem lê o conteúdo: o servidor grava os " +
        "bytes como vieram, então não prometa resumir, extrair ou interpretar o que está " +
        "dentro. Um anexo que falhe não impede os outros — a resposta lista o que salvou e " +
        "o que não.",
      inputSchema: {
        type: "object",
        properties: {
          contrato: { type: "string", description: "número do contrato ou parte do objeto" },
          documento: { type: "string", description: "código do documento, ex: 'CTS'" },
          obra: { type: "string", description: "nome (ou parte) da obra" },
          anexos: {
            type: "array",
            description: "números dos anexos a baixar; omita para baixar todos",
            items: { type: "number" },
          },
        },
      },
    },
  ],

  handlers: {
    contratos_detalhar: detalharContrato,
    contratos_baixar_anexos: baixarAnexosDoContrato,
  },
};
