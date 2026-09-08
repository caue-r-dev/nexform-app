import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getSaldoDisponivel } from '@/app/actions/creditos'
import CreditosResellerView from '@/components/reseller/CreditosResellerView'

export const dynamic = 'force-dynamic'
// OCR do comprovante (tesseract.js/worker_threads, rodado em enviarComprovante)
// é pesado — sem folga aqui o timeout padrão da function em produção podia
// matar a execução no meio, antes do .update() final gravar qualquer
// resultado (bug real: transação ficava travada em "pendente" pra sempre,
// invisível pro admin, que só vê/aprova status "revisao").
export const maxDuration = 60

export default async function ResellerCreditosPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: reseller } = await adminClient
    .from('resellers').select('id').eq('auth_user_id', user.id).single()
  if (!reseller) redirect('/login')

  const [saldoDisponivel, { data: depositos }] = await Promise.all([
    getSaldoDisponivel(reseller.id),
    adminClient
      .from('credit_transactions')
      .select('id, valor, status, valor_ocr_lido, criado_em')
      .eq('reseller_id', reseller.id)
      .eq('tipo', 'deposito')
      .order('criado_em', { ascending: false }),
  ])

  return (
    <div className="theme-kreatop" style={{ flex: 1, padding: 24 }}>
      <div className="page-head">
        <div>
          <h1>Créditos</h1>
          <p>Deposite via Pix pra liberar o envio de etiquetas de postagem</p>
        </div>
      </div>
      <CreditosResellerView saldoDisponivel={saldoDisponivel} depositos={depositos ?? []} />
    </div>
  )
}
