'use client'

import { useMemo, useState } from 'react'
import { markEtiquetaPrinted, markBatchPrinted, deleteEtiqueta } from '@/app/actions/etiquetas'

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
  productImagem: string | null
  upload_batch_id: string | null
  kit_sku: string | null
  kit_nome: string | null
  resellers: { nome: string }[] | { nome: string } | null
}

type Batch = {
  key: string
  reseller: string
  dataUpload: string
  signedUrl: string | null
  storagePath: string
  items: Etiqueta[]
  status: 'pendente' | 'impressa'
  pendingIds: string[]
}

const fmtDT = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function getReseller(rel: Etiqueta['resellers']): string {
  if (!rel) return '—'
  return Array.isArray(rel) ? (rel[0]?.nome ?? '—') : rel.nome
}

// Agrupa por upload_batch_id — etiquetas antigas (sem lote) viram lote de 1 item usando o próprio id.
function groupBatches(etiquetas: Etiqueta[]): Batch[] {
  const map = new Map<string, Etiqueta[]>()
  for (const e of etiquetas) {
    const key = e.upload_batch_id ?? e.id
    const arr = map.get(key)
    if (arr) arr.push(e)
    else map.set(key, [e])
  }
  return Array.from(map.entries()).map(([key, items]) => {
    const pendingIds = items.filter(i => i.status === 'pendente').map(i => i.id)
    return {
      key,
      reseller: getReseller(items[0].resellers),
      dataUpload: items[0].data_upload,
      signedUrl: items[0].signedUrl,
      storagePath: items[0].storage_path,
      items,
      status: pendingIds.length === 0 ? 'impressa' : 'pendente',
      pendingIds,
    }
  })
}

export default function EtiquetasAdminView({ etiquetas }: { etiquetas: Etiqueta[] }) {
  const [filter, setFilter] = useState<'todas' | 'pendente' | 'impressa'>('pendente')
  const [marking, setMarking] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Batch | null>(null)

  const batches = useMemo(() => groupBatches(etiquetas), [etiquetas])
  const filtered = filter === 'todas' ? batches : batches.filter(b => b.status === filter)
  const pendentes = batches.filter(b => b.status === 'pendente').length

  async function handleMarkBatchPrinted(b: Batch) {
    setMarking(b.key)
    await markBatchPrinted(b.pendingIds)
    setMarking(null)
    if (viewing?.key === b.key) setViewing(null)
  }

  async function handleMarkItemPrinted(id: string) {
    setMarking(id)
    await markEtiquetaPrinted(id)
    setMarking(null)
  }

  async function handleDelete(e: Etiqueta) {
    if (!confirm(`Remover etiqueta ${e.sku}?`)) return
    await deleteEtiqueta(e.id)
  }

  return (
    <>
      {/* Modal visualização do arquivo do lote */}
      {viewing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }} onClick={() => setViewing(null)}>
          <div className="card" style={{ padding: 24, maxWidth: 560, width: '90vw', maxHeight: '90vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>{viewing.reseller} · {viewing.items.length} {viewing.items.length === 1 ? 'item' : 'itens'}</h2>
              <button onClick={() => setViewing(null)} className="btn btn-sm btn-ghost">Fechar</button>
            </div>
            {viewing.signedUrl && (
              viewing.storagePath.endsWith('.pdf')
                ? <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 20, textAlign: 'center', background: 'var(--card2)', marginBottom: 14 }}>
                    <span style={{ fontSize: 40 }}>📄</span>
                    <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 700 }}>Arquivo PDF</p>
                    <a href={viewing.signedUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{ marginTop: 8, display: 'inline-block' }}>Abrir PDF</a>
                  </div>
                : <img src={viewing.signedUrl} alt=""
                    style={{ width: '100%', maxHeight: 340, objectFit: 'contain', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 14 }} />
            )}
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13, margin: 0 }}>
              {[
                ['Revendedor', viewing.reseller],
                ['Enviado', fmtDT(viewing.dataUpload)],
                ['Status', viewing.status],
              ].map(([k, v]) => [
                <dt key={`k-${k}`} style={{ fontWeight: 800, color: 'var(--soft)' }}>{k}</dt>,
                <dd key={`v-${k}`} style={{ margin: 0, fontWeight: 700 }}>{v}</dd>,
              ])}
            </dl>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {viewing.signedUrl && (
                <a href={viewing.signedUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                  Abrir arquivo
                </a>
              )}
              {viewing.status === 'pendente' && (
                <button
                  onClick={() => handleMarkBatchPrinted(viewing)}
                  disabled={marking === viewing.key}
                  className="btn btn-primary btn-sm"
                >
                  {marking === viewing.key ? '…' : 'Marcar lote como impresso'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Controles */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center' }}>
        {(['pendente', 'impressa', 'todas'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}>
            {f === 'pendente' ? `Pendentes${pendentes > 0 ? ` (${pendentes})` : ''}` : f === 'impressa' ? 'Impressas' : 'Todas'}
          </button>
        ))}
      </div>

      {/* Grid de cards (por lote) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
        {filtered.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px 0', color: 'var(--soft)', fontWeight: 700 }}>
            <span style={{ color: 'var(--green)', fontSize: 22, display: 'block', marginBottom: 6 }}>✳</span>
            Nenhuma etiqueta {filter !== 'todas' ? filter : ''}.
          </div>
        )}
        {filtered.map(b => {
          const isExpanded = expanded === b.key
          return (
            <div key={b.key} className="card" style={{
              border: `1.5px solid ${b.status === 'impressa' ? 'var(--line)' : 'var(--green)'}`,
              opacity: b.status === 'impressa' ? .65 : 1,
            }}>
              <div style={{ padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }} onClick={() => setViewing(b)}>
                <span style={{ display: 'inline-flex', width: 40, height: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', background: 'var(--card2)', borderRadius: 8, border: '1px solid var(--line)', fontSize: 18 }}>
                  📄
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {b.reseller}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--soft)', fontWeight: 700 }}>
                    {fmtDT(b.dataUpload)} · {b.items.length} {b.items.length === 1 ? 'item' : 'itens'}
                  </div>
                </div>
                {b.status === 'pendente'
                  ? <span className="tag tag-warn">Pendente</span>
                  : <span className="tag">Impressa</span>
                }
              </div>

              <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => setExpanded(isExpanded ? null : b.key)}
                  className="btn btn-sm btn-ghost"
                  style={{ fontSize: 11 }}
                >
                  {b.items.length} {b.items.length === 1 ? 'item' : 'itens'} {isExpanded ? '▲' : '▼'}
                </button>
                {b.status === 'pendente' && (
                  <button
                    onClick={() => handleMarkBatchPrinted(b)}
                    disabled={marking === b.key}
                    className="btn btn-sm btn-primary"
                    style={{ fontSize: 10.5, padding: '3px 8px' }}
                  >
                    {marking === b.key ? '…' : 'Marcar lote como impresso'}
                  </button>
                )}
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--line)', background: 'var(--card2)' }}>
                  {b.items.map((item, idx) => {
                    // Itens de um mesmo kit ficam consecutivos (a fila do revendedor expande
                    // 1 SKU de kit em N itens, na ordem) — mostra 1 aviso antes do primeiro
                    // item de cada grupo pra quem separa o pedido não mandar o mesmo produto
                    // 2x achando que são vendas avulsas distintas.
                    const isFirstOfKit = item.kit_sku && item.kit_sku !== b.items[idx - 1]?.kit_sku
                    return (
                    <div key={item.id}>
                      {isFirstOfKit && (
                        <div style={{
                          padding: '6px 14px', fontSize: 10.5, fontWeight: 800,
                          color: 'var(--amber)', background: 'var(--amber-bg, rgba(217,119,6,.12))',
                          borderBottom: '1px solid var(--line)',
                        }}>
                          🎁 Kit: {item.kit_nome} — itens abaixo são do mesmo pedido, não separe como vendas distintas
                        </div>
                      )}
                    <div style={{
                      display: 'flex', gap: 8, alignItems: 'center', padding: '8px 14px',
                      borderBottom: '1px solid var(--line)',
                      borderLeft: item.kit_sku ? '3px solid var(--amber)' : undefined,
                    }}>
                      {item.productImagem
                        ? <img src={item.productImagem} alt={item.sku} style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', flexShrink: 0 }} />
                        : <span style={{ display: 'inline-flex', width: 32, height: 32, flexShrink: 0, alignItems: 'center', justifyContent: 'center', background: 'var(--card)', borderRadius: 6, border: '1px dashed var(--line)', fontSize: 10, color: 'var(--soft)' }} />
                      }
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.product_nome}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--soft)', fontWeight: 700 }}>
                          {item.sku} {item.cor_nome ? `· ${item.cor_nome}` : ''} · qtd {item.qtd}
                        </div>
                      </div>
                      {item.status === 'pendente' ? (
                        <>
                          <button
                            onClick={() => handleMarkItemPrinted(item.id)}
                            disabled={marking === item.id}
                            className="btn btn-sm btn-primary"
                            style={{ fontSize: 10, padding: '2px 6px' }}
                          >
                            {marking === item.id ? '…' : 'Marcar como impressa'}
                          </button>
                          <button onClick={() => handleDelete(item)} className="btn btn-sm btn-danger-ghost" style={{ fontSize: 10, padding: '2px 6px' }}>
                            Remover
                          </button>
                        </>
                      ) : (
                        <span className="tag" style={{ fontSize: 10 }}>Impressa</span>
                      )}
                    </div>
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
