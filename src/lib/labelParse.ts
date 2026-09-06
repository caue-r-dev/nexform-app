export type KnownSku = {
  productId: string
  corId: string | null
  sku: string
  productNome: string
  corNome: string | null
}

const QTD_PATTERNS = [
  // DANFE simplificado / declaração de conteúdo: número solto logo após "Total" no rodapé da etiqueta.
  /Total[\s\S]{0,20}?(\d+)\s*$/i,
  /qtd[e]?[.:\s]+(\d+)/i,
  /quantidade[:\s]+(\d+)/i,
  /(\d+)\s*(?:unidade|peça|item)/i,
  /x\s*(\d+)\b/i,
]

export function parseQtd(text: string): number | null {
  const trimmed = text.trim()
  for (const pattern of QTD_PATTERNS) {
    const m = trimmed.match(pattern)
    if (m) return parseInt(m[1])
  }
  return null
}

export type SkuQtyMatch = { sku: KnownSku; qtd: number }

// Mapa de posição: string sem espaço/quebra de linha (pra achar SKU ignorando ruído de
// formatação) -> índice correspondente no texto original (pra recortar a "janela" de
// texto ao redor de cada SKU e procurar ali a quantidade daquele item específico).
function buildNormalizedIndex(text: string): { normalized: string; origIndex: number[] } {
  const chars: string[] = []
  const origIndex: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!/\s/.test(ch)) {
      chars.push(ch.toUpperCase())
      origIndex.push(i)
    }
  }
  return { normalized: chars.join(''), origIndex }
}

// Acha, dentro de uma janela de texto isolada pra um item, uma linha composta só por
// dígitos — é assim que a QTD de cada item aparece nas etiquetas/DANFEs (uma por linha,
// logo após a descrição/variação daquele item, antes do Nº do próximo item).
function extractStandaloneQtd(window: string): number | null {
  const m = window.match(/^[ \t]*(\d{1,4})[ \t]*$/m)
  return m ? parseInt(m[1], 10) : null
}

// Acha TODOS os SKUs conhecidos e distintos citados no texto — não só "o melhor" —
// cada um com sua própria quantidade. Necessário pra pedidos com múltiplos produtos
// diferentes numa mesma etiqueta/DANFE (1 página pode listar N itens).
//
// Estratégia: casa SKUs do mais específico (mais longo) pro mais genérico, marcando as
// posições já usadas, pra um SKU pai (ex: "1013") nunca "roubar" o match de um SKU filho
// mais específico que já o contém (ex: "1013.#A210"). Pra achar a QTD de cada item,
// corta a janela de busca sempre ANTES do rodapé "Total" (que soma a quantidade de
// TODOS os itens do pedido, não de um item isolado) e pega a primeira linha só-com-
// dígitos dentro da janela daquele item.
export function matchSkusMulti(text: string, knownSkus: KnownSku[]): SkuQtyMatch[] {
  const { normalized, origIndex } = buildNormalizedIndex(text)
  const claimed = new Array(normalized.length).fill(false)

  type Occurrence = { start: number; end: number; sku: KnownSku }
  const occurrences: Occurrence[] = []

  const bySpecificity = [...knownSkus].sort((a, b) => b.sku.length - a.sku.length)
  for (const k of bySpecificity) {
    const needle = k.sku.toUpperCase().replace(/\s+/g, '')
    if (!needle) continue
    let from = 0
    for (;;) {
      const idx = normalized.indexOf(needle, from)
      if (idx === -1) break
      from = idx + 1
      const end = idx + needle.length
      // SKU só-numérico (ex: "1000", produto sem cor) não pode casar como parte de uma
      // sequência de dígitos maior (código de barras, CEP, CPF, número de rastreio) —
      // isso gera falso positivo real: "1000" bate dentro de qualquer código de barras
      // que contenha esses 4 dígitos em sequência. Exige que a ocorrência seja um token
      // isolado (vizinhos não-dígito ou fim do texto).
      if (/^\d+$/.test(needle)) {
        const before = idx > 0 ? normalized[idx - 1] : ''
        const after = end < normalized.length ? normalized[end] : ''
        if (/\d/.test(before) || /\d/.test(after)) continue
      }
      let overlaps = false
      for (let i = idx; i < end; i++) {
        if (claimed[i]) { overlaps = true; break }
      }
      if (overlaps) continue
      for (let i = idx; i < end; i++) claimed[i] = true
      occurrences.push({ start: idx, end, sku: k })
    }
  }

  occurrences.sort((a, b) => a.start - b.start)
  if (occurrences.length === 0) return []

  const totalIdx = text.search(/total/i)
  const searchLimit = totalIdx === -1 ? text.length : totalIdx

  return occurrences.map((occ, i) => {
    const windowStart = origIndex[occ.end - 1] + 1
    const next = occurrences[i + 1]
    const windowEnd = next ? origIndex[next.start] : searchLimit
    const window = windowStart < windowEnd ? text.slice(windowStart, Math.min(windowEnd, searchLimit)) : ''
    const qtd = extractStandaloneQtd(window) ?? parseQtd(window) ?? 1
    return { sku: occ.sku, qtd }
  })
}
