'use server'

import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import QRCode from 'qrcode'
import { buildPixPayload } from '@/lib/pix'
import { PDF_CONFIG } from '@/lib/pdf-config'
import { parseValorPago, parseDataHoraPagamento, dataHoraDentroDoPrazo } from '@/lib/pixReceiptParse'

async function currentResellerId() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: reseller } = await adminClient
    .from('resellers').select('id').eq('auth_user_id', user.id).single()
  return reseller?.id ?? null
}

// aprovarDeposito/rejeitarDeposito movem dinheiro — nunca confiar só na tela
// que chama (o id da action vaza pro bundle client, um revendedor autenticado
// consegue invocar diretamente). Mesma fonte de verdade que src/proxy.ts usa
// pra gatear /admin/*.
async function currentIsAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.app_metadata?.role === 'admin'
}

export async function getSaldoDisponivel(resellerId: string): Promise<number> {
  const [{ data: depositos }, { data: debitos }] = await Promise.all([
    adminClient.from('credit_transactions').select('valor')
      .eq('reseller_id', resellerId).eq('tipo', 'deposito').eq('status', 'confirmado'),
    adminClient.from('credit_transactions').select('valor')
      .eq('reseller_id', resellerId).eq('tipo', 'debito'),
  ])
  const totalDepositos = (depositos ?? []).reduce((s, d) => s + Number(d.valor), 0)
  const totalDebitos = (debitos ?? []).reduce((s, d) => s + Number(d.valor), 0)
  return totalDepositos - totalDebitos
}

export async function criarDeposito(valor: number) {
  const resellerId = await currentResellerId()
  if (!resellerId) return { error: 'Revendedor não encontrado.' }
  if (!valor || !Number.isFinite(valor) || valor <= 0) return { error: 'Valor inválido.' }
  if (valor > 100000) return { error: 'Valor muito alto — fale com o admin pra depósitos grandes.' }
  // Arredonda pra centavos — o payload Pix e a coluna numeric(10,2) já
  // truncam nesse limite, arredondar aqui evita divergência entre o que
  // aparece na tela e o valor realmente gravado/cobrado no QR Code.
  valor = Math.round(valor * 100) / 100

  const { data: tx, error } = await adminClient
    .from('credit_transactions')
    .insert({ reseller_id: resellerId, tipo: 'deposito', valor, status: 'pendente' })
    .select('id').single()
  if (error || !tx) return { error: error?.message ?? 'Falha ao criar depósito.' }

  await adminClient.from('credit_transactions').update({ pix_txid: tx.id }).eq('id', tx.id)

  const pixCopiaCola = buildPixPayload({
    pixKey: PDF_CONFIG.pixKey,
    merchantName: PDF_CONFIG.pixMerchantName,
    merchantCity: PDF_CONFIG.pixMerchantCity,
    amount: valor,
    txid: tx.id,
  })
  const pixQrDataUrl = await QRCode.toDataURL(pixCopiaCola, { margin: 1, width: 240 })

  revalidatePath('/reseller/creditos')
  return { ok: true as const, id: tx.id, pixCopiaCola, pixQrDataUrl }
}

// Lê o valor pago diretamente do arquivo salvo no Storage — nunca aceita um
// valor "já lido" vindo do client (um revendedor conseguiria forjar OCR via
// devtools e creditar saldo sem pagar nada). O OCR roda aqui, no servidor,
// sobre o arquivo que o próprio upload já gravou no bucket.
export async function enviarComprovante(transactionId: string, storagePath: string) {
  const resellerId = await currentResellerId()
  if (!resellerId) return { error: 'Revendedor não encontrado.' }

  const { data: tx } = await adminClient
    .from('credit_transactions')
    .select('id, reseller_id, valor, status, criado_em')
    .eq('id', transactionId)
    .single()
  if (!tx || tx.reseller_id !== resellerId) return { error: 'Depósito não encontrado.' }
  if (tx.status !== 'pendente') return { error: 'Depósito já processado.' }

  // storagePath sempre começa com "{reseller_id}/..." (rota de upload monta
  // assim) — bloqueia um path de outro revendedor sendo reaproveitado aqui.
  if (!storagePath.startsWith(`${resellerId}/`)) return { error: 'Comprovante inválido.' }

  // Tudo daqui pra baixo (download, OCR, update final) fica num try/catch
  // amplo — qualquer falha inesperada (não só erro de OCR/parse já tratado
  // internamente) precisa terminar gravando um status revisável, nunca
  // deixar a transação presa em "pendente" pra sempre. Presa em "pendente"
  // é invisível pro admin: a fila de revisão só lista status "revisao"
  // (CreditosAdminView.tsx), então "pendente" travado nunca aparece pra
  // ninguém aprovar/rejeitar — bug real que motivou esse try/catch.
  try {
    const { data: fileBlob, error: downloadError } = await adminClient.storage
      .from('comprovantes')
      .download(storagePath)
    if (downloadError || !fileBlob) throw new Error('Falha ao ler o comprovante enviado.')

    const bytes = Buffer.from(await fileBlob.arrayBuffer())
    const isPDF = storagePath.toLowerCase().endsWith('.pdf')

    let text = ''
    if (isPDF) {
      try {
        const { PDFParse } = await import('pdf-parse')
        const parser = new PDFParse({ data: bytes })
        const result = await parser.getText()
        text = result.pages[0]?.text ?? ''
        await parser.destroy()
      } catch (err) {
        console.error('pdf-parse falhou (comprovante):', err)
      }
    } else {
      try {
        const path = await import('path')
        const { createWorker, PSM } = await import('tesseract.js')
        // tesseract.js resolve o worker-script via __dirname, que o bundler
        // do Next.js (server action) reescreve pra um caminho que não existe
        // em disco — passa o path real (relativo a process.cwd(), que continua
        // correto em runtime) explicitamente pra não depender disso.
        const workerPath = path.join(process.cwd(), 'node_modules/tesseract.js/src/worker-script/node/index.js')
        const worker = await createWorker('por', 1, { workerPath })
        // Sem isto, o mesmo PSM.AUTO (que já é o default nominal) às vezes deixa
        // passar em branco justo a linha do valor em prints de app bancário
        // (fonte grande, isolada, topo da imagem) — confirmado reproduzível
        // testando localmente com um comprovante real que falhava sempre sem
        // isto e sempre lia certo com isto. Setar explicitamente força o
        // tesseract a re-analisar o layout da página em vez de usar o cache
        // de segmentação da inicialização do worker.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
        const { data } = await worker.recognize(bytes)
        await worker.terminate()
        text = data.text
      } catch (err) {
        console.error('OCR falhou (comprovante):', err)
      }
    }

    const valorOcrLido = parseValorPago(text)
    const valorBate = valorOcrLido != null && Math.abs(valorOcrLido - Number(tx.valor)) < 0.005

    // Rejeita Pix agendado ou comprovante reaproveitado: a data/hora impressa
    // no comprovante precisa estar a até 30 min de quando o depósito foi
    // solicitado (não bate quando pago com agendamento pra outro dia/horário,
    // ou quando é um comprovante velho sendo reenviado). Sem data legível no
    // comprovante, não bloqueia sozinho — só o valor decide (mesmo padrão de
    // "não engole erro, mas também não trava por causa de OCR incompleto").
    const dataComprovante = parseDataHoraPagamento(text)
    const dataBate = dataComprovante == null || dataHoraDentroDoPrazo(dataComprovante, new Date(tx.criado_em))

    const bate = valorBate && dataBate
    const status: 'confirmado' | 'revisao' = bate ? 'confirmado' : 'revisao'

    const { error } = await adminClient
      .from('credit_transactions')
      .update({
        storage_path: storagePath,
        valor_ocr_lido: valorOcrLido,
        status,
        confirmado_em: bate ? new Date().toISOString() : null,
      })
      .eq('id', transactionId)
      .eq('status', 'pendente')
    if (error) return { error: error.message }

    revalidatePath('/reseller/creditos')
    revalidatePath('/reseller')
    revalidatePath('/admin/creditos')
    return { ok: true as const, status }
  } catch (err) {
    console.error('enviarComprovante falhou:', err)
    // Best-effort: manda pra revisão manual em vez de deixar travado em
    // "pendente" (invisível pro admin). Se esse update também falhar, não
    // tem mais nada a fazer — mas ao menos tentamos.
    await adminClient
      .from('credit_transactions')
      .update({ storage_path: storagePath, status: 'revisao' })
      .eq('id', transactionId)
      .eq('status', 'pendente')
    revalidatePath('/reseller/creditos')
    revalidatePath('/admin/creditos')
    return { ok: true as const, status: 'revisao' as const }
  }
}

export async function aprovarDeposito(id: string) {
  if (!(await currentIsAdmin())) return { error: 'Acesso negado.' }
  const { error } = await adminClient
    .from('credit_transactions')
    .update({ status: 'confirmado', confirmado_em: new Date().toISOString() })
    .eq('id', id).eq('status', 'revisao')
  if (error) return { error: error.message }
  revalidatePath('/admin/creditos')
  revalidatePath('/reseller/creditos')
  revalidatePath('/reseller')
  return { ok: true as const }
}

export async function rejeitarDeposito(id: string) {
  if (!(await currentIsAdmin())) return { error: 'Acesso negado.' }
  const { error } = await adminClient
    .from('credit_transactions')
    .update({ status: 'rejeitado' })
    .eq('id', id).eq('status', 'revisao')
  if (error) return { error: error.message }
  revalidatePath('/admin/creditos')
  revalidatePath('/reseller/creditos')
  return { ok: true as const }
}

export async function lancarRecargaManual(resellerId: string, valor: number, observacao?: string) {
  if (!(await currentIsAdmin())) return { error: 'Acesso negado.' }
  if (!resellerId) return { error: 'Selecione um revendedor.' }
  if (!valor || !Number.isFinite(valor) || valor <= 0) return { error: 'Valor inválido.' }
  if (valor > 100000) return { error: 'Valor muito alto — confirme o valor antes de lançar.' }
  valor = Math.round(valor * 100) / 100

  const { error } = await adminClient.from('credit_transactions').insert({
    reseller_id: resellerId,
    tipo: 'deposito',
    status: 'confirmado',
    valor,
    observacao: observacao?.trim() || null,
    confirmado_em: new Date().toISOString(),
  })
  if (error) return { error: error.message }

  revalidatePath('/admin/creditos')
  revalidatePath('/reseller/creditos')
  revalidatePath('/reseller')
  return { ok: true as const }
}
