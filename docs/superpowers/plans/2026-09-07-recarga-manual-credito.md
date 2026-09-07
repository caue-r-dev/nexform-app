# Recarga Manual de Crédito (Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao admin um jeito de lançar um depósito de crédito já confirmado pra um revendedor, sem depender do fluxo de upload+OCR (que às vezes trava em loop infinito antes de criar a transação).

**Architecture:** Uma coluna nova (`observacao`) em `credit_transactions`, uma server action nova (`lancarRecargaManual`) que insere a transação direto com `status: 'confirmado'`, e um form novo no topo de `/admin/creditos` que a chama. Segue exatamente os mesmos padrões já usados por `aprovarDeposito`/`rejeitarDeposito`/`criarDeposito` no mesmo arquivo.

**Tech Stack:** Next.js 16 App Router, Supabase JS v2 (`adminClient`), TypeScript, React client component.

## Global Constraints

- Toda migration que adiciona coluna em tabela existente NÃO precisa de grant novo (grant é por tabela) — só migration que CRIA tabela precisa de `GRANT ALL ... TO service_role` explícito ([[project_poliform_infra]]).
- Toda server action que move dinheiro precisa checar `currentIsAdmin()` no próprio server, nunca confiar só na tela que chama.
- Chavear sempre por `reseller_id`, nunca por `nome` (nomes não são únicos no schema).
- Projeto não tem cobertura de teste automatizado pra server actions/UI (só lógica pura em `src/__tests__/*` — calc, sku, parse, pix). Validação desta feature é manual, seguindo o fluxo já confirmado do usuário: mergear direto pra `main`, push, checar em produção via Vercel — não há suíte a rodar aqui.
- Fluxo de deploy: push na `main` dispara deploy automático na Vercel ([[project_poliform_infra]]) — sem PR, sem preview local, conforme preferência já confirmada do usuário.

---

### Task 1: Migration — coluna `observacao`

**Files:**
- Create: `supabase/migrations/016_credit_transactions_observacao.sql`

**Interfaces:**
- Produces: coluna `credit_transactions.observacao` (text, nullable), consumida pela Task 2 (insert) e Task 4 (exibição).

- [ ] **Step 1: Escrever a migration**

```sql
-- ============================================================
-- NexForm · Recarga manual de crédito (admin)
-- Rodar no Supabase Dashboard → SQL Editor
-- ============================================================

alter table public.credit_transactions add column observacao text;
```

- [ ] **Step 2: Aplicar manualmente no Supabase Dashboard (SQL Editor)**

Copiar o conteúdo do arquivo e rodar no SQL Editor do projeto Supabase de produção (mesmo processo já usado pras migrations `006`, `007`, etc. — ver [[project_poliform_infra]]). Confirmar que não retornou erro.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/016_credit_transactions_observacao.sql
git commit -m "$(cat <<'EOF'
feat: adiciona coluna observacao em credit_transactions

Suporte pra recarga manual de credito guardar o motivo/origem do
lancamento (ex: comprovante recebido por WhatsApp).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBcEvDXDX4DTzycxGwVkFi
EOF
)"
```

---

### Task 2: Server action `lancarRecargaManual`

**Files:**
- Modify: `src/app/actions/creditos.ts`

**Interfaces:**
- Consumes: `adminClient` (já importado no arquivo, linha 3), `currentIsAdmin()` (já definida no arquivo, linhas 24-28).
- Produces: `export async function lancarRecargaManual(resellerId: string, valor: number, observacao?: string): Promise<{ error: string } | { ok: true }>` — consumida pela Task 4 (componente).

- [ ] **Step 1: Adicionar a função no final do arquivo**

Adicionar ao final de `src/app/actions/creditos.ts` (depois de `rejeitarDeposito`):

```ts
export async function lancarRecargaManual(resellerId: string, valor: number, observacao?: string) {
  if (!(await currentIsAdmin())) return { error: 'Acesso negado.' }
  if (!resellerId) return { error: 'Selecione um revendedor.' }
  if (!valor || !Number.isFinite(valor) || valor <= 0) return { error: 'Valor inválido.' }
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
```

- [ ] **Step 2: Verificar tipos com o compilador**

Run: `npx tsc --noEmit`
Expected: sem erros novos relacionados a `creditos.ts` (o projeto pode já ter warnings pré-existentes em outros arquivos — só checar que `creditos.ts` não introduz novo erro).

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/creditos.ts
git commit -m "$(cat <<'EOF'
feat: server action pra lancar recarga manual de credito

Permite ao admin criar um deposito ja confirmado direto, sem passar
pelo fluxo de upload+OCR (contorno pro caso do upload travar em loop
infinito antes de criar a transacao).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBcEvDXDX4DTzycxGwVkFi
EOF
)"
```

---

### Task 3: Página `/admin/creditos` busca lista completa de revendedores

**Files:**
- Modify: `src/app/admin/creditos/page.tsx`

**Interfaces:**
- Consumes: `adminClient` (já importado, linha 1).
- Produces: prop nova `resellers: { id: string; nome: string }[]` passada pro `CreditosAdminView`, consumida pela Task 4.

- [ ] **Step 1: Buscar revendedores e passar como prop**

Editar `src/app/admin/creditos/page.tsx`:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add src/app/admin/creditos/page.tsx
git commit -m "$(cat <<'EOF'
feat: pagina de creditos busca lista completa de revendedores

Necessario pro form de recarga manual poder lancar credito pra
revendedor que ainda nao tem nenhum deposito no historico.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBcEvDXDX4DTzycxGwVkFi
EOF
)"
```

(O componente `CreditosAdminView` ainda não aceita a prop `resellers` — isso é normal, a Task 4 adiciona. `npx tsc --noEmit` vai acusar erro de prop faltando até lá; não rodar o build sozinho antes da Task 4.)

---

### Task 4: Form de recarga manual em `CreditosAdminView`

**Files:**
- Modify: `src/components/admin/creditos/CreditosAdminView.tsx`

**Interfaces:**
- Consumes: `lancarRecargaManual(resellerId, valor, observacao?)` (Task 2), prop `resellers: { id: string; nome: string }[]` (Task 3).
- Produces: nada consumido por outra task — última do plano.

- [ ] **Step 1: Atualizar imports, tipo de `Transacao` e props do componente**

Em `src/components/admin/creditos/CreditosAdminView.tsx`, editar o topo do arquivo:

```tsx
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
```

- [ ] **Step 2: Atualizar assinatura do componente e adicionar estado do form**

Substituir a linha da assinatura do componente:

```tsx
export default function CreditosAdminView({ transacoes, resellers }: { transacoes: Transacao[]; resellers: Reseller[] }) {
  const [filtro, setFiltro] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [recargaResellerId, setRecargaResellerId] = useState('')
  const [recargaValor, setRecargaValor] = useState('')
  const [recargaObs, setRecargaObs] = useState('')
  const [recargaBusy, setRecargaBusy] = useState(false)
```

- [ ] **Step 3: Adicionar handler do form**

Adicionar depois de `handleRejeitar` (antes de `handleExportar`):

```tsx
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
```

- [ ] **Step 4: Adicionar o card do form no topo do JSX**

Adicionar como primeiro elemento dentro do `<>` que o componente retorna, antes do bloco `<div style={{ marginBottom: 22 }}>` de "Saldo por revendedor":

```tsx
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
```

- [ ] **Step 5: Diferenciar "Lançamento manual" na coluna Comprovante**

Na tabela principal (última seção do componente), substituir a célula de comprovante:

```tsx
                  <td>
                    {d.signedUrl
                      ? <a href={d.signedUrl} target="_blank" rel="noreferrer">Ver ↗</a>
                      : d.status === 'confirmado' && !d.storage_path
                        ? <span title={d.observacao ?? undefined} style={{ color: 'var(--soft)' }}>Lançamento manual</span>
                        : <span style={{ color: 'var(--soft)' }}>—</span>
                    }
                  </td>
```

- [ ] **Step 6: Verificar tipos com o compilador**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 7: Testar manualmente em dev**

Run: `npm run dev`

Abrir `/admin/creditos` logado como admin, preencher o form (revendedor + valor + observação opcional), clicar "Confirmar recarga". Confirmar que:
- A tabela "Saldo por revendedor" atualiza o saldo do revendedor escolhido.
- A linha nova aparece na tabela principal com status "Confirmado" e "Lançamento manual" na coluna Comprovante.
- Logar como o revendedor escolhido (ou checar `/reseller/creditos` dele) e confirmar que o saldo disponível também reflete o novo depósito.

- [ ] **Step 8: Commit**

```bash
git add src/components/admin/creditos/CreditosAdminView.tsx
git commit -m "$(cat <<'EOF'
feat: form de recarga manual de credito no admin

Card novo no topo de /admin/creditos — admin escolhe revendedor,
valor e observacao opcional, confirma, e o deposito ja entra
confirmado. Contorno pro caso do upload de comprovante travar em loop
infinito antes de criar a transacao.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBcEvDXDX4DTzycxGwVkFi
EOF
)"
```

---

### Task 5: Deploy

**Files:** nenhum (só operação de deploy).

- [ ] **Step 1: Push pra `main`**

```bash
git push
```

- [ ] **Step 2: Confirmar deploy na Vercel**

Checar `https://poliform-app.vercel.app/admin/creditos` (ou `nexform.nexvix.com.br/admin/creditos`) depois do deploy automático rodar, e repetir o teste manual do Task 4 Step 7 direto em produção (fluxo de validação já confirmado do usuário — ver [[feedback_deploy_workflow]]).
