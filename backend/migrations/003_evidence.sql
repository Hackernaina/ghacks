-- Append-only. Never UPDATE except duplicate_count and payment_id (orphan linking).
CREATE TABLE evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  payment_id UUID NULL REFERENCES payments(id),
  psp TEXT NULL,
  psp_ref TEXT NULL,
  idem_key TEXT NULL,
  order_id UUID NULL,

  reported_status TEXT NOT NULL,
  amount BIGINT NULL,
  currency TEXT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duplicate_count INT NOT NULL DEFAULT 0,
  raw JSONB NOT NULL,

  UNIQUE (source, source_event_id)
);

CREATE INDEX evidence_payment_id_idx ON evidence (payment_id);
CREATE INDEX evidence_psp_ref_idx ON evidence (psp_ref);
CREATE INDEX evidence_idem_key_idx ON evidence (idem_key);
