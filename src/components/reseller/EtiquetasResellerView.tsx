'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { createEtiqueta, deleteEtiqueta } from '@/app/actions/etiquetas'
import { matchSkusMulti, parseQtd, type KnownSku } from '@/lib/labelParse'

type Etiqueta = {
  id: string
  sku: string
  product_nome: string
  cor_nome: string | null
  qtd: number
  storage_path: string
  status: 'pendente' | 'impressa'
  data_upload: string
  data_impressao: string | null
  signedUrl: string | null
}

type ProductCor = { corId: string; nome: string; codigo: string }
type Product = { id: string; nome: string; sku: string; valorUnitario: number | null; cores: ProductCor[] }

type QueueItem = {
  localId: string
  file: File
  previewUrl: string | null
  storagePath: string | null
  productId: string
  corId: string | null
  qtd: number
  status: 'lendo' | 'pronto' | 'erro'
  matched: boolean
  error?: string
  page: number | null
  totalPages: number | null
  uploadBatchId: string
}

const fmtDT = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const uid = () => Math.random().toString(36).slice(2)

type ParsedItem = { productId: string; corId: string | null; qtd: number; matched: boolean }

// Um texto de etiqueta/DANFE pode conter mais de um produto (pedido com itens
// diferentes) — retorna 1 item por SKU identificado, cada um com sua própria
// quantidade. Sem nenhum SKU reconhecido, cai pra 1 item vazio (seleção manual),
// ainda tentando aproveitar a quantidade lida no texto.
function itemsFromText(text: string, knownSkus: KnownSku[]): ParsedItem[] {
  const matches = matchSkusMulti(text, knownSkus)
  if (matches.length === 0) {
    const qtd = parseQtd(text)
    return [{ productId: '', corId: null, qtd: qtd && qtd > 0 ? qtd : 1, matched: false }]
  }
  return matches.flatMap(m => {
    const qtd = m.qtd > 0 ? m.qtd : 1
    // Kit: 1 ocorrência no texto vira N itens (um por linha de kit_items), qtd de cada
    // um multiplicada pela qtd de kits lida na etiqueta (normalmente 1 kit por linha).
    if (m.sku.kitItems) {
      return m.sku.kitItems.map(item => ({
        productId: item.productId,
        corId: item.corId,
        qtd: qtd * item.quantidade,
        matched: true,
      }))
    }
    return [{ productId: m.sku.productId, corId: m.sku.corId, qtd, matched: true }]
  })
}

export default function EtiquetasResellerView({ etiquetas, knownSkus, products, saldoDisponivel }: {
  etiquetas: Etiqueta[]
  knownSkus: KnownSku[]
  products: Product[]
  saldoDisponivel: number
}) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [statusMsg, setStatusMsg] = useState('')
  const [confirming, setConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    if (fileRef.current) fileRef.current.value = ''

    setStatusMsg(`Lendo ${files.length} etiqueta(s)…`)

    for (const file of files) {
      const localId = uid()
      const uploadBatchId = crypto.randomUUID()
      const isPDF = file.type === 'application/pdf'
      const previewUrl = isPDF ? null : URL.createObjectURL(file)
      const item: QueueItem = {
        localId, file, previewUrl, storagePath: null,
        productId: '', corId: null, qtd: 1, status: 'lendo', matched: false,
        page: null, totalPages: null, uploadBatchId,
      }
      setQueue(q => [...q, item])
      processFile(localId, file, isPDF)
    }
  }

  async function processFile(localId: string, file: File, isPDF: boolean) {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/etiquetas/upload', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok || json.error) {
        updateItem(localId, { status: 'erro', error: json.error ?? 'Erro no upload.' })
        return
      }

      // PDF com mais de 1 página = mais de uma etiqueta/pedido no mesmo arquivo.
      if (isPDF) {
        if (json.pdfParseError) {
          // Leitura do PDF falhou (não é "SKU não encontrado") — item continua confirmável,
          // mas com seleção manual obrigatória e mensagem que deixa a causa clara.
          updateItem(localId, {
            storagePath: json.path,
            productId: '', corId: null, qtd: 1, matched: false,
            status: 'pronto', totalPages: 1,
            error: 'Falha ao ler o PDF — selecione o produto manualmente.',
          })
          return
        }
        const pageTexts: string[] = json.pageTexts ?? []
        const totalPages = pageTexts.length || 1

        // Cada página pode listar mais de um produto (pedido com itens diferentes na
        // mesma etiqueta) — expande pra 1 QueueItem por item identificado, não por
        // página. Itens da mesma página compartilham o mesmo número de página.
        setQueue(q => {
          const base = q.find(it => it.localId === localId)
          if (!base) return q
          const expanded: QueueItem[] = pageTexts.flatMap((text, idx) =>
            itemsFromText(text, knownSkus).map(p => ({
              ...base,
              localId: uid(),
              storagePath: json.path,
              productId: p.productId,
              corId: p.corId,
              qtd: p.qtd,
              matched: p.matched,
              status: 'pronto' as const,
              page: idx + 1,
              totalPages,
            }))
          )
          return q.flatMap(it => it.localId === localId ? expanded : [it])
        })
        return
      }

      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('eng')
      const { data } = await worker.recognize(file)
      await worker.terminate()
      const text = data.text

      setQueue(q => {
        const base = q.find(it => it.localId === localId)
        if (!base) return q
        const expanded: QueueItem[] = itemsFromText(text, knownSkus).map(p => ({
          ...base,
          localId: uid(),
          storagePath: json.path,
          productId: p.productId,
          corId: p.corId,
          qtd: p.qtd,
          matched: p.matched,
          status: 'pronto' as const,
        }))
        return q.flatMap(it => it.localId === localId ? expanded : [it])
      })
    } catch {
      updateItem(localId, { status: 'erro', error: 'Falha ao processar arquivo.' })
    }
    setStatusMsg('')
  }

  function updateItem(localId: string, patch: Partial<QueueItem>) {
    setQueue(q => q.map(it => it.localId === localId ? { ...it, ...patch } : it))
  }

  function setProduct(localId: string, productId: string) {
    updateItem(localId, { productId, corId: null })
  }
  function setCor(localId: string, corId: string) {
    updateItem(localId, { corId: corId || null })
  }
  function setQtd(localId: string, qtd: number) {
    updateItem(localId, { qtd: qtd > 0 ? qtd : 1 })
  }
  function removeItem(localId: string) {
    setQueue(q => q.filter(it => it.localId !== localId))
  }

  async function handleConfirm() {
    const ready = queue.filter(it =>
      it.status === 'pronto' && it.storagePath && it.productId && coverage.get(it.localId)?.coberto
    )
    if (ready.length === 0) return
    setConfirming(true)
    for (const it of ready) {
      await createEtiqueta({
        storage_path: it.storagePath!,
        product_id: it.productId,
        cor_id: it.corId,
        qtd: it.qtd,
        upload_batch_id: it.uploadBatchId,
      })
    }
    setQueue(q => q.filter(it => !ready.some(r => r.localId === it.localId)))
    setConfirming(false)
  }

  async function handleDelete(e: Etiqueta) {
    if (e.status === 'impressa') { alert('Etiqueta já impressa não pode ser removida.'); return }
    if (!confirm(`Remover etiqueta ${e.sku}?`)) return
    const res = await deleteEtiqueta(e.id)
    if (res.error) alert(res.error)
  }

  // Total do pedido — soma valorUnitario (repasse) × qtd só dos itens com produto selecionado.
  // Preparação pro sistema de saldo/crédito: só exibição, nenhum débito é feito aqui.
  const identifiedItems = queue.filter(it => it.productId)
  const orderTotal = identifiedItems.reduce((sum, it) => {
    const product = products.find(p => p.id === it.productId)
    return sum + (product?.valorUnitario ?? 0) * it.qtd
  }, 0)

  // Cobertura do saldo, item a item, na ordem em que aparecem na fila —
  // cada item "reserva" do saldo restante; o que não cabe fica descoberto.
  // Produto com custo unitário inválido (valorUnitario null) nunca é
  // coberto — o servidor rejeita esse item de qualquer forma, então não
  // faz sentido consumir saldo por ele nem marcá-lo como liberado.
  let saldoRestante = saldoDisponivel
  const coverage = new Map<string, { coberto: boolean; faltante: number }>()
  for (const it of queue) {
    if (it.status !== 'pronto' || !it.productId) continue
    const product = products.find(p => p.id === it.productId)
    if (product?.valorUnitario == null) {
      coverage.set(it.localId, { coberto: false, faltante: 0 })
      continue
    }
    const valorItem = product.valorUnitario * it.qtd
    if (valorItem <= saldoRestante) {
      coverage.set(it.localId, { coberto: true, faltante: 0 })
      saldoRestante -= valorItem
    } else {
      coverage.set(it.localId, { coberto: false, faltante: valorItem - saldoRestante })
      saldoRestante = 0
    }
  }

  // Deriva do mesmo predicado que handleConfirm usa — o botão nunca deve
  // anunciar uma contagem maior do que realmente vai ser enviada.
  const pendingCount = queue.filter(it => it.status === 'pronto' && coverage.get(it.localId)?.coberto).length

  return (
    <>
      {/* Envio */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-head">
          <h2 style={{ fontSize: 14 }}>Enviar etiquetas</h2>
          <p>Envie uma ou várias fotos/PDFs — o produto e a cor são identificados pelo SKU lido na etiqueta. Confira antes de confirmar.</p>
        </div>
        <div style={{ padding: 18 }}>
          <input
            ref={fileRef} id="etiqueta-files" type="file"
            accept="image/*,application/pdf" multiple onChange={handleFiles}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
          />
          <label htmlFor="etiqueta-files" className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-flex' }}>
            + Enviar etiqueta(s)
          </label>
          {statusMsg && <p className="helper" style={{ color: 'var(--green)' }}>{statusMsg}</p>}
        </div>

        {queue.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)' }}>
            <table>
              <thead>
                <tr>
                  <th>Etiqueta</th>
                  <th>Produto</th>
                  <th>Cor</th>
                  <th>Qtd</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {queue.map(it => {
                  const product = products.find(p => p.id === it.productId) ?? null
                  return (
                    <tr key={it.localId}>
                      <td>
                        {it.previewUrl
                          ? <img src={it.previewUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />
                          : <span style={{ display: 'inline-flex', width: 44, height: 44, alignItems: 'center', justifyContent: 'center', background: 'var(--card2)', borderRadius: 6, border: '1px solid var(--line)', fontSize: 20 }}>📄</span>
                        }
                        {it.totalPages && it.totalPages > 1 && (
                          <div style={{ fontSize: 10.5, color: 'var(--soft)', fontWeight: 700, marginTop: 3, textAlign: 'center' }}>
                            pág. {it.page}/{it.totalPages}
                          </div>
                        )}
                      </td>
                      <td>
                        {it.status === 'lendo'
                          ? <span className="helper" style={{ margin: 0 }}>Lendo…</span>
                          : <select value={it.productId} onChange={e => setProduct(it.localId, e.target.value)} style={{ minWidth: 160 }}>
                              <option value="">Não identificado — selecione</option>
                              {products.map(p => <option key={p.id} value={p.id}>{p.nome} ({p.sku})</option>)}
                            </select>
                        }
                      </td>
                      <td>
                        {it.status !== 'lendo' && (
                          <select value={it.corId ?? ''} onChange={e => setCor(it.localId, e.target.value)} disabled={!product || product.cores.length === 0}>
                            <option value="">Sem cor</option>
                            {product?.cores.map(c => <option key={c.corId} value={c.corId}>{c.nome}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {it.status !== 'lendo' && (
                          <input type="number" min={1} value={it.qtd} onChange={e => setQtd(it.localId, parseInt(e.target.value) || 1)} style={{ width: 60 }} />
                        )}
                      </td>
                      <td>
                        {it.status === 'lendo' && <span className="tag tag-muted">Lendo…</span>}
                        {it.status === 'erro' && <span className="tag" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>{it.error}</span>}
                        {it.status === 'pronto' && it.matched && <span className="tag">SKU identificado</span>}
                        {it.status === 'pronto' && !it.matched && (
                          <span className="tag tag-warn">{it.error ?? 'Confirme manualmente'}</span>
                        )}
                        {it.status === 'pronto' && it.productId && product?.valorUnitario == null && (
                          <div style={{ marginTop: 4 }}>
                            <span className="tag" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>Custo unitário inválido — verifique o produto</span>
                          </div>
                        )}
                        {it.status === 'pronto' && it.productId && product?.valorUnitario != null && (
                          coverage.get(it.localId)?.coberto
                            ? <div style={{ marginTop: 4 }}><span className="tag">✓ Coberto pelo saldo</span></div>
                            : <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                                <span className="tag tag-warn">Faltam {fmtBRL(coverage.get(it.localId)?.faltante ?? 0)}</span>
                                <Link
                                  href={`/reseller/creditos?valor=${(coverage.get(it.localId)?.faltante ?? 0).toFixed(2)}`}
                                  className="btn btn-sm btn-ghost"
                                  style={{ textDecoration: 'none' }}
                                >
                                  Depositar
                                </Link>
                              </div>
                        )}
                      </td>
                      <td>
                        <button onClick={() => removeItem(it.localId)} className="btn btn-sm btn-danger-ghost">Remover</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div style={{ padding: '12px 14px 0' }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>
                Valor total do pedido: <span style={{ color: 'var(--green)' }}>{fmtBRL(orderTotal)}</span>
                {identifiedItems.length < queue.length && (
                  <span style={{ fontWeight: 700, color: 'var(--soft)' }}>
                    {' '}({identifiedItems.length} de {queue.length} itens identificados)
                  </span>
                )}
              </span>
            </div>
            <div style={{ padding: 14, display: 'flex', gap: 8 }}>
              <button onClick={handleConfirm} disabled={confirming || pendingCount === 0} className="btn btn-primary">
                {confirming ? 'Confirmando…' : `Confirmar ${pendingCount || ''} etiqueta${pendingCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lista já enviadas */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Produto / SKU</th>
                <th>Qtd</th>
                <th>Enviado</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {etiquetas.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={6}><span className="ast">✳</span>Nenhuma etiqueta enviada ainda.</td>
                </tr>
              )}
              {etiquetas.map(e => (
                <tr key={e.id}>
                  <td>
                    {e.signedUrl
                      ? e.storage_path.endsWith('.pdf')
                        ? <a href={e.signedUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', width: 48, height: 48, alignItems: 'center', justifyContent: 'center', background: 'var(--card2)', borderRadius: 6, border: '1px solid var(--line)', fontSize: 22, textDecoration: 'none' }}>📄</a>
                        : <a href={e.signedUrl} target="_blank" rel="noreferrer">
                            <img src={e.signedUrl} alt={e.sku} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />
                          </a>
                      : <span style={{ display: 'inline-block', width: 48, height: 48, background: 'var(--card2)', borderRadius: 6, border: '1px dashed var(--line)' }} />
                    }
                  </td>
                  <td>
                    <div style={{ fontWeight: 800, fontSize: 13 }}>{e.product_nome}</div>
                    <span className="tag tag-muted">{e.sku}</span>
                    {e.cor_nome && <span style={{ fontSize: 11.5, color: 'var(--soft)', marginLeft: 4 }}>{e.cor_nome}</span>}
                  </td>
                  <td className="mono">{e.qtd}</td>
                  <td style={{ fontSize: 12 }}>{fmtDT(e.data_upload)}</td>
                  <td>
                    {e.status === 'impressa'
                      ? <span className="tag">Impressa</span>
                      : <span className="tag tag-warn">Pendente</span>
                    }
                  </td>
                  <td>
                    {e.status !== 'impressa' && (
                      <button onClick={() => handleDelete(e)} className="btn btn-sm btn-danger-ghost">Remover</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
