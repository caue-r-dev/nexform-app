import { describe, it, expect } from 'vitest'
import { parseValorPago, parseDataHoraPagamento, dataHoraDentroDoPrazo } from '../lib/pixReceiptParse'

describe('parseValorPago', () => {
  it('lê "Valor: R$ 123,45"', () => {
    expect(parseValorPago('Comprovante de transferência\nValor: R$ 123,45\nData: 03/09/2026')).toBe(123.45)
  })

  it('lê "R$1.234,56" (milhar com ponto)', () => {
    expect(parseValorPago('Pix enviado\nR$1.234,56\nPara: NEXFORM')).toBe(1234.56)
  })

  it('lê valor sem o rótulo "Valor", só o R$', () => {
    expect(parseValorPago('Transferência Pix\nR$ 70,48\nConcluída')).toBe(70.48)
  })

  it('prioriza o padrão com rótulo "valor" quando há mais de um R$ no texto', () => {
    const text = 'Comprovante\nTarifa: R$ 0,00\nValor: R$ 70,48\nTotal debitado: R$ 70,48'
    expect(parseValorPago(text)).toBe(70.48)
  })

  it('retorna null quando não encontra nenhum valor', () => {
    expect(parseValorPago('Texto sem nenhum valor monetário aqui')).toBeNull()
  })

  it('retorna null pra texto vazio', () => {
    expect(parseValorPago('')).toBeNull()
  })

  it('não confunde "70.48" (ponto decimal, sem vírgula) com milhar', () => {
    // OCR às vezes lê a vírgula do Real como ponto — "R$ 70.48" tem que
    // continuar sendo 70.48, nunca 7048.
    expect(parseValorPago('Valor: R$ 70.48')).toBe(70.48)
  })

  it('ainda trata ponto como milhar quando tem 3 dígitos e vírgula decimal', () => {
    expect(parseValorPago('Valor: R$ 1.234,56')).toBe(1234.56)
  })

  it('lê "R$11,82" colado, sem espaço (OCR real de print de app bancário)', () => {
    // Texto real (tesseract.js, PSM.AUTO explícito) de um print de extrato — sem esse
    // parâmetro explícito o tesseract às vezes deixava a linha do valor inteira de fora
    // do texto lido (bug separado, corrigido em enviarComprovante), fazendo o comprovante
    // cair sempre em revisão manual mesmo com o valor certo.
    const text = '- R$11,82 [ conctuída\n\nO Pagamento Pix\nO 08/09/2026 às 15:14\nORIGEM\n\nNome\n\nCaue Ribeiro dos Santos'
    expect(parseValorPago(text)).toBe(11.82)
  })
})

describe('parseDataHoraPagamento', () => {
  it('lê "DD/MM/AAAA ... HH:MM"', () => {
    const d = parseDataHoraPagamento('Comprovante\nData: 03/09/2026 Hora: 20:11\nValor: R$ 3,00')
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2026)
    expect(d!.getMonth()).toBe(8) // setembro = índice 8
    expect(d!.getDate()).toBe(3)
    expect(d!.getHours()).toBe(20)
    expect(d!.getMinutes()).toBe(11)
  })

  it('lê "DD/MM/AAAA às HH:MM"', () => {
    const d = parseDataHoraPagamento('Pago em 03/09/2026 às 20:11')
    expect(d).not.toBeNull()
    expect(d!.getDate()).toBe(3)
    expect(d!.getHours()).toBe(20)
  })

  it('retorna null quando não acha data/hora no texto', () => {
    expect(parseDataHoraPagamento('Comprovante sem nenhuma data')).toBeNull()
  })

  it('lê data/hora de print de app bancário (texto OCR real)', () => {
    const d = parseDataHoraPagamento('O Pagamento Pix\n\nO 08/09/2026 às 15:14\nORIGEM')
    expect(d).not.toBeNull()
    expect(d!.getDate()).toBe(8)
    expect(d!.getMonth()).toBe(8)
    expect(d!.getHours()).toBe(15)
    expect(d!.getMinutes()).toBe(14)
  })
})

describe('dataHoraDentroDoPrazo', () => {
  it('true quando a diferença é menor que 30 minutos', () => {
    const ref = new Date('2026-09-03T20:00:00')
    const comprovante = new Date('2026-09-03T20:20:00')
    expect(dataHoraDentroDoPrazo(comprovante, ref)).toBe(true)
  })

  it('false quando passa de 30 minutos (Pix agendado pra depois)', () => {
    const ref = new Date('2026-09-03T20:00:00')
    const comprovante = new Date('2026-09-03T21:00:00')
    expect(dataHoraDentroDoPrazo(comprovante, ref)).toBe(false)
  })

  it('false pra comprovante de outro dia (reaproveitado)', () => {
    const ref = new Date('2026-09-03T20:00:00')
    const comprovante = new Date('2026-09-01T20:05:00')
    expect(dataHoraDentroDoPrazo(comprovante, ref)).toBe(false)
  })
})
