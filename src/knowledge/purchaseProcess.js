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
 * O conteúdo vive em `purchaseProcess.json` e não em literais de string: é
 * texto longo e estruturado, que se revisa melhor como dado do que espalhado
 * por um módulo de código.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));

const CONHECIMENTO = JSON.parse(
  fs.readFileSync(path.join(aqui, "purchaseProcess.json"), "utf8")
);

export async function describePurchaseProcess() {
  return CONHECIMENTO;
}
