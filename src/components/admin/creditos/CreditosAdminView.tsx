'use client'

import { useMemo, useState } from 'react'
import { aprovarDeposito, rejeitarDeposito, lancarRecargaManual } from '@/app/actions/creditos'
import { downloadCSV } from '@/lib/downloadCSV'

type Transacao = {
  id: string
  tipo: 'deposito' | 'debito'
  valor: number
  status: 'pendente' | 'confirmado' | 'revisao' | 'rejeitado'
  valor_ocr_lido: number | null
  storage_path: string | null
  observacao: string | null
  criado_em: string
  reseller_id: string
  resellers: { nome: string } | { nome: string }[] | null
  signedUrl: string | null
}

type Reseller = { id: string; nome: string }

const fmtBRL = (n: number) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtDT = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function resellerNome(t: Transacao) {
  const r = Array.isArray(t.resellers) ? t.resellers[0] : t.resellers
  return r?.nome ?? '—'
}

function statusTag(status: Transacao['status']) {
  if (status === 'confirmado') return <span className="tag">Confirmado</span>
  if (status === 'rejeitado') return <span className="tag" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>Rejeitado</span>
  if (status === 'revisao') return <span className="tag tag-warn">Em revisão</span>
  return <span className="tag tag-muted">Pendente</span>
}

export default function CreditosAdminView({ transacoes, resellers }: { transacoes: Transacao[]; resellers: Reseller[] }) {
  const [filtro, setFiltro] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [recargaResellerId, setRecargaResellerId] = useState('')
  const [recargaValor, setRecargaValor] = useState('')
  const [recargaObs, setRecargaObs] = useState('')
  const [recargaBusy, setRecargaBusy] = useState(false)

  const depositos = useMemo(() => transacoes.filter(t => t.tipo === 'deposito'), [transacoes])
  const emRevisao = depositos.filter(d => d.status === 'revisao')

  // Chaveado por reseller_id (não por nome) — nomes de revendedor não são
  // únicos, dois "Maria Silva" não podem mesclar saldo/histórico.
  const revendedores = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of depositos) map.set(d.reseller_id, resellerNome(d))
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
  }, [depositos])
  const filtrados = filtro ? depositos.filter(d => d.reseller_id === filtro) : depositos

  // Saldo por revendedor — acumulado (todo depósito confirmado, nunca
  // diminui, é o total histórico recebido) e disponível (acumulado menos
  // débitos) — calculado a partir de TODAS as transações, não só a lista
  // de depósitos usada no resto da tela.
  const saldoPorRevendedor = useMemo(() => {
    const map = new Map<string, { nome: string; acumulado: number; disponivel: number }>()
    for (const t of transacoes) {
      const entry = map.get(t.reseller_id) ?? { nome: resellerNome(t), acumulado: 0, disponivel: 0 }
      if (t.tipo === 'deposito' && t.status === 'confirmado') {
        entry.acumulado += Number(t.valor)
        entry.disponivel += Number(t.valor)
      } else if (t.tipo === 'debito') {
        entry.disponivel -= Number(t.valor)
      }
      map.set(t.reseller_id, entry)
    }
    return [...map.entries()].sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'pt-BR'))
  }, [transacoes])

  async function handleAprovar(id: string) {
    setBusy(id)
    const res = await aprovarDeposito(id)
    setBusy(null)
    if (res.error) alert(res.error)
  }
  async function handleRejeitar(id: string) {
    if (!confirm('Rejeitar este depósito?')) return
    setBusy(id)
    const res = await rejeitarDeposito(id)
    setBusy(null)
    if (res.error) alert(res.error)
  }

  async function handleLancarRecarga() {
    const valor = Number(recargaValor.replace(',', '.'))
    setRecargaBusy(true)
    const res = await lancarRecargaManual(recargaResellerId, valor, recargaObs)
    setRecargaBusy(false)
    if (res.error) { alert(res.error); return }
    setRecargaResellerId('')
    setRecargaValor('')
    setRecargaObs('')
  }

  function handleExportar() {
    const rows: string[][] = [['Revendedor', 'Valor', 'Status', 'Data', 'Comprovante']]
    for (const d of filtrados) {
      rows.push([resellerNome(d), fmtBRL(d.valor), d.status, fmtDT(d.criado_em), d.signedUrl ?? ''])
    }
    downloadCSV('comprovantes.csv', rows)
  }

  return (
    <>
      <div style={{ marginBottom: 22 }}>
        <div className="section-head"><h3>Lançar recarga manual</h3></div>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ minWidth: 220 }}>
              <label>Revendedor</label>
              <select value={recargaResellerId} onChange={e => setRecargaResellerId(e.target.value)}>
                <option value="">Selecione...</option>
                {resellers.map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}
              </select>
            </div>
            <div className="field" style={{ maxWidth: 160 }}>
              <label>Valor</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={recargaValor}
                onChange={e => setRecargaValor(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Observação (opcional)</label>
              <input
                type="text"
                placeholder="Ex: comprovante recebido por WhatsApp"
                value={recargaObs}
                onChange={e => setRecargaObs(e.target.value)}
              />
            </div>
            <button
              onClick={handleLancarRecarga}
              disabled={recargaBusy || !recargaResellerId || !recargaValor}
              className="btn btn-sm btn-primary"
            >
              Confirmar recarga
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div className="section-head"><h3>Saldo por revendedor</h3></div>
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Revendedor</th>
                  <th>Saldo acumulado</th>
                  <th>Saldo disponível</th>
                </tr>
              </thead>
              <tbody>
                {saldoPorRevendedor.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={3}><span className="ast">✳</span>Nenhum depósito cadastrado.</td>
                  </tr>
                )}
                {saldoPorRevendedor.map(([id, s]) => (
                  <tr key={id}>
                    <td style={{ fontWeight: 800 }}>{s.nome}</td>
                    <td className="mono" style={{ fontWeight: 800 }}>{fmtBRL(s.acumulado)}</td>
                    <td className="mono" style={{ fontWeight: 800, color: 'var(--green)' }}>{fmtBRL(s.disponivel)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {emRevisao.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div className="section-head"><h3>Fila de revisão ({emRevisao.length})</h3></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
            {emRevisao.map(d => (
              <div key={d.id} className="card" style={{ padding: '16px 18px' }}>
                <p style={{ margin: '0 0 6px', fontWeight: 800 }}>{resellerNome(d)}</p>
                <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700 }}>
                  Declarado: <span style={{ color: 'var(--green)' }}>{fmtBRL(d.valor)}</span>
                </p>
                <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: 'var(--soft)' }}>
                  OCR leu: {d.valor_ocr_lido != null ? fmtBRL(d.valor_ocr_lido) : 'não identificado'}
                </p>
                {d.signedUrl && (
                  <a href={d.signedUrl} target="_blank" rel="noreferrer" style={{ display: 'block', marginBottom: 10 }}>
                    Ver comprovante ↗
                  </a>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => handleAprovar(d.id)} disabled={busy === d.id} className="btn btn-sm btn-primary">Aprovar</button>
                  <button onClick={() => handleRejeitar(d.id)} disabled={busy === d.id} className="btn btn-sm btn-danger-ghost">Rejeitar</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div className="field" style={{ maxWidth: 280 }}>
          <label>Filtrar por revendedor</label>
          <select value={filtro} onChange={e => setFiltro(e.target.value)}>
            <option value="">Todos</option>
            {revendedores.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </div>
        <button onClick={handleExportar} className="btn btn-sm btn-ghost">Exportar comprovantes</button>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Revendedor</th>
                <th>Valor</th>
                <th>Status</th>
                <th>Comprovante</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={5}><span className="ast">✳</span>Nenhum depósito cadastrado.</td>
                </tr>
              )}
              {filtrados.map(d => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 800 }}>{resellerNome(d)}</td>
                  <td className="mono" style={{ fontWeight: 800 }}>{fmtBRL(d.valor)}</td>
                  <td>{statusTag(d.status)}</td>
                  <td>
                    {d.signedUrl
                      ? <a href={d.signedUrl} target="_blank" rel="noreferrer">Ver ↗</a>
                      : d.status === 'confirmado' && !d.storage_path
                        ? <span title={d.observacao ?? undefined} style={{ color: 'var(--soft)' }}>Lançamento manual</span>
                        : <span style={{ color: 'var(--soft)' }}>—</span>
                    }
                  </td>
                  <td style={{ fontSize: 12 }}>{fmtDT(d.criado_em)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
