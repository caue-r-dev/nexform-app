# Recarga manual de crédito (admin) — design

## Problema

O upload de comprovante do revendedor (fluxo Pix + OCR, ver [[project_poliform_infra]]) as vezes trava num loop infinito antes de criar a transação. Quando isso acontece o revendedor manda o comprovante direto pro admin (WhatsApp), e não existe hoje nenhuma linha em `credit_transactions` pra aprovar — `aprovarDeposito`/`rejeitarDeposito` só operam sobre transações já em status `revisao`.

## Solução

Botão/form novo em `/admin/creditos` que cria uma transação de depósito já **confirmada**, direto pelo admin, sem depender do upload/OCR.

## Schema

Migration `016_credit_transactions_observacao.sql`:

```sql
alter table public.credit_transactions add column observacao text;
```

`credit_transactions` já existe (migration `014`) e já tem `GRANT ALL ... TO service_role` — `alter table add column` não precisa de grant novo (grant é por tabela, não por coluna).

## Server action

Novo em `src/app/actions/creditos.ts`:

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

Mesmo gate `currentIsAdmin()` já usado por `aprovarDeposito`/`rejeitarDeposito` — não confia só na tela que chama.

## Página `/admin/creditos`

Hoje só busca `credit_transactions`; a lista de revendedores pro filtro é derivada dos depósitos existentes (revendedor sem nenhum depósito ainda não aparece). O form de recarga manual precisa da lista **completa** de revendedores, então a página passa a buscar também:

```ts
adminClient.from('resellers').select('id, nome').order('nome')
```

(mesmo padrão já usado em `admin/relatorios/page.tsx` e `admin/vendas/page.tsx`) e repassa como prop nova `resellers` pro componente.

## Componente `CreditosAdminView`

Novo card fixo no topo da página, acima de "Saldo por revendedor":

- Select "Revendedor" (lista completa recebida via prop, não só quem já tem depósito)
- Input "Valor" (mesmo formato numérico/moeda usado em `criarDeposito` no lado revendedor)
- Textarea "Observação (opcional)" — ex. "comprovante recebido por WhatsApp"
- Botão "Confirmar recarga" — chama `lancarRecargaManual`, mostra erro via `alert` (mesmo padrão de `handleAprovar`/`handleRejeitar`), limpa os campos em caso de sucesso. `revalidatePath` já atualiza a tabela/saldo sem reload manual.

### Diferenciação na tabela principal

Depósito confirmado sem `storage_path` é, por construção, um lançamento manual (todo depósito confirmado pelo fluxo normal passou por upload e tem `storage_path`). Na coluna "Comprovante":

- Tem `storage_path` → link "Ver ↗" (comportamento atual, sem mudança)
- Não tem `storage_path` e é o lançamento manual → texto "Lançamento manual" (com a observação como `title`/tooltip, se preenchida)
- Não tem `storage_path` e não é manual (ex.: pendente, sem upload ainda) → "—" (comportamento atual, sem mudança)

## Fora do escopo

- Não mexe nas transações `pendente` órfãs deixadas pelo bug do loop infinito no upload — ficam inertes (não contam pro saldo), sem necessidade de limpeza pra essa feature funcionar.
- Não corrige o bug do loop infinito do upload em si — só dá o contorno operacional pro admin.
- Sem anexo de arquivo no lançamento manual (decisão do usuário — mais rápido sem upload).
