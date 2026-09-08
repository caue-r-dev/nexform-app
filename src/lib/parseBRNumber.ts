// Converte um número digitado por um usuário no formato BR ("1.234,56",
// "50,00", "50") para um JS number. Diferente do parseBRNumber interno de
// pixReceiptParse.ts (que lida com ambiguidade de leitura OCR), aqui a
// entrada é digitada por uma pessoa: ponto é sempre separador de milhar,
// vírgula é sempre o separador decimal — "1.234" sempre vira 1234, nunca
// 1.234.
export function parseBRNumber(input: string): number {
  return Number(input.trim().replace(/\./g, '').replace(',', '.'))
}
