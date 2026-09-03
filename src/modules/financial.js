export const financialModule = {
  tools: [
    {
      name: "financeiro_contas_a_pagar",
      description:
        "TESTE — confirma que o módulo financeiro está carregado e que a chamada " +
        "chega ao handler certo. Não lê nada do Sienge de verdade ainda.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  handlers: {
    async financeiro_contas_a_pagar() {
      return { success: true, message: "Teste concluído com sucesso — a tool está funcionando." };
    },
  },
};
