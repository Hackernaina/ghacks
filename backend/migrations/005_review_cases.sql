CREATE TABLE review_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NULL REFERENCES payments(id),
  order_id UUID NULL REFERENCES orders(id),
  case_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  summary TEXT NOT NULL,
  suggested_action TEXT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '[]',
  resolution TEXT NULL,
  note TEXT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);

-- Dedupe key format: "${caseType}:${paymentId}" or "ORPHAN:${pspRef}".
CREATE UNIQUE INDEX review_cases_open_dedupe_idx
  ON review_cases (dedupe_key)
  WHERE status = 'OPEN';

CREATE INDEX review_cases_payment_id_idx ON review_cases (payment_id);
CREATE INDEX review_cases_order_id_idx ON review_cases (order_id);
CREATE INDEX review_cases_status_idx ON review_cases (status);
