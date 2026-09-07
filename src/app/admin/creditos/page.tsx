import { adminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/fetchAllRows'
import CreditosAdminView from '@/components/admin/creditos/CreditosAdminView'

export const dynamic = 'force-dynamic'

export default async function AdminCreditosPage() {
  // Busca TODAS as transações (depósito + débito) — a tela precisa dos
  // débitos também pra calcular o saldo disponível por revendedor, não só
  // a lista de depósitos. Pagina alem do limite de 1000 linhas do
  // PostgREST pra saldo acumulado/disponível não ficarem errados.
  const rows = await fetchAllRows((from, to) =>
    adminClient
      .from('credit_transactions')
      .select('id, tipo, valor, status, valor_ocr_lido, storage_path, observacao, criado_em, reseller_id, resellers(nome)')
      .order('criado_em', { ascending: false })
      .range(from, to)
  )

  const withUrls = await Promise.all(
    rows.map(async r => {
      if (!r.storage_path) return { ...r, signedUrl: null }
      const { data } = await adminClient.storage
        .from('comprovantes')
        .createSignedUrl(r.storage_path, 3600)
      return { ...r, signedUrl: data?.signedUrl ?? null }
    })
  )

  // Lista completa de revendedores (não só quem já tem depósito) — o form
  // de recarga manual precisa poder lançar pra revendedor sem histórico.
  const { data: resellers } = await adminClient
    .from('resellers')
    .select('id, nome')
    .order('nome')

  return (
    <div className="theme-kreatop" style={{ flex: 1, padding: 24 }}>
      <div className="page-head">
        <div>
          <h1>Créditos</h1>
          <p>Depósitos dos revendedores — aprove ou rejeite os que caíram em revisão</p>
        </div>
      </div>
      <CreditosAdminView transacoes={withUrls} resellers={resellers ?? []} />
    </div>
  )
}
