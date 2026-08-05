/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Cache em memória com expiração por TTL.
 *
 * Existe por causa da cota diária: repetir a mesma consulta dentro de uma
 * conversa é comum e cada repetição custa uma chamada do orçamento do dia.
 * Some quando o processo morre, de propósito — cache de ERP que sobrevive ao
 * processo entrega dado velho sem que ninguém saiba de onde veio.
 */

import { getLogger } from "../utils/logger.js";

const logger = getLogger();

class TTLCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds = 60) {
    this.store.set(key, { value, expireAt: Date.now() + ttlSeconds * 1000 });
    if (this.store.size % 100 === 0) this.cleanup();
  }

  cleanup() {
    const now = Date.now();
    let removidas = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expireAt) {
        this.store.delete(key);
        removidas += 1;
      }
    }
    if (removidas) logger.debug(`Cache cleanup: removidas ${removidas} entradas`);
  }

  invalidate(pattern) {
    let removidas = 0;
    for (const key of [...this.store.keys()]) {
      if (key.includes(pattern)) {
        this.store.delete(key);
        removidas += 1;
      }
    }
    if (removidas) {
      logger.debug(`Cache invalidated: ${removidas} entradas com padrão '${pattern}'`);
    }
  }
}

const cache = new TTLCache();

export function cacheGet(key) {
  return cache.get(key);
}

export function cacheSet(key, value, ttlSeconds = 60) {
  cache.set(key, value, ttlSeconds);
}

export function cacheInvalidate(pattern) {
  cache.invalidate(pattern);
}
