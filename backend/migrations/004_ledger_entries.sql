CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  psp_ref TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (psp_ref, entry_type)
);

CREATE INDEX ledger_entries_payment_id_idx ON ledger_entries (payment_id);
CREATE INDEX ledger_entries_order_id_idx ON ledger_entries (order_id);
