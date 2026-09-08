-- ============================================================
-- Poliform · Kit na leitura de etiqueta
-- Rodar no Supabase Dashboard -> SQL Editor
-- ============================================================

-- Etiqueta de kit vira N linhas (uma por item do kit, ja existente) sem nenhum
-- vinculo entre elas — no painel admin ("etiquetas pendentes") aparecem como
-- N produtos avulsos, sem indicar que vieram do mesmo kit. Risco real: quem
-- separa o pedido manda 2x o mesmo produto achando que sao 2 vendas distintas.
-- kit_sku/kit_nome nullable — etiqueta de produto avulso (nao-kit) fica null,
-- sem quebrar nada existente.
alter table public.etiquetas
  add column kit_sku  text,
  add column kit_nome text;
