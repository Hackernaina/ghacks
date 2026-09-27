CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  attempt INT NOT NULL,
  psp TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,
  psp_ref TEXT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,

  state TEXT NOT NULL,
  confidence TEXT NULL,
  reason TEXT NULL,

  next_check_at TIMESTAMPTZ NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  not_found_since TIMESTAMPTZ NULL,
  poll_count INT NOT NULL DEFAULT 0,

  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payments_one_active_per_order
  ON payments (order_id)
  WHERE state NOT IN ('FAILED');

CREATE INDEX payments_psp_ref_idx ON payments (psp_ref);
CREATE INDEX payments_next_check_at_idx ON payments (next_check_at);
CREATE INDEX payments_order_id_idx ON payments (order_id);
