import { adminClient } from '@/lib/supabase/admin'
import EtiquetasAdminView from '@/components/admin/etiquetas/EtiquetasAdminView'

export const dynamic = 'force-dynamic'

export default async function AdminEtiquetasPage() {
  const { data: etiquetas } = await adminClient
    .from('etiquetas')
    .select(`
      id, sku, product_nome, cor_nome, qtd, upload_batch_id, kit_sku, kit_nome,
      storage_path, status, data_upload, data_impressao,
      resellers(nome),
      sales(products(imagem))
    `)
    .order('data_upload', { ascending: false })

  // Gera URLs assinadas server-side (1h) — arquivo enviado pelo revendedor (comprovante), não a foto do produto.
  const etiquetasComUrl = await Promise.all(
    (etiquetas ?? []).map(async e => {
      const { data } = await adminClient.storage
        .from('etiquetas')
        .createSignedUrl(e.storage_path, 3600)
      const sale = Array.isArray(e.sales) ? e.sales[0] : e.sales
      const product = sale ? (Array.isArray(sale.products) ? sale.products[0] : sale.products) : null
      return { ...e, signedUrl: data?.signedUrl ?? null, productImagem: product?.imagem ?? null }
    })
  )

  return (
    <div className="theme-kreatop" style={{ flex: 1, padding: 24 }}>
      <div className="page-head">
        <div>
          <h1>Etiquetas</h1>
          <p>Fila de impressão de etiquetas de postagem</p>
        </div>
      </div>
      <EtiquetasAdminView etiquetas={etiquetasComUrl} />
    </div>
  )
}
