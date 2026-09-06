import { describe, it, expect } from 'vitest'
import { matchSkusMulti, type KnownSku } from '../lib/labelParse'

const knownSkus: KnownSku[] = [
  { productId: 'p-nossa-senhora', corId: 'c-branco', sku: '1009.00002', productNome: 'Escultura Nossa Senhora', corNome: 'Branco' },
  { productId: 'p-esfera', corId: 'c-rosa', sku: '1013.#A210', productNome: 'Esfera Sensorial', corNome: 'Rosa Choque V-Silk' },
  { productId: 'p-esfera', corId: 'c-rainbow', sku: '1013.00003', productNome: 'Esfera Sensorial', corNome: 'Rainbow' },
  { productId: 'p-cubo', corId: 'c-rainbow2', sku: '1011.00003', productNome: 'Cubo Infinito', corNome: 'Rainbow' },
  { productId: 'p-cobra', corId: 'c-verde', sku: '1000.#0192', productNome: 'Cobra Articulada', corNome: 'Verde Velvet' },
]

describe('matchSkusMulti', () => {
  it('identifica 2 SKUs diferentes na mesma página, cada um com sua própria qtd', () => {
    // Texto real extraído (pdf-parse) de uma etiqueta com pedido de 2 produtos distintos.
    const text = 'IDENTIFICAÇÃO DOS BENS\nNº SKU DESCRIÇÃO VARIAÇÃO QTD 1 1009.00002\nImagem ReligiosaEscultura Decorativa 20cmNossa Senhora Aparecida Branco\n1\n2\n711013.#A210\n3DTransformável AntiestresseEsfera Sensorial Fidget\nV-SilkChoqueRosa\n1\n06-09-2026 Total\n2'

    const result = matchSkusMulti(text, knownSkus)

    expect(result).toHaveLength(2)
    expect(result[0].sku.sku).toBe('1009.00002')
    expect(result[0].qtd).toBe(1)
    expect(result[1].sku.sku).toBe('1013.#A210')
    expect(result[1].qtd).toBe(1)
  })

  it('não deixa o total geral (rodapé "Total") vazar como qtd do último item', () => {
    const text = 'SKU 1011.00003\ndescrição qualquer\n1\n06-09-2026 Total\n1'
    const result = matchSkusMulti(text, knownSkus)
    expect(result).toHaveLength(1)
    expect(result[0].qtd).toBe(1)
  })

  it('página com 1 único SKU continua funcionando (regressão)', () => {
    const text = 'SKU 1000.#0192\nCobra Articulada Fidget Toy Verde Velvet\n1\n06-09-2026 Total\n1'
    const result = matchSkusMulti(text, knownSkus)
    expect(result).toHaveLength(1)
    expect(result[0].sku.sku).toBe('1000.#0192')
    expect(result[0].qtd).toBe(1)
  })

  it('não confunde SKU pai com SKU filho mais específico (evita duplicar match)', () => {
    const text = 'SKU 1013.00003 Esfera Sensorial Rainbow\n1\nTotal 1'
    const result = matchSkusMulti(text, knownSkus)
    expect(result).toHaveLength(1)
    expect(result[0].sku.sku).toBe('1013.00003')
  })

  it('sem nenhum SKU conhecido no texto retorna lista vazia', () => {
    const result = matchSkusMulti('texto aleatório sem SKU nenhum', knownSkus)
    expect(result).toEqual([])
  })

  it('qtd maior que 1 pra um item específico é respeitada (não força 1)', () => {
    const text = 'SKU 1011.00003\ndescrição\n3\n06-09-2026 Total\n3'
    const result = matchSkusMulti(text, knownSkus)
    expect(result[0].qtd).toBe(3)
  })

  it('SKU só-numérico não casa por acidente dentro do código de barras/rastreio (falso positivo real)', () => {
    const knownSkusComSemCor: KnownSku[] = [
      ...knownSkus,
      { productId: 'p-cobra', corId: null, sku: '1000', productNome: 'Cobra Articulada', corNome: null },
    ]
    // Texto real (pdf-parse) da etiqueta página 1 — contém "31260957506967000167550010000032501706009680"
    // (código de rastreio), que tem "1000" embutido no meio da sequência de dígitos.
    const text = 'S\nP 395-03 021 Pedido: 999881965272734 2026-09-05 20:23 DESTINATÁRIO\n999881965272734 999881965272734 REMETENTE: Nathali Júlia Jardim América Rua Votuporanga 156, Várzea Paulista, SP, 13221240 N**x Residencial Boa Vista R REVERENDO DAVID ROSE D E CARVALHO 187, Jacutinga, MG, 37590000 31260957506967000167550010000032501706009680 UP3460014242 06/09/2026 20:25:04 1/4\nDECLARAÇÃO DE CONTEÚDO\nCódigo de Rastreamento: 999881965272734\nREMETENTE\nCEP:CPF/CNPJ:NOME: ravora\nDESTINATÁRIO\nCEP: 13221240CPF/CNPJ: 52304811884NOME: Nathali Júlia\nIDENTIFICAÇÃO DOS BENS\nNº SKU DESCRIÇÃO VARIAÇÃO QTD 1 1009.00002\nImagem ReligiosaEscultura Decorativa 20cmNossa Senhora Aparecida Branco\n1\n2\n711013.#A210\n3DTransformável AntiestresseEsfera Sensorial Fidget\nV-SilkChoqueRosa\n1\n06-09-2026 Total\n2'

    const result = matchSkusMulti(text, knownSkusComSemCor)

    expect(result).toHaveLength(2)
    expect(result.map(r => r.sku.sku)).toEqual(['1009.00002', '1013.#A210'])
    expect(result.some(r => r.sku.sku === '1000')).toBe(false)
  })

  it('não casa SKU só-numérico com nº de endereço nem CEP quebrado antes da tabela de itens', () => {
    const knownSkusComFaceplate: KnownSku[] = [
      ...knownSkus,
      { productId: 'p-faceplate', corId: null, sku: '1050', productNome: 'Faceplate PS5', corNome: null },
    ]
    // Texto real (pdf-parse) da etiqueta página 4 — endereço "Ribeiro 1050" (nº da casa)
    // e CEP "18191482" quebrado em "181914" + "82" pela extração, ambos antes da tabela
    // de itens ("IDENTIFICAÇÃO DOS BENS"), onde o único produto real é 1013.00003.
    const text = 'S\nO\nD 352-12 201 Pedido: 999881965942045 2026-09-06 20:20 DESTINATÁRIO\n999881965942045 999881965942045 REMETENTE: Maria Augusta Reis Pereira Setor 6 casa 41, Rio Verde Rua Romeu Antune s Ribeiro 1050, Araçoiaba da Serra, SP, 181914 82N**x Residencial Boa Vista R REVERENDO DAVID ROSE D E CARVALHO 187, Jacutinga, MG, 37590000 31260957506967000167550010000032531764310755 UP3460014245 06/09/2026 20:25:04 4/4\nDECLARAÇÃO DE CONTEÚDO\nCódigo de Rastreamento: 999881965942045\nREMETENTE\nCEP:CPF/CNPJ:NOME: ravora\nDESTINATÁRIO\nCEP: 18191482CPF/CNPJ: 42605930807NOME: Maria Augusta Reis Pereira\nIDENTIFICAÇÃO DOS BENS\nNº SKU DESCRIÇÃO VARIAÇÃO QTD 1 1013.00003\n3DTransformável AntiestresseEsfera Sensorial Fidget Rainbow\n1\n06-09-2026 Total\n1'

    const result = matchSkusMulti(text, knownSkusComFaceplate)

    expect(result).toHaveLength(1)
    expect(result[0].sku.sku).toBe('1013.00003')
    expect(result[0].qtd).toBe(1)
  })
})
