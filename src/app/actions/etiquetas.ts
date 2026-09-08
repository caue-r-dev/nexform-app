'use server'

import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { calcCustoUnitario } from '@/lib/calc'
import { revalidatePath } from 'next/cache'
import { getSaldoDisponivel } from './creditos'

export type EtiquetaFormData = {
  storage_path: string
  product_id: string
  cor_id: string | null
  qtd: number
  upload_batch_id: string
  kit_sku: string | null
  kit_nome: string | null
}

// Etiqueta enviada por revendedor sempre gera automaticamente uma sale
// vinculada ao revendedor logado (regra 8 do gemini.md) — nunca se pede
// pra ele digitar produto/cor do zero, só confirmar o SKU lido por OCR.
export async function createEtiqueta(data: EtiquetaFormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autenticado.' }

  if (!data.product_id) return { error: 'Produto não identificado — selecione manualmente.' }
  if (data.qtd < 1) return { error: 'Quantidade mínima: 1.' }

  const { data: reseller } = await adminClient
    .from('resellers')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()
  if (!reseller) return { error: 'Revendedor não encontrado.' }

  const { data: product } = await adminClient
    .from('products')
    .select('nome, sku, custo_producao, margem_producao')
    .eq('id', data.product_id)
    .single()
  if (!product) return { error: 'Produto não encontrado.' }

  const valor_unitario = calcCustoUnitario(product.custo_producao, product.margem_producao)
  if (valor_unitario == null) return { error: 'Custo unitário inválido — verifique margem de produção do produto.' }

  const valorNecessario = valor_unitario * data.qtd
  const saldo = await getSaldoDisponivel(reseller.id)
  if (saldo < valorNecessario) {
    return { error: 'Saldo insuficiente — deposite antes de confirmar esta etiqueta.' }
  }

  let sku = product.sku
  let cor_nome: string | null = null

  if (data.cor_id) {
    const { data: cor } = await adminClient
      .from('cores_globais')
      .select('nome, codigo')
      .eq('id', data.cor_id)
      .single()
    if (cor) {
      sku = `${product.sku}.${cor.codigo}`
      cor_nome = cor.nome
    }
  }

  const { data: sale, error: saleErr } = await adminClient.from('sales').insert({
    reseller_id: reseller.id,
    product_id: data.product_id,
    cor_id: data.cor_id || null,
    sku,
    cor_nome,
    qtd: data.qtd,
    date: new Date().toISOString().slice(0, 10),
    valor_unitario,
    total: valor_unitario * data.qtd,
    custo_producao: product.custo_producao,
  }).select('id').single()

  if (saleErr || !sale) return { error: saleErr?.message ?? 'Erro ao registrar venda.' }

  const { error: etiquetaErr } = await adminClient.from('etiquetas').insert({
    reseller_id: reseller.id,
    sale_id: sale.id,
    product_nome: product.nome,
    cor_nome,
    sku,
    qtd: data.qtd,
    storage_path: data.storage_path,
    upload_batch_id: data.upload_batch_id,
    kit_sku: data.kit_sku,
    kit_nome: data.kit_nome,
  })

  if (etiquetaErr) {
    await adminClient.from('sales').delete().eq('id', sale.id)
    return { error: etiquetaErr.message }
  }

  const { error: debitoErr } = await adminClient.from('credit_transactions').insert({
    reseller_id: reseller.id,
    tipo: 'debito',
    valor: valorNecessario,
    status: 'confirmado',
    sale_id: sale.id,
  })

  if (debitoErr) {
    await adminClient.from('etiquetas').delete().eq('sale_id', sale.id)
    await adminClient.from('sales').delete().eq('id', sale.id)
    return { error: debitoErr.message }
  }

  revalidatePath('/reseller/etiquetas')
  revalidatePath('/admin/etiquetas')
  revalidatePath('/admin/vendas')
  revalidatePath('/reseller')
  revalidatePath('/reseller/creditos')
  revalidatePath('/admin/creditos')
  return { ok: true }
}

export async function markEtiquetaPrinted(id: string) {
  const { error } = await adminClient.from('etiquetas').update({
    status: 'impressa',
    data_impressao: new Date().toISOString(),
  }).eq('id', id)

  if (error) return { error: error.message }
  revalidatePath('/admin/etiquetas')
  return { ok: true }
}

// Marca todos os itens de um lote de upload como impressos numa única query.
export async function markBatchPrinted(ids: string[]) {
  if (ids.length === 0) return { error: 'Nenhum item no lote.' }
  const { error } = await adminClient.from('etiquetas').update({
    status: 'impressa',
    data_impressao: new Date().toISOString(),
  }).in('id', ids)

  if (error) return { error: error.message }
  revalidatePath('/admin/etiquetas')
  return { ok: true }
}

export async function deleteEtiqueta(id: string) {
  const { data: etiqueta } = await adminClient
    .from('etiquetas')
    .select('storage_path, status, sale_id')
    .eq('id', id)
    .single()

  if (etiqueta?.status === 'impressa') return { error: 'Etiqueta já impressa não pode ser removida.' }

  if (etiqueta?.storage_path) {
    await adminClient.storage.from('etiquetas').remove([etiqueta.storage_path])
  }

  const { error } = await adminClient.from('etiquetas').delete().eq('id', id)
  if (error) return { error: error.message }

  if (etiqueta?.sale_id) {
    // Busca o débito ANTES de apagar a venda — sale_id na linha de débito é
    // "on delete set null", então depois do delete não dá mais pra achar
    // qual débito era daquela venda.
    const { data: debito } = await adminClient
      .from('credit_transactions')
      .select('id, valor, reseller_id')
      .eq('sale_id', etiqueta.sale_id)
      .eq('tipo', 'debito')
      .maybeSingle()

    const { data: deletedSales } = await adminClient
      .from('sales')
      .delete()
      .eq('id', etiqueta.sale_id)
      .is('fechamento_id', null)
      .select('id')

    // Só reverte o crédito se a venda realmente foi apagada (mesma condição
    // fechamento_id null de antes) — sem isso o revendedor perdia o valor
    // debitado pra sempre ao remover uma etiqueta já confirmada. Reversão
    // vira um depósito já confirmado (nunca edita/apaga o débito original),
    // mantendo o ledger auditável.
    if (debito && deletedSales && deletedSales.length > 0) {
      await adminClient.from('credit_transactions').insert({
        reseller_id: debito.reseller_id,
        tipo: 'deposito',
        valor: debito.valor,
        status: 'confirmado',
        confirmado_em: new Date().toISOString(),
      })
    }
  }

  revalidatePath('/reseller/etiquetas')
  revalidatePath('/admin/etiquetas')
  revalidatePath('/admin/vendas')
  revalidatePath('/reseller')
  revalidatePath('/reseller/creditos')
  revalidatePath('/admin/creditos')
  return { ok: true }
}
